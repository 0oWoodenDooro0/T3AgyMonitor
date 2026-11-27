import { EventEmitter } from 'node:events';

import {
  CdpClient,
  DEFAULT_CDP_HOST,
  DEFAULT_CDP_PORT,
  validatePort,
} from './cdp-client.mjs';

export const DEFAULT_BINDING_NAME = '__t3AgyMonitorSend';
export const DEFAULT_STATE_RECEIVER = '__t3AgyMonitorReceive';

/**
 * Parse and validate an incoming UI binding command payload.
 */
export function parseBindingCommand(rawPayload) {
  let parsed;
  try {
    parsed = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;
  } catch (error) {
    return { ok: false, reason: 'invalid_json', error: error.message };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'invalid_shape', error: 'Command payload must be a JSON object' };
  }

  if (typeof parsed.type !== 'string' || parsed.type.trim().length === 0) {
    return { ok: false, reason: 'missing_type', error: 'Command payload requires a non-empty string "type"' };
  }

  return { ok: true, command: parsed };
}

/**
 * Attach-only CDP Sidecar controller with bounded-backoff auto-reconnect
 * and Runtime.addBinding / Runtime.evaluate UI bridge.
 */
export class Sidecar extends EventEmitter {
  #host;
  #port;
  #bindingName;
  #stateReceiver;
  #getOverlayScript;
  #commandHandlers;
  #onCommand;
  #logger;
  #fetchImpl;
  #WebSocketImpl;
  #CdpClientClass;
  #reconnectMinDelayMs;
  #reconnectMaxDelayMs;
  #reconnectFactor;

  #client = null;
  #running = false;
  #status = 'STOPPED';
  #reconnectTimer = null;
  #currentBackoffMs;
  #lastState = null;

  constructor({
    host = DEFAULT_CDP_HOST,
    port = DEFAULT_CDP_PORT,
    bindingName = DEFAULT_BINDING_NAME,
    stateReceiver = DEFAULT_STATE_RECEIVER,
    getOverlayScript = () => '',
    commandHandlers = {},
    onCommand = null,
    logger = console,
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
    CdpClientClass = CdpClient,
    reconnectMinDelayMs = 250,
    reconnectMaxDelayMs = 5000,
    reconnectFactor = 2,
  } = {}) {
    super();
    this.#host = host;
    this.#port = validatePort(port);
    this.#bindingName = bindingName;
    this.#stateReceiver = stateReceiver;
    this.#getOverlayScript = getOverlayScript;
    this.#commandHandlers = { ...commandHandlers };
    this.#onCommand = onCommand;
    this.#logger = logger;
    this.#fetchImpl = fetchImpl;
    this.#WebSocketImpl = WebSocketImpl;
    this.#CdpClientClass = CdpClientClass;
    this.#reconnectMinDelayMs = Math.max(1, Number(reconnectMinDelayMs) || 250);
    this.#reconnectMaxDelayMs = Math.max(this.#reconnectMinDelayMs, Number(reconnectMaxDelayMs) || 5000);
    this.#reconnectFactor = Math.max(1, Number(reconnectFactor) || 2);
    this.#currentBackoffMs = this.#reconnectMinDelayMs;
  }

  get status() {
    return this.#status;
  }

  get port() {
    return this.#port;
  }

  async start() {
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#currentBackoffMs = this.#reconnectMinDelayMs;
    await this.#tryAttach();
  }

  async stop() {
    this.#running = false;
    this.#clearReconnectTimer();
    if (this.#client) {
      this.#client.removeAllListeners();
      this.#client.close();
      this.#client = null;
    }
    this.#status = 'STOPPED';
    this.emit('stopped');
  }

  async pushState(state) {
    this.#lastState = state;
    if (!this.#client || !this.#client.isConnected) {
      this.#logDegraded('Cannot push state while disconnected from Host App');
      return false;
    }

    try {
      const serialized = JSON.stringify(state);
      await this.#client.evaluate(
        `typeof globalThis[${JSON.stringify(this.#stateReceiver)}] === 'function' && globalThis[${JSON.stringify(this.#stateReceiver)}](${serialized})`,
      );
      return true;
    } catch (error) {
      this.#logDegraded('Failed to push state to Host App', { error: error.message });
      return false;
    }
  }

  async #tryAttach() {
    if (!this.#running) {
      return;
    }

    const client = new this.#CdpClientClass({
      host: this.#host,
      port: this.#port,
      fetchImpl: this.#fetchImpl,
      WebSocketImpl: this.#WebSocketImpl,
    });

    try {
      await client.connect();
      if (!this.#running) {
        client.close();
        return;
      }

      client.on('bindingCalled', (params) => {
        void this.#handleBindingCalled(params);
      });

      client.on('close', (info) => {
        this.#handleDisconnect(info);
      });

      client.on('error', (error) => {
        this.#logDegraded('CDP client transport error', { error: error.message });
      });

      await client.enableRuntime();
      await client.addBinding(this.#bindingName);

      const overlayScript = typeof this.#getOverlayScript === 'function'
        ? this.#getOverlayScript()
        : '';
      if (typeof overlayScript === 'string' && overlayScript.trim().length > 0) {
        await client.evaluate(overlayScript);
      }

      this.#client = client;
      this.#status = 'CONNECTED';
      this.#currentBackoffMs = this.#reconnectMinDelayMs;
      this.emit('connected');

      if (this.#lastState !== null) {
        await this.pushState(this.#lastState);
      }
    } catch (error) {
      client.close();
      this.#client = null;
      this.#enterDegradedAndScheduleReconnect('Failed to attach to Host App over CDP', {
        error: error.message,
      });
    }
  }

  #handleDisconnect(info) {
    if (this.#client) {
      this.#client.removeAllListeners();
      this.#client = null;
    }
    if (!this.#running) {
      return;
    }
    this.#enterDegradedAndScheduleReconnect('Host App CDP connection closed; scheduling reconnect', {
      code: info?.code,
      reason: info?.reason,
    });
  }

  #enterDegradedAndScheduleReconnect(message, extra = {}) {
    this.#status = 'DEGRADED';
    const delayMs = this.#currentBackoffMs;
    this.#currentBackoffMs = Math.min(
      this.#reconnectMaxDelayMs,
      Math.round(this.#currentBackoffMs * this.#reconnectFactor),
    );

    this.#logDegraded(message, { ...extra, nextRetryMs: delayMs });
    this.emit('degraded', { message, nextRetryMs: delayMs, ...extra });

    this.#clearReconnectTimer();
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#tryAttach();
    }, delayMs);
  }

  #clearReconnectTimer() {
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
  }

  async #handleBindingCalled(params) {
    if (params?.name !== this.#bindingName) {
      return;
    }

    const validation = parseBindingCommand(params.payload);
    if (!validation.ok) {
      this.#logDegraded('Rejected malformed UI binding command', {
        reason: validation.reason,
        error: validation.error,
      });
      this.emit('commandRejected', validation);
      return;
    }

    const { command } = validation;
    const handler = Object.hasOwn(this.#commandHandlers, command.type)
      ? this.#commandHandlers[command.type]
      : null;

    if (typeof handler !== 'function' && typeof this.#onCommand !== 'function') {
      const rejection = {
        ok: false,
        reason: 'unknown_command',
        type: command.type,
        error: `Unknown UI binding command "${command.type}"`,
      };
      this.#logDegraded('Rejected unknown UI binding command', { type: command.type });
      this.emit('commandRejected', rejection);
      return;
    }

    try {
      if (typeof handler === 'function') {
        await handler(command);
      } else {
        await this.#onCommand(command);
      }
      this.emit('commandHandled', command);
    } catch (error) {
      this.#logDegraded('UI binding command handler failed', {
        type: command.type,
        error: error.message,
      });
      this.emit('commandError', { command, error });
    }
  }

  #logDegraded(message, extra = {}) {
    this.#logger.warn({
      status: 'DEGRADED',
      component: 'Sidecar',
      port: this.#port,
      message,
      ...extra,
    });
  }
}

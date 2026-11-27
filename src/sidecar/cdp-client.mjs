import { EventEmitter } from 'node:events';

export const DEFAULT_CDP_HOST = '127.0.0.1';
export const DEFAULT_CDP_PORT = 9222;

/**
 * Validate a TCP port number (integer in [1, 65535]).
 */
export function validatePort(rawPort) {
  const num = typeof rawPort === 'string' && rawPort.trim() === '' ? NaN : Number(rawPort);
  if (!Number.isInteger(num) || num <= 0 || num > 65535) {
    throw new RangeError(`Invalid CDP port "${rawPort}": expected an integer between 1 and 65535`);
  }
  return num;
}

/**
 * Discover a debuggable Host App page target via CDP `/json/list`.
 */
export async function discoverTarget({
  host = DEFAULT_CDP_HOST,
  port = DEFAULT_CDP_PORT,
  fetchImpl = globalThis.fetch,
  targetFilter = null,
} = {}) {
  const validPort = validatePort(port);
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch implementation is required for CDP target discovery');
  }

  const endpoint = `http://${host}:${validPort}/json/list`;
  const response = await fetchImpl(endpoint);
  if (!response?.ok) {
    throw new Error(`CDP target discovery failed at ${endpoint}: HTTP ${response?.status ?? 'unknown'}`);
  }

  const targets = await response.json();
  if (!Array.isArray(targets)) {
    throw new Error(`CDP target discovery returned non-array payload from ${endpoint}`);
  }

  const withWs = targets.filter((t) => t && typeof t.webSocketDebuggerUrl === 'string' && t.webSocketDebuggerUrl.length > 0);
  const selected = typeof targetFilter === 'function'
    ? withWs.find(targetFilter)
    : withWs.find((t) => t.type === 'page' && !String(t.url || '').startsWith('devtools://'))
      ?? withWs.find((t) => t.type === 'page');

  if (!selected) {
    throw new Error(`No debuggable page target found at ${endpoint}`);
  }

  return selected;
}

/**
 * Minimal zero-dependency CDP client over WebSocket.
 */
export class CdpClient extends EventEmitter {
  #host;
  #port;
  #fetchImpl;
  #WebSocketImpl;
  #targetFilter;
  #ws = null;
  #nextId = 1;
  #pending = new Map();
  #connected = false;

  constructor({
    host = DEFAULT_CDP_HOST,
    port = DEFAULT_CDP_PORT,
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
    targetFilter = null,
  } = {}) {
    super();
    this.#host = host;
    this.#port = validatePort(port);
    this.#fetchImpl = fetchImpl;
    this.#WebSocketImpl = WebSocketImpl;
    this.#targetFilter = targetFilter;
  }

  get isConnected() {
    return this.#connected;
  }

  async connect() {
    if (this.#connected) {
      return;
    }
    if (typeof this.#WebSocketImpl !== 'function') {
      throw new Error('WebSocket implementation is required for CdpClient');
    }

    const target = await discoverTarget({
      host: this.#host,
      port: this.#port,
      fetchImpl: this.#fetchImpl,
      targetFilter: this.#targetFilter,
    });

    await this.#openSocket(target.webSocketDebuggerUrl);
  }

  #openSocket(wsUrl) {
    return new Promise((resolve, reject) => {
      const ws = new this.#WebSocketImpl(wsUrl);
      let settled = false;

      const onOpen = () => {
        settled = true;
        this.#ws = ws;
        this.#connected = true;
        resolve();
      };

      const onError = (event) => {
        const err = event?.error instanceof Error
          ? event.error
          : new Error(event?.message || 'CDP WebSocket error');
        if (!settled) {
          settled = true;
          reject(err);
          return;
        }
        if (this.listenerCount('error') > 0) {
          this.emit('error', err);
        }
      };

      const onMessage = (event) => {
        this.#handleMessage(event?.data);
      };

      const onClose = (event) => {
        const wasConnected = this.#connected;
        this.#connected = false;
        this.#ws = null;
        this.#rejectAllPending(new Error('CDP WebSocket closed'));
        if (!settled) {
          settled = true;
          reject(new Error(`CDP WebSocket closed before opening (code ${event?.code ?? 'unknown'})`));
          return;
        }
        if (wasConnected) {
          this.emit('close', { code: event?.code ?? 1000, reason: event?.reason ?? '' });
        }
      };

      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
      ws.addEventListener('message', onMessage);
      ws.addEventListener('close', onClose);
    });
  }

  #handleMessage(rawData) {
    let message;
    try {
      const text = typeof rawData === 'string' ? rawData : String(rawData);
      message = JSON.parse(text);
    } catch {
      return;
    }

    if (typeof message?.id === 'number') {
      const entry = this.#pending.get(message.id);
      if (!entry) return;
      this.#pending.delete(message.id);
      if (message.error) {
        entry.reject(new Error(message.error.message || `CDP error ${message.error.code ?? ''}`.trim()));
      } else {
        entry.resolve(message.result ?? {});
      }
      return;
    }

    if (typeof message?.method === 'string') {
      this.emit('event', message);
      if (message.method === 'Runtime.bindingCalled') {
        this.emit('bindingCalled', message.params ?? {});
      }
    }
  }

  #rejectAllPending(error) {
    for (const entry of this.#pending.values()) {
      entry.reject(error);
    }
    this.#pending.clear();
  }

  send(method, params = {}) {
    if (!this.#connected || !this.#ws) {
      return Promise.reject(new Error('CDP client is not connected'));
    }

    const id = this.#nextId++;
    const payload = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#ws.send(payload);
      } catch (error) {
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  enableRuntime() {
    return this.send('Runtime.enable');
  }

  addBinding(name) {
    return this.send('Runtime.addBinding', { name });
  }

  evaluate(expression, { awaitPromise = true, returnByValue = true } = {}) {
    return this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue,
    });
  }

  close() {
    this.#connected = false;
    this.#rejectAllPending(new Error('CDP client closed'));
    if (this.#ws) {
      try {
        this.#ws.close();
      } catch {
        // Ignore close errors on already-closing sockets.
      }
      this.#ws = null;
    }
  }
}

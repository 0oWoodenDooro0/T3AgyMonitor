import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { CdpClient, discoverTarget } from '../src/sidecar/cdp-client.mjs';
import { Sidecar } from '../src/sidecar/sidecar.mjs';
import { parseCliArgs, runCli } from '../src/cli.mjs';

class MockWebSocket extends EventEmitter {
  static OPEN = 1;
  static CLOSED = 3;

  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.onMessage = null;
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN;
      this.emit('open');
    });
  }

  addEventListener(type, listener) {
    this.on(type, listener);
  }

  removeEventListener(type, listener) {
    this.off(type, listener);
  }

  send(raw) {
    const msg = JSON.parse(raw);
    this.sent.push(msg);
    if (this.onMessage) {
      this.onMessage(msg, this);
    }
  }

  receive(payload) {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.emit('message', { data });
  }

  close(code = 1000, reason = '') {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', { code, reason });
  }
}

test('discoverTarget selects page target from /json/list', async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, 'http://127.0.0.1:9222/json/list');
    return {
      ok: true,
      status: 200,
      async json() {
        return [
          { id: 'bg-1', type: 'background_page', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/bg-1' },
          { id: 'p-1', type: 'page', title: 'T3 Code', url: 'app://t3', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/p-1' },
        ];
      },
    };
  };

  const target = await discoverTarget({ port: 9222, fetchImpl });
  assert.equal(target.id, 'p-1');
  assert.equal(target.webSocketDebuggerUrl, 'ws://127.0.0.1:9222/devtools/page/p-1');
});

test('CdpClient connects, sends Runtime commands, and dispatches Runtime.bindingCalled', async () => {
  let activeWs = null;
  class TrackingMockWebSocket extends MockWebSocket {
    constructor(url) {
      super(url);
      activeWs = this;
      this.onMessage = (msg, ws) => {
        ws.receive({ id: msg.id, result: { echoed: msg.method, params: msg.params } });
      };
    }
  }

  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async json() {
      return [{ id: 'p-1', type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/p-1' }];
    },
  });

  const client = new CdpClient({ port: 9222, fetchImpl, WebSocketImpl: TrackingMockWebSocket });
  await client.connect();

  const enableRes = await client.enableRuntime();
  assert.equal(enableRes.echoed, 'Runtime.enable');

  const bindRes = await client.addBinding('__t3AgyMonitorSend');
  assert.equal(bindRes.echoed, 'Runtime.addBinding');
  assert.deepEqual(bindRes.params, { name: '__t3AgyMonitorSend' });

  const evalRes = await client.evaluate('1 + 1');
  assert.equal(evalRes.echoed, 'Runtime.evaluate');
  assert.equal(evalRes.params.expression, '1 + 1');

  const bindingEvents = [];
  client.on('bindingCalled', (params) => bindingEvents.push(params));

  activeWs.receive({
    method: 'Runtime.bindingCalled',
    params: { name: '__t3AgyMonitorSend', payload: '{"type":"ping"}' },
  });

  assert.equal(bindingEvents.length, 1);
  assert.deepEqual(bindingEvents[0], { name: '__t3AgyMonitorSend', payload: '{"type":"ping"}' });

  client.close();
});

function createHarness() {
  const sockets = [];
  const logs = { warn: [], info: [], error: [] };
  const logger = {
    warn: (entry) => logs.warn.push(entry),
    info: (entry) => logs.info.push(entry),
    error: (entry) => logs.error.push(entry),
  };

  class HarnessWebSocket extends MockWebSocket {
    constructor(url) {
      super(url);
      sockets.push(this);
      this.onMessage = (msg, ws) => {
        ws.receive({ id: msg.id, result: {} });
      };
    }
  }

  let targetsAvailable = true;
  const fetchImpl = async () => {
    if (!targetsAvailable) {
      throw new Error('ECONNREFUSED');
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return [{ id: 'p-1', type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/p-1' }];
      },
    };
  };

  return {
    sockets,
    logs,
    logger,
    WebSocketImpl: HarnessWebSocket,
    fetchImpl,
    setTargetsAvailable(val) {
      targetsAvailable = val;
    },
  };
}

test('Sidecar attaches, injects overlay script, pushes state, and routes valid/invalid binding commands', async () => {
  const harness = createHarness();
  const handled = [];
  const rejected = [];

  const sidecar = new Sidecar({
    port: 9222,
    fetchImpl: harness.fetchImpl,
    WebSocketImpl: harness.WebSocketImpl,
    logger: harness.logger,
    getOverlayScript: () => 'window.__overlayBooted = true;',
    commandHandlers: {
      refresh: async (cmd) => {
        handled.push(cmd);
      },
    },
  });

  sidecar.on('commandRejected', (info) => rejected.push(info));

  await sidecar.start();
  assert.equal(sidecar.status, 'CONNECTED');
  assert.equal(harness.sockets.length, 1);

  const ws = harness.sockets[0];
  const methods = ws.sent.map((m) => m.method);
  assert.deepEqual(methods, ['Runtime.enable', 'Runtime.addBinding', 'Runtime.evaluate']);
  assert.equal(ws.sent[2].params.expression, 'window.__overlayBooted = true;');
  assert.equal(ws.sent[2].params.awaitPromise, false);
  assert.equal(ws.sent[2].params.returnByValue, true);

  const pushed = await sidecar.pushState({ activeModel: 'gemini-4', tokens: 1200 });
  assert.equal(pushed, true);
  assert.equal(ws.sent.length, 4);
  assert.equal(ws.sent[3].method, 'Runtime.evaluate');
  assert.equal(ws.sent[3].params.awaitPromise, false);
  assert.equal(ws.sent[3].params.returnByValue, false);
  assert.match(ws.sent[3].params.expression, /"activeModel":"gemini-4"/);

  // Valid command
  ws.receive({
    method: 'Runtime.bindingCalled',
    params: { name: '__t3AgyMonitorSend', payload: JSON.stringify({ type: 'refresh', source: 'capsule' }) },
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(handled.length, 1);
  assert.deepEqual(handled[0], { type: 'refresh', source: 'capsule' });

  // Malformed JSON command
  ws.receive({
    method: 'Runtime.bindingCalled',
    params: { name: '__t3AgyMonitorSend', payload: '{not-json' },
  });
  // Unknown command type
  ws.receive({
    method: 'Runtime.bindingCalled',
    params: { name: '__t3AgyMonitorSend', payload: JSON.stringify({ type: 'unknown_action' }) },
  });
  // Unrelated binding name should be ignored
  ws.receive({
    method: 'Runtime.bindingCalled',
    params: { name: 'otherBinding', payload: '{}' },
  });

  await new Promise((r) => setTimeout(r, 10));
  assert.equal(rejected.length, 2);
  assert.equal(sidecar.status, 'CONNECTED');
  assert.ok(harness.logs.warn.some((entry) => entry?.status === 'DEGRADED'));

  await sidecar.stop();
});

test('Sidecar logs DEGRADED and auto-reconnects with bounded backoff on Host App disconnect', async () => {
  const harness = createHarness();
  const degradedEvents = [];
  let connectedCount = 0;

  const sidecar = new Sidecar({
    port: 9222,
    fetchImpl: harness.fetchImpl,
    WebSocketImpl: harness.WebSocketImpl,
    logger: harness.logger,
    reconnectMinDelayMs: 5,
    reconnectMaxDelayMs: 15,
    reconnectFactor: 2,
  });

  sidecar.on('degraded', (ev) => degradedEvents.push(ev));
  sidecar.on('connected', () => {
    connectedCount += 1;
  });

  await sidecar.start();
  assert.equal(connectedCount, 1);
  await sidecar.pushState({ step: 1 });

  // Simulate Host App restart: targets unavailable briefly, then socket closes.
  harness.setTargetsAvailable(false);
  harness.sockets[0].close(1006, 'Host App restarted');

  assert.equal(sidecar.status, 'DEGRADED');
  assert.ok(harness.logs.warn.some((w) => w.status === 'DEGRADED'));

  // Wait for at least two failed reconnect attempts to verify bounded backoff
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(degradedEvents.length >= 2);
  assert.ok(degradedEvents.every((ev) => ev.nextRetryMs <= 15));

  // Bring Host App back online
  harness.setTargetsAvailable(true);
  await new Promise((r) => setTimeout(r, 40));

  assert.equal(sidecar.status, 'CONNECTED');
  assert.equal(connectedCount, 2);
  // Last state should be re-pushed on reconnect
  const reconnectedWs = harness.sockets.at(-1);
  assert.ok(reconnectedWs.sent.some((m) => m.method === 'Runtime.evaluate' && m.params.expression.includes('"step":1')));

  await sidecar.stop();
});

test('CLI parses --port, T3_CDP_PORT, default 9222, and rejects invalid ports', async () => {
  assert.deepEqual(parseCliArgs([], {}), { port: 9222, help: false });
  assert.deepEqual(parseCliArgs([], { T3_CDP_PORT: '9333' }), { port: 9333, help: false });
  assert.deepEqual(parseCliArgs(['--port', '9444'], { T3_CDP_PORT: '9333' }), { port: 9444, help: false });
  assert.deepEqual(parseCliArgs(['--port=9555'], {}), { port: 9555, help: false });

  for (const badArgs of [['--port', '0'], ['--port', '-1'], ['--port', '65536'], ['--port', 'abc'], ['--port']]) {
    assert.throws(() => parseCliArgs(badArgs, {}), /Invalid CDP port|Missing value/);
  }

  const errors = [];
  const code = await runCli(['--port', '70000'], {}, {
    stderr: { write: (msg) => errors.push(msg) },
  });
  assert.equal(code, 1);
  assert.match(errors.join(''), /Invalid CDP port/);
});

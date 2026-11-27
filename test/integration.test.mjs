import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createApp } from '../src/app.mjs';
import { installOverlayRuntime } from '../src/overlay/index.mjs';
import { runCli } from '../src/cli.mjs';
import { createMockDom } from './overlay-panels.test.mjs';

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 't3-agy-e2e-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function createE2EFixtureDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE projection_projects (
      project_id TEXT PRIMARY KEY,
      title TEXT,
      workspace_root TEXT,
      default_model_selection_json TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT,
      archived_at TEXT
    );
    CREATE TABLE projection_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT,
      title TEXT,
      branch TEXT,
      worktree_path TEXT,
      latest_turn_id TEXT,
      runtime_mode TEXT,
      interaction_mode TEXT,
      model_selection_json TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT,
      archived_at TEXT
    );
    CREATE TABLE projection_thread_sessions (
      thread_id TEXT PRIMARY KEY,
      status TEXT,
      provider_name TEXT,
      provider_session_id TEXT,
      provider_thread_id TEXT,
      active_turn_id TEXT,
      last_error TEXT,
      updated_at TEXT,
      runtime_mode TEXT,
      provider_instance_id TEXT
    );
    CREATE TABLE orchestration_v2_projection_runs (
      run_id TEXT PRIMARY KEY,
      thread_id TEXT,
      ordinal INTEGER,
      provider TEXT,
      provider_thread_id TEXT,
      status TEXT,
      requested_at TEXT,
      completed_at TEXT,
      payload_json TEXT,
      provider_instance_id TEXT
    );
    CREATE TABLE orchestration_v2_projection_subagents (
      subagent_id TEXT PRIMARY KEY,
      thread_id TEXT,
      run_id TEXT,
      parent_node_id TEXT,
      provider TEXT,
      provider_thread_id TEXT,
      child_thread_id TEXT,
      origin TEXT,
      status TEXT,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT,
      payload_json TEXT,
      driver TEXT,
      completion_delivery_state TEXT
    );
    CREATE TABLE orchestration_v2_projection_checkpoints (
      checkpoint_id TEXT PRIMARY KEY,
      thread_id TEXT,
      run_id TEXT,
      turn_id TEXT,
      ordinal_within_scope INTEGER,
      status TEXT,
      captured_at TEXT,
      payload_json TEXT
    );
  `);

  db.prepare(
    `INSERT INTO projection_projects (project_id, title, workspace_root, updated_at)
     VALUES ('proj-1', 'T3AgyMonitor', '/tmp/proj', '2026-11-27T10:00:00.000Z')`,
  ).run();

  db.prepare(
    `INSERT INTO projection_threads (thread_id, project_id, title, latest_turn_id, updated_at)
     VALUES ('thread-main', 'proj-1', 'Main Session', 'turn-1', '2026-11-27T10:01:00.000Z')`,
  ).run();

  db.prepare(
    `INSERT INTO projection_thread_sessions (thread_id, status, provider_name, provider_thread_id, active_turn_id, updated_at)
     VALUES ('thread-main', 'running', 'antigravity', 'conv-main-123', 'turn-1', '2026-11-27T10:01:00.000Z')`,
  ).run();

  db.prepare(
    `INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at)
     VALUES ('run-1', 'thread-main', 1, 'antigravity', 'conv-main-123', 'running', '2026-11-27T10:00:00.000Z')`,
  ).run();

  db.prepare(
    `INSERT INTO orchestration_v2_projection_subagents (subagent_id, thread_id, run_id, provider, provider_thread_id, origin, status, started_at, payload_json)
     VALUES ('sub-1', 'thread-main', 'run-1', 'antigravity', 'conv-sub-456', 'subagent', 'running', '2026-11-27T10:00:05.000Z', '{"role":"Researcher"}')`,
  ).run();

  db.prepare(
    `INSERT INTO orchestration_v2_projection_checkpoints (checkpoint_id, thread_id, run_id, turn_id, ordinal_within_scope, status, captured_at, payload_json)
     VALUES ('cp-1', 'thread-main', 'run-1', 'turn-1', 1, 'ready', '2026-11-27T10:00:10.000Z', '{"summary":"checkpoint","tokens":50}')`,
  ).run();

  db.close();
}

/**
 * Bridges Sidecar's CDP client directly to an in-memory OverlayRuntime + MockDom.
 */
function createCdpOverlayBridge(globalTarget) {
  const bindings = new Set();
  const sockets = [];

  class BridgeWebSocket extends EventEmitter {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit('open');
      });
    }

    addEventListener(type, fn) {
      this.on(type, fn);
    }

    removeEventListener(type, fn) {
      this.off(type, fn);
    }

    send(raw) {
      const msg = JSON.parse(raw);
      let result = {};
      if (msg.method === 'Runtime.addBinding') {
        const bindingName = msg.params.name;
        bindings.add(bindingName);
        globalTarget[bindingName] = (payload) => {
          this.emit('message', {
            data: JSON.stringify({
              method: 'Runtime.bindingCalled',
              params: { name: bindingName, payload },
            }),
          });
        };
      } else if (msg.method === 'Runtime.evaluate') {
        const expr = msg.params.expression;
        // Execute __t3AgyMonitorReceive(<json>) against globalTarget
        const match = /globalThis\["([^"]+)"\]\(([\s\S]+)\)$/.exec(expr);
        if (match && typeof globalTarget[match[1]] === 'function') {
          globalTarget[match[1]](JSON.parse(match[2]));
        }
        result = { result: { type: 'undefined' } };
      }
      queueMicrotask(() => {
        this.emit('message', { data: JSON.stringify({ id: msg.id, result }) });
      });
    }

    close() {
      this.readyState = 3;
      this.emit('close', { code: 1000, reason: 'closed' });
    }
  }

  const fetchImpl = async (url) => {
    if (String(url).includes('/json/list')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return [{ id: 'page-1', type: 'page', title: 'T3 Code', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/page-1' }];
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return { tag_name: 'v0.2.0', html_url: 'https://github.com/0oWoodenDooro0/T3AgyMonitor/releases/tag/v0.2.0' };
      },
    };
  };

  return { WebSocketImpl: BridgeWebSocket, fetchImpl, bindings, sockets };
}

test('End-to-end: StateReader + TranscriptParser + Sidecar + OverlayRuntime renders 3 header surfaces and handles UI actions', async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, 'statev2.sqlite');
    const providersDir = path.join(dir, 'providers', 'antigravity');
    const mainConvDir = path.join(providersDir, 'profile-a', 'antigravity-acp', 'brain', 'conv-main-123', '.system_generated', 'logs');
    const subConvDir = path.join(providersDir, 'profile-a', 'antigravity-acp', 'brain', 'conv-sub-456', '.system_generated', 'logs');
    await fs.mkdir(mainConvDir, { recursive: true });
    await fs.mkdir(subConvDir, { recursive: true });

    createE2EFixtureDb(dbPath);

    await fs.writeFile(
      path.join(mainConvDir, 'transcript.jsonl'),
      [
        JSON.stringify({ type: 'USER_INPUT', content: 'Analyze repo', tokens: 100, created_at: '2026-11-27T10:00:00.000Z' }),
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          model: 'gemini-4-hydrogen',
          input_tokens: 1000,
          cache_read_tokens: 500,
          output_tokens: 200,
          tool_calls: [{ name: 'read_file' }],
          tool_calls_tokens: 100,
          created_at: '2026-11-27T10:00:02.000Z',
        }),
        JSON.stringify({ type: 'GENERIC', content: 'file content', tokens: 150, created_at: '2026-11-27T10:00:03.000Z' }),
      ].join('\n') + '\n',
      'utf8',
    );

    await fs.writeFile(
      path.join(subConvDir, 'transcript.jsonl'),
      [
        JSON.stringify({ type: 'USER_INPUT', content: 'Check ADRs', tokens: 40, created_at: '2026-11-27T10:00:05.000Z' }),
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          model: 'gemini-4-hydrogen',
          input_tokens: 400,
          cache_read_tokens: 100,
          output_tokens: 80,
          created_at: '2026-11-27T10:00:06.000Z',
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const configPath = path.join(dir, 'config.json');
    const ratesPath = path.join(dir, 'missing-rates.json');

    const { document, MockMutationObserver, MockEvent } = createMockDom();
    const globalTarget = {};
    const bridge = createCdpOverlayBridge(globalTarget);

    // Prepare the 3 header DOM anchors
    for (const testId of [
      'composer-toolbar',
      'context-breakdown-anchor',
      'unified-timeline-anchor',
    ]) {
      const el = document.createElement('div');
      el.setAttribute('data-testid', testId);
      document.body.appendChild(el);
    }

    const runtime = installOverlayRuntime({
      document,
      MutationObserver: MockMutationObserver,
      globalTarget,
      logger: { warn: () => {} },
    });

    const app = createApp({
      port: 9222,
      configPath,
      dbPath,
      providersDir,
      ratesPath,
      currentVersion: '0.1.0',
      fetchImpl: bridge.fetchImpl,
      WebSocketImpl: bridge.WebSocketImpl,
      logger: { warn: () => {} },
    });

    try {
      await app.start();
      // Wait a tick for async commandHandlers / pushState
      await new Promise((r) => setTimeout(r, 20));

      // Verify the 3 header surfaces mounted and rendered real data (and removed surfaces are not registered)
      assert.equal(runtime.getSurface('composer-ring'), null);
      assert.equal(runtime.getSurface('stage-progress'), null);
      assert.equal(runtime.getSurface('overview-panel'), null);

      const capsuleSurface = runtime.getSurface('status-capsule');
      assert.ok(capsuleSurface);
      const capsuleRoot = runtime.registry.get('status-capsule').shadowRoot;
      assert.match(
        capsuleRoot.querySelector('[data-role="capsule-slots"]').textContent,
        /gemini-4-hydrogen/,
      );

      const breakdownRoot = runtime.registry.get('context-breakdown').shadowRoot;
      assert.equal(breakdownRoot.querySelectorAll('[data-role="breakdown-row"]').length, 7);
      assert.match(breakdownRoot.querySelector('[data-role="breakdown-total"]').textContent, /1500/);

      const timelineRoot = runtime.registry.get('unified-timeline').shadowRoot;
      assert.ok(timelineRoot.querySelectorAll('[data-role="timeline-step"]').length >= 4);
      assert.equal(timelineRoot.querySelectorAll('[data-role="running-task-item"]').length, 1);

      // UI action round-trip 1: updateConfig via status-capsule -> persisted + pushed back
      const updateSelect = capsuleRoot.querySelector('[data-role="update-mode-select"]');
      updateSelect.value = 'manual';
      updateSelect.dispatchEvent(new MockEvent('change'));
      await new Promise((r) => setTimeout(r, 20));
      const savedConfig = JSON.parse(await fs.readFile(configPath, 'utf8'));
      assert.equal(savedConfig.updateCheckMode, 'manual');

      // UI action round-trip 2: checkUpdates -> badge appears on Status Capsule
      runtime.dispatchAction('checkUpdates');
      await new Promise((r) => setTimeout(r, 20));
      const badge = runtime.registry.get('status-capsule').shadowRoot.querySelector('[data-role="update-badge"]');
      assert.equal(badge.getAttribute('aria-hidden'), 'false');
      assert.match(badge.textContent, /v0\.2\.0/);

      // UI action round-trip 3: refresh -> re-reads transcript and pushes updated tokens
      await fs.appendFile(
        path.join(mainConvDir, 'transcript.jsonl'),
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          model: 'gemini-4-hydrogen',
          input_tokens: 1500,
          cache_read_tokens: 900,
          output_tokens: 300,
          created_at: '2026-11-27T10:00:12.000Z',
        }) + '\n',
        'utf8',
      );
      runtime.dispatchAction('refresh');
      await new Promise((r) => setTimeout(r, 20));
      assert.match(breakdownRoot.querySelector('[data-role="breakdown-total"]').textContent, /2400/);

      const latestSnapshot = await app.buildSnapshot();
      assert.ok(latestSnapshot.composerRing);
      assert.equal(latestSnapshot.composerRing.mode, 'context_window');
      assert.equal(latestSnapshot.contextBreakdowns['sub-1'].totalInputTokens, 500);
      assert.ok(latestSnapshot.plannerResponse);
      assert.equal(latestSnapshot.plannerResponse.outputTokens, 300);

      // UI action round-trip 4: selectContextAgent -> switches ContextBreakdownSurface to sub-1
      runtime.dispatchAction('selectContextAgent', { agentId: 'sub-1' });
      await new Promise((r) => setTimeout(r, 20));
      assert.match(breakdownRoot.querySelector('[data-role="breakdown-total"]').textContent, /500/);

      // Verify default getOverlayScript on createApp produces a non-empty executable bundle
      const defaultApp = createApp({ configPath, dbPath, providersDir, ratesPath });
      const defaultSnap = await defaultApp.buildSnapshot();
      assert.ok(defaultSnap.composerRing);
      assert.ok(defaultApp.sidecar);
    } finally {
      await app.stop();
      runtime.destroy();
    }
  });
});

test('runCli starts createApp with parsed port', async () => {
  const startedPorts = [];
  const code = await runCli(['--port', '9444'], {}, {
    registerSignals: false,
    AppFactory: (opts) => {
      startedPorts.push(opts.port);
      return {
        async start() {},
        async stop() {},
      };
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(startedPorts, [9444]);
});

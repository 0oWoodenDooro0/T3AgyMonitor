import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { T3StateReader } from '../src/data/t3-state-reader.mjs';

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 't3-agy-state-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function createFixtureDb(dbPath) {
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
      provider_instance_id TEXT,
      completion_delivery_state TEXT
    );
    CREATE TABLE orchestration_v2_projection_checkpoints (
      checkpoint_id TEXT PRIMARY KEY,
      thread_id TEXT,
      scope_id TEXT,
      run_id TEXT,
      node_id TEXT,
      parent_checkpoint_id TEXT,
      ordinal_within_scope INTEGER,
      app_run_ordinal INTEGER,
      status TEXT,
      captured_at TEXT,
      payload_json TEXT
    );
  `);
  return db;
}

test('T3StateReader logs DEGRADED warning and returns null when DB is missing', async () => {
  await withTempDir(async (dir) => {
    const warnings = [];
    const reader = new T3StateReader({
      dbPath: path.join(dir, 'nonexistent.sqlite'),
      logger: { warn: (entry) => warnings.push(entry) },
    });

    const snapshot = await reader.getThreadSnapshot('thread-1');
    assert.equal(snapshot, null);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].status, 'DEGRADED');
    assert.equal(warnings[0].component, 'T3StateReader');
  });
});

test('T3StateReader maps thread_id to conversationId, recursive subagents (with cycle guard), and checkpoints', async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, 'statev2.sqlite');
    const providersDir = path.join(dir, 'providers', 'antigravity');
    const convMain = 'conv-main-111';
    const convChild = 'conv-child-222';
    const transcriptFile = path.join(
      providersDir,
      'acct-hash',
      'antigravity-acp',
      'brain',
      convMain,
      '.system_generated',
      'logs',
      'transcript.jsonl',
    );
    await fs.mkdir(path.dirname(transcriptFile), { recursive: true });
    await fs.writeFile(transcriptFile, '', 'utf8');

    const db = createFixtureDb(dbPath);
    db.prepare(
      `INSERT INTO projection_projects (project_id, title, workspace_root, updated_at) VALUES (?, ?, ?, ?)`,
    ).run('proj-1', 'T3AgyMonitor', '/tmp/proj', '2026-11-27T10:00:00Z');

    db.prepare(
      `INSERT INTO projection_threads (thread_id, project_id, title, branch, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run('thread-main', 'proj-1', 'Main Thread', 'main', '2026-11-27T10:05:00Z');

    db.prepare(
      `INSERT INTO projection_threads (thread_id, project_id, title, branch, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run('thread-child', 'proj-1', 'Child Thread', 'main', '2026-11-27T10:04:00Z');

    db.prepare(
      `INSERT INTO projection_thread_sessions (thread_id, status, provider_name, provider_thread_id) VALUES (?, ?, ?, ?)`,
    ).run(
      'thread-main',
      'running',
      'antigravity',
      `provider-thread:provider:antigravity:native-thread:${convMain}`,
    );

    db.prepare(
      `INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('run-1', 'thread-main', 1, 'antigravity', convMain, 'completed', '2026-11-27T10:01:00Z');

    db.prepare(
      `INSERT INTO orchestration_v2_projection_subagents (subagent_id, thread_id, run_id, parent_node_id, provider, provider_thread_id, child_thread_id, origin, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('sub-1', 'thread-main', 'run-1', 'root', 'antigravity', convChild, 'thread-child', 'app_owned', 'running', '2026-11-27T10:02:00Z');

    // Intentional cycle back to thread-main to verify cycle protection
    db.prepare(
      `INSERT INTO orchestration_v2_projection_subagents (subagent_id, thread_id, run_id, parent_node_id, provider, provider_thread_id, child_thread_id, origin, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('sub-cycle', 'thread-child', 'run-2', 'sub-1', 'antigravity', convMain, 'thread-main', 'app_owned', 'completed', '2026-11-27T10:03:00Z');

    db.prepare(
      `INSERT INTO orchestration_v2_projection_checkpoints (checkpoint_id, thread_id, scope_id, run_id, ordinal_within_scope, status, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('cp-1', 'thread-main', 'scope-1', 'run-1', 1, 'ready', '2026-11-27T10:03:30Z');
    db.close();

    const reader = new T3StateReader({ dbPath, providersDir, logger: { warn() {} } });
    const snapshot = await reader.getThreadSnapshot('thread-main');

    assert.ok(snapshot);
    assert.equal(snapshot.thread.thread_id, 'thread-main');
    assert.equal(snapshot.thread.project_title, 'T3AgyMonitor');
    assert.equal(snapshot.conversationId, convMain);
    assert.equal(snapshot.transcriptPath, transcriptFile);
    assert.equal(snapshot.runs.length, 1);
    assert.equal(snapshot.subagents.length, 2);
    assert.equal(snapshot.subagents[0].depth, 1);
    assert.equal(snapshot.subagents[0].conversationId, convChild);
    assert.equal(snapshot.subagents[1].depth, 2);
    assert.equal(snapshot.checkpoints.length, 1);
    assert.equal(snapshot.checkpoints[0].checkpoint_id, 'cp-1');
  });
});

test('T3StateReader reads orchestration_v2_projection_threads and orchestration_v2_projection_provider_threads (payload_json.nativeThreadRef.nativeId)', async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, 'statev2.sqlite');
    const providersDir = path.join(dir, 'providers', 'antigravity');
    const convV2 = 'conv-v2-999';
    const transcriptFile = path.join(
      providersDir,
      'acct-hash',
      'antigravity-acp',
      'brain',
      convV2,
      '.system_generated',
      'logs',
      'transcript.jsonl',
    );
    await fs.mkdir(path.dirname(transcriptFile), { recursive: true });
    await fs.writeFile(transcriptFile, '', 'utf8');

    const db = createFixtureDb(dbPath);
    db.exec(`
      CREATE TABLE orchestration_v2_projection_threads (
        thread_id TEXT PRIMARY KEY,
        project_id TEXT,
        title TEXT,
        default_provider TEXT,
        runtime_mode TEXT,
        interaction_mode TEXT,
        active_provider_thread_id TEXT,
        created_at TEXT,
        updated_at TEXT,
        archived_at TEXT,
        deleted_at TEXT,
        payload_json TEXT,
        provider_instance_id TEXT,
        fork_run_ids_json TEXT
      );
      CREATE TABLE orchestration_v2_projection_provider_threads (
        provider_thread_id TEXT PRIMARY KEY,
        thread_id TEXT,
        owner_node_id TEXT,
        provider TEXT,
        provider_session_id TEXT,
        status TEXT,
        first_run_ordinal INTEGER,
        last_run_ordinal INTEGER,
        updated_at TEXT,
        payload_json TEXT,
        driver TEXT,
        provider_instance_id TEXT
      );
    `);

    db.prepare(
      `INSERT INTO projection_projects (project_id, title, workspace_root, updated_at) VALUES (?, ?, ?, ?)`,
    ).run('proj-v2', 'T3AgyMonitor', '/tmp/proj-v2', '2026-11-27T11:00:00Z');

    const pendingProviderThreadId =
      'provider-thread:provider:antigravity:native-thread:pending%3Arun%3Athread%3Av2-thread-1%3Aordinal%3A1';

    db.prepare(
      `INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, active_provider_thread_id, updated_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'v2-thread-1',
      'proj-v2',
      'V2 Thread',
      'antigravity',
      pendingProviderThreadId,
      '2026-11-27T11:05:00Z',
      JSON.stringify({ branch: 'main', worktreePath: '/tmp/proj-v2' }),
    );

    db.prepare(
      `INSERT INTO orchestration_v2_projection_provider_threads (provider_thread_id, thread_id, provider, status, updated_at, payload_json) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      pendingProviderThreadId,
      'v2-thread-1',
      'antigravity',
      'active',
      '2026-11-27T11:05:00Z',
      JSON.stringify({ nativeThreadRef: { driver: 'antigravity', nativeId: convV2 } }),
    );
    db.close();

    const reader = new T3StateReader({ dbPath, providersDir, logger: { warn() {} } });
    const active = reader.listActiveThreads({ limit: 10 });
    assert.equal(active.length, 1);
    assert.equal(active[0].thread_id, 'v2-thread-1');
    assert.equal(active[0].branch, 'main');
    assert.equal(active[0].project_title, 'T3AgyMonitor');
    assert.equal(active[0].conversation_id, convV2);

    const snapshot = await reader.getThreadSnapshot('v2-thread-1');
    assert.ok(snapshot);
    assert.equal(snapshot.thread.thread_id, 'v2-thread-1');
    assert.equal(snapshot.thread.branch, 'main');
    assert.equal(snapshot.session.status, 'active');
    assert.equal(snapshot.conversationId, convV2);
    assert.equal(snapshot.transcriptPath, transcriptFile);
  });
});

test('T3StateReader resolves delegated subagent conversationId and transcriptPath via orchestration_v2_projection_provider_threads', async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, 'statev2.sqlite');
    const providersDir = path.join(dir, 'providers', 'antigravity');
    const convMain = 'conv-main-delegator';
    const convChild = 'conv-child-delegated';
    const childTranscriptFile = path.join(
      providersDir,
      'acct-hash',
      'antigravity-acp',
      'brain',
      convChild,
      '.system_generated',
      'logs',
      'transcript.jsonl',
    );
    await fs.mkdir(path.dirname(childTranscriptFile), { recursive: true });
    await fs.writeFile(childTranscriptFile, '', 'utf8');

    const db = createFixtureDb(dbPath);
    db.exec(`
      CREATE TABLE orchestration_v2_projection_threads (
        thread_id TEXT PRIMARY KEY,
        project_id TEXT,
        title TEXT,
        default_provider TEXT,
        runtime_mode TEXT,
        interaction_mode TEXT,
        active_provider_thread_id TEXT,
        created_at TEXT,
        updated_at TEXT,
        archived_at TEXT,
        deleted_at TEXT,
        payload_json TEXT,
        provider_instance_id TEXT,
        fork_run_ids_json TEXT
      );
      CREATE TABLE orchestration_v2_projection_provider_threads (
        provider_thread_id TEXT PRIMARY KEY,
        thread_id TEXT,
        owner_node_id TEXT,
        provider TEXT,
        provider_session_id TEXT,
        status TEXT,
        first_run_ordinal INTEGER,
        last_run_ordinal INTEGER,
        updated_at TEXT,
        payload_json TEXT,
        driver TEXT,
        provider_instance_id TEXT
      );
    `);

    const pendingMainPt =
      'provider-thread:provider:antigravity:native-thread:pending%3Arun%3Athread%3Amain-1%3Aordinal%3A1';
    const pendingChildPt =
      'provider-thread:provider:antigravity:native-thread:pending%3Arun%3Athread%3Achild-1%3Aordinal%3A1';

    db.prepare(
      `INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, active_provider_thread_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('main-1', 'proj-1', 'Main', 'antigravity', pendingMainPt, '2026-11-27T12:00:00Z');

    db.prepare(
      `INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, active_provider_thread_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('child-1', 'proj-1', 'Delegated Child', 'antigravity', pendingChildPt, '2026-11-27T12:01:00Z');

    db.prepare(
      `INSERT INTO orchestration_v2_projection_provider_threads (provider_thread_id, thread_id, provider, status, updated_at, payload_json) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      pendingMainPt,
      'main-1',
      'antigravity',
      'active',
      '2026-11-27T12:00:00Z',
      JSON.stringify({ nativeThreadRef: { driver: 'antigravity', nativeId: convMain } }),
    );

    db.prepare(
      `INSERT INTO orchestration_v2_projection_provider_threads (provider_thread_id, thread_id, provider, status, updated_at, payload_json) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      pendingChildPt,
      'child-1',
      'antigravity',
      'active',
      '2026-11-27T12:01:00Z',
      JSON.stringify({ nativeThreadRef: { driver: 'antigravity', nativeId: convChild } }),
    );

    db.prepare(
      `INSERT INTO orchestration_v2_projection_subagents (subagent_id, thread_id, run_id, parent_node_id, provider, provider_thread_id, child_thread_id, origin, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'sub-delegated-1',
      'main-1',
      'run-1',
      'root',
      'antigravity',
      pendingChildPt,
      'child-1',
      'delegate_task',
      'running',
      '2026-11-27T12:01:00Z',
    );
    db.close();

    const reader = new T3StateReader({ dbPath, providersDir, logger: { warn() {} } });
    const snapshot = await reader.getThreadSnapshot('main-1');

    assert.ok(snapshot);
    assert.equal(snapshot.subagents.length, 1);
    assert.equal(snapshot.subagents[0].child_thread_id, 'child-1');
    assert.equal(snapshot.subagents[0].conversationId, convChild);
    assert.equal(snapshot.subagents[0].transcriptPath, childTranscriptFile);
  });
});

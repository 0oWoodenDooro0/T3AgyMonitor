import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const NATIVE_THREAD_PREFIX = 'provider-thread:provider:antigravity:native-thread:';

export function resolveDefaultStateDbPath(homeDir = os.homedir()) {
  return path.join(homeDir, '.t3', 'userdata', 'statev2.sqlite');
}

export function resolveDefaultProvidersDir(homeDir = os.homedir()) {
  return path.join(homeDir, '.t3', 'userdata', 'providers', 'antigravity');
}

/**
 * Extract a resolved Antigravity conversation ID from a provider_thread_id string.
 * Returns null for unresolved `pending:` placeholders or empty values.
 */
export function extractConversationId(rawId) {
  if (typeof rawId !== 'string' || rawId.trim().length === 0) {
    return null;
  }
  const value = rawId.startsWith(NATIVE_THREAD_PREFIX)
    ? rawId.slice(NATIVE_THREAD_PREFIX.length)
    : rawId;

  if (value.startsWith('pending:') || value.startsWith('pending%3A')) {
    return null;
  }
  return value;
}

/**
 * Read-only SQLite reader for T3 Code's `statev2.sqlite` projection tables.
 */
export class T3StateReader {
  #dbPath;
  #providersDir;
  #logger;

  constructor({
    dbPath = resolveDefaultStateDbPath(),
    providersDir = resolveDefaultProvidersDir(),
    logger = console,
  } = {}) {
    this.#dbPath = dbPath;
    this.#providersDir = providersDir;
    this.#logger = logger;
  }

  #openReadOnly() {
    try {
      return new DatabaseSync(this.#dbPath, { readOnly: true });
    } catch (error) {
      this.#logger.warn({
        status: 'DEGRADED',
        component: 'T3StateReader',
        message: 'Unable to open statev2.sqlite in read-only mode',
        dbPath: this.#dbPath,
        error: error.message,
      });
      return null;
    }
  }

  async resolveTranscriptPath(conversationId) {
    if (!conversationId) {
      return null;
    }
    try {
      const entries = await fs.readdir(this.#providersDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const candidate = path.join(
          this.#providersDir,
          entry.name,
          'antigravity-acp',
          'brain',
          conversationId,
          '.system_generated',
          'logs',
          'transcript.jsonl',
        );
        try {
          await fs.access(candidate);
          return candidate;
        } catch {
          // Continue scanning account-hash directories
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  #collectRecursiveSubagents(db, rootThreadId) {
    const visited = new Set([rootThreadId]);
    const queue = [{ threadId: rootThreadId, depth: 1 }];
    const collected = [];

    const stmt = db.prepare(`
      SELECT subagent_id, thread_id, run_id, parent_node_id, provider,
             provider_thread_id, child_thread_id, origin, status,
             started_at, completed_at, updated_at, payload_json, driver,
             completion_delivery_state
      FROM orchestration_v2_projection_subagents
      WHERE thread_id = ?
      ORDER BY started_at ASC, subagent_id ASC
    `);

    while (queue.length > 0) {
      const { threadId, depth } = queue.shift();
      const rows = stmt.all(threadId);
      for (const row of rows) {
        const conversationId = extractConversationId(row.provider_thread_id);
        collected.push({
          ...row,
          depth,
          conversationId,
        });
        if (row.child_thread_id && !visited.has(row.child_thread_id)) {
          visited.add(row.child_thread_id);
          queue.push({ threadId: row.child_thread_id, depth: depth + 1 });
        }
      }
    }

    return collected;
  }

  async getThreadSnapshot(threadId) {
    if (!threadId) {
      return null;
    }
    const db = this.#openReadOnly();
    if (!db) {
      return null;
    }

    try {
      const thread = db
        .prepare(
          `SELECT t.*, p.title AS project_title, p.workspace_root AS project_workspace_root
           FROM projection_threads t
           LEFT JOIN projection_projects p ON p.project_id = t.project_id
           WHERE t.thread_id = ? AND t.deleted_at IS NULL`,
        )
        .get(threadId);

      if (!thread) {
        return null;
      }

      const session =
        db
          .prepare(`SELECT * FROM projection_thread_sessions WHERE thread_id = ?`)
          .get(threadId) ?? null;

      const runs = db
        .prepare(
          `SELECT * FROM orchestration_v2_projection_runs
           WHERE thread_id = ?
           ORDER BY ordinal ASC`,
        )
        .all(threadId);

      const checkpoints = db
        .prepare(
          `SELECT * FROM orchestration_v2_projection_checkpoints
           WHERE thread_id = ?
           ORDER BY ordinal_within_scope ASC, captured_at ASC`,
        )
        .all(threadId);

      const rawSubagents = this.#collectRecursiveSubagents(db, threadId);
      const subagents = await Promise.all(
        rawSubagents.map(async (sub) => ({
          ...sub,
          transcriptPath: await this.resolveTranscriptPath(sub.conversationId),
        })),
      );

      const conversationId =
        extractConversationId(session?.provider_thread_id) ??
        [...runs].reverse().map((r) => extractConversationId(r.provider_thread_id)).find(Boolean) ??
        null;

      const transcriptPath = await this.resolveTranscriptPath(conversationId);

      return {
        thread,
        session,
        conversationId,
        transcriptPath,
        runs,
        subagents,
        checkpoints,
      };
    } catch (error) {
      this.#logger.warn({
        status: 'DEGRADED',
        component: 'T3StateReader',
        message: 'Failed querying statev2.sqlite',
        threadId,
        error: error.message,
      });
      return null;
    } finally {
      db.close();
    }
  }

  listActiveThreads({ limit = 50 } = {}) {
    const db = this.#openReadOnly();
    if (!db) {
      return [];
    }

    try {
      return db
        .prepare(
          `SELECT t.thread_id, t.project_id, t.title, t.branch, t.worktree_path,
                  t.latest_turn_id, t.updated_at, p.title AS project_title,
                  s.status AS session_status, s.provider_name, s.provider_thread_id
           FROM projection_threads t
           LEFT JOIN projection_projects p ON p.project_id = t.project_id
           LEFT JOIN projection_thread_sessions s ON s.thread_id = t.thread_id
           WHERE t.deleted_at IS NULL AND t.archived_at IS NULL
           ORDER BY t.updated_at DESC
           LIMIT ?`,
        )
        .all(limit);
    } catch (error) {
      this.#logger.warn({
        status: 'DEGRADED',
        component: 'T3StateReader',
        message: 'Failed listing active threads from statev2.sqlite',
        error: error.message,
      });
      return [];
    } finally {
      db.close();
    }
  }
}

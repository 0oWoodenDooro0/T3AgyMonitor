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

function parseJsonSafe(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractProviderConversationId(providerThreadId, payloadJson) {
  const direct = extractConversationId(providerThreadId);
  if (direct) {
    return direct;
  }
  const payload = parseJsonSafe(payloadJson);
  const nativeId = payload?.nativeThreadRef?.nativeId;
  return extractConversationId(nativeId);
}

function hasTable(db, tableName) {
  const row = db
    .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName);
  return Boolean(row?.present);
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
      let thread = null;
      let session = null;

      if (hasTable(db, 'orchestration_v2_projection_threads')) {
        const v2Thread = db
          .prepare(
            `SELECT t.*, p.title AS project_title, p.workspace_root AS project_workspace_root
             FROM orchestration_v2_projection_threads t
             LEFT JOIN projection_projects p ON p.project_id = t.project_id
             WHERE t.thread_id = ? AND t.deleted_at IS NULL`,
          )
          .get(threadId);

        if (v2Thread) {
          const payload = parseJsonSafe(v2Thread.payload_json);
          thread = {
            ...v2Thread,
            branch: v2Thread.branch ?? payload?.branch ?? null,
            worktree_path: v2Thread.worktree_path ?? payload?.worktreePath ?? null,
          };

          if (hasTable(db, 'orchestration_v2_projection_provider_threads')) {
            const pt =
              db
                .prepare(
                  `SELECT * FROM orchestration_v2_projection_provider_threads
                   WHERE thread_id = ?
                   ORDER BY (provider_thread_id = ?) DESC, updated_at DESC
                   LIMIT 1`,
                )
                .get(threadId, v2Thread.active_provider_thread_id ?? '') ?? null;
            if (pt) {
              session = {
                ...pt,
                provider_name: pt.provider ?? null,
              };
            }
          }
        }
      }

      if (!thread && hasTable(db, 'projection_threads')) {
        thread = db
          .prepare(
            `SELECT t.*, p.title AS project_title, p.workspace_root AS project_workspace_root
             FROM projection_threads t
             LEFT JOIN projection_projects p ON p.project_id = t.project_id
             WHERE t.thread_id = ? AND t.deleted_at IS NULL`,
          )
          .get(threadId);

        if (thread && hasTable(db, 'projection_thread_sessions')) {
          session =
            db
              .prepare(`SELECT * FROM projection_thread_sessions WHERE thread_id = ?`)
              .get(threadId) ?? null;
        }
      }

      if (!thread) {
        return null;
      }

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
        extractProviderConversationId(session?.provider_thread_id, session?.payload_json) ??
        [...runs]
          .reverse()
          .map((r) => extractProviderConversationId(r.provider_thread_id, r.payload_json))
          .find(Boolean) ??
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
      if (hasTable(db, 'orchestration_v2_projection_threads')) {
        const hasProvThreads = hasTable(db, 'orchestration_v2_projection_provider_threads');
        const v2Rows = hasProvThreads
          ? db
              .prepare(
                `SELECT t.thread_id, t.project_id, t.title, t.default_provider,
                        t.active_provider_thread_id, t.updated_at, t.payload_json,
                        p.title AS project_title,
                        pt.status AS session_status, pt.provider AS provider_name,
                        pt.provider_thread_id, pt.payload_json AS provider_payload_json
                 FROM orchestration_v2_projection_threads t
                 LEFT JOIN projection_projects p ON p.project_id = t.project_id
                 LEFT JOIN orchestration_v2_projection_provider_threads pt
                   ON pt.provider_thread_id = COALESCE(
                     t.active_provider_thread_id,
                     (SELECT pt2.provider_thread_id
                      FROM orchestration_v2_projection_provider_threads pt2
                      WHERE pt2.thread_id = t.thread_id
                      ORDER BY pt2.updated_at DESC
                      LIMIT 1)
                   )
                 WHERE t.deleted_at IS NULL AND t.archived_at IS NULL
                 ORDER BY t.updated_at DESC
                 LIMIT ?`,
              )
              .all(limit)
          : db
              .prepare(
                `SELECT t.thread_id, t.project_id, t.title, t.default_provider,
                        t.active_provider_thread_id, t.updated_at, t.payload_json,
                        p.title AS project_title
                 FROM orchestration_v2_projection_threads t
                 LEFT JOIN projection_projects p ON p.project_id = t.project_id
                 WHERE t.deleted_at IS NULL AND t.archived_at IS NULL
                 ORDER BY t.updated_at DESC
                 LIMIT ?`,
              )
              .all(limit);

        if (v2Rows.length > 0) {
          return v2Rows.map((row) => {
            const threadPayload = parseJsonSafe(row.payload_json);
            return {
              thread_id: row.thread_id,
              project_id: row.project_id,
              title: row.title,
              branch: threadPayload?.branch ?? null,
              worktree_path: threadPayload?.worktreePath ?? null,
              latest_turn_id: null,
              updated_at: row.updated_at,
              project_title: row.project_title ?? null,
              session_status: row.session_status ?? null,
              provider_name: row.provider_name ?? row.default_provider ?? null,
              provider_thread_id: row.provider_thread_id ?? row.active_provider_thread_id ?? null,
              conversation_id: extractProviderConversationId(
                row.provider_thread_id,
                row.provider_payload_json,
              ),
            };
          });
        }
      }

      if (!hasTable(db, 'projection_threads')) {
        return [];
      }

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

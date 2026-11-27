import fs from 'node:fs/promises';
import { parseTranscriptLines } from '../data/transcript-parser.mjs';

const RUNNING_STATUSES = new Set(['running', 'queued', 'starting', 'working', 'in_progress']);

function parseTimestampMs(ts) {
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    return ts;
  }
  if (typeof ts === 'string' && ts.trim().length > 0) {
    const parsed = Date.parse(ts);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function isMainTurnBoundary(event) {
  if (!event || event.type !== 'USER_INPUT') {
    return false;
  }
  if (event.source === 'SUBAGENT_NOTIFICATION') {
    return false;
  }
  if (typeof event.content === 'string' && event.content.includes('<SUBAGENT_NOTIFICATION>')) {
    return false;
  }
  return true;
}

function cleanSummaryText(raw) {
  if (typeof raw !== 'string') {
    return '';
  }
  let text = raw;
  text = text.replace(/<t3_code_instructions>[\s\S]*?<\/t3_code_instructions>/gi, ' ');
  text = text.replace(/<\/?t3_code_instructions>/gi, ' ');
  text = text.replace(/<\/?USER_REQUEST>/gi, ' ');
  text = text.replace(/^(?:Created At|Completed At):[^\n]*$/gim, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  return text.slice(0, 160);
}

function summarizeEvent(event) {
  if (!event) {
    return '';
  }
  if (typeof event.content === 'string' && event.content.trim().length > 0) {
    const cleaned = cleanSummaryText(event.content);
    if (cleaned.length > 0) {
      return cleaned;
    }
  }
  if (Array.isArray(event.tool_calls) && event.tool_calls.length > 0) {
    const names = event.tool_calls.map((t) => t?.name ?? 'tool').join(', ');
    return `Tool calls: ${names}`;
  }
  if (event.error) {
    return cleanSummaryText(String(event.error));
  }
  return event.type ?? 'EVENT';
}

function formatSubagentLabel(sub, index) {
  const candidates = [sub?.title, sub?.label];
  for (const raw of candidates) {
    if (typeof raw !== 'string') {
      continue;
    }
    const trimmed = raw.trim();
    if (!trimmed || /^(?:node|thread|provider-thread):/i.test(trimmed)) {
      continue;
    }
    return trimmed.length > 42 ? `${trimmed.slice(0, 41)}…` : trimmed;
  }
  return `Subagent #${index + 1}`;
}

function buildTurnsFromMainEvents(mainEvents, runs = []) {
  const turns = [];
  let currentTurn = null;

  for (let i = 0; i < mainEvents.length; i += 1) {
    const ev = mainEvents[i];
    const tsMs = parseTimestampMs(ev.created_at);
    if (!currentTurn || isMainTurnBoundary(ev)) {
      const turnIndex = turns.length + 1;
      const run = runs[turnIndex - 1] ?? null;
      currentTurn = {
        turnId: ev.turn_id ?? run?.turn_id ?? `turn-${turnIndex}`,
        turnIndex,
        startMs: tsMs,
        endMs: Infinity,
        startedAt: ev.created_at ?? run?.started_at ?? null,
        completedAt: run?.completed_at ?? null,
        status: run?.status ?? 'active',
        entries: [],
        runningTasks: [],
      };
      if (turns.length > 0) {
        turns[turns.length - 1].endMs = tsMs;
      }
      turns.push(currentTurn);
    }
  }

  if (turns.length === 0) {
    turns.push({
      turnId: 'turn-1',
      turnIndex: 1,
      startMs: 0,
      endMs: Infinity,
      startedAt: null,
      completedAt: null,
      status: 'active',
      entries: [],
      runningTasks: [],
    });
  }

  return turns;
}

function findTurnForTimestamp(turns, tsMs) {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (tsMs >= turns[i].startMs && tsMs < turns[i].endMs) {
      return turns[i];
    }
  }
  return turns[0];
}

function normalizeEntry(event, meta, orderIndex) {
  const timestamp = event.created_at ?? null;
  return {
    id: event.id ?? `${meta.agentId}:${orderIndex}`,
    agentId: meta.agentId,
    agentKind: meta.agentKind,
    agentLabel: meta.agentLabel,
    depth: meta.depth,
    parentAgentId: meta.parentAgentId,
    timestamp,
    timestampMs: parseTimestampMs(timestamp),
    orderIndex,
    type: event.type ?? 'GENERIC',
    summary: summarizeEvent(event),
    toolCalls: Array.isArray(event.tool_calls) ? event.tool_calls : [],
    raw: event,
  };
}

function logDegraded(logger, reason, message, details = {}) {
  logger?.warn?.({
    status: 'DEGRADED',
    component: 'UnifiedTimeline',
    reason,
    message,
    ...details,
  });
}

function resolveAgentHierarchy(mainThreadId, subagents, logger) {
  const threadToAgent = new Map();
  if (mainThreadId) {
    threadToAgent.set(mainThreadId, { agentId: 'main', depth: 0 });
  }

  const byId = new Map();
  for (const sub of subagents) {
    const id = sub.subagent_id ?? sub.agentId;
    if (id && sub.child_thread_id) {
      threadToAgent.set(sub.child_thread_id, { agentId: id, depth: null });
    }
    if (id) {
      byId.set(id, sub);
    }
  }

  const resolved = new Map();

  function computeNode(sub, stack = new Set()) {
    const id = sub.subagent_id ?? sub.agentId;
    if (!id) {
      return null;
    }
    if (resolved.has(id)) {
      return resolved.get(id);
    }
    if (stack.has(id)) {
      logDegraded(logger, 'cyclic_subagent_reference', 'Cyclic subagent reference detected', {
        agentId: id,
        threadId: sub.thread_id ?? null,
        childThreadId: sub.child_thread_id ?? null,
      });
      return {
        agentId: id,
        parentAgentId: 'main',
        depth: sub.depth ?? 1,
        degraded: true,
      };
    }

    stack.add(id);

    let parentAgentId = sub.parentAgentId ?? null;
    let depth = null;
    let isOrphan = false;

    if (!parentAgentId) {
      if (!mainThreadId || sub.thread_id === mainThreadId || !sub.thread_id) {
        parentAgentId = 'main';
        depth = 1;
      } else if (threadToAgent.has(sub.thread_id)) {
        const parentRef = threadToAgent.get(sub.thread_id);
        parentAgentId = parentRef.agentId;
      } else {
        isOrphan = true;
        logDegraded(logger, 'orphan_subagent_reference', 'Orphan subagent reference detected', {
          agentId: id,
          threadId: sub.thread_id,
          childThreadId: sub.child_thread_id ?? null,
        });
      }
    } else if (parentAgentId !== 'main' && !byId.has(parentAgentId)) {
      isOrphan = true;
      logDegraded(logger, 'orphan_subagent_reference', 'Orphan subagent reference detected', {
        agentId: id,
        parentAgentId,
      });
    }

    if (depth === null) {
      if (parentAgentId === 'main') {
        depth = 1;
      } else if (parentAgentId && byId.has(parentAgentId)) {
        const parentNode = computeNode(byId.get(parentAgentId), stack);
        depth = (parentNode?.depth ?? 0) + 1;
      } else {
        depth = sub.depth ?? 1;
        parentAgentId = parentAgentId ?? 'main';
      }
    }

    stack.delete(id);
    const info = { agentId: id, parentAgentId, depth, orphan: isOrphan };
    resolved.set(id, info);
    return info;
  }

  for (const sub of subagents) {
    computeNode(sub);
  }

  return resolved;
}

/**
 * Merge main thread events and recursive subagents / delegated tasks / swarm workers
 * chronologically, grouped by turn.
 */
export function buildUnifiedTimeline({
  mainThread = {},
  subagents = [],
  runs = [],
  agentId = 'all',
  nowMs = Date.now(),
  logger = console,
} = {}) {
  const mainEvents = Array.isArray(mainThread.events) ? mainThread.events : [];
  const turns = buildTurnsFromMainEvents(mainEvents, runs);

  const mainMeta = {
    agentId: 'main',
    agentKind: 'main',
    agentLabel: 'Main Agent',
    depth: 0,
    parentAgentId: null,
  };

  const availableAgents = [
    {
      agentId: mainMeta.agentId,
      kind: mainMeta.agentKind,
      label: mainMeta.agentLabel,
      depth: 0,
      parentAgentId: null,
      status: 'active',
    },
  ];

  for (let i = 0; i < mainEvents.length; i += 1) {
    const entry = normalizeEntry(mainEvents[i], mainMeta, i);
    const turn = findTurnForTimestamp(turns, entry.timestampMs);
    entry.turnId = turn.turnId;
    entry.turnIndex = turn.turnIndex;
    turn.entries.push(entry);
  }

  const hierarchy = resolveAgentHierarchy(
    mainThread.threadId ?? mainThread.thread_id,
    subagents,
    logger,
  );

  let subIndex = 0;
  for (const sub of subagents) {
    const subId = sub.subagent_id ?? sub.agentId;
    if (!subId) {
      continue;
    }
    const node = hierarchy.get(subId) ?? { agentId: subId, parentAgentId: 'main', depth: sub.depth ?? 1 };
    const subMeta = {
      agentId: subId,
      agentKind: sub.origin ?? sub.kind ?? 'subagent',
      agentLabel: formatSubagentLabel(sub, subIndex),
      depth: node.depth,
      parentAgentId: node.parentAgentId,
    };
    subIndex += 1;

    availableAgents.push({
      agentId: subMeta.agentId,
      kind: subMeta.agentKind,
      label: subMeta.agentLabel,
      depth: subMeta.depth,
      parentAgentId: subMeta.parentAgentId,
      status: sub.status ?? 'unknown',
      orphan: Boolean(node.orphan),
    });

    if (!Array.isArray(sub.events) || sub.transcriptMissing) {
      logDegraded(logger, 'missing_child_transcript', 'Missing child transcript for subagent', {
        agentId: subId,
        conversationId: sub.conversationId ?? null,
        childThreadId: sub.child_thread_id ?? null,
      });
    }

    const subEvents = Array.isArray(sub.events) ? sub.events : [];
    let latestStepSummary = null;
    for (let i = 0; i < subEvents.length; i += 1) {
      const entry = normalizeEntry(subEvents[i], subMeta, i);
      const turn = findTurnForTimestamp(turns, entry.timestampMs);
      entry.turnId = turn.turnId;
      entry.turnIndex = turn.turnIndex;
      turn.entries.push(entry);
      latestStepSummary = entry.summary;
    }

    if (RUNNING_STATUSES.has(sub.status)) {
      const startedAtMs = parseTimestampMs(sub.started_at ?? subEvents[0]?.created_at);
      const anchorMs = startedAtMs > 0 ? startedAtMs : nowMs;
      const enclosingTurn = findTurnForTimestamp(turns, anchorMs);
      enclosingTurn.runningTasks.push({
        agentId: subMeta.agentId,
        kind: subMeta.agentKind,
        label: subMeta.agentLabel,
        status: sub.status,
        depth: subMeta.depth,
        parentAgentId: subMeta.parentAgentId,
        startedAt: sub.started_at ?? null,
        elapsedMs: startedAtMs > 0 ? Math.max(0, nowMs - startedAtMs) : 0,
        latestStepSummary: latestStepSummary ?? sub.status,
        eventCount: subEvents.length,
        expandable: true,
      });
    }
  }

  for (const turn of turns) {
    turn.entries.sort((a, b) => {
      if (a.timestampMs !== b.timestampMs) {
        return a.timestampMs - b.timestampMs;
      }
      if (a.depth !== b.depth) {
        return a.depth - b.depth;
      }
      return a.orderIndex - b.orderIndex;
    });

    if (agentId && agentId !== 'all') {
      turn.entries = turn.entries.filter((entry) => entry.agentId === agentId);
      turn.runningTasks = turn.runningTasks.filter((task) => task.agentId === agentId);
    }
  }

  const filteredTurns =
    agentId && agentId !== 'all'
      ? turns.filter((turn) => turn.entries.length > 0 || turn.runningTasks.length > 0)
      : turns;

  return {
    agentFilter: agentId ?? 'all',
    availableAgents,
    turns: filteredTurns,
  };
}

async function defaultReadTranscript(transcriptPath, { logger = console } = {}) {
  if (!transcriptPath) {
    return null;
  }
  try {
    const raw = await fs.readFile(transcriptPath, 'utf8');
    return parseTranscriptLines(raw.split('\n'), { logger, sourcePath: transcriptPath });
  } catch (error) {
    logger?.warn?.({
      status: 'DEGRADED',
      component: 'UnifiedTimeline',
      reason: 'transcript_read_error',
      message: 'Failed reading transcript file',
      transcriptPath,
      error: error.message,
    });
    return null;
  }
}

/**
 * Load main and recursive child transcripts from a T3StateReader snapshot and merge them.
 */
export async function collectUnifiedTimeline({
  threadId,
  stateReader,
  readTranscript,
  agentId = 'all',
  nowMs = Date.now(),
  logger = console,
} = {}) {
  if (!stateReader || !threadId) {
    return buildUnifiedTimeline({ agentId, nowMs, logger });
  }

  const snapshot = await stateReader.getThreadSnapshot(threadId);
  if (!snapshot) {
    logDegraded(logger, 'missing_thread_snapshot', 'Thread snapshot not found', { threadId });
    return buildUnifiedTimeline({ agentId, nowMs, logger });
  }

  const loadTranscript =
    readTranscript ?? ((filePath) => defaultReadTranscript(filePath, { logger }));

  const mainEvents = snapshot.transcriptPath
    ? ((await loadTranscript(snapshot.transcriptPath)) ?? [])
    : [];

  const enrichedSubagents = await Promise.all(
    (snapshot.subagents ?? []).map(async (sub) => {
      const childPath =
        sub.transcriptPath ??
        (sub.conversationId && stateReader.resolveTranscriptPath
          ? await stateReader.resolveTranscriptPath(sub.conversationId)
          : null);

      if (!childPath) {
        return { ...sub, events: null, transcriptMissing: true };
      }
      const events = await loadTranscript(childPath);
      return {
        ...sub,
        transcriptPath: childPath,
        events: Array.isArray(events) ? events : null,
        transcriptMissing: !Array.isArray(events),
      };
    }),
  );

  return buildUnifiedTimeline({
    mainThread: {
      threadId: snapshot.thread?.thread_id ?? threadId,
      title: snapshot.thread?.title ?? 'Main Agent',
      events: mainEvents,
    },
    subagents: enrichedSubagents,
    runs: snapshot.runs ?? [],
    agentId,
    nowMs,
    logger,
  });
}

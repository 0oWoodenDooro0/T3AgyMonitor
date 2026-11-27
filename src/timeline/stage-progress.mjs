const COMPLETED_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

function parseTs(ts) {
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    return ts;
  }
  if (typeof ts === 'string' && ts.trim().length > 0) {
    const parsed = Date.parse(ts);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function getToolCalls(event) {
  if (!event) {
    return [];
  }
  if (Array.isArray(event.tool_calls)) {
    return event.tool_calls;
  }
  if (Array.isArray(event.toolCalls)) {
    return event.toolCalls;
  }
  return [];
}

function isToolStep(event) {
  if (!event) {
    return false;
  }
  if (event.type === 'GENERIC') {
    return true;
  }
  if (event.type === 'PLANNER_RESPONSE' && getToolCalls(event).length > 0) {
    return true;
  }
  return false;
}

function formatDurationSec(ms) {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

/**
 * Aggregate consecutive tool calls within an active turn into a concise Stage Progress summary,
 * and transition to a collapsed turn duration bar once the turn completes.
 */
export function computeStageProgress({
  events = [],
  turnStatus = 'active',
  startedAt = null,
  completedAt = null,
  nowMs = Date.now(),
} = {}) {
  const list = Array.isArray(events) ? events : [];
  const firstEventMs = parseTs(list[0]?.created_at ?? list[0]?.timestamp);
  const lastEventMs = parseTs(list[list.length - 1]?.created_at ?? list[list.length - 1]?.timestamp);
  const turnStartMs = parseTs(startedAt) ?? firstEventMs ?? nowMs;
  const turnEndMs = parseTs(completedAt);
  const isCompleted = COMPLETED_STATUSES.has(turnStatus) || turnEndMs !== null;

  if (isCompleted) {
    let totalTools = 0;
    const allTools = [];
    for (const ev of list) {
      for (const tc of getToolCalls(ev)) {
        totalTools += 1;
        allTools.push(tc?.name ?? 'tool');
      }
    }
    const endMs = turnEndMs ?? lastEventMs ?? nowMs;
    const durationMs = Math.max(0, endMs - turnStartMs);
    const toolSuffix =
      totalTools > 0 ? ` (${totalTools} tool call${totalTools === 1 ? '' : 's'})` : '';
    return {
      mode: 'collapsed',
      collapsed: true,
      stageLabel: `Completed in ${formatDurationSec(durationMs)}${toolSuffix}`,
      toolCount: totalTools,
      tools: allTools,
      durationMs,
      elapsedMs: durationMs,
    };
  }

  // Scan backward for consecutive tool-call / tool-result steps at the tail of the active turn
  const trailingSteps = [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (isToolStep(list[i])) {
      trailingSteps.unshift(list[i]);
    } else {
      break;
    }
  }

  const tools = [];
  for (const step of trailingSteps) {
    for (const tc of getToolCalls(step)) {
      tools.push(tc?.name ?? 'tool');
    }
  }

  if (tools.length === 0) {
    const elapsedMs = Math.max(0, nowMs - turnStartMs);
    return {
      mode: 'thinking',
      collapsed: false,
      stageLabel: 'Thinking…',
      toolCount: 0,
      tools: [],
      durationMs: null,
      elapsedMs,
    };
  }

  const stageStartMs =
    parseTs(trailingSteps[0]?.created_at ?? trailingSteps[0]?.timestamp) ?? turnStartMs;
  const elapsedMs = Math.max(0, nowMs - stageStartMs);
  const latestTool = tools[tools.length - 1];
  const stageLabel = `Running ${tools.length} tool call${tools.length === 1 ? '' : 's'} (latest: ${latestTool})`;

  return {
    mode: 'active',
    collapsed: false,
    stageLabel,
    toolCount: tools.length,
    tools,
    durationMs: null,
    elapsedMs,
  };
}

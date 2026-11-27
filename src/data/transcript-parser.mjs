import fs from 'node:fs/promises';

export const CONTEXT_CATEGORIES = Object.freeze([
  'User Messages',
  'Assistant & Thinking',
  'Tool Calls',
  'Tool Results',
  'Subagent Notifications',
  'Checkpoints',
  'System & Tools Overhead',
]);

function toNonNegativeInt(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0;
}

function payloadTokens(value, explicitTokens) {
  if (Number.isFinite(Number(explicitTokens)) && Number(explicitTokens) >= 0) {
    return Math.floor(Number(explicitTokens));
  }
  if (!value) {
    return 0;
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 0 ? Math.ceil(text.length / 4) : 0;
}

function isSubagentNotification(event) {
  if (event.source === 'SUBAGENT_NOTIFICATION') {
    return true;
  }
  if (typeof event.content === 'string' && event.content.includes('<SUBAGENT_NOTIFICATION>')) {
    return true;
  }
  return false;
}

/**
 * Parse raw JSONL lines, skipping malformed lines with a structured DEGRADED warning.
 */
export function parseTranscriptLines(lines, { logger = console, sourcePath = null } = {}) {
  const events = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]?.trim();
    if (!raw) {
      continue;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        events.push(parsed);
      }
    } catch (error) {
      logger.warn({
        status: 'DEGRADED',
        component: 'TranscriptParser',
        message: 'Skipping malformed JSONL line in transcript',
        lineIndex: i,
        sourcePath,
        error: error.message,
      });
    }
  }
  return events;
}

/**
 * Compute exact 7-category Context Breakdown from transcript events and SQLite checkpoints.
 * Per ADR-0002, never estimates System Prompt / User Rules / Skills / MCP Tools from local files.
 */
export function computeContextBreakdown(events, { checkpoints = [] } = {}) {
  const categories = {
    'User Messages': 0,
    'Assistant & Thinking': 0,
    'Tool Calls': 0,
    'Tool Results': 0,
    'Subagent Notifications': 0,
    Checkpoints: 0,
    'System & Tools Overhead': 0,
  };

  let latestInputTokens = 0;

  for (const event of events) {
    if (event.type === 'USER_INPUT') {
      if (isSubagentNotification(event)) {
        categories['Subagent Notifications'] += payloadTokens(event.content, event.tokens);
      } else {
        categories['User Messages'] += payloadTokens(event.content, event.tokens);
      }
    } else if (event.type === 'PLANNER_RESPONSE') {
      latestInputTokens = toNonNegativeInt(event.input_tokens);
      const toolCallsTokens = Array.isArray(event.tool_calls)
        ? payloadTokens(event.tool_calls, event.tool_calls_tokens)
        : 0;
      const outputTokens = toNonNegativeInt(event.output_tokens);
      const assistantTokens =
        outputTokens > 0
          ? outputTokens
          : payloadTokens(event.content, event.tokens) + payloadTokens(event.thinking);

      categories['Assistant & Thinking'] += assistantTokens;
      categories['Tool Calls'] += toolCallsTokens;
    } else if (event.type === 'GENERIC') {
      categories['Tool Results'] += payloadTokens(event.content ?? event.error, event.tokens);
    } else if (event.type === 'SYSTEM_MESSAGE' && isSubagentNotification(event)) {
      categories['Subagent Notifications'] += payloadTokens(event.content, event.tokens);
    }
  }

  for (const cp of checkpoints) {
    categories.Checkpoints += payloadTokens(cp.payload_json ?? cp, cp.tokens);
  }

  const knownSum =
    categories['User Messages'] +
    categories['Assistant & Thinking'] +
    categories['Tool Calls'] +
    categories['Tool Results'] +
    categories['Subagent Notifications'] +
    categories.Checkpoints;

  categories['System & Tools Overhead'] = Math.max(0, latestInputTokens - knownSum);

  return {
    totalInputTokens: latestInputTokens,
    categories,
  };
}

/**
 * Compute cache hit rate and transcript-fallback tokens/sec from parsed events.
 */
export function computeTranscriptMetrics(events) {
  let latestPlanner = null;
  let latestPlannerIndex = -1;
  let totalOutputTokens = 0;
  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let plannerSteps = 0;

  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i];
    if (ev.type === 'PLANNER_RESPONSE') {
      latestPlanner = ev;
      latestPlannerIndex = i;
      plannerSteps += 1;
      totalInputTokens += toNonNegativeInt(ev.input_tokens);
      totalCacheReadTokens += toNonNegativeInt(ev.cache_read_tokens);
      totalOutputTokens += toNonNegativeInt(ev.output_tokens);
    }
  }

  if (!latestPlanner) {
    return {
      model: null,
      cacheHitRate: null,
      tokensPerSecond: null,
      latestInputTokens: 0,
      latestCacheReadTokens: 0,
      latestOutputTokens: 0,
      totalInputTokens: 0,
      totalCacheReadTokens: 0,
      totalOutputTokens: 0,
      plannerSteps: 0,
    };
  }

  const latestInputTokens = toNonNegativeInt(latestPlanner.input_tokens);
  const latestCacheReadTokens = toNonNegativeInt(latestPlanner.cache_read_tokens);
  const latestOutputTokens = toNonNegativeInt(latestPlanner.output_tokens);

  const cacheHitRate =
    latestInputTokens > 0 ? Math.min(1, latestCacheReadTokens / latestInputTokens) : 0;

  let tokensPerSecond = null;
  if (latestPlannerIndex > 0 && latestPlanner.created_at) {
    const prev = events[latestPlannerIndex - 1];
    if (prev?.created_at) {
      const currMs = Date.parse(latestPlanner.created_at);
      const prevMs = Date.parse(prev.created_at);
      const durationSec = (currMs - prevMs) / 1000;
      if (Number.isFinite(durationSec) && durationSec > 0) {
        tokensPerSecond = latestOutputTokens / durationSec;
      }
    }
  }

  return {
    model: latestPlanner.model ?? null,
    cacheHitRate,
    tokensPerSecond,
    latestInputTokens,
    latestCacheReadTokens,
    latestOutputTokens,
    totalInputTokens,
    totalCacheReadTokens,
    totalOutputTokens,
    plannerSteps,
  };
}

/**
 * Incremental byte-offset reader for append-only `transcript.jsonl` files.
 */
export class IncrementalTranscriptReader {
  #filePath;
  #logger;
  #byteOffset = 0;
  #remainder = '';
  #events = [];

  constructor(filePath, { logger = console } = {}) {
    this.#filePath = filePath;
    this.#logger = logger;
  }

  getEvents() {
    return this.#events;
  }

  async readIncremental({ checkpoints = [] } = {}) {
    let handle;
    try {
      const stat = await fs.stat(this.#filePath);
      if (stat.size < this.#byteOffset) {
        // File was truncated/rotated; reset incremental state.
        this.#byteOffset = 0;
        this.#remainder = '';
        this.#events = [];
      }

      if (stat.size === this.#byteOffset) {
        return {
          newEvents: [],
          allEvents: this.#events,
          breakdown: computeContextBreakdown(this.#events, { checkpoints }),
          metrics: computeTranscriptMetrics(this.#events),
        };
      }

      const bytesToRead = stat.size - this.#byteOffset;
      const buffer = Buffer.allocUnsafe(bytesToRead);
      handle = await fs.open(this.#filePath, 'r');
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, this.#byteOffset);
      this.#byteOffset += bytesRead;

      const chunk = this.#remainder + buffer.subarray(0, bytesRead).toString('utf8');
      const lines = chunk.split('\n');
      this.#remainder = lines.pop() ?? '';

      const newEvents = parseTranscriptLines(lines, {
        logger: this.#logger,
        sourcePath: this.#filePath,
      });
      this.#events.push(...newEvents);

      return {
        newEvents,
        allEvents: this.#events,
        breakdown: computeContextBreakdown(this.#events, { checkpoints }),
        metrics: computeTranscriptMetrics(this.#events),
      };
    } catch (error) {
      this.#logger.warn({
        status: 'DEGRADED',
        component: 'TranscriptParser',
        message: 'Failed reading transcript.jsonl incrementally',
        sourcePath: this.#filePath,
        error: error.message,
      });
      return {
        newEvents: [],
        allEvents: this.#events,
        breakdown: computeContextBreakdown(this.#events, { checkpoints }),
        metrics: computeTranscriptMetrics(this.#events),
      };
    } finally {
      if (handle) {
        await handle.close();
      }
    }
  }
}

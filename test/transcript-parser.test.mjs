import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  IncrementalTranscriptReader,
  computeContextBreakdown,
  computeTranscriptMetrics,
  parseTranscriptLines,
} from '../src/data/transcript-parser.mjs';

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 't3-agy-transcript-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('parseTranscriptLines skips malformed JSONL lines with DEGRADED warning', () => {
  const warnings = [];
  const lines = [
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: '2026-11-27T10:00:00Z', content: 'hi' }),
    '{ broken json line',
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-27T10:00:05Z',
      model: 'gemini-4-hydrogen-medium',
      input_tokens: 1000,
      cache_read_tokens: 400,
      output_tokens: 100,
    }),
  ];

  const events = parseTranscriptLines(lines, {
    logger: { warn: (entry) => warnings.push(entry) },
  });

  assert.equal(events.length, 2);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].status, 'DEGRADED');
  assert.equal(warnings[0].component, 'TranscriptParser');
});

test('computeContextBreakdown produces exact 7 categories with residual clamped >= 0', () => {
  const events = [
    { step_index: 0, type: 'USER_INPUT', content: 'abcd'.repeat(10), created_at: '2026-11-27T10:00:00Z' },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      model: 'gemini-4-hydrogen-medium',
      input_tokens: 500,
      cache_read_tokens: 250,
      output_tokens: 60,
      thinking: 'abcd'.repeat(5),
      tool_calls: [{ name: 'read_file', args: { Path: '/tmp/a' } }],
      created_at: '2026-11-27T10:00:05Z',
    },
    { step_index: 2, type: 'GENERIC', content: 'abcd'.repeat(8), created_at: '2026-11-27T10:00:06Z' },
    {
      step_index: 3,
      type: 'SYSTEM_MESSAGE',
      source: 'SUBAGENT_NOTIFICATION',
      content: 'abcd'.repeat(4),
      created_at: '2026-11-27T10:00:07Z',
    },
  ];
  const checkpoints = [{ checkpoint_id: 'cp-1', payload_json: '{"id":"cp-1"}' }];

  const breakdown = computeContextBreakdown(events, { checkpoints });
  assert.deepEqual(Object.keys(breakdown.categories), [
    'User Messages',
    'Assistant & Thinking',
    'Tool Calls',
    'Tool Results',
    'Subagent Notifications',
    'Checkpoints',
    'System & Tools Overhead',
  ]);
  assert.equal(breakdown.totalInputTokens, 750);
  assert.ok(breakdown.categories['System & Tools Overhead'] >= 0);

  // Verify clamping when sum of known categories exceeds input_tokens
  const tinyBudgetEvents = [
    { step_index: 0, type: 'USER_INPUT', content: 'x'.repeat(400), created_at: '2026-11-27T10:00:00Z' },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      input_tokens: 10,
      cache_read_tokens: 0,
      output_tokens: 50,
      created_at: '2026-11-27T10:00:02Z',
    },
  ];
  const clamped = computeContextBreakdown(tinyBudgetEvents);
  assert.equal(clamped.categories['System & Tools Overhead'], 0);
});

test('computeTranscriptMetrics calculates cacheHitRate and returns null tok/s on zero or negative duration', () => {
  const zeroDurationEvents = [
    { step_index: 0, type: 'USER_INPUT', created_at: '2026-11-27T10:00:05Z', content: 'hi' },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-27T10:00:05Z',
      input_tokens: 1000,
      cache_read_tokens: 250,
      output_tokens: 100,
    },
  ];
  const zeroMetrics = computeTranscriptMetrics(zeroDurationEvents);
  assert.equal(zeroMetrics.cacheHitRate, 250 / 1250);
  assert.equal(zeroMetrics.latestContextTokens, 1250);
  assert.equal(zeroMetrics.tokensPerSecond, null);

  const negativeDurationEvents = [
    { step_index: 0, type: 'USER_INPUT', created_at: '2026-11-27T10:00:10Z', content: 'hi' },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-27T10:00:05Z',
      input_tokens: 1000,
      cache_read_tokens: 500,
      output_tokens: 100,
    },
  ];
  assert.equal(computeTranscriptMetrics(negativeDurationEvents).tokensPerSecond, null);

  const validEvents = [
    { step_index: 0, type: 'USER_INPUT', created_at: '2026-11-27T10:00:00Z', content: 'hi' },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-27T10:00:04Z',
      input_tokens: 1000,
      cache_read_tokens: 500,
      output_tokens: 100,
    },
  ];
  assert.equal(computeTranscriptMetrics(validEvents).tokensPerSecond, 25);
});

test('computeTranscriptMetrics and computeContextBreakdown handle Antigravity uncached input_tokens + cache_read_tokens', () => {
  const events = [
    { step_index: 0, type: 'USER_INPUT', content: 'Analyze the codebase', created_at: '2026-11-27T10:00:00Z' },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      model: 'gemini-4-hydrogen-medium',
      input_tokens: 2941,
      cache_read_tokens: 256726,
      output_tokens: 412,
      created_at: '2026-11-27T10:00:04Z',
    },
  ];

  const metrics = computeTranscriptMetrics(events);
  assert.equal(metrics.latestInputTokens, 2941);
  assert.equal(metrics.latestCacheReadTokens, 256726);
  assert.equal(metrics.latestContextTokens, 259667);
  assert.ok(Math.abs(metrics.cacheHitRate - 256726 / 259667) < 1e-9);
  assert.ok(metrics.cacheHitRate < 1);

  const breakdown = computeContextBreakdown(events);
  assert.equal(breakdown.totalInputTokens, 259667);
  assert.ok(breakdown.categories['System & Tools Overhead'] > 250000);
});

test('IncrementalTranscriptReader reads only newly appended lines across polls', async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, 'transcript.jsonl');
    const line1 = JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: '2026-11-27T10:00:00Z', content: 'a' });
    const line2 = JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-27T10:00:02Z',
      input_tokens: 200,
      cache_read_tokens: 100,
      output_tokens: 40,
    });
    await fs.writeFile(filePath, `${line1}\n`, 'utf8');

    const reader = new IncrementalTranscriptReader(filePath, { logger: { warn() {} } });
    const first = await reader.readIncremental();
    assert.equal(first.newEvents.length, 1);
    assert.equal(first.allEvents.length, 1);

    await fs.appendFile(filePath, `${line2}\n`, 'utf8');
    const second = await reader.readIncremental();
    assert.equal(second.newEvents.length, 1);
    assert.equal(second.allEvents.length, 2);
    assert.equal(second.metrics.tokensPerSecond, 20);
  });
});

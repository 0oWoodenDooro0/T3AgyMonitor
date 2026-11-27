import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildUnifiedTimeline,
  collectUnifiedTimeline,
  computeStageProgress,
} from '../src/timeline/index.mjs';

test('buildUnifiedTimeline merges main thread and direct child agents chronologically grouped by turn', () => {
  const result = buildUnifiedTimeline({
    mainThread: {
      threadId: 'thread-main',
      title: 'Main Session',
      events: [
        {
          type: 'USER_INPUT',
          created_at: '2026-11-27T10:00:00.000Z',
          content: 'Inspect the repo',
        },
        {
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-27T10:00:02.000Z',
          content: 'Delegating search',
          tool_calls: [{ name: 'invoke_subagent' }],
        },
        {
          type: 'USER_INPUT',
          created_at: '2026-11-27T10:01:00.000Z',
          content: 'Summarize findings',
        },
        {
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-27T10:01:05.000Z',
          content: 'Here is the summary.',
        },
      ],
    },
    subagents: [
      {
        subagent_id: 'sub-1',
        thread_id: 'thread-main',
        child_thread_id: 'thread-sub-1',
        origin: 'subagent',
        status: 'completed',
        started_at: '2026-11-27T10:00:03.000Z',
        completed_at: '2026-11-27T10:00:10.000Z',
        events: [
          {
            type: 'USER_INPUT',
            created_at: '2026-11-27T10:00:03.500Z',
            content: 'Find all files',
          },
          {
            type: 'PLANNER_RESPONSE',
            created_at: '2026-11-27T10:00:08.000Z',
            content: 'Found 3 files',
          },
        ],
      },
    ],
  });

  assert.equal(result.turns.length, 2);
  assert.equal(result.turns[0].turnIndex, 1);
  assert.equal(result.turns[1].turnIndex, 2);

  // Turn 1 should have 2 main events + 2 subagent events sorted chronologically
  const turn1 = result.turns[0];
  assert.equal(turn1.entries.length, 4);
  assert.deepEqual(
    turn1.entries.map((e) => [e.agentId, e.timestamp]),
    [
      ['main', '2026-11-27T10:00:00.000Z'],
      ['main', '2026-11-27T10:00:02.000Z'],
      ['sub-1', '2026-11-27T10:00:03.500Z'],
      ['sub-1', '2026-11-27T10:00:08.000Z'],
    ],
  );
  assert.equal(turn1.entries[2].agentKind, 'subagent');
  assert.equal(turn1.entries[2].depth, 1);

  // Turn 2 has 2 main events
  assert.equal(result.turns[1].entries.length, 2);
});

test('buildUnifiedTimeline handles nested subagents, inline running-task expansion, and per-agent filtering', () => {
  const input = {
    nowMs: Date.parse('2026-11-27T10:00:15.000Z'),
    mainThread: {
      threadId: 'thread-main',
      title: 'Main Session',
      events: [
        {
          type: 'USER_INPUT',
          created_at: '2026-11-27T10:00:00.000Z',
          content: 'Build feature',
        },
        {
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-27T10:00:02.000Z',
          content: 'Spawning worker and delegate',
        },
      ],
    },
    subagents: [
      {
        subagent_id: 'worker-1',
        thread_id: 'thread-main',
        child_thread_id: 'thread-worker-1',
        origin: 'swarm',
        label: 'Swarm Worker 1',
        status: 'running',
        started_at: '2026-11-27T10:00:03.000Z',
        events: [
          {
            type: 'PLANNER_RESPONSE',
            created_at: '2026-11-27T10:00:05.000Z',
            content: 'Working on module A',
          },
        ],
      },
      {
        subagent_id: 'nested-1',
        thread_id: 'thread-worker-1',
        child_thread_id: 'thread-nested-1',
        origin: 'delegate',
        label: 'Nested Delegate',
        status: 'running',
        started_at: '2026-11-27T10:00:06.000Z',
        events: [
          {
            type: 'GENERIC',
            created_at: '2026-11-27T10:00:09.000Z',
            content: 'Running unit tests',
          },
        ],
      },
    ],
  };

  const allResult = buildUnifiedTimeline(input);
  assert.equal(allResult.turns.length, 1);

  const turn = allResult.turns[0];
  assert.deepEqual(
    turn.entries.map((e) => [e.agentId, e.depth, e.parentAgentId]),
    [
      ['main', 0, null],
      ['main', 0, null],
      ['worker-1', 1, 'main'],
      ['nested-1', 2, 'worker-1'],
    ],
  );

  // Inline running-task expansion metadata attached to the turn
  assert.equal(turn.runningTasks.length, 2);
  assert.deepEqual(
    turn.runningTasks.map((t) => ({
      agentId: t.agentId,
      kind: t.kind,
      depth: t.depth,
      parentAgentId: t.parentAgentId,
      expandable: t.expandable,
      elapsedMs: t.elapsedMs,
      latestStepSummary: t.latestStepSummary,
    })),
    [
      {
        agentId: 'worker-1',
        kind: 'swarm',
        depth: 1,
        parentAgentId: 'main',
        expandable: true,
        elapsedMs: 12000,
        latestStepSummary: 'Working on module A',
      },
      {
        agentId: 'nested-1',
        kind: 'delegate',
        depth: 2,
        parentAgentId: 'worker-1',
        expandable: true,
        elapsedMs: 9000,
        latestStepSummary: 'Running unit tests',
      },
    ],
  );

  // Per-agent filtering
  const filtered = buildUnifiedTimeline({ ...input, agentId: 'nested-1' });
  assert.equal(filtered.agentFilter, 'nested-1');
  assert.equal(filtered.turns.length, 1);
  assert.equal(filtered.turns[0].entries.length, 1);
  assert.equal(filtered.turns[0].entries[0].agentId, 'nested-1');
  assert.deepEqual(
    filtered.availableAgents.map((a) => a.agentId),
    ['main', 'worker-1', 'nested-1'],
  );
});

test('buildUnifiedTimeline logs structured DEGRADED warnings on missing child transcripts, cyclic references, and orphan references', () => {
  const warnings = [];
  const logger = {
    warn: (payload) => warnings.push(payload),
  };

  const result = buildUnifiedTimeline({
    logger,
    mainThread: {
      threadId: 'thread-main',
      events: [
        {
          type: 'USER_INPUT',
          created_at: '2026-11-27T10:00:00.000Z',
          content: 'Start',
        },
      ],
    },
    subagents: [
      // Missing transcript (events is null/undefined and transcriptMissing not suppressed)
      {
        subagent_id: 'sub-missing',
        thread_id: 'thread-main',
        child_thread_id: 'thread-sub-missing',
        origin: 'subagent',
        status: 'running',
        started_at: '2026-11-27T10:00:01.000Z',
        events: null,
      },
      // Cyclic reference: sub-a -> sub-b -> sub-a
      {
        subagent_id: 'sub-a',
        thread_id: 'thread-sub-b',
        child_thread_id: 'thread-sub-a',
        origin: 'subagent',
        status: 'completed',
        events: [
          {
            type: 'PLANNER_RESPONSE',
            created_at: '2026-11-27T10:00:02.000Z',
            content: 'Cycle A',
          },
        ],
      },
      {
        subagent_id: 'sub-b',
        thread_id: 'thread-sub-a',
        child_thread_id: 'thread-sub-b',
        origin: 'subagent',
        status: 'completed',
        events: [
          {
            type: 'PLANNER_RESPONSE',
            created_at: '2026-11-27T10:00:03.000Z',
            content: 'Cycle B',
          },
        ],
      },
      // Orphan reference: thread_id points to unknown thread
      {
        subagent_id: 'sub-orphan',
        thread_id: 'thread-does-not-exist',
        child_thread_id: 'thread-sub-orphan',
        origin: 'delegate',
        status: 'completed',
        events: [
          {
            type: 'PLANNER_RESPONSE',
            created_at: '2026-11-27T10:00:04.000Z',
            content: 'Orphan work',
          },
        ],
      },
    ],
  });

  // Should still produce valid timeline without infinite loop or crash
  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0].runningTasks.length, 1);
  assert.equal(result.turns[0].runningTasks[0].agentId, 'sub-missing');

  assert.ok(warnings.every((w) => w.status === 'DEGRADED' && w.component === 'UnifiedTimeline'));
  const reasons = warnings.map((w) => w.reason);
  assert.ok(reasons.includes('missing_child_transcript'));
  assert.ok(reasons.includes('cyclic_subagent_reference'));
  assert.ok(reasons.includes('orphan_subagent_reference'));
});

test('collectUnifiedTimeline loads main and child transcripts from stateReader snapshot and degrades on missing child transcript', async () => {
  const warnings = [];
  const logger = { warn: (p) => warnings.push(p) };

  const stateReader = {
    async getThreadSnapshot(threadId) {
      assert.equal(threadId, 'thread-1');
      return {
        thread: { thread_id: 'thread-1', title: 'Repo Audit' },
        transcriptPath: '/tmp/main.jsonl',
        runs: [],
        subagents: [
          {
            subagent_id: 'sub-ok',
            thread_id: 'thread-1',
            child_thread_id: 'thread-sub-ok',
            origin: 'subagent',
            status: 'completed',
            conversationId: 'conv-ok',
            depth: 1,
          },
          {
            subagent_id: 'sub-no-file',
            thread_id: 'thread-1',
            child_thread_id: 'thread-sub-missing',
            origin: 'delegate',
            status: 'running',
            conversationId: null,
            depth: 1,
          },
        ],
      };
    },
    async resolveTranscriptPath(convId) {
      return convId === 'conv-ok' ? '/tmp/sub-ok.jsonl' : null;
    },
  };

  const readTranscript = async (transcriptPath) => {
    if (transcriptPath === '/tmp/main.jsonl') {
      return [
        { type: 'USER_INPUT', created_at: '2026-11-27T10:00:00.000Z', content: 'Audit' },
      ];
    }
    if (transcriptPath === '/tmp/sub-ok.jsonl') {
      return [
        { type: 'PLANNER_RESPONSE', created_at: '2026-11-27T10:00:05.000Z', content: 'Done' },
      ];
    }
    return [];
  };

  const timeline = await collectUnifiedTimeline({
    threadId: 'thread-1',
    stateReader,
    readTranscript,
    logger,
  });

  assert.equal(timeline.turns.length, 1);
  assert.equal(timeline.turns[0].entries.length, 2);
  assert.equal(timeline.turns[0].runningTasks.length, 1);
  assert.equal(timeline.turns[0].runningTasks[0].agentId, 'sub-no-file');
  assert.ok(
    warnings.some((w) => w.status === 'DEGRADED' && w.reason === 'missing_child_transcript'),
  );
});

test('computeStageProgress aggregates consecutive tool calls in active turn and collapses on turn completion', () => {
  const activeEvents = [
    {
      type: 'USER_INPUT',
      created_at: '2026-11-27T10:00:00.000Z',
      content: 'Fix the bug',
    },
    {
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-27T10:00:02.000Z',
      tool_calls: [{ name: 'read_file' }, { name: 'run_command' }],
    },
    {
      type: 'GENERIC',
      created_at: '2026-11-27T10:00:04.000Z',
      content: 'file contents...',
    },
    {
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-27T10:00:06.000Z',
      tool_calls: [{ name: 'edit_file' }],
    },
  ];

  const activeStage = computeStageProgress({
    events: activeEvents,
    turnStatus: 'running',
    nowMs: Date.parse('2026-11-27T10:00:10.000Z'),
  });

  assert.equal(activeStage.mode, 'active');
  assert.equal(activeStage.collapsed, false);
  assert.equal(activeStage.toolCount, 3);
  assert.deepEqual(activeStage.tools, ['read_file', 'run_command', 'edit_file']);
  assert.equal(activeStage.elapsedMs, 8000);
  assert.ok(activeStage.stageLabel.includes('3'));
  assert.ok(activeStage.stageLabel.includes('edit_file'));

  // Transition to collapsed turn duration bar when turn completes
  const completedStage = computeStageProgress({
    events: [
      ...activeEvents,
      {
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-27T10:00:12.000Z',
        content: 'All fixed.',
      },
    ],
    turnStatus: 'completed',
    startedAt: '2026-11-27T10:00:00.000Z',
    completedAt: '2026-11-27T10:00:12.000Z',
  });

  assert.equal(completedStage.mode, 'collapsed');
  assert.equal(completedStage.collapsed, true);
  assert.equal(completedStage.toolCount, 3);
  assert.equal(completedStage.durationMs, 12000);
  assert.ok(completedStage.stageLabel.includes('12.0s'));

  // Active turn before any tool calls
  const thinkingStage = computeStageProgress({
    events: [activeEvents[0]],
    turnStatus: 'running',
    nowMs: Date.parse('2026-11-27T10:00:01.500Z'),
  });
  assert.equal(thinkingStage.mode, 'thinking');
  assert.equal(thinkingStage.collapsed, false);
  assert.equal(thinkingStage.toolCount, 0);
  assert.equal(thinkingStage.elapsedMs, 1500);
});

test('buildUnifiedTimeline keeps Main Agent in availableAgents when filtered to subagent, uses clean subagent titles, and strips instruction wrappers from step summaries', () => {
  const result = buildUnifiedTimeline({
    agentId: 'sub-raw',
    mainThread: {
      threadId: 'thread-main',
      title: 'Long Thread Title That Should Not Replace Main Agent',
      events: [
        {
          type: 'USER_INPUT',
          created_at: '2026-11-27T10:00:00.000Z',
          content:
            'Created At: 2026-11-27T10:00:00Z\nCompleted At: 2026-11-27T10:00:05Z\n<t3_code_instructions>Internal instructions here</t3_code_instructions>\n<USER_REQUEST>\nFix the timeline agent filter\n</USER_REQUEST>',
        },
      ],
    },
    subagents: [
      {
        subagent_id: 'sub-titled',
        thread_id: 'thread-main',
        title: 'Investigate SQLite projection schema and subagent titles',
        status: 'completed',
        events: [
          {
            type: 'PLANNER_RESPONSE',
            created_at: '2026-11-27T10:00:02.000Z',
            content: 'Checked schema',
          },
        ],
      },
      {
        subagent_id: 'sub-raw',
        thread_id: 'thread-main',
        label: 'node:delegated-task:command%3Amcp%3At3-code%3Adelegate_task',
        status: 'completed',
        events: [
          {
            type: 'PLANNER_RESPONSE',
            created_at: '2026-11-27T10:00:03.000Z',
            content: 'Completed work',
          },
        ],
      },
    ],
  });

  // Main Agent stays first in availableAgents even when filtered to sub-raw
  assert.deepEqual(
    result.availableAgents.map((a) => ({ agentId: a.agentId, label: a.label })),
    [
      { agentId: 'main', label: 'Main Agent' },
      { agentId: 'sub-titled', label: 'Investigate SQLite projection schema and …' },
      { agentId: 'sub-raw', label: 'Subagent #2' },
    ],
  );
  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0].entries.length, 1);
  assert.equal(result.turns[0].entries[0].agentId, 'sub-raw');

  // Unfiltered timeline cleans instruction wrappers from step summary
  const unfiltered = buildUnifiedTimeline({
    mainThread: {
      threadId: 'thread-main',
      events: [
        {
          type: 'USER_INPUT',
          created_at: '2026-11-27T10:00:00.000Z',
          content:
            'Created At: 2026-11-27T10:00:00Z\nCompleted At: 2026-11-27T10:00:05Z\n<t3_code_instructions>Internal instructions here</t3_code_instructions>\n<USER_REQUEST>\nFix the timeline agent filter\n</USER_REQUEST>',
        },
      ],
    },
  });
  assert.equal(unfiltered.turns[0].entries[0].summary, 'Fix the timeline agent filter');
});

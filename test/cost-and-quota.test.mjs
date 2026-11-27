import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CostCalculator } from '../src/data/cost-calculator.mjs';
import { NullQuotaProvider, QuotaProvider, computeComposerRingState } from '../src/data/quota-provider.mjs';

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 't3-agy-cost-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('CostCalculator falls back to bundled rates and logs DEGRADED warning when rates file is missing', async () => {
  await withTempDir(async (dir) => {
    const warnings = [];
    const calc = new CostCalculator({
      ratesPath: path.join(dir, 'missing-rates.json'),
      logger: { warn: (entry) => warnings.push(entry) },
    });

    await calc.loadRates();
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].status, 'DEGRADED');
    assert.equal(warnings[0].component, 'CostCalculator');

    const step = calc.calculateStepCost({
      model: 'gemini-4-hydrogen-medium',
      inputTokens: 1000,
      cacheReadTokens: 400,
      outputTokens: 200,
    });
    assert.equal(step.rateFound, true);
    assert.ok(step.costUsd > 0);
  });
});

test('CostCalculator loads usage-model-rates.json and summarizes session per-model usage', async () => {
  await withTempDir(async (dir) => {
    const ratesPath = path.join(dir, 'usage-model-rates.json');
    await fs.writeFile(
      ratesPath,
      JSON.stringify({
        fetchedAtMs: 1700000000000,
        document: {
          'custom-model': {
            input_cost_per_token: 0.000002,
            cache_read_input_token_cost: 0.0000005,
            output_cost_per_token: 0.00001,
            max_input_tokens: 200000,
          },
        },
      }),
      'utf8',
    );

    const calc = new CostCalculator({ ratesPath, logger: { warn() {} } });
    await calc.loadRates();

    const summary = calc.summarizeSession([
      { type: 'USER_INPUT', content: 'hi' },
      {
        type: 'PLANNER_RESPONSE',
        model: 'custom-model',
        input_tokens: 1000,
        cache_read_tokens: 200,
        output_tokens: 100,
      },
      {
        type: 'PLANNER_RESPONSE',
        model: 'custom-model',
        input_tokens: 500,
        cache_read_tokens: 0,
        output_tokens: 50,
      },
    ]);

    // Step 1: 800 * 2e-6 + 200 * 5e-7 + 100 * 1e-5 = 0.0016 + 0.0001 + 0.001 = 0.0027
    // Step 2: 500 * 2e-6 + 50 * 1e-5 = 0.001 + 0.0005 = 0.0015
    assert.ok(Math.abs(summary.totalCostUsd - 0.0042) < 1e-9);
    assert.equal(summary.perModel['custom-model'].steps, 2);
    assert.equal(summary.perModel['custom-model'].maxInputTokens, 200000);
  });
});

test('NullQuotaProvider returns null and computeComposerRingState handles context window and soft budgets with [0, 100] clamping', async () => {
  const provider = new NullQuotaProvider();
  assert.equal(provider instanceof QuotaProvider, true);
  assert.equal(provider.isAvailable(), false);
  assert.equal(await provider.getQuota({ model: 'gemini-4-hydrogen' }), null);

  const ctxState = computeComposerRingState({
    ringMode: 'context_window',
    contextTokens: 250000,
    maxContextTokens: 1000000,
  });
  assert.equal(ctxState.source, 'context_window');
  assert.equal(ctxState.remainingPercent, 75);

  const overBudgetUsd = computeComposerRingState({
    ringMode: 'soft_budget_usd',
    softBudgetUsd: 5,
    sessionCostUsd: 8,
  });
  assert.equal(overBudgetUsd.source, 'soft_budget_usd');
  assert.equal(overBudgetUsd.remainingPercent, 0);

  const tokenBudget = computeComposerRingState({
    ringMode: 'soft_budget_tokens',
    softBudgetTokens: 1000,
    sessionTotalTokens: 250,
  });
  assert.equal(tokenBudget.source, 'soft_budget_tokens');
  assert.equal(tokenBudget.remainingPercent, 75);
});

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const BUNDLED_MODEL_RATES = Object.freeze({
  'gemini-4-hydrogen': {
    input_cost_per_token: 0.00000125,
    cache_read_input_token_cost: 0.0000003125,
    output_cost_per_token: 0.00001,
    max_input_tokens: 1000000,
  },
  'gemini-4-neon': {
    input_cost_per_token: 0.0000025,
    cache_read_input_token_cost: 0.000000625,
    output_cost_per_token: 0.000015,
    max_input_tokens: 1000000,
  },
  'gemini-2.5-pro': {
    input_cost_per_token: 0.00000125,
    cache_read_input_token_cost: 0.0000003125,
    output_cost_per_token: 0.00001,
    max_input_tokens: 1000000,
  },
  'gemini-2.5-flash': {
    input_cost_per_token: 0.00000015,
    cache_read_input_token_cost: 0.0000000375,
    output_cost_per_token: 0.0000006,
    max_input_tokens: 1000000,
  },
  'claude-sonnet-4-6': {
    input_cost_per_token: 0.000003,
    cache_read_input_token_cost: 0.0000003,
    output_cost_per_token: 0.000015,
    max_input_tokens: 1000000,
  },
});

const EFFORT_SUFFIX_RE = /-(minimal|low|medium|high)$/;

export function resolveDefaultRatesPath(homeDir = os.homedir()) {
  return path.join(homeDir, '.t3', 'userdata', 'usage-model-rates.json');
}

function toNonNegative(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

function lookupRateEntry(model, rateTable) {
  if (!model || typeof model !== 'string') {
    return null;
  }
  const candidates = [
    model,
    model.replace(EFFORT_SUFFIX_RE, ''),
    model.includes('/') ? model.split('/').pop() : null,
    model.includes('/') ? model.split('/').pop().replace(EFFORT_SUFFIX_RE, '') : null,
  ].filter(Boolean);

  for (const key of candidates) {
    if (rateTable[key]) {
      return rateTable[key];
    }
  }
  return null;
}

/**
 * Calculates per-step and session USD costs from `usage-model-rates.json`
 * with a bundled fallback rate table.
 */
export class CostCalculator {
  #ratesPath;
  #logger;
  #rates = { ...BUNDLED_MODEL_RATES };

  constructor({ ratesPath = resolveDefaultRatesPath(), logger = console } = {}) {
    this.#ratesPath = ratesPath;
    this.#logger = logger;
  }

  async loadRates() {
    try {
      const raw = await fs.readFile(this.#ratesPath, 'utf8');
      const parsed = JSON.parse(raw);
      const doc = parsed?.document && typeof parsed.document === 'object' ? parsed.document : parsed;
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        throw new Error('Invalid usage-model-rates.json structure');
      }
      this.#rates = { ...BUNDLED_MODEL_RATES, ...doc };
    } catch (error) {
      this.#logger.warn({
        status: 'DEGRADED',
        component: 'CostCalculator',
        message: 'Failed to load usage-model-rates.json; using bundled fallback rates',
        ratesPath: this.#ratesPath,
        error: error.message,
      });
      this.#rates = { ...BUNDLED_MODEL_RATES };
    }
    return this.#rates;
  }

  getRate(model) {
    return lookupRateEntry(model, this.#rates) ?? lookupRateEntry(model, BUNDLED_MODEL_RATES);
  }

  calculateStepCost({ model, inputTokens = 0, cacheReadTokens = 0, outputTokens = 0 }) {
    const rate = this.getRate(model);
    const safeInput = toNonNegative(inputTokens);
    const safeCacheRead = Math.min(safeInput, toNonNegative(cacheReadTokens));
    const safeOutput = toNonNegative(outputTokens);
    const uncachedInput = Math.max(0, safeInput - safeCacheRead);

    if (!rate) {
      return {
        model: model ?? null,
        costUsd: 0,
        rateFound: false,
        maxInputTokens: null,
      };
    }

    const inputRate = toNonNegative(rate.input_cost_per_token);
    const cacheReadRate = toNonNegative(rate.cache_read_input_token_cost ?? inputRate);
    const outputRate = toNonNegative(rate.output_cost_per_token);
    const costUsd =
      uncachedInput * inputRate + safeCacheRead * cacheReadRate + safeOutput * outputRate;

    return {
      model: model ?? null,
      costUsd,
      rateFound: true,
      maxInputTokens: Number.isFinite(Number(rate.max_input_tokens))
        ? Number(rate.max_input_tokens)
        : null,
    };
  }

  summarizeSession(events) {
    const perModel = {};
    let totalCostUsd = 0;
    let totalInputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalOutputTokens = 0;

    for (const ev of events) {
      if (ev?.type !== 'PLANNER_RESPONSE') {
        continue;
      }
      const modelKey = ev.model ?? 'unknown';
      const inputTokens = toNonNegative(ev.input_tokens);
      const cacheReadTokens = toNonNegative(ev.cache_read_tokens);
      const outputTokens = toNonNegative(ev.output_tokens);
      const step = this.calculateStepCost({
        model: ev.model,
        inputTokens,
        cacheReadTokens,
        outputTokens,
      });

      totalCostUsd += step.costUsd;
      totalInputTokens += inputTokens;
      totalCacheReadTokens += cacheReadTokens;
      totalOutputTokens += outputTokens;

      if (!perModel[modelKey]) {
        perModel[modelKey] = {
          steps: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          maxInputTokens: step.maxInputTokens,
          rateFound: step.rateFound,
        };
      }
      const bucket = perModel[modelKey];
      bucket.steps += 1;
      bucket.inputTokens += inputTokens;
      bucket.cacheReadTokens += cacheReadTokens;
      bucket.outputTokens += outputTokens;
      bucket.costUsd += step.costUsd;
    }

    return {
      totalCostUsd,
      totalInputTokens,
      totalCacheReadTokens,
      totalOutputTokens,
      perModel,
    };
  }
}

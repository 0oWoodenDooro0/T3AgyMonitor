const DEFAULT_CONTEXT_WINDOW_TOKENS = 1_000_000;

function clampPercent(value) {
  if (!Number.isFinite(value)) {
    return 100;
  }
  return Math.max(0, Math.min(100, value));
}

function nonNegative(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

/**
 * Pluggable interface for provider-side remaining model quota (ADR-0003).
 */
export class QuotaProvider {
  isAvailable() {
    return false;
  }

  async getQuota() {
    return null;
  }
}

/**
 * Default inactive QuotaProvider used until native Antigravity quota data is exposed.
 */
export class NullQuotaProvider extends QuotaProvider {
  isAvailable() {
    return false;
  }

  async getQuota() {
    return null;
  }
}

/**
 * Compute Composer Ring remaining capacity percentage [0, 100] from either
 * active provider quota, local Soft Budget (USD/tokens), or Context Window %.
 */
export function computeComposerRingState({
  ringMode = 'context_window',
  contextTokens = 0,
  maxContextTokens = DEFAULT_CONTEXT_WINDOW_TOKENS,
  softBudgetUsd = 0,
  softBudgetTokens = 0,
  sessionCostUsd = 0,
  sessionTotalTokens = 0,
  quotaInfo = null,
} = {}) {
  if (quotaInfo && Number.isFinite(Number(quotaInfo.remainingPercent))) {
    const remainingPercent = clampPercent(Number(quotaInfo.remainingPercent));
    return {
      source: 'provider_quota',
      remainingPercent,
      usedPercent: 100 - remainingPercent,
      label: quotaInfo.label ?? 'Provider Quota',
    };
  }

  if (ringMode === 'soft_budget_usd' && nonNegative(softBudgetUsd) > 0) {
    const limit = nonNegative(softBudgetUsd);
    const used = nonNegative(sessionCostUsd);
    const remainingPercent = clampPercent(((limit - used) / limit) * 100);
    return {
      source: 'soft_budget_usd',
      remainingPercent,
      usedPercent: 100 - remainingPercent,
      used,
      limit,
      label: 'Soft Budget (USD)',
    };
  }

  if (ringMode === 'soft_budget_tokens' && nonNegative(softBudgetTokens) > 0) {
    const limit = nonNegative(softBudgetTokens);
    const used = nonNegative(sessionTotalTokens);
    const remainingPercent = clampPercent(((limit - used) / limit) * 100);
    return {
      source: 'soft_budget_tokens',
      remainingPercent,
      usedPercent: 100 - remainingPercent,
      used,
      limit,
      label: 'Soft Budget (Tokens)',
    };
  }

  const limit = nonNegative(maxContextTokens) > 0 ? nonNegative(maxContextTokens) : DEFAULT_CONTEXT_WINDOW_TOKENS;
  const used = nonNegative(contextTokens);
  const remainingPercent = clampPercent(((limit - used) / limit) * 100);
  return {
    source: 'context_window',
    remainingPercent,
    usedPercent: 100 - remainingPercent,
    used,
    limit,
    label: 'Context Window',
  };
}

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const MIN_CAPSULE_SLOTS = 1;
export const MAX_CAPSULE_SLOTS = 5;

export const DEFAULT_CONFIG = Object.freeze({
  cdpPort: 9222,
  capsuleSlots: Object.freeze(['model', 'context', 'cost', 'speed', 'cache']),
  ringMode: 'context_window',
  softBudgetUsd: 0,
  softBudgetTokens: 0,
  updateCheckMode: 'auto',
  overviewOpen: false,
});

const VALID_RING_MODES = new Set(['context_window', 'soft_budget_usd', 'soft_budget_tokens']);
const VALID_UPDATE_MODES = new Set(['auto', 'manual', 'off']);

/**
 * Resolve the XDG config file path for T3AgyMonitor.
 */
export function resolveDefaultConfigPath(env = process.env, homeDir = os.homedir()) {
  const xdgConfigHome = env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
  return path.join(xdgConfigHome, 't3-agy-monitor', 'config.json');
}

function clampNonNegativeNumber(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    return fallback;
  }
  return num;
}

function normalizeCapsuleSlots(slots) {
  if (!Array.isArray(slots)) {
    return [...DEFAULT_CONFIG.capsuleSlots];
  }
  const filtered = slots.filter((s) => typeof s === 'string' && s.trim().length > 0);
  if (filtered.length < MIN_CAPSULE_SLOTS) {
    return [DEFAULT_CONFIG.capsuleSlots[0]];
  }
  return filtered.slice(0, MAX_CAPSULE_SLOTS);
}

/**
 * Normalize and clamp a raw config object against defaults and domain invariants.
 */
export function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const cdpPort =
    Number.isInteger(source.cdpPort) && source.cdpPort > 0 && source.cdpPort <= 65535
      ? source.cdpPort
      : DEFAULT_CONFIG.cdpPort;

  return {
    cdpPort,
    capsuleSlots: normalizeCapsuleSlots(source.capsuleSlots),
    ringMode: VALID_RING_MODES.has(source.ringMode) ? source.ringMode : DEFAULT_CONFIG.ringMode,
    softBudgetUsd: clampNonNegativeNumber(source.softBudgetUsd, DEFAULT_CONFIG.softBudgetUsd),
    softBudgetTokens: clampNonNegativeNumber(source.softBudgetTokens, DEFAULT_CONFIG.softBudgetTokens),
    updateCheckMode: VALID_UPDATE_MODES.has(source.updateCheckMode)
      ? source.updateCheckMode
      : DEFAULT_CONFIG.updateCheckMode,
    overviewOpen: typeof source.overviewOpen === 'boolean' ? source.overviewOpen : DEFAULT_CONFIG.overviewOpen,
  };
}

/**
 * Persistent XDG JSON config store with fail-open defaults and value clamping.
 */
export class ConfigStore {
  #configPath;
  #logger;

  constructor({ configPath = resolveDefaultConfigPath(), logger = console } = {}) {
    this.#configPath = configPath;
    this.#logger = logger;
  }

  getConfigPath() {
    return this.#configPath;
  }

  async load() {
    try {
      const rawText = await fs.readFile(this.#configPath, 'utf8');
      const parsed = JSON.parse(rawText);
      return normalizeConfig(parsed);
    } catch (error) {
      this.#logger.warn({
        status: 'DEGRADED',
        component: 'ConfigStore',
        message: 'Failed to load config; falling back to defaults',
        configPath: this.#configPath,
        error: error.message,
      });
      return normalizeConfig(DEFAULT_CONFIG);
    }
  }

  async save(nextConfig) {
    const normalized = normalizeConfig(nextConfig);
    await fs.mkdir(path.dirname(this.#configPath), { recursive: true });
    await fs.writeFile(this.#configPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    return normalized;
  }
}

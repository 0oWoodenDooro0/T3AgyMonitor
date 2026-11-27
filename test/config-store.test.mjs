import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore, DEFAULT_CONFIG } from '../src/config/config-store.mjs';

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 't3-agy-config-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('ConfigStore returns defaults and logs DEGRADED warning when config file is missing', async () => {
  await withTempDir(async (dir) => {
    const warnings = [];
    const configPath = path.join(dir, 't3-agy-monitor', 'config.json');
    const store = new ConfigStore({
      configPath,
      logger: { warn: (entry) => warnings.push(entry) },
    });

    const cfg = await store.load();
    assert.deepEqual(cfg, DEFAULT_CONFIG);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].status, 'DEGRADED');
    assert.equal(warnings[0].component, 'ConfigStore');
  });
});

test('ConfigStore falls back to defaults and logs DEGRADED warning on corrupt JSON', async () => {
  await withTempDir(async (dir) => {
    const warnings = [];
    const configPath = path.join(dir, 'config.json');
    await fs.writeFile(configPath, '{ not valid json', 'utf8');

    const store = new ConfigStore({
      configPath,
      logger: { warn: (entry) => warnings.push(entry) },
    });

    const cfg = await store.load();
    assert.deepEqual(cfg, DEFAULT_CONFIG);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].status, 'DEGRADED');
  });
});

test('ConfigStore clamps capsuleSlots to [1, 5] and negative softBudget to 0 on save and load', async () => {
  await withTempDir(async (dir) => {
    const configPath = path.join(dir, 'nested', 'config.json');
    const store = new ConfigStore({ configPath, logger: { warn() {} } });

    const saved = await store.save({
      capsuleSlots: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      softBudgetUsd: -12.5,
      softBudgetTokens: -500,
    });
    assert.equal(saved.capsuleSlots.length, 5);
    assert.deepEqual(saved.capsuleSlots, ['a', 'b', 'c', 'd', 'e']);
    assert.equal(saved.softBudgetUsd, 0);
    assert.equal(saved.softBudgetTokens, 0);

    const reloaded = await store.load();
    assert.deepEqual(reloaded, saved);

    const emptySlotsSaved = await store.save({ capsuleSlots: [] });
    assert.equal(emptySlotsSaved.capsuleSlots.length >= 1, true);
    assert.equal(emptySlotsSaved.capsuleSlots.length <= 5, true);
  });
});

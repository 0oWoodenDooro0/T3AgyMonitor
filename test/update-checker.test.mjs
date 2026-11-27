import test from 'node:test';
import assert from 'node:assert/strict';

import { UpdateChecker, compareSemver, parseSemver } from '../src/updater/index.mjs';

test('UpdateChecker in off mode makes zero network requests on startup and manual check', async () => {
  let fetchCalls = 0;
  const checker = new UpdateChecker({
    currentVersion: '0.1.0',
    mode: 'off',
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('should not be called');
    },
  });

  const startupResult = await checker.checkOnStartup();
  const manualResult = await checker.checkNow();

  assert.equal(fetchCalls, 0);
  assert.equal(startupResult.hasUpdate, false);
  assert.equal(startupResult.currentVersion, '0.1.0');
  assert.equal(startupResult.latestVersion, null);
  assert.equal(startupResult.releaseUrl, null);
  assert.equal(startupResult.mode, 'off');
  assert.equal(startupResult.degraded, false);
  assert.equal(startupResult.checkedAt, null);
  assert.equal(typeof startupResult.updateCommand, 'string');
  assert.ok(startupResult.updateCommand.length > 0);
  assert.deepEqual(manualResult, startupResult);
});

test('UpdateChecker in auto mode checks once on startup and detects newer release with leading v', async () => {
  let fetchCalls = 0;
  let capturedUrl = null;
  let capturedOptions = null;

  const checker = new UpdateChecker({
    currentVersion: '0.1.0',
    mode: 'auto',
    repo: '0oWoodenDooro0/T3AgyMonitor',
    now: () => '2026-11-27T11:30:00.000Z',
    fetchImpl: async (url, options) => {
      fetchCalls += 1;
      capturedUrl = url;
      capturedOptions = options;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            tag_name: 'v0.2.0',
            html_url: 'https://github.com/0oWoodenDooro0/T3AgyMonitor/releases/tag/v0.2.0',
          };
        },
      };
    },
  });

  const first = await checker.checkOnStartup();
  const second = await checker.checkOnStartup();

  assert.equal(fetchCalls, 1);
  assert.equal(
    capturedUrl,
    'https://api.github.com/repos/0oWoodenDooro0/T3AgyMonitor/releases/latest',
  );
  assert.ok(capturedOptions?.headers?.Accept?.includes('application/vnd.github+json'));
  assert.deepEqual(first, {
    hasUpdate: true,
    currentVersion: '0.1.0',
    latestVersion: '0.2.0',
    releaseUrl: 'https://github.com/0oWoodenDooro0/T3AgyMonitor/releases/tag/v0.2.0',
    updateCommand: 'npm update -g t3-agy-monitor',
    checkedAt: '2026-11-27T11:30:00.000Z',
    mode: 'auto',
    degraded: false,
  });
  assert.deepEqual(second, first);
});

test('UpdateChecker in manual mode skips startup check and checks only on checkNow()', async () => {
  let fetchCalls = 0;
  const checker = new UpdateChecker({
    currentVersion: '0.1.0',
    mode: 'manual',
    now: () => '2026-11-27T11:31:00.000Z',
    fetchImpl: async () => {
      fetchCalls += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            tag_name: '1.0.0',
            html_url: 'https://github.com/0oWoodenDooro0/T3AgyMonitor/releases/tag/1.0.0',
          };
        },
      };
    },
  });

  const startup = await checker.checkOnStartup();
  assert.equal(fetchCalls, 0);
  assert.equal(startup.hasUpdate, false);
  assert.equal(startup.latestVersion, null);
  assert.equal(startup.mode, 'manual');
  assert.equal(startup.degraded, false);

  const manual = await checker.checkNow();
  assert.equal(fetchCalls, 1);
  assert.equal(manual.hasUpdate, true);
  assert.equal(manual.latestVersion, '1.0.0');
  assert.equal(manual.releaseUrl, 'https://github.com/0oWoodenDooro0/T3AgyMonitor/releases/tag/1.0.0');
  assert.equal(manual.checkedAt, '2026-11-27T11:31:00.000Z');
  assert.equal(manual.degraded, false);
});

test('UpdateChecker reports hasUpdate: false for equal and older versions', async () => {
  const tags = ['v0.2.0', '0.1.9', 'v0.2.0-rc.1'];
  let idx = 0;
  const checker = new UpdateChecker({
    currentVersion: '0.2.0',
    mode: 'manual',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        const tag = tags[idx++];
        return {
          tag_name: tag,
          html_url: `https://github.com/0oWoodenDooro0/T3AgyMonitor/releases/tag/${tag}`,
        };
      },
    }),
  });

  const equalRes = await checker.checkNow();
  assert.equal(equalRes.hasUpdate, false);
  assert.equal(equalRes.latestVersion, '0.2.0');
  assert.equal(equalRes.degraded, false);

  const olderRes = await checker.checkNow();
  assert.equal(olderRes.hasUpdate, false);
  assert.equal(olderRes.latestVersion, '0.1.9');
  assert.equal(olderRes.degraded, false);

  const prereleaseRes = await checker.checkNow();
  assert.equal(prereleaseRes.hasUpdate, false);
  assert.equal(prereleaseRes.latestVersion, '0.2.0-rc.1');
  assert.equal(prereleaseRes.degraded, false);
});

test('parseSemver and compareSemver reject malformed tags and order valid tags strictly', () => {
  for (const invalid of ['', 'nightly', 'v1.2', '1.2.3.4', 'v01.2.3', 'v1.2.3-01', null, undefined]) {
    assert.equal(parseSemver(invalid), null, `expected ${String(invalid)} to be rejected`);
  }

  assert.equal(compareSemver('v1.2.3+build.1', '1.2.3+build.2'), 0);
  assert.equal(compareSemver('1.2.3-alpha.1', '1.2.3-alpha.beta'), -1);
  assert.equal(compareSemver('1.2.3-1', '1.2.3-alpha'), -1);
  assert.equal(compareSemver('1.2.3-alpha', '1.2.3'), -1);
  assert.equal(compareSemver('1.2.10', '1.2.2'), 1);
  assert.throws(() => compareSemver('bad', '1.0.0'));
});

test('UpdateChecker rejects malformed release tags cleanly and logs DEGRADED warning', async () => {
  for (const badTag of ['nightly', 'v1.2', 'v01.0.0', '', undefined]) {
    const warnings = [];
    const checker = new UpdateChecker({
      currentVersion: '0.1.0',
      mode: 'manual',
      logger: { warn: (entry) => warnings.push(entry) },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() {
          return {
            tag_name: badTag,
            html_url: 'https://github.com/0oWoodenDooro0/T3AgyMonitor/releases/tag/bad',
          };
        },
      }),
    });

    const result = await checker.checkNow();
    assert.equal(result.hasUpdate, false);
    assert.equal(result.latestVersion, null);
    assert.equal(result.releaseUrl, null);
    assert.equal(result.degraded, true);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].status, 'DEGRADED');
    assert.equal(warnings[0].component, 'UpdateChecker');
  }
});

test('UpdateChecker fails open with DEGRADED log on HTTP errors and rate limits (403/429)', async () => {
  for (const status of [403, 429, 500]) {
    const warnings = [];
    const checker = new UpdateChecker({
      currentVersion: '0.1.0',
      mode: 'manual',
      logger: { warn: (entry) => warnings.push(entry) },
      fetchImpl: async () => ({
        ok: false,
        status,
        async json() {
          return {};
        },
      }),
    });

    const result = await checker.checkNow();
    assert.equal(result.hasUpdate, false);
    assert.equal(result.latestVersion, null);
    assert.equal(result.degraded, true);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].status, 'DEGRADED');
    assert.equal(warnings[0].httpStatus, status);
  }
});

test('UpdateChecker fails open with DEGRADED log on network error, timeout, and malformed JSON', async () => {
  // Network rejection
  {
    const warnings = [];
    const checker = new UpdateChecker({
      currentVersion: '0.1.0',
      mode: 'manual',
      logger: { warn: (entry) => warnings.push(entry) },
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });

    const result = await checker.checkNow();
    assert.equal(result.hasUpdate, false);
    assert.equal(result.degraded, true);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].status, 'DEGRADED');
    assert.match(warnings[0].error, /ECONNREFUSED/);
  }

  // Timeout via AbortSignal
  {
    const warnings = [];
    const checker = new UpdateChecker({
      currentVersion: '0.1.0',
      mode: 'manual',
      timeoutMs: 15,
      logger: { warn: (entry) => warnings.push(entry) },
      fetchImpl: (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')));
        }),
    });

    const result = await checker.checkNow();
    assert.equal(result.hasUpdate, false);
    assert.equal(result.degraded, true);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].status, 'DEGRADED');
  }

  // Malformed JSON
  {
    const warnings = [];
    const checker = new UpdateChecker({
      currentVersion: '0.1.0',
      mode: 'manual',
      logger: { warn: (entry) => warnings.push(entry) },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() {
          throw new SyntaxError('Unexpected token');
        },
      }),
    });

    const result = await checker.checkNow();
    assert.equal(result.hasUpdate, false);
    assert.equal(result.degraded, true);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].status, 'DEGRADED');
  }
});



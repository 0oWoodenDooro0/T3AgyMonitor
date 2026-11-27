export const DEFAULT_REPO = '0oWoodenDooro0/T3AgyMonitor';
export const DEFAULT_UPDATE_COMMAND = 'npm update -g t3-agy-monitor';
export const DEFAULT_TIMEOUT_MS = 5000;

const VALID_MODES = new Set(['auto', 'manual', 'off']);
const SEMVER_RE =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/**
 * Parse a strict SemVer 2.0.0 string with optional leading `v`.
 * Returns null for malformed tags or invalid prerelease numeric identifiers.
 */
export function parseSemver(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  const match = SEMVER_RE.exec(raw.trim());
  if (!match) {
    return null;
  }
  const [, majorStr, minorStr, patchStr, prereleaseRaw] = match;
  const prerelease = prereleaseRaw ? prereleaseRaw.split('.') : [];
  for (const id of prerelease) {
    if (/^\d+$/.test(id) && id.length > 1 && id.startsWith('0')) {
      return null;
    }
  }
  const normalized = `${majorStr}.${minorStr}.${patchStr}${prereleaseRaw ? `-${prereleaseRaw}` : ''}`;
  return {
    major: Number(majorStr),
    minor: Number(minorStr),
    patch: Number(patchStr),
    prerelease,
    version: normalized,
  };
}

function comparePrerelease(aPre, bPre) {
  if (aPre.length === 0 && bPre.length === 0) return 0;
  if (aPre.length === 0) return 1;
  if (bPre.length === 0) return -1;

  const len = Math.max(aPre.length, bPre.length);
  for (let i = 0; i < len; i += 1) {
    if (i >= aPre.length) return -1;
    if (i >= bPre.length) return 1;

    const aId = aPre[i];
    const bId = bPre[i];
    if (aId === bId) continue;

    const aNum = /^\d+$/.test(aId);
    const bNum = /^\d+$/.test(bId);
    if (aNum && bNum) {
      return Number(aId) < Number(bId) ? -1 : 1;
    }
    if (aNum) return -1;
    if (bNum) return 1;
    return aId < bId ? -1 : 1;
  }
  return 0;
}

/**
 * Compare two parsed or string semver versions. Returns -1, 0, or 1.
 * Throws if either version is malformed.
 */
export function compareSemver(a, b) {
  const parsedA = typeof a === 'string' ? parseSemver(a) : a;
  const parsedB = typeof b === 'string' ? parseSemver(b) : b;
  if (!parsedA || !parsedB) {
    throw new Error('Cannot compare malformed semver');
  }
  for (const key of ['major', 'minor', 'patch']) {
    if (parsedA[key] !== parsedB[key]) {
      return parsedA[key] < parsedB[key] ? -1 : 1;
    }
  }
  return comparePrerelease(parsedA.prerelease, parsedB.prerelease);
}

/**
 * Notification-only GitHub Releases update checker.
 */
export class UpdateChecker {
  #currentVersion;
  #mode;
  #repo;
  #apiUrl;
  #updateCommand;
  #timeoutMs;
  #fetchImpl;
  #logger;
  #now;
  #startupResult = null;
  #startupPromise = null;

  constructor({
    currentVersion = '0.1.0',
    mode = 'auto',
    repo = DEFAULT_REPO,
    apiUrl,
    updateCommand = DEFAULT_UPDATE_COMMAND,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    logger = console,
    now = () => new Date().toISOString(),
  } = {}) {
    this.#currentVersion = currentVersion;
    this.#mode = VALID_MODES.has(mode) ? mode : 'auto';
    this.#repo = repo;
    this.#apiUrl = apiUrl ?? `https://api.github.com/repos/${this.#repo}/releases/latest`;
    this.#updateCommand = updateCommand;
    this.#timeoutMs = timeoutMs;
    this.#fetchImpl = fetchImpl;
    this.#logger = logger;
    this.#now = now;
  }

  #buildPayload({
    hasUpdate = false,
    latestVersion = null,
    releaseUrl = null,
    checkedAt = null,
    degraded = false,
  } = {}) {
    return {
      hasUpdate,
      currentVersion: this.#currentVersion,
      latestVersion,
      releaseUrl,
      updateCommand: this.#updateCommand,
      checkedAt,
      mode: this.#mode,
      degraded,
    };
  }

  #failOpen(reason, details = {}) {
    this.#logger.warn({
      status: 'DEGRADED',
      component: 'UpdateChecker',
      message: reason,
      ...details,
    });
    return this.#buildPayload({
      checkedAt: this.#now(),
      degraded: true,
    });
  }

  async checkOnStartup() {
    if (this.#mode !== 'auto') {
      return this.#buildPayload();
    }
    if (this.#startupResult) {
      return this.#startupResult;
    }
    if (!this.#startupPromise) {
      this.#startupPromise = this.checkNow().then((result) => {
        this.#startupResult = result;
        return result;
      });
    }
    return this.#startupPromise;
  }

  async checkNow() {
    if (this.#mode === 'off') {
      return this.#buildPayload();
    }

    const currentParsed = parseSemver(this.#currentVersion);
    if (!currentParsed) {
      return this.#failOpen('Malformed currentVersion', {
        currentVersion: this.#currentVersion,
      });
    }

    if (typeof this.#fetchImpl !== 'function') {
      return this.#failOpen('No fetch implementation available');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Request timed out')), this.#timeoutMs);

    let response;
    try {
      response = await this.#fetchImpl(this.#apiUrl, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'T3AgyMonitor',
        },
        signal: controller.signal,
      });
    } catch (error) {
      return this.#failOpen('Update check network request failed', {
        error: error?.message ?? String(error),
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response || !response.ok) {
      const status = response?.status ?? null;
      return this.#failOpen(
        status === 403 || status === 429
          ? 'GitHub Releases API rate limited'
          : 'GitHub Releases API returned HTTP error',
        { httpStatus: status },
      );
    }

    let release;
    try {
      release = await response.json();
    } catch (error) {
      return this.#failOpen('Malformed JSON from GitHub Releases API', {
        error: error?.message ?? String(error),
      });
    }

    const latestParsed = parseSemver(release?.tag_name);
    if (!latestParsed) {
      return this.#failOpen('Malformed release tag_name from GitHub Releases API', {
        tagName: release?.tag_name ?? null,
      });
    }

    const hasUpdate = compareSemver(latestParsed, currentParsed) > 0;
    const releaseUrl = typeof release?.html_url === 'string' && release.html_url.length > 0
      ? release.html_url
      : null;

    return this.#buildPayload({
      hasUpdate,
      latestVersion: latestParsed.version,
      releaseUrl,
      checkedAt: this.#now(),
      degraded: false,
    });
  }
}

function formatTtft(ttftMs) {
  if (typeof ttftMs !== 'number' || !Number.isFinite(ttftMs) || ttftMs < 0) {
    return '—';
  }
  return `${(ttftMs / 1000).toFixed(2)}s`;
}

function formatTokPerSec(tokPerSec) {
  if (typeof tokPerSec !== 'number' || !Number.isFinite(tokPerSec) || tokPerSec <= 0) {
    return '—';
  }
  return `${tokPerSec.toFixed(1)} tok/s`;
}

function estimateTokensFromText(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * In-page streaming observer measuring real-time TTFT and live tok/s during
 * active generation, reconciling with authoritative PLANNER_RESPONSE counts
 * from the Sidecar, and falling back to transcript averages on history/mid-turn
 * attach (ADR-0005).
 */
export class StreamObserver {
  #turnId = null;
  #turnStartMs = null;
  #firstTokenMs = null;
  #lastChunkMs = null;
  #outputTokens = 0;
  #isStreaming = false;
  #source = 'idle';
  #tokPerSec = null;

  startTurn({ turnId = null, nowMs = Date.now() } = {}) {
    this.#turnId = turnId;
    this.#turnStartMs = Number.isFinite(nowMs) ? nowMs : Date.now();
    this.#firstTokenMs = null;
    this.#lastChunkMs = null;
    this.#outputTokens = 0;
    this.#isStreaming = true;
    this.#source = 'live';
    this.#tokPerSec = null;
  }

  onChunk({ text = '', tokens = null, nowMs = Date.now() } = {}) {
    const ts = Number.isFinite(nowMs) ? nowMs : Date.now();
    if (!this.#isStreaming) {
      this.startTurn({ turnId: this.#turnId, nowMs: ts });
    }

    const deltaTokens =
      typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0
        ? tokens
        : estimateTokensFromText(text);

    if (this.#firstTokenMs === null) {
      this.#firstTokenMs = ts;
    }
    this.#lastChunkMs = ts;
    this.#outputTokens += deltaTokens;
    this.#source = 'live';

    const elapsedSec = (this.#lastChunkMs - this.#firstTokenMs) / 1000;
    this.#tokPerSec = elapsedSec > 0 ? this.#outputTokens / elapsedSec : null;
  }

  reconcile({ turnId = null, outputTokens = null, durationMs = null, tokPerSec = null } = {}) {
    if (turnId !== null && this.#turnId !== null && turnId !== this.#turnId) {
      return;
    }

    if (typeof outputTokens === 'number' && Number.isFinite(outputTokens) && outputTokens >= 0) {
      this.#outputTokens = outputTokens;
    }

    if (typeof tokPerSec === 'number' && Number.isFinite(tokPerSec) && tokPerSec > 0) {
      this.#tokPerSec = tokPerSec;
    } else if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0) {
      this.#tokPerSec = this.#outputTokens / (durationMs / 1000);
    }

    this.#isStreaming = false;
    if (this.#source === 'idle') {
      this.#source = 'transcript';
    }
  }

  applyTranscriptFallback({ turnId = null, outputTokens = 0, tokPerSec = null } = {}) {
    this.#turnId = turnId;
    this.#turnStartMs = null;
    this.#firstTokenMs = null;
    this.#lastChunkMs = null;
    this.#isStreaming = false;
    this.#source = 'transcript';
    this.#outputTokens =
      typeof outputTokens === 'number' && Number.isFinite(outputTokens) && outputTokens >= 0
        ? outputTokens
        : 0;
    this.#tokPerSec =
      typeof tokPerSec === 'number' && Number.isFinite(tokPerSec) && tokPerSec > 0
        ? tokPerSec
        : null;
  }

  getMetrics() {
    const ttftMs =
      this.#source === 'live' && this.#turnStartMs !== null && this.#firstTokenMs !== null
        ? Math.max(0, this.#firstTokenMs - this.#turnStartMs)
        : null;

    return {
      turnId: this.#turnId,
      source: this.#source,
      isStreaming: this.#isStreaming,
      ttftMs,
      ttftDisplay: formatTtft(ttftMs),
      tokPerSec: this.#tokPerSec,
      tokPerSecDisplay: formatTokPerSec(this.#tokPerSec),
      outputTokens: this.#outputTokens,
    };
  }
}

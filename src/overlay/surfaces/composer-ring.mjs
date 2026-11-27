export function clampPercent(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return 0;
  }
  return Math.min(100, Math.max(0, num));
}

const MODE_LABELS = Object.freeze({
  context_window: 'Context Window',
  soft_budget_usd: 'Soft Budget (USD)',
  soft_budget_tokens: 'Soft Budget (Tokens)',
  quota: 'Model Quota',
});

/**
 * Shadow DOM Composer Ring framing the Host App's composer input, displaying
 * Context Window %, local Soft Budget, or active QuotaProvider clamped to [0, 100%].
 */
export class ComposerRingSurface {
  #document;
  #shadowRoot = null;
  #ringEl = null;
  #fillEl = null;
  #labelEl = null;

  constructor({ document = globalThis.document } = {}) {
    this.#document = document;
  }

  mount(shadowRoot) {
    this.#shadowRoot = shadowRoot;
    shadowRoot.innerHTML = '';

    const style = this.#document.createElement('style');
    style.textContent = `
      :host { display: block; pointer-events: none; color: var(--foreground); font-family: var(--font-sans, system-ui, sans-serif); }
      .ring-frame { position: relative; display: flex; flex-direction: column; gap: 3px; padding: 0; background: transparent; border: none; }
      .ring-track { height: 3px; width: 100%; border-radius: 999px; overflow: hidden; background: var(--muted); }
      .ring-fill { height: 100%; border-radius: 999px; background: var(--primary); transition: width 150ms ease; }
      .ring-label { font-family: var(--font-sans, system-ui, sans-serif); font-size: 10px; line-height: 1.2; text-align: right; font-variant-numeric: tabular-nums; color: var(--muted-foreground); }
    `;

    const ringEl = this.#document.createElement('div');
    ringEl.setAttribute('data-role', 'composer-ring-root');
    ringEl.className = 'ring-frame';

    const trackEl = this.#document.createElement('div');
    trackEl.setAttribute('data-role', 'ring-track');
    trackEl.className = 'ring-track';

    const fillEl = this.#document.createElement('div');
    fillEl.setAttribute('data-role', 'ring-fill');
    fillEl.setAttribute('role', 'progressbar');
    fillEl.setAttribute('aria-valuemin', '0');
    fillEl.setAttribute('aria-valuemax', '100');
    fillEl.setAttribute('aria-valuenow', '0');
    fillEl.setAttribute('data-percent', '0');
    fillEl.className = 'ring-fill';

    const labelEl = this.#document.createElement('span');
    labelEl.setAttribute('data-role', 'ring-label');
    labelEl.className = 'ring-label';

    trackEl.appendChild(fillEl);
    ringEl.appendChild(trackEl);
    ringEl.appendChild(labelEl);
    shadowRoot.appendChild(style);
    shadowRoot.appendChild(ringEl);

    this.#ringEl = ringEl;
    this.#fillEl = fillEl;
    this.#labelEl = labelEl;
  }

  update(snapshot = {}) {
    if (!this.#shadowRoot || !this.#fillEl || !this.#labelEl) {
      return;
    }

    const ringState = snapshot?.composerRing ?? {};
    const mode = ringState.mode ?? ringState.source ?? snapshot?.config?.ringMode ?? 'context_window';
    const rawPercent =
      ringState.percent ??
      ringState.remainingPercent ??
      snapshot?.metrics?.contextPercent ??
      0;
    const percent = clampPercent(rawPercent);
    const rounded = Math.round(percent);
    const modeLabel = ringState.label ?? MODE_LABELS[mode] ?? 'Context Window';
    const formatPct = (n) => (Number.isInteger(n) ? `${n}%` : `${n.toFixed(1)}%`);

    this.#ringEl.setAttribute('data-mode', mode);
    this.#fillEl.setAttribute('aria-valuenow', String(rounded));
    this.#fillEl.setAttribute('data-percent', String(rounded));
    this.#fillEl.style.width = `${rounded}%`;
    if (mode === 'context_window') {
      const usedPct = clampPercent(
        Number.isFinite(Number(ringState.usedPercent)) ? Number(ringState.usedPercent) : 100 - percent,
      );
      this.#labelEl.textContent = `Context ${formatPct(usedPct)} used · ${formatPct(percent)} left`;
    } else {
      this.#labelEl.textContent = `${modeLabel}: ${formatPct(rounded)}`;
    }
  }

  unmount() {
    if (this.#shadowRoot) {
      this.#shadowRoot.innerHTML = '';
    }
    this.#shadowRoot = null;
  }
}

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
      :host { display: block; pointer-events: none; }
      .ring-frame { position: relative; border-radius: 12px; padding: 2px; }
      .ring-track { height: 3px; width: 100%; border-radius: 999px; overflow: hidden; }
      .ring-fill { height: 100%; transition: width 150ms ease; }
      .ring-label { font-family: system-ui, sans-serif; font-size: 11px; margin-top: 2px; }
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

    this.#ringEl.setAttribute('data-mode', mode);
    this.#fillEl.setAttribute('aria-valuenow', String(rounded));
    this.#fillEl.setAttribute('data-percent', String(rounded));
    this.#fillEl.style.width = `${rounded}%`;
    this.#labelEl.textContent = `${modeLabel}: ${rounded}%`;
  }

  unmount() {
    if (this.#shadowRoot) {
      this.#shadowRoot.innerHTML = '';
    }
    this.#shadowRoot = null;
  }
}

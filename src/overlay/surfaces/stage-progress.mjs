/**
 * Shadow DOM Stage Progress bar showing consecutive tool-call progress during
 * active turns and auto-collapsing into the turn duration bar on completion.
 */
export class StageProgressSurface {
  #document;
  #shadowRoot = null;
  #barEl = null;
  #labelEl = null;
  #countEl = null;

  constructor({ document = globalThis.document } = {}) {
    this.#document = document;
  }

  mount(shadowRoot) {
    this.#shadowRoot = shadowRoot;
    shadowRoot.innerHTML = '';

    const style = this.#document.createElement('style');
    style.textContent = `
      :host { display: block; font-family: var(--font-sans, system-ui, sans-serif); font-size: 12px; color: var(--foreground); }
      .stage-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 8px; border-radius: calc(var(--radius, 8px) - 2px); background: color-mix(in oklch, var(--secondary) 55%, transparent); border: 1px solid color-mix(in oklch, var(--border) 45%, transparent); color: var(--foreground); }
      .stage-bar[data-collapsed="true"] { display: none; }
    `;

    const barEl = this.#document.createElement('div');
    barEl.setAttribute('data-role', 'stage-bar');
    barEl.setAttribute('data-collapsed', 'false');
    barEl.setAttribute('data-mode', 'thinking');
    barEl.className = 'stage-bar';

    const labelEl = this.#document.createElement('span');
    labelEl.setAttribute('data-role', 'stage-label');

    const countEl = this.#document.createElement('span');
    countEl.setAttribute('data-role', 'stage-count');

    barEl.appendChild(labelEl);
    barEl.appendChild(countEl);
    shadowRoot.appendChild(style);
    shadowRoot.appendChild(barEl);

    this.#barEl = barEl;
    this.#labelEl = labelEl;
    this.#countEl = countEl;
  }

  update(snapshot = {}) {
    if (!this.#shadowRoot || !this.#barEl || !this.#labelEl) {
      return;
    }

    const stage = snapshot?.stageProgress ?? {};
    const mode = stage.mode ?? (stage.collapsed ? 'collapsed' : 'thinking');
    const collapsed = Boolean(stage.collapsed || mode === 'collapsed');
    const toolCount = Number.isFinite(Number(stage.toolCount)) ? Number(stage.toolCount) : 0;

    this.#barEl.setAttribute('data-mode', mode);
    this.#barEl.setAttribute('data-collapsed', collapsed ? 'true' : 'false');
    this.#labelEl.textContent = stage.stageLabel ?? (collapsed ? 'Completed' : 'Thinking…');
    this.#countEl.textContent = toolCount > 0 ? `${toolCount}` : '';
  }

  unmount() {
    if (this.#shadowRoot) {
      this.#shadowRoot.innerHTML = '';
    }
    this.#shadowRoot = null;
  }
}

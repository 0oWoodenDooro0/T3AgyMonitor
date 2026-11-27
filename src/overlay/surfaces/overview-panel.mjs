function formatDurationMs(ms) {
  const safe = Number.isFinite(Number(ms)) && Number(ms) > 0 ? Number(ms) : 0;
  return `${(safe / 1000).toFixed(2)}s`;
}

/**
 * Shadow DOM collapsible right-side Overview Panel persisting collapsed state
 * via CDP binding (`updateConfig`), showing current execution stage, per-step
 * duration, and per-model local cumulative usage or active QuotaProvider quota (ADR-0003).
 */
export class OverviewPanelSurface {
  #document;
  #dispatchAction;
  #shadowRoot = null;
  #panelEl = null;
  #toggleEl = null;
  #bodyEl = null;
  #stageEl = null;
  #stepsEl = null;
  #usageEl = null;
  #collapsed = true;
  #lastSnapshot = {};

  constructor({ document = globalThis.document, dispatchAction = () => {} } = {}) {
    this.#document = document;
    this.#dispatchAction = dispatchAction;
  }

  mount(shadowRoot) {
    this.#shadowRoot = shadowRoot;
    shadowRoot.innerHTML = '';

    const style = this.#document.createElement('style');
    style.textContent = `
      :host { display: block; position: fixed; top: 84px; right: 16px; z-index: 40; max-width: 320px; font-family: system-ui, sans-serif; font-size: 12px; color: var(--foreground, #e4e4e7); }
      .overview-panel { display: flex; flex-direction: column; gap: 8px; padding: 8px 10px; border-radius: 8px; background: var(--popover, rgba(24, 24, 27, 0.94)); color: var(--foreground, #e4e4e7); border: 1px solid var(--border, rgba(255, 255, 255, 0.12)); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35); backdrop-filter: blur(8px); }
      .overview-panel[data-collapsed="true"] .overview-body { display: none; }
      .overview-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .overview-row { display: flex; justify-content: space-between; gap: 8px; padding: 2px 0; }
      button { background: var(--secondary, rgba(255, 255, 255, 0.08)); color: var(--foreground, #e4e4e7); border: 1px solid var(--border, rgba(255, 255, 255, 0.14)); border-radius: 6px; padding: 2px 8px; font-size: 11px; cursor: pointer; }
    `;

    const panelEl = this.#document.createElement('aside');
    panelEl.setAttribute('data-role', 'overview-panel');
    panelEl.setAttribute('data-collapsed', this.#collapsed ? 'true' : 'false');
    panelEl.className = 'overview-panel';

    const header = this.#document.createElement('div');
    header.className = 'overview-header';

    const title = this.#document.createElement('span');
    title.setAttribute('data-role', 'overview-title');
    title.textContent = 'Overview';

    const toggleEl = this.#document.createElement('button');
    toggleEl.setAttribute('data-role', 'overview-toggle');
    toggleEl.textContent = this.#collapsed ? 'Expand' : 'Collapse';
    toggleEl.addEventListener('click', () => {
      this.#collapsed = !this.#collapsed;
      this.#syncCollapsed();
      this.#dispatchAction('updateConfig', { overviewOpen: !this.#collapsed });
    });

    const bodyEl = this.#document.createElement('div');
    bodyEl.setAttribute('data-role', 'overview-body');
    bodyEl.className = 'overview-body';

    const stageEl = this.#document.createElement('div');
    stageEl.setAttribute('data-role', 'overview-stage');

    const stepsEl = this.#document.createElement('div');
    stepsEl.setAttribute('data-role', 'overview-steps');

    const usageEl = this.#document.createElement('div');
    usageEl.setAttribute('data-role', 'overview-usage');

    header.appendChild(title);
    header.appendChild(toggleEl);
    bodyEl.appendChild(stageEl);
    bodyEl.appendChild(stepsEl);
    bodyEl.appendChild(usageEl);
    panelEl.appendChild(header);
    panelEl.appendChild(bodyEl);

    shadowRoot.appendChild(style);
    shadowRoot.appendChild(panelEl);

    this.#panelEl = panelEl;
    this.#toggleEl = toggleEl;
    this.#bodyEl = bodyEl;
    this.#stageEl = stageEl;
    this.#stepsEl = stepsEl;
    this.#usageEl = usageEl;
    this.#syncCollapsed();
  }

  update(snapshot = {}) {
    this.#lastSnapshot = snapshot ?? {};
    if (typeof snapshot?.config?.overviewOpen === 'boolean') {
      this.#collapsed = !snapshot.config.overviewOpen;
    }
    if (!this.#shadowRoot) {
      return;
    }

    this.#syncCollapsed();

    const stage = snapshot?.stageProgress ?? {};
    this.#stageEl.textContent = stage.stageLabel ?? 'Idle';

    const overview = snapshot?.overview ?? {};
    const stepDurations = Array.isArray(overview.stepDurations) ? overview.stepDurations : [];
    this.#stepsEl.innerHTML = '';
    for (const step of stepDurations) {
      const row = this.#document.createElement('div');
      row.className = 'overview-row';
      row.setAttribute('data-role', 'step-duration-row');
      row.textContent = `${step.label ?? 'Step'}: ${formatDurationMs(step.durationMs)}`;
      this.#stepsEl.appendChild(row);
    }

    this.#usageEl.innerHTML = '';
    const quota = snapshot?.quota;
    if (quota?.available && quota?.models && typeof quota.models === 'object') {
      for (const [model, info] of Object.entries(quota.models)) {
        const row = this.#document.createElement('div');
        row.className = 'overview-row';
        row.setAttribute('data-role', 'model-quota-row');
        row.setAttribute('data-model', model);
        const pct = Number.isFinite(Number(info?.remainingPercent))
          ? `${Math.round(Number(info.remainingPercent))}%`
          : '—';
        row.textContent = `${model}: ${info?.label ?? `${pct} remaining`}`;
        this.#usageEl.appendChild(row);
      }
      return;
    }

    const perModel = overview.perModel ?? {};
    for (const [model, bucket] of Object.entries(perModel)) {
      const row = this.#document.createElement('div');
      row.className = 'overview-row';
      row.setAttribute('data-role', 'model-usage-row');
      row.setAttribute('data-model', model);
      const cost = typeof bucket?.costUsd === 'number' ? `$${bucket.costUsd.toFixed(4)}` : '$0.0000';
      const steps = bucket?.steps ?? 0;
      const inTok = bucket?.inputTokens ?? 0;
      const outTok = bucket?.outputTokens ?? 0;
      row.textContent = `${model}: ${steps} steps, ${inTok} in / ${outTok} out (${cost})`;
      this.#usageEl.appendChild(row);
    }
  }

  #syncCollapsed() {
    if (!this.#panelEl || !this.#toggleEl || !this.#bodyEl) {
      return;
    }
    this.#panelEl.setAttribute('data-collapsed', this.#collapsed ? 'true' : 'false');
    this.#bodyEl.setAttribute('aria-hidden', this.#collapsed ? 'true' : 'false');
    this.#toggleEl.textContent = this.#collapsed ? 'Expand' : 'Collapse';
  }

  unmount() {
    if (this.#shadowRoot) {
      this.#shadowRoot.innerHTML = '';
    }
    this.#shadowRoot = null;
  }
}

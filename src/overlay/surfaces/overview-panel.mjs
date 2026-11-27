const STEP_TYPE_LABELS = Object.freeze({
  PLANNER_RESPONSE: 'Planner',
  GENERIC: 'Tool',
  USER_INPUT: 'User',
  SYSTEM_MESSAGE: 'System',
});

function formatDurationMs(ms) {
  const safe = Number.isFinite(Number(ms)) && Number(ms) > 0 ? Number(ms) : 0;
  return `${(safe / 1000).toFixed(2)}s`;
}

function formatCompactTokens(tokens) {
  const num = Number.isFinite(Number(tokens)) && Number(tokens) > 0 ? Math.floor(Number(tokens)) : 0;
  if (num >= 1000) {
    return `${(num / 1000).toFixed(1)}k`;
  }
  return String(num);
}

function formatStepLabel(rawLabel) {
  let label = String(rawLabel ?? 'Step');
  for (const [rawType, humanLabel] of Object.entries(STEP_TYPE_LABELS)) {
    label = label.replace(new RegExp(`\\b${rawType}\\b`, 'g'), humanLabel);
  }
  return label;
}

function createSectionHeader(document, text) {
  const el = document.createElement('div');
  el.className = 'overview-section-label';
  el.textContent = text;
  return el;
}

/**
 * Shadow DOM collapsible right-side Overview Panel persisting collapsed state
 * via CDP binding (`updateConfig`), showing current execution stage, per-model
 * local cumulative usage or active QuotaProvider quota (ADR-0003), and recent steps.
 */
export class OverviewPanelSurface {
  #document;
  #dispatchAction;
  #shadowRoot = null;
  #panelEl = null;
  #toggleEl = null;
  #chevronEl = null;
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
      :host { display: inline-flex; align-items: center; position: relative; margin-right: 185px !important; margin-left: 6px !important; z-index: 50; -webkit-app-region: no-drag !important; app-region: no-drag !important; font-family: system-ui, sans-serif; font-size: 12px; color: var(--foreground, #e4e4e7); flex-shrink: 0; }
      .overview-panel { display: inline-flex; align-items: center; position: relative; }
      .overview-toggle { box-sizing: border-box; display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 10px; border-radius: 999px; -webkit-app-region: no-drag; app-region: no-drag; background: rgba(255, 255, 255, 0.04); color: var(--foreground, #e4e4e7); border: 1px solid rgba(255, 255, 255, 0.09); font-size: 11px; font-variant-numeric: tabular-nums; cursor: pointer; white-space: nowrap; transition: background 120ms ease, border-color 120ms ease; }
      .overview-toggle:hover { background: rgba(255, 255, 255, 0.08); border-color: rgba(255, 255, 255, 0.16); }
      .overview-chevron { opacity: 0.7; font-size: 10px; line-height: 1; }
      .overview-panel[data-collapsed="true"] .overview-body { display: none; }
      .overview-body { position: fixed; top: 48px; right: 16px; width: 328px; max-height: calc(100vh - 72px); overflow-y: auto; z-index: 80; pointer-events: auto; display: flex; flex-direction: column; gap: 10px; padding: 12px; border-radius: 10px; background: var(--popover, rgba(20, 20, 23, 0.96)); color: var(--foreground, #e4e4e7); border: 1px solid rgba(255, 255, 255, 0.1); box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45); backdrop-filter: blur(10px); font-variant-numeric: tabular-nums; }
      .overview-section { display: flex; flex-direction: column; gap: 6px; padding-bottom: 10px; border-bottom: 1px solid rgba(255, 255, 255, 0.07); }
      .overview-section:last-child { padding-bottom: 0; border-bottom: none; }
      .overview-section-label { font-size: 10px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted-foreground, rgba(228, 228, 231, 0.52)); }
      .stage-pill { display: inline-flex; align-items: center; align-self: flex-start; padding: 3px 9px; border-radius: 999px; font-size: 11px; font-weight: 500; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.09); color: var(--foreground, #e4e4e7); }
      .overview-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 3px 0; font-size: 11px; }
      .model-meta { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
      .model-name { font-weight: 500; color: var(--foreground, #e4e4e7); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .model-tokens { font-size: 10px; color: var(--muted-foreground, rgba(228, 228, 231, 0.58)); }
      .model-cost { font-weight: 500; color: var(--foreground, #e4e4e7); white-space: nowrap; }
      .step-row { display: grid; grid-template-columns: minmax(0, 1fr) 52px auto; align-items: center; gap: 8px; padding: 2px 0; font-size: 11px; }
      .step-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: rgba(228, 228, 231, 0.85); }
      .step-bar-track { height: 4px; border-radius: 999px; background: rgba(255, 255, 255, 0.07); overflow: hidden; }
      .step-bar-fill { height: 100%; border-radius: 999px; background: var(--primary, rgba(96, 165, 250, 0.75)); }
      .step-duration { color: var(--muted-foreground, rgba(228, 228, 231, 0.6)); white-space: nowrap; text-align: right; }
      .empty-muted { font-size: 11px; color: var(--muted-foreground, rgba(228, 228, 231, 0.5)); }
    `;

    const panelEl = this.#document.createElement('aside');
    panelEl.setAttribute('data-role', 'overview-panel');
    panelEl.setAttribute('data-collapsed', this.#collapsed ? 'true' : 'false');
    panelEl.className = 'overview-panel';

    const toggleEl = this.#document.createElement('button');
    toggleEl.setAttribute('data-role', 'overview-toggle');
    toggleEl.className = 'overview-toggle';

    const title = this.#document.createElement('span');
    title.setAttribute('data-role', 'overview-title');
    title.textContent = 'Overview';

    const chevronEl = this.#document.createElement('span');
    chevronEl.className = 'overview-chevron';
    chevronEl.textContent = this.#collapsed ? '▾' : '▴';

    toggleEl.appendChild(title);
    toggleEl.appendChild(chevronEl);
    toggleEl.addEventListener('click', () => {
      this.#collapsed = !this.#collapsed;
      this.#syncCollapsed();
      this.#dispatchAction('updateConfig', { overviewOpen: !this.#collapsed });
    });

    const bodyEl = this.#document.createElement('div');
    bodyEl.setAttribute('data-role', 'overview-body');
    bodyEl.className = 'overview-body';

    const stageSection = this.#document.createElement('div');
    stageSection.className = 'overview-section';
    stageSection.appendChild(createSectionHeader(this.#document, 'Stage'));
    const stageEl = this.#document.createElement('div');
    stageEl.setAttribute('data-role', 'overview-stage');
    stageEl.className = 'stage-pill';
    stageSection.appendChild(stageEl);

    const usageSection = this.#document.createElement('div');
    usageSection.className = 'overview-section';
    usageSection.appendChild(createSectionHeader(this.#document, 'Models'));
    const usageEl = this.#document.createElement('div');
    usageEl.setAttribute('data-role', 'overview-usage');
    usageSection.appendChild(usageEl);

    const stepsSection = this.#document.createElement('div');
    stepsSection.className = 'overview-section';
    stepsSection.appendChild(createSectionHeader(this.#document, 'Recent Steps'));
    const stepsEl = this.#document.createElement('div');
    stepsEl.setAttribute('data-role', 'overview-steps');
    stepsSection.appendChild(stepsEl);

    bodyEl.appendChild(stageSection);
    bodyEl.appendChild(usageSection);
    bodyEl.appendChild(stepsSection);
    panelEl.appendChild(toggleEl);
    panelEl.appendChild(bodyEl);

    shadowRoot.appendChild(style);
    shadowRoot.appendChild(panelEl);

    this.#panelEl = panelEl;
    this.#toggleEl = toggleEl;
    this.#chevronEl = chevronEl;
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
    const stageCollapsed = Boolean(stage.collapsed || stage.mode === 'collapsed');
    this.#stageEl.textContent = stageCollapsed
      ? (stage.stageLabel ?? 'Idle')
      : (stage.stageLabel ?? 'Idle');

    const overview = snapshot?.overview ?? {};
    this.#renderSteps(Array.isArray(overview.stepDurations) ? overview.stepDurations : []);
    this.#renderUsage(snapshot?.quota, overview.perModel ?? {});
  }

  #renderSteps(stepDurations) {
    this.#stepsEl.innerHTML = '';
    const nonZero = stepDurations.filter((step) => Number(step?.durationMs) > 0);
    const displaySteps = (nonZero.length > 0 ? nonZero : stepDurations).slice(-8);

    if (displaySteps.length === 0) {
      const empty = this.#document.createElement('div');
      empty.className = 'empty-muted';
      empty.textContent = 'No steps recorded yet';
      this.#stepsEl.appendChild(empty);
      return;
    }

    const maxDurationMs = Math.max(
      1,
      ...displaySteps.map((step) => (Number.isFinite(Number(step?.durationMs)) ? Number(step.durationMs) : 0)),
    );

    for (const step of displaySteps) {
      const durationMs = Number.isFinite(Number(step?.durationMs)) && Number(step.durationMs) > 0
        ? Number(step.durationMs)
        : 0;
      const pct = Math.min(100, Math.round((durationMs / maxDurationMs) * 100));

      const row = this.#document.createElement('div');
      row.className = 'overview-row step-row';
      row.setAttribute('data-role', 'step-duration-row');

      const labelEl = this.#document.createElement('span');
      labelEl.className = 'step-label';
      labelEl.textContent = formatStepLabel(step?.label ?? 'Step');

      const trackEl = this.#document.createElement('div');
      trackEl.className = 'step-bar-track';
      const fillEl = this.#document.createElement('div');
      fillEl.className = 'step-bar-fill';
      fillEl.style.width = `${pct}%`;
      trackEl.appendChild(fillEl);

      const durEl = this.#document.createElement('span');
      durEl.className = 'step-duration';
      durEl.textContent = formatDurationMs(durationMs);

      row.appendChild(labelEl);
      row.appendChild(trackEl);
      row.appendChild(durEl);
      this.#stepsEl.appendChild(row);
    }
  }

  #renderUsage(quota, perModel) {
    this.#usageEl.innerHTML = '';
    if (quota?.available && quota?.models && typeof quota.models === 'object') {
      for (const [model, info] of Object.entries(quota.models)) {
        const row = this.#document.createElement('div');
        row.className = 'overview-row';
        row.setAttribute('data-role', 'model-quota-row');
        row.setAttribute('data-model', model);

        const nameEl = this.#document.createElement('span');
        nameEl.className = 'model-name';
        nameEl.textContent = model;

        const pct = Number.isFinite(Number(info?.remainingPercent))
          ? `${Math.round(Number(info.remainingPercent))}%`
          : '—';
        const valEl = this.#document.createElement('span');
        valEl.className = 'model-cost';
        valEl.textContent = info?.label ?? `${pct} remaining`;

        row.appendChild(nameEl);
        row.appendChild(valEl);
        this.#usageEl.appendChild(row);
      }
      return;
    }

    const entries = Object.entries(perModel);
    if (entries.length === 0) {
      const empty = this.#document.createElement('div');
      empty.className = 'empty-muted';
      empty.textContent = 'No model usage yet';
      this.#usageEl.appendChild(empty);
      return;
    }

    for (const [model, bucket] of entries) {
      const row = this.#document.createElement('div');
      row.className = 'overview-row';
      row.setAttribute('data-role', 'model-usage-row');
      row.setAttribute('data-model', model);

      const meta = this.#document.createElement('div');
      meta.className = 'model-meta';

      const nameEl = this.#document.createElement('span');
      nameEl.className = 'model-name';
      nameEl.textContent = model;

      const tokensEl = this.#document.createElement('span');
      tokensEl.className = 'model-tokens';
      const inTok = formatCompactTokens(bucket?.inputTokens ?? 0);
      const outTok = formatCompactTokens(bucket?.outputTokens ?? 0);
      tokensEl.textContent = `${inTok} in · ${outTok} out`;

      meta.appendChild(nameEl);
      meta.appendChild(tokensEl);

      const costEl = this.#document.createElement('span');
      costEl.className = 'model-cost';
      costEl.textContent =
        typeof bucket?.costUsd === 'number' ? `$${bucket.costUsd.toFixed(4)}` : '$0.0000';

      row.appendChild(meta);
      row.appendChild(costEl);
      this.#usageEl.appendChild(row);
    }
  }

  #syncCollapsed() {
    if (!this.#panelEl || !this.#toggleEl || !this.#bodyEl) {
      return;
    }
    this.#panelEl.setAttribute('data-collapsed', this.#collapsed ? 'true' : 'false');
    this.#bodyEl.setAttribute('aria-hidden', this.#collapsed ? 'true' : 'false');
    this.#toggleEl.setAttribute('aria-expanded', this.#collapsed ? 'false' : 'true');
    if (this.#chevronEl) {
      this.#chevronEl.textContent = this.#collapsed ? '▾' : '▴';
    }
  }

  unmount() {
    if (this.#shadowRoot) {
      this.#shadowRoot.innerHTML = '';
    }
    this.#shadowRoot = null;
  }
}

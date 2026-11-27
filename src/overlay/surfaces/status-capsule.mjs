import { buildBreakdownStats, formatTokenCount } from './context-breakdown.mjs';

export const MIN_CAPSULE_SLOTS = 1;
export const MAX_CAPSULE_SLOTS = 5;
export const AVAILABLE_CAPSULE_SLOTS = Object.freeze([
  'model',
  'context',
  'cost',
  'speed',
  'cache',
  'ttft',
  'tokens',
]);

export function clampCapsuleSlots(slots) {
  if (!Array.isArray(slots)) {
    return ['model', 'context', 'cost', 'speed', 'cache'];
  }
  const filtered = slots.filter((s) => typeof s === 'string' && s.trim().length > 0);
  if (filtered.length < MIN_CAPSULE_SLOTS) {
    return [AVAILABLE_CAPSULE_SLOTS[0]];
  }
  return filtered.slice(0, MAX_CAPSULE_SLOTS);
}

function formatCost(costUsd) {
  if (typeof costUsd !== 'number' || !Number.isFinite(costUsd)) {
    return '$0.00';
  }
  if (costUsd >= 0.01 || costUsd === 0) {
    return `$${costUsd.toFixed(2)}`;
  }
  return `$${costUsd.toFixed(4)}`;
}

function formatSlotValue(slot, metrics = {}) {
  switch (slot) {
    case 'model':
      return metrics.model ?? '—';
    case 'context':
      return typeof metrics.contextPercent === 'number'
        ? `${metrics.contextPercent.toFixed(1)}% ctx`
        : '—';
    case 'cost':
      return formatCost(metrics.costUsd);
    case 'speed':
      return metrics.tokPerSecDisplay ?? '—';
    case 'ttft':
      return metrics.ttftDisplay ?? '—';
    case 'cache':
      return typeof metrics.cacheHitRate === 'number'
        ? `${Math.round(metrics.cacheHitRate * 100)}% cache`
        : '—';
    case 'tokens':
      return typeof metrics.outputTokens === 'number'
        ? `${formatTokenCount(metrics.outputTokens)} tok`
        : '0 tok';
    default:
      return String(metrics[slot] ?? '—');
  }
}

function clampPct(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return 0;
  }
  return Math.min(100, Math.max(0, num));
}

function buildRingSvg(percent) {
  const pct = clampPct(percent);
  const r = 6;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - pct / 100);
  const stroke = pct >= 85 ? '#f87171' : pct >= 65 ? '#fbbf24' : '#22d3ee';
  return `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="${r}" fill="none" stroke="rgba(255,255,255,0.14)" stroke-width="2"/><circle cx="8" cy="8" r="${r}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" transform="rotate(-90 8 8)"/></svg>`;
}

/**
 * Shadow DOM Status Capsule surface: compact glass pill with SVG context ring,
 * 1-5 clamped metric slots, hover summary, unified agy-powertools dashboard
 * popover, and right-click refresh over the CDP binding.
 */
export class StatusCapsuleSurface {
  #document;
  #dispatchAction;
  #shadowRoot = null;
  #barEl = null;
  #ringEl = null;
  #slotsEl = null;
  #badgeEl = null;
  #hoverEl = null;
  #popoverEl = null;
  #kpiSpeedValEl = null;
  #kpiSpeedSubEl = null;
  #kpiTtftValEl = null;
  #kpiCacheValEl = null;
  #kpiCostValEl = null;
  #ctxSummaryEl = null;
  #ctxBarEl = null;
  #ctxLegendEl = null;
  #usageSectionEl = null;
  #updateBannerEl = null;
  #releaseLinkEl = null;
  #updateCmdEl = null;
  #settingsToggleEl = null;
  #settingsPanelEl = null;
  #slotListEl = null;
  #budgetModeEl = null;
  #budgetValueEl = null;
  #updateModeEl = null;
  #updateCheckBtnEl = null;
  #popoverOpen = false;
  #hoverOpen = false;
  #settingsOpen = false;
  #lastSnapshot = {};

  constructor({
    document = globalThis.document,
    dispatchAction = () => {},
  } = {}) {
    this.#document = document;
    this.#dispatchAction = dispatchAction;
  }

  mount(shadowRoot) {
    this.#shadowRoot = shadowRoot;
    shadowRoot.innerHTML = '';

    const style = this.#document.createElement('style');
    style.textContent = `
      :host { display: inline-flex; align-items: center; position: relative; margin-right: 6px !important; z-index: 50; -webkit-app-region: no-drag !important; app-region: no-drag !important; font-family: system-ui, -apple-system, sans-serif; font-size: 12px; color: var(--foreground, #e4e4e7); flex-shrink: 0; }
      * { box-sizing: border-box; }
      .capsule-bar { height: 26px; display: inline-flex; align-items: center; gap: 6px; padding: 0 9px; border-radius: 999px; cursor: pointer; -webkit-app-region: no-drag !important; app-region: no-drag !important; background: rgba(24, 24, 27, 0.85); border: 1px solid rgba(255, 255, 255, 0.1); color: #e4e4e7; font-variant-numeric: tabular-nums; backdrop-filter: blur(8px); transition: background 120ms ease, border-color 120ms ease; }
      .capsule-bar:hover { background: rgba(39, 39, 42, 0.95); border-color: rgba(255, 255, 255, 0.2); }
      .capsule-ring { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; flex-shrink: 0; }
      .capsule-slots { display: inline-flex; align-items: center; }
      .capsule-slot { white-space: nowrap; padding: 0 7px; border-right: 1px solid rgba(255, 255, 255, 0.1); font-size: 11px; line-height: 1.2; color: #e4e4e7; }
      .capsule-slot:first-child { padding-left: 2px; }
      .capsule-slot:last-child { border-right: none; padding-right: 2px; }
      .update-badge { padding: 1px 6px; border-radius: 999px; background: rgba(34, 211, 238, 0.16); color: #22d3ee; border: 1px solid rgba(34, 211, 238, 0.35); font-size: 10px; font-weight: 600; white-space: nowrap; }
      .hover-summary { position: absolute; top: 100%; right: 0; margin-top: 6px; z-index: 80; padding: 6px 10px; border-radius: 8px; background: #18181b; color: #d4d4d8; border: 1px solid rgba(255, 255, 255, 0.12); box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45); font-size: 11px; white-space: nowrap; font-variant-numeric: tabular-nums; }
      .capsule-popover { position: fixed; top: 48px; right: 20px; width: 430px; max-height: 78vh; overflow-y: auto; z-index: 80; pointer-events: auto; padding: 14px; border-radius: 12px; background: #18181b; color: #e4e4e7; border: 1px solid rgba(255, 255, 255, 0.1); box-shadow: 0 16px 40px rgba(0, 0, 0, 0.55); display: flex; flex-direction: column; gap: 12px; }
      [aria-hidden="true"] { display: none !important; }
      .kpi-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
      .kpi-card { background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 8px; padding: 8px 9px; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .kpi-label { font-size: 10px; color: #a1a1aa; text-transform: uppercase; letter-spacing: 0.04em; }
      .kpi-value { font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; color: #f4f4f5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .kpi-value--cyan { color: #22d3ee; }
      .kpi-value--emerald { color: #34d399; }
      .kpi-sub { font-size: 10px; color: #71717a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .section-card { background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
      .section-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .section-title { font-size: 12px; font-weight: 600; color: #f4f4f5; }
      .section-meta { font-size: 11px; color: #a1a1aa; font-variant-numeric: tabular-nums; }
      .segmented-bar { display: flex; width: 100%; height: 8px; border-radius: 999px; overflow: hidden; background: rgba(255, 255, 255, 0.08); gap: 1px; }
      .segmented-segment { height: 100%; min-width: 2px; }
      .legend-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px 12px; }
      .legend-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 11px; min-width: 0; }
      .legend-label { display: inline-flex; align-items: center; gap: 6px; min-width: 0; color: #d4d4d8; }
      .legend-dot { width: 7px; height: 7px; border-radius: 999px; flex-shrink: 0; }
      .legend-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .legend-val { color: #a1a1aa; font-variant-numeric: tabular-nums; white-space: nowrap; flex-shrink: 0; }
      .usage-row { display: flex; flex-direction: column; gap: 4px; }
      .usage-row-top { display: flex; justify-content: space-between; font-size: 11px; color: #d4d4d8; font-variant-numeric: tabular-nums; }
      .usage-track { height: 5px; width: 100%; border-radius: 999px; background: rgba(255, 255, 255, 0.08); overflow: hidden; }
      .usage-fill { height: 100%; border-radius: 999px; background: #22d3ee; }
      .update-banner { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border-radius: 8px; background: rgba(34, 211, 238, 0.08); border: 1px solid rgba(34, 211, 238, 0.25); }
      .update-banner-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11px; }
      .update-link { color: #22d3ee; text-decoration: none; font-weight: 500; }
      .update-link:hover { text-decoration: underline; }
      .update-cmd { width: 100%; background: #09090b; color: #e4e4e7; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 6px; padding: 4px 8px; font-family: ui-monospace, monospace; font-size: 11px; }
      .settings-toggle { width: 100%; display: flex; align-items: center; justify-content: space-between; background: rgba(255, 255, 255, 0.03); color: #a1a1aa; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 8px; padding: 7px 10px; font-size: 11px; font-weight: 500; cursor: pointer; }
      .settings-toggle:hover { color: #f4f4f5; background: rgba(255, 255, 255, 0.06); }
      .settings-panel { display: flex; flex-direction: column; gap: 10px; padding: 10px 12px; border-radius: 8px; background: rgba(255, 255, 255, 0.02); border: 1px solid rgba(255, 255, 255, 0.08); }
      .setting-row { display: flex; flex-direction: column; gap: 5px; }
      .setting-row-inline { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
      .setting-label { font-size: 11px; font-weight: 500; color: #a1a1aa; }
      .slot-pills { display: flex; flex-wrap: wrap; gap: 5px; }
      .slot-pill { padding: 3px 8px; border-radius: 999px; font-size: 11px; cursor: pointer; border: 1px solid rgba(255, 255, 255, 0.12); background: #27272a; color: #a1a1aa; transition: all 120ms ease; }
      .slot-pill[data-active="true"] { background: rgba(34, 211, 238, 0.16); color: #22d3ee; border-color: rgba(34, 211, 238, 0.4); }
      .dark-select, .dark-input { background: #27272a; color: #e4e4e7; border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 6px; padding: 4px 8px; font-size: 11px; outline: none; }
      .dark-input { width: 100px; font-variant-numeric: tabular-nums; }
      .inline-controls { display: flex; align-items: center; gap: 6px; }
      .check-btn { background: #27272a; color: #e4e4e7; border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 6px; padding: 4px 9px; font-size: 11px; cursor: pointer; }
      .check-btn:hover { background: #3f3f46; }
    `;

    const container = this.#document.createElement('div');
    container.setAttribute('data-role', 'status-capsule-root');

    const bar = this.#document.createElement('div');
    bar.setAttribute('data-role', 'capsule-bar');
    bar.className = 'capsule-bar';

    const ringEl = this.#document.createElement('span');
    ringEl.setAttribute('data-role', 'capsule-ring');
    ringEl.className = 'capsule-ring';
    ringEl.innerHTML = buildRingSvg(0);
    bar.appendChild(ringEl);

    const slotsEl = this.#document.createElement('div');
    slotsEl.setAttribute('data-role', 'capsule-slots');
    slotsEl.className = 'capsule-slots';
    bar.appendChild(slotsEl);

    const badgeEl = this.#document.createElement('span');
    badgeEl.setAttribute('data-role', 'update-badge');
    badgeEl.className = 'update-badge';
    badgeEl.setAttribute('aria-hidden', 'true');
    bar.appendChild(badgeEl);

    const hoverEl = this.#document.createElement('div');
    hoverEl.setAttribute('data-role', 'hover-summary');
    hoverEl.className = 'hover-summary';
    hoverEl.setAttribute('aria-hidden', 'true');

    const popoverEl = this.#document.createElement('div');
    popoverEl.setAttribute('data-role', 'popover');
    popoverEl.className = 'capsule-popover';
    popoverEl.setAttribute('aria-hidden', 'true');

    // 1. 4-Card KPI Grid
    const kpiGrid = this.#document.createElement('div');
    kpiGrid.setAttribute('data-role', 'kpi-grid');
    kpiGrid.className = 'kpi-grid';

    const makeKpi = (label, valueClass, subText) => {
      const card = this.#document.createElement('div');
      card.className = 'kpi-card';
      const lbl = this.#document.createElement('span');
      lbl.className = 'kpi-label';
      lbl.textContent = label;
      const val = this.#document.createElement('span');
      val.className = valueClass ? `kpi-value ${valueClass}` : 'kpi-value';
      val.textContent = '—';
      const sub = this.#document.createElement('span');
      sub.className = 'kpi-sub';
      sub.textContent = subText;
      card.appendChild(lbl);
      card.appendChild(val);
      card.appendChild(sub);
      return { card, val, sub };
    };

    const speedKpi = makeKpi('Output Speed', 'kpi-value--cyan', '—');
    const ttftKpi = makeKpi('TTFT', '', 'First token');
    const cacheKpi = makeKpi('Cache Hit', 'kpi-value--emerald', 'Prompt cache');
    const costKpi = makeKpi('Session Cost', '', 'USD total');
    kpiGrid.appendChild(speedKpi.card);
    kpiGrid.appendChild(ttftKpi.card);
    kpiGrid.appendChild(cacheKpi.card);
    kpiGrid.appendChild(costKpi.card);
    popoverEl.appendChild(kpiGrid);

    // 2. Context Window Card
    const ctxCard = this.#document.createElement('div');
    ctxCard.setAttribute('data-role', 'popover-context-card');
    ctxCard.className = 'section-card';
    const ctxHeader = this.#document.createElement('div');
    ctxHeader.className = 'section-header';
    const ctxTitle = this.#document.createElement('span');
    ctxTitle.className = 'section-title';
    ctxTitle.textContent = 'Context Window';
    const ctxSummaryEl = this.#document.createElement('span');
    ctxSummaryEl.className = 'section-meta';
    ctxHeader.appendChild(ctxTitle);
    ctxHeader.appendChild(ctxSummaryEl);
    const ctxBarEl = this.#document.createElement('div');
    ctxBarEl.setAttribute('data-role', 'popover-context-bar');
    ctxBarEl.className = 'segmented-bar';
    const ctxLegendEl = this.#document.createElement('div');
    ctxLegendEl.setAttribute('data-role', 'popover-context-legend');
    ctxLegendEl.className = 'legend-grid';
    ctxCard.appendChild(ctxHeader);
    ctxCard.appendChild(ctxBarEl);
    ctxCard.appendChild(ctxLegendEl);
    popoverEl.appendChild(ctxCard);

    // 3. Usage / Soft Budget Section
    const usageSectionEl = this.#document.createElement('div');
    usageSectionEl.setAttribute('data-role', 'popover-usage-section');
    usageSectionEl.className = 'section-card';
    popoverEl.appendChild(usageSectionEl);

    // Update Banner (visible when hasUpdate)
    const updateBannerEl = this.#document.createElement('div');
    updateBannerEl.setAttribute('data-role', 'update-banner');
    updateBannerEl.className = 'update-banner';
    updateBannerEl.setAttribute('aria-hidden', 'true');
    const updateTop = this.#document.createElement('div');
    updateTop.className = 'update-banner-top';
    const updateTitle = this.#document.createElement('span');
    updateTitle.textContent = 'Update available';
    const releaseLinkEl = this.#document.createElement('a');
    releaseLinkEl.setAttribute('data-role', 'release-notes-link');
    releaseLinkEl.className = 'update-link';
    releaseLinkEl.target = '_blank';
    releaseLinkEl.rel = 'noopener noreferrer';
    releaseLinkEl.textContent = 'Release Notes';
    updateTop.appendChild(updateTitle);
    updateTop.appendChild(releaseLinkEl);
    const updateCmdEl = this.#document.createElement('input');
    updateCmdEl.setAttribute('data-role', 'update-command');
    updateCmdEl.className = 'update-cmd';
    updateCmdEl.setAttribute('readonly', 'true');
    updateBannerEl.appendChild(updateTop);
    updateBannerEl.appendChild(updateCmdEl);
    popoverEl.appendChild(updateBannerEl);

    // 4. Collapsible Labeled Settings Section
    const settingsToggleEl = this.#document.createElement('button');
    settingsToggleEl.setAttribute('data-role', 'settings-toggle');
    settingsToggleEl.className = 'settings-toggle';
    settingsToggleEl.setAttribute('aria-expanded', 'false');
    settingsToggleEl.textContent = 'Settings ⚙';
    settingsToggleEl.addEventListener('click', () => {
      this.#settingsOpen = !this.#settingsOpen;
      this.#syncVisibility();
    });
    popoverEl.appendChild(settingsToggleEl);

    const settingsPanelEl = this.#document.createElement('div');
    settingsPanelEl.setAttribute('data-role', 'settings-panel');
    settingsPanelEl.className = 'settings-panel';
    settingsPanelEl.setAttribute('aria-hidden', 'true');

    // Metric Slots (1-5)
    const slotsSetting = this.#document.createElement('div');
    slotsSetting.className = 'setting-row';
    const slotsLabel = this.#document.createElement('label');
    slotsLabel.className = 'setting-label';
    slotsLabel.textContent = 'Metric Slots (1–5)';
    const slotListEl = this.#document.createElement('div');
    slotListEl.setAttribute('data-role', 'slot-selector');
    slotListEl.className = 'slot-pills';
    slotsSetting.appendChild(slotsLabel);
    slotsSetting.appendChild(slotListEl);
    settingsPanelEl.appendChild(slotsSetting);

    // Ring Mode
    const ringModeRow = this.#document.createElement('div');
    ringModeRow.className = 'setting-row-inline';
    const ringModeLabel = this.#document.createElement('label');
    ringModeLabel.className = 'setting-label';
    ringModeLabel.textContent = 'Ring Mode';
    const budgetModeEl = this.#document.createElement('select');
    budgetModeEl.setAttribute('data-role', 'ring-mode-select');
    budgetModeEl.className = 'dark-select';
    for (const [val, text] of [
      ['context_window', 'Context Window'],
      ['soft_budget_usd', 'Soft Budget (USD)'],
      ['soft_budget_tokens', 'Soft Budget (Tokens)'],
    ]) {
      const opt = this.#document.createElement('option');
      opt.value = val;
      opt.setAttribute('value', val);
      opt.textContent = text;
      budgetModeEl.appendChild(opt);
    }
    ringModeRow.appendChild(ringModeLabel);
    ringModeRow.appendChild(budgetModeEl);
    settingsPanelEl.appendChild(ringModeRow);

    // Soft Budget
    const budgetRow = this.#document.createElement('div');
    budgetRow.className = 'setting-row-inline';
    const budgetLabel = this.#document.createElement('label');
    budgetLabel.className = 'setting-label';
    budgetLabel.textContent = 'Soft Budget';
    const budgetValueEl = this.#document.createElement('input');
    budgetValueEl.setAttribute('data-role', 'soft-budget-input');
    budgetValueEl.className = 'dark-input';
    budgetValueEl.type = 'number';
    budgetValueEl.placeholder = '0';
    budgetRow.appendChild(budgetLabel);
    budgetRow.appendChild(budgetValueEl);
    settingsPanelEl.appendChild(budgetRow);

    // Update Check
    const updateRow = this.#document.createElement('div');
    updateRow.className = 'setting-row-inline';
    const updateLabel = this.#document.createElement('label');
    updateLabel.className = 'setting-label';
    updateLabel.textContent = 'Update Check';
    const updateControls = this.#document.createElement('div');
    updateControls.className = 'inline-controls';
    const updateModeEl = this.#document.createElement('select');
    updateModeEl.setAttribute('data-role', 'update-mode-select');
    updateModeEl.className = 'dark-select';
    for (const [val, text] of [
      ['auto', 'Auto'],
      ['manual', 'Manual'],
      ['off', 'Off'],
    ]) {
      const opt = this.#document.createElement('option');
      opt.value = val;
      opt.setAttribute('value', val);
      opt.textContent = text;
      updateModeEl.appendChild(opt);
    }
    const updateCheckBtnEl = this.#document.createElement('button');
    updateCheckBtnEl.setAttribute('data-role', 'update-check-btn');
    updateCheckBtnEl.className = 'check-btn';
    updateCheckBtnEl.textContent = 'Check';
    updateCheckBtnEl.addEventListener('click', () => {
      this.#dispatchAction('checkUpdates', {});
    });
    updateControls.appendChild(updateModeEl);
    updateControls.appendChild(updateCheckBtnEl);
    updateRow.appendChild(updateLabel);
    updateRow.appendChild(updateControls);
    settingsPanelEl.appendChild(updateRow);

    popoverEl.appendChild(settingsPanelEl);

    bar.addEventListener('mouseenter', () => {
      this.#hoverOpen = true;
      this.#syncVisibility();
    });
    bar.addEventListener('mouseleave', () => {
      this.#hoverOpen = false;
      this.#syncVisibility();
    });
    bar.addEventListener('click', () => {
      this.#popoverOpen = !this.#popoverOpen;
      this.#syncVisibility();
    });
    bar.addEventListener('contextmenu', (event) => {
      if (typeof event?.preventDefault === 'function') {
        event.preventDefault();
      }
      this.#dispatchAction('refresh', { surface: 'status-capsule' });
    });

    budgetModeEl.addEventListener('change', () => {
      this.#dispatchAction('updateConfig', { ringMode: budgetModeEl.value });
    });
    budgetValueEl.addEventListener('change', () => {
      const val = Math.max(0, Number(budgetValueEl.value) || 0);
      const mode = budgetModeEl.value;
      if (mode === 'soft_budget_tokens') {
        this.#dispatchAction('updateConfig', { softBudgetTokens: val });
      } else {
        this.#dispatchAction('updateConfig', { softBudgetUsd: val });
      }
    });
    updateModeEl.addEventListener('change', () => {
      this.#dispatchAction('updateConfig', { updateCheckMode: updateModeEl.value });
    });

    container.appendChild(bar);
    container.appendChild(hoverEl);
    container.appendChild(popoverEl);
    shadowRoot.appendChild(style);
    shadowRoot.appendChild(container);

    this.#barEl = bar;
    this.#ringEl = ringEl;
    this.#slotsEl = slotsEl;
    this.#badgeEl = badgeEl;
    this.#hoverEl = hoverEl;
    this.#popoverEl = popoverEl;
    this.#kpiSpeedValEl = speedKpi.val;
    this.#kpiSpeedSubEl = speedKpi.sub;
    this.#kpiTtftValEl = ttftKpi.val;
    this.#kpiCacheValEl = cacheKpi.val;
    this.#kpiCostValEl = costKpi.val;
    this.#ctxSummaryEl = ctxSummaryEl;
    this.#ctxBarEl = ctxBarEl;
    this.#ctxLegendEl = ctxLegendEl;
    this.#usageSectionEl = usageSectionEl;
    this.#updateBannerEl = updateBannerEl;
    this.#releaseLinkEl = releaseLinkEl;
    this.#updateCmdEl = updateCmdEl;
    this.#settingsToggleEl = settingsToggleEl;
    this.#settingsPanelEl = settingsPanelEl;
    this.#slotListEl = slotListEl;
    this.#budgetModeEl = budgetModeEl;
    this.#budgetValueEl = budgetValueEl;
    this.#updateModeEl = updateModeEl;
    this.#updateCheckBtnEl = updateCheckBtnEl;

    this.#syncVisibility();
  }

  update(snapshot = {}) {
    this.#lastSnapshot = snapshot ?? {};
    if (!this.#shadowRoot) {
      return;
    }

    const config = this.#lastSnapshot.config ?? {};
    const metrics = this.#lastSnapshot.metrics ?? {};
    const update = this.#lastSnapshot.update ?? {};
    const slots = clampCapsuleSlots(config.capsuleSlots);

    this.#ringEl.innerHTML = buildRingSvg(metrics.contextPercent ?? 0);

    this.#slotsEl.innerHTML = '';
    for (const slot of slots) {
      const el = this.#document.createElement('span');
      el.setAttribute('data-role', 'capsule-slot');
      el.setAttribute('data-slot', slot);
      el.className = 'capsule-slot';
      el.textContent = formatSlotValue(slot, metrics);
      this.#slotsEl.appendChild(el);
    }

    this.#hoverEl.textContent = AVAILABLE_CAPSULE_SLOTS
      .map((slot) => `${slot}: ${formatSlotValue(slot, metrics)}`)
      .join(' · ');

    if (update.hasUpdate && update.latestVersion) {
      this.#badgeEl.setAttribute('aria-hidden', 'false');
      this.#badgeEl.textContent = `v${update.latestVersion}`;
    } else {
      this.#badgeEl.setAttribute('aria-hidden', 'true');
      this.#badgeEl.textContent = '';
    }

    // 1. KPI Grid
    this.#kpiSpeedValEl.textContent = metrics.tokPerSecDisplay ?? '—';
    this.#kpiSpeedSubEl.textContent = metrics.model ?? '—';
    this.#kpiTtftValEl.textContent = metrics.ttftDisplay ?? '—';
    this.#kpiCacheValEl.textContent =
      typeof metrics.cacheHitRate === 'number'
        ? `${(metrics.cacheHitRate * 100).toFixed(1)}%`
        : '—';
    this.#kpiCostValEl.textContent =
      typeof metrics.costUsd === 'number' ? `$${metrics.costUsd.toFixed(3)}` : '$0.000';

    // 2. Context Window Card
    const stats = buildBreakdownStats(this.#lastSnapshot.contextBreakdown);
    const maxCtx = Number(this.#lastSnapshot.composerRing?.maxContextTokens) || 1_000_000;
    const ctxPct = clampPct(metrics.contextPercent ?? 0);
    this.#ctxSummaryEl.textContent = `${formatTokenCount(stats.totalInputTokens)} / ${formatTokenCount(maxCtx)} (${ctxPct.toFixed(1)}%)`;

    this.#ctxBarEl.innerHTML = '';
    this.#ctxLegendEl.innerHTML = '';
    for (const item of stats.items) {
      if (item.widthPct > 0) {
        const seg = this.#document.createElement('div');
        seg.className = 'segmented-segment';
        seg.style.width = `${item.widthPct.toFixed(2)}%`;
        seg.style.background = item.color;
        this.#ctxBarEl.appendChild(seg);
      }
      const row = this.#document.createElement('div');
      row.className = 'legend-row';
      const lbl = this.#document.createElement('span');
      lbl.className = 'legend-label';
      const dot = this.#document.createElement('span');
      dot.className = 'legend-dot';
      dot.style.background = item.color;
      const name = this.#document.createElement('span');
      name.className = 'legend-name';
      name.textContent = item.category;
      const val = this.#document.createElement('span');
      val.className = 'legend-val';
      val.textContent = formatTokenCount(item.tokens);
      lbl.appendChild(dot);
      lbl.appendChild(name);
      row.appendChild(lbl);
      row.appendChild(val);
      this.#ctxLegendEl.appendChild(row);
    }

    // 3. Usage / Soft Budget Section
    this.#renderUsageSection(config, metrics);

    // Update Banner
    this.#releaseLinkEl.href = update.releaseUrl ?? '';
    this.#releaseLinkEl.setAttribute('aria-hidden', update.releaseUrl ? 'false' : 'true');
    this.#updateCmdEl.value = update.updateCommand ?? '';
    this.#updateBannerEl.setAttribute('aria-hidden', update.hasUpdate ? 'false' : 'true');

    // 4. Settings
    this.#slotListEl.innerHTML = '';
    for (const slot of AVAILABLE_CAPSULE_SLOTS) {
      const active = slots.includes(slot);
      const btn = this.#document.createElement('button');
      btn.className = 'slot-pill';
      btn.setAttribute('data-role', 'slot-toggle');
      btn.setAttribute('data-slot', slot);
      btn.setAttribute('data-active', active ? 'true' : 'false');
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      btn.textContent = active ? `✓ ${slot}` : slot;
      btn.addEventListener('click', () => {
        const next = active
          ? slots.filter((s) => s !== slot)
          : [...slots, slot];
        this.#dispatchAction('updateConfig', { capsuleSlots: clampCapsuleSlots(next) });
      });
      this.#slotListEl.appendChild(btn);
    }

    this.#budgetModeEl.value = config.ringMode ?? 'context_window';
    this.#budgetValueEl.value = String(
      config.ringMode === 'soft_budget_tokens'
        ? (config.softBudgetTokens ?? 0)
        : (config.softBudgetUsd ?? 0),
    );
    this.#updateModeEl.value = config.updateCheckMode ?? update.mode ?? 'auto';
  }

  #renderUsageSection(config, metrics) {
    this.#usageSectionEl.innerHTML = '';
    const header = this.#document.createElement('div');
    header.className = 'section-header';
    const title = this.#document.createElement('span');
    title.className = 'section-title';
    title.textContent = 'Model Usage & Budget';
    header.appendChild(title);
    this.#usageSectionEl.appendChild(header);

    const perModel = this.#lastSnapshot.overview?.perModel ?? {};
    const entries = Object.entries(perModel);
    const maxCost = entries.reduce((m, [, v]) => Math.max(m, Number(v?.costUsd) || 0), 0);

    if (entries.length === 0) {
      const empty = this.#document.createElement('div');
      empty.className = 'section-meta';
      empty.textContent = 'No model usage recorded yet';
      this.#usageSectionEl.appendChild(empty);
    } else {
      for (const [model, usage] of entries) {
        const cost = Number(usage?.costUsd) || 0;
        const pct = maxCost > 0 ? clampPct((cost / maxCost) * 100) : 0;
        const row = this.#document.createElement('div');
        row.className = 'usage-row';
        const top = this.#document.createElement('div');
        top.className = 'usage-row-top';
        const nameEl = this.#document.createElement('span');
        nameEl.textContent = model;
        const valEl = this.#document.createElement('span');
        valEl.textContent = `$${cost.toFixed(4)} (${usage?.steps ?? 0} steps)`;
        top.appendChild(nameEl);
        top.appendChild(valEl);
        const track = this.#document.createElement('div');
        track.className = 'usage-track';
        const fill = this.#document.createElement('div');
        fill.className = 'usage-fill';
        fill.style.width = `${pct.toFixed(1)}%`;
        track.appendChild(fill);
        row.appendChild(top);
        row.appendChild(track);
        this.#usageSectionEl.appendChild(row);
      }
    }

    const budgetLimit =
      config.ringMode === 'soft_budget_tokens'
        ? Number(config.softBudgetTokens) || 0
        : Number(config.softBudgetUsd) || 0;
    if (budgetLimit > 0) {
      const used =
        config.ringMode === 'soft_budget_tokens'
          ? Number(metrics.outputTokens) || 0
          : Number(metrics.costUsd) || 0;
      const pct = clampPct((used / budgetLimit) * 100);
      const row = this.#document.createElement('div');
      row.className = 'usage-row';
      const top = this.#document.createElement('div');
      top.className = 'usage-row-top';
      const lbl = this.#document.createElement('span');
      lbl.textContent = 'Soft Budget';
      const val = this.#document.createElement('span');
      val.textContent =
        config.ringMode === 'soft_budget_tokens'
          ? `${formatTokenCount(used)} / ${formatTokenCount(budgetLimit)} (${pct.toFixed(0)}%)`
          : `$${used.toFixed(2)} / $${budgetLimit.toFixed(2)} (${pct.toFixed(0)}%)`;
      top.appendChild(lbl);
      top.appendChild(val);
      const track = this.#document.createElement('div');
      track.className = 'usage-track';
      const fill = this.#document.createElement('div');
      fill.className = 'usage-fill';
      fill.style.width = `${pct.toFixed(1)}%`;
      fill.style.background = pct >= 90 ? '#f87171' : '#34d399';
      track.appendChild(fill);
      row.appendChild(top);
      row.appendChild(track);
      this.#usageSectionEl.appendChild(row);
    }
  }

  #syncVisibility() {
    if (this.#hoverEl) {
      this.#hoverEl.setAttribute('aria-hidden', this.#hoverOpen && !this.#popoverOpen ? 'false' : 'true');
    }
    if (this.#popoverEl) {
      this.#popoverEl.setAttribute('aria-hidden', this.#popoverOpen ? 'false' : 'true');
    }
    if (this.#settingsPanelEl) {
      this.#settingsPanelEl.setAttribute('aria-hidden', this.#settingsOpen ? 'false' : 'true');
    }
    if (this.#settingsToggleEl) {
      this.#settingsToggleEl.setAttribute('aria-expanded', this.#settingsOpen ? 'true' : 'false');
    }
  }

  unmount() {
    if (this.#shadowRoot) {
      this.#shadowRoot.innerHTML = '';
    }
    this.#shadowRoot = null;
  }
}

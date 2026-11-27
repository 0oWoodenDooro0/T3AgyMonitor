import { buildBreakdownStats, formatTokenCount } from './context-breakdown.mjs';

export const MIN_CAPSULE_SLOTS = 1;
export const MAX_CAPSULE_SLOTS = 5;
export const AVAILABLE_CAPSULE_SLOTS = Object.freeze([
  'model',
  'context',
  'cost',
  'speed',
  'cache',
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
    case 'cache':
      return typeof metrics.cacheHitRate === 'number'
        ? `${Math.round(metrics.cacheHitRate * 100)}% cache`
        : '—';
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
  return `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="${r}" fill="none" stroke="color-mix(in oklch, var(--border) 55%, transparent)" stroke-width="2"/><circle cx="8" cy="8" r="${r}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" transform="rotate(-90 8 8)"/></svg>`;
}

/**
 * Shadow DOM Status Capsule surface: compact glass pill with SVG context ring,
 * 1-5 clamped metric slots, hover summary, unified agy-powertools dashboard
 * popover, and right-click refresh over the CDP binding.
 */
export class StatusCapsuleSurface {
  #document;
  #dispatchAction;
  #onOpenPopover;
  #shadowRoot = null;
  #barEl = null;
  #ringEl = null;
  #slotsEl = null;
  #badgeEl = null;
  #hoverEl = null;
  #popoverEl = null;
  #kpiSpeedValEl = null;
  #kpiSpeedSubEl = null;
  #kpiContextValEl = null;
  #kpiContextSubEl = null;
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
  #updateModeEl = null;
  #updateCheckBtnEl = null;
  #popoverOpen = false;
  #hoverOpen = false;
  #settingsOpen = false;
  #lastSnapshot = {};

  constructor({
    document = globalThis.document,
    dispatchAction = () => {},
    onOpenPopover = null,
  } = {}) {
    this.#document = document;
    this.#dispatchAction = dispatchAction;
    this.#onOpenPopover = typeof onOpenPopover === 'function' ? onOpenPopover : null;
  }

  mount(shadowRoot) {
    this.#shadowRoot = shadowRoot;
    shadowRoot.innerHTML = '';

    const style = this.#document.createElement('style');
    style.textContent = `
      :host { display: inline-flex; align-items: center; position: relative; margin-right: 6px !important; z-index: 50; -webkit-app-region: no-drag !important; app-region: no-drag !important; font-family: var(--font-sans, system-ui, -apple-system, sans-serif); font-size: 12px; color: var(--foreground); flex-shrink: 0; }
      * { box-sizing: border-box; }
      .capsule-bar { height: 26px; display: inline-flex; align-items: center; gap: 6px; padding: 0 9px; border-radius: 999px; cursor: pointer; -webkit-app-region: no-drag !important; app-region: no-drag !important; background: color-mix(in oklch, var(--secondary) 55%, transparent); border: 1px solid color-mix(in oklch, var(--border) 45%, transparent); color: var(--foreground); font-variant-numeric: tabular-nums; backdrop-filter: blur(8px); transition: background 120ms ease, border-color 120ms ease; }
      .capsule-bar:hover { background: var(--accent); border-color: var(--border); }
      .capsule-ring { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; flex-shrink: 0; }
      .capsule-slots { display: inline-flex; align-items: center; }
      .capsule-slot { white-space: nowrap; padding: 0 7px; border-right: 1px solid color-mix(in oklch, var(--border) 45%, transparent); font-size: 11px; line-height: 1.2; color: var(--foreground); }
      .capsule-slot:first-child { padding-left: 2px; }
      .capsule-slot:last-child { border-right: none; padding-right: 2px; }
      .update-badge { padding: 1px 6px; border-radius: 999px; background: color-mix(in oklch, var(--primary) 16%, transparent); color: var(--primary); border: 1px solid color-mix(in oklch, var(--primary) 35%, transparent); font-size: 10px; font-weight: 600; white-space: nowrap; }
      .hover-summary { position: absolute; top: 100%; right: 0; margin-top: 6px; z-index: 80; padding: 6px 10px; border-radius: var(--radius, 8px); background: var(--popover); color: var(--popover-foreground, var(--foreground)); border: 1px solid color-mix(in oklch, var(--border) 45%, transparent); box-shadow: 0 10px 28px rgba(0, 0, 0, 0.35); font-size: 11px; white-space: nowrap; font-variant-numeric: tabular-nums; }
      .capsule-popover { position: fixed; top: 48px; right: 20px; width: 430px; max-height: 78vh; overflow-y: auto; z-index: 80; pointer-events: auto; padding: 14px; border-radius: calc(var(--radius, 8px) + 4px); background: var(--popover); color: var(--popover-foreground, var(--foreground)); border: 1px solid color-mix(in oklch, var(--border) 45%, transparent); box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45); display: flex; flex-direction: column; gap: 12px; }
      [aria-hidden="true"] { display: none !important; }
      .kpi-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
      .kpi-card { background: var(--card); border: 1px solid color-mix(in oklch, var(--border) 45%, transparent); border-radius: var(--radius, 8px); padding: 8px 9px; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .kpi-label { font-size: 10px; color: var(--muted-foreground); text-transform: uppercase; letter-spacing: 0.04em; }
      .kpi-value { font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--card-foreground, var(--foreground)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .kpi-value--cyan { color: var(--primary, #22d3ee); }
      .kpi-value--emerald { color: #34d399; }
      .kpi-sub { font-size: 10px; color: var(--muted-foreground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .section-card { background: var(--card); border: 1px solid color-mix(in oklch, var(--border) 45%, transparent); border-radius: var(--radius, 8px); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
      .section-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .section-title { font-size: 12px; font-weight: 600; color: var(--card-foreground, var(--foreground)); }
      .section-meta { font-size: 11px; color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
      .segmented-bar { display: flex; width: 100%; height: 8px; border-radius: 999px; overflow: hidden; background: var(--muted); gap: 1px; }
      .segmented-segment { height: 100%; min-width: 2px; }
      .legend-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px 12px; }
      .legend-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 11px; min-width: 0; }
      .legend-label { display: inline-flex; align-items: center; gap: 6px; min-width: 0; color: var(--foreground); }
      .legend-dot { width: 7px; height: 7px; border-radius: 999px; flex-shrink: 0; }
      .legend-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .legend-val { color: var(--muted-foreground); font-variant-numeric: tabular-nums; white-space: nowrap; flex-shrink: 0; }
      .usage-row { display: flex; flex-direction: column; gap: 4px; }
      .usage-row-top { display: flex; justify-content: space-between; font-size: 11px; color: var(--foreground); font-variant-numeric: tabular-nums; }
      .usage-track { height: 5px; width: 100%; border-radius: 999px; background: var(--muted); overflow: hidden; }
      .usage-fill { height: 100%; border-radius: 999px; background: var(--primary, #22d3ee); }
      .update-banner { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border-radius: var(--radius, 8px); background: color-mix(in oklch, var(--primary) 10%, transparent); border: 1px solid color-mix(in oklch, var(--primary) 28%, transparent); }
      .update-banner-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11px; }
      .update-link { color: var(--primary); text-decoration: none; font-weight: 500; }
      .update-link:hover { text-decoration: underline; }
      .update-cmd { width: 100%; background: var(--background); color: var(--foreground); border: 1px solid color-mix(in oklch, var(--border) 45%, transparent); border-radius: calc(var(--radius, 8px) - 2px); padding: 4px 8px; font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; }
      .settings-toggle { width: 100%; display: flex; align-items: center; justify-content: space-between; background: color-mix(in oklch, var(--secondary) 55%, transparent); color: var(--muted-foreground); border: 1px solid color-mix(in oklch, var(--border) 45%, transparent); border-radius: var(--radius, 8px); padding: 7px 10px; font-size: 11px; font-weight: 500; cursor: pointer; font-family: inherit; }
      .settings-toggle:hover { color: var(--foreground); background: var(--accent); }
      .settings-panel { display: flex; flex-direction: column; gap: 10px; padding: 10px 12px; border-radius: var(--radius, 8px); background: var(--card); border: 1px solid color-mix(in oklch, var(--border) 45%, transparent); }
      .setting-row { display: flex; flex-direction: column; gap: 5px; }
      .setting-row-inline { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
      .setting-label { font-size: 11px; font-weight: 500; color: var(--muted-foreground); }
      .slot-pills { display: flex; flex-wrap: wrap; gap: 5px; }
      .slot-pill { padding: 3px 8px; border-radius: 999px; font-size: 11px; cursor: pointer; border: 1px solid color-mix(in oklch, var(--border) 45%, transparent); background: color-mix(in oklch, var(--secondary) 55%, transparent); color: var(--muted-foreground); font-family: inherit; transition: all 120ms ease; }
      .slot-pill[data-active="true"] { background: color-mix(in oklch, var(--primary) 16%, transparent); color: var(--primary); border-color: color-mix(in oklch, var(--primary) 40%, transparent); }
      .dark-select { background: var(--secondary); color: var(--foreground); border: 1px solid color-mix(in oklch, var(--border) 45%, transparent); border-radius: calc(var(--radius, 8px) - 2px); padding: 4px 8px; font-size: 11px; font-family: inherit; outline: none; }
      .inline-controls { display: flex; align-items: center; gap: 6px; }
      .check-btn { background: var(--secondary); color: var(--foreground); border: 1px solid color-mix(in oklch, var(--border) 45%, transparent); border-radius: calc(var(--radius, 8px) - 2px); padding: 4px 9px; font-size: 11px; font-family: inherit; cursor: pointer; }
      .check-btn:hover { background: var(--accent); }
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
    const contextKpi = makeKpi('Context Used', '', '0 / 1.0M');
    const cacheKpi = makeKpi('Cache Hit', 'kpi-value--emerald', 'Prompt cache');
    const costKpi = makeKpi('Session Cost', '', 'USD total');
    kpiGrid.appendChild(speedKpi.card);
    kpiGrid.appendChild(contextKpi.card);
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
      const nextOpen = !this.#popoverOpen;
      if (nextOpen) {
        this.#onOpenPopover?.();
      }
      this.#popoverOpen = nextOpen;
      this.#syncVisibility();
    });
    bar.addEventListener('contextmenu', (event) => {
      if (typeof event?.preventDefault === 'function') {
        event.preventDefault();
      }
      this.#dispatchAction('refresh', { surface: 'status-capsule' });
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
    this.#kpiContextValEl = contextKpi.val;
    this.#kpiContextSubEl = contextKpi.sub;
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

    const stats = buildBreakdownStats(this.#lastSnapshot.contextBreakdown);
    const maxCtx = Number(this.#lastSnapshot.composerRing?.maxContextTokens) || 1_000_000;
    const ctxPct = clampPct(metrics.contextPercent ?? 0);

    // 1. KPI Grid
    this.#kpiSpeedValEl.textContent = metrics.tokPerSecDisplay ?? '—';
    this.#kpiSpeedSubEl.textContent = metrics.model ?? '—';
    this.#kpiContextValEl.textContent =
      typeof metrics.contextPercent === 'number' ? `${ctxPct.toFixed(1)}%` : '—';
    this.#kpiContextSubEl.textContent = `${formatTokenCount(stats.totalInputTokens)} / ${formatTokenCount(maxCtx)}`;
    this.#kpiCacheValEl.textContent =
      typeof metrics.cacheHitRate === 'number'
        ? `${(metrics.cacheHitRate * 100).toFixed(1)}%`
        : '—';
    this.#kpiCostValEl.textContent =
      typeof metrics.costUsd === 'number' ? `$${metrics.costUsd.toFixed(3)}` : '$0.000';

    // 2. Context Window Card
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

    // 3. Usage Section
    this.#renderUsageSection();

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

    this.#updateModeEl.value = config.updateCheckMode ?? update.mode ?? 'auto';
  }

  #renderUsageSection() {
    this.#usageSectionEl.innerHTML = '';
    const header = this.#document.createElement('div');
    header.className = 'section-header';
    const title = this.#document.createElement('span');
    title.className = 'section-title';
    title.textContent = 'Model Usage';
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
  }

  closePopover() {
    if (!this.#popoverOpen) {
      return;
    }
    this.#popoverOpen = false;
    this.#syncVisibility();
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

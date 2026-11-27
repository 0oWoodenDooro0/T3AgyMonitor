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

function formatSlotValue(slot, metrics = {}) {
  switch (slot) {
    case 'model':
      return metrics.model ?? '—';
    case 'context':
      return typeof metrics.contextPercent === 'number'
        ? `${Math.round(metrics.contextPercent)}% ctx`
        : '—';
    case 'cost':
      return typeof metrics.costUsd === 'number'
        ? `$${metrics.costUsd.toFixed(4)}`
        : '$0.0000';
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
        ? `${metrics.outputTokens} tok`
        : '0 tok';
    default:
      return String(metrics[slot] ?? '—');
  }
}

/**
 * Shadow DOM Status Capsule surface: 1-5 clamped metric slots, hover summary,
 * click popover (slot selector, Soft Budget editor, update mode/badge/links),
 * and right-click refresh over the CDP binding.
 */
export class StatusCapsuleSurface {
  #document;
  #dispatchAction;
  #shadowRoot = null;
  #barEl = null;
  #slotsEl = null;
  #badgeEl = null;
  #hoverEl = null;
  #popoverEl = null;
  #slotListEl = null;
  #budgetModeEl = null;
  #budgetValueEl = null;
  #updateModeEl = null;
  #releaseLinkEl = null;
  #updateCmdEl = null;
  #popoverOpen = false;
  #hoverOpen = false;
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
      :host { display: inline-flex; position: relative; margin-right: 6px !important; z-index: 50; -webkit-app-region: no-drag !important; app-region: no-drag !important; font-family: system-ui, sans-serif; font-size: 12px; color: var(--foreground, #e4e4e7); flex-shrink: 0; }
      .capsule-bar { display: inline-flex; align-items: center; gap: 8px; padding: 3px 8px; border-radius: 999px; cursor: pointer; -webkit-app-region: no-drag; app-region: no-drag; background: var(--secondary, rgba(24, 24, 27, 0.85)); border: 1px solid var(--border, rgba(255, 255, 255, 0.12)); color: var(--foreground, #e4e4e7); }
      .capsule-slots { display: inline-flex; align-items: center; gap: 8px; }
      .capsule-slot { white-space: nowrap; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--border, rgba(255, 255, 255, 0.12)); background: var(--secondary, rgba(255, 255, 255, 0.06)); font-size: 11px; }
      .hover-summary, .popover { padding: 8px; border-radius: 8px; background: var(--popover, rgba(24, 24, 27, 0.96)); color: var(--foreground, #e4e4e7); border: 1px solid var(--border, rgba(255, 255, 255, 0.12)); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35); }
      .hover-summary { position: absolute; top: 100%; left: 0; margin-top: 6px; z-index: 80; }
      .capsule-popover { position: fixed; top: 48px; left: 320px; z-index: 80; pointer-events: auto; max-height: 75vh; overflow-y: auto; }
      [aria-hidden="true"] { display: none; }
    `;

    const container = this.#document.createElement('div');
    container.setAttribute('data-role', 'status-capsule-root');

    const bar = this.#document.createElement('div');
    bar.setAttribute('data-role', 'capsule-bar');
    bar.className = 'capsule-bar';

    const slotsEl = this.#document.createElement('div');
    slotsEl.setAttribute('data-role', 'capsule-slots');
    slotsEl.className = 'capsule-slots';
    bar.appendChild(slotsEl);

    const badgeEl = this.#document.createElement('span');
    badgeEl.setAttribute('data-role', 'update-badge');
    badgeEl.setAttribute('aria-hidden', 'true');
    bar.appendChild(badgeEl);

    const hoverEl = this.#document.createElement('div');
    hoverEl.setAttribute('data-role', 'hover-summary');
    hoverEl.className = 'hover-summary';
    hoverEl.setAttribute('aria-hidden', 'true');

    const popoverEl = this.#document.createElement('div');
    popoverEl.setAttribute('data-role', 'popover');
    popoverEl.className = 'popover capsule-popover';
    popoverEl.setAttribute('aria-hidden', 'true');

    const slotListEl = this.#document.createElement('div');
    slotListEl.setAttribute('data-role', 'slot-selector');
    popoverEl.appendChild(slotListEl);

    const budgetModeEl = this.#document.createElement('select');
    budgetModeEl.setAttribute('data-role', 'soft-budget-mode');
    popoverEl.appendChild(budgetModeEl);

    const budgetValueEl = this.#document.createElement('input');
    budgetValueEl.setAttribute('data-role', 'soft-budget-value');
    budgetValueEl.type = 'number';
    popoverEl.appendChild(budgetValueEl);

    const updateModeEl = this.#document.createElement('select');
    updateModeEl.setAttribute('data-role', 'update-mode-select');
    popoverEl.appendChild(updateModeEl);

    const releaseLinkEl = this.#document.createElement('a');
    releaseLinkEl.setAttribute('data-role', 'release-notes-link');
    releaseLinkEl.target = '_blank';
    releaseLinkEl.rel = 'noopener noreferrer';
    releaseLinkEl.textContent = 'Release Notes';
    popoverEl.appendChild(releaseLinkEl);

    const updateCmdEl = this.#document.createElement('input');
    updateCmdEl.setAttribute('data-role', 'update-command');
    updateCmdEl.setAttribute('readonly', 'true');
    popoverEl.appendChild(updateCmdEl);

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
    this.#slotsEl = slotsEl;
    this.#badgeEl = badgeEl;
    this.#hoverEl = hoverEl;
    this.#popoverEl = popoverEl;
    this.#slotListEl = slotListEl;
    this.#budgetModeEl = budgetModeEl;
    this.#budgetValueEl = budgetValueEl;
    this.#updateModeEl = updateModeEl;
    this.#releaseLinkEl = releaseLinkEl;
    this.#updateCmdEl = updateCmdEl;

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
      .join(' | ');

    if (update.hasUpdate && update.latestVersion) {
      this.#badgeEl.setAttribute('aria-hidden', 'false');
      this.#badgeEl.textContent = `v${update.latestVersion}`;
    } else {
      this.#badgeEl.setAttribute('aria-hidden', 'true');
      this.#badgeEl.textContent = '';
    }

    this.#slotListEl.innerHTML = '';
    for (const slot of AVAILABLE_CAPSULE_SLOTS) {
      const btn = this.#document.createElement('button');
      btn.setAttribute('data-role', 'slot-toggle');
      btn.setAttribute('data-slot', slot);
      btn.textContent = slots.includes(slot) ? `[x] ${slot}` : `[ ] ${slot}`;
      btn.addEventListener('click', () => {
        const next = slots.includes(slot)
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
    this.#releaseLinkEl.href = update.releaseUrl ?? '';
    this.#releaseLinkEl.setAttribute('aria-hidden', update.releaseUrl ? 'false' : 'true');
    this.#updateCmdEl.value = update.updateCommand ?? '';
  }

  #syncVisibility() {
    if (this.#hoverEl) {
      this.#hoverEl.setAttribute('aria-hidden', this.#hoverOpen && !this.#popoverOpen ? 'false' : 'true');
    }
    if (this.#popoverEl) {
      this.#popoverEl.setAttribute('aria-hidden', this.#popoverOpen ? 'false' : 'true');
    }
  }

  unmount() {
    if (this.#shadowRoot) {
      this.#shadowRoot.innerHTML = '';
    }
    this.#shadowRoot = null;
  }
}

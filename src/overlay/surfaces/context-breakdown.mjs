export const CONTEXT_CATEGORIES = Object.freeze([
  'User Messages',
  'Assistant & Thinking',
  'Tool Calls',
  'Tool Results',
  'Subagent Notifications',
  'Checkpoints',
  'System & Tools Overhead',
]);

export const CATEGORY_COLORS = Object.freeze({
  'User Messages': '#38bdf8',
  'Assistant & Thinking': '#a78bfa',
  'Tool Calls': '#fbbf24',
  'Tool Results': '#34d399',
  'Subagent Notifications': '#f472b6',
  Checkpoints: '#fb923c',
  'System & Tools Overhead': '#71717a',
});

function toNonNegativeInt(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0;
}

export function formatTokenCount(value) {
  const num = toNonNegativeInt(value);
  if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(1)}M`;
  }
  if (num >= 10_000) {
    return `${(num / 1000).toFixed(1)}k`;
  }
  return String(num);
}

export function normalizeBreakdownEntry(entry, fallbackLabel = 'Main Agent') {
  const source = entry && typeof entry === 'object' ? entry : {};
  const rawCategories = source.categories && typeof source.categories === 'object' ? source.categories : {};
  const categories = {};
  for (const cat of CONTEXT_CATEGORIES) {
    categories[cat] = toNonNegativeInt(rawCategories[cat]);
  }
  const totalInputTokens = toNonNegativeInt(source.totalInputTokens);
  return {
    label: typeof source.label === 'string' && source.label.trim() ? source.label : fallbackLabel,
    totalInputTokens,
    categories,
  };
}

export function buildBreakdownStats(entry, fallbackLabel = 'Main Agent') {
  const normalized = normalizeBreakdownEntry(entry, fallbackLabel);
  const sumOfCategoryTokens = CONTEXT_CATEGORIES.reduce(
    (sum, category) => sum + (normalized.categories[category] ?? 0),
    0,
  );
  const denominator = Math.max(normalized.totalInputTokens, sumOfCategoryTokens);
  const items = CONTEXT_CATEGORIES.map((category) => {
    const tokens = normalized.categories[category] ?? 0;
    const pct = denominator > 0 ? Math.min(100, Math.round((tokens / denominator) * 100)) : 0;
    const widthPct = denominator > 0 ? Math.min(100, (tokens / denominator) * 100) : 0;
    return {
      category,
      tokens,
      pct,
      widthPct,
      color: CATEGORY_COLORS[category] ?? '#71717a',
    };
  });
  return {
    label: normalized.label,
    totalInputTokens: normalized.totalInputTokens,
    sumOfCategoryTokens,
    denominator,
    items,
  };
}

/**
 * Shadow DOM Context Breakdown surface rendering the 7 exact categories
 * (ADR-0002) with a segmented bar, 2-column legend, and agent switcher.
 */
export class ContextBreakdownSurface {
  #document;
  #dispatchAction;
  #shadowRoot = null;
  #rootEl = null;
  #toggleEl = null;
  #switcherEl = null;
  #totalEl = null;
  #barEl = null;
  #rowsEl = null;
  #open = false;
  #selectedAgentId = 'main';
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
      :host { display: inline-flex; align-items: center; position: relative; margin-right: 6px !important; z-index: 50; -webkit-app-region: no-drag !important; app-region: no-drag !important; font-family: system-ui, -apple-system, sans-serif; font-size: 12px; color: var(--foreground, #e4e4e7); flex-shrink: 0; }
      .context-toggle { box-sizing: border-box; display: inline-flex; align-items: center; height: 26px; padding: 0 10px; border-radius: 999px; -webkit-app-region: no-drag !important; app-region: no-drag !important; background: rgba(24, 24, 27, 0.85); color: var(--foreground, #e4e4e7); border: 1px solid rgba(255, 255, 255, 0.1); font-size: 11px; font-weight: 500; font-variant-numeric: tabular-nums; cursor: pointer; white-space: nowrap; transition: background 120ms ease, border-color 120ms ease; }
      .context-toggle:hover { background: rgba(39, 39, 42, 0.95); border-color: rgba(255, 255, 255, 0.2); }
      .breakdown-panel { position: fixed; top: 48px; right: 160px; width: 390px; max-height: 75vh; overflow-y: auto; z-index: 80; pointer-events: auto; padding: 12px 14px; border-radius: 12px; background: #18181b; color: #e4e4e7; border: 1px solid rgba(255, 255, 255, 0.1); box-shadow: 0 16px 40px rgba(0, 0, 0, 0.55); }
      [data-open="false"] .breakdown-panel { display: none; }
      .breakdown-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
      .breakdown-title-group { display: flex; align-items: center; gap: 8px; min-width: 0; }
      .breakdown-title { font-size: 12px; font-weight: 600; color: #f4f4f5; white-space: nowrap; }
      .breakdown-total { font-size: 11px; font-weight: 500; color: #a1a1aa; font-variant-numeric: tabular-nums; margin-left: auto; white-space: nowrap; }
      select { background: #27272a; color: #e4e4e7; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 6px; padding: 3px 8px; font-size: 11px; outline: none; cursor: pointer; max-width: 160px; }
      select:hover { border-color: rgba(255, 255, 255, 0.24); }
      .segmented-bar { display: flex; width: 100%; height: 8px; border-radius: 999px; overflow: hidden; background: rgba(255, 255, 255, 0.08); margin-bottom: 10px; gap: 1px; }
      .segmented-segment { height: 100%; min-width: 2px; transition: width 160ms ease; }
      .breakdown-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 12px; }
      .breakdown-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 2px 0; min-width: 0; font-size: 11px; }
      .category-label { display: inline-flex; align-items: center; gap: 6px; min-width: 0; color: #d4d4d8; }
      .category-dot { width: 7px; height: 7px; border-radius: 999px; flex-shrink: 0; }
      .category-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .category-value { color: #a1a1aa; font-variant-numeric: tabular-nums; white-space: nowrap; flex-shrink: 0; }
    `;

    const root = this.#document.createElement('div');
    root.setAttribute('data-role', 'context-breakdown-root');
    root.setAttribute('data-open', this.#open ? 'true' : 'false');

    const toggleEl = this.#document.createElement('button');
    toggleEl.setAttribute('data-role', 'context-toggle');
    toggleEl.className = 'context-toggle';
    toggleEl.textContent = 'Context';
    toggleEl.addEventListener('click', () => {
      this.#open = !this.#open;
      this.#syncOpen();
    });

    const panel = this.#document.createElement('div');
    panel.setAttribute('data-role', 'context-breakdown');
    panel.className = 'breakdown-panel';

    const header = this.#document.createElement('div');
    header.className = 'breakdown-header';

    const titleGroup = this.#document.createElement('div');
    titleGroup.className = 'breakdown-title-group';

    const title = this.#document.createElement('span');
    title.setAttribute('data-role', 'breakdown-title');
    title.className = 'breakdown-title';
    title.textContent = 'Context Breakdown';

    const switcherEl = this.#document.createElement('select');
    switcherEl.setAttribute('data-role', 'agent-switcher');
    switcherEl.addEventListener('change', () => {
      this.#selectedAgentId = switcherEl.value || 'main';
      this.#renderFromSnapshot();
      this.#dispatchAction('selectContextAgent', { agentId: this.#selectedAgentId });
    });

    const totalEl = this.#document.createElement('div');
    totalEl.setAttribute('data-role', 'breakdown-total');
    totalEl.className = 'breakdown-total';

    const barEl = this.#document.createElement('div');
    barEl.setAttribute('data-role', 'breakdown-bar');
    barEl.className = 'segmented-bar';

    const rowsEl = this.#document.createElement('div');
    rowsEl.setAttribute('data-role', 'breakdown-rows');
    rowsEl.className = 'breakdown-grid';

    titleGroup.appendChild(title);
    titleGroup.appendChild(switcherEl);
    header.appendChild(titleGroup);
    header.appendChild(totalEl);
    panel.appendChild(header);
    panel.appendChild(barEl);
    panel.appendChild(rowsEl);
    root.appendChild(toggleEl);
    root.appendChild(panel);

    shadowRoot.appendChild(style);
    shadowRoot.appendChild(root);

    this.#rootEl = root;
    this.#toggleEl = toggleEl;
    this.#switcherEl = switcherEl;
    this.#totalEl = totalEl;
    this.#barEl = barEl;
    this.#rowsEl = rowsEl;
    this.#syncOpen();
  }

  #syncOpen() {
    if (this.#rootEl) {
      this.#rootEl.setAttribute('data-open', this.#open ? 'true' : 'false');
    }
    if (this.#toggleEl) {
      this.#toggleEl.setAttribute('aria-expanded', this.#open ? 'true' : 'false');
    }
  }

  update(snapshot = {}) {
    this.#lastSnapshot = snapshot ?? {};
    if (typeof this.#lastSnapshot.selectedContextAgentId === 'string' && this.#lastSnapshot.selectedContextAgentId) {
      this.#selectedAgentId = this.#lastSnapshot.selectedContextAgentId;
    }
    if (!this.#shadowRoot) {
      return;
    }
    this.#renderFromSnapshot();
  }

  #resolveBreakdowns() {
    const map = new Map();
    const multi = this.#lastSnapshot.contextBreakdowns;
    if (multi && typeof multi === 'object' && !Array.isArray(multi)) {
      for (const [agentId, entry] of Object.entries(multi)) {
        map.set(agentId, normalizeBreakdownEntry(entry, agentId === 'main' ? 'Main Agent' : agentId));
      }
    }
    if (!map.has('main')) {
      map.set('main', normalizeBreakdownEntry(this.#lastSnapshot.contextBreakdown, 'Main Agent'));
    }
    return map;
  }

  #renderFromSnapshot() {
    if (!this.#shadowRoot || !this.#switcherEl || !this.#totalEl || !this.#barEl || !this.#rowsEl) {
      return;
    }

    const breakdowns = this.#resolveBreakdowns();
    if (!breakdowns.has(this.#selectedAgentId)) {
      this.#selectedAgentId = 'main';
    }

    this.#switcherEl.innerHTML = '';
    for (const [agentId, entry] of breakdowns.entries()) {
      const option = this.#document.createElement('option');
      option.value = agentId;
      option.setAttribute('value', agentId);
      option.textContent = entry.label;
      if (agentId === this.#selectedAgentId) {
        option.selected = true;
      }
      this.#switcherEl.appendChild(option);
    }
    this.#switcherEl.value = this.#selectedAgentId;

    const active = breakdowns.get(this.#selectedAgentId) ?? normalizeBreakdownEntry(null);
    const stats = buildBreakdownStats(active);
    this.#totalEl.textContent = `Total: ${formatTokenCount(stats.totalInputTokens)}`;

    this.#barEl.innerHTML = '';
    this.#rowsEl.innerHTML = '';

    for (const item of stats.items) {
      if (item.widthPct > 0) {
        const seg = this.#document.createElement('div');
        seg.className = 'segmented-segment';
        seg.setAttribute('data-role', 'breakdown-segment');
        seg.setAttribute('data-segment-category', item.category);
        seg.style.width = `${item.widthPct.toFixed(2)}%`;
        seg.style.background = item.color;
        seg.title = `${item.category}: ${formatTokenCount(item.tokens)} (${item.pct}%)`;
        this.#barEl.appendChild(seg);
      }

      const row = this.#document.createElement('div');
      row.className = 'breakdown-row';
      row.setAttribute('data-role', 'breakdown-row');
      row.setAttribute('data-category', item.category);

      const labelWrap = this.#document.createElement('span');
      labelWrap.className = 'category-label';

      const dotEl = this.#document.createElement('span');
      dotEl.className = 'category-dot';
      dotEl.style.background = item.color;

      const nameEl = this.#document.createElement('span');
      nameEl.setAttribute('data-role', 'category-name');
      nameEl.className = 'category-name';
      nameEl.textContent = item.category;

      const valueEl = this.#document.createElement('span');
      valueEl.setAttribute('data-role', 'category-value');
      valueEl.className = 'category-value';
      valueEl.textContent = `${formatTokenCount(item.tokens)} (${item.pct}%)`;

      labelWrap.appendChild(dotEl);
      labelWrap.appendChild(nameEl);
      row.appendChild(labelWrap);
      row.appendChild(valueEl);
      this.#rowsEl.appendChild(row);
    }
  }

  unmount() {
    if (this.#shadowRoot) {
      this.#shadowRoot.innerHTML = '';
    }
    this.#shadowRoot = null;
  }
}

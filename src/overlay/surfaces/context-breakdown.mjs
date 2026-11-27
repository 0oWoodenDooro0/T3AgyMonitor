export const CONTEXT_CATEGORIES = Object.freeze([
  'User Messages',
  'Assistant & Thinking',
  'Tool Calls',
  'Tool Results',
  'Subagent Notifications',
  'Checkpoints',
  'System & Tools Overhead',
]);

function toNonNegativeInt(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0;
}

function normalizeBreakdownEntry(entry, fallbackLabel = 'Main Agent') {
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

/**
 * Shadow DOM Context Breakdown surface rendering the 7 exact categories
 * (ADR-0002) with a main-agent / subagent switcher.
 */
export class ContextBreakdownSurface {
  #document;
  #dispatchAction;
  #shadowRoot = null;
  #rootEl = null;
  #toggleEl = null;
  #switcherEl = null;
  #totalEl = null;
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
      :host { display: inline-flex; align-items: center; position: relative; margin-right: 6px !important; z-index: 50; -webkit-app-region: no-drag !important; app-region: no-drag !important; font-family: system-ui, sans-serif; font-size: 12px; color: var(--foreground, #e4e4e7); flex-shrink: 0; }
      .context-toggle { box-sizing: border-box; display: inline-flex; align-items: center; height: 26px; padding: 0 10px; border-radius: 999px; -webkit-app-region: no-drag; app-region: no-drag; background: rgba(255, 255, 255, 0.04); color: var(--foreground, #e4e4e7); border: 1px solid rgba(255, 255, 255, 0.09); font-size: 11px; font-variant-numeric: tabular-nums; cursor: pointer; white-space: nowrap; transition: background 120ms ease, border-color 120ms ease; }
      .context-toggle:hover { background: rgba(255, 255, 255, 0.08); border-color: rgba(255, 255, 255, 0.16); }
      .breakdown-panel { position: fixed; top: 48px; right: 160px; width: 360px; max-height: 70vh; overflow-y: auto; z-index: 80; pointer-events: auto; padding: 8px 10px; border-radius: 8px; background: var(--popover, rgba(24, 24, 27, 0.94)); color: var(--foreground, #e4e4e7); border: 1px solid var(--border, rgba(255, 255, 255, 0.12)); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35); backdrop-filter: blur(8px); }
      [data-open="false"] .breakdown-panel { display: none; }
      .breakdown-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
      .breakdown-row { display: flex; justify-content: space-between; gap: 8px; padding: 2px 0; }
      select { background: var(--secondary, rgba(255, 255, 255, 0.08)); color: var(--foreground, #e4e4e7); border: 1px solid var(--border, rgba(255, 255, 255, 0.14)); border-radius: 6px; padding: 2px 6px; font-size: 11px; }
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

    const title = this.#document.createElement('span');
    title.setAttribute('data-role', 'breakdown-title');
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

    const rowsEl = this.#document.createElement('div');
    rowsEl.setAttribute('data-role', 'breakdown-rows');

    header.appendChild(title);
    header.appendChild(switcherEl);
    panel.appendChild(header);
    panel.appendChild(totalEl);
    panel.appendChild(rowsEl);
    root.appendChild(toggleEl);
    root.appendChild(panel);

    shadowRoot.appendChild(style);
    shadowRoot.appendChild(root);

    this.#rootEl = root;
    this.#toggleEl = toggleEl;
    this.#switcherEl = switcherEl;
    this.#totalEl = totalEl;
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
    if (!this.#shadowRoot || !this.#switcherEl || !this.#totalEl || !this.#rowsEl) {
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
    const total = active.totalInputTokens;
    this.#totalEl.textContent = `Total: ${total} tokens`;

    this.#rowsEl.innerHTML = '';
    for (const category of CONTEXT_CATEGORIES) {
      const tokens = active.categories[category] ?? 0;
      const pct = total > 0 ? Math.round((tokens / total) * 100) : 0;

      const row = this.#document.createElement('div');
      row.className = 'breakdown-row';
      row.setAttribute('data-role', 'breakdown-row');
      row.setAttribute('data-category', category);

      const nameEl = this.#document.createElement('span');
      nameEl.setAttribute('data-role', 'category-name');
      nameEl.textContent = category;

      const valueEl = this.#document.createElement('span');
      valueEl.setAttribute('data-role', 'category-value');
      valueEl.textContent = `${tokens} (${pct}%)`;

      row.appendChild(nameEl);
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

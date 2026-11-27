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
  #switcherEl = null;
  #totalEl = null;
  #rowsEl = null;
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
      :host { display: block; font-family: system-ui, sans-serif; font-size: 12px; }
      .breakdown-panel { padding: 8px 10px; border-radius: 8px; }
      .breakdown-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
      .breakdown-row { display: flex; justify-content: space-between; gap: 8px; padding: 2px 0; }
    `;

    const root = this.#document.createElement('div');
    root.setAttribute('data-role', 'context-breakdown-root');
    root.className = 'breakdown-panel';

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
    root.appendChild(header);
    root.appendChild(totalEl);
    root.appendChild(rowsEl);

    shadowRoot.appendChild(style);
    shadowRoot.appendChild(root);

    this.#switcherEl = switcherEl;
    this.#totalEl = totalEl;
    this.#rowsEl = rowsEl;
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

function formatElapsedMs(ms) {
  const safe = Number.isFinite(Number(ms)) && Number(ms) > 0 ? Number(ms) : 0;
  return `${(safe / 1000).toFixed(1)}s`;
}

/**
 * Shadow DOM Unified Timeline surface rendering chronological merged steps
 * with turn rail, per-agent filter, and inline expansion for running
 * subagents, delegated tasks, and swarm workers.
 */
export class UnifiedTimelineSurface {
  #document;
  #dispatchAction;
  #shadowRoot = null;
  #rootEl = null;
  #toggleEl = null;
  #filterEl = null;
  #railEl = null;
  #stepsEl = null;
  #runningEl = null;
  #open = false;
  #selectedAgentId = 'all';
  #selectedTurnId = null;
  #expandedTasks = new Set();
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
      :host { display: inline-flex; align-items: center; position: relative; font-family: system-ui, sans-serif; font-size: 12px; color: var(--foreground, #e4e4e7); flex-shrink: 0; }
      .timeline-toggle { display: inline-flex; align-items: center; height: 26px; padding: 0 10px; border-radius: 999px; background: var(--secondary, rgba(24, 24, 27, 0.85)); color: var(--foreground, #e4e4e7); border: 1px solid var(--border, rgba(255, 255, 255, 0.14)); font-size: 11px; cursor: pointer; white-space: nowrap; }
      .timeline-root { position: fixed; top: 48px; right: 16px; width: 440px; max-height: 70vh; overflow-y: auto; z-index: 50; display: flex; flex-direction: column; gap: 8px; padding: 8px; border-radius: 8px; background: var(--popover, rgba(24, 24, 27, 0.94)); color: var(--foreground, #e4e4e7); border: 1px solid var(--border, rgba(255, 255, 255, 0.12)); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35); backdrop-filter: blur(8px); }
      [data-open="false"] .timeline-root { display: none; }
      .timeline-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .timeline-body { display: flex; gap: 10px; }
      .turn-rail { display: flex; flex-direction: column; gap: 4px; min-width: 72px; }
      .timeline-main { flex: 1; display: flex; flex-direction: column; gap: 6px; }
      .timeline-step { padding: 4px 6px; border-radius: 6px; }
      .timeline-root select, .timeline-root button { background: var(--secondary, rgba(255, 255, 255, 0.08)); color: var(--foreground, #e4e4e7); border: 1px solid var(--border, rgba(255, 255, 255, 0.14)); border-radius: 6px; padding: 2px 6px; font-size: 11px; }
      [aria-hidden="true"] { display: none; }
    `;

    const root = this.#document.createElement('div');
    root.setAttribute('data-role', 'unified-timeline-root');
    root.setAttribute('data-open', this.#open ? 'true' : 'false');

    const toggleEl = this.#document.createElement('button');
    toggleEl.setAttribute('data-role', 'timeline-toggle');
    toggleEl.className = 'timeline-toggle';
    toggleEl.textContent = 'Timeline';
    toggleEl.addEventListener('click', () => {
      this.#open = !this.#open;
      this.#syncOpen();
    });

    const panel = this.#document.createElement('div');
    panel.setAttribute('data-role', 'unified-timeline');
    panel.className = 'timeline-root';

    const header = this.#document.createElement('div');
    header.className = 'timeline-header';

    const title = this.#document.createElement('span');
    title.setAttribute('data-role', 'timeline-title');
    title.textContent = 'Unified Timeline';

    const filterEl = this.#document.createElement('select');
    filterEl.setAttribute('data-role', 'agent-filter');
    filterEl.addEventListener('change', () => {
      this.#selectedAgentId = filterEl.value || 'all';
      this.#render();
      this.#dispatchAction('filterTimeline', { agentId: this.#selectedAgentId });
    });

    const body = this.#document.createElement('div');
    body.className = 'timeline-body';

    const railEl = this.#document.createElement('div');
    railEl.setAttribute('data-role', 'turn-rail');
    railEl.className = 'turn-rail';

    const mainCol = this.#document.createElement('div');
    mainCol.className = 'timeline-main';

    const runningEl = this.#document.createElement('div');
    runningEl.setAttribute('data-role', 'running-tasks');

    const stepsEl = this.#document.createElement('div');
    stepsEl.setAttribute('data-role', 'timeline-steps');

    header.appendChild(title);
    header.appendChild(filterEl);
    mainCol.appendChild(runningEl);
    mainCol.appendChild(stepsEl);
    body.appendChild(railEl);
    body.appendChild(mainCol);
    panel.appendChild(header);
    panel.appendChild(body);
    root.appendChild(toggleEl);
    root.appendChild(panel);

    shadowRoot.appendChild(style);
    shadowRoot.appendChild(root);

    this.#rootEl = root;
    this.#toggleEl = toggleEl;
    this.#filterEl = filterEl;
    this.#railEl = railEl;
    this.#stepsEl = stepsEl;
    this.#runningEl = runningEl;
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
    if (snapshot?.timeline?.agentFilter) {
      this.#selectedAgentId = snapshot.timeline.agentFilter;
    }
    if (!this.#shadowRoot) {
      return;
    }
    this.#render();
  }

  #render() {
    if (!this.#shadowRoot || !this.#filterEl || !this.#railEl || !this.#stepsEl || !this.#runningEl) {
      return;
    }

    const timeline = this.#lastSnapshot.timeline ?? {};
    const turns = Array.isArray(timeline.turns) ? timeline.turns : [];
    const availableAgents = Array.isArray(timeline.availableAgents) ? timeline.availableAgents : [];

    this.#filterEl.innerHTML = '';
    const allOpt = this.#document.createElement('option');
    allOpt.value = 'all';
    allOpt.setAttribute('value', 'all');
    allOpt.textContent = 'All Agents';
    this.#filterEl.appendChild(allOpt);

    for (const agent of availableAgents) {
      const opt = this.#document.createElement('option');
      opt.value = agent.agentId;
      opt.setAttribute('value', agent.agentId);
      opt.textContent = agent.agentLabel ?? agent.agentId;
      this.#filterEl.appendChild(opt);
    }
    this.#filterEl.value = this.#selectedAgentId;

    this.#railEl.innerHTML = '';
    for (const turn of turns) {
      const btn = this.#document.createElement('button');
      btn.setAttribute('data-role', 'turn-rail-item');
      btn.setAttribute('data-turn-id', turn.turnId);
      btn.setAttribute('data-active', this.#selectedTurnId === turn.turnId ? 'true' : 'false');
      btn.textContent = `T${turn.turnIndex} (${turn.status ?? 'active'})`;
      btn.addEventListener('click', () => {
        this.#selectedTurnId = this.#selectedTurnId === turn.turnId ? null : turn.turnId;
        this.#render();
      });
      this.#railEl.appendChild(btn);
    }

    const visibleTurns = this.#selectedTurnId
      ? turns.filter((t) => t.turnId === this.#selectedTurnId)
      : turns;

    this.#runningEl.innerHTML = '';
    this.#stepsEl.innerHTML = '';

    for (const turn of visibleTurns) {
      const tasks = Array.isArray(turn.runningTasks) ? turn.runningTasks : [];
      const filteredTasks =
        this.#selectedAgentId === 'all'
          ? tasks
          : tasks.filter((task) => task.agentId === this.#selectedAgentId);

      for (const task of filteredTasks) {
        const taskKey = `${turn.turnId}:${task.agentId}`;
        const expanded = this.#expandedTasks.has(taskKey);

        const item = this.#document.createElement('div');
        item.setAttribute('data-role', 'running-task-item');
        item.setAttribute('data-agent-id', task.agentId);

        const toggle = this.#document.createElement('button');
        toggle.setAttribute('data-role', 'running-task-toggle');
        toggle.textContent = `${task.label ?? task.agentId} [${task.status ?? 'running'}] (${formatElapsedMs(task.elapsedMs)})`;
        toggle.addEventListener('click', () => {
          if (this.#expandedTasks.has(taskKey)) {
            this.#expandedTasks.delete(taskKey);
          } else {
            this.#expandedTasks.add(taskKey);
          }
          this.#render();
        });

        const details = this.#document.createElement('div');
        details.setAttribute('data-role', 'running-task-details');
        details.setAttribute('aria-hidden', expanded ? 'false' : 'true');
        details.textContent = `${task.kind ?? 'subagent'}: ${task.latestStepSummary ?? ''} (${task.eventCount ?? 0} steps)`;

        item.appendChild(toggle);
        item.appendChild(details);
        this.#runningEl.appendChild(item);
      }

      const entries = Array.isArray(turn.entries) ? turn.entries : [];
      const filteredEntries =
        this.#selectedAgentId === 'all'
          ? entries
          : entries.filter((entry) => entry.agentId === this.#selectedAgentId);

      for (const entry of filteredEntries) {
        const stepEl = this.#document.createElement('div');
        stepEl.className = 'timeline-step';
        stepEl.setAttribute('data-role', 'timeline-step');
        stepEl.setAttribute('data-agent-id', entry.agentId);
        stepEl.setAttribute('data-turn-id', turn.turnId);
        stepEl.setAttribute('data-depth', String(entry.depth ?? 0));
        stepEl.textContent = `[${entry.agentLabel ?? entry.agentId}] ${entry.type}: ${entry.summary ?? ''}`;
        this.#stepsEl.appendChild(stepEl);
      }
    }
  }

  unmount() {
    if (this.#shadowRoot) {
      this.#shadowRoot.innerHTML = '';
    }
    this.#shadowRoot = null;
  }
}

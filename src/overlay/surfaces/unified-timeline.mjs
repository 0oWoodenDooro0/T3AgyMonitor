function formatElapsedMs(ms) {
  const safe = Number.isFinite(Number(ms)) && Number(ms) > 0 ? Number(ms) : 0;
  return `${(safe / 1000).toFixed(1)}s`;
}

function resolveRoleLabel(entry) {
  if (entry.agentKind && entry.agentKind !== 'main') {
    return 'Subagent';
  }
  switch (entry.type) {
    case 'USER_INPUT':
      return 'User';
    case 'PLANNER_RESPONSE':
      return 'Assistant';
    case 'GENERIC':
      return 'Tool';
    case 'SYSTEM_MESSAGE':
      return 'System';
    default:
      return entry.type ?? 'Event';
  }
}

function formatRelativeTime(entry, turnStartMs) {
  const entryMs = Number(entry?.timestampMs);
  if (Number.isFinite(entryMs) && entryMs > 0 && Number.isFinite(turnStartMs) && turnStartMs > 0) {
    const delta = Math.max(0, entryMs - turnStartMs);
    return `+${(delta / 1000).toFixed(1)}s`;
  }
  return entry?.type ?? '';
}

/**
 * Shadow DOM Unified Timeline surface rendering chronological merged steps
 * with turn rail, per-agent filter, collapsible turn cards, and inline expansion
 * for running subagents, delegated tasks, and swarm workers.
 */
export class UnifiedTimelineSurface {
  #document;
  #dispatchAction;
  #onOpenPopover;
  #shadowRoot = null;
  #rootEl = null;
  #toggleEl = null;
  #stepCountEl = null;
  #filterEl = null;
  #railEl = null;
  #stepsEl = null;
  #runningEl = null;
  #open = false;
  #selectedAgentId = 'all';
  #selectedTurnId = null;
  #collapsedTurns = new Map();
  #expandedTasks = new Set();
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
      :host { display: inline-flex; align-items: center; position: relative; margin-right: 185px !important; z-index: 50; -webkit-app-region: no-drag !important; app-region: no-drag !important; font-family: var(--font-sans, system-ui, sans-serif); font-size: 12px; color: var(--foreground); flex-shrink: 0; }
      .timeline-toggle { box-sizing: border-box; display: inline-flex; align-items: center; height: 26px; padding: 0 10px; border-radius: 999px; -webkit-app-region: no-drag; app-region: no-drag; background: color-mix(in oklch, var(--secondary) 55%, transparent); color: var(--foreground); border: 1px solid color-mix(in oklch, var(--border) 45%, transparent); font-size: 11px; font-family: inherit; font-variant-numeric: tabular-nums; cursor: pointer; white-space: nowrap; transition: background 120ms ease, border-color 120ms ease; }
      .timeline-toggle:hover { background: var(--accent); border-color: var(--border); }
      .timeline-root { position: fixed; top: 48px; right: 16px; width: 460px; max-height: 70vh; overflow-y: auto; z-index: 80; pointer-events: auto; display: flex; flex-direction: column; gap: 8px; padding: 0 10px 10px; border-radius: calc(var(--radius, 8px) + 2px); background: var(--popover); color: var(--popover-foreground, var(--foreground)); border: 1px solid color-mix(in oklch, var(--border) 45%, transparent); box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4); backdrop-filter: blur(10px); font-variant-numeric: tabular-nums; }
      [data-open="false"] .timeline-root { display: none; }
      .timeline-header { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; flex-wrap: nowrap; gap: 8px; padding: 10px 0 8px; background: var(--popover); border-bottom: 1px solid color-mix(in oklch, var(--border) 45%, transparent); }
      .timeline-title-group { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; }
      .timeline-title { font-size: 12px; font-weight: 600; white-space: nowrap; flex-shrink: 0; color: var(--popover-foreground, var(--foreground)); }
      .timeline-count-badge { padding: 1px 6px; border-radius: 999px; font-size: 10px; white-space: nowrap; flex-shrink: 0; background: color-mix(in oklch, var(--secondary) 55%, transparent); color: var(--muted-foreground); }
      .timeline-header select { min-width: 0; flex: 1; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; }
      .timeline-body { display: flex; gap: 10px; }
      .turn-rail { display: flex; flex-direction: column; gap: 4px; min-width: 76px; }
      .turn-rail button[data-active="true"] { background: var(--accent); border-color: var(--border); color: var(--accent-foreground, var(--foreground)); }
      .timeline-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
      .turn-card { display: flex; flex-direction: column; gap: 4px; border: 1px solid color-mix(in oklch, var(--border) 45%, transparent); border-radius: var(--radius, 8px); background: var(--card); padding: 6px; }
      .turn-card-header { display: flex; align-items: center; justify-content: space-between; width: 100%; background: transparent !important; border: none !important; padding: 2px 4px !important; text-align: left; cursor: pointer; font-weight: 500; color: var(--card-foreground, var(--foreground)); font-family: inherit; }
      .turn-card-steps { display: flex; flex-direction: column; gap: 3px; }
      .turn-card[data-collapsed="true"] .turn-card-steps { display: none; }
      .timeline-step { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 6px; padding: 3px 6px; border-radius: calc(var(--radius, 8px) - 2px); background: color-mix(in oklch, var(--secondary) 45%, transparent); font-size: 11px; }
      .step-role-pill { padding: 1px 6px; border-radius: 999px; font-size: 10px; font-weight: 500; background: color-mix(in oklch, var(--secondary) 75%, transparent); color: var(--foreground); white-space: nowrap; }
      .step-summary { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--foreground); }
      .step-time { font-size: 10px; color: var(--muted-foreground); white-space: nowrap; }
      .timeline-root select, .timeline-root button { background: var(--secondary); color: var(--foreground); border: 1px solid color-mix(in oklch, var(--border) 45%, transparent); border-radius: calc(var(--radius, 8px) - 2px); padding: 2px 6px; font-size: 11px; font-family: inherit; }
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
      const nextOpen = !this.#open;
      if (nextOpen) {
        this.#onOpenPopover?.();
      }
      this.#open = nextOpen;
      this.#syncOpen();
    });

    const panel = this.#document.createElement('div');
    panel.setAttribute('data-role', 'unified-timeline');
    panel.className = 'timeline-root';

    const header = this.#document.createElement('div');
    header.className = 'timeline-header';

    const titleGroup = this.#document.createElement('div');
    titleGroup.className = 'timeline-title-group';

    const title = this.#document.createElement('span');
    title.setAttribute('data-role', 'timeline-title');
    title.className = 'timeline-title';
    title.textContent = 'Unified Timeline';

    const stepCountEl = this.#document.createElement('span');
    stepCountEl.setAttribute('data-role', 'timeline-step-count');
    stepCountEl.className = 'timeline-count-badge';
    stepCountEl.textContent = '0 steps';

    titleGroup.appendChild(title);
    titleGroup.appendChild(stepCountEl);

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

    header.appendChild(titleGroup);
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
    this.#stepCountEl = stepCountEl;
    this.#filterEl = filterEl;
    this.#railEl = railEl;
    this.#stepsEl = stepsEl;
    this.#runningEl = runningEl;
    this.#syncOpen();
  }

  closePopover() {
    if (!this.#open) {
      return;
    }
    this.#open = false;
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
    const mainAgent = availableAgents.find((a) => a.agentId === 'main') ?? {
      agentId: 'main',
      label: 'Main Agent',
    };
    const subAgents = availableAgents.filter((a) => a.agentId !== 'main' && a.agentId !== 'all');
    const dropdownAgents = [
      { agentId: 'all', label: 'All Agents' },
      { agentId: 'main', label: mainAgent.agentLabel ?? mainAgent.label ?? 'Main Agent' },
      ...subAgents.map((agent) => ({
        agentId: agent.agentId,
        label: agent.agentLabel ?? agent.label ?? agent.agentId,
      })),
    ];

    if (!dropdownAgents.some((a) => a.agentId === this.#selectedAgentId)) {
      this.#selectedAgentId = 'all';
    }

    this.#filterEl.innerHTML = '';
    for (const agent of dropdownAgents) {
      const opt = this.#document.createElement('option');
      opt.value = agent.agentId;
      opt.setAttribute('value', agent.agentId);
      opt.textContent = agent.label;
      if (agent.agentId === this.#selectedAgentId) {
        opt.selected = true;
      }
      this.#filterEl.appendChild(opt);
    }
    this.#filterEl.value = this.#selectedAgentId;

    if (this.#selectedTurnId && !turns.some((t) => t.turnId === this.#selectedTurnId)) {
      this.#selectedTurnId = null;
    }

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
    const latestTurnId = turns.at(-1)?.turnId ?? null;

    this.#runningEl.innerHTML = '';
    this.#stepsEl.innerHTML = '';

    let totalVisibleSteps = 0;

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

      if (filteredEntries.length === 0) {
        continue;
      }

      totalVisibleSteps += filteredEntries.length;

      const defaultCollapsed = turn.turnId !== latestTurnId && this.#selectedTurnId !== turn.turnId;
      const isCollapsed = this.#collapsedTurns.has(turn.turnId)
        ? this.#collapsedTurns.get(turn.turnId)
        : defaultCollapsed;

      const card = this.#document.createElement('div');
      card.className = 'turn-card';
      card.setAttribute('data-role', 'turn-card');
      card.setAttribute('data-turn-id', turn.turnId);
      card.setAttribute('data-collapsed', isCollapsed ? 'true' : 'false');

      const cardHeader = this.#document.createElement('button');
      cardHeader.className = 'turn-card-header';
      cardHeader.setAttribute('data-role', 'turn-card-toggle');
      cardHeader.textContent = `Turn ${turn.turnIndex} · ${filteredEntries.length} ${filteredEntries.length === 1 ? 'step' : 'steps'} ${isCollapsed ? '▾' : '▴'}`;
      cardHeader.addEventListener('click', () => {
        this.#collapsedTurns.set(turn.turnId, !isCollapsed);
        this.#render();
      });

      const cardSteps = this.#document.createElement('div');
      cardSteps.className = 'turn-card-steps';

      for (const entry of filteredEntries) {
        const stepEl = this.#document.createElement('div');
        stepEl.className = 'timeline-step';
        stepEl.setAttribute('data-role', 'timeline-step');
        stepEl.setAttribute('data-agent-id', entry.agentId);
        stepEl.setAttribute('data-turn-id', turn.turnId);
        stepEl.setAttribute('data-depth', String(entry.depth ?? 0));

        const roleEl = this.#document.createElement('span');
        roleEl.className = 'step-role-pill';
        roleEl.textContent = resolveRoleLabel(entry);

        const summaryEl = this.#document.createElement('span');
        summaryEl.className = 'step-summary';
        summaryEl.textContent = entry.summary ?? '';

        const timeEl = this.#document.createElement('span');
        timeEl.className = 'step-time';
        timeEl.textContent = formatRelativeTime(entry, turn.startMs);

        stepEl.appendChild(roleEl);
        stepEl.appendChild(summaryEl);
        stepEl.appendChild(timeEl);
        cardSteps.appendChild(stepEl);
      }

      card.appendChild(cardHeader);
      card.appendChild(cardSteps);
      this.#stepsEl.appendChild(card);
    }

    if (this.#stepCountEl) {
      this.#stepCountEl.textContent = `${totalVisibleSteps} ${totalVisibleSteps === 1 ? 'step' : 'steps'}`;
    }
  }

  unmount() {
    if (this.#shadowRoot) {
      this.#shadowRoot.innerHTML = '';
    }
    this.#shadowRoot = null;
  }
}

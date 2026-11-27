import test from 'node:test';
import assert from 'node:assert/strict';

import { ContextBreakdownSurface } from '../src/overlay/surfaces/context-breakdown.mjs';
import { UnifiedTimelineSurface } from '../src/overlay/surfaces/unified-timeline.mjs';
import { OverviewPanelSurface } from '../src/overlay/surfaces/overview-panel.mjs';
import { installOverlayRuntime, DEFAULT_SURFACE_ANCHORS } from '../src/overlay/index.mjs';

export function createMockDom() {
  const observers = [];

  class MockEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.bubbles = Boolean(init.bubbles);
      this.cancelable = Boolean(init.cancelable);
      this.defaultPrevented = false;
      this.target = null;
      this.currentTarget = null;
    }

    preventDefault() {
      if (this.cancelable) {
        this.defaultPrevented = true;
      }
    }
  }

  class MockClassList {
    #set = new Set();
    add(...tokens) {
      for (const t of tokens) this.#set.add(t);
    }
    remove(...tokens) {
      for (const t of tokens) this.#set.delete(t);
    }
    contains(token) {
      return this.#set.has(token);
    }
  }

  class MockElement {
    constructor(tagName, ownerDocument) {
      this.tagName = String(tagName).toUpperCase();
      this.ownerDocument = ownerDocument;
      this.children = [];
      this.parentNode = null;
      this.attributes = new Map();
      this.dataset = {};
      this.style = {};
      this.classList = new MockClassList();
      this.shadowRoot = null;
      this._listeners = new Map();
      this._innerHTML = '';
      this._textContent = '';
      this.id = '';
      this.className = '';
      this.value = '';
      this.checked = false;
      this.href = '';
      this.target = '';
      this.rel = '';
      this.type = '';
      this.disabled = false;
    }

    get isConnected() {
      let cur = this;
      while (cur) {
        if (cur === this.ownerDocument.documentElement || cur === this.ownerDocument.body) {
          return true;
        }
        cur = cur.parentNode;
      }
      return false;
    }

    set innerHTML(val) {
      this._innerHTML = String(val);
      this.children = [];
    }

    get innerHTML() {
      return this._innerHTML;
    }

    set textContent(val) {
      this._textContent = String(val);
    }

    get textContent() {
      if (this._textContent) {
        return this._textContent;
      }
      return this.children.map((c) => c.textContent).join('');
    }

    setAttribute(name, value) {
      const str = String(value);
      this.attributes.set(name, str);
      if (name === 'id') this.id = str;
      if (name === 'class') this.className = str;
      if (name.startsWith('data-')) {
        const camel = name
          .slice(5)
          .replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
        this.dataset[camel] = str;
      }
    }

    getAttribute(name) {
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    appendChild(child) {
      if (child.parentNode) {
        child.parentNode.removeChild(child);
      }
      child.parentNode = this;
      this.children.push(child);
      return child;
    }

    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx !== -1) {
        this.children.splice(idx, 1);
        child.parentNode = null;
      }
      return child;
    }

    remove() {
      if (this.parentNode) {
        this.parentNode.removeChild(this);
      }
    }

    attachShadow({ mode }) {
      const root = new MockShadowRoot(this, mode, this.ownerDocument);
      this.shadowRoot = root;
      return root;
    }

    addEventListener(type, fn) {
      if (!this._listeners.has(type)) {
        this._listeners.set(type, []);
      }
      this._listeners.get(type).push(fn);
    }

    removeEventListener(type, fn) {
      const list = this._listeners.get(type);
      if (!list) return;
      const idx = list.indexOf(fn);
      if (idx !== -1) list.splice(idx, 1);
    }

    dispatchEvent(event) {
      event.target = event.target ?? this;
      event.currentTarget = this;
      const list = this._listeners.get(event.type) ?? [];
      for (const fn of [...list]) {
        fn.call(this, event);
      }
      return !event.defaultPrevented;
    }

    matches(selector) {
      return matchesSimpleSelector(this, selector);
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null;
    }

    querySelectorAll(selector) {
      const results = [];
      const visit = (node) => {
        for (const child of node.children) {
          if (matchesSimpleSelector(child, selector)) {
            results.push(child);
          }
          visit(child);
        }
      };
      visit(this);
      return results;
    }
  }

  class MockShadowRoot extends MockElement {
    constructor(host, mode, ownerDocument) {
      super('#shadow-root', ownerDocument);
      this.host = host;
      this.mode = mode;
    }
  }

  function matchesSimpleSelector(el, selectorList) {
    const selectors = selectorList.split(',').map((s) => s.trim()).filter(Boolean);
    return selectors.some((sel) => {
      if (sel.startsWith('#')) {
        return el.id === sel.slice(1);
      }
      if (sel.startsWith('.')) {
        return el.className.split(/\s+/).includes(sel.slice(1));
      }
      const attrMatch = /^\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]$/.exec(sel);
      if (attrMatch) {
        const [, attr, val] = attrMatch;
        const actual = el.getAttribute(attr);
        if (val === undefined) return actual !== null;
        return actual === val;
      }
      return el.tagName.toLowerCase() === sel.toLowerCase();
    });
  }

  class MockMutationObserver {
    #callback;
    #connected = false;

    constructor(callback) {
      this.#callback = callback;
      observers.push(this);
    }

    observe() {
      this.#connected = true;
    }

    disconnect() {
      this.#connected = false;
    }

    trigger() {
      if (this.#connected) {
        this.#callback([], this);
      }
    }
  }

  const document = {
    documentElement: null,
    body: null,
    createElement(tag) {
      return new MockElement(tag, document);
    },
    querySelector(selector) {
      return document.documentElement.querySelector(selector);
    },
    querySelectorAll(selector) {
      return document.documentElement.querySelectorAll(selector);
    },
  };
  document.documentElement = new MockElement('html', document);
  document.body = new MockElement('body', document);
  document.documentElement.appendChild(document.body);

  return {
    document,
    MockMutationObserver,
    MockEvent,
    triggerMutations: () => observers.forEach((o) => o.trigger()),
  };
}

test('ContextBreakdownSurface renders all 7 exact categories and switches between main agent and subagents', () => {
  const { document, MockEvent } = createMockDom();
  const host = document.createElement('div');
  document.body.appendChild(host);
  const shadowRoot = host.attachShadow({ mode: 'open' });

  const surface = new ContextBreakdownSurface({ document });
  surface.mount(shadowRoot);

  surface.update({
    contextBreakdown: {
      totalInputTokens: 1000,
      categories: {
        'User Messages': 100,
        'Assistant & Thinking': 200,
        'Tool Calls': 150,
        'Tool Results': 250,
        'Subagent Notifications': 50,
        Checkpoints: 50,
        'System & Tools Overhead': 200,
      },
    },
    contextBreakdowns: {
      main: {
        label: 'Main Agent',
        totalInputTokens: 1000,
        categories: {
          'User Messages': 100,
          'Assistant & Thinking': 200,
          'Tool Calls': 150,
          'Tool Results': 250,
          'Subagent Notifications': 50,
          Checkpoints: 50,
          'System & Tools Overhead': 200,
        },
      },
      'sub-1': {
        label: 'Researcher (sub-1)',
        totalInputTokens: 400,
        categories: {
          'User Messages': 40,
          'Assistant & Thinking': 80,
          'Tool Calls': 60,
          'Tool Results': 120,
          'Subagent Notifications': 0,
          Checkpoints: 0,
          'System & Tools Overhead': 100,
        },
      },
    },
  });

  const rows = shadowRoot.querySelectorAll('[data-role="breakdown-row"]');
  assert.equal(rows.length, 7);
  assert.deepEqual(
    rows.map((r) => r.getAttribute('data-category')),
    [
      'User Messages',
      'Assistant & Thinking',
      'Tool Calls',
      'Tool Results',
      'Subagent Notifications',
      'Checkpoints',
      'System & Tools Overhead',
    ],
  );
  assert.match(shadowRoot.querySelector('[data-role="breakdown-total"]').textContent, /1000/);

  const switcher = shadowRoot.querySelector('[data-role="agent-switcher"]');
  assert.ok(switcher);
  const options = switcher.querySelectorAll('option');
  assert.equal(options.length, 2);

  switcher.value = 'sub-1';
  switcher.dispatchEvent(new MockEvent('change'));

  assert.match(shadowRoot.querySelector('[data-role="breakdown-total"]').textContent, /400/);
  const subToolResults = shadowRoot.querySelector('[data-category="Tool Results"]');
  assert.match(subToolResults.textContent, /120/);
  assert.match(subToolResults.textContent, /30%/);
});

test('UnifiedTimelineSurface renders turn rail, per-agent filter, merged steps, and inline running-task expansion', () => {
  const { document, MockEvent } = createMockDom();
  const host = document.createElement('div');
  document.body.appendChild(host);
  const shadowRoot = host.attachShadow({ mode: 'open' });

  const actions = [];
  const surface = new UnifiedTimelineSurface({
    document,
    dispatchAction: (type, payload) => actions.push({ type, payload }),
  });
  surface.mount(shadowRoot);

  surface.update({
    timeline: {
      agentFilter: 'all',
      availableAgents: [
        { agentId: 'main', agentKind: 'main', agentLabel: 'Main Agent' },
        { agentId: 'sub-1', agentKind: 'subagent', agentLabel: 'Code Reviewer' },
      ],
      turns: [
        {
          turnId: 'turn-1',
          turnIndex: 1,
          status: 'completed',
          entries: [
            {
              id: 'e1',
              agentId: 'main',
              agentKind: 'main',
              agentLabel: 'Main Agent',
              depth: 0,
              type: 'USER_INPUT',
              summary: 'Review changes',
            },
          ],
          runningTasks: [],
        },
        {
          turnId: 'turn-2',
          turnIndex: 2,
          status: 'active',
          entries: [
            {
              id: 'e2',
              agentId: 'sub-1',
              agentKind: 'subagent',
              agentLabel: 'Code Reviewer',
              depth: 1,
              type: 'PLANNER_RESPONSE',
              summary: 'Checking ADR compliance',
            },
          ],
          runningTasks: [
            {
              agentId: 'sub-1',
              kind: 'subagent',
              label: 'Code Reviewer',
              status: 'running',
              depth: 1,
              elapsedMs: 1200,
              latestStepSummary: 'Reading src/app.mjs',
              eventCount: 3,
              expandable: true,
            },
          ],
        },
      ],
    },
  });

  const turnItems = shadowRoot.querySelectorAll('[data-role="turn-rail-item"]');
  assert.equal(turnItems.length, 2);

  let steps = shadowRoot.querySelectorAll('[data-role="timeline-step"]');
  assert.equal(steps.length, 2);

  // Expand inline running task
  const taskToggle = shadowRoot.querySelector('[data-role="running-task-toggle"]');
  const taskDetails = shadowRoot.querySelector('[data-role="running-task-details"]');
  assert.equal(taskDetails.getAttribute('aria-hidden'), 'true');
  taskToggle.dispatchEvent(new MockEvent('click'));
  assert.equal(shadowRoot.querySelector('[data-role="running-task-details"]').getAttribute('aria-hidden'), 'false');
  assert.match(shadowRoot.querySelector('[data-role="running-task-details"]').textContent, /Reading src\/app\.mjs/);

  // Filter by sub-1
  const filterSelect = shadowRoot.querySelector('[data-role="agent-filter"]');
  filterSelect.value = 'sub-1';
  filterSelect.dispatchEvent(new MockEvent('change'));

  steps = shadowRoot.querySelectorAll('[data-role="timeline-step"]');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].getAttribute('data-agent-id'), 'sub-1');
  assert.deepEqual(actions[0], { type: 'filterTimeline', payload: { agentId: 'sub-1' } });

  // Turn rail click focuses turn-1
  turnItems[0].dispatchEvent(new MockEvent('click'));
  assert.equal(shadowRoot.querySelectorAll('[data-role="timeline-step"]').length, 0);
});

test('OverviewPanelSurface persists collapsed state via updateConfig and renders stage, step durations, and local usage vs active quota', () => {
  const { document, MockEvent } = createMockDom();
  const host = document.createElement('div');
  document.body.appendChild(host);
  const shadowRoot = host.attachShadow({ mode: 'open' });

  const actions = [];
  const surface = new OverviewPanelSurface({
    document,
    dispatchAction: (type, payload) => actions.push({ type, payload }),
  });
  surface.mount(shadowRoot);

  // Mode 1: local cumulative usage (QuotaProvider inactive)
  surface.update({
    config: { overviewOpen: false },
    stageProgress: { stageLabel: 'Running 2 tools (read_file, rg)', mode: 'tool_calls', toolCount: 2 },
    overview: {
      stepDurations: [
        { label: 'Step 1 (USER_INPUT -> PLANNER_RESPONSE)', durationMs: 1450 },
        { label: 'Step 2 (Tool Result)', durationMs: 320 },
      ],
      perModel: {
        'gemini-4-hydrogen': { steps: 2, inputTokens: 1200, outputTokens: 300, costUsd: 0.0045 },
      },
    },
    quota: { available: false, models: null },
  });

  const panel = shadowRoot.querySelector('[data-role="overview-panel"]');
  assert.equal(panel.getAttribute('data-collapsed'), 'true');
  assert.match(shadowRoot.querySelector('[data-role="overview-stage"]').textContent, /Running 2 tools/);
  assert.equal(shadowRoot.querySelectorAll('[data-role="step-duration-row"]').length, 2);
  const usageRows = shadowRoot.querySelectorAll('[data-role="model-usage-row"]');
  assert.equal(usageRows.length, 1);
  assert.match(usageRows[0].textContent, /gemini-4-hydrogen/);
  assert.match(usageRows[0].textContent, /\$0\.0045/);
  assert.equal(shadowRoot.querySelectorAll('[data-role="model-quota-row"]').length, 0);

  // Toggle open -> dispatches updateConfig({ overviewOpen: true })
  const toggleBtn = shadowRoot.querySelector('[data-role="overview-toggle"]');
  toggleBtn.dispatchEvent(new MockEvent('click'));
  assert.equal(panel.getAttribute('data-collapsed'), 'false');
  assert.deepEqual(actions[0], { type: 'updateConfig', payload: { overviewOpen: true } });

  // Mode 2: active QuotaProvider
  surface.update({
    config: { overviewOpen: true },
    stageProgress: { stageLabel: 'Completed in 1.8s', mode: 'collapsed' },
    overview: {
      stepDurations: [],
      perModel: {
        'gemini-4-hydrogen': { steps: 2, inputTokens: 1200, outputTokens: 300, costUsd: 0.0045 },
      },
    },
    quota: {
      available: true,
      models: {
        'gemini-4-hydrogen': { remainingPercent: 82, label: '82% remaining' },
      },
    },
  });

  const quotaRows = shadowRoot.querySelectorAll('[data-role="model-quota-row"]');
  assert.equal(quotaRows.length, 1);
  assert.match(quotaRows[0].textContent, /82%/);
});

test('installOverlayRuntime registers all 6 surfaces and silently skips missing anchors with console.warn (ADR-0004)', () => {
  const { document, MockMutationObserver } = createMockDom();
  const warnings = [];
  const logger = { warn: (msg) => warnings.push(msg) };

  // Only provide anchors for status-capsule and context-breakdown; omit unified-timeline, overview-panel, etc.
  const capsuleAnchor = document.createElement('div');
  capsuleAnchor.setAttribute('data-testid', 'composer-toolbar');
  document.body.appendChild(capsuleAnchor);

  const breakdownAnchor = document.createElement('div');
  breakdownAnchor.setAttribute('data-testid', 'context-breakdown-anchor');
  document.body.appendChild(breakdownAnchor);

  assert.ok(Array.isArray(DEFAULT_SURFACE_ANCHORS['context-breakdown']));
  assert.ok(Array.isArray(DEFAULT_SURFACE_ANCHORS['unified-timeline']));
  assert.ok(Array.isArray(DEFAULT_SURFACE_ANCHORS['overview-panel']));

  const runtime = installOverlayRuntime({
    document,
    MutationObserver: MockMutationObserver,
    globalTarget: {},
    logger,
  });

  assert.ok(runtime.getSurface('context-breakdown'));
  assert.ok(runtime.getSurface('unified-timeline'));
  assert.ok(runtime.getSurface('overview-panel'));
  assert.equal(runtime.registry.get('context-breakdown').isMounted, true);
  assert.equal(runtime.registry.get('unified-timeline').isMounted, false);
  assert.equal(runtime.registry.get('overview-panel').isMounted, false);

  // Silent skip warnings emitted, no floating fallback appended to document.body
  assert.ok(warnings.some((w) => String(w).includes('unified-timeline')));
  assert.ok(warnings.some((w) => String(w).includes('overview-panel')));
  assert.equal(
    document.body.children.some((c) => c.getAttribute('data-t3-agy-surface') === 'overview-panel'),
    false,
  );

  runtime.destroy();
});

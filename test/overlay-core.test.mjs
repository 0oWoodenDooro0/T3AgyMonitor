import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AnchorAdapter,
  AnchorRegistry,
} from '../src/overlay/anchor-adapter.mjs';
import { StreamObserver } from '../src/overlay/stream-observer.mjs';
import {
  StatusCapsuleSurface,
  clampCapsuleSlots,
} from '../src/overlay/surfaces/status-capsule.mjs';
import {
  ComposerRingSurface,
  clampPercent,
} from '../src/overlay/surfaces/composer-ring.mjs';
import { StageProgressSurface } from '../src/overlay/surfaces/stage-progress.mjs';
import { OverlayRuntime } from '../src/overlay/runtime.mjs';
import { installOverlayRuntime } from '../src/overlay/index.mjs';

/**
 * Lightweight mock DOM + Shadow DOM harness for pure Node.js testing.
 */
function createMockDom() {
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

    trigger(records = [{ type: 'childList' }]) {
      if (this.#connected) {
        this.#callback(records, this);
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
      return document.body.querySelector(selector);
    },
    querySelectorAll(selector) {
      return document.body.querySelectorAll(selector);
    },
  };
  document.documentElement = new MockElement('html', document);
  document.body = new MockElement('body', document);
  document.documentElement.appendChild(document.body);

  return {
    document,
    MutationObserver: MockMutationObserver,
    MockEvent,
    triggerMutations() {
      for (const obs of observers) {
        obs.trigger();
      }
    },
  };
}

test('AnchorAdapter mounts inside Shadow DOM using resilient selector list and re-mounts on MutationObserver', () => {
  const dom = createMockDom();
  const warnings = [];
  const logger = { warn: (entry) => warnings.push(entry) };

  const anchorEl = dom.document.createElement('div');
  anchorEl.setAttribute('data-testid', 'composer-bar');
  dom.document.body.appendChild(anchorEl);

  const adapter = new AnchorAdapter({
    surfaceId: 'status-capsule',
    selectors: ['[data-testid="missing-primary"]', '[data-testid="composer-bar"]'],
    hostTag: 't3-agy-status-capsule',
    document: dom.document,
    logger,
  });

  const mounted = adapter.mount();
  assert.ok(mounted);
  assert.equal(mounted.shadowRoot.mode, 'open');
  assert.equal(anchorEl.children.length, 1);
  assert.equal(warnings.length, 0);

  // Simulate Host App re-render removing the host element
  anchorEl.removeChild(mounted.host);
  assert.equal(anchorEl.children.length, 0);

  const registry = new AnchorRegistry({
    document: dom.document,
    MutationObserver: dom.MutationObserver,
    logger,
  });
  registry.register(adapter);
  registry.observe();
  dom.triggerMutations();

  assert.equal(anchorEl.children.length, 1);
  registry.disconnect();
});

test('AnchorAdapter silently skips missing anchor with console.warn and never renders a floating fallback', () => {
  const dom = createMockDom();
  const warnings = [];
  const logger = { warn: (entry) => warnings.push(entry) };

  const adapter = new AnchorAdapter({
    surfaceId: 'composer-ring',
    selectors: ['[data-testid="non-existent-composer"]'],
    document: dom.document,
    logger,
  });

  const mounted = adapter.mount();
  assert.equal(mounted, null);
  assert.equal(dom.document.body.children.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(JSON.stringify(warnings[0]), /composer-ring/);
});

test('StreamObserver measures live TTFT and tok/s and reconciles with authoritative PLANNER_RESPONSE', () => {
  const observer = new StreamObserver();
  observer.startTurn({ turnId: 'turn-1', nowMs: 1000 });
  observer.onChunk({ tokens: 10, nowMs: 1350 }); // TTFT = 350ms
  observer.onChunk({ tokens: 30, nowMs: 2350 }); // 40 tokens over 1.0s since first token = 40 tok/s

  const live = observer.getMetrics();
  assert.equal(live.source, 'live');
  assert.equal(live.isStreaming, true);
  assert.equal(live.ttftMs, 350);
  assert.equal(live.ttftDisplay, '0.35s');
  assert.equal(live.tokPerSec, 40);
  assert.equal(live.outputTokens, 40);

  observer.reconcile({
    turnId: 'turn-1',
    outputTokens: 60,
    durationMs: 1500,
  });

  const reconciled = observer.getMetrics();
  assert.equal(reconciled.isStreaming, false);
  assert.equal(reconciled.source, 'live');
  assert.equal(reconciled.ttftMs, 350);
  assert.equal(reconciled.outputTokens, 60);
  assert.equal(reconciled.tokPerSec, 40);
});

test('StreamObserver falls back to transcript averages and "—" for TTFT on history or mid-turn attach', () => {
  const observer = new StreamObserver();
  observer.applyTranscriptFallback({
    turnId: 'turn-hist',
    outputTokens: 120,
    tokPerSec: 48.5,
  });

  const fallback = observer.getMetrics();
  assert.equal(fallback.source, 'transcript');
  assert.equal(fallback.isStreaming, false);
  assert.equal(fallback.ttftMs, null);
  assert.equal(fallback.ttftDisplay, '—');
  assert.equal(fallback.tokPerSec, 48.5);
  assert.equal(fallback.tokPerSecDisplay, '48.5 tok/s');

  observer.applyTranscriptFallback({
    turnId: 'turn-zero',
    outputTokens: 10,
    tokPerSec: null,
  });
  assert.equal(observer.getMetrics().tokPerSec, null);
  assert.equal(observer.getMetrics().tokPerSecDisplay, '—');
});

test('StatusCapsuleSurface clamps slots [1, 5], toggles hover/popover, renders update info, and dispatches right-click refresh', () => {
  const dom = createMockDom();
  const host = dom.document.createElement('t3-agy-status-capsule');
  const shadowRoot = host.attachShadow({ mode: 'open' });
  const dispatched = [];

  assert.deepEqual(clampCapsuleSlots([]), ['model']);
  assert.equal(clampCapsuleSlots(['a', 'b', 'c', 'd', 'e', 'f', 'g']).length, 5);

  const capsule = new StatusCapsuleSurface({
    document: dom.document,
    dispatchAction: (type, payload) => dispatched.push({ type, payload }),
  });
  capsule.mount(shadowRoot);

  capsule.update({
    config: {
      capsuleSlots: ['model', 'context', 'cost', 'speed', 'cache', 'extra-ignored'],
      ringMode: 'soft_budget_usd',
      softBudgetUsd: 10,
      softBudgetTokens: 0,
      updateCheckMode: 'auto',
    },
    metrics: {
      model: 'gemini-4-hydrogen',
      contextPercent: 42,
      costUsd: 0.12,
      tokPerSecDisplay: '38.2 tok/s',
      ttftDisplay: '0.40s',
      cacheHitRate: 0.75,
    },
    update: {
      hasUpdate: true,
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
      releaseUrl: 'https://github.com/0oWoodenDooro0/T3AgyMonitor/releases/tag/v0.2.0',
      updateCommand: 'npm update -g t3-agy-monitor',
      mode: 'auto',
    },
  });

  const renderedSlots = shadowRoot.querySelectorAll('[data-role="capsule-slot"]');
  assert.equal(renderedSlots.length, 5);

  // Hover summary
  const bar = shadowRoot.querySelector('[data-role="capsule-bar"]');
  const hoverSummary = shadowRoot.querySelector('[data-role="hover-summary"]');
  assert.equal(hoverSummary.getAttribute('aria-hidden'), 'true');
  bar.dispatchEvent(new dom.MockEvent('mouseenter'));
  assert.equal(hoverSummary.getAttribute('aria-hidden'), 'false');
  bar.dispatchEvent(new dom.MockEvent('mouseleave'));
  assert.equal(hoverSummary.getAttribute('aria-hidden'), 'true');

  // Click popover & update badge / release notes / copyable command
  const popover = shadowRoot.querySelector('[data-role="popover"]');
  assert.equal(popover.getAttribute('aria-hidden'), 'true');
  bar.dispatchEvent(new dom.MockEvent('click'));
  assert.equal(popover.getAttribute('aria-hidden'), 'false');

  const releaseLink = shadowRoot.querySelector('[data-role="release-notes-link"]');
  assert.equal(releaseLink.href, 'https://github.com/0oWoodenDooro0/T3AgyMonitor/releases/tag/v0.2.0');
  const updateCmd = shadowRoot.querySelector('[data-role="update-command"]');
  assert.equal(updateCmd.value, 'npm update -g t3-agy-monitor');

  // Right-click refresh
  const ctxEvent = new dom.MockEvent('contextmenu', { cancelable: true });
  bar.dispatchEvent(ctxEvent);
  assert.equal(ctxEvent.defaultPrevented, true);
  assert.deepEqual(dispatched[0], {
    type: 'refresh',
    payload: { surface: 'status-capsule' },
  });
});

test('ComposerRingSurface clamps percentage to [0, 100] across context window, soft budget, and quota modes', () => {
  const dom = createMockDom();
  const host = dom.document.createElement('t3-agy-composer-ring');
  const shadowRoot = host.attachShadow({ mode: 'open' });

  assert.equal(clampPercent(-12), 0);
  assert.equal(clampPercent(145.6), 100);
  assert.equal(clampPercent(Number.NaN), 0);

  const ring = new ComposerRingSurface({ document: dom.document });
  ring.mount(shadowRoot);

  ring.update({
    composerRing: {
      mode: 'context_window',
      percent: 125,
      label: 'Context Window',
    },
  });

  const fill = shadowRoot.querySelector('[data-role="ring-fill"]');
  const label = shadowRoot.querySelector('[data-role="ring-label"]');
  assert.equal(fill.getAttribute('aria-valuenow'), '100');
  assert.equal(fill.getAttribute('data-percent'), '100');
  assert.match(label.textContent, /100%/);

  ring.update({
    composerRing: {
      mode: 'soft_budget_usd',
      percent: -5,
      label: 'Soft Budget ($)',
    },
  });
  assert.equal(fill.getAttribute('aria-valuenow'), '0');
  assert.match(label.textContent, /0%/);
});

test('StageProgressSurface shows consecutive tool-call progress and auto-collapses on turn completion', () => {
  const dom = createMockDom();
  const host = dom.document.createElement('t3-agy-stage-progress');
  const shadowRoot = host.attachShadow({ mode: 'open' });

  const stage = new StageProgressSurface({ document: dom.document });
  stage.mount(shadowRoot);

  stage.update({
    stageProgress: {
      mode: 'active',
      collapsed: false,
      stageLabel: 'Running 3 tool calls (latest: read_file)',
      toolCount: 3,
      tools: ['grep', 'list_dir', 'read_file'],
      elapsedMs: 1200,
      durationMs: null,
    },
  });

  const bar = shadowRoot.querySelector('[data-role="stage-bar"]');
  const label = shadowRoot.querySelector('[data-role="stage-label"]');
  assert.equal(bar.getAttribute('data-collapsed'), 'false');
  assert.equal(bar.getAttribute('data-mode'), 'active');
  assert.equal(label.textContent, 'Running 3 tool calls (latest: read_file)');

  stage.update({
    stageProgress: {
      mode: 'collapsed',
      collapsed: true,
      stageLabel: 'Completed in 2.4s (3 tool calls)',
      toolCount: 3,
      tools: ['grep', 'list_dir', 'read_file'],
      elapsedMs: 2400,
      durationMs: 2400,
    },
  });

  assert.equal(bar.getAttribute('data-collapsed'), 'true');
  assert.equal(bar.getAttribute('data-mode'), 'collapsed');
  assert.equal(label.textContent, 'Completed in 2.4s (3 tool calls)');
});

test('OverlayRuntime mounts pluggable surfaces, skips missing anchors, receives state, and dispatches actions over CDP binding', () => {
  const dom = createMockDom();
  const warnings = [];
  const logger = { warn: (entry) => warnings.push(entry) };
  const bindingCalls = [];
  const globalTarget = {
    __t3AgyMonitorSend: (raw) => bindingCalls.push(JSON.parse(raw)),
  };

  // Mount composer-bar & turn-stage-anchor, omit composer-input-container (silent skip)
  const composerBar = dom.document.createElement('div');
  composerBar.setAttribute('data-testid', 'composer-bar');
  const stageAnchor = dom.document.createElement('div');
  stageAnchor.setAttribute('data-testid', 'turn-stage-anchor');
  const customAnchor = dom.document.createElement('div');
  customAnchor.setAttribute('data-testid', 'custom-panel-anchor');
  dom.document.body.appendChild(composerBar);
  dom.document.body.appendChild(stageAnchor);
  dom.document.body.appendChild(customAnchor);

  const customUpdates = [];
  const runtime = installOverlayRuntime({
    document: dom.document,
    MutationObserver: dom.MutationObserver,
    globalTarget,
    logger,
    extraSurfaces: [
      {
        id: 'custom-overview',
        selectors: ['[data-testid="custom-panel-anchor"]'],
        createSurface: ({ document: doc, dispatchAction }) => ({
          mount(shadowRoot) {
            const el = doc.createElement('div');
            el.setAttribute('data-role', 'custom-root');
            el.addEventListener('click', () => dispatchAction('toggleOverview', { open: true }));
            shadowRoot.appendChild(el);
          },
          update(snapshot) {
            customUpdates.push(snapshot);
          },
          unmount() {},
        }),
      },
    ],
  });

  assert.ok(runtime instanceof OverlayRuntime);
  assert.equal(composerBar.children.length, 1);
  assert.equal(stageAnchor.children.length, 1);
  assert.equal(customAnchor.children.length, 1);
  assert.equal(warnings.length, 1); // composer-ring missing -> silent skip + warn

  // Push state via global receiver (__t3AgyMonitorReceive)
  globalTarget.__t3AgyMonitorReceive({
    config: { capsuleSlots: ['model', 'speed'] },
    metrics: { model: 'gemini-4-hydrogen' },
    transcriptMetrics: { tokPerSec: 52.0, outputTokens: 100 },
    stageProgress: { mode: 'active', collapsed: false, stageLabel: 'Running 1 tool call', toolCount: 1 },
  });

  assert.equal(customUpdates.length, 1);
  assert.equal(customUpdates[0].metrics.ttftDisplay, '—');
  assert.equal(customUpdates[0].metrics.tokPerSecDisplay, '52.0 tok/s');

  // Dispatch action via CDP binding
  runtime.dispatchAction('refresh', { reason: 'manual' });
  assert.deepEqual(bindingCalls[0], {
    type: 'refresh',
    payload: { reason: 'manual' },
  });

  runtime.destroy();
});

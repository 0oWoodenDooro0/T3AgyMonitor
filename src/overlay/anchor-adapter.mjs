export const DEFAULT_SURFACE_ANCHORS = Object.freeze({
  'status-capsule': Object.freeze([
    '[data-testid="composer-toolbar"]',
    '[data-testid="composer-bar"]',
    '.composer-toolbar',
    'footer[data-slot="composer"]',
  ]),
  'composer-ring': Object.freeze([
    '[data-testid="composer-input-container"]',
    '[data-testid="composer-editor"]',
    '.composer-input-wrapper',
    'form[data-slot="composer"]',
  ]),
  'stage-progress': Object.freeze([
    '[data-testid="turn-stage-anchor"]',
    '[data-testid="active-turn-footer"]',
    '[data-testid="message-list"]',
    '.thread-messages',
  ]),
});

/**
 * Mounts a single UI surface inside a native Host App DOM anchor using Shadow DOM
 * isolation. Silently skips rendering and logs a warning if no selector matches.
 */
export class AnchorAdapter {
  #surfaceId;
  #selectors;
  #hostTag;
  #position;
  #document;
  #logger;
  #host = null;
  #shadowRoot = null;
  #anchor = null;
  #warnedMissing = false;

  constructor({
    surfaceId,
    selectors = [],
    hostTag = `t3-agy-${surfaceId}`,
    position = 'append',
    document = globalThis.document,
    logger = console,
  } = {}) {
    if (!surfaceId || typeof surfaceId !== 'string') {
      throw new Error('AnchorAdapter requires a non-empty surfaceId');
    }
    this.#surfaceId = surfaceId;
    this.#selectors = Array.isArray(selectors) ? selectors.filter(Boolean) : [];
    this.#hostTag = hostTag;
    this.#position = position;
    this.#document = document;
    this.#logger = logger;
  }

  get surfaceId() {
    return this.#surfaceId;
  }

  get host() {
    return this.#host;
  }

  get shadowRoot() {
    return this.#shadowRoot;
  }

  get anchor() {
    return this.#anchor;
  }

  get isMounted() {
    return Boolean(this.#host && this.#host.isConnected && this.#shadowRoot);
  }

  resolveAnchor() {
    if (!this.#document || typeof this.#document.querySelector !== 'function') {
      return null;
    }
    for (const selector of this.#selectors) {
      try {
        const found = this.#document.querySelector(selector);
        if (found) {
          return found;
        }
      } catch {
        // Ignore invalid CSS selectors in resilient fallback lists
      }
    }
    return null;
  }

  mount() {
    if (this.isMounted) {
      return { host: this.#host, shadowRoot: this.#shadowRoot, anchor: this.#anchor };
    }

    const anchor = this.resolveAnchor();
    if (!anchor) {
      this.#host = null;
      this.#shadowRoot = null;
      this.#anchor = null;
      if (!this.#warnedMissing) {
        this.#warnedMissing = true;
        this.#logger.warn(
          `[T3AgyMonitor] Native mount anchor missing for surface "${this.#surfaceId}"; skipping surface (ADR-0004).`,
        );
      }
      return null;
    }

    this.#warnedMissing = false;
    const host = this.#document.createElement(this.#hostTag);
    host.setAttribute('data-t3-agy-surface', this.#surfaceId);
    const shadowRoot = host.attachShadow({ mode: 'open' });

    if (this.#position === 'prepend' && typeof anchor.prepend === 'function') {
      anchor.prepend(host);
    } else {
      anchor.appendChild(host);
    }

    this.#host = host;
    this.#shadowRoot = shadowRoot;
    this.#anchor = anchor;

    return { host, shadowRoot, anchor };
  }

  unmount() {
    if (this.#host && typeof this.#host.remove === 'function') {
      this.#host.remove();
    }
    this.#host = null;
    this.#shadowRoot = null;
    this.#anchor = null;
  }
}

/**
 * Coordinates multiple AnchorAdapters and re-mounts detached surfaces via MutationObserver.
 */
export class AnchorRegistry {
  #adapters = new Map();
  #document;
  #MutationObserverImpl;
  #observer = null;
  #onMount;

  constructor({
    document = globalThis.document,
    MutationObserver = globalThis.MutationObserver,
    onMount = null,
  } = {}) {
    this.#document = document;
    this.#MutationObserverImpl = MutationObserver;
    this.#onMount = onMount;
  }

  register(adapter) {
    this.#adapters.set(adapter.surfaceId, adapter);
    return adapter;
  }

  get(surfaceId) {
    return this.#adapters.get(surfaceId) ?? null;
  }

  list() {
    return [...this.#adapters.values()];
  }

  mountAll() {
    const results = new Map();
    for (const adapter of this.#adapters.values()) {
      const wasMounted = adapter.isMounted;
      const mounted = adapter.mount();
      results.set(adapter.surfaceId, mounted);
      if (!wasMounted && mounted && typeof this.#onMount === 'function') {
        this.#onMount(adapter.surfaceId, mounted);
      }
    }
    return results;
  }

  observe() {
    if (this.#observer || !this.#MutationObserverImpl || !this.#document?.body) {
      return;
    }
    this.#observer = new this.#MutationObserverImpl(() => {
      this.mountAll();
    });
    this.#observer.observe(this.#document.body, {
      childList: true,
      subtree: true,
    });
  }

  disconnect() {
    if (this.#observer) {
      this.#observer.disconnect();
      this.#observer = null;
    }
  }

  unmountAll() {
    this.disconnect();
    for (const adapter of this.#adapters.values()) {
      adapter.unmount();
    }
  }
}

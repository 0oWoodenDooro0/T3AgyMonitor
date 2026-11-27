import { AnchorAdapter, AnchorRegistry } from './anchor-adapter.mjs';
import { DEFAULT_STREAM_SELECTORS, StreamObserver } from './stream-observer.mjs';

export const DEFAULT_BINDING_NAME = '__t3AgyMonitorSend';
export const DEFAULT_STATE_RECEIVER = '__t3AgyMonitorReceive';

/**
 * Extensible browser-side OverlayRuntime coordinating pluggable Shadow DOM
 * surfaces, native AnchorAdapters, StreamObserver metrics, and CDP binding
 * communication.
 */
export class OverlayRuntime {
  #document;
  #MutationObserver;
  #globalTarget;
  #bindingName;
  #stateReceiver;
  #logger;
  #registry;
  #streamObserver;
  #streamSelectors;
  #surfaces = new Map();
  #lastSnapshot = null;

  constructor({
    document = globalThis.document,
    MutationObserver = globalThis.MutationObserver,
    globalTarget = globalThis,
    bindingName = DEFAULT_BINDING_NAME,
    stateReceiver = DEFAULT_STATE_RECEIVER,
    logger = console,
    streamObserver = new StreamObserver(),
    streamSelectors = DEFAULT_STREAM_SELECTORS,
    surfaceDefinitions = [],
  } = {}) {
    this.#document = document;
    this.#MutationObserver = MutationObserver;
    this.#globalTarget = globalTarget;
    this.#bindingName = bindingName;
    this.#stateReceiver = stateReceiver;
    this.#logger = logger;
    this.#streamObserver = streamObserver;
    this.#streamSelectors = streamSelectors;

    this.#registry = new AnchorRegistry({
      document: this.#document,
      MutationObserver,
      onMount: (surfaceId, mounted) => {
        const entry = this.#surfaces.get(surfaceId);
        if (!entry || !mounted?.shadowRoot) {
          return;
        }
        entry.instance.mount(mounted.shadowRoot);
        if (this.#lastSnapshot) {
          entry.instance.update(this.#lastSnapshot);
        }
      },
    });

    for (const def of surfaceDefinitions) {
      this.registerSurface(def);
    }
  }

  get streamObserver() {
    return this.#streamObserver;
  }

  get registry() {
    return this.#registry;
  }

  registerSurface(definition) {
    if (!definition || typeof definition.id !== 'string' || typeof definition.createSurface !== 'function') {
      throw new Error('Surface definition requires an "id" and "createSurface" factory');
    }

    const adapter = new AnchorAdapter({
      surfaceId: definition.id,
      selectors: definition.selectors ?? [],
      hostTag: definition.hostTag ?? `t3-agy-${definition.id}`,
      position: definition.position ?? 'append',
      document: this.#document,
      logger: this.#logger,
    });

    const instance = definition.createSurface({
      document: this.#document,
      dispatchAction: (type, payload) => this.dispatchAction(type, payload),
      streamObserver: this.#streamObserver,
      logger: this.#logger,
    });

    this.#registry.register(adapter);
    this.#surfaces.set(definition.id, { definition, adapter, instance });

    if (adapter.isMounted) {
      instance.mount(adapter.shadowRoot);
      if (this.#lastSnapshot) {
        instance.update(this.#lastSnapshot);
      }
    }

    return instance;
  }

  getSurface(surfaceId) {
    return this.#surfaces.get(surfaceId)?.instance ?? null;
  }

  mount() {
    if (this.#globalTarget && this.#stateReceiver) {
      this.#globalTarget[this.#stateReceiver] = (snapshot) => {
        this.receiveState(snapshot);
      };
    }

    const results = this.#registry.mountAll();
    for (const [surfaceId, mounted] of results.entries()) {
      if (!mounted) continue;
      const entry = this.#surfaces.get(surfaceId);
      if (entry) {
        entry.instance.mount(mounted.shadowRoot);
        if (this.#lastSnapshot) {
          entry.instance.update(this.#lastSnapshot);
        }
      }
    }
    this.#registry.observe();
    this.#streamObserver.attach({
      document: this.#document,
      MutationObserver: this.#MutationObserver,
      selectors: this.#streamSelectors,
    });
    return results;
  }

  receiveState(snapshot = {}) {
    if (!snapshot || typeof snapshot !== 'object') {
      return;
    }

    if (snapshot.plannerResponse) {
      this.#streamObserver.reconcile(snapshot.plannerResponse);
    } else if (snapshot.transcriptMetrics && !this.#streamObserver.getMetrics().isStreaming) {
      this.#streamObserver.applyTranscriptFallback(snapshot.transcriptMetrics);
    }

    const streamMetrics = this.#streamObserver.getMetrics();
    const hasLiveStream = streamMetrics.source === 'live';
    const enrichedSnapshot = {
      ...snapshot,
      metrics: {
        ...streamMetrics,
        ...(snapshot.metrics ?? {}),
        ttftMs: hasLiveStream
          ? streamMetrics.ttftMs
          : (snapshot.metrics?.ttftMs ?? streamMetrics.ttftMs),
        ttftDisplay: hasLiveStream
          ? streamMetrics.ttftDisplay
          : (snapshot.metrics?.ttftDisplay ?? streamMetrics.ttftDisplay),
        tokPerSec: hasLiveStream
          ? (streamMetrics.tokPerSec ?? snapshot.metrics?.tokPerSec)
          : (snapshot.metrics?.tokPerSec ?? streamMetrics.tokPerSec),
        tokPerSecDisplay: hasLiveStream
          ? (streamMetrics.tokPerSec !== null
              ? streamMetrics.tokPerSecDisplay
              : (snapshot.metrics?.tokPerSecDisplay ?? streamMetrics.tokPerSecDisplay))
          : (snapshot.metrics?.tokPerSecDisplay ?? streamMetrics.tokPerSecDisplay),
      },
    };

    this.#lastSnapshot = enrichedSnapshot;

    for (const { adapter, instance } of this.#surfaces.values()) {
      if (adapter.isMounted && typeof instance.update === 'function') {
        instance.update(enrichedSnapshot);
      }
    }
  }

  dispatchAction(type, payload = {}) {
    if (typeof type !== 'string' || type.trim().length === 0) {
      return false;
    }
    const sender = this.#globalTarget?.[this.#bindingName];
    if (typeof sender !== 'function') {
      this.#logger.warn({
        status: 'DEGRADED',
        component: 'OverlayRuntime',
        message: 'CDP binding function is not attached; cannot dispatch UI action',
        type,
      });
      return false;
    }
    sender(JSON.stringify({ type, payload }));
    return true;
  }

  destroy() {
    this.#streamObserver.detach();
    this.#registry.unmountAll();
    for (const { instance } of this.#surfaces.values()) {
      if (typeof instance.unmount === 'function') {
        instance.unmount();
      }
    }
    if (this.#globalTarget && this.#stateReceiver && this.#globalTarget[this.#stateReceiver]) {
      delete this.#globalTarget[this.#stateReceiver];
    }
  }
}

import { DEFAULT_SURFACE_ANCHORS } from './anchor-adapter.mjs';
import { OverlayRuntime } from './runtime.mjs';
import { StatusCapsuleSurface } from './surfaces/status-capsule.mjs';
import { ComposerRingSurface } from './surfaces/composer-ring.mjs';
import { StageProgressSurface } from './surfaces/stage-progress.mjs';
import { ContextBreakdownSurface } from './surfaces/context-breakdown.mjs';
import { UnifiedTimelineSurface } from './surfaces/unified-timeline.mjs';
import { OverviewPanelSurface } from './surfaces/overview-panel.mjs';

export function createDefaultSurfaceDefinitions(anchors = DEFAULT_SURFACE_ANCHORS) {
  return [
    {
      id: 'status-capsule',
      selectors: anchors['status-capsule'] ?? DEFAULT_SURFACE_ANCHORS['status-capsule'],
      createSurface: ({ document, dispatchAction, onOpenPopover }) =>
        new StatusCapsuleSurface({ document, dispatchAction, onOpenPopover }),
    },
    {
      id: 'context-breakdown',
      selectors: anchors['context-breakdown'] ?? DEFAULT_SURFACE_ANCHORS['context-breakdown'],
      createSurface: ({ document, dispatchAction, onOpenPopover }) =>
        new ContextBreakdownSurface({ document, dispatchAction, onOpenPopover }),
    },
    {
      id: 'unified-timeline',
      selectors: anchors['unified-timeline'] ?? DEFAULT_SURFACE_ANCHORS['unified-timeline'],
      createSurface: ({ document, dispatchAction, onOpenPopover }) =>
        new UnifiedTimelineSurface({ document, dispatchAction, onOpenPopover }),
    },
  ];
}

/**
 * Create and mount the OverlayRuntime with the core surfaces and any pluggable
 * extra surface definitions.
 */
export function installOverlayRuntime({
  anchors = DEFAULT_SURFACE_ANCHORS,
  extraSurfaces = [],
  ...runtimeOptions
} = {}) {
  const surfaceDefinitions = [
    ...createDefaultSurfaceDefinitions(anchors),
    ...(Array.isArray(extraSurfaces) ? extraSurfaces : []),
  ];
  const runtime = new OverlayRuntime({
    ...runtimeOptions,
    surfaceDefinitions,
  });
  runtime.mount();
  return runtime;
}

export { AnchorAdapter, AnchorRegistry, DEFAULT_SURFACE_ANCHORS } from './anchor-adapter.mjs';
export { StreamObserver, DEFAULT_STREAM_SELECTORS } from './stream-observer.mjs';
export { OverlayRuntime, DEFAULT_BINDING_NAME, DEFAULT_STATE_RECEIVER } from './runtime.mjs';
export { buildOverlayScript } from './bundle.mjs';
export { StatusCapsuleSurface, clampCapsuleSlots } from './surfaces/status-capsule.mjs';
export { ComposerRingSurface, clampPercent } from './surfaces/composer-ring.mjs';
export { StageProgressSurface } from './surfaces/stage-progress.mjs';
export { ContextBreakdownSurface, CONTEXT_CATEGORIES } from './surfaces/context-breakdown.mjs';
export { UnifiedTimelineSurface } from './surfaces/unified-timeline.mjs';
export { OverviewPanelSurface } from './surfaces/overview-panel.mjs';

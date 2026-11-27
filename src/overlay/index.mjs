import { DEFAULT_SURFACE_ANCHORS } from './anchor-adapter.mjs';
import { OverlayRuntime } from './runtime.mjs';
import { StatusCapsuleSurface } from './surfaces/status-capsule.mjs';
import { ComposerRingSurface } from './surfaces/composer-ring.mjs';
import { StageProgressSurface } from './surfaces/stage-progress.mjs';

export function createDefaultSurfaceDefinitions(anchors = DEFAULT_SURFACE_ANCHORS) {
  return [
    {
      id: 'status-capsule',
      selectors: anchors['status-capsule'] ?? DEFAULT_SURFACE_ANCHORS['status-capsule'],
      createSurface: ({ document, dispatchAction }) =>
        new StatusCapsuleSurface({ document, dispatchAction }),
    },
    {
      id: 'composer-ring',
      selectors: anchors['composer-ring'] ?? DEFAULT_SURFACE_ANCHORS['composer-ring'],
      createSurface: ({ document }) => new ComposerRingSurface({ document }),
    },
    {
      id: 'stage-progress',
      selectors: anchors['stage-progress'] ?? DEFAULT_SURFACE_ANCHORS['stage-progress'],
      createSurface: ({ document }) => new StageProgressSurface({ document }),
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
export { StreamObserver } from './stream-observer.mjs';
export { OverlayRuntime, DEFAULT_BINDING_NAME, DEFAULT_STATE_RECEIVER } from './runtime.mjs';
export { StatusCapsuleSurface, clampCapsuleSlots } from './surfaces/status-capsule.mjs';
export { ComposerRingSurface, clampPercent } from './surfaces/composer-ring.mjs';
export { StageProgressSurface } from './surfaces/stage-progress.mjs';

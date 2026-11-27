import fs from 'node:fs';

const MODULE_SPECS = [
  {
    file: './anchor-adapter.mjs',
    varName: '__mod_anchor_adapter',
    imports: [],
    exports: ['DEFAULT_SURFACE_ANCHORS', 'AnchorAdapter', 'AnchorRegistry'],
  },
  {
    file: './stream-observer.mjs',
    varName: '__mod_stream_observer',
    imports: [],
    exports: ['DEFAULT_STREAM_SELECTORS', 'StreamObserver'],
  },
  {
    file: './runtime.mjs',
    varName: '__mod_runtime',
    imports: [
      'const { AnchorAdapter, AnchorRegistry } = __mod_anchor_adapter;',
      'const { DEFAULT_STREAM_SELECTORS, StreamObserver } = __mod_stream_observer;',
    ],
    exports: ['DEFAULT_BINDING_NAME', 'DEFAULT_STATE_RECEIVER', 'OverlayRuntime'],
  },
  {
    file: './surfaces/status-capsule.mjs',
    varName: '__mod_status_capsule',
    imports: [],
    exports: ['StatusCapsuleSurface', 'clampCapsuleSlots'],
  },
  {
    file: './surfaces/composer-ring.mjs',
    varName: '__mod_composer_ring',
    imports: [],
    exports: ['ComposerRingSurface', 'clampPercent'],
  },
  {
    file: './surfaces/stage-progress.mjs',
    varName: '__mod_stage_progress',
    imports: [],
    exports: ['StageProgressSurface'],
  },
  {
    file: './surfaces/context-breakdown.mjs',
    varName: '__mod_context_breakdown',
    imports: [],
    exports: ['ContextBreakdownSurface', 'CONTEXT_CATEGORIES'],
  },
  {
    file: './surfaces/unified-timeline.mjs',
    varName: '__mod_unified_timeline',
    imports: [],
    exports: ['UnifiedTimelineSurface'],
  },
  {
    file: './surfaces/overview-panel.mjs',
    varName: '__mod_overview_panel',
    imports: [],
    exports: ['OverviewPanelSurface'],
  },
  {
    file: './index.mjs',
    varName: '__mod_index',
    imports: [
      'const { DEFAULT_SURFACE_ANCHORS } = __mod_anchor_adapter;',
      'const { OverlayRuntime } = __mod_runtime;',
      'const { StatusCapsuleSurface } = __mod_status_capsule;',
      'const { ComposerRingSurface } = __mod_composer_ring;',
      'const { StageProgressSurface } = __mod_stage_progress;',
      'const { ContextBreakdownSurface } = __mod_context_breakdown;',
      'const { UnifiedTimelineSurface } = __mod_unified_timeline;',
      'const { OverviewPanelSurface } = __mod_overview_panel;',
    ],
    exports: ['createDefaultSurfaceDefinitions', 'installOverlayRuntime'],
  },
];

function stripModuleSyntax(source) {
  return source
    .replace(/^\s*import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^\s*export\s+\{[\s\S]*?\}\s+from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^\s*export\s+(?=(?:const|let|var|function|class|async\s+function)\b)/gm, '');
}

let cachedCoreBundle = null;

function getCoreBundleSource() {
  if (cachedCoreBundle !== null) {
    return cachedCoreBundle;
  }

  const chunks = [];
  for (const spec of MODULE_SPECS) {
    const raw = fs.readFileSync(new URL(spec.file, import.meta.url), 'utf8');
    const body = stripModuleSyntax(raw);
    const importLines = spec.imports.join('\n');
    const returnLine = `return { ${spec.exports.join(', ')} };`;
    chunks.push(
      `const ${spec.varName} = (() => {\n${importLines}\n${body}\n${returnLine}\n})();`,
    );
  }
  cachedCoreBundle = chunks.join('\n\n');
  return cachedCoreBundle;
}

/**
 * Assemble a zero-dependency, browser-executable IIFE that bootstraps
 * OverlayRuntime, all 6 Shadow DOM surfaces, and StreamObserver on globalThis.
 */
export function buildOverlayScript(options = {}) {
  const serializedOptions = JSON.stringify(options ?? {});
  const core = getCoreBundleSource();
  return [
    '(() => {',
    '  const summarize = (rt, alreadyInstalled) => ({',
    '    ok: true,',
    '    alreadyInstalled,',
    '    mounted: rt?.registry?.list',
    '      ? rt.registry.list().filter((a) => a.isMounted).map((a) => a.surfaceId)',
    '      : [],',
    '  });',
    '  if (globalThis.__t3AgyMonitorRuntime) {',
    '    return summarize(globalThis.__t3AgyMonitorRuntime, true);',
    '  }',
    core,
    `  const runtime = __mod_index.installOverlayRuntime(${serializedOptions});`,
    '  globalThis.__t3AgyMonitorRuntime = runtime;',
    '  return summarize(runtime, false);',
    '})();',
  ].join('\n');
}

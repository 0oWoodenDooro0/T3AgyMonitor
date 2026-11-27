import fs from 'node:fs/promises';
import {
  ConfigStore,
  CostCalculator,
  NullQuotaProvider,
  T3StateReader,
  computeComposerRingState,
  computeContextBreakdown,
  computeTranscriptMetrics,
  parseTranscriptLines,
} from './data/index.mjs';
import { collectUnifiedTimeline, computeStageProgress } from './timeline/index.mjs';
import { UpdateChecker } from './updater/index.mjs';
import { Sidecar } from './sidecar/index.mjs';

async function readTranscriptEvents(transcriptPath, logger) {
  if (!transcriptPath) {
    return [];
  }
  try {
    const raw = await fs.readFile(transcriptPath, 'utf8');
    return parseTranscriptLines(raw.split('\n'), { logger, sourcePath: transcriptPath });
  } catch (error) {
    logger?.warn?.({
      status: 'DEGRADED',
      component: 'App',
      message: 'Failed reading transcript file',
      transcriptPath,
      error: error.message,
    });
    return [];
  }
}

function computeStepDurations(events) {
  const durations = [];
  for (let i = 1; i < events.length; i += 1) {
    const prev = events[i - 1];
    const curr = events[i];
    const prevMs = Date.parse(prev?.created_at ?? '');
    const currMs = Date.parse(curr?.created_at ?? '');
    if (Number.isFinite(prevMs) && Number.isFinite(currMs) && currMs >= prevMs) {
      durations.push({
        label: `Step ${i} (${curr?.type ?? 'EVENT'})`,
        durationMs: currMs - prevMs,
      });
    }
  }
  return durations;
}

/**
 * Sidecar composition root connecting ConfigStore, T3StateReader,
 * TranscriptParser, CostCalculator, QuotaProvider, UnifiedTimeline,
 * StageProgress, UpdateChecker, and Sidecar.
 */
export function createApp({
  port = 9222,
  host,
  threadId = null,
  configPath,
  dbPath,
  providersDir,
  ratesPath,
  currentVersion = '0.1.0',
  quotaProvider = new NullQuotaProvider(),
  getOverlayScript = () => '',
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  SidecarClass = Sidecar,
  logger = console,
} = {}) {
  const configStore = new ConfigStore({ configPath, logger });
  const stateReader = new T3StateReader({ dbPath, providersDir, logger });
  const costCalculator = new CostCalculator({ ratesPath, logger });

  let currentConfig = null;
  let updateChecker = null;
  let lastUpdateState = { hasUpdate: false, mode: 'auto', currentVersion };
  let activeAgentFilter = 'all';

  async function ensureInitialized() {
    if (!currentConfig) {
      currentConfig = await configStore.load();
      await costCalculator.loadRates();
      updateChecker = new UpdateChecker({
        currentVersion,
        mode: currentConfig.updateCheckMode,
        fetchImpl,
        logger,
      });
    }
  }

  async function buildSnapshot() {
    await ensureInitialized();

    let targetThreadId = threadId;
    if (!targetThreadId) {
      const activeThreads = stateReader.listActiveThreads({ limit: 1 });
      targetThreadId = activeThreads[0]?.thread_id ?? null;
    }

    const threadSnapshot = targetThreadId
      ? await stateReader.getThreadSnapshot(targetThreadId)
      : null;

    const mainEvents = threadSnapshot?.transcriptPath
      ? await readTranscriptEvents(threadSnapshot.transcriptPath, logger)
      : [];

    const mainBreakdown = computeContextBreakdown(mainEvents, {
      checkpoints: threadSnapshot?.checkpoints ?? [],
    });

    const contextBreakdowns = {
      main: {
        label: threadSnapshot?.thread?.title ? `Main (${threadSnapshot.thread.title})` : 'Main Agent',
        ...mainBreakdown,
      },
    };

    for (const sub of threadSnapshot?.subagents ?? []) {
      const subEvents = sub.transcriptPath
        ? await readTranscriptEvents(sub.transcriptPath, logger)
        : [];
      const subId = sub.subagent_id ?? sub.child_thread_id ?? sub.conversationId;
      if (subId) {
        contextBreakdowns[subId] = {
          label: `${sub.origin ?? 'subagent'} (${subId})`,
          ...computeContextBreakdown(subEvents),
        };
      }
    }

    const transcriptMetrics = computeTranscriptMetrics(mainEvents);
    const sessionCost = costCalculator.summarizeSession(mainEvents);
    const modelRate = costCalculator.getRate(transcriptMetrics.model);
    const maxContextTokens = Number.isFinite(Number(modelRate?.max_input_tokens))
      ? Number(modelRate.max_input_tokens)
      : 1_000_000;

    const quotaAvailable = Boolean(quotaProvider?.isAvailable?.());
    const quotaData = quotaAvailable
      ? await quotaProvider.getQuota({ model: transcriptMetrics.model })
      : null;

    const ring = computeComposerRingState({
      ringMode: currentConfig.ringMode,
      contextTokens: transcriptMetrics.latestInputTokens,
      maxContextTokens,
      softBudgetUsd: currentConfig.softBudgetUsd,
      softBudgetTokens: currentConfig.softBudgetTokens,
      sessionCostUsd: sessionCost.totalCostUsd,
      sessionTotalTokens: sessionCost.totalInputTokens + sessionCost.totalOutputTokens,
      quotaInfo: quotaData,
    });

    const timeline = await collectUnifiedTimeline({
      threadId: targetThreadId,
      stateReader,
      agentId: activeAgentFilter,
      logger,
    });

    const latestTurn = timeline.turns.at(-1) ?? null;
    const latestTurnEvents = (latestTurn?.entries ?? [])
      .filter((e) => e.agentId === 'main')
      .map((e) => e.raw ?? e);
    const stageProgress = computeStageProgress({
      events: latestTurnEvents.length > 0 ? latestTurnEvents : mainEvents,
      turnStatus: latestTurn?.status ?? threadSnapshot?.session?.status ?? 'active',
      startedAt: latestTurn?.startedAt ?? null,
      completedAt: latestTurn?.completedAt ?? null,
    });

    const contextPercent =
      maxContextTokens > 0
        ? Math.min(100, (transcriptMetrics.latestInputTokens / maxContextTokens) * 100)
        : 0;

    return {
      threadId: targetThreadId,
      config: currentConfig,
      metrics: {
        model: transcriptMetrics.model,
        contextPercent,
        costUsd: sessionCost.totalCostUsd,
        cacheHitRate: transcriptMetrics.cacheHitRate,
        outputTokens: transcriptMetrics.totalOutputTokens,
        tokPerSec: transcriptMetrics.tokensPerSecond,
        tokPerSecDisplay:
          typeof transcriptMetrics.tokensPerSecond === 'number'
            ? `${transcriptMetrics.tokensPerSecond.toFixed(1)} tok/s`
            : '—',
        ttftDisplay: '—',
      },
      transcriptMetrics,
      ring,
      stageProgress,
      contextBreakdown: mainBreakdown,
      contextBreakdowns,
      timeline,
      overview: {
        stepDurations: computeStepDurations(mainEvents),
        perModel: sessionCost.perModel,
      },
      quota: {
        available: quotaAvailable,
        models: quotaData?.models ?? null,
      },
      update: lastUpdateState,
    };
  }

  async function pushFreshSnapshot() {
    const snapshot = await buildSnapshot();
    await sidecar.pushState(snapshot);
    return snapshot;
  }

  const sidecar = new SidecarClass({
    host,
    port,
    getOverlayScript,
    fetchImpl,
    WebSocketImpl,
    logger,
    commandHandlers: {
      refresh: async () => {
        await pushFreshSnapshot();
      },
      updateConfig: async (command) => {
        await ensureInitialized();
        const patch = command?.payload && typeof command.payload === 'object' ? command.payload : {};
        currentConfig = await configStore.save({ ...currentConfig, ...patch });
        if (patch.updateCheckMode && updateChecker) {
          updateChecker = new UpdateChecker({
            currentVersion,
            mode: currentConfig.updateCheckMode,
            fetchImpl,
            logger,
          });
        }
        await pushFreshSnapshot();
      },
      checkUpdates: async () => {
        await ensureInitialized();
        lastUpdateState = await updateChecker.checkNow();
        await pushFreshSnapshot();
      },
      filterTimeline: async (command) => {
        activeAgentFilter = command?.payload?.agentId ?? 'all';
        await pushFreshSnapshot();
      },
    },
  });

  sidecar.on('connected', () => {
    void pushFreshSnapshot();
  });

  return {
    sidecar,
    configStore,
    stateReader,
    costCalculator,
    quotaProvider,
    buildSnapshot,
    pushFreshSnapshot,
    async start() {
      await ensureInitialized();
      lastUpdateState = await updateChecker.checkOnStartup();
      await sidecar.start();
      if (sidecar.status === 'CONNECTED') {
        await pushFreshSnapshot();
      }
    },
    async stop() {
      await sidecar.stop();
    },
  };
}

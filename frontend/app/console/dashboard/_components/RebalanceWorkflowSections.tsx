"use client";

import Link from "next/link";
import {
  Fragment,
  type ReactNode,
  type SVGProps,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useUsdInrRate } from "@/hooks/useUsdInrRate";
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, FileSpreadsheet, History, Loader2, Pause, Play, X } from "lucide-react";

import {
  buildConsensusRows,
  buildDashboardActionRows,
  buildTechnicalScanMap,
  buildTechnicalScanPrompt,
  ConsensusBreakupButton,
  ScoreMatrixButton,
  ScoreMatrixModal,
  StockDetailsButton,
  getTechnicalScanForStock,
  loadScoreMatrixFormulaConfig,
  saveScoreMatrixFormulaConfig,
  getScoreMatrixValidationSummary,
  type ScoreMatrixFormulaConfig,
  type ActionCategory,
  type ActionEstimate,
  extractRebalanceInputFingerprint,
  fetchAllFullRuns,
  isCompletedRebalanceRun,
  type DashboardActionRow,
  type ScoreMatrixDetail,
  type StockDetailsData,
  type TechnicalScanResult,
  type StockConsensus,
} from "@/app/console/_components/FinalActionablesConsole";
import { Button } from "@/components/ui/button";
import { TradingViewSymbolLink } from "@/components/shared/TradingViewSymbolLink";
import { TradingViewUrlListButton } from "@/components/shared/TradingViewUrlListButton";
import { LlmModelMixControls } from "@/components/shared/LlmModelMixControls";
import MarkdownRenderer from "@/components/shared/MarkdownRenderer";
import { LlmModelSelectionPanel } from "@/components/shared/LlmModelSelectionPanel";
import {
  buildRebalanceInputBundle,
  buildRebalancePrompt,
  ensureRebalanceFlowMarker,
  getPreviousMarketClose,
  getRebalanceDefaultExportSheetName,
  inferRebalanceMarketFromPrompt,
} from "@/lib/rebalance";
import {
  buildSwingTradePrompt,
  getSwingTradeDefaultExportSheetName,
  getSwingTradeDefaultInvestmentAmount,
  type SwingTradeMarket,
} from "@/lib/swingTrade";
import {
  DEFAULT_ZERODHA_BUY_THRESHOLD,
  buildDefaultZerodhaBasketSelection,
  syncZerodhaBasketBuySelection,
  type ZerodhaBasketSelectableOrder,
} from "@/lib/zerodhaBasketSelection";
import { getAutoRebalanceRunDisplayLabel, getRunDetailPathFromPrompt, isRunInSwingTradeMarket } from "@/lib/runPresentation";
import { APIError, apiService } from "@/services/api";
import { URLs } from "@/lib/urls";
import { INDIA_TIMEZONE } from "../_context";
import { cn } from "@/lib/utils";
import type {
  IndMoneyUsPortfolioSnapshotCreateRequest,
  JobResponse,
  PortfolioAnalysisHistoryItem,
  ZerodhaPortfolioSnapshotDetail,
  ZerodhaPortfolioOverviewResponse,
  IndMoneyUsThreatAnalysis,
  ProviderInfo,
  ProviderModelTarget,
  RunCreate,
  AutoRebalanceRunMetadata,
  RunResponse,
  ZerodhaThreatAnalysis,
} from "@/types/api";
import { normalizeError } from "./dashboardOverviewUtils";

type WorkflowPortfolio = "zerodha" | "indmoneyUs";
type WorkflowStageKey =
  | "sync"
  | "swing"
  | "threats"
  | "rebalance"
  | "technical"
  | "actionables";
type StageState = "idle" | "queued" | "running" | "completed" | "failed";
type InputSelectionStage =
  | "threats"
  | "swing"
  | "rebalance"
  | "technical"
  | "actionables";
type InputSelectionCandidate = {
  id: string;
  source: "next" | "threat" | "run-job";
  label: string;
  jobNo: string;
  timestamp: string | null;
  status: string;
  costUsd: number | null;
  error: string | null;
  run?: RunResponse;
  jobId?: number;
  content?: string | null;
  market?: SwingTradeMarket;
};
type RunOutputJobStatus = "completed" | "partial" | "failed" | "other";

type AutoRebalanceCostBreakdownItem = {
  id: string;
  stage: Exclude<WorkflowStageKey, "sync" | "actionables">;
  sourceType: "run" | "job";
  runId?: number | null;
  jobId?: number | null;
  runPrompt?: string | null;
  timestamp: string | null;
  provider: string;
  model: string;
  status: string;
  costUsd: number | null;
  llmCount: number;
  autoRebalancePortfolio?: string | null;
  autoRebalanceSequence?: number | null;
  autoRebalanceLabel?: string | null;
};

type AutoRebalanceScanGroup = {
  id: string;
  portfolio: WorkflowPortfolio;
  timestamp: string | null;
  totalCostUsd: number;
  label: string;
  sequence: number;
  items: AutoRebalanceCostBreakdownItem[];
};

type StageLlmHistoryEntry = {
  id: string;
  runId: number;
  jobId: number;
  timestamp: string | null;
  provider: string;
  model: string;
  runtime: string | null;
  costUsd: number | null;
  status: RunOutputJobStatus;
  rawStatus: string;
};
type HistoricalLlmCostMapInr = Record<string, number>;
type StageInfo = {
  state: StageState;
  startedAt?: string | null;
  endedAt?: string | null;
  completedAt?: string | null;
  provider?: string | null;
  model?: string | null;
  runStatus?: string | null;
  exportStatus?: string | null;
  costUsd?: number | null;
  costInr?: number | null;
  error?: string | null;
  activeRunId?: number | null;
  lastRunId?: number | null;
  completedLlms?: number | null;
  totalLlms?: number | null;
  recommendedStocks?: number | null;
  rebalanceInputs?: number | null;
};
type ZerodhaBasketOrderKind = "Market" | "Limit" | "After market";
type ZerodhaBasketOrderPercent = number;
const ZERODHA_KITE_PUBLISHER_BATCH_SIZE = 5;
type ZerodhaBasketSubmission = {
  executionMode: ZerodhaExecutionMode;
  redirected: number;
  basketCount: number;
  clipboardCopied: boolean;
  orders: ZerodhaBasketPreviewOrder[];
  placedOrderIds?: string[];
  failedMessages?: string[];
  portfolioRefreshedAt?: string | null;
};
type ZerodhaBasketPreviewOrder = {
  id: string;
  exchange: string;
  symbol: string;
  action: ActionCategory;
  side: "BUY" | "SELL";
  units: number | null;
  baseUnits: number | null;
  currentUnits: number | null;
  price: number | null;
  lastPrice: number | null;
  amount: number | null;
  availableBalance: number | null;
  percent: ZerodhaBasketOrderPercent;
  orderKind: ZerodhaBasketOrderKind;
  stock: StockConsensus;
  detail: ScoreMatrixDetail;
  technicalScan: TechnicalScanResult | null;
};
type WorkflowState = Record<WorkflowStageKey, StageInfo>;
type IndMoneySyncMode = "reuse" | "paste";
type PromptPreviewStage = "threats" | "swing" | "rebalance" | "technical";

type SavedModelMix = {
  id: string;
  name: string;
  targets: string[];
};

const MODEL_MIX_STORAGE_KEY = "investment-engine:model-mixes:v1";
const AUTO_REBALANCE_MIX_NAME = "Auto Rebalance Model Mix";
const AUTO_REBALANCE_MIX_ALIASES = [
  AUTO_REBALANCE_MIX_NAME,
  "Auto rebalance Models Mix",
];
const GPT_4O_MINI_MODEL = "gpt-4o-mini";
const POLL_INTERVAL_MS = 3000;
const MAX_RUN_POLLS = 160;
const MAX_JOB_POLLS = 120;
const MAX_ZERODHA_SYNC_POLLS = 30;
const WORKFLOW_STORAGE_KEY = "investment-engine:rebalance-workflow-state:v1";
const STAGE_LLM_SELECTION_STORAGE_KEY = "investment-engine:dashboard-stage-llms:v1";
const WORKFLOW_COMPLETION_RESET_DELAY_MS = 10000;
export const ZERODHA_DASHBOARD_SYNC_NOW_EVENT =
  "investment-engine:dashboard:zerodha-sync-now";

const STAGE_ORDER: WorkflowStageKey[] = [
  "sync",
  "threats",
  "swing",
  "rebalance",
  "technical",
  "actionables",
];

const COST_BEARING_STAGES: WorkflowStageKey[] = [
  "threats",
  "swing",
  "rebalance",
  "technical",
];

const STAGE_METADATA: Record<
  WorkflowStageKey,
  {
    step: string;
    idle: string;
    running: string;
    completed: string;
    tileDescription: string;
    chartTitle: string;
    chartLines: string[];
  }
> = {
  sync: {
    step: "01",
    idle: "Sync Portfolio",
    running: "Syncing Portfolio",
    completed: "Portfolio Synced",
    tileDescription:
      "Refresh Zerodha holdings, cash, and exposure before any risk or opportunity logic runs.",
    chartTitle: "Sync",
    chartLines: ["Latest holdings, cash,", "and exposure snapshot"],
  },
  swing: {
    step: "03",
    idle: "Swing Opportunities",
    running: "Running Swing Opportunity Scan",
    completed: "Swing Opportunities Ready",
    tileDescription:
      "Surface fresh setups, momentum, and catalyst-driven names worth new capital or adds.",
    chartTitle: "Swing",
    chartLines: ["Momentum, catalysts,", "and opportunity signals"],
  },
  threats: {
    step: "02",
    idle: "Threats & Guardrails",
    running: "Running Threats & Guardrails",
    completed: "Threats & Guardrails Ready",
    tileDescription:
      "Score macro, sector, and position-level risks that can block adds, force trims, or raise cash.",
    chartTitle: "Threats",
    chartLines: ["Macro, sector, and", "position-level guardrails"],
  },
  rebalance: {
    step: "04",
    idle: "Rebalance Draft",
    running: "Building Rebalance Draft",
    completed: "Rebalance Draft Ready",
    tileDescription:
      "Merge sync, threats, and swing conviction into target weights, adds, trims, and holds.",
    chartTitle: "Rebalance",
    chartLines: ["Merge signals into target", "weights, adds, trims, holds"],
  },
  technical: {
    step: "05",
    idle: "Technical Validation",
    running: "Running Technical Validation",
    completed: "Technical Validation Ready",
    tileDescription:
      "Validate entry quality, trim timing, and whether each proposed action still fits the chart.",
    chartTitle: "Technical",
    chartLines: ["Validate entries, trims,", "and execution timing"],
  },
  actionables: {
    step: "06",
    idle: "Final Actionables",
    running: "Preparing Final Actionables",
    completed: "Final Actionables Ready",
    tileDescription:
      "Publish the validated buy/add, sell/trim, and hold/watch outputs for execution.",
    chartTitle: "Actionables",
    chartLines: ["Publish trade-ready", "buy, sell, and watch outputs"],
  },
};

function initialWorkflowState(): WorkflowState {
  return STAGE_ORDER.reduce((acc, stage) => {
    acc[stage] = { state: "idle" };
    return acc;
  }, {} as WorkflowState);
}

type PersistedWorkflow = {
  states: Record<WorkflowPortfolio, WorkflowState>;
  runningPortfolio: WorkflowPortfolio | null;
  specificMode: Record<WorkflowPortfolio, boolean>;
  selectedStages: Record<WorkflowPortfolio, WorkflowStageKey[]>;
  selectedInputs?: Record<
    WorkflowPortfolio,
    Partial<Record<InputSelectionStage, string[]>>
  >;
  lastAutoRebalanceCosts?: Record<WorkflowPortfolio, number | null>;
  savedAt: string;
};

function buildInitialStates() {
  return {
    zerodha: initialWorkflowState(),
    indmoneyUs: initialWorkflowState(),
  };
}

function readPersistedWorkflow(): PersistedWorkflow | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(WORKFLOW_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedWorkflow;
    if (!parsed?.states?.zerodha || !parsed?.states?.indmoneyUs) return null;
    return parsed;
  } catch {
    return null;
  }
}

function persistWorkflow(snapshot: PersistedWorkflow) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WORKFLOW_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // Progress persistence is best-effort; the visible in-memory state remains authoritative.
  }
}

function hasRestorableRunningWorkflow(
  persisted: PersistedWorkflow | null,
  portfolio: WorkflowPortfolio | null | undefined,
) {
  if (!persisted || !portfolio) return false;
  return STAGE_ORDER.some((stage) => {
    const state = persisted.states?.[portfolio]?.[stage]?.state;
    return state === "queued" || state === "running";
  });
}

function getRestorableRunningPortfolio(persisted: PersistedWorkflow | null) {
  return hasRestorableRunningWorkflow(persisted, persisted?.runningPortfolio)
    ? (persisted?.runningPortfolio ?? null)
    : null;
}

function getQueuedStages(
  portfolio: WorkflowPortfolio,
  states: Record<WorkflowPortfolio, WorkflowState>,
  runningPortfolio: WorkflowPortfolio | null,
  specificMode: Record<WorkflowPortfolio, boolean>,
  selectedStages: Record<WorkflowPortfolio, Set<WorkflowStageKey>>,
) {
  if (runningPortfolio !== portfolio) return new Set<WorkflowStageKey>();
  const runningIndex = STAGE_ORDER.findIndex(
    (stage) => states[portfolio][stage].state === "running",
  );
  const activeIndex = runningIndex >= 0 ? runningIndex : -1;
  return new Set(
    STAGE_ORDER.filter((stage, index) => {
      const info = states[portfolio][stage];
      if (info.state !== "idle" && info.state !== "queued") return false;
      if (index <= activeIndex) return false;
      return specificMode[portfolio]
        ? selectedStages[portfolio].has(stage)
        : true;
    }),
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function parseTimestampMs(value?: string | null) {
  if (!value) return 0;
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const date = /[zZ]|[+-]\d{2}:\d{2}$/.test(normalized)
    ? new Date(normalized)
    : new Date(`${normalized}Z`);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function formatTimestamp(value?: string | null) {
  if (!value) return "Not available";
  const ms = parseTimestampMs(value);
  if (!ms) return value;
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: INDIA_TIMEZONE,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(ms));
}

function getStageLabel(stage: WorkflowStageKey, state: StageState) {
  if (state === "running") return STAGE_METADATA[stage].running;
  if (state === "queued") return STAGE_METADATA[stage].idle;
  if (state === "completed") return STAGE_METADATA[stage].completed;
  return STAGE_METADATA[stage].idle;
}

function getStageClasses(state: StageState) {
  if (state === "running")
    return "border-amber-300 bg-amber-50 text-amber-950 shadow-amber-100 ring-1 ring-amber-100";
  if (state === "queued")
    return "border-sky-200 bg-sky-50 text-sky-950 shadow-sky-100 ring-1 ring-sky-100";
  if (state === "completed")
    return "border-emerald-300 bg-emerald-50 text-emerald-950 shadow-emerald-100 ring-1 ring-emerald-100";
  if (state === "failed")
    return "border-red-300 bg-red-50 text-red-950 shadow-red-100 ring-1 ring-red-100";
  return "border-slate-200 bg-white text-slate-950 shadow-slate-100";
}

function getInputStatusBadgeClass(status?: string | null) {
  const normalized = (status || "").toLowerCase();
  if (["reserved", "queued", "pending"].includes(normalized)) {
    return "bg-blue-50 text-blue-700 ring-blue-200";
  }
  if (normalized === "partial") {
    return "bg-amber-50 text-amber-700 ring-amber-200";
  }
  if (normalized === "completed" || normalized === "synced" || normalized === "parsed") {
    return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  }
  if (normalized === "failed" || normalized === "error") {
    return "bg-red-50 text-red-700 ring-red-200";
  }
  return "bg-slate-100 text-slate-700 ring-slate-200";
}

function getStageTileLabel(stage: WorkflowStageKey) {
  const labels: Record<WorkflowStageKey, string> = {
    sync: "Sync Portfolio",
    threats: "Threats Scan",
    swing: "Swing Scan",
    rebalance: "Rebalance",
    technical: "Technical Scan",
    actionables: "Actionables",
  };
  return labels[stage];
}

function getLlmSelectorScanLabel(
  stage: WorkflowStageKey,
  portfolio: WorkflowPortfolio | null,
) {
  const marketLabel =
    portfolio === "zerodha" ? "India" : portfolio === "indmoneyUs" ? "US" : "";
  const scanLabels: Record<WorkflowStageKey, string> = {
    sync: "Sync",
    threats: "Threats",
    swing: "Swing",
    rebalance: "Rebalance",
    technical: "Technical",
    actionables: "Actionables",
  };

  return [scanLabels[stage], marketLabel].filter(Boolean).join(" ");
}

function getLlmSelectorTitle(
  stage: WorkflowStageKey,
  portfolio: WorkflowPortfolio | null,
  costInr?: number | null,
) {
  const scanLabel = getLlmSelectorScanLabel(stage, portfolio);
  const costLabel = formatInrCost(costInr);
  return `Select LLMs- ${scanLabel}${costLabel !== "n/a" ? ` (Cost incurred: ${costLabel})` : ""}`;
}

function summarizeRun(run: RunResponse) {
  const jobs = run.run_jobs?.map((link) => link.job).filter((job): job is JobResponse => Boolean(job)) ?? [];
  const firstJob = jobs[0];
  const costUsd = jobs.reduce(
    (total, job) => total + (job.estimated_cost ?? 0),
    0,
  );
  const failedJob = jobs.find(
    (job) => (job.status || "").toLowerCase() === "failed" || job.error_message,
  );
  return {
    completedAt: run.updated_at ?? firstJob?.updated_at ?? run.created_at,
    provider: jobs.length > 1 ? `${jobs.length} LLMs` : firstJob?.provider,
    model: jobs.length > 1 ? "Model mix" : firstJob?.model,
    runStatus: run.status,
    exportStatus: run.export_status ?? firstJob?.export_status,
    costUsd: costUsd || null,
    error: run.export_error ?? failedJob?.error_message ?? null,
  };
}

function summarizeThreat(
  analysis: ZerodhaThreatAnalysis | IndMoneyUsThreatAnalysis,
) {
  return {
    completedAt: analysis.updated_at ?? analysis.created_at,
    provider: analysis.provider,
    model: analysis.model,
    runStatus: analysis.status,
    exportStatus: null,
    costUsd: analysis.estimated_cost ?? null,
    error: analysis.error_message ?? null,
  };
}


function readSavedModelMixes(): SavedModelMix[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(MODEL_MIX_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter(
          (mix) =>
            mix &&
            typeof mix.id === "string" &&
            typeof mix.name === "string" &&
            Array.isArray(mix.targets),
        )
      : [];
  } catch {
    return [];
  }
}

function getRunTargetsFromStoredMix(providers: ProviderInfo[]) {
  let parsed: SavedModelMix[] = [];
  try {
    const raw = window.localStorage.getItem(MODEL_MIX_STORAGE_KEY);
    parsed = raw ? JSON.parse(raw) : [];
  } catch {
    parsed = [];
  }

  const compatible = new Set(
    providers.flatMap((provider) =>
      provider.models
        .filter(
          (model) =>
            provider.model_compatibility?.[model]?.compatible !== false,
        )
        .map((model) => `${provider.name}::${model}`),
    ),
  );

  const aliasNames = new Set(
    AUTO_REBALANCE_MIX_ALIASES.map((name) => name.toLowerCase()),
  );
  const autoMix = parsed.find((mix) =>
    aliasNames.has(mix?.name?.toLowerCase?.() ?? ""),
  );
  const sourceTargets = autoMix?.targets?.length ? autoMix.targets : [];

  return uniqueTargetKeys(sourceTargets)
    .filter((target) => compatible.has(target))
    .map((target) => {
      const [provider, model] = target.split("::");
      return { provider, model };
    });
}

function getGpt4oMiniTarget(
  providers: ProviderInfo[],
): ProviderModelTarget | null {
  const provider = providers.find(
    (item) =>
      item.configured &&
      item.models.includes(GPT_4O_MINI_MODEL) &&
      item.model_compatibility?.[GPT_4O_MINI_MODEL]?.compatible !== false,
  );
  return provider
    ? { provider: provider.name, model: GPT_4O_MINI_MODEL }
    : null;
}

async function waitForRunCompletion(
  runId: number,
  onProgress?: (run: RunResponse) => void,
  shouldStop?: () => boolean,
) {
  for (let attempt = 0; attempt < MAX_RUN_POLLS; attempt += 1) {
    if (shouldStop?.()) throw new Error(`Run #${runId} was cancelled by user.`);
    const run = await apiService.getRun(runId);
    onProgress?.(run);
    const status = (run.status || "").toLowerCase();
    if (status === "completed" || status === "partial" || status === "failed") return run;
    await sleep(POLL_INTERVAL_MS);
  }
  const lastRun = await apiService.getRun(runId);
  onProgress?.(lastRun);
  return lastRun;
}


async function waitForZerodhaPortfolioSync(
  previousCapturedAt?: string | null,
): Promise<ZerodhaPortfolioOverviewResponse> {
  let latestOverview = await apiService.zerodhaPortfolioOverview();

  for (let attempt = 0; attempt < MAX_ZERODHA_SYNC_POLLS; attempt += 1) {
    const latestCapturedAt = latestOverview.latest?.captured_at ?? null;
    if (latestCapturedAt && latestCapturedAt !== (previousCapturedAt ?? null)) {
      return latestOverview;
    }

    await sleep(POLL_INTERVAL_MS);
    latestOverview = await apiService.zerodhaPortfolioOverview();
  }

  return latestOverview;
}

async function waitForThreatCompletion(
  portfolio: WorkflowPortfolio,
  jobId: number,
  shouldStop?: () => boolean,
): Promise<ZerodhaThreatAnalysis | IndMoneyUsThreatAnalysis> {
  for (let attempt = 0; attempt < MAX_JOB_POLLS; attempt += 1) {
    if (shouldStop?.()) {
      throw new Error(`Threat job #${jobId} was cancelled by user.`);
    }
    const analysis =
      portfolio === "zerodha"
        ? await apiService.zerodhaThreatJob(jobId)
        : await apiService.indmoneyUsThreatJob(jobId);
    const status = (analysis.status || "").toLowerCase();
    if (status === "completed" || status === "failed") return analysis;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `Threat job #${jobId} did not finish before the dashboard timeout.`,
  );
}

function getLatestMatchingRebalanceRuns(
  runs: RunResponse[],
  market: SwingTradeMarket,
) {
  const marketRuns = runs
    .filter((run) => isCompletedRebalanceRun(run, market))
    .sort(
      (a, b) => parseTimestampMs(b.created_at) - parseTimestampMs(a.created_at),
    );
  const latestRun = marketRuns[0];
  if (!latestRun) return [];
  const fingerprint = extractRebalanceInputFingerprint(latestRun.prompt);
  return marketRuns.filter(
    (run) => extractRebalanceInputFingerprint(run.prompt) === fingerprint,
  );
}

const ZERODHA_BASKET_ACTIONS = new Set<ActionCategory>([
  "Sell All",
  "Trim",
  "Add more",
  "Buy New",
]);
const ZERODHA_BASKET_SECTION_ORDER: ActionCategory[] = [
  "Sell All",
  "Trim",
  "Buy New",
  "Add more",
];
const ZERODHA_BASKET_SECTION_LABELS: Partial<Record<ActionCategory, string>> = {
  "Sell All": "Sell All",
  Trim: "Trim",
  "Buy New": "Buy New",
  "Add more": "Buy More",
  Hold: "Hold",
};
const ZERODHA_BASKET_INCREASING_SCORE_ACTIONS = new Set<ActionCategory>(["Sell All", "Trim"]);
const ZERODHA_BASKET_DECREASING_SCORE_ACTIONS = new Set<ActionCategory>(["Add more", "Buy New"]);
const ZERODHA_DEFAULT_MARKET_PROTECTION = "-1";
type ZerodhaExecutionMode = "direct_market" | "publisher_limit";
const LLM_STAGE_TILE_KEYS = new Set<WorkflowStageKey>([
  "threats",
  "swing",
  "rebalance",
  "technical",
]);
const ZERODHA_ORDER_KINDS: ZerodhaBasketOrderKind[] = [
  "Market",
  "Limit",
  "After market",
];

const KITE_BASKET_URL = "https://kite.zerodha.com/connect/basket";
function buildKiteBasketUrl(apiKey: string) {
  const url = new URL(KITE_BASKET_URL);
  url.searchParams.set("api_key", apiKey);
  return url.toString();
}
const INDIA_MARKET_TIME_ZONE = "Asia/Kolkata";
const INDIA_MARKET_OPEN_MINUTES = 9 * 60 + 15;
const INDIA_MARKET_CLOSE_MINUTES = 15 * 60 + 30;

function getIndiaMarketStatus(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: INDIA_MARKET_TIME_ZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = value("weekday");
  const hour = Number(value("hour"));
  const minute = Number(value("minute"));
  const minutes = hour * 60 + minute;
  const isWeekday = !["Sat", "Sun"].includes(weekday);
  const open = isWeekday && minutes >= INDIA_MARKET_OPEN_MINUTES && minutes <= INDIA_MARKET_CLOSE_MINUTES;
  return {
    open,
    label: open
      ? "NSE/BSE regular market appears open now."
      : "NSE/BSE regular market appears closed now. Selected regular orders will be submitted as Zerodha AMO.",
  };
}

function getZerodhaBasketOrderExecution(order: ZerodhaBasketPreviewOrder, marketOpen: boolean, executionMode: ZerodhaExecutionMode = "publisher_limit") {
  const variety = order.orderKind === "After market" || !marketOpen ? "amo" as const : "regular" as const;

  return {
    orderType: executionMode === "direct_market" ? "MARKET" as const : "LIMIT" as const,
    variety,
  };
}

function getZerodhaPublisherApiKey(loginUrl: string) {
  try {
    return new URL(loginUrl).searchParams.get("api_key")?.trim() || null;
  } catch {
    return null;
  }
}

function chunkZerodhaBasketOrders(orders: ZerodhaBasketPreviewOrder[]) {
  const chunks: ZerodhaBasketPreviewOrder[][] = [];
  for (let index = 0; index < orders.length; index += ZERODHA_KITE_PUBLISHER_BATCH_SIZE) {
    chunks.push(orders.slice(index, index + ZERODHA_KITE_PUBLISHER_BATCH_SIZE));
  }
  return chunks;
}

function buildZerodhaKiteBasketPayload(orders: ZerodhaBasketPreviewOrder[], marketOpen: boolean) {
  return orders.map((order) => {
    const execution = getZerodhaBasketOrderExecution(order, marketOpen, "publisher_limit");
    const payload: Record<string, string | number | boolean> = {
      variety: execution.variety,
      tradingsymbol: order.symbol.toUpperCase(),
      exchange: order.exchange.toUpperCase(),
      transaction_type: order.side,
      order_type: execution.orderType,
      quantity: Math.max(1, Math.floor(order.units ?? 0)),
      product: "CNC",
      validity: "DAY",
      readonly: false,
      tag: "credx",
    };
    if (execution.orderType === "MARKET") {
      throw new Error("Publisher basket payload cannot contain MARKET orders");
    } else if (order.price) {
      payload.price = Number(order.price.toFixed(2));
    }
    return payload;
  });
}

async function prepareZerodhaBasketOrdersForKite(orders: ZerodhaBasketPreviewOrder[]) {
  const limitOrders = orders;
  if (limitOrders.length === 0) return orders;

  const response = await apiService.zerodhaPrepareBasketOrders({
    orders: limitOrders.map((order) => ({
      tradingsymbol: order.symbol.toUpperCase(),
      exchange: order.exchange.toUpperCase(),
      transaction_type: order.side,
      quantity: Math.max(1, Math.floor(order.units ?? 0)),
      price: order.price ?? 0,
      last_price: order.lastPrice ?? undefined,
    })),
  });
  const preparedByOrderId = new Map(
    limitOrders.map((order, index) => [order.id, response.orders[index]] as const),
  );

  return orders.map((order) => {
    const prepared = preparedByOrderId.get(order.id);
    return prepared
      ? {
          ...order,
          price: prepared.price,
          lastPrice: prepared.last_price,
          amount: calculateZerodhaBasketAmount(order.units, prepared.price),
        }
      : order;
  });
}

function postZerodhaKiteBasket(apiKey: string, orders: ZerodhaBasketPreviewOrder[], marketOpen: boolean, targetName: string) {
  const form = document.createElement("form");
  form.method = "post";
  form.action = buildKiteBasketUrl(apiKey);
  form.target = targetName;
  form.style.display = "none";

  const apiKeyInput = document.createElement("input");
  apiKeyInput.type = "hidden";
  apiKeyInput.name = "api_key";
  apiKeyInput.value = apiKey;
  form.appendChild(apiKeyInput);

  const dataInput = document.createElement("input");
  dataInput.type = "hidden";
  dataInput.name = "data";
  dataInput.value = JSON.stringify(buildZerodhaKiteBasketPayload(orders, marketOpen));
  form.appendChild(dataInput);

  document.body.appendChild(form);
  form.submit();
  form.remove();
}

function buildZerodhaKiteClipboardText(orders: ZerodhaBasketPreviewOrder[], marketOpen: boolean) {
  const lines = [
    "Cred-X Zerodha order basket for Kite",
    "Paste/reference this in Kite while placing the orders manually:",
    "",
    "Exchange, Symbol, Side, Qty, Order Type, Variety, Product, Validity, Price, Market Protection",
  ];

  orders.forEach((order) => {
    const execution = getZerodhaBasketOrderExecution(order, marketOpen, "publisher_limit");
    const price = execution.orderType === "LIMIT" && order.price ? order.price.toFixed(2) : "";
    const marketProtection = execution.orderType === "MARKET" ? String(ZERODHA_DEFAULT_MARKET_PROTECTION) : "";
    lines.push([
      order.exchange,
      order.symbol,
      order.side,
      Math.max(1, Math.floor(order.units ?? 0)),
      execution.orderType,
      execution.variety.toUpperCase(),
      "CNC",
      "DAY",
      price,
      marketProtection,
    ].join(", "));
  });

  return lines.join("\n");
}

async function copyZerodhaKiteBasketToClipboard(orders: ZerodhaBasketPreviewOrder[], marketOpen: boolean) {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return false;
  await navigator.clipboard.writeText(buildZerodhaKiteClipboardText(orders, marketOpen));
  return true;
}

function parseBasketNumber(value?: string | null) {
  const match = String(value || "")
    .replace(/,/g, "")
    .match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function getBasketPrice(stock: StockConsensus, amount: number | null, units: number | null, fallbackPrice: number | null = null) {
  if (amount !== null && amount > 0 && units !== null && units !== 0) return Math.abs(amount / units);
  const representativePrice = parseBasketNumber(stock.representative["Price Per Unit"]);
  if (representativePrice !== null && representativePrice > 0) return representativePrice;
  return fallbackPrice !== null && fallbackPrice > 0 ? fallbackPrice : null;
}

function calculatePercentBasketUnits(baseUnits: number | null, percent: ZerodhaBasketOrderPercent) {
  if (baseUnits === null || baseUnits <= 0) return null;
  const rawUnits = Math.abs(baseUnits) * (percent / 100);
  return Math.max(1, Math.floor(rawUnits));
}

function getZerodhaBasketSellUnitLimit(order: ZerodhaBasketPreviewOrder) {
  const availableUnits = order.currentUnits ?? order.baseUnits;
  return availableUnits !== null && availableUnits > 0 ? Math.floor(availableUnits) : null;
}

function getZerodhaBasketBuyUnitLimit(order: ZerodhaBasketPreviewOrder) {
  if (order.availableBalance === null || order.availableBalance <= 0 || order.price === null || order.price <= 0) {
    return null;
  }
  return Math.floor(order.availableBalance / order.price);
}

function getZerodhaBasketUnitLimit(order: ZerodhaBasketPreviewOrder) {
  return order.side === "SELL" ? getZerodhaBasketSellUnitLimit(order) : getZerodhaBasketBuyUnitLimit(order);
}

function clampZerodhaBasketUnits(units: number | null, maxUnits: number | null) {
  if (units === null || !Number.isFinite(units)) return null;
  const wholeUnits = Math.floor(Math.abs(units));
  if (wholeUnits < 1) return null;
  if (maxUnits !== null && maxUnits < 1) return null;
  return Math.min(wholeUnits, maxUnits ?? wholeUnits);
}

function calculateZerodhaBasketAmount(units: number | null, price: number | null) {
  return units !== null && price !== null ? Math.abs(units * price) : null;
}

function calculateZerodhaBasketPercent(
  side: "BUY" | "SELL",
  units: number | null,
  amount: number | null,
  totalUnits: number | null,
  availableBalance: number | null,
) {
  if (side === "SELL") {
    if (units === null || totalUnits === null || totalUnits <= 0) return 0;
    return Math.min(100, Math.max(0, (units / totalUnits) * 100));
  }
  if (amount === null || availableBalance === null || availableBalance <= 0) return 0;
  return Math.max(0, (amount / availableBalance) * 100);
}

function formatBasketPercent(value: number) {
  if (!Number.isFinite(value)) return "0%";
  const normalized = Math.max(0, value);
  return `${new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: normalized > 0 && normalized < 10 ? 1 : 0,
  }).format(normalized)}%`;
}

function formatZerodhaLtpRefreshTime(value: string | null) {
  if (!value) return "Using latest synced portfolio snapshot prices until the first quote refresh";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Using recently refreshed quoted LTP for the next basket";
  return `Quoted LTP refreshed ${new Intl.DateTimeFormat("en-IN", {
    timeZone: INDIA_TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(parsed)} IST for the next basket`;
}

function getZerodhaBasketBaseUnits(action: ActionCategory, estimate: ActionEstimate) {
  if (action === "Sell All" || action === "Trim") {
    return estimate.currentUnits !== null && estimate.currentUnits > 0
      ? estimate.currentUnits
      : estimate.units;
  }
  return estimate.units;
}

function getZerodhaBasketActionForPercent(order: ZerodhaBasketPreviewOrder) {
  if (order.side === "SELL") return order.percent >= 100 ? "Sell All" : "Trim";
  return order.action;
}

function applyZerodhaBasketPercent(
  order: ZerodhaBasketPreviewOrder,
  percent: ZerodhaBasketOrderPercent,
): ZerodhaBasketPreviewOrder {
  const baseUnits = order.side === "SELL" ? (order.currentUnits ?? order.baseUnits) : order.baseUnits;
  const units = clampZerodhaBasketUnits(
    calculatePercentBasketUnits(baseUnits, percent),
    getZerodhaBasketUnitLimit(order),
  );
  const amount = calculateZerodhaBasketAmount(units, order.price);
  const normalizedPercent = calculateZerodhaBasketPercent(
    order.side,
    units,
    amount,
    order.side === "SELL" ? (order.currentUnits ?? order.baseUnits) : order.baseUnits,
    order.availableBalance,
  );

  return {
    ...order,
    action: order.side === "SELL" ? (normalizedPercent >= 100 ? "Sell All" : "Trim") : order.action,
    units,
    amount,
    percent: normalizedPercent,
  };
}

function applyZerodhaBasketUnitDelta(
  order: ZerodhaBasketPreviewOrder,
  delta: number,
): ZerodhaBasketPreviewOrder {
  const units = clampZerodhaBasketUnits((order.units ?? 0) + delta, getZerodhaBasketUnitLimit(order));
  const amount = calculateZerodhaBasketAmount(units, order.price);
  const percent = calculateZerodhaBasketPercent(
    order.side,
    units,
    amount,
    order.side === "SELL" ? (order.currentUnits ?? order.baseUnits) : order.baseUnits,
    order.availableBalance,
  );

  return {
    ...order,
    action: order.side === "SELL" ? (percent >= 100 ? "Sell All" : "Trim") : order.action,
    units,
    amount,
    percent,
  };
}

function applyZerodhaBasketLivePricing(
  order: ZerodhaBasketPreviewOrder,
  price: number | null,
  lastPrice: number | null,
): ZerodhaBasketPreviewOrder {
  const pricedOrder = {
    ...order,
    price,
    lastPrice,
  };
  const units = clampZerodhaBasketUnits(order.units, getZerodhaBasketUnitLimit(pricedOrder));
  const amount = calculateZerodhaBasketAmount(units, price);
  const percent = calculateZerodhaBasketPercent(
    order.side,
    units,
    amount,
    order.side === "SELL" ? (order.currentUnits ?? order.baseUnits) : order.baseUnits,
    order.availableBalance,
  );

  return {
    ...pricedOrder,
    action: order.side === "SELL" ? (percent >= 100 ? "Sell All" : "Trim") : order.action,
    units,
    amount,
    percent,
  };
}

function mergePreparedZerodhaBasketOrders(
  currentOrders: ZerodhaBasketPreviewOrder[],
  preparedOrders: ZerodhaBasketPreviewOrder[],
) {
  const preparedById = new Map(preparedOrders.map((order) => [order.id, order] as const));
  return currentOrders.map((order) => {
    const prepared = preparedById.get(order.id);
    return prepared
      ? applyZerodhaBasketLivePricing(order, prepared.price, prepared.lastPrice)
      : order;
  });
}

function getZerodhaBasketScore(order: ZerodhaBasketPreviewOrder) {
  return order.detail.calculatedScore;
}

function getZerodhaBasketSelectableOrders(
  orders: ZerodhaBasketPreviewOrder[],
): ZerodhaBasketSelectableOrder[] {
  return orders.map((order) => ({
    id: order.id,
    side: order.side,
    score: getZerodhaBasketScore(order),
  }));
}

function formatZerodhaBasketScore(value: number | null) {
  return value === null ? "—" : value.toFixed(2);
}

function buildZerodhaBasketScoreWarningMessage(orders: ZerodhaBasketPreviewOrder[]) {
  const issueLines = orders.flatMap((order) => {
    const summary = getScoreMatrixValidationSummary(order.detail);
    if (!summary.finalScoreOutOfRange && summary.rangeIssues.length === 0) return [];

    return [
      `${order.exchange} ${order.symbol}: final score ${formatZerodhaBasketScore(summary.rawScore)}`,
      ...(summary.finalScoreMessage ? [`- ${summary.finalScoreMessage}`] : []),
      ...summary.rangeIssues.map((issue) => `- ${issue.parameter}: ${issue.message}`),
      "",
    ];
  });

  if (!issueLines.length) return null;

  return [
    "Warning: one or more selected Zerodha basket stocks have score inconsistencies.",
    "",
    ...issueLines,
    "Review the inconsistent inputs before placing the basket.",
  ].join("\n").trim();
}

function compareZerodhaBasketOrdersByScore(left: ZerodhaBasketPreviewOrder, right: ZerodhaBasketPreviewOrder) {
  const leftAction = getZerodhaBasketActionForPercent(left);
  const rightAction = getZerodhaBasketActionForPercent(right);
  const leftActionIndex = ZERODHA_BASKET_SECTION_ORDER.indexOf(leftAction);
  const rightActionIndex = ZERODHA_BASKET_SECTION_ORDER.indexOf(rightAction);
  const actionComparison = (leftActionIndex === -1 ? Number.MAX_SAFE_INTEGER : leftActionIndex)
    - (rightActionIndex === -1 ? Number.MAX_SAFE_INTEGER : rightActionIndex);
  if (actionComparison !== 0) return actionComparison;

  const leftScore = getZerodhaBasketScore(left);
  const rightScore = getZerodhaBasketScore(right);
  const leftMissingScore = leftScore === null || !Number.isFinite(leftScore);
  const rightMissingScore = rightScore === null || !Number.isFinite(rightScore);
  if (leftMissingScore !== rightMissingScore) return leftMissingScore ? 1 : -1;

  if (!leftMissingScore && !rightMissingScore) {
    const shouldSortIncreasing = ZERODHA_BASKET_INCREASING_SCORE_ACTIONS.has(leftAction);
    const shouldSortDecreasing = ZERODHA_BASKET_DECREASING_SCORE_ACTIONS.has(leftAction);
    const scoreComparison = shouldSortIncreasing
      ? leftScore - rightScore
      : shouldSortDecreasing
        ? rightScore - leftScore
        : 0;
    if (scoreComparison !== 0) return scoreComparison;
  }

  return left.symbol.localeCompare(right.symbol, undefined, { sensitivity: "base", numeric: true });
}

function formatBasketQuantity(value: number | null) {
  if (value === null) return "—";
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 }).format(value);
}

function formatBasketCurrency(value: number | null) {
  if (value === null) return "—";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(value);
}

function normalizeZerodhaBasketSymbol(value?: string | null) {
  return (value || "")
    .trim()
    .toUpperCase()
    .replace(/^(?:NSE|BSE):/, "")
    .replace(/\.(?:NS|BO|NSE|BSE)$/i, "")
    .trim();
}

function buildZerodhaHoldingExchangeMap(snapshot?: ZerodhaPortfolioSnapshotDetail | null) {
  const map = new Map<string, string>();
  snapshot?.holdings.forEach((holding) => {
    const symbol = normalizeZerodhaBasketSymbol(holding.tradingsymbol);
    const exchange = holding.exchange?.trim().toUpperCase();
    if (symbol && exchange) map.set(symbol, exchange);
  });
  return map;
}

function buildZerodhaSnapshotPriceMap(snapshot?: ZerodhaPortfolioSnapshotDetail | null) {
  const map = new Map<string, number>();
  snapshot?.holdings.forEach((holding) => {
    const symbol = normalizeZerodhaBasketSymbol(holding.tradingsymbol);
    const price = holding.last_price || holding.close_price || holding.average_price || 0;
    if (symbol && price > 0) map.set(symbol, price);
  });
  [...(snapshot?.positions.net ?? []), ...(snapshot?.positions.day ?? [])].forEach((position) => {
    const symbol = normalizeZerodhaBasketSymbol(position.tradingsymbol);
    const price = position.last_price || position.close_price || position.average_price || 0;
    if (symbol && price > 0 && !map.has(symbol)) map.set(symbol, price);
  });
  return map;
}

function getZerodhaBasketExchange(
  stock: StockConsensus,
  side: "BUY" | "SELL",
  holdingExchangeBySymbol: Map<string, string>,
) {
  const symbol = normalizeZerodhaBasketSymbol(stock.symbol);
  const holdingExchange = symbol ? holdingExchangeBySymbol.get(symbol) : null;
  if (side === "SELL" && holdingExchange) return holdingExchange;

  const rawExchange = stock.exchange || stock.representative["Exchange Symbol"]?.split(/\s+/)[0] || "NSE";
  return rawExchange.trim().toUpperCase() || "NSE";
}

function buildZerodhaBasketPreviewOrders(
  rows: DashboardActionRow[],
  technicalScans: Record<string, TechnicalScanResult>,
  snapshot?: ZerodhaPortfolioSnapshotDetail | null,
): ZerodhaBasketPreviewOrder[] {
  const holdingExchangeBySymbol = buildZerodhaHoldingExchangeMap(snapshot);
  const snapshotPriceBySymbol = buildZerodhaSnapshotPriceMap(snapshot);
  const availableBalance = snapshot?.available_margin ?? null;

  return rows
    .filter((row) => ZERODHA_BASKET_ACTIONS.has(row.formulaAction))
    .map((row) => {
      const { stock } = row;
      const action = row.formulaAction;
      const estimate = row.formulaEstimate;
      const side: "BUY" | "SELL" = action === "Sell All" || action === "Trim" ? "SELL" : "BUY";
      const requestedPercent: ZerodhaBasketOrderPercent = action === "Trim" ? 50 : 100;
      const baseUnits = getZerodhaBasketBaseUnits(action, estimate);
      const normalizedSymbol = normalizeZerodhaBasketSymbol(stock.symbol) || stock.symbol;
      const snapshotPrice = snapshotPriceBySymbol.get(normalizedSymbol) ?? null;
      const price = getBasketPrice(stock, estimate.amount, estimate.units, snapshotPrice);
      const rawUnits = calculatePercentBasketUnits(baseUnits, requestedPercent);
      const sellAvailableUnits = estimate.currentUnits ?? baseUnits;
      const maxUnits = side === "SELL"
        ? (sellAvailableUnits !== null && sellAvailableUnits > 0 ? Math.floor(sellAvailableUnits) : null)
        : (availableBalance !== null && price !== null && price > 0 ? Math.floor(availableBalance / price) : null);
      const units = clampZerodhaBasketUnits(rawUnits, maxUnits);
      const amount = calculateZerodhaBasketAmount(units, price) ?? estimate.amount;
      const percent = calculateZerodhaBasketPercent(
        side,
        units,
        amount,
        side === "SELL" ? sellAvailableUnits : baseUnits,
        availableBalance,
      );
      return {
        id: `zerodha:${row.id}`,
        exchange: getZerodhaBasketExchange(stock, side, holdingExchangeBySymbol),
        symbol: normalizedSymbol,
        action,
        side,
        units,
        baseUnits,
        currentUnits: estimate.currentUnits,
        price,
        amount,
        lastPrice: snapshotPrice,
        availableBalance,
        percent,
        orderKind: "Market" as const,
        stock,
        detail: row.detail,
        technicalScan: getTechnicalScanForStock(technicalScans, stock),
      };
    })
    .filter((order) => order.units !== null && order.units > 0)
    .sort(compareZerodhaBasketOrdersByScore);
}

function isActionablesFresh(completedAt: string | null | undefined, now: number) {
  const completedMs = completedAt ? parseTimestampMs(completedAt) : 0;
  return Boolean(completedMs && now - completedMs >= 0 && now - completedMs < 60 * 60 * 1000);
}

function targetKey(target: ProviderModelTarget) {
  return `${target.provider}::${target.model}`;
}

function parseTargetKey(key: string): ProviderModelTarget | null {
  const [provider, model] = key.split("::");
  return provider && model ? { provider, model } : null;
}

function uniqueTargetKeys(keys: string[]) {
  const unique: string[] = [];
  const seen = new Set<string>();
  keys.forEach((key) => {
    const normalized = key.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    unique.push(key);
  });
  return unique;
}

function getCompatibleTargets(providers: ProviderInfo[]) {
  return providers.flatMap((provider) =>
    provider.models
      .filter(
        (model) => provider.model_compatibility?.[model]?.compatible !== false,
      )
      .map((model) => ({ provider: provider.name, model })),
  );
}

function readStageLlmSelection(stage: WorkflowStageKey) {
  try {
    const raw = window.localStorage.getItem(STAGE_LLM_SELECTION_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return Array.isArray(parsed?.[stage]) ? (parsed[stage] as string[]) : [];
  } catch {
    return [];
  }
}

function writeStageLlmSelection(stage: WorkflowStageKey, keys: string[]) {
  try {
    const raw = window.localStorage.getItem(STAGE_LLM_SELECTION_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    window.localStorage.setItem(
      STAGE_LLM_SELECTION_STORAGE_KEY,
      JSON.stringify({ ...parsed, [stage]: keys }),
    );
  } catch {
    // Local storage is a convenience only; workflow defaults still apply.
  }
}

function getDefaultStageTargets(
  stage: WorkflowStageKey,
  providers: ProviderInfo[],
) {
  if (stage === "swing" || stage === "rebalance") {
    return getRunTargetsFromStoredMix(providers);
  }

  const gpt4oMiniTarget = getGpt4oMiniTarget(providers);
  return gpt4oMiniTarget ? [gpt4oMiniTarget] : [];
}

function getSavedStageTargets(
  stage: WorkflowStageKey,
  providers: ProviderInfo[],
) {
  const compatibleKeys = new Set(
    getCompatibleTargets(providers).map(targetKey),
  );
  const savedTargets = uniqueTargetKeys(readStageLlmSelection(stage))
    .filter((key) => compatibleKeys.has(key))
    .map(parseTargetKey)
    .filter((target): target is ProviderModelTarget => Boolean(target));

  return savedTargets.length > 0
    ? savedTargets
    : getDefaultStageTargets(stage, providers);
}


function getAutoRebalancePortfolioKey(portfolio: WorkflowPortfolio): AutoRebalanceRunMetadata["auto_rebalance_portfolio"] {
  return portfolio === "zerodha" ? "india" : "indmoney_us";
}

async function reserveAutoRebalanceRunMetadata(
  portfolio: WorkflowPortfolio,
): Promise<AutoRebalanceRunMetadata> {
  const reserved = await apiService.reserveAutoRebalanceRunLabel(
    getAutoRebalancePortfolioKey(portfolio),
  );
  return {
    auto_rebalance_portfolio: reserved.portfolio,
    auto_rebalance_sequence: reserved.sequence,
    auto_rebalance_label: reserved.label,
  };
}

function buildRunPayload({
  prompt,
  targets,
  sheetName,
  runMetadata,
  scanLabel,
}: {
  prompt: string;
  targets: ProviderModelTarget[];
  sheetName?: string;
  runMetadata?: AutoRebalanceRunMetadata | null;
  scanLabel?: "Swing Scan" | "Rebalance Scan" | "Technical Scan";
}): RunCreate {
  const uniqueTargets = uniqueTargetKeys(targets.map(targetKey))
    .map(parseTargetKey)
    .filter((target): target is ProviderModelTarget => Boolean(target));

  const metadata = runMetadata
    ? {
        ...runMetadata,
        auto_rebalance_label: scanLabel
          ? `${runMetadata.auto_rebalance_label} (${scanLabel})`
          : runMetadata.auto_rebalance_label,
      }
    : {};

  return {
    prompt,
    targets: uniqueTargets,
    allow_parallel: true,
    auto_export_enabled: Boolean(sheetName),
    export_sheet_name: sheetName,
    ...metadata,
  };
}

function formatDuration(
  start?: string | null,
  end?: string | null,
  now = Date.now(),
) {
  const started = parseTimestampMs(start);
  if (!started) return null;
  const ended = end ? parseTimestampMs(end) : now;
  if (!ended) return null;
  const totalSeconds = Math.max(0, Math.floor((ended - started) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function getRunProgress(run: RunResponse) {
  const jobs = run.run_jobs?.map((link) => link.job).filter(Boolean) ?? [];
  return {
    completedLlms: jobs.filter((job) =>
      ["completed", "failed"].includes((job.status || "").toLowerCase()),
    ).length,
    totalLlms: jobs.length,
  };
}

function isUsableStageJob(job?: { status?: string; response?: string | null }) {
  const status = (job?.status || "").toLowerCase();
  return (
    status === "completed" ||
    status === "partial" ||
    Boolean(job?.response?.trim())
  );
}

function getRunJobTimestamp(
  run: RunResponse,
  job?: { updated_at?: string | null; created_at?: string | null },
) {
  return job?.updated_at ?? job?.created_at ?? getLatestRunTimestamp(run);
}

function buildRunJobCandidate(
  run: RunResponse,
  jobId: number | undefined,
  stageLabel: string,
  market: SwingTradeMarket,
): InputSelectionCandidate | null {
  const link = run.run_jobs?.find((item) => item.job?.id === jobId);
  const job = link?.job;
  if (!job || !isUsableStageJob(job)) return null;
  const costUsd =
    typeof job.estimated_cost === "number" ? job.estimated_cost : null;
  return {
    id: `run:${run.id}:job:${job.id}`,
    source: "run-job",
    label: `${stageLabel} · ${job.provider}/${job.model}`,
    jobNo: `#${run.id} / #${job.id}`,
    timestamp: getRunJobTimestamp(run, job),
    status: job.status || run.status,
    costUsd,
    error: job.error_message ?? null,
    run,
    jobId: job.id,
    content: job.response,
    market,
  };
}

function buildRunJobCandidates(runs: RunResponse[], stageLabel: string, market: SwingTradeMarket) {
  return runs.flatMap(
    (run) =>
      (run.run_jobs ?? [])
        .map((link) => buildRunJobCandidate(run, link.job?.id, stageLabel, market))
        .filter(Boolean) as InputSelectionCandidate[],
  );
}

function buildNextCandidate(
  stage: InputSelectionStage,
  market: SwingTradeMarket,
): InputSelectionCandidate {
  const labelByStage: Record<InputSelectionStage, string> = {
    threats: "Upcoming portfolio snapshot",
    swing: "Upcoming Threat Scan output",
    rebalance: "Upcoming Swing Scan output",
    technical: "Upcoming Rebalance Scan output",
    actionables: "Upcoming Technical Scan output",
  };
  return {
    id: `${stage}:next`,
    source: "next",
    label: labelByStage[stage],
    jobNo: "Upcoming run",
    timestamp: null,
    status: "reserved",
    costUsd: null,
    error: null,
    market,
  };
}

function getInputMarketLabel(market?: SwingTradeMarket) {
  if (market === "india") return "India";
  if (market === "us") return "US";
  return "Market unknown";
}

function getInputMarketBadgeClass(market?: SwingTradeMarket) {
  if (market === "india") return "border-orange-200 bg-orange-50 text-orange-800";
  if (market === "us") return "border-indigo-200 bg-indigo-50 text-indigo-800";
  return "border-slate-200 bg-slate-50 text-slate-600";
}

function getStagePromptPreview(portfolio: WorkflowPortfolio, stage: PromptPreviewStage) {
  const market: SwingTradeMarket = portfolio === "zerodha" ? "india" : "us";
  const portfolioName = portfolio === "zerodha" ? "Zerodha" : "INDmoney US";
  if (stage === "threats") {
    const marker = portfolio === "zerodha" ? "[ZERODHA_THREATS]" : "[INDMONEY_US_THREATS]";
    return `${marker}
[ENABLE_WEB_SEARCH]
[THREAT_METADATA_DO_NOT_REPEAT]

${portfolioName} Threat Scan Flow

This dashboard queues the server-side ${portfolioName} threat prompt through the threat-scan worker endpoint. The runtime prompt includes the latest selected portfolio snapshot, web-search markers, and the normalized threat analysis instructions stored with the backend threat flow.`;
  }
  if (stage === "swing") {
    return buildSwingTradePrompt(market, getSwingTradeDefaultInvestmentAmount(market));
  }
  if (stage === "rebalance") {
    return `${ensureRebalanceFlowMarker(buildRebalancePrompt(market), market)}

---

## Rebalance Input Bundle
Runtime inputs are appended here from the Select Inputs popup: latest portfolio snapshot, latest Threat Scan output, and all selected Swing Scan outputs run after the previous market close.`;
  }
  return buildTechnicalScanPrompt([], market);
}

function filterRunToSelectedJobs(
  run: RunResponse,
  selectedIds: Set<string>,
): RunResponse | null {
  const runJobs = (run.run_jobs ?? []).filter((link) =>
    selectedIds.has(`run:${run.id}:job:${link.job?.id}`),
  );
  if (runJobs.length === 0) return null;
  return { ...run, run_jobs: runJobs };
}

function uniqueRunsBySelectedCandidates(
  candidates: InputSelectionCandidate[],
  selectedIds: Set<string>,
) {
  const byRun = new Map<number, RunResponse>();
  candidates.forEach((candidate) => {
    if (!candidate.run) return;
    byRun.set(candidate.run.id, candidate.run);
  });
  return Array.from(byRun.values())
    .map((run) => filterRunToSelectedJobs(run, selectedIds))
    .filter(Boolean) as RunResponse[];
}

function withInrCost(info: Partial<StageInfo>, usdInrRate: number) {
  if (typeof info.costUsd !== "number" || info.costUsd <= 0) return info;
  return {
    ...info,
    costInr: info.costInr ?? info.costUsd * usdInrRate,
  };
}

function getLatestRunTimestamp(run: RunResponse) {
  const timestamps = [
    run.updated_at,
    run.exported_at,
    run.created_at,
    ...((run.run_jobs ?? []).flatMap((link) => [
      link.job?.updated_at,
      link.job?.created_at,
    ])),
  ]
    .map(parseTimestampMs)
    .filter(Boolean);
  if (timestamps.length === 0) return run.updated_at ?? run.exported_at ?? run.created_at ?? null;
  return new Date(Math.max(...timestamps)).toISOString();
}

function sortRunsByLatestTimestamp(runs: RunResponse[]) {
  return [...runs].sort(
    (a, b) =>
      parseTimestampMs(getLatestRunTimestamp(b)) -
      parseTimestampMs(getLatestRunTimestamp(a)),
  );
}

function isTechnicalScanRun(run: RunResponse, market: SwingTradeMarket) {
  if (!/##\s*Technical Scan Input Bundle/i.test(run.prompt)) return false;
  return market === "us"
    ? /Market:\s*US equities/i.test(run.prompt)
    : /Market:\s*India equities/i.test(run.prompt);
}

function isCompletedTechnicalScanRun(
  run: RunResponse,
  market: SwingTradeMarket,
) {
  if (!isTechnicalScanRun(run, market)) return false;
  const hasUsableJob = (run.run_jobs ?? []).some((link) => {
    const job = link.job;
    return isUsableStageJob(job) && Boolean(job?.response?.trim());
  });
  return isUsableStageJob(run) || hasUsableJob;
}

function isRebalanceRunForMarket(run: RunResponse, market: SwingTradeMarket) {
  return inferRebalanceMarketFromPrompt(run.prompt) === market;
}

function getLatestStageRun(
  runs: RunResponse[],
  stage: Extract<WorkflowStageKey, "swing" | "rebalance" | "technical">,
  market: SwingTradeMarket,
) {
  const matchingRuns = runs.filter((run) => {
    if (stage === "swing") return isRunInSwingTradeMarket(run.prompt, market);
    if (stage === "rebalance") return isRebalanceRunForMarket(run, market);
    return isTechnicalScanRun(run, market);
  });
  return sortRunsByLatestTimestamp(matchingRuns)[0];
}

function countUniqueStocksFromRun(run: RunResponse) {
  const symbols = new Set<string>();
  (run.run_jobs ?? []).forEach((link) => {
    const job = link.job;
    if ((job?.status || "").toLowerCase() !== "completed") return;
    const response = job.response ?? "";
    response.split("\n").forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("|")) return;
      if (/^\|?\s*:?-{3,}/.test(trimmed)) return;
      if (/Stock Symbol/i.test(trimmed)) return;
      const cells = trimmed
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean);
      const symbol = cells[2] || cells[1];
      if (
        symbol &&
        !/^(?:stock symbol|symbol|n\/?a|—|-)$/.test(symbol.toLowerCase())
      ) {
        symbols.add(symbol.toUpperCase());
      }
    });
  });
  return symbols.size || null;
}

function summarizeCompletedRunForIdle(
  run: RunResponse | undefined,
  usdInrRate: number,
  recommendedStocks?: number | null,
): Partial<StageInfo> {
  if (!run) return {};
  return withInrCost(
    {
      ...summarizeRun(run),
      ...getRunProgress(run),
      completedAt: getLatestRunTimestamp(run),
      lastRunId: run.id,
      recommendedStocks: recommendedStocks ?? null,
    },
    usdInrRate,
  );
}

function formatInrCost(value?: number | null) {
  return typeof value === "number" && value > 0
    ? `₹${value.toFixed(2)}`
    : "n/a";
}

function getStageCostInr(info: StageInfo, usdInrRate: number) {
  if (typeof info.costInr === "number" && info.costInr > 0) return info.costInr;
  if (typeof info.costUsd === "number" && info.costUsd > 0)
    return info.costUsd * usdInrRate;
  return 0;
}

function getWorkflowRunCost(state: WorkflowState, usdInrRate: number) {
  return COST_BEARING_STAGES.reduce(
    (total, stage) => total + getStageCostInr(state[stage], usdInrRate),
    0,
  );
}

function getWorkflowRunDuration(state: WorkflowState, now = Date.now()) {
  const starts = COST_BEARING_STAGES.map((stage) =>
    parseTimestampMs(state[stage].startedAt),
  ).filter(Boolean);
  const ends = COST_BEARING_STAGES.map((stage) =>
    parseTimestampMs(state[stage].endedAt ?? state[stage].completedAt),
  ).filter(Boolean);
  if (!starts.length) return null;
  return formatDuration(
    new Date(Math.min(...starts)).toISOString(),
    ends.length ? new Date(Math.max(...ends)).toISOString() : null,
    now,
  );
}

function getRunDuration(run: RunResponse) {
  const jobs = run.run_jobs?.map((link) => link.job).filter(Boolean) ?? [];
  const startMs = Math.min(
    ...[
      parseTimestampMs(run.created_at),
      ...jobs.map((job) => parseTimestampMs(job.created_at)),
    ].filter(Boolean),
  );
  const endMs = Math.max(
    ...[
      parseTimestampMs(run.updated_at),
      ...jobs.map((job) => parseTimestampMs(job.updated_at)),
    ].filter(Boolean),
  );
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return formatDuration(
    new Date(startMs).toISOString(),
    new Date(endMs).toISOString(),
  );
}

function classifyRunOutputJob(
  job: NonNullable<RunResponse["run_jobs"]>[number]["job"],
): RunOutputJobStatus {
  const status = (job?.status || "").toLowerCase();
  const issueText = `${job?.error_message || ""}
${job?.response || ""}`.toLowerCase();
  const hasSavedRows = Boolean(job?.response?.trim());
  const isMalformedTable = issueText.includes("malformed table output");
  const isPartialTable = issueText.includes("partial rebalance table");

  if (
    status === "partial" ||
    isPartialTable ||
    (isMalformedTable && hasSavedRows) ||
    (hasSavedRows && status !== "completed" && status !== "failed")
  ) {
    return "partial";
  }
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "other";
}

function getRunOutputDisplayLabel(run: RunResponse) {
  return getAutoRebalanceRunDisplayLabel(run);
}

function getRunOutputSummary(run: RunResponse) {
  const runLabel = getRunOutputDisplayLabel(run);
  const jobs = run.run_jobs?.map((link) => link.job).filter((job): job is JobResponse => Boolean(job)) ?? [];
  const classifications = jobs.map(classifyRunOutputJob);
  const completed = classifications.filter((state) => state === "completed").length;
  const partial = classifications.filter((state) => state === "partial").length;
  const failed = classifications.filter((state) => state === "failed").length;
  const costUsd = jobs.reduce(
    (total, job) => total + (job.estimated_cost ?? 0),
    0,
  );
  const duration = getRunDuration(run);
  return [
    `${runLabel} · ${formatTimestamp(run.created_at)} · LLMs used: ${jobs.length}`,
    `Completed: ${completed} · Partial: ${partial} · Failed: ${failed}`,
    duration ? `Time taken: ${duration}` : null,
    costUsd > 0 ? `Cost incurred: $${costUsd.toFixed(4)}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatLlmCompletion(info: StageInfo) {
  if (!info.totalLlms) return "Not available";
  return `${info.completedLlms ?? 0}/${info.totalLlms}`;
}

function formatRecommendedStockProgress(info: StageInfo) {
  const expected = info.totalLlms ? info.totalLlms * 5 : null;
  const recommended = info.recommendedStocks ?? null;
  if (recommended === null && expected === null) return "n/a";
  return `${recommended ?? 0}${expected !== null ? `/${expected}` : ""}`;
}

function formatBriefTileError(error?: string | null) {
  if (!error?.trim()) return "None";
  const trimmed = error.trim().replace(/\s+/g, " ");
  return trimmed.length > 96 ? `${trimmed.slice(0, 93)}…` : trimmed;
}

function getLlmStageTileRows(info: StageInfo, now: number) {
  return [
    { label: "Last scan", value: formatTimestamp(info.completedAt ?? info.startedAt) },
    { label: "LLMs completed", value: formatLlmCompletion(info) },
    { label: "Stocks recommended", value: formatRecommendedStockProgress(info) },
    { label: "Duration", value: formatDuration(info.startedAt, info.endedAt, now) ?? "n/a" },
    { label: "Cost incurred", value: formatInrCost(info.costInr) },
    { label: "Error", value: formatBriefTileError(info.error) },
  ];
}

function getActionablesStageTileRows(info: StageInfo) {
  return [
    { label: "Last update", value: formatTimestamp(info.completedAt ?? info.startedAt) },
    { label: "Rebalance inputs", value: info.rebalanceInputs?.toString() ?? "n/a" },
    { label: "Stocks recommended", value: info.recommendedStocks?.toString() ?? "n/a" },
    { label: "Error", value: formatBriefTileError(info.error) },
  ];
}


function formatInrCostFromUsd(value: number | null | undefined, usdInrRate: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "₹0.00";
  }
  return `₹${(value * usdInrRate).toFixed(2)}`;
}

function getJobDuration(job?: JobResponse | null) {
  return formatDuration(job?.created_at, job?.updated_at);
}

function getRunCostUsd(run: RunResponse) {
  return (run.run_jobs ?? []).reduce(
    (total, link) => total + (link.job?.estimated_cost ?? 0),
    0,
  );
}

function getRunLlmLabel(run: RunResponse) {
  const jobs = run.run_jobs?.map((link) => link.job).filter(Boolean) ?? [];
  if (jobs.length === 0) return { provider: "Unknown", model: "No LLM jobs" };
  if (jobs.length === 1) {
    return { provider: jobs[0]?.provider ?? "Unknown", model: jobs[0]?.model ?? "Unknown" };
  }
  return { provider: `${jobs.length} LLMs`, model: "Model mix" };
}


function getAutoRebalanceStageForRun(
  run: RunResponse,
  portfolio: WorkflowPortfolio,
): AutoRebalanceCostBreakdownItem["stage"] | null {
  const market: SwingTradeMarket = portfolio === "zerodha" ? "india" : "us";
  if (isCompletedRebalanceRun(run, market)) return "rebalance";
  if (isCompletedTechnicalScanRun(run, market)) return "technical";
  if (isRunInSwingTradeMarket(run.prompt || "", market)) return "swing";
  return null;
}

function buildThreatCostBreakdownItem(
  item: PortfolioAnalysisHistoryItem,
): AutoRebalanceCostBreakdownItem {
  return {
    id: `threat:${item.job_id}`,
    stage: "threats",
    sourceType: "job",
    jobId: item.job_id,
    runId: item.run_id ?? null,
    timestamp: item.updated_at ?? item.created_at ?? null,
    provider: item.provider,
    model: item.model,
    status: item.status,
    costUsd: typeof item.estimated_cost === "number" ? item.estimated_cost : null,
    llmCount: 1,
    autoRebalancePortfolio: item.auto_rebalance_portfolio ?? null,
    autoRebalanceSequence: item.auto_rebalance_sequence ?? null,
    autoRebalanceLabel: item.auto_rebalance_label ?? null,
  };
}

function buildRunCostBreakdownItems(
  run: RunResponse,
  portfolio: WorkflowPortfolio,
): AutoRebalanceCostBreakdownItem[] {
  const stage = getAutoRebalanceStageForRun(run, portfolio);
  if (!stage) return [];
  const jobs = run.run_jobs?.map((link) => link.job).filter((job): job is JobResponse => Boolean(job)) ?? [];
  if (jobs.length === 0) {
    const { provider, model } = getRunLlmLabel(run);
    return [{
      id: `run:${run.id}:${stage}`,
      stage,
      sourceType: "run",
      runId: run.id,
      timestamp: getLatestRunTimestamp(run),
      runPrompt: run.prompt,
      provider,
      model,
      status: run.status,
      costUsd: getRunCostUsd(run),
      llmCount: 0,
      autoRebalancePortfolio: run.auto_rebalance_portfolio ?? null,
      autoRebalanceSequence: run.auto_rebalance_sequence ?? null,
      autoRebalanceLabel: run.auto_rebalance_label ?? null,
    }];
  }
  return jobs.map((job) => ({
    id: `run:${run.id}:job:${job.id}:${stage}`,
    stage,
    sourceType: "run",
    runId: run.id,
    jobId: job.id,
    timestamp: job.updated_at ?? job.created_at ?? getLatestRunTimestamp(run),
    runPrompt: run.prompt,
    provider: job.provider,
    model: job.model,
    status: job.status || run.status,
    costUsd: typeof job.estimated_cost === "number" ? job.estimated_cost : null,
    llmCount: 1,
    autoRebalancePortfolio: run.auto_rebalance_portfolio ?? job.auto_rebalance_portfolio ?? null,
    autoRebalanceSequence: run.auto_rebalance_sequence ?? job.auto_rebalance_sequence ?? null,
    autoRebalanceLabel: run.auto_rebalance_label ?? job.auto_rebalance_label ?? null,
  }));
}

function buildAutoRebalanceScanGroups(
  runs: RunResponse[],
  threatHistory: PortfolioAnalysisHistoryItem[],
  portfolio: WorkflowPortfolio,
): AutoRebalanceScanGroup[] {
  const maxGapMs = 90 * 60 * 1000;
  const items = [
    ...threatHistory.map(buildThreatCostBreakdownItem),
    ...runs.flatMap((run) => buildRunCostBreakdownItems(run, portfolio)),
  ]
    .filter((item) => parseTimestampMs(item.timestamp) > 0)
    .sort((a, b) => parseTimestampMs(a.timestamp) - parseTimestampMs(b.timestamp));

  const groups: AutoRebalanceCostBreakdownItem[][] = [];
  items.forEach((item) => {
    const lastGroup = groups[groups.length - 1];
    const lastItem = lastGroup?.[lastGroup.length - 1];
    const hasReservedRunBoundary = Boolean(
      item.autoRebalanceSequence &&
      lastItem?.autoRebalanceSequence &&
      item.autoRebalancePortfolio &&
      lastItem.autoRebalancePortfolio,
    );
    const sameReservedRun = Boolean(
      hasReservedRunBoundary &&
      item.autoRebalancePortfolio === lastItem?.autoRebalancePortfolio &&
      item.autoRebalanceSequence === lastItem?.autoRebalanceSequence,
    );
    const differentReservedRun = Boolean(hasReservedRunBoundary && !sameReservedRun);
    const shouldStartNewGroup =
      !lastGroup ||
      !lastItem ||
      differentReservedRun ||
      (!sameReservedRun &&
        parseTimestampMs(item.timestamp) - parseTimestampMs(lastItem.timestamp) > maxGapMs);
    if (shouldStartNewGroup) {
      groups.push([item]);
      return;
    }
    lastGroup.push(item);
  });

  const chronologicalGroups = groups.map((group, index) => {
    const sortedItems = [...group].sort(
      (a, b) => parseTimestampMs(a.timestamp) - parseTimestampMs(b.timestamp),
    );
    const explicitSequence = sortedItems.find((item) => item.autoRebalanceSequence)?.autoRebalanceSequence ?? null;
    return {
      chronologicalSequence: index + 1,
      explicitSequence,
      sortedItems,
    };
  });
  const explicitSequenceCounts = chronologicalGroups.reduce<Record<number, number>>((counts, group) => {
    if (typeof group.explicitSequence === "number" && group.explicitSequence > 0) {
      counts[group.explicitSequence] = (counts[group.explicitSequence] ?? 0) + 1;
    }
    return counts;
  }, {});

  return chronologicalGroups
    .map((group) => {
      const { chronologicalSequence, explicitSequence, sortedItems } = group;
      const latestTimestamp = new Date(
        Math.max(...sortedItems.map((item) => parseTimestampMs(item.timestamp))),
      ).toISOString();
      const stageRank: Record<AutoRebalanceCostBreakdownItem["stage"], number> = {
        threats: 1,
        swing: 2,
        rebalance: 3,
        technical: 4,
      };
      const idParts = sortedItems.map((item) => item.id).join("|");
      let sequence = chronologicalSequence;
      let canUseExplicitLabel = false;
      if (
        typeof explicitSequence === "number" &&
        explicitSequence > 0 &&
        explicitSequenceCounts[explicitSequence] === 1
      ) {
        sequence = explicitSequence;
        canUseExplicitLabel = true;
      }
      const fallbackLabel = portfolio === "zerodha" ? `India Run #${sequence}` : `IndMoney US Run #${sequence}`;
      const explicitLabel = sortedItems.find((item) => item.autoRebalanceLabel)?.autoRebalanceLabel ?? null;
      const label = canUseExplicitLabel && explicitLabel ? explicitLabel : fallbackLabel;
      return {
        id: `${portfolio}:${sequence}:${idParts}`,
        portfolio,
        timestamp: latestTimestamp,
        totalCostUsd: sortedItems.reduce(
          (total, item) => total + (item.costUsd ?? 0),
          0,
        ),
        label,
        sequence,
        items: sortedItems.sort((a, b) => {
          const rankDelta = stageRank[a.stage] - stageRank[b.stage];
          return rankDelta || parseTimestampMs(a.timestamp) - parseTimestampMs(b.timestamp);
        }),
      };
    })
    .sort((a, b) => parseTimestampMs(b.timestamp) - parseTimestampMs(a.timestamp));
}

function formatAutoRebalanceStageLabel(
  stage: AutoRebalanceCostBreakdownItem["stage"],
) {
  return getStageTileLabel(stage);
}

function getAutoRebalanceItemRunHref(item: AutoRebalanceCostBreakdownItem) {
  if (item.runId) return getRunDetailPathFromPrompt(item.runId, item.runPrompt);
  if (item.jobId) return URLs.routes.console.jobDetail(item.jobId);
  return null;
}

function getAutoRebalanceItemLlmHref(item: AutoRebalanceCostBreakdownItem) {
  const runHref = getAutoRebalanceItemRunHref(item);
  if (!runHref) return null;
  if (item.runId && item.jobId) return `${runHref}#llm-output-job-${item.jobId}`;
  return runHref;
}

function getAutoRebalanceItemJobNumber(item: AutoRebalanceCostBreakdownItem) {
  if (item.jobId) return `Job #${item.jobId}`;
  if (item.runId) return `Run #${item.runId}`;
  return "—";
}

function groupAutoRebalanceItemsByStage(items: AutoRebalanceCostBreakdownItem[]) {
  const stageOrder: AutoRebalanceCostBreakdownItem["stage"][] = [
    "threats",
    "swing",
    "rebalance",
    "technical",
  ];
  return stageOrder
    .map((stage) => ({
      stage,
      items: items.filter((item) => item.stage === stage),
    }))
    .filter((section) => section.items.length > 0);
}

function AutoRebalanceCostLink({
  href,
  children,
  className,
}: {
  href: string | null;
  children: ReactNode;
  className?: string;
}) {
  if (!href) return <span className={className}>{children}</span>;
  return (
    <Link href={href} className={cn("hover:text-blue-700 hover:underline", className)}>
      {children}
    </Link>
  );
}


function isRunForStageHistory(
  run: RunResponse,
  stage: WorkflowStageKey,
  portfolio: WorkflowPortfolio,
) {
  const market: SwingTradeMarket = portfolio === "zerodha" ? "india" : "us";
  const prompt = run.prompt || "";
  if (stage === "swing") return isRunInSwingTradeMarket(prompt, market);
  if (stage === "rebalance") return isCompletedRebalanceRun(run, market);
  if (stage === "technical") return isCompletedTechnicalScanRun(run, market);
  if (stage === "threats") {
    const marker = portfolio === "zerodha" ? "[ZERODHA_THREATS]" : "[INDMONEY_US_THREATS]";
    return prompt.includes(marker) || /Threat Scan Flow/i.test(prompt);
  }
  return false;
}

function buildStageLlmHistoryEntries(
  runs: RunResponse[],
  stage: WorkflowStageKey,
  portfolio: WorkflowPortfolio,
): StageLlmHistoryEntry[] {
  return runs
    .filter((run) => isRunForStageHistory(run, stage, portfolio))
    .flatMap((run) =>
      (run.run_jobs ?? []).flatMap((link) => {
        const job = link.job;
        if (!job) return [];
        return [{
          id: `${run.id}:${job.id}`,
          runId: run.id,
          jobId: job.id,
          timestamp: job.updated_at ?? job.created_at ?? run.updated_at ?? run.created_at ?? null,
          provider: job.provider,
          model: job.model,
          runtime: getJobDuration(job),
          costUsd: typeof job.estimated_cost === "number" ? job.estimated_cost : null,
          status: classifyRunOutputJob(job),
          rawStatus: job.status || run.status || "unknown",
        }];
      }),
    )
    .sort((a, b) => parseTimestampMs(b.timestamp) - parseTimestampMs(a.timestamp));
}

function hasKnownUsdCost(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function toHistoricalLlmCostKey(
  provider: string | null | undefined,
  model: string | null | undefined,
) {
  return provider && model ? `${provider}::${model}` : null;
}

function toRoundedInrCost(usdCost: number, usdInrRate: number) {
  return Math.round(usdCost * usdInrRate * 100) / 100;
}

function buildRunHistoricalCostMapInr(
  runs: RunResponse[],
  stage: WorkflowStageKey,
  portfolio: WorkflowPortfolio,
  usdInrRate: number,
): HistoricalLlmCostMapInr {
  const costs: HistoricalLlmCostMapInr = {};
  buildStageLlmHistoryEntries(runs, stage, portfolio).forEach((entry) => {
    const key = toHistoricalLlmCostKey(entry.provider, entry.model);
    if (!key || costs[key] !== undefined) return;
    // The Auto-rebalance history popup reports actual incurred cost for any
    // job that reached the backend and recorded spend, including partial runs.
    // Use the same source for Select LLM indicatory costs so the selector
    // mirrors the latest incurred amount instead of falling back to stale
    // provider estimates for non-completed-but-charged jobs.
    if (!hasKnownUsdCost(entry.costUsd)) return;
    costs[key] = toRoundedInrCost(entry.costUsd, usdInrRate);
  });
  return costs;
}

function buildThreatHistoricalCostMapInr(
  history: PortfolioAnalysisHistoryItem[],
  usdInrRate: number,
): HistoricalLlmCostMapInr {
  const costs: HistoricalLlmCostMapInr = {};
  history
    .slice()
    .sort(
      (a, b) =>
        parseTimestampMs(b.updated_at ?? b.created_at) -
        parseTimestampMs(a.updated_at ?? a.created_at),
    )
    .forEach((item) => {
      const key = toHistoricalLlmCostKey(item.provider, item.model);
      if (!key || costs[key] !== undefined) return;
      if (!hasKnownUsdCost(item.estimated_cost)) return;
      costs[key] = toRoundedInrCost(item.estimated_cost, usdInrRate);
    });
  return costs;
}

async function loadStageHistoricalCostMapInr(
  stage: WorkflowStageKey,
  portfolio: WorkflowPortfolio,
  usdInrRate: number,
): Promise<HistoricalLlmCostMapInr> {
  if (stage === "sync" || stage === "actionables") return {};
  if (stage === "threats") {
    const response = portfolio === "zerodha"
      ? await apiService.zerodhaThreatsHistory({ limit: 200 })
      : await apiService.indmoneyUsThreatsHistory({ limit: 200 });
    return buildThreatHistoricalCostMapInr(response.history ?? [], usdInrRate);
  }

  const runs = await fetchAllFullRuns();
  return buildRunHistoricalCostMapInr(runs, stage, portfolio, usdInrRate);
}

function getRunOutputStatusClass(status: RunOutputJobStatus) {
  if (status === "completed") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "partial") return "border-sky-200 bg-sky-50 text-sky-700";
  if (status === "failed") return "border-red-200 bg-red-50 text-red-700";
  return "border-slate-200 bg-slate-50 text-slate-600";
}

function getRunOutputStatusLabel(status: RunOutputJobStatus) {
  if (status === "completed") return "Completed";
  if (status === "partial") return "Partial";
  if (status === "failed") return "Failed";
  return "Other";
}

type ParsedLlmTable = {
  intro: string;
  headers: string[];
  rows: string[][];
  outro: string;
};

function splitPipeTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isPipeTableDivider(line: string) {
  return /^\|?[\s:-|]+\|?$/.test(line.trim());
}

function parseLlmPipeTable(content: string): ParsedLlmTable | null {
  const lines = content.split(/\r?\n/);
  const tableStart = lines.findIndex((line, index) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || splitPipeTableRow(trimmed).length < 3) return false;
    const nextLine = lines[index + 1]?.trim() ?? "";
    return isPipeTableDivider(nextLine) || nextLine.startsWith("|");
  });

  if (tableStart < 0) return null;

  const headers = splitPipeTableRow(lines[tableStart]);
  let rowStart = tableStart + 1;
  if (isPipeTableDivider(lines[rowStart] ?? "")) rowStart += 1;

  const rows: string[][] = [];
  let tableEnd = rowStart;
  while (tableEnd < lines.length && lines[tableEnd].trim().startsWith("|")) {
    const cells = splitPipeTableRow(lines[tableEnd]);
    if (cells.length >= 2 && !isPipeTableDivider(lines[tableEnd])) {
      rows.push(headers.map((_, index) => cells[index] ?? ""));
    }
    tableEnd += 1;
  }

  if (rows.length === 0) return null;
  return {
    intro: lines.slice(0, tableStart).join("\n").trim(),
    headers,
    rows,
    outro: lines.slice(tableEnd).join("\n").trim(),
  };
}

function StandardLlmOutputRenderer({ content }: { content: string }) {
  const parsed = parseLlmPipeTable(content);

  if (!parsed) {
    return (
      <MarkdownRenderer
        content={content}
        enableValidation={false}
        className="text-xs leading-6 text-slate-700 [&_.prose]:max-w-none [&_table]:min-w-max [&_td]:align-top [&_td]:text-xs [&_th]:whitespace-nowrap [&_th]:text-[11px]"
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-semibold text-amber-800">
        Detected pipe-delimited markdown table output and converted it to the standard readable LLM table format.
      </div>
      {parsed.intro ? (
        <MarkdownRenderer
          content={parsed.intro}
          enableValidation={false}
          className="text-sm leading-6 text-slate-700 [&_.prose]:max-w-none"
        />
      ) : null}
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="max-h-[62vh] w-full max-w-full overflow-auto overscroll-contain">
          <table className="min-w-max border-separate border-spacing-0 text-left text-xs text-slate-700">
            <thead className="sticky top-0 z-10 bg-slate-900 text-[11px] uppercase tracking-[0.08em] text-white">
              <tr>
                {parsed.headers.map((header, index) => (
                  <th
                    key={`${header}-${index}`}
                    scope="col"
                    className="max-w-[18rem] border-r border-slate-700 px-3 py-3 align-top font-bold last:border-r-0"
                  >
                    {header || `Column ${index + 1}`}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {parsed.rows.map((row, rowIndex) => (
                <tr key={`llm-row-${rowIndex}`} className="odd:bg-white even:bg-slate-50 hover:bg-blue-50/70">
                  {row.map((cell, cellIndex) => (
                    <td
                      key={`llm-cell-${rowIndex}-${cellIndex}`}
                      className="min-w-36 max-w-[22rem] border-r border-t border-slate-100 px-3 py-3 align-top leading-5 last:border-r-0"
                    >
                      {cell || "—"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {parsed.outro ? (
        <MarkdownRenderer
          content={parsed.outro}
          enableValidation={false}
          className="text-sm leading-6 text-slate-700 [&_.prose]:max-w-none"
        />
      ) : null}
    </div>
  );
}

function RunOutputDetails({ run }: { run: RunResponse }) {
  const usdInrRate = useUsdInrRate();
  const [highlightedJobId, setHighlightedJobId] = useState<number | null>(null);
  const jobs = run.run_jobs?.map((link) => link.job).filter((job): job is JobResponse => Boolean(job)) ?? [];
  const classifications = jobs.map(classifyRunOutputJob);
  const completed = classifications.filter((state) => state === "completed").length;
  const partial = classifications.filter((state) => state === "partial").length;
  const failed = classifications.filter((state) => state === "failed").length;
  const duration = getRunDuration(run);
  const costUsd = getRunCostUsd(run);
  const runLabel = getRunOutputDisplayLabel(run);

  const scrollToJob = (jobId: number) => {
    setHighlightedJobId(jobId);
    window.setTimeout(() => setHighlightedJobId((current) => (current === jobId ? null : current)), 1000);
    document.getElementById(`run-output-job-${jobId}`)?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };

  return (
    <div className="max-w-full space-y-4 overflow-x-hidden bg-white p-5 text-slate-900">
      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">
              Last Run Summary
            </p>
            <h4 className="mt-2 text-lg font-extrabold text-slate-950">
              {runLabel} · {formatTimestamp(run.created_at)}
              <span className="block text-sm font-semibold text-slate-600 sm:ml-2 sm:inline">
                LLMs used: {jobs.length}{duration ? ` · Time taken: ${duration}` : ""}
              </span>
            </h4>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center text-xs font-bold uppercase tracking-[0.14em]">
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-5 py-3 text-emerald-700">
              <span className="block text-xl">{completed}</span>Completed
            </div>
            <div className="rounded-2xl border border-sky-200 bg-sky-50 px-5 py-3 text-sky-700">
              <span className="block text-xl">{partial}</span>Partial
            </div>
            <div className="rounded-2xl border border-red-200 bg-red-50 px-5 py-3 text-red-700">
              <span className="block text-xl">{failed}</span>Failed
            </div>
          </div>
        </div>
        {costUsd > 0 ? (
          <p className="mt-2 text-sm font-semibold text-slate-600">Cumulative cost: {formatInrCostFromUsd(costUsd, usdInrRate)}</p>
        ) : null}
        <div className="mt-4 overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-[0.14em] text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-bold">Provider</th>
                  <th className="px-4 py-3 font-bold">Model</th>
                  <th className="px-4 py-3 font-bold">Status</th>
                  <th className="px-4 py-3 font-bold">Runtime</th>
                  <th className="px-4 py-3 font-bold">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {jobs.map((job) => {
                  const state = classifyRunOutputJob(job);
                  const jobDuration = getJobDuration(job);
                  return (
                    <tr
                      key={`summary-job-${job.id}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => scrollToJob(job.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") scrollToJob(job.id);
                      }}
                      className="cursor-pointer bg-white transition hover:bg-slate-50"
                      title={`Jump to ${job.provider}/${job.model}`}
                    >
                      <td className="px-4 py-3 font-bold capitalize text-slate-900">{job.provider}</td>
                      <td className="px-4 py-3 font-semibold text-slate-700">{job.model}</td>
                      <td className="px-4 py-3">
                        <span className={`rounded-full border px-2.5 py-1 text-xs font-bold ${getRunOutputStatusClass(state)}`}>
                          {getRunOutputStatusLabel(state)}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-600">{jobDuration ?? "n/a"}</td>
                      <td className="px-4 py-3 font-bold text-slate-700">{formatInrCostFromUsd(job.estimated_cost, usdInrRate)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        <p className="mt-4 text-xs text-slate-500">
          Malformed table outputs with any stored LLM table response are counted as Partial.
        </p>
      </section>

      {jobs.map((job) => {
        const state = classifyRunOutputJob(job);
        const isHighlighted = highlightedJobId === job.id;
        return (
          <section
            key={`details-job-${job.id}`}
            id={`run-output-job-${job.id}`}
            className={`scroll-mt-6 overflow-hidden rounded-2xl border bg-white transition duration-300 ${
              isHighlighted
                ? "border-blue-400 ring-4 ring-blue-200"
                : "border-slate-200"
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
              <div>
                <h4 className="font-bold text-slate-950">
                  <span className="capitalize">{job.provider}</span>
                  <span className="ml-3 text-sm font-medium text-slate-500">{job.model}</span>
                  <span className="ml-3 text-sm font-medium text-slate-500">Job #{job.id}</span>
                </h4>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
                <span>Run timer: {getJobDuration(job) ?? "n/a"}</span>
                <span>Cost: {formatInrCostFromUsd(job.estimated_cost, usdInrRate)}</span>
                <span className={`rounded-full border px-2 py-1 ${getRunOutputStatusClass(state)}`}>
                  {getRunOutputStatusLabel(state)}
                </span>
              </div>
            </div>
            {job.error_message ? (
              <div className="m-5 rounded-none border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-700">
                {job.error_message}
              </div>
            ) : null}
            {job.response?.trim() ? (
              <div className="m-5 max-w-full overflow-x-auto rounded-2xl bg-slate-50 p-5">
                <StandardLlmOutputRenderer content={job.response.trim()} />
              </div>
            ) : (
              <div className="m-5 rounded-2xl bg-slate-50 p-5 text-xs leading-6 text-slate-700">
                No response text saved.
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function getIdleStageRows(stage: WorkflowStageKey, info: StageInfo, now: number) {
  if (stage === "sync") {
    return [{ label: "Latest sync", value: formatTimestamp(info.completedAt) }];
  }
  if (LLM_STAGE_TILE_KEYS.has(stage)) {
    return getLlmStageTileRows(info, now);
  }
  return getActionablesStageTileRows(info);
}

function getStageOutputRoute(
  portfolio: WorkflowPortfolio,
  stage: WorkflowStageKey,
) {
  const zerodha = portfolio === "zerodha";
  const routeByStage: Record<WorkflowStageKey, string> = {
    sync: zerodha
      ? URLs.routes.console.zerodha()
      : URLs.routes.console.indmoneyUs(),
    threats: zerodha
      ? URLs.routes.console.zerodhaThreats()
      : URLs.routes.console.indmoneyUsThreats(),
    swing: zerodha
      ? URLs.routes.console.zerodhaSwingTrade()
      : URLs.routes.console.indmoneyUsSwingTrade(),
    rebalance: zerodha
      ? URLs.routes.console.zerodhaRebalance()
      : URLs.routes.console.indmoneyUsRebalance(),
    technical: URLs.routes.console.dashboard(),
    actionables: `${URLs.routes.console.dashboard()}#final-actionables`,
  };
  return routeByStage[stage];
}

function BoxArrowIcon({
  className,
  variant,
}: {
  className?: string;
  variant: "input" | "output";
}) {
  const isInput = variant === "input";
  const boxPath = isInput
    ? "M12 12h40v40H12M12 12v13M12 39v13"
    : "M12 12h40M12 12v40M12 52h40M52 12v13M52 39v13";
  const arrowLinePath = isInput ? "M7 32h32" : "M25 32h32";
  const arrowHeadPath = isInput ? "M29 22l10 10-10 10" : "M47 22l10 10-10 10";

  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d={boxPath}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="6"
      />
      <path
        d={arrowLinePath}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="6"
      />
      <path
        d={arrowHeadPath}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="6"
      />
    </svg>
  );
}

function SelectInputsIcon({ className }: { className?: string }) {
  return <BoxArrowIcon className={className} variant="input" />;
}

function ViewOutputIcon({ className }: { className?: string }) {
  return <BoxArrowIcon className={className} variant="output" />;
}

function LlmDetailsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 1200 1200"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M614.6 83.8c-101.3 0-190.5 54-240 134.8-95.2-19.7-195.8 17.6-250.1 111.8-50.7 87.8-42.7 191.1 10.9 269.5-53.5 78.5-61.5 181.8-10.8 269.6 54.3 94.1 154.8 131.4 250 111.7 49.5 80.8 138.7 134.9 240 134.9 108.7 0 194-63.4 236.1-149 95.2 19.6 195.7-17.7 250-111.8 50.7-87.8 42.7-191.1-10.8-269.5 53.5-78.5 61.5-181.8 10.8-269.6-54.3-94.1-154.8-131.4-250-111.7-49.5-80.8-138.7-134.7-236.1-120.7Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="72"
      />
      <path
        d="M405 764V436l286-164 286 164v328L691 928 405 764Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="72"
      />
      <path
        d="M405 436 691 600l286-164M691 600v328M405 764l286-164"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="72"
      />
    </svg>
  );
}

function PromptIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M15 20l16 12-16 12"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="6"
      />
      <path
        d="M35 46h15"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="6"
      />
    </svg>
  );
}

function WorkflowStageTile({
  stage,
  info,
  now,
  selectable,
  selected,
  onClick,
  onInfoClick,
  onInputClick,
  onPromptClick,
  onOutputClick,
  onSyncNowClick,
  onPlaceOrderClick,
  onCalculationsClick,
}: {
  stage: WorkflowStageKey;
  info: StageInfo;
  now: number;
  selectable?: boolean;
  selected?: boolean;
  onClick?: () => void;
  onInfoClick?: () => void;
  onInputClick?: () => void;
  onPromptClick?: () => void;
  onOutputClick?: () => void;
  onSyncNowClick?: () => void;
  onPlaceOrderClick?: () => void;
  onCalculationsClick?: () => void;
}) {
  const isRunning = info.state === "running";
  const isCompleted = info.state === "completed";
  const stageMeta = STAGE_METADATA[stage];
  const showPromptShortcut = Boolean(onPromptClick);
  const iconButtonClasses =
    "inline-flex size-10 items-center justify-center rounded-full border border-blue-200 bg-white text-slate-800 shadow-sm transition hover:border-blue-400 hover:bg-white hover:text-blue-700";
  const selectionClasses = selectable
    ? selected
      ? "ring-2 ring-blue-500"
      : info.state === "idle"
        ? "bg-white opacity-100"
        : ""
    : "";
  const isFreshActionables = isActionablesFresh(info.completedAt, now);

  return (
    <button
      type="button"
      onClick={() => {
        onClick?.();
      }}
      disabled={!onClick}
      className={`relative flex min-h-[17rem] flex-col items-start justify-start rounded-2xl border p-5 text-left align-top shadow-sm transition hover:-translate-y-0.5 hover:shadow-md disabled:cursor-default disabled:hover:translate-y-0 ${getStageClasses(info.state)} ${selectionClasses}`}
    >
      {onInputClick ? (
        <span
          role="button"
          tabIndex={0}
          onClick={(event) => {
            event.stopPropagation();
            onInputClick();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              event.stopPropagation();
              onInputClick();
            }
          }}
          className={`absolute left-5 top-5 ${iconButtonClasses}`}
          aria-label={`Select inputs for ${stageMeta.idle}`}
          title="Select Inputs"
        >
          <SelectInputsIcon className="size-6" />
        </span>
      ) : null}
      {onInfoClick ? (
        <span
          role="button"
          tabIndex={0}
          onClick={(event) => {
            event.stopPropagation();
            onInfoClick();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              event.stopPropagation();
              onInfoClick();
            }
          }}
          className={`absolute right-5 top-5 ${iconButtonClasses}`}
          aria-label={`Show ${stageMeta.idle} LLM details`}
          title="LLM models and expected cost"
        >
          <LlmDetailsIcon className="size-6" />
        </span>
      ) : null}

      {onCalculationsClick ? (
        <span
          role="button"
          tabIndex={0}
          onClick={(event) => {
            event.stopPropagation();
            onCalculationsClick();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              event.stopPropagation();
              onCalculationsClick();
            }
          }}
          className={`absolute right-5 top-5 ${iconButtonClasses}`}
          aria-label={`Open ${stageMeta.idle} Actionables Calculations`}
          title="Actionables Calculations"
        >
          <FileSpreadsheet className="size-6" />
        </span>
      ) : null}

      <div className="w-full px-10 text-center text-base font-semibold text-slate-950">
        <div className="flex min-w-0 items-center justify-center gap-2">
          {isRunning ? (
            <Loader2 className="size-4 shrink-0 animate-spin text-amber-600" />
          ) : info.state === "failed" ? (
            <AlertCircle className="size-4 shrink-0 text-red-600" />
          ) : isCompleted ? (
            <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />
          ) : null}
          <span className="truncate">{getStageTileLabel(stage)}</span>
        </div>
      </div>

      <div className="mt-6 w-full space-y-2 text-sm leading-5 text-slate-600">
        {info.state === "idle" || info.state === "queued" ? (
          getIdleStageRows(stage, info, now).map((row) => (
            <p key={row.label}>
              <span className="font-semibold text-slate-600">
                {row.label}:
              </span>{" "}
              {row.value}
            </p>
          ))
        ) : (
          (LLM_STAGE_TILE_KEYS.has(stage)
            ? getLlmStageTileRows(info, now)
            : stage === "actionables"
              ? getActionablesStageTileRows(info)
              : getIdleStageRows(stage, info, now)
          ).map((row) => (
            <p key={row.label} className={row.label === "Error" && row.value !== "None" ? "text-red-700" : undefined}>
              <span className="font-semibold text-slate-600">
                {row.label}:
              </span>{" "}
              {row.value}
            </p>
          ))
        )}
      </div>

      {onSyncNowClick && stage === "sync" ? (
        <span
          role="button"
          tabIndex={0}
          onClick={(event) => {
            event.stopPropagation();
            onSyncNowClick();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              event.stopPropagation();
              onSyncNowClick();
            }
          }}
          className="mt-6 inline-flex h-10 items-center justify-center self-center rounded-full bg-blue-600 px-6 text-sm font-semibold text-white shadow-md shadow-blue-600/25 transition hover:bg-blue-700"
        >
          Sync Now
        </span>
      ) : null}

      {onPlaceOrderClick && stage === "actionables" ? (
        <span
          role="button"
          tabIndex={0}
          onClick={(event) => {
            event.stopPropagation();
            onPlaceOrderClick();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              event.stopPropagation();
              onPlaceOrderClick();
            }
          }}
          className={cn(
            "mt-6 inline-flex h-10 items-center justify-center self-center rounded-full px-6 text-sm font-semibold text-white shadow-md transition",
            isFreshActionables
              ? "bg-emerald-600 shadow-emerald-600/25 hover:bg-emerald-700"
              : "bg-blue-600 shadow-blue-600/25 hover:bg-blue-700",
          )}
        >
          Place Order
        </span>
      ) : null}

      <div className="mt-auto flex w-full items-end justify-between gap-3 pt-5">
        {showPromptShortcut ? (
          <span
            role="button"
            tabIndex={0}
            onClick={(event) => {
              event.stopPropagation();
              onPromptClick?.();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                event.stopPropagation();
                onPromptClick?.();
              }
            }}
            className="inline-flex size-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-950 shadow-sm transition hover:border-slate-300 hover:bg-slate-50"
            aria-label={`Open prompt for ${stageMeta.idle}`}
            title="Prompt"
          >
            <PromptIcon className="size-6" />
          </span>
        ) : (
          <span aria-hidden="true" />
        )}
        {onOutputClick ? (
          <span
            role="button"
            tabIndex={0}
            onClick={(event) => {
              event.stopPropagation();
              onOutputClick();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                event.stopPropagation();
                onOutputClick();
              }
            }}
            className={iconButtonClasses}
            aria-label={`View output for ${stageMeta.idle}`}
            title="View Output"
          >
            <ViewOutputIcon className="size-6" />
          </span>
        ) : null}
      </div>
    </button>
  );
}

function ZerodhaBasketPreviewDialog({
  open,
  loading,
  error,
  orders,
  selectedIds,
  onClose,
  onToggle,
  onToggleAll,
  onToggleSection,
  onOrderKindChange,
  onPercentChange,
  onUnitsChange,
  onPlaceOrder,
  placing,
  directMarketAvailable,
  executionMode,
  onExecutionModeChange,
  onRefreshLtp,
  ltpRefreshing,
  ltpRefreshedAt,
  submission,
  detailsData,
  formulaConfig,
  onFormulaConfigChange,
  buyThreshold,
  buyThresholdDraft,
  onBuyThresholdDraftChange,
}: {
  open: boolean;
  loading: boolean;
  error: string | null;
  orders: ZerodhaBasketPreviewOrder[];
  selectedIds: Set<string>;
  onClose: () => void;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  onToggleSection: (action: ActionCategory) => void;
  onOrderKindChange: (id: string, orderKind: ZerodhaBasketOrderKind) => void;
  onPercentChange: (id: string, percent: ZerodhaBasketOrderPercent) => void;
  onUnitsChange: (id: string, delta: number) => void;
  onPlaceOrder: () => void;
  placing: boolean;
  directMarketAvailable: boolean;
  executionMode: ZerodhaExecutionMode;
  onExecutionModeChange: (mode: ZerodhaExecutionMode) => void;
  onRefreshLtp: () => void;
  ltpRefreshing: boolean;
  ltpRefreshedAt: string | null;
  submission: ZerodhaBasketSubmission | null;
  detailsData: StockDetailsData;
  formulaConfig: ScoreMatrixFormulaConfig;
  onFormulaConfigChange: (updater: (current: ScoreMatrixFormulaConfig) => ScoreMatrixFormulaConfig) => void;
  buyThreshold: number;
  buyThresholdDraft: string;
  onBuyThresholdDraftChange: (value: string) => void;
}) {
  const [selectedMatrixDetail, setSelectedMatrixDetail] = useState<ScoreMatrixDetail | null>(null);

  if (!open) return null;

  const selectedOrders = orders.filter((order) => selectedIds.has(order.id));
  const selectedBuyAmount = selectedOrders
    .filter((order) => order.side === "BUY")
    .reduce((sum, order) => sum + (order.amount ?? 0), 0);
  const selectedSellAmount = selectedOrders
    .filter((order) => order.side === "SELL")
    .reduce((sum, order) => sum + (order.amount ?? 0), 0);
  const allSelected = orders.length > 0 && orders.every((order) => selectedIds.has(order.id));
  const marketStatus = getIndiaMarketStatus();
  const canUseDirectMarket = directMarketAvailable && marketStatus.open;
  const submittedOrderIds = new Set(submission?.orders.map((order) => order.id) ?? []);
  const placedOrderIds = new Set(submission?.placedOrderIds ?? []);
  const sectionGroups = ZERODHA_BASKET_SECTION_ORDER.map((action) => ({
    action,
    label: ZERODHA_BASKET_SECTION_LABELS[action] ?? action,
    orders: orders
      .filter((order) => getZerodhaBasketActionForPercent(order) === action)
      .sort(compareZerodhaBasketOrdersByScore),
  })).filter((group) => group.orders.length > 0);

  const buttonText = executionMode === "direct_market" ? "Place protected MARKET orders" : "Open Kite protected LIMIT basket";
  const busyText = executionMode === "direct_market" ? "Placing…" : "Opening…";
  const renderPlaceOrderButton = (className?: string) => (
    <Button
      type="button"
      onClick={onPlaceOrder}
      disabled={!selectedOrders.length || placing || ltpRefreshing}
      className={cn(
        "shrink-0 rounded-full bg-blue-600 px-5 text-sm font-bold text-white shadow-md shadow-blue-600/25 hover:bg-blue-700 disabled:opacity-50",
        className,
      )}
    >
      {placing ? busyText : buttonText}
    </Button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-7xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 p-5">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.35em] text-slate-400">
              Zerodha Basket Preview
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <h3 className="text-xl font-bold text-slate-950">
                Zerodha India Place Order Basket
              </h3>
              <TradingViewUrlListButton
                items={orders.map((order) => ({
                  symbol: order.symbol,
                  market: "india",
                  exchange: order.exchange,
                }))}
                title="Zerodha India Basket TradingView URLs"
                ariaLabel="Open Zerodha India basket TradingView URL list"
              />
            </div>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Sell All and Trim actionables are pre-selected. Buy New and Buy More rows auto-select only when the Final Score is greater than the Buy threshold. Review the basket here, use protected MARKET for all selected stocks by default whenever direct Kite Connect access is enabled during regular market hours, or switch back to the Publisher-safe protected LIMIT basket when needed.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {renderPlaceOrderButton()}
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-slate-200 p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              aria-label="Close Zerodha basket preview"
            >
              <X className="size-5" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-5">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
              <Loader2 className="size-4 animate-spin" /> Preparing Zerodha basket…
            </div>
          ) : orders.length ? (
            <>
              {error ? (
                <div className="mb-5 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                  {error}
                </div>
              ) : null}

              <div className={cn("mb-5 rounded-2xl border px-4 py-3 text-sm font-semibold", marketStatus.open ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800")}>
                {marketStatus.label}
              </div>

              {submission ? (
                <div className={cn("mb-5 rounded-2xl border px-4 py-3 text-sm", submission.executionMode === "direct_market" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-blue-200 bg-blue-50 text-blue-800")}>
                  {submission.executionMode === "direct_market" ? (
                    <div className="flex flex-col gap-1">
                      <div className="font-bold">Success: {submission.redirected} protected MARKET order{submission.redirected === 1 ? "" : "s"} completed in Kite.</div>
                      <div>Executed rows are highlighted green below so you can see which Trim/Sell/Buy transactions finished.</div>
                      {submission.portfolioRefreshedAt ? (
                        <div>Portfolio snapshot refreshed after execution; the latest holdings are available for the next Trim calculation.</div>
                      ) : null}
                      {submission.failedMessages?.length ? (
                        <div className="font-semibold text-amber-800">Failed: {submission.failedMessages.join("; ")}</div>
                      ) : null}
                    </div>
                  ) : (
                    <>
                      Created {submission.basketCount} Kite protected LIMIT basket tray{submission.basketCount === 1 ? "" : "s"} for {submission.redirected} selected order{submission.redirected === 1 ? "" : "s"}.
                      {submission.basketCount > 1 ? ` Each tray contains at most ${ZERODHA_KITE_PUBLISHER_BATCH_SIZE} orders; place every tray in Kite.` : ""}
                      {submission.clipboardCopied ? " A backup order checklist was copied to your clipboard." : " Use the table below as your backup manual-entry checklist if Kite rejects the basket payload."}
                    </>
                  )}
                </div>
              ) : null}

              <div className="mb-5 flex flex-col gap-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <div className="text-xs font-bold uppercase tracking-wide text-slate-500">Execution Mode</div>
                  <div className="mt-2 inline-flex rounded-full border border-slate-200 bg-white p-1 shadow-sm">
                    <button
                      type="button"
                      onClick={() => onExecutionModeChange("publisher_limit")}
                      className={cn(
                        "rounded-full px-4 py-2 text-sm font-semibold transition",
                        executionMode === "publisher_limit"
                          ? "bg-blue-600 text-white shadow-sm"
                          : "text-slate-600 hover:bg-slate-100",
                      )}
                    >
                      Protected LIMIT basket
                    </button>
                    <button
                      type="button"
                      onClick={() => canUseDirectMarket && onExecutionModeChange("direct_market")}
                      disabled={!canUseDirectMarket}
                      className={cn(
                        "rounded-full px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50",
                        executionMode === "direct_market"
                          ? "bg-emerald-600 text-white shadow-sm"
                          : "text-slate-600 hover:bg-slate-100",
                      )}
                    >
                      Protected MARKET for selected stocks
                    </button>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-slate-500">
                    {canUseDirectMarket
                      ? "Protected MARKET submits all selected rows directly with market_protection=-1. Per-row order type selectors still control the LIMIT basket fallback."
                      : directMarketAvailable
                        ? "Protected MARKET becomes available only while NSE/BSE regular trading is open."
                        : "Protected MARKET requires backend direct-order access from a Kite-whitelisted server egress IP."}
                  </p>
                </div>

                <div className="flex flex-col items-start gap-2 lg:items-end">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={onRefreshLtp}
                    disabled={!orders.length || ltpRefreshing || placing}
                    className="rounded-full border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700"
                  >
                    {ltpRefreshing ? (
                      <>
                        <Loader2 className="mr-2 size-4 animate-spin" />
                        Refreshing LTP…
                      </>
                    ) : (
                      "Refresh LTP"
                    )}
                  </Button>
                  <div className="text-xs text-slate-500">
                    {formatZerodhaLtpRefreshTime(ltpRefreshedAt)}
                  </div>
                  <div className="max-w-sm text-xs leading-5 text-slate-500 lg:text-right">
                    Refresh updates the preview and the next basket payload only. Any Kite basket tabs already opened keep showing Zerodha&apos;s own live LTP feed.
                  </div>
                </div>
              </div>

              <div className="mb-5 grid gap-3 md:grid-cols-4">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="text-xs font-bold uppercase tracking-wide text-slate-500">Selected Orders</div>
                  <div className="mt-2 text-2xl font-black text-slate-950">{selectedOrders.length}/{orders.length}</div>
                </div>
                <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-4">
                  <div className="text-xs font-bold uppercase tracking-wide text-emerald-700">Buy Basket</div>
                  <div className="mt-2 text-2xl font-black text-emerald-950">{formatBasketCurrency(selectedBuyAmount)}</div>
                </div>
                <div className="rounded-2xl border border-red-100 bg-red-50 p-4">
                  <div className="text-xs font-bold uppercase tracking-wide text-red-700">Sell Basket</div>
                  <div className="mt-2 text-2xl font-black text-red-950">{formatBasketCurrency(selectedSellAmount)}</div>
                </div>
                <div className="rounded-2xl border border-blue-100 bg-blue-50 p-4">
                  <label className="block text-xs font-bold uppercase tracking-wide text-blue-700" htmlFor="zerodha-buy-threshold">
                    Buy Threshold
                  </label>
                  <input
                    id="zerodha-buy-threshold"
                    type="number"
                    step="0.01"
                    value={buyThresholdDraft}
                    onChange={(event) => onBuyThresholdDraftChange(event.target.value)}
                    className="mt-2 w-full rounded-xl border border-blue-200 bg-white px-3 py-2 text-lg font-black text-slate-950 shadow-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
                    aria-label="Buy-side auto-select final score threshold"
                  />
                  <p className="mt-2 text-xs leading-5 text-blue-800">
                    Buy New and Buy More rows stay selected only when Final Score is greater than {buyThreshold.toFixed(2)}.
                  </p>
                </div>
              </div>

              <div className="overflow-hidden rounded-2xl border border-slate-200">
                <div className="overflow-x-auto overscroll-x-contain">
                  <table className="min-w-[92rem] w-full text-sm">
                    <thead>
                      <tr className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                        <th className="px-4 py-3 font-semibold">
                          <label className="inline-flex items-center gap-2 whitespace-nowrap">
                            <input
                              type="checkbox"
                              checked={allSelected}
                              onChange={onToggleAll}
                              aria-label="Select or deselect all Zerodha basket orders"
                              className="size-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                            />
                            <span>All Stocks</span>
                          </label>
                        </th>
                        <th className="px-4 py-3 font-semibold">Stock</th>
                        <th className="px-4 py-3 font-semibold">Score</th>
                        <th className="px-4 py-3 font-semibold">Consensus</th>
                        <th className="px-4 py-3 font-semibold">Action</th>
                        <th className="px-4 py-3 font-semibold">Side</th>
                        <th className="px-4 py-3 font-semibold">Units</th>
                        <th className="px-4 py-3 font-semibold">%</th>
                        <th className="px-4 py-3 font-semibold">Quoted LTP</th>
                        <th className="px-4 py-3 font-semibold">Limit Price</th>
                        <th className="px-4 py-3 font-semibold">Amount</th>
                        <th className="px-4 py-3 font-semibold">Order Type</th>
                        <th className="px-4 py-3 font-semibold">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {sectionGroups.map((group) => {
                        const sectionSelected = group.orders.filter((order) => selectedIds.has(order.id)).length;
                        const sectionAllSelected = sectionSelected === group.orders.length;
                        return (
                          <Fragment key={group.action}>
                            <tr className="border-y border-slate-200 bg-slate-100 text-slate-900">
                              <td className="px-4 py-3" colSpan={13}>
                                <label className="inline-flex items-center gap-3 text-sm font-black">
                                  <input
                                    type="checkbox"
                                    checked={sectionAllSelected}
                                    onChange={() => onToggleSection(group.action)}
                                    aria-label={`Select or deselect ${group.label} Zerodha basket orders`}
                                    className="size-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                                  />
                                  <span>{group.label}</span>
                                  <span className="text-xs font-semibold text-slate-500">{sectionSelected}/{group.orders.length} selected</span>
                                </label>
                              </td>
                            </tr>
                            {group.orders.map((order) => {
                              const isSubmitted = submittedOrderIds.has(order.id);
                              const isPlaced = placedOrderIds.has(order.id) || (submission?.executionMode === "publisher_limit" && isSubmitted);
                              return (
                              <tr key={order.id} className={cn("transition", isPlaced ? "bg-emerald-50/80 ring-1 ring-inset ring-emerald-100" : isSubmitted ? "bg-amber-50/70" : "bg-white")}>
                                <td className="px-4 py-3">
                                  <input
                                    type="checkbox"
                                    checked={selectedIds.has(order.id)}
                                    onChange={() => onToggle(order.id)}
                                    aria-label={`Select ${order.exchange} ${order.symbol}`}
                                    className="size-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                                  />
                                </td>
                                <td className="whitespace-nowrap px-4 py-3 font-bold text-slate-950">
                                  <div className="inline-flex items-center gap-1.5">
                                    <StockDetailsButton
                                      stock={order.stock}
                                      market="india"
                                      technicalScan={order.technicalScan}
                                      detailsData={detailsData}
                                    />
                                    <span className="text-xs font-semibold text-slate-500">{order.exchange}</span>
                                    <TradingViewSymbolLink
                                      symbol={order.symbol}
                                      market="india"
                                      exchange={order.exchange}
                                      className="underline-offset-4 transition hover:text-blue-700 hover:underline"
                                    >
                                      {order.symbol}
                                    </TradingViewSymbolLink>
                                  </div>
                                </td>
                                <td className="whitespace-nowrap px-4 py-3 font-semibold text-slate-800">
                                  <ScoreMatrixButton detail={order.detail} formulaConfig={formulaConfig} onOpenDetail={setSelectedMatrixDetail} />
                                </td>
                                <td className="whitespace-nowrap px-4 py-3">
                                  <ConsensusBreakupButton stock={order.stock} action={getZerodhaBasketActionForPercent(order)} />
                                </td>
                                <td className="whitespace-nowrap px-4 py-3 text-slate-700">{getZerodhaBasketActionForPercent(order)}</td>
                                <td className="px-4 py-3">
                                  <span className={cn(
                                    "rounded-full px-3 py-1 text-xs font-bold",
                                    order.side === "BUY" ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700",
                                  )}>
                                    {order.side}
                                  </span>
                                </td>
                                <td className="whitespace-nowrap px-4 py-3 text-slate-700">
                                  <div className="inline-flex items-center overflow-hidden rounded-full border border-slate-200 bg-white text-sm font-semibold shadow-sm">
                                    <button
                                      type="button"
                                      onClick={() => onUnitsChange(order.id, -1)}
                                      disabled={(order.units ?? 0) <= 1}
                                      className="px-2 py-1 text-slate-500 hover:bg-slate-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-40"
                                      aria-label={`Decrease ${order.exchange} ${order.symbol} units`}
                                    >
                                      -
                                    </button>
                                    <span className="min-w-10 px-2 py-1 text-center text-slate-800">
                                      {formatBasketQuantity(order.units)}
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => onUnitsChange(order.id, 1)}
                                      disabled={getZerodhaBasketUnitLimit(order) !== null && (order.units ?? 0) >= (getZerodhaBasketUnitLimit(order) ?? 0)}
                                      className="px-2 py-1 text-slate-500 hover:bg-slate-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-40"
                                      aria-label={`Increase ${order.exchange} ${order.symbol} units`}
                                    >
                                      +
                                    </button>
                                  </div>
                                </td>
                                <td className="px-4 py-3">
                                  {order.side === "SELL" ? (
                                    <button
                                      type="button"
                                      onClick={() => onPercentChange(order.id, order.percent >= 100 ? 50 : 100)}
                                      className="rounded-full border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
                                      aria-label={`Toggle ${order.exchange} ${order.symbol} basket percentage between trim and sell all`}
                                    >
                                      {formatBasketPercent(order.percent)}
                                    </button>
                                  ) : (
                                    <span className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700">
                                      {formatBasketPercent(order.percent)}
                                    </span>
                                  )}
                                </td>
                                <td className="whitespace-nowrap px-4 py-3 text-slate-700">{formatBasketCurrency(order.lastPrice)}</td>
                                <td className="whitespace-nowrap px-4 py-3 text-slate-700">{formatBasketCurrency(order.price)}</td>
                                <td className="whitespace-nowrap px-4 py-3 text-slate-700">{formatBasketCurrency(order.amount)}</td>
                                <td className="px-4 py-3">
                                  <select
                                    value={order.orderKind}
                                    onChange={(event) => onOrderKindChange(order.id, event.target.value as ZerodhaBasketOrderKind)}
                                    className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
                                  >
                                    {ZERODHA_ORDER_KINDS.map((orderKind) => (
                                      <option key={orderKind} value={orderKind}>
                                        {orderKind}
                                      </option>
                                    ))}
                                  </select>
                                </td>
                                <td className="whitespace-nowrap px-4 py-3 text-xs font-semibold text-slate-600">
                                  {isPlaced ? (
                                    <span className="inline-flex rounded-full bg-emerald-100 px-3 py-1 font-bold text-emerald-800">{submission?.executionMode === "direct_market" ? "Completed in Kite" : "Sent to protected LIMIT tray"}</span>
                                  ) : isSubmitted ? (
                                    <span className="inline-flex rounded-full bg-amber-100 px-3 py-1 font-bold text-amber-800">Failed / check Kite</span>
                                  ) : (
                                    <span>Pending</span>
                                  )}
                                </td>
                              </tr>
                              );
                            })}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : (
            error ? (
              <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                {error}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-12 text-center text-sm text-slate-500">
                No Sell All, Trim, Add more, or Buy New Zerodha actionables are available yet.
              </div>
            )
          )}
        </div>

        <div className="flex shrink-0 flex-col gap-3 border-t border-slate-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
          <div className="min-w-0 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {executionMode === "direct_market"
              ? "Protected MARKET mode submits every selected stock through the backend using Kite Connect with market_protection=-1 during regular NSE/BSE hours. Access tokens never reach the browser."
              : "Publisher-safe fallback uses /connect/basket only for protected LIMIT orders. Each limit price mirrors the latest available quoted LTP before basket submission, so stale recommendation prices are never used as execution prices. Kite can still show a newer live LTP after the basket page opens."}
          </div>
          {renderPlaceOrderButton("w-full justify-center sm:w-auto")}
        </div>

        <ScoreMatrixModal
          detail={selectedMatrixDetail}
          formulaConfig={formulaConfig}
          onFormulaConfigChange={onFormulaConfigChange}
          onClose={() => setSelectedMatrixDetail(null)}
        />
      </div>
    </div>
  );
}

function IndMoneySnapshotDialog({
  open,
  saving,
  error,
  onClose,
  onContinue,
}: {
  open: boolean;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onContinue: (
    mode: IndMoneySyncMode,
    payload?: IndMoneyUsPortfolioSnapshotCreateRequest,
  ) => void;
}) {
  const [mode, setMode] = useState<IndMoneySyncMode>("reuse");
  const [rawText, setRawText] = useState("");

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-3xl bg-white p-5 shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold text-slate-950">
              Sync INDmoney US Portfolio
            </h3>
            <p className="mt-1 text-sm text-slate-500">
              Continue with the last saved snapshot or paste the latest INDmoney
              screen before the rebalance workflow runs.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <label className="rounded-2xl border border-slate-200 p-4 text-sm font-semibold text-slate-800">
            <input
              className="mr-2"
              type="radio"
              checked={mode === "reuse"}
              onChange={() => setMode("reuse")}
            />
            Continue with last snapshot
          </label>
          <label className="rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm font-semibold text-blue-900">
            <input
              className="mr-2"
              type="radio"
              checked={mode === "paste"}
              onChange={() => setMode("paste")}
            />
            Paste latest INDmoney snapshot
          </label>
        </div>

        {mode === "paste" ? (
          <textarea
            value={rawText}
            onChange={(event) => setRawText(event.target.value)}
            placeholder="Paste the copied INDmoney portfolio screen here..."
            className="mt-4 min-h-64 w-full resize-y rounded-2xl border border-blue-200 bg-white p-3 text-sm outline-none focus:border-blue-400"
          />
        ) : null}

        {error ? (
          <div className="mt-4 flex items-start gap-2 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        <div className="mt-5 flex justify-end gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={saving || (mode === "paste" && !rawText.trim())}
            onClick={() =>
              onContinue(
                mode,
                mode === "paste"
                  ? {
                      raw_text: rawText.trim(),
                      captured_at: new Date().toISOString(),
                    }
                  : undefined,
              )
            }
            className="rounded-full bg-slate-950 px-7 font-extrabold uppercase tracking-[0.18em] text-white hover:bg-slate-800"
          >
            {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            Continue Rebalance
          </Button>
        </div>
      </div>
    </div>
  );
}

function InputSelectionDialog({
  open,
  stage,
  candidates,
  selectedIds,
  usdInrRate,
  loading,
  onToggle,
  onToggleAll,
  onResetDefaults,
  onClose,
}: {
  open: boolean;
  stage: InputSelectionStage | null;
  candidates: InputSelectionCandidate[];
  selectedIds: Set<string>;
  usdInrRate: number;
  loading: boolean;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  onResetDefaults: () => void;
  onClose: () => void;
}) {
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const [expandedRunKeys, setExpandedRunKeys] = useState<Set<string>>(() => new Set());
  const allSelected =
    candidates.length > 0 &&
    candidates.every((candidate) => selectedIds.has(candidate.id));
  const someSelected = candidates.some((candidate) =>
    selectedIds.has(candidate.id),
  );
  const selectedCount = candidates.filter((candidate) =>
    selectedIds.has(candidate.id),
  ).length;

  const runGroups = useMemo(() => {
    const groups = new Map<
      string,
      {
        key: string;
        runId: number | null;
        title: string;
        timestamp: string | null;
        market?: SwingTradeMarket;
        candidates: InputSelectionCandidate[];
      }
    >();

    candidates.forEach((candidate) => {
      const key = candidate.run ? `run:${candidate.run.id}` : candidate.id;
      const existing = groups.get(key);
      if (existing) {
        existing.candidates.push(candidate);
        existing.market = existing.market ?? candidate.market;
        if (
          candidate.timestamp &&
          (!existing.timestamp || parseTimestampMs(candidate.timestamp) > parseTimestampMs(existing.timestamp))
        ) {
          existing.timestamp = candidate.timestamp;
        }
        return;
      }

      groups.set(key, {
        key,
        runId: candidate.run?.id ?? null,
        title: candidate.run ? getAutoRebalanceRunDisplayLabel(candidate.run) : candidate.jobNo,
        timestamp: candidate.timestamp,
        market: candidate.market,
        candidates: [candidate],
      });
    });

    return Array.from(groups.values()).sort((left, right) => {
      const leftIsUpcoming = left.candidates.some((candidate) => candidate.source === "next");
      const rightIsUpcoming = right.candidates.some((candidate) => candidate.source === "next");
      if (leftIsUpcoming !== rightIsUpcoming) return leftIsUpcoming ? -1 : 1;
      return parseTimestampMs(right.timestamp) - parseTimestampMs(left.timestamp);
    });
  }, [candidates]);

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someSelected && !allSelected;
    }
  }, [allSelected, someSelected]);

  if (!open || !stage) return null;

  const titleByStage: Record<InputSelectionStage, string> = {
    threats: "Select Threat Scan inputs",
    swing: "Select Swing Scan inputs",
    rebalance: "Select Rebalance Scan inputs",
    technical: "Select Technical Scan inputs",
    actionables: "Select Actionables inputs",
  };
  const rationaleByStage: Record<InputSelectionStage, string> = {
    threats:
      "Use the upcoming synced portfolio snapshot plus the latest saved snapshot so the threat model can score the freshest holdings and cash context.",
    swing:
      "Use the upcoming Threat Scan output plus the latest completed threat report so Swing Scan can avoid names blocked by current guardrails while still having fallback risk context.",
    rebalance:
      "Select all Swing Scan outputs run after the previous market close by default, plus the upcoming Swing Scan output when this workflow generates one, so Rebalance reviews the full fresh consensus candidate pool.",
    technical:
      "Use the upcoming Rebalance Scan output plus the latest completed rebalance output so Technical Scan validates the freshest proposed adds, trims, exits, and holds.",
    actionables:
      "Use the upcoming Technical Scan output plus the latest completed Rebalance Scan and Technical Scan outputs so final actionables can combine portfolio rebalance intent with current chart validation.",
  };

  const toggleRunGroup = (groupCandidates: InputSelectionCandidate[]) => {
    const groupAllSelected = groupCandidates.every((candidate) => selectedIds.has(candidate.id));
    groupCandidates.forEach((candidate) => {
      if (groupAllSelected ? selectedIds.has(candidate.id) : !selectedIds.has(candidate.id)) {
        onToggle(candidate.id);
      }
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-[28px] bg-white shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex shrink-0 items-start justify-between gap-4 px-6 pb-4 pt-6">
          <div>
            <h3 className="text-2xl font-extrabold tracking-tight text-slate-950">
              {titleByStage[stage]}
            </h3>
            <p className="mt-2 text-base text-slate-500">
              Choose which previous-stage outputs should be included in the next
              prompt.
            </p>
            <div className="mt-3 max-w-3xl rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium leading-6 text-amber-800">
              <span className="font-extrabold">Input selection rationale:</span>{" "}
              {rationaleByStage[stage]}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close input selection"
          >
            <X className="size-5" />
          </button>
        </div>
        <div className="mx-6 mb-4 flex shrink-0 items-center justify-between gap-3 rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm font-semibold text-blue-950">
          <span>
            {selectedCount} output{selectedCount === 1 ? "" : "s"} selected.
          </span>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-[0.18em] text-blue-950">
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allSelected}
                onChange={onToggleAll}
                aria-label="Select or deselect all inputs"
              />
              Select all
            </label>
            <button
              type="button"
              onClick={onResetDefaults}
              className="rounded-full border border-slate-300 bg-white px-5 py-2 text-xs font-extrabold uppercase tracking-[0.18em] text-slate-900 shadow-sm hover:bg-slate-50"
            >
              Reset defaults
            </button>
          </div>
        </div>
        <div className="mx-6 min-h-0 flex-1 overflow-auto rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
          {loading ? (
            <div className="flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white p-8 text-sm text-slate-500">
              <Loader2 className="size-4 animate-spin" /> Loading eligible
              outputs…
            </div>
          ) : candidates.length === 0 ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-8 text-sm text-slate-500">
              No eligible outputs are available yet.
            </div>
          ) : (
            <div className="space-y-3">
              {runGroups.map((group) => {
                const groupSelectedCount = group.candidates.filter((candidate) => selectedIds.has(candidate.id)).length;
                const groupAllSelected = groupSelectedCount === group.candidates.length;
                const expanded = expandedRunKeys.has(group.key);
                const statusSummary = Array.from(new Set(group.candidates.map((candidate) => candidate.status || "unknown"))).join(", ");
                const totalCostUsd = group.candidates.reduce(
                  (total, candidate) => total + (typeof candidate.costUsd === "number" ? candidate.costUsd : 0),
                  0,
                );

                return (
                  <div key={group.key} className="rounded-2xl border border-slate-200 bg-white shadow-sm">
                    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                      <input
                        type="checkbox"
                        checked={groupAllSelected}
                        onChange={() => toggleRunGroup(group.candidates)}
                        aria-label={`Select all LLM jobs in ${group.title}`}
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedRunKeys((current) => {
                            const next = new Set(current);
                            if (next.has(group.key)) next.delete(group.key);
                            else next.add(group.key);
                            return next;
                          })
                        }
                        className="flex items-center gap-2 rounded-full px-2 py-1 text-left font-extrabold text-slate-950 hover:bg-slate-100"
                        aria-expanded={expanded}
                        aria-label={`${expanded ? "Collapse" : "Expand"} ${group.title} LLM job details`}
                      >
                        {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                      </button>
                      {group.runId ? (
                        <Link
                          href={URLs.routes.console.runDetail(group.runId)}
                          className="font-extrabold text-slate-950 underline-offset-4 hover:text-blue-700 hover:underline"
                        >
                          {group.title}
                        </Link>
                      ) : (
                        <span className="font-extrabold text-slate-950">{group.title}</span>
                      )}
                      <span
                        className={cn(
                          "rounded-full border px-3 py-1 text-xs font-extrabold uppercase tracking-[0.14em]",
                          getInputMarketBadgeClass(group.market),
                        )}
                        title={`Scan market: ${getInputMarketLabel(group.market)}`}
                      >
                        {getInputMarketLabel(group.market)}
                      </span>
                      <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-bold text-blue-800">
                        {groupSelectedCount}/{group.candidates.length} LLM job{group.candidates.length === 1 ? "" : "s"} selected
                      </span>
                      <span className="text-sm text-slate-500">
                        {group.timestamp ? formatTimestamp(group.timestamp) : "Reserved for next output"}
                      </span>
                      <span className="text-sm capitalize text-slate-500">{statusSummary}</span>
                      <span className="ml-auto text-sm font-semibold text-slate-600">
                        {totalCostUsd > 0 ? `₹${(totalCostUsd * usdInrRate).toFixed(2)}` : "Cost n/a"}
                      </span>
                    </div>
                    {expanded ? (
                      <div className="border-t border-slate-100 px-4 pb-4 pt-2">
                        <table className="w-full min-w-[760px] text-left text-sm">
                          <thead className="text-xs font-extrabold uppercase tracking-wide text-slate-500">
                            <tr>
                              <th className="w-10 py-2 pr-3">Select</th>
                              <th className="px-3 py-2">Job</th>
                              <th className="px-3 py-2">Timestamp</th>
                              <th className="px-3 py-2">Status</th>
                              <th className="px-3 py-2">Market</th>
                              <th className="px-3 py-2">LLM / Source</th>
                              <th className="px-3 py-2">Cost (INR)</th>
                              <th className="px-3 py-2">Error</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {group.candidates.map((candidate) => (
                              <tr key={candidate.id} className={candidate.source === "next" ? "bg-blue-50/60" : "bg-white"}>
                                <td className="py-3 pr-3 align-top">
                                  <input
                                    type="checkbox"
                                    checked={selectedIds.has(candidate.id)}
                                    onChange={() => onToggle(candidate.id)}
                                    aria-label={`Select ${candidate.label}`}
                                  />
                                </td>
                                <td className="px-3 py-3 align-top font-semibold text-slate-900">{candidate.jobNo}</td>
                                <td className="px-3 py-3 align-top text-slate-600">
                                  {candidate.timestamp ? formatTimestamp(candidate.timestamp) : "Reserved for next output"}
                                </td>
                                <td className="px-3 py-3 align-top">
                                  <span className={cn("rounded-full px-2 py-1 text-xs font-semibold capitalize ring-1", getInputStatusBadgeClass(candidate.status))}>
                                    {candidate.status}
                                  </span>
                                </td>
                                <td className="px-3 py-3 align-top">
                                  <span className={cn("rounded-full border px-2 py-1 text-xs font-bold", getInputMarketBadgeClass(candidate.market))}>
                                    {getInputMarketLabel(candidate.market)}
                                  </span>
                                </td>
                                <td className="px-3 py-3 align-top text-slate-700">{candidate.label}</td>
                                <td className="px-3 py-3 align-top text-slate-600">
                                  {typeof candidate.costUsd === "number" ? `₹${(candidate.costUsd * usdInrRate).toFixed(2)}` : "n/a"}
                                </td>
                                <td className="max-w-xs px-3 py-3 align-top text-xs text-red-700">{candidate.error || "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="flex shrink-0 justify-end px-6 py-5">
          <Button
            type="button"
            onClick={onClose}
            className="rounded-full bg-slate-950 px-7 font-extrabold uppercase tracking-[0.18em] text-white hover:bg-slate-800"
          >
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}

function RebalanceFlowIcon({ className = "size-5" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="5"
    >
      <circle cx="32" cy="13" r="9" />
      <circle cx="15" cy="47" r="9" />
      <circle cx="52" cy="38" r="9" />
      <path d="M32 22v12" />
      <path d="M23 34h29" />
      <path d="M15 38v-4h17" />
    </svg>
  );
}

function ZerodhaRebalanceFlowCard() {
  const [visible, setVisible] = useState(false);
  const legendItems = [
    {
      label: "Primary workflow",
      description: "Blue solid arrows show the main stage handoff.",
      sample: (
        <span
          className="h-0.5 w-12 rounded-full bg-blue-600"
          aria-hidden="true"
        />
      ),
    },
    {
      label: "Opportunity signals",
      description: "Teal dotted arrows carry swing conviction into rebalance.",
      sample: (
        <span
          className="h-0 w-12 border-t-2 border-dotted border-teal-600"
          aria-hidden="true"
        />
      ),
    },
    {
      label: "Risk / guardrails",
      description: "Red dashed arrows highlight constraints and safety checks.",
      sample: (
        <span
          className="h-0 w-12 border-t-2 border-dashed border-red-500"
          aria-hidden="true"
        />
      ),
    },
    {
      label: "Grouped cards",
      description: "Rounded cards group lanes, guardrails, and final outputs.",
      sample: (
        <span
          className="h-8 w-12 rounded-2xl border border-slate-300 bg-slate-100"
          aria-hidden="true"
        />
      ),
    },
  ];

  const stageCards = [
    {
      stage: "sync",
      x: 64,
      y: 214,
      width: 190,
      height: 92,
      fill: "#eff6ff",
      stroke: "#93c5fd",
      accent: "#1d4ed8",
    },
    {
      stage: "threats",
      x: 326,
      y: 98,
      width: 220,
      height: 92,
      fill: "#fff1f2",
      stroke: "#fda4af",
      accent: "#be123c",
    },
    {
      stage: "swing",
      x: 326,
      y: 354,
      width: 220,
      height: 92,
      fill: "#ecfeff",
      stroke: "#5eead4",
      accent: "#0f766e",
    },
    {
      stage: "rebalance",
      x: 634,
      y: 214,
      width: 220,
      height: 92,
      fill: "#eff6ff",
      stroke: "#93c5fd",
      accent: "#1d4ed8",
    },
    {
      stage: "technical",
      x: 886,
      y: 214,
      width: 220,
      height: 92,
      fill: "#f8fafc",
      stroke: "#94a3b8",
      accent: "#334155",
    },
  ] satisfies Array<{
    stage: WorkflowStageKey;
    x: number;
    y: number;
    width: number;
    height: number;
    fill: string;
    stroke: string;
    accent: string;
  }>;

  const downstreamOutputs = [
    {
      title: "Buy / Add",
      subtitleLines: ["Validated adds with", "supportive setup quality."],
      y: 170,
      fill: "#f0fdf4",
      stroke: "#86efac",
      accent: "#15803d",
    },
    {
      title: "Sell / Trim",
      subtitleLines: ["Risk-led reductions or", "technically weak names."],
      y: 255,
      fill: "#fff1f2",
      stroke: "#fda4af",
      accent: "#be123c",
    },
    {
      title: "Hold / Watch",
      subtitleLines: ["Neutral names needing", "confirmation before action."],
      y: 340,
      fill: "#fffbeb",
      stroke: "#fcd34d",
      accent: "#b45309",
    },
  ];

  return (
    <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-950">
            Zerodha Rebalance Flow
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Follow how the latest sync splits into risk and opportunity lanes,
            converges in rebalance, and exits as validated actionables.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => setVisible((current) => !current)}
          aria-expanded={visible}
          className="rounded-full"
        >
          <RebalanceFlowIcon className="mr-2 size-5" />
          {visible ? "Hide" : "Show"} Zerodha Rebalance Flow
        </Button>
      </div>

      {visible ? (
        <div className="mt-5 rounded-[24px] border border-slate-200 bg-slate-50 p-4">
          <div className="grid gap-3 rounded-[20px] border border-slate-200 bg-white/90 p-4 sm:grid-cols-2 xl:grid-cols-4">
            {legendItems.map((item) => (
              <div key={item.label} className="flex items-start gap-3">
                <span className="mt-1 flex h-8 w-12 items-center justify-center">
                  {item.sample}
                </span>
                <div>
                  <p className="text-sm font-semibold text-slate-900">
                    {item.label}
                  </p>
                  <p className="text-xs leading-5 text-slate-500">
                    {item.description}
                  </p>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 overflow-x-auto">
            <svg
              viewBox="0 0 1360 520"
              role="img"
              aria-labelledby="zerodha-rebalance-flow-title zerodha-rebalance-flow-desc"
              className="min-w-[1040px]"
            >
              <title id="zerodha-rebalance-flow-title">
                Zerodha rebalance workflow from sync through threats, swing,
                rebalance, technical validation, and final actionables.
              </title>
              <desc id="zerodha-rebalance-flow-desc">
                The sync stage feeds a risk and guardrail lane plus an
                opportunity lane. Those inputs combine in rebalance, move
                through technical validation, and finally publish buy or add,
                sell or trim, and hold or watch outputs.
              </desc>
              <defs>
                <marker
                  id="flow-arrow-teal"
                  markerHeight="8"
                  markerWidth="8"
                  orient="auto"
                  refX="7"
                  refY="4"
                >
                  <path d="M0,0 L8,4 L0,8 Z" fill="#0f766e" />
                </marker>
                <marker
                  id="flow-arrow-blue"
                  markerHeight="8"
                  markerWidth="8"
                  orient="auto"
                  refX="7"
                  refY="4"
                >
                  <path d="M0,0 L8,4 L0,8 Z" fill="#2563eb" />
                </marker>
                <marker
                  id="flow-arrow-red"
                  markerHeight="8"
                  markerWidth="8"
                  orient="auto"
                  refX="7"
                  refY="4"
                >
                  <path d="M0,0 L8,4 L0,8 Z" fill="#dc2626" />
                </marker>
              </defs>

              <rect
                x="12"
                y="12"
                width="1336"
                height="496"
                rx="32"
                fill="#f8fafc"
                stroke="#e2e8f0"
                strokeWidth="2"
              />
              <rect
                x="286"
                y="52"
                width="300"
                height="184"
                rx="28"
                fill="#fff5f5"
                stroke="#fecaca"
                strokeWidth="2"
              />
              <rect
                x="286"
                y="284"
                width="300"
                height="184"
                rx="28"
                fill="#ecfeff"
                stroke="#99f6e4"
                strokeWidth="2"
              />
              <rect
                x="1124"
                y="92"
                width="200"
                height="336"
                rx="28"
                fill="#ffffff"
                stroke="#cbd5e1"
                strokeWidth="2"
              />

              <text
                x="316"
                y="88"
                fill="#881337"
                fontSize="15"
                fontWeight="700"
              >
                Risk / guardrail lane
              </text>
              <text x="316" y="112" fill="#9f1239" fontSize="12">
                Threats decide what should block adds, force trims, or preserve
                cash.
              </text>
              <text
                x="316"
                y="320"
                fill="#115e59"
                fontSize="15"
                fontWeight="700"
              >
                Opportunity lane
              </text>
              <text x="316" y="344" fill="#0f766e" fontSize="12">
                Swing scan surfaces where fresh capital or adds have the best
                setup.
              </text>
              <text
                x="1152"
                y="128"
                fill="#334155"
                fontSize="12"
                fontWeight="700"
              >
                Step 06
              </text>
              <text
                x="1152"
                y="152"
                fill="#0f172a"
                fontSize="18"
                fontWeight="700"
              >
                Actionables
              </text>
              <text x="1152" y="174" fill="#475569" fontSize="12">
                <tspan x="1152" dy="0">
                  Publish the validated outputs
                </tspan>
                <tspan x="1152" dy="16">
                  traders actually execute.
                </tspan>
              </text>

              <path
                d="M254 242 C290 242 290 144 326 144"
                fill="none"
                stroke="#2563eb"
                strokeLinecap="round"
                strokeWidth="4"
                markerEnd="url(#flow-arrow-blue)"
              />
              <path
                d="M436 190 C436 242 436 302 436 354"
                fill="none"
                stroke="#2563eb"
                strokeLinecap="round"
                strokeWidth="4"
                markerEnd="url(#flow-arrow-blue)"
              />
              <path
                d="M546 400 C598 400 598 260 634 260"
                fill="none"
                stroke="#2563eb"
                strokeLinecap="round"
                strokeWidth="4"
                markerEnd="url(#flow-arrow-blue)"
              />
              <path
                d="M854 260 H886"
                fill="none"
                stroke="#2563eb"
                strokeLinecap="round"
                strokeWidth="4"
                markerEnd="url(#flow-arrow-blue)"
              />
              <path
                d="M1106 260 H1124"
                fill="none"
                stroke="#2563eb"
                strokeLinecap="round"
                strokeWidth="4"
                markerEnd="url(#flow-arrow-blue)"
              />

              <path
                d="M546 144 C612 160 628 212 634 232"
                fill="none"
                stroke="#dc2626"
                strokeDasharray="7 7"
                strokeLinecap="round"
                strokeWidth="4"
                markerEnd="url(#flow-arrow-red)"
              />
              <path
                d="M546 400 C612 382 624 314 634 286"
                fill="none"
                stroke="#0f766e"
                strokeDasharray="2 10"
                strokeLinecap="round"
                strokeWidth="4"
                markerEnd="url(#flow-arrow-teal)"
              />

              <path
                d="M794 168 L794 214"
                fill="none"
                stroke="#dc2626"
                strokeDasharray="7 7"
                strokeLinecap="round"
                strokeWidth="3"
              />
              <path
                d="M998 306 L998 340"
                fill="none"
                stroke="#dc2626"
                strokeDasharray="7 7"
                strokeLinecap="round"
                strokeWidth="3"
              />

              <path
                d="M724 152 H864"
                fill="none"
                stroke="#cbd5e1"
                strokeDasharray="4 8"
                strokeLinecap="round"
                strokeWidth="2"
              />
              <text
                x="564"
                y="132"
                fill="#9f1239"
                fontSize="12"
                fontWeight="700"
              >
                Risk inputs into rebalance
              </text>
              <text x="564" y="154" fill="#881337" fontSize="12">
                Threat score, downside flags, concentration and cash discipline.
              </text>
              <text
                x="564"
                y="402"
                fill="#115e59"
                fontSize="12"
                fontWeight="700"
              >
                Opportunity signals into rebalance
              </text>
              <text x="564" y="424" fill="#0f766e" fontSize="12">
                Setup quality, momentum, catalysts, and relative strength.
              </text>

              <rect
                x="688"
                y="96"
                width="212"
                height="72"
                rx="18"
                fill="#ffffff"
                stroke="#fca5a5"
                strokeDasharray="7 6"
                strokeWidth="2"
              />
              <text
                x="708"
                y="122"
                fill="#991b1b"
                fontSize="12"
                fontWeight="700"
              >
                Allocation guardrails
              </text>
              <text x="708" y="142" fill="#b91c1c" fontSize="12">
                Cash buffer, sector caps, and position sizing stay explicit.
              </text>

              <rect
                x="906"
                y="340"
                width="216"
                height="72"
                rx="18"
                fill="#ffffff"
                stroke="#fca5a5"
                strokeDasharray="7 6"
                strokeWidth="2"
              />
              <text
                x="926"
                y="366"
                fill="#991b1b"
                fontSize="12"
                fontWeight="700"
              >
                Execution guardrails
              </text>
              <text x="926" y="386" fill="#b91c1c" fontSize="12">
                Confirm trend, respect staged exits, or leave names on watch.
              </text>

              {stageCards.map((stageCard) => {
                const stageMeta = STAGE_METADATA[stageCard.stage];
                return (
                  <g key={stageCard.stage}>
                    <rect
                      x={stageCard.x}
                      y={stageCard.y}
                      width={stageCard.width}
                      height={stageCard.height}
                      rx="24"
                      fill={stageCard.fill}
                      stroke={stageCard.stroke}
                      strokeWidth="2.5"
                    />
                    <rect
                      x={stageCard.x + 16}
                      y={stageCard.y + 16}
                      width="66"
                      height="24"
                      rx="12"
                      fill="#ffffff"
                      opacity="0.92"
                    />
                    <text
                      x={stageCard.x + 49}
                      y={stageCard.y + 32}
                      textAnchor="middle"
                      fill={stageCard.accent}
                      fontSize="12"
                      fontWeight="700"
                    >
                      Step {stageMeta.step}
                    </text>
                    <text
                      x={stageCard.x + 18}
                      y={stageCard.y + 56}
                      fill="#0f172a"
                      fontSize="18"
                      fontWeight="700"
                    >
                      {stageMeta.chartTitle}
                    </text>
                    <text
                      x={stageCard.x + 18}
                      y={stageCard.y + 74}
                      fill="#475569"
                      fontSize="12"
                    >
                      {stageMeta.chartLines.map((line, index) => (
                        <tspan
                          key={`${stageCard.stage}-${line}`}
                          x={stageCard.x + 18}
                          dy={index === 0 ? 0 : 16}
                        >
                          {line}
                        </tspan>
                      ))}
                    </text>
                  </g>
                );
              })}

              {downstreamOutputs.map((output) => (
                <g key={output.title}>
                  <rect
                    x="1148"
                    y={output.y}
                    width="152"
                    height="64"
                    rx="20"
                    fill={output.fill}
                    stroke={output.stroke}
                    strokeWidth="2"
                  />
                  <text
                    x="1170"
                    y={output.y + 26}
                    fill={output.accent}
                    fontSize="13"
                    fontWeight="700"
                  >
                    {output.title}
                  </text>
                  <text
                    x="1170"
                    y={output.y + 44}
                    fill="#475569"
                    fontSize="11.5"
                  >
                    {output.subtitleLines.map((line, index) => (
                      <tspan
                        key={`${output.title}-${line}`}
                        x="1170"
                        dy={index === 0 ? 0 : 14}
                      >
                        {line}
                      </tspan>
                    ))}
                  </text>
                </g>
              ))}
            </svg>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AutoRebalanceCostHistoryDialog({
  open,
  portfolio,
  groups,
  loading,
  error,
  usdInrRate,
  onClose,
}: {
  open: boolean;
  portfolio: WorkflowPortfolio | null;
  groups: AutoRebalanceScanGroup[];
  loading: boolean;
  error: string | null;
  usdInrRate: number;
  selectedGroup: AutoRebalanceScanGroup | null;
  onSelectGroup: (group: AutoRebalanceScanGroup) => void;
  onClose: () => void;
  onCloseBreakdown: () => void;
}) {
  const [collapsedRunIds, setCollapsedRunIds] = useState<Set<string>>(() => new Set());
  const [collapsedStageKeys, setCollapsedStageKeys] = useState<Set<string>>(() => new Set());

  if (!open || !portfolio) return null;
  const title = portfolio === "zerodha" ? "Zerodha scan cost history" : "INDmoney US scan cost history";
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="flex h-full w-full max-w-4xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 p-5">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-blue-600">
              Auto-rebalance history
            </p>
            <h3 className="mt-1 text-lg font-extrabold text-slate-950">{title}</h3>
            <p className="mt-1 text-sm text-slate-500">
              Each Run button press is tracked as an independent India or IndMoney US run.
              Each run section is split by stage, and each stage can list one or many LLM/source rows.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close auto-rebalance cost history"
          >
            <X className="size-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 py-12 text-sm text-slate-500">
              <Loader2 className="size-4 animate-spin" /> Loading runs…
            </div>
          ) : error ? (
            <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
          ) : groups.length === 0 ? (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
              No previous runs were found for this portfolio yet.
            </div>
          ) : (
            <div className="space-y-4">
              {groups.map((group) => {
                const runCollapsed = collapsedRunIds.has(group.id);

                return (
                  <section key={group.id} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                    <div className="flex flex-col gap-3 border-b border-slate-200 bg-slate-50/70 p-4 sm:flex-row sm:items-start sm:justify-between">
                      <div className="flex items-start gap-3">
                        <button
                          type="button"
                          onClick={() => {
                            setCollapsedRunIds((current) => {
                              const next = new Set(current);
                              if (next.has(group.id)) next.delete(group.id);
                              else next.add(group.id);
                              return next;
                            });
                          }}
                          className="mt-0.5 rounded-full p-1 text-slate-500 hover:bg-white hover:text-blue-700"
                          aria-expanded={!runCollapsed}
                          aria-label={`${runCollapsed ? "Expand" : "Collapse"} ${group.label}`}
                        >
                          {runCollapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
                        </button>
                        <div>
                          <h4 className="text-sm font-extrabold text-slate-950">
                            {group.label} · {formatTimestamp(group.timestamp)}
                          </h4>
                          <p className="mt-1 text-xs text-slate-500">
                            {group.items.length} cost item{group.items.length === 1 ? "" : "s"} · {group.items.reduce((total, item) => total + item.llmCount, 0)} LLM job{group.items.reduce((total, item) => total + item.llmCount, 0) === 1 ? "" : "s"}
                          </p>
                        </div>
                      </div>
                      <div className="text-left sm:text-right">
                        <p className="text-base font-extrabold text-emerald-700">
                          {formatInrCostFromUsd(group.totalCostUsd, usdInrRate)}
                        </p>
                        <p className="mt-1 text-[11px] font-bold uppercase tracking-[0.14em] text-slate-400">
                          Total incurred
                        </p>
                      </div>
                    </div>

                    {!runCollapsed ? (
                      <div className="overflow-x-auto">
                        <table className="min-w-full divide-y divide-slate-200 text-sm">
                          <thead className="bg-white text-left text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">
                            <tr>
                              <th className="px-4 py-3">Job No</th>
                              <th className="px-4 py-3">Stage/Scan</th>
                              <th className="px-4 py-3">LLM / Source</th>
                              <th className="px-4 py-3">Timestamp</th>
                              <th className="px-4 py-3 text-right">Cost</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 bg-white">
                            {groupAutoRebalanceItemsByStage(group.items).map((section) => {
                              const sectionKey = `${group.id}:${section.stage}`;
                              const sectionCollapsed = collapsedStageKeys.has(sectionKey);
                              const sectionCostUsd = section.items.reduce(
                                (total, item) => total + (item.costUsd ?? 0),
                                0,
                              );
                              const showSectionCost =
                                section.stage === "swing" || section.stage === "rebalance";

                              return (
                                <Fragment key={sectionKey}>
                                  <tr className="bg-blue-50/70">
                                    <td colSpan={5} className="px-4 py-2 text-[11px] font-extrabold uppercase tracking-[0.18em] text-blue-700">
                                      <span className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setCollapsedStageKeys((current) => {
                                              const next = new Set(current);
                                              if (next.has(sectionKey)) next.delete(sectionKey);
                                              else next.add(sectionKey);
                                              return next;
                                            });
                                          }}
                                          className="flex items-center gap-2 text-left hover:text-blue-900"
                                          aria-expanded={!sectionCollapsed}
                                          aria-label={`${sectionCollapsed ? "Expand" : "Collapse"} ${formatAutoRebalanceStageLabel(section.stage)} rows`}
                                        >
                                          {sectionCollapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
                                          <span>{formatAutoRebalanceStageLabel(section.stage)}</span>
                                        </button>
                                        {showSectionCost ? (
                                          <span className="text-emerald-700">
                                            Cumulative cost:{" "}
                                            {formatInrCostFromUsd(sectionCostUsd, usdInrRate)}
                                          </span>
                                        ) : null}
                                      </span>
                                    </td>
                                  </tr>
                                  {!sectionCollapsed
                                    ? section.items.map((item) => {
                                        const runHref = getAutoRebalanceItemRunHref(item);
                                        const llmHref = getAutoRebalanceItemLlmHref(item);
                                        return (
                                          <tr key={item.id} className="align-top">
                                            <td className="whitespace-nowrap px-4 py-3 font-semibold text-slate-700">
                                              <AutoRebalanceCostLink href={runHref}>
                                                {getAutoRebalanceItemJobNumber(item)}
                                              </AutoRebalanceCostLink>
                                            </td>
                                            <td className="px-4 py-3">
                                              <AutoRebalanceCostLink href={runHref} className="font-bold text-slate-950">
                                                {formatAutoRebalanceStageLabel(item.stage)}
                                              </AutoRebalanceCostLink>
                                              <p className="mt-1 text-xs capitalize text-slate-500">{item.status || "unknown"}</p>
                                            </td>
                                            <td className="min-w-56 px-4 py-3">
                                              <AutoRebalanceCostLink href={llmHref} className="font-semibold text-blue-700">
                                                {item.provider}/{item.model}
                                              </AutoRebalanceCostLink>
                                              <p className="mt-1 text-xs text-slate-500">
                                                {item.runId ? (item.jobId ? `Output section for job #${item.jobId}` : "Run-level source") : "Standalone source job"}
                                              </p>
                                            </td>
                                            <td className="whitespace-nowrap px-4 py-3 text-slate-600">{formatTimestamp(item.timestamp)}</td>
                                            <td className="whitespace-nowrap px-4 py-3 text-right font-extrabold text-emerald-700">
                                              {formatInrCostFromUsd(item.costUsd, usdInrRate)}
                                            </td>
                                          </tr>
                                        );
                                      })
                                    : null}
                                </Fragment>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    ) : null}
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StageLlmSelectorDialog({
  open,
  stage,
  portfolio,
  providers,
  selectedKeys,
  onToggle,
  onSelectAll,
  onClear,
  onResetDefaults,
  onReplaceSelection,
  onClose,
  lastRunCostInr,
  historicalEstimatedCostInrByTarget = {},
}: {
  open: boolean;
  stage: WorkflowStageKey | null;
  portfolio: WorkflowPortfolio | null;
  providers: ProviderInfo[];
  selectedKeys: Set<string>;
  onToggle: (key: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onResetDefaults: () => void;
  onReplaceSelection: (keys: Set<string>) => void;
  onClose: () => void;
  lastRunCostInr?: number | null;
  historicalEstimatedCostInrByTarget?: HistoricalLlmCostMapInr;
}) {
  const [savedMixes, setSavedMixes] = useState<SavedModelMix[]>(() =>
    readSavedModelMixes(),
  );
  const [selectedMixId, setSelectedMixId] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyEntries, setHistoryEntries] = useState<StageLlmHistoryEntry[]>([]);
  const [historyKey, setHistoryKey] = useState("");
  const usdInrRate = useUsdInrRate();
  const currentHistoryKey = stage && portfolio ? `${portfolio}:${stage}` : "";
  const activeHistoryOpen = historyOpen && historyKey === currentHistoryKey;
  const hasLastRunCost =
    typeof lastRunCostInr === "number" &&
    Number.isFinite(lastRunCostInr) &&
    lastRunCostInr > 0;
  const selectorScanLabel = stage
    ? getLlmSelectorScanLabel(stage, portfolio)
    : "this scan";
  const selectorTitle = stage
    ? getLlmSelectorTitle(stage, portfolio, lastRunCostInr)
    : "Select LLMs";
  const loadHistory = useCallback(async () => {
    if (!stage || !portfolio || !currentHistoryKey) return;
    if (historyKey === currentHistoryKey) {
      setHistoryOpen((current) => !current);
      if (historyEntries.length > 0) return;
    } else {
      setHistoryKey(currentHistoryKey);
      setHistoryEntries([]);
      setHistoryError(null);
      setHistoryOpen(true);
    }
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const runs = await fetchAllFullRuns();
      setHistoryEntries(buildStageLlmHistoryEntries(runs, stage, portfolio).slice(0, 60));
    } catch (error) {
      setHistoryError(normalizeError(error));
    } finally {
      setHistoryLoading(false);
    }
  }, [currentHistoryKey, historyEntries.length, historyKey, portfolio, stage]);

  const persistSavedMixes = useCallback((mixes: SavedModelMix[]) => {
    setSavedMixes(mixes);
    try {
      window.localStorage.setItem(MODEL_MIX_STORAGE_KEY, JSON.stringify(mixes));
    } catch {
      // Keep selector usable even when localStorage is unavailable.
    }
  }, []);

  const getEstimatedCostInr = useCallback(
    (providerName: string, model: string) => {
      const override = historicalEstimatedCostInrByTarget[`${providerName}::${model}`];
      if (typeof override === "number" && Number.isFinite(override)) {
        return override;
      }
      return providers.find((provider) => provider.name === providerName)
        ?.model_estimated_cost_inr?.[model];
    },
    [historicalEstimatedCostInrByTarget, providers],
  );

  if (!open || !stage) return null;

  const singleSelect = stage === "threats" || stage === "technical";
  const compatibleTargets = new Set(
    providers.flatMap((provider) =>
      provider.models
        .filter(
          (model) =>
            provider.configured &&
            provider.model_compatibility?.[model]?.compatible !== false,
        )
        .map((model) => `${provider.name}::${model}`),
    ),
  );
  const modelMixControls = (
    <LlmModelMixControls
      mixes={savedMixes}
      selectedMixId={selectedMixId}
      onApply={(id) => {
        if (!id || id === "none") {
          setSelectedMixId("");
          return;
        }
        const mix = savedMixes.find((item) => item.id === id);
        if (!mix) return;
        const filteredTargets = mix.targets.filter((target) =>
          compatibleTargets.has(target),
        );
        if (filteredTargets.length < mix.targets.length) {
          window.alert(
            "Some models in this mix are incompatible with current API access and were skipped.",
          );
        }
        if (singleSelect) {
          onReplaceSelection(new Set(filteredTargets.slice(0, 1)));
        } else {
          onReplaceSelection(new Set(filteredTargets));
        }
        setSelectedMixId(id);
      }}
      onSave={() => {
        const name = window.prompt("Name this model mix:");
        if (!name) return;
        const cleaned = name.trim();
        if (!cleaned) return;
        const targets = Array.from(selectedKeys);
        if (targets.length === 0) {
          window.alert("Select at least one model before saving a mix.");
          return;
        }
        const now = new Date().toISOString();
        const existing = savedMixes.find(
          (mix) => mix.name.toLowerCase() === cleaned.toLowerCase(),
        );
        if (existing) {
          const updated = { ...existing, name: cleaned, targets, updated_at: now };
          persistSavedMixes(
            savedMixes.map((mix) => (mix.id === existing.id ? updated : mix)),
          );
          setSelectedMixId(existing.id);
          return;
        }
        const created = {
          id: `mix_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
          name: cleaned,
          targets,
          updated_at: now,
        };
        persistSavedMixes([created, ...savedMixes]);
        setSelectedMixId(created.id);
      }}
      onEdit={() => {
        if (!selectedMixId) return;
        const current = savedMixes.find((mix) => mix.id === selectedMixId);
        if (!current) return;
        const name = window.prompt("Edit model mix name:", current.name);
        if (!name?.trim()) return;
        persistSavedMixes(
          savedMixes.map((mix) =>
            mix.id === selectedMixId
              ? { ...mix, name: name.trim(), updated_at: new Date().toISOString() }
              : mix,
          ),
        );
      }}
      onDelete={() => {
        if (!selectedMixId) return;
        const current = savedMixes.find((mix) => mix.id === selectedMixId);
        if (!window.confirm(`Delete model mix "${current?.name || selectedMixId}"?`)) {
          return;
        }
        persistSavedMixes(savedMixes.filter((mix) => mix.id !== selectedMixId));
        setSelectedMixId("");
      }}
    />
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 px-4 py-6 backdrop-blur-sm" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">
              {selectorTitle}
            </p>
            <h3 className="mt-1 text-xl font-bold text-slate-950">
              {getStageLabel(stage, "idle")}
            </h3>
            <p className="mt-1 text-sm text-slate-500">
              Choose the provider/model targets this dashboard stage should use.
            </p>
            {hasLastRunCost ? (
              <p className="mt-2 inline-flex rounded-full bg-emerald-50 px-3 py-1 text-sm font-semibold text-emerald-700 ring-1 ring-emerald-100">
                Last {selectorScanLabel} cost incurred: {formatInrCost(lastRunCostInr)}
              </p>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={loadHistory}
              className={cn(
                "rounded-full p-2 text-slate-500 hover:bg-blue-50 hover:text-blue-700",
                activeHistoryOpen ? "bg-blue-50 text-blue-700 ring-1 ring-blue-200" : "",
              )}
              aria-label={`Show LLM run history for ${selectorTitle}`}
              title={`${selectorTitle} run history`}
            >
              <History className="size-5" />
            </button>
            <button
              type="button"
              onClick={() => {
                setHistoryOpen(false);
                onClose();
              }}
              className="rounded-full p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
              aria-label="Close LLM selector"
            >
              <X className="size-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {activeHistoryOpen ? (
            <div className="mb-5 rounded-2xl border border-blue-100 bg-blue-50/50 p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h4 className="text-sm font-extrabold uppercase tracking-[0.16em] text-blue-900">LLM run history</h4>
                  <p className="mt-1 text-xs text-slate-600">Click any LLM tile to open that job on the run details page.</p>
                </div>
                {historyLoading ? <Loader2 className="size-4 animate-spin text-blue-700" /> : null}
              </div>
              {historyError ? (
                <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{historyError}</div>
              ) : historyLoading && historyEntries.length === 0 ? (
                <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">Loading LLM history…</div>
              ) : historyEntries.length === 0 ? (
                <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">No prior LLM jobs were found for this stage.</div>
              ) : (
                <div className="grid max-h-72 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
                  {historyEntries.map((entry) => (
                    <Link
                      key={entry.id}
                      href={`${URLs.routes.console.runDetail(entry.runId)}#llm-output-job-${entry.jobId}`}
                      className="rounded-2xl border border-slate-200 bg-white p-3 text-left shadow-sm transition hover:border-blue-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-xs font-extrabold uppercase tracking-[0.14em] text-slate-500">Run #{entry.runId} / Job #{entry.jobId}</p>
                          <p className="mt-1 truncate text-sm font-bold text-slate-950">{entry.provider}/{entry.model}</p>
                        </div>
                        <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-bold capitalize", getRunOutputStatusClass(entry.status))}>
                          {getRunOutputStatusLabel(entry.status)}
                        </span>
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-600">
                        <span>{entry.timestamp ? formatTimestamp(entry.timestamp) : "No timestamp"}</span>
                        <span>Runtime: {entry.runtime ?? "n/a"}</span>
                        <span>Cost: {formatInrCostFromUsd(entry.costUsd, usdInrRate)}</span>
                        <span>Status: {entry.rawStatus}</span>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          ) : null}
          <LlmModelSelectionPanel
            providers={providers}
            selectedKeys={selectedKeys}
            selectionMode={singleSelect ? "single" : "multiple"}
            emptyMessage="Loading provider models..."
            showBulkActions={!singleSelect}
            modelMixControls={modelMixControls}
            getEstimatedCostInr={getEstimatedCostInr}
            onToggle={onToggle}
            onSelectAll={singleSelect ? undefined : onSelectAll}
            onClear={onClear}
            costSummaryLabel="Estimated selected run"
            onToggleProvider={(providerName, models) => {
              const providerModelKeys = models.map(
                (model) => `${providerName}::${model}`,
              );
              const allSelected =
                providerModelKeys.length > 0 &&
                providerModelKeys.every((key) => selectedKeys.has(key));
              providerModelKeys.forEach((key) => {
                if (allSelected === selectedKeys.has(key)) {
                  onToggle(key);
                }
              });
            }}
          />
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-slate-200 px-6 py-4">
          <button
            type="button"
            onClick={onResetDefaults}
            className="rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Reset defaults
          </button>
          <Button
            type="button"
            onClick={onClose}
            className="rounded-full bg-slate-950 text-white hover:bg-slate-800"
          >
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}

export function RebalanceWorkflowSections({
  onDashboardRefresh,
}: {
  onDashboardRefresh: () => Promise<void>;
}) {
  const usdInrRate = useUsdInrRate();
  const [initialPersisted] = useState<PersistedWorkflow | null>(() =>
    readPersistedWorkflow(),
  );
  const initialRunningPortfolio = useMemo(
    () => getRestorableRunningPortfolio(initialPersisted),
    [initialPersisted],
  );
  const [states, setStates] = useState<
    Record<WorkflowPortfolio, WorkflowState>
  >(() =>
    initialRunningPortfolio && initialPersisted?.states
      ? initialPersisted.states
      : buildInitialStates(),
  );
  const [runningPortfolio, setRunningPortfolio] =
    useState<WorkflowPortfolio | null>(() => initialRunningPortfolio);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [indMoneySyncOnly, setIndMoneySyncOnly] = useState(false);
  const [now, setNow] = useState(0);
  const [workflowPaused, setWorkflowPaused] = useState(false);
  const [specificMode, setSpecificMode] = useState<
    Record<WorkflowPortfolio, boolean>
  >(() => ({
    zerodha:
      initialRunningPortfolio === "zerodha"
        ? Boolean(initialPersisted?.specificMode?.zerodha)
        : false,
    indmoneyUs:
      initialRunningPortfolio === "indmoneyUs"
        ? Boolean(initialPersisted?.specificMode?.indmoneyUs)
        : false,
  }));
  const [selectedStages, setSelectedStages] = useState<
    Record<WorkflowPortfolio, Set<WorkflowStageKey>>
  >(() => ({
    zerodha: new Set(
      initialRunningPortfolio === "zerodha"
        ? (initialPersisted?.selectedStages?.zerodha ?? [])
        : [],
    ),
    indmoneyUs: new Set(
      initialRunningPortfolio === "indmoneyUs"
        ? (initialPersisted?.selectedStages?.indmoneyUs ?? [])
        : [],
    ),
  }));
  const [selectedInputs, setSelectedInputs] = useState<
    Record<WorkflowPortfolio, Record<InputSelectionStage, Set<string>>>
  >(() => ({
    zerodha: {
      threats: new Set(
        initialRunningPortfolio === "zerodha"
          ? (initialPersisted?.selectedInputs?.zerodha?.threats ?? ["threats:next"])
          : ["threats:next"],
      ),
      swing: new Set(
        initialRunningPortfolio === "zerodha"
          ? (initialPersisted?.selectedInputs?.zerodha?.swing ?? ["swing:next"])
          : ["swing:next"],
      ),
      rebalance: new Set(
        initialRunningPortfolio === "zerodha"
          ? (initialPersisted?.selectedInputs?.zerodha?.rebalance ?? [
              "rebalance:next",
            ])
          : ["rebalance:next"],
      ),
      technical: new Set(
        initialRunningPortfolio === "zerodha"
          ? (initialPersisted?.selectedInputs?.zerodha?.technical ?? [
              "technical:next",
            ])
          : ["technical:next"],
      ),
      actionables: new Set(
        initialRunningPortfolio === "zerodha"
          ? (initialPersisted?.selectedInputs?.zerodha?.actionables ?? [
              "actionables:next",
            ])
          : ["actionables:next"],
      ),
    },
    indmoneyUs: {
      threats: new Set(
        initialRunningPortfolio === "indmoneyUs"
          ? (initialPersisted?.selectedInputs?.indmoneyUs?.threats ?? [
              "threats:next",
            ])
          : ["threats:next"],
      ),
      swing: new Set(
        initialRunningPortfolio === "indmoneyUs"
          ? (initialPersisted?.selectedInputs?.indmoneyUs?.swing ?? [
              "swing:next",
            ])
          : ["swing:next"],
      ),
      rebalance: new Set(
        initialRunningPortfolio === "indmoneyUs"
          ? (initialPersisted?.selectedInputs?.indmoneyUs?.rebalance ?? [
              "rebalance:next",
            ])
          : ["rebalance:next"],
      ),
      technical: new Set(
        initialRunningPortfolio === "indmoneyUs"
          ? (initialPersisted?.selectedInputs?.indmoneyUs?.technical ?? [
              "technical:next",
            ])
          : ["technical:next"],
      ),
      actionables: new Set(
        initialRunningPortfolio === "indmoneyUs"
          ? (initialPersisted?.selectedInputs?.indmoneyUs?.actionables ?? [
              "actionables:next",
            ])
          : ["actionables:next"],
      ),
    },
  }));
  const [lastAutoRebalanceCosts, setLastAutoRebalanceCosts] = useState<
    Record<WorkflowPortfolio, number | null>
  >(
    () =>
      initialPersisted?.lastAutoRebalanceCosts ?? {
        zerodha: null,
        indmoneyUs: null,
      },
  );
  const [inputDialog, setInputDialog] = useState<{
    portfolio: WorkflowPortfolio;
    stage: InputSelectionStage;
  } | null>(null);
  const [inputCandidates, setInputCandidates] = useState<
    InputSelectionCandidate[]
  >([]);
  const [inputCandidatesLoading, setInputCandidatesLoading] = useState(false);
  const [llmDialogStage, setLlmDialogStage] = useState<WorkflowStageKey | null>(
    null,
  );
  const [llmDialogPortfolio, setLlmDialogPortfolio] = useState<WorkflowPortfolio | null>(
    null,
  );
  const [llmDialogProviders, setLlmDialogProviders] = useState<ProviderInfo[]>(
    [],
  );
  const [llmDialogSelectedKeys, setLlmDialogSelectedKeys] = useState<
    Set<string>
  >(new Set());
  const [llmDialogHistoricalCosts, setLlmDialogHistoricalCosts] =
    useState<HistoricalLlmCostMapInr>({});
  const [costHistoryPortfolio, setCostHistoryPortfolio] = useState<WorkflowPortfolio | null>(null);
  const [costHistoryGroups, setCostHistoryGroups] = useState<AutoRebalanceScanGroup[]>([]);
  const [costHistoryLoading, setCostHistoryLoading] = useState(false);
  const [costHistoryError, setCostHistoryError] = useState<string | null>(null);
  const [selectedCostGroup, setSelectedCostGroup] = useState<AutoRebalanceScanGroup | null>(null);
  const [outputDialog, setOutputDialog] = useState<{
    portfolio: WorkflowPortfolio;
    stage: WorkflowStageKey;
    title: string;
    body: string;
    loading: boolean;
    error: string | null;
    routeUrl?: string | null;
    run?: RunResponse | null;
  } | null>(null);
  const [promptDialog, setPromptDialog] = useState<{
    portfolio: WorkflowPortfolio;
    stage: PromptPreviewStage;
    title: string;
    body: string;
  } | null>(null);
  const [zerodhaBasketOpen, setZerodhaBasketOpen] = useState(false);
  const [zerodhaBasketLoading, setZerodhaBasketLoading] = useState(false);
  const [zerodhaBasketPlacing, setZerodhaBasketPlacing] = useState(false);
  const [zerodhaBasketSubmission, setZerodhaBasketSubmission] = useState<ZerodhaBasketSubmission | null>(null);
  const [zerodhaBasketError, setZerodhaBasketError] = useState<string | null>(null);
  const [zerodhaBasketOrders, setZerodhaBasketOrders] = useState<ZerodhaBasketPreviewOrder[]>([]);
  const [zerodhaExecutionMode, setZerodhaExecutionMode] = useState<ZerodhaExecutionMode>("publisher_limit");
  const [zerodhaDirectMarketAvailable, setZerodhaDirectMarketAvailable] = useState(false);
  const [zerodhaBasketLtpRefreshing, setZerodhaBasketLtpRefreshing] = useState(false);
  const [zerodhaBasketLtpRefreshedAt, setZerodhaBasketLtpRefreshedAt] = useState<string | null>(null);
  const [zerodhaBasketDetailsData, setZerodhaBasketDetailsData] = useState<StockDetailsData>({
    portfolioSnapshot: null,
    eventsAnalysis: null,
    threatsAnalysis: null,
    error: null,
  });
  const [scoreMatrixFormulaConfig, setScoreMatrixFormulaConfig] = useState<ScoreMatrixFormulaConfig>(() => loadScoreMatrixFormulaConfig());
  const [zerodhaBasketBuyThreshold, setZerodhaBasketBuyThreshold] = useState(DEFAULT_ZERODHA_BUY_THRESHOLD);
  const [zerodhaBasketBuyThresholdDraft, setZerodhaBasketBuyThresholdDraft] = useState(
    DEFAULT_ZERODHA_BUY_THRESHOLD.toFixed(2),
  );
  const [selectedZerodhaBasketIds, setSelectedZerodhaBasketIds] = useState<Set<string>>(new Set());
  const activeExecutionRefsRef = useRef<Array<{ kind: "run" | "job"; id: number }>>([]);
  const cancelRequestedRef = useRef(false);
  const pauseRequestedRef = useRef(false);

  useEffect(() => {
    persistWorkflow({
      states,
      runningPortfolio,
      specificMode,
      selectedStages: {
        zerodha: Array.from(selectedStages.zerodha),
        indmoneyUs: Array.from(selectedStages.indmoneyUs),
      },
      selectedInputs: {
        zerodha: {
          threats: Array.from(selectedInputs.zerodha.threats),
          swing: Array.from(selectedInputs.zerodha.swing),
          rebalance: Array.from(selectedInputs.zerodha.rebalance),
          technical: Array.from(selectedInputs.zerodha.technical),
          actionables: Array.from(selectedInputs.zerodha.actionables),
        },
        indmoneyUs: {
          threats: Array.from(selectedInputs.indmoneyUs.threats),
          swing: Array.from(selectedInputs.indmoneyUs.swing),
          rebalance: Array.from(selectedInputs.indmoneyUs.rebalance),
          technical: Array.from(selectedInputs.indmoneyUs.technical),
          actionables: Array.from(selectedInputs.indmoneyUs.actionables),
        },
      },
      lastAutoRebalanceCosts,
      savedAt: new Date().toISOString(),
    });
  }, [
    lastAutoRebalanceCosts,
    runningPortfolio,
    selectedInputs,
    selectedStages,
    specificMode,
    states,
  ]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const isBusy = Boolean(runningPortfolio);

  const openAutoRebalanceCostHistory = useCallback(async (portfolio: WorkflowPortfolio) => {
    setCostHistoryPortfolio(portfolio);
    setSelectedCostGroup(null);
    setCostHistoryLoading(true);
    setCostHistoryError(null);
    try {
      const [runs, threatHistory] = await Promise.all([
        fetchAllFullRuns(),
        portfolio === "zerodha"
          ? apiService.zerodhaThreatsHistory({ limit: 200 })
          : apiService.indmoneyUsThreatsHistory({ limit: 200 }),
      ]);
      setCostHistoryGroups(
        buildAutoRebalanceScanGroups(runs, threatHistory.history ?? [], portfolio).slice(0, 40),
      );
    } catch (error) {
      setCostHistoryError(normalizeError(error));
      setCostHistoryGroups([]);
    } finally {
      setCostHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    saveScoreMatrixFormulaConfig(scoreMatrixFormulaConfig);
  }, [scoreMatrixFormulaConfig]);

  const handleScoreMatrixFormulaConfigChange = useCallback((updater: (current: ScoreMatrixFormulaConfig) => ScoreMatrixFormulaConfig) => {
    setScoreMatrixFormulaConfig((current) => {
      const next = updater(current);
      if (zerodhaBasketOpen && zerodhaBasketOrders.length > 0) {
        const currentOrders = zerodhaBasketOrders;

        const stocksByKey = new Map<string, StockConsensus>();
        const technicalScansBySymbol: Record<string, TechnicalScanResult> = {};
        currentOrders.forEach((order) => {
          stocksByKey.set(order.stock.key, order.stock);
          if (order.technicalScan) {
            technicalScansBySymbol[`SYMBOL:${order.symbol.toUpperCase()}`] = order.technicalScan;
            technicalScansBySymbol[`SYMBOL:${order.stock.symbol.toUpperCase()}`] = order.technicalScan;
          }
        });

        const actionRows = buildDashboardActionRows(
          [...stocksByKey.values()],
          "india",
          technicalScansBySymbol,
          next,
        );
        const rebuiltOrders = buildZerodhaBasketPreviewOrders(
          actionRows,
          technicalScansBySymbol,
          zerodhaBasketDetailsData.portfolioSnapshot as ZerodhaPortfolioSnapshotDetail | null,
        );
        const previousBySymbol = new Map(currentOrders.map((order) => [order.symbol, order]));
        const nextOrders = rebuiltOrders.map((order) => {
          const previousOrder = previousBySymbol.get(order.symbol);
          if (!previousOrder) return order;
          return applyZerodhaBasketLivePricing(
            {
              ...order,
              orderKind: previousOrder.orderKind,
            },
            previousOrder.price ?? order.price,
            previousOrder.lastPrice ?? order.lastPrice,
          );
        });
        setZerodhaBasketOrders(nextOrders);
        setSelectedZerodhaBasketIds(
          buildDefaultZerodhaBasketSelection(
            getZerodhaBasketSelectableOrders(nextOrders),
            zerodhaBasketBuyThreshold,
          ),
        );
      }
      setZerodhaBasketSubmission(null);
      return next;
    });
  }, [zerodhaBasketBuyThreshold, zerodhaBasketDetailsData.portfolioSnapshot, zerodhaBasketOpen, zerodhaBasketOrders]);

  const closeAutoRebalanceCostHistory = useCallback(() => {
    setCostHistoryPortfolio(null);
    setSelectedCostGroup(null);
    setCostHistoryError(null);
  }, []);

  const openZerodhaBasketPreview = useCallback(async () => {
    setZerodhaBasketOpen(true);
    setZerodhaBasketLoading(true);
    setZerodhaBasketError(null);
    setZerodhaBasketSubmission(null);
    setZerodhaBasketLtpRefreshedAt(null);
    setZerodhaDirectMarketAvailable(false);
    try {
      const [runs, overview, status, login] = await Promise.all([
        fetchAllFullRuns(),
        apiService.zerodhaPortfolioOverview(),
        apiService.zerodhaStatus(),
        apiService.zerodhaLoginUrl(),
      ]);
      const directMarketEnabled = Boolean(
        status.connected
          && login.configured
          && status.direct_market_orders_enabled
          && login.direct_market_orders_enabled,
      );
      setZerodhaDirectMarketAvailable(
        directMarketEnabled,
      );
      setZerodhaExecutionMode(directMarketEnabled && getIndiaMarketStatus().open ? "direct_market" : "publisher_limit");
      const [eventsResult, threatsResult] = await Promise.allSettled([
        apiService.zerodhaEventsLatest(),
        apiService.zerodhaThreatsLatest(),
      ]);
      const stocks = buildConsensusRows(
        getLatestMatchingRebalanceRuns(runs, "india"),
        "india",
        overview.latest,
      );
      const technicalScans = buildTechnicalScanMap(runs);
      const actionRows = buildDashboardActionRows(stocks, "india", technicalScans, scoreMatrixFormulaConfig);
      const orders = buildZerodhaBasketPreviewOrders(actionRows, technicalScans, overview.latest);
      const capturedDetailsErrors = [eventsResult, threatsResult]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => normalizeError(result.reason));
      setZerodhaBasketDetailsData({
        portfolioSnapshot: overview.latest,
        eventsAnalysis: eventsResult.status === "fulfilled" ? eventsResult.value.analysis : null,
        threatsAnalysis: threatsResult.status === "fulfilled" ? threatsResult.value.analysis : null,
        error: capturedDetailsErrors.length ? capturedDetailsErrors.join("; ") : null,
      });
      setZerodhaBasketOrders(orders);
      setSelectedZerodhaBasketIds(
        buildDefaultZerodhaBasketSelection(
          getZerodhaBasketSelectableOrders(orders),
          zerodhaBasketBuyThreshold,
        ),
      );
    } catch (error) {
      setZerodhaBasketOrders([]);
      setZerodhaDirectMarketAvailable(false);
      setZerodhaBasketDetailsData((current) => ({
        ...current,
        error: normalizeError(error),
      }));
      setSelectedZerodhaBasketIds(new Set());
      setZerodhaBasketError(`Could not prepare Zerodha basket: ${normalizeError(error)}`);
    } finally {
      setZerodhaBasketLoading(false);
    }
  }, [scoreMatrixFormulaConfig, zerodhaBasketBuyThreshold]);

  const updateZerodhaBasketBuyThresholdDraft = useCallback((value: string) => {
    setZerodhaBasketBuyThresholdDraft(value);
    const trimmedValue = value.trim();
    if (!trimmedValue) return;

    const parsed = Number(trimmedValue);
    if (!Number.isFinite(parsed)) return;

    setZerodhaBasketBuyThreshold(parsed);
    setZerodhaBasketSubmission(null);
    setSelectedZerodhaBasketIds((current) =>
      syncZerodhaBasketBuySelection(
        current,
        getZerodhaBasketSelectableOrders(zerodhaBasketOrders),
        parsed,
      ),
    );
  }, [zerodhaBasketOrders]);

  const toggleZerodhaBasketOrder = useCallback((id: string) => {
    setSelectedZerodhaBasketIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAllZerodhaBasketOrders = useCallback(() => {
    setSelectedZerodhaBasketIds((current) => {
      const allOrdersSelected = zerodhaBasketOrders.every((order) => current.has(order.id));
      if (allOrdersSelected) return new Set();
      return new Set(zerodhaBasketOrders.map((order) => order.id));
    });
  }, [zerodhaBasketOrders]);

  const toggleZerodhaBasketSection = useCallback(
    (action: ActionCategory) => {
      const sectionOrderIds = zerodhaBasketOrders
        .filter((order) => getZerodhaBasketActionForPercent(order) === action)
        .map((order) => order.id);
      setSelectedZerodhaBasketIds((current) => {
        const next = new Set(current);
        const sectionAllSelected = sectionOrderIds.every((id) => next.has(id));
        sectionOrderIds.forEach((id) => {
          if (sectionAllSelected) next.delete(id);
          else next.add(id);
        });
        return next;
      });
    },
    [zerodhaBasketOrders],
  );

  const updateZerodhaBasketOrderKind = useCallback(
    (id: string, orderKind: ZerodhaBasketOrderKind) => {
      setZerodhaBasketSubmission(null);
      setZerodhaBasketOrders((current) =>
        current.map((order) => (order.id === id ? { ...order, orderKind } : order)),
      );
    },
    [],
  );

  const updateZerodhaBasketPercent = useCallback(
    (id: string, percent: ZerodhaBasketOrderPercent) => {
      setZerodhaBasketSubmission(null);
      setZerodhaBasketOrders((current) =>
        current.map((order) => (order.id === id ? applyZerodhaBasketPercent(order, percent) : order)),
      );
    },
    [],
  );

  const updateZerodhaBasketUnits = useCallback(
    (id: string, delta: number) => {
      setZerodhaBasketSubmission(null);
      setZerodhaBasketOrders((current) =>
        current.map((order) => (order.id === id ? applyZerodhaBasketUnitDelta(order, delta) : order)),
      );
    },
    [],
  );

  const refreshZerodhaBasketLtp = useCallback(async () => {
    if (!zerodhaBasketOrders.length) return;
    setZerodhaBasketLtpRefreshing(true);
    setZerodhaBasketSubmission(null);
    setZerodhaBasketError(null);
    try {
      const preparedOrders = await prepareZerodhaBasketOrdersForKite(zerodhaBasketOrders);
      setZerodhaBasketOrders((current) => mergePreparedZerodhaBasketOrders(current, preparedOrders));
      setZerodhaBasketLtpRefreshedAt(new Date().toISOString());
    } catch (error) {
      setZerodhaBasketError(`Could not refresh live LTP: ${normalizeError(error)}`);
    } finally {
      setZerodhaBasketLtpRefreshing(false);
    }
  }, [zerodhaBasketOrders]);

  const changeZerodhaExecutionMode = useCallback((mode: ZerodhaExecutionMode) => {
    setZerodhaExecutionMode(mode);
    setZerodhaBasketSubmission(null);
    setZerodhaBasketError(null);
  }, []);

  const placeSelectedZerodhaBasketOrders = useCallback(async () => {
    const selectedOrders = zerodhaBasketOrders
      .filter((order) => selectedZerodhaBasketIds.has(order.id))
      .sort(compareZerodhaBasketOrdersByScore);
    if (!selectedOrders.length) {
      window.alert("Select at least one Zerodha basket row before opening Kite.");
      return;
    }
    const scoreWarningMessage = buildZerodhaBasketScoreWarningMessage(selectedOrders);
    if (scoreWarningMessage) {
      window.alert(scoreWarningMessage);
    }
    const marketStatus = getIndiaMarketStatus();
    const orderChunks = chunkZerodhaBasketOrders(selectedOrders);
    const shouldContinue = window.confirm(
      `${marketStatus.label}

${zerodhaExecutionMode === "direct_market"
  ? `This will place ${selectedOrders.length} selected Zerodha protected MARKET order${selectedOrders.length === 1 ? "" : "s"} directly through Kite Connect with market_protection=-1. Continue?`
  : `This will open ${orderChunks.length} Kite protected LIMIT basket tray${orderChunks.length === 1 ? "" : "s"} for ${selectedOrders.length} selected Zerodha order${selectedOrders.length === 1 ? "" : "s"}. Orders are split into batches of ${ZERODHA_KITE_PUBLISHER_BATCH_SIZE} so Kite does not leave later rows unsubmitted. Review and place every tray inside Kite. Continue?`}`,
    );
    if (!shouldContinue) return;

    setZerodhaBasketPlacing(true);
    setZerodhaBasketSubmission(null);
    setZerodhaBasketError(null);

    if (zerodhaExecutionMode === "direct_market") {
      if (!marketStatus.open) {
        setZerodhaBasketPlacing(false);
        setZerodhaBasketError("Protected MARKET orders are available only during regular NSE/BSE trading hours. Switch back to the protected LIMIT basket after market close.");
        return;
      }
      try {
        const response = await apiService.zerodhaPlaceProtectedMarketOrders({
          orders: selectedOrders.map((order) => ({
            tradingsymbol: order.symbol.toUpperCase(),
            exchange: order.exchange.toUpperCase() as "NSE" | "BSE",
            transaction_type: order.side,
            quantity: Math.max(1, Math.floor(order.units ?? 0)),
            product: "CNC",
            validity: "DAY",
            market_protection: ZERODHA_DEFAULT_MARKET_PROTECTION,
          })),
        });
        const failed = response.results.filter((result) => result.status === "failed");
        const placedResultKeys = new Set(
          response.results
            .filter((result) => result.status === "placed")
            .map((result) => `${result.exchange.toUpperCase()}:${result.tradingsymbol.toUpperCase()}:${result.transaction_type}`),
        );
        const placedOrders = selectedOrders.filter((order) =>
          placedResultKeys.has(`${order.exchange.toUpperCase()}:${order.symbol.toUpperCase()}:${order.side}`),
        );
        const failedMessages = failed.map((result) => `${result.tradingsymbol}: ${result.error || "unknown error"}`);
        let portfolioRefreshedAt: string | null = null;

        if (response.placed_count > 0) {
          try {
            const previousOverview = await apiService.zerodhaPortfolioOverview();
            await apiService.zerodhaSyncPortfolio();
            const overview = await waitForZerodhaPortfolioSync(previousOverview.latest?.captured_at);
            portfolioRefreshedAt = overview.latest?.captured_at ?? null;
            setZerodhaBasketDetailsData((current) => ({
              ...current,
              portfolioSnapshot: overview.latest,
            }));
          } catch (syncError) {
            failedMessages.push(`Portfolio refresh after order placement did not complete: ${normalizeError(syncError)}`);
          }
        }

        setZerodhaBasketSubmission({
          executionMode: "direct_market",
          redirected: response.placed_count,
          basketCount: 0,
          clipboardCopied: false,
          orders: selectedOrders,
          placedOrderIds: placedOrders.map((order) => order.id),
          failedMessages,
          portfolioRefreshedAt,
        });
        if (failed.length) {
          setZerodhaBasketError(`Placed ${response.placed_count} protected MARKET order${response.placed_count === 1 ? "" : "s"}; ${response.failed_count} failed: ${failedMessages.join("; ")}`);
        }
      } catch (error) {
        setZerodhaBasketError(`Could not place protected MARKET orders: ${normalizeError(error)}. Use the Publisher-safe protected LIMIT fallback if direct order placement is unavailable.`);
      } finally {
        setZerodhaBasketPlacing(false);
      }
      return;
    }

    const kiteTargetPrefix = `zerodha-basket-${Date.now()}`;
    const kiteWindows = orderChunks.map((_, index) => {
      const targetName = `${kiteTargetPrefix}-${index + 1}`;
      return {
        targetName,
        win: window.open("about:blank", targetName),
      };
    });
    if (kiteWindows.some((entry) => !entry.win)) {
      kiteWindows.forEach((entry) => entry.win?.close());
      setZerodhaBasketPlacing(false);
      setZerodhaBasketError(`Your browser blocked one or more Kite basket popups. Allow popups for this site, then try the protected LIMIT basket again. ${orderChunks.length} popup${orderChunks.length === 1 ? "" : "s"} required for the selected rows.`);
      return;
    }
    kiteWindows.forEach((entry) => {
      if (entry.win) entry.win.opener = null;
    });

    try {
      const login = await apiService.zerodhaLoginUrl();
      const apiKey = login.configured ? getZerodhaPublisherApiKey(login.login_url) : null;
      if (!apiKey) {
        kiteWindows.forEach((entry) => entry.win?.close());
        setZerodhaBasketError("Zerodha Kite Publisher is not configured. Add ZERODHA_API_KEY on the backend and try again.");
        return;
      }

      const preparedOrders = await prepareZerodhaBasketOrdersForKite(selectedOrders);
      setZerodhaBasketOrders((current) => mergePreparedZerodhaBasketOrders(current, preparedOrders));
      setZerodhaBasketLtpRefreshedAt(new Date().toISOString());
      const preparedChunks = chunkZerodhaBasketOrders(preparedOrders);

      let clipboardCopied = false;
      try {
        clipboardCopied = await copyZerodhaKiteBasketToClipboard(preparedOrders, marketStatus.open);
      } catch {
        clipboardCopied = false;
      }

      preparedChunks.forEach((chunk, index) => {
        postZerodhaKiteBasket(apiKey, chunk, marketStatus.open, kiteWindows[index].targetName);
      });

      setZerodhaBasketSubmission({
        executionMode: "publisher_limit",
        redirected: preparedOrders.length,
        basketCount: preparedChunks.length,
        clipboardCopied,
        orders: preparedOrders,
      });
    } catch (error) {
      kiteWindows.forEach((entry) => entry.win?.close());
      setZerodhaBasketError(`Could not open the Kite order basket: ${normalizeError(error)}`);
    } finally {
      setZerodhaBasketPlacing(false);
    }
  }, [selectedZerodhaBasketIds, zerodhaBasketOrders, zerodhaExecutionMode]);

  const loadLatestIdleStageInfo = useCallback(async () => {
    const [
      zerodhaOverviewResult,
      indmoneyOverviewResult,
      zerodhaThreatResult,
      indmoneyThreatResult,
      runsResult,
    ] = await Promise.allSettled([
      apiService.zerodhaPortfolioOverview(),
      apiService.indmoneyUsPortfolioOverview(),
      apiService.zerodhaThreatsLatest(),
      apiService.indmoneyUsThreatsLatest(),
      fetchAllFullRuns(),
    ]);

    const zerodhaOverview =
      zerodhaOverviewResult.status === "fulfilled"
        ? zerodhaOverviewResult.value
        : null;
    const indmoneyOverview =
      indmoneyOverviewResult.status === "fulfilled"
        ? indmoneyOverviewResult.value
        : null;
    const zerodhaThreat =
      zerodhaThreatResult.status === "fulfilled" ? zerodhaThreatResult.value : null;
    const indmoneyThreat =
      indmoneyThreatResult.status === "fulfilled"
        ? indmoneyThreatResult.value
        : null;
    const runs = runsResult.status === "fulfilled" ? runsResult.value : [];

    const nextByPortfolio = (
      ["zerodha", "indmoneyUs"] as WorkflowPortfolio[]
    ).reduce(
      (acc, portfolio) => {
        const market: SwingTradeMarket =
          portfolio === "zerodha" ? "india" : "us";
        const latestSwingRun = getLatestStageRun(runs, "swing", market);
        const latestRebalanceRun = getLatestStageRun(runs, "rebalance", market);
        const latestTechnicalRun = getLatestStageRun(runs, "technical", market);
        const latestRebalanceRuns = latestRebalanceRun
          ? getLatestMatchingRebalanceRuns(runs, market)
          : [];
        const latestActionablesTimestamp = [
          latestTechnicalRun,
          latestRebalanceRun,
        ]
          .map((run) => (run ? getLatestRunTimestamp(run) : null))
          .filter(Boolean)
          .sort((a, b) => parseTimestampMs(b) - parseTimestampMs(a))[0];
        const latestActionableStocks = latestRebalanceRuns.length
          ? buildConsensusRows(latestRebalanceRuns, market)
          : [];

        const overview =
          portfolio === "zerodha" ? zerodhaOverview : indmoneyOverview;
        const threatResponse =
          portfolio === "zerodha" ? zerodhaThreat : indmoneyThreat;
        const threat = threatResponse?.analysis ?? null;
        const syncStatus =
          portfolio === "zerodha"
            ? "last synced portfolio"
            : (indmoneyOverview?.latest?.parse_status ?? "last snapshot");

        acc[portfolio] = {
          sync: {
            completedAt: overview?.latest?.captured_at ?? null,
            runStatus: overview?.latest ? syncStatus : null,
          },
          swing: summarizeCompletedRunForIdle(
            latestSwingRun,
            usdInrRate,
            latestSwingRun ? countUniqueStocksFromRun(latestSwingRun) : null,
          ),
          threats: threat
            ? withInrCost(
                {
                  ...summarizeThreat(threat),
                  completedLlms:
                    (threat.status || "").toLowerCase() === "completed" ? 1 : 0,
                  totalLlms: 1,
                },
                usdInrRate,
              )
            : {},
          rebalance: summarizeCompletedRunForIdle(
            latestRebalanceRun,
            usdInrRate,
            latestRebalanceRuns.length
              ? buildConsensusRows(latestRebalanceRuns, market).length
              : null,
          ),
          technical: summarizeCompletedRunForIdle(
            latestTechnicalRun,
            usdInrRate,
            latestTechnicalRun ? countUniqueStocksFromRun(latestTechnicalRun) : null,
          ),
          actionables: {
            completedAt: latestActionablesTimestamp ?? null,
            runStatus: latestActionablesTimestamp
              ? "derived from latest rebalance/technical scan"
              : null,
            rebalanceInputs: latestRebalanceRuns.length || null,
            recommendedStocks: latestActionableStocks.length || null,
          },
        };
        return acc;
      },
      {} as Record<
        WorkflowPortfolio,
        Record<WorkflowStageKey, Partial<StageInfo>>
      >,
    );

    setStates((current) => {
      const next = { ...current };
      (["zerodha", "indmoneyUs"] as WorkflowPortfolio[]).forEach(
        (portfolio) => {
          next[portfolio] = { ...current[portfolio] };
          STAGE_ORDER.forEach((stage) => {
            if (current[portfolio][stage].state !== "idle") return;
            next[portfolio][stage] = {
              ...current[portfolio][stage],
              ...nextByPortfolio[portfolio][stage],
              state: "idle",
            };
          });
        },
      );
      return next;
    });
  }, [usdInrRate]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadLatestIdleStageInfo().catch(() => {
        // The workflow tiles keep their built-in "Not available" fallbacks if
        // any dashboard source is temporarily unavailable.
      });
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [loadLatestIdleStageInfo]);

  const updateStage = useCallback(
    (
      portfolio: WorkflowPortfolio,
      stage: WorkflowStageKey,
      info: Partial<StageInfo>,
    ) => {
      setStates((current) => {
        const next = {
          ...current,
          [portfolio]: {
            ...current[portfolio],
            [stage]: { ...current[portfolio][stage], ...info },
          },
        };
        const persisted = readPersistedWorkflow();
        if (persisted) {
          persistWorkflow({
            ...persisted,
            states: next,
            savedAt: new Date().toISOString(),
          });
        }
        return next;
      });
    },
    [],
  );

  const resetPortfolio = useCallback((portfolio: WorkflowPortfolio) => {
    setStates((current) => ({
      ...current,
      [portfolio]: STAGE_ORDER.reduce((acc, stage) => {
        const info = current[portfolio][stage];
        acc[stage] = {
          ...info,
          state: "idle",
          activeRunId: null,
        };
        return acc;
      }, {} as WorkflowState),
    }));
  }, []);

  const completeSkippedStage = useCallback(
    (
      portfolio: WorkflowPortfolio,
      stage: WorkflowStageKey,
      note = "Using latest saved output",
    ) => {
      const timestamp = new Date().toISOString();
      updateStage(portfolio, stage, {
        state: specificMode[portfolio] ? "idle" : "completed",
        ...(specificMode[portfolio]
          ? {}
          : {
              startedAt: timestamp,
              endedAt: timestamp,
              completedAt: timestamp,
            }),
        runStatus: note,
        error: null,
      });
    },
    [specificMode, updateStage],
  );

  const markRunning = useCallback(
    (
      portfolio: WorkflowPortfolio,
      stage: WorkflowStageKey,
      extra?: Partial<StageInfo>,
    ) => {
      const timestamp = new Date().toISOString();
      updateStage(portfolio, stage, {
        state: "running",
        startedAt: timestamp,
        endedAt: null,
        completedAt: null,
        error: null,
        ...extra,
      });
    },
    [updateStage],
  );

  const markCompleted = useCallback(
    (
      portfolio: WorkflowPortfolio,
      stage: WorkflowStageKey,
      info: Partial<StageInfo>,
    ) => {
      const timestamp = new Date().toISOString();
      const infoWithInrCost = withInrCost(info, usdInrRate);
      updateStage(portfolio, stage, {
        state: "completed",
        endedAt: timestamp,
        completedAt: infoWithInrCost.completedAt ?? timestamp,
        activeRunId: null,
        ...infoWithInrCost,
      });
    },
    [updateStage, usdInrRate],
  );

  useEffect(() => {
    if (!runningPortfolio) return;
    const runningEntries = STAGE_ORDER.flatMap((stage) => {
      const info = states[runningPortfolio][stage];
      return info.state === "running" && info.activeRunId
        ? [{ stage, runId: info.activeRunId }]
        : [];
    });
    if (runningEntries.length === 0) return;

    let cancelled = false;
    const poll = async () => {
      await Promise.allSettled(
        runningEntries.map(async ({ stage, runId }) => {
          if (stage === "threats") {
            const analysis =
              runningPortfolio === "zerodha"
                ? await apiService.zerodhaThreatJob(runId)
                : await apiService.indmoneyUsThreatJob(runId);
            if (cancelled) return;
            const status = (analysis.status || "").toLowerCase();
            updateStage(runningPortfolio, stage, {
              ...withInrCost(summarizeThreat(analysis), usdInrRate),
              completedLlms: status === "completed" || status === "partial" ? 1 : 0,
              totalLlms: 1,
            });
            if (status === "completed") {
              markCompleted(runningPortfolio, stage, {
                ...summarizeThreat(analysis),
                completedLlms: 1,
                totalLlms: 1,
              });
            } else if (status === "failed") {
              updateStage(runningPortfolio, stage, {
                state: "failed",
                endedAt: new Date().toISOString(),
                error: analysis.error_message ?? "Threats scan failed.",
                runStatus: analysis.status,
              });
            }
            return;
          }

          const run = await apiService.getRun(runId);
          if (cancelled) return;
          const status = (run.status || "").toLowerCase();
          const market: SwingTradeMarket =
            runningPortfolio === "zerodha" ? "india" : "us";
          const runSummary = withInrCost(
            {
              ...summarizeRun(run),
              ...getRunProgress(run),
              lastRunId: run.id,
              recommendedStocks:
                stage === "swing" || stage === "technical"
                  ? countUniqueStocksFromRun(run)
                  : stage === "rebalance"
                    ? buildConsensusRows(
                        getLatestMatchingRebalanceRuns([run], market),
                        market,
                      ).length || null
                    : undefined,
            },
            usdInrRate,
          );
          updateStage(runningPortfolio, stage, runSummary);
          if (status === "completed" || status === "partial") {
            markCompleted(runningPortfolio, stage, {
              ...runSummary,
              recommendedStocks:
                stage === "swing"
                  ? countUniqueStocksFromRun(run)
                  : stage === "rebalance"
                    ? buildConsensusRows(
                        getLatestMatchingRebalanceRuns([run], market),
                        market,
                      ).length || null
                    : undefined,
            });
          } else if (status === "failed") {
            updateStage(runningPortfolio, stage, {
              ...runSummary,
              state: "failed",
              endedAt: new Date().toISOString(),
              error: summarizeRun(run).error ?? `Run #${run.id} failed.`,
            });
          }
        }),
      );
    };

    void poll();
    const timer = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [markCompleted, runningPortfolio, states, updateStage, usdInrRate]);

  const toggleSpecificMode = useCallback((portfolio: WorkflowPortfolio) => {
    setSpecificMode((current) => {
      const nextEnabled = !current[portfolio];
      if (nextEnabled) {
        setSelectedStages((selected) => ({
          ...selected,
          [portfolio]: new Set(),
        }));
      }
      return { ...current, [portfolio]: nextEnabled };
    });
  }, []);

  const toggleStageSelection = useCallback(
    (portfolio: WorkflowPortfolio, stage: WorkflowStageKey) => {
      setSelectedStages((current) => {
        const nextSet = new Set(current[portfolio]);
        if (nextSet.has(stage)) nextSet.delete(stage);
        else nextSet.add(stage);
        return { ...current, [portfolio]: nextSet };
      });
    },
    [],
  );

  const loadInputCandidates = useCallback(
    async (portfolio: WorkflowPortfolio, stage: InputSelectionStage) => {
      setInputCandidatesLoading(true);
      try {
        const market: SwingTradeMarket =
          portfolio === "zerodha" ? "india" : "us";
        const nextCandidate = buildNextCandidate(stage, market);
        let candidates: InputSelectionCandidate[] = [nextCandidate];

        if (stage === "threats") {
          const overview =
            portfolio === "zerodha"
              ? await apiService.zerodhaPortfolioOverview()
              : await apiService.indmoneyUsPortfolioOverview();
          if (overview.latest) {
            candidates.push({
              id: `portfolio:${portfolio}:latest`,
              source: "run-job",
              label:
                portfolio === "zerodha"
                  ? "Latest Zerodha portfolio snapshot"
                  : "Latest INDmoney US snapshot",
              jobNo: "Latest snapshot",
              timestamp: overview.latest.captured_at ?? null,
              status:
                portfolio === "zerodha"
                  ? "synced"
                  : (("parse_status" in overview.latest
                      ? overview.latest.parse_status
                      : null) ?? "parsed"),
              costUsd: null,
              error: null,
              content: JSON.stringify(overview.latest, null, 2),
              market,
            });
          }
        } else if (stage === "swing") {
          const latest =
            portfolio === "zerodha"
              ? (await apiService.zerodhaThreatsLatest()).analysis
              : (await apiService.indmoneyUsThreatsLatest()).analysis;
          if (
            latest &&
            isUsableStageJob({
              status: latest.status,
              response: latest.report?.raw_markdown,
            })
          ) {
            candidates.push({
              id: `threat:${latest.job_id}`,
              source: "threat",
              label: `${latest.provider}/${latest.model}`,
              jobNo: `#${latest.job_id}`,
              timestamp: latest.created_at,
              status: latest.status,
              costUsd: latest.estimated_cost ?? null,
              error: latest.error_message ?? null,
              content: latest.report?.raw_markdown ?? null,
              market,
            });
          }
        } else {
          const runs = await fetchAllFullRuns();
          if (stage === "rebalance") {
            const previousClose = getPreviousMarketClose(market);
            candidates = candidates.concat(
              buildRunJobCandidates(
                sortRunsByLatestTimestamp(
                  runs
                    .filter(
                      (run) =>
                        parseTimestampMs(run.created_at) >
                        previousClose.getTime(),
                    )
                    .filter((run) =>
                      isRunInSwingTradeMarket(run.prompt, market),
                    ),
                ),
                "Swing Scan",
                market,
              ),
            );
          } else if (stage === "technical") {
            candidates = candidates.concat(
              buildRunJobCandidates(
                sortRunsByLatestTimestamp(
                  runs.filter((run) => isCompletedRebalanceRun(run, market)),
                ),
                "Rebalance Scan",
                market,
              ),
            );
          } else {
            const rebalanceCandidates = buildRunJobCandidates(
              sortRunsByLatestTimestamp(
                runs.filter((run) => isCompletedRebalanceRun(run, market)),
              ),
              "Rebalance Scan",
              market,
            );
            const technicalCandidates = buildRunJobCandidates(
              sortRunsByLatestTimestamp(
                runs.filter((run) => isCompletedTechnicalScanRun(run, market)),
              ),
              "Technical Scan",
              market,
            );
            candidates = candidates.concat(
              rebalanceCandidates,
              technicalCandidates,
            );
          }
        }

        setInputCandidates(candidates);
        setSelectedInputs((current) => {
          const currentSet = current[portfolio][stage];
          const onlyReservedNext =
            currentSet.size === 1 && currentSet.has(nextCandidate.id);
          const defaultIds =
            stage === "rebalance"
              ? candidates.map((candidate) => candidate.id)
              : stage === "actionables"
                ? ([
                    nextCandidate.id,
                    candidates.find((candidate) =>
                      candidate.label.startsWith("Rebalance Scan"),
                    )?.id,
                    candidates.find((candidate) =>
                      candidate.label.startsWith("Technical Scan"),
                    )?.id,
                  ].filter(Boolean) as string[])
                : ([
                    nextCandidate.id,
                    candidates.find((candidate) => candidate.source !== "next")
                      ?.id,
                  ].filter(Boolean) as string[]);
          if (stage !== "rebalance" && currentSet.size > 0 && !onlyReservedNext)
            return current;
          return {
            ...current,
            [portfolio]: {
              ...current[portfolio],
              [stage]: new Set(defaultIds),
            },
          };
        });
      } finally {
        setInputCandidatesLoading(false);
      }
    },
    [],
  );

  const openInputSelection = useCallback(
    (portfolio: WorkflowPortfolio, stage: WorkflowStageKey) => {
      if (
        stage !== "threats" &&
        stage !== "swing" &&
        stage !== "rebalance" &&
        stage !== "technical" &&
        stage !== "actionables"
      )
        return;
      const inputStage = stage as InputSelectionStage;
      setInputDialog({ portfolio, stage: inputStage });
      void loadInputCandidates(portfolio, inputStage).catch((error) => {
        setInputCandidates([]);
        window.alert(
          `Could not load selectable inputs: ${normalizeError(error)}`,
        );
      });
    },
    [loadInputCandidates],
  );

  const toggleInputCandidate = useCallback(
    (id: string) => {
      if (!inputDialog) return;
      setSelectedInputs((current) => {
        const nextSet = new Set(
          current[inputDialog.portfolio][inputDialog.stage],
        );
        if (nextSet.has(id)) nextSet.delete(id);
        else nextSet.add(id);
        return {
          ...current,
          [inputDialog.portfolio]: {
            ...current[inputDialog.portfolio],
            [inputDialog.stage]: nextSet,
          },
        };
      });
    },
    [inputDialog],
  );

  const toggleAllInputCandidates = useCallback(() => {
    if (!inputDialog) return;
    setSelectedInputs((current) => {
      const allSelected = inputCandidates.every((candidate) =>
        current[inputDialog.portfolio][inputDialog.stage].has(candidate.id),
      );
      return {
        ...current,
        [inputDialog.portfolio]: {
          ...current[inputDialog.portfolio],
          [inputDialog.stage]: allSelected
            ? new Set()
            : new Set(inputCandidates.map((candidate) => candidate.id)),
        },
      };
    });
  }, [inputDialog, inputCandidates]);

  const resetDefaultInputCandidates = useCallback(() => {
    if (!inputDialog) return;
    const nextCandidateId = `${inputDialog.stage}:next`;
    const defaultIds =
      inputDialog.stage === "rebalance"
        ? inputCandidates.map((candidate) => candidate.id)
        : ([
            nextCandidateId,
            inputCandidates.find((candidate) => candidate.source !== "next")?.id,
          ].filter(Boolean) as string[]);
    setSelectedInputs((current) => ({
      ...current,
      [inputDialog.portfolio]: {
        ...current[inputDialog.portfolio],
        [inputDialog.stage]: new Set(defaultIds),
      },
    }));
  }, [inputCandidates, inputDialog]);

  const promptToContinueAfterProblem = useCallback(
    (stage: WorkflowStageKey, details: string) => {
      return window.confirm(
        `${getStageLabel(stage, "idle")} did not complete cleanly.\n\n${details}\n\nDo you want to continue to the next stage using the latest available saved output where possible?`,
      );
    },
    [],
  );

  const waitForRunWithStageHandling = useCallback(
    async (
      portfolio: WorkflowPortfolio,
      stage: WorkflowStageKey,
      runId: number,
    ) => {
      activeExecutionRefsRef.current = [
        ...activeExecutionRefsRef.current.filter(
          (entry) => !(entry.kind === "run" && entry.id === runId),
        ),
        { kind: "run", id: runId },
      ];
      updateStage(portfolio, stage, { activeRunId: runId });

      while (true) {
        let run: RunResponse;
        try {
          run = await waitForRunCompletion(
            runId,
            (progressRun) =>
              updateStage(portfolio, stage, getRunProgress(progressRun)),
            () => cancelRequestedRef.current,
          );
        } catch (error) {
          if (error instanceof APIError && error.status === 401) {
            updateStage(portfolio, stage, {
              state: "failed",
              endedAt: new Date().toISOString(),
              runStatus: "auth expired",
              error:
                "Dashboard authentication expired while polling. The worker job may still have completed and saved output in the background; refresh/sign in again before verifying the result.",
            });
            throw new Error(
              "Dashboard authentication expired while polling. The worker job may still complete in the background; refresh/sign in again and open View Output or the stage screen to verify saved results.",
            );
          }
          throw error;
        }
        const status = (run.status || "").toLowerCase();
        if (status === "completed" || status === "partial") return run;

        const progress = getRunProgress(run);
        const error = summarizeRun(run).error;
        const timeoutLike = status !== "failed";
        const detail = timeoutLike
          ? `Run #${runId} is still processing after the dashboard polling window. Heavy prompts can take longer. Completed so far: ${progress.completedLlms}/${progress.totalLlms} LLMs.`
          : `Run #${runId} ended with status "${run.status}". Completed so far: ${progress.completedLlms}/${progress.totalLlms} LLMs. ${error ? `Error: ${error}` : ""}`;

        if (progress.completedLlms > 0) {
          const waitLonger = window.confirm(
            `${detail}\n\nPress OK to keep waiting. Press Cancel to continue with completed LLMs and kill pending/processing LLM jobs.`,
          );
          if (waitLonger) continue;
          await apiService.cancelRun(runId);
          return apiService.getRun(runId);
        }

        throw new Error(
          `${detail}\n\nNo LLM output is available yet, so this stage cannot safely continue without user approval.`,
        );
      }
    },
    [updateStage],
  );

  const showStageLlmInfo = useCallback(async (portfolio: WorkflowPortfolio, stage: WorkflowStageKey) => {
    if (stage === "sync" || stage === "actionables") return;
    setLlmDialogStage(stage);
    setLlmDialogPortfolio(portfolio);
    setLlmDialogProviders([]);
    setLlmDialogSelectedKeys(new Set());
    setLlmDialogHistoricalCosts({});
    try {
      const [providers, historicalCosts] = await Promise.all([
        apiService.getProviders({
          prompt: buildSwingTradePrompt(
            portfolio === "zerodha" ? "india" : "us",
            getSwingTradeDefaultInvestmentAmount(
              portfolio === "zerodha" ? "india" : "us",
            ),
          ),
        }),
        loadStageHistoricalCostMapInr(stage, portfolio, usdInrRate),
      ]);
      const targets = getSavedStageTargets(stage, providers);
      setLlmDialogProviders(providers);
      setLlmDialogSelectedKeys(new Set(targets.map(targetKey)));
      setLlmDialogHistoricalCosts(historicalCosts);
    } catch (error) {
      setLlmDialogStage(null);
      setLlmDialogPortfolio(null);
      window.alert(`Could not load LLM details: ${normalizeError(error)}`);
    }
  }, [usdInrRate]);

  useEffect(() => {
    const handleOpenStageOutput = (event: Event) => {
      const payload = (event as CustomEvent<{ runId?: number; stage?: WorkflowStageKey; portfolio?: WorkflowPortfolio }>).detail;
      if (!payload?.runId || !payload.stage || !payload.portfolio) return;
      if (payload.stage !== "rebalance" && payload.stage !== "technical") return;
      event.preventDefault();
      const title = `${payload.portfolio === "zerodha" ? "Zerodha India" : "INDmoney US"} · ${STAGE_METADATA[payload.stage].idle} Output`;
      setOutputDialog({
        portfolio: payload.portfolio,
        stage: payload.stage,
        title,
        body: "",
        loading: true,
        error: null,
        routeUrl: null,
        run: null,
      });
      void fetchAllFullRuns()
        .then((runs) => {
          const selectedRun = runs.find((run) => run.id === payload.runId) ?? null;
          setOutputDialog({
            portfolio: payload.portfolio as WorkflowPortfolio,
            stage: payload.stage as WorkflowStageKey,
            title,
            body: selectedRun ? "" : `No saved run output was found for run #${payload.runId}.`,
            loading: false,
            error: null,
            routeUrl: null,
            run: selectedRun,
          });
        })
        .catch((error) => {
          setOutputDialog({
            portfolio: payload.portfolio as WorkflowPortfolio,
            stage: payload.stage as WorkflowStageKey,
            title,
            body: "",
            loading: false,
            error: normalizeError(error),
            routeUrl: null,
            run: null,
          });
        });
    };

    window.addEventListener("final-actionables:open-stage-output", handleOpenStageOutput);
    return () => window.removeEventListener("final-actionables:open-stage-output", handleOpenStageOutput);
  }, []);

  const showStageOutput = useCallback(
    async (portfolio: WorkflowPortfolio, stage: WorkflowStageKey) => {
      const title = `${portfolio === "zerodha" ? "Zerodha India" : "INDmoney US"} · ${STAGE_METADATA[stage].idle} Output`;
      const routeUrl = ["swing", "rebalance", "technical"].includes(stage)
        ? null
        : getStageOutputRoute(portfolio, stage);
      setOutputDialog({
        portfolio,
        stage,
        title,
        body: "",
        loading: false,
        error: null,
        routeUrl,
        run: null,
      });
      try {
        if (routeUrl) return;
        const market: SwingTradeMarket =
          portfolio === "zerodha" ? "india" : "us";
        let body = "No saved output is available yet.";
        let selectedRun: RunResponse | null = null;
        if (stage === "sync") {
          const overview =
            portfolio === "zerodha"
              ? await apiService.zerodhaPortfolioOverview()
              : await apiService.indmoneyUsPortfolioOverview();
          body = JSON.stringify(overview.latest ?? overview, null, 2);
        } else if (stage === "threats") {
          const latest =
            portfolio === "zerodha"
              ? (await apiService.zerodhaThreatsLatest()).analysis
              : (await apiService.indmoneyUsThreatsLatest()).analysis;
          body =
            latest?.report?.raw_markdown?.trim() ||
            latest?.error_message ||
            "No saved threat output is available yet.";
        } else if (stage === "actionables") {
          body =
            "Final Actionables are rendered in the dashboard output tables below. Use the section anchor to inspect the latest India and US actionable rows.";
        } else {
          const runs = await fetchAllFullRuns();
          selectedRun = sortRunsByLatestTimestamp(
            runs.filter((run) => {
              if (stage === "swing")
                return isRunInSwingTradeMarket(run.prompt, market);
              if (stage === "rebalance")
                return isCompletedRebalanceRun(run, market);
              if (stage === "technical")
                return isCompletedTechnicalScanRun(run, market);
              return false;
            }),
          )[0];
          const jobs =
            selectedRun?.run_jobs?.map((link) => link.job).filter(Boolean) ?? [];
          body = jobs.length
            ? [
                `## Last run summary\n${selectedRun ? getRunOutputSummary(selectedRun) : "Not available"}`,
                jobs
                  .map(
                    (job) =>
                      `# ${selectedRun ? getRunOutputDisplayLabel(selectedRun) : "Run"} / Job ${job?.id} · ${job?.provider ?? "LLM"}/${job?.model ?? "model"}\n\n${job?.response?.trim() || job?.error_message || "No response text saved."}`,
                  )
                  .join("\n\n---\n\n"),
              ].join("\n\n---\n\n")
            : "No saved LLM output is available yet.";
        }
        setOutputDialog({
          portfolio,
          stage,
          title,
          body,
          loading: false,
          error: null,
          routeUrl: null,
          run: selectedRun,
        });
      } catch (error) {
        setOutputDialog({
          portfolio,
          stage,
          title,
          body: "",
          loading: false,
          error: normalizeError(error),
          routeUrl: null,
          run: null,
        });
      }
    },
    [],
  );

  const persistLlmDialogSelection = useCallback(
    (nextKeys: Set<string>) => {
      if (!llmDialogStage) return;
      writeStageLlmSelection(llmDialogStage, [...nextKeys]);
      setLlmDialogSelectedKeys(nextKeys);
    },
    [llmDialogStage],
  );

  const toggleLlmTarget = useCallback(
    (key: string) => {
      if (!llmDialogStage) return;
      const singleSelect =
        llmDialogStage === "threats" || llmDialogStage === "technical";
      const next = singleSelect
        ? new Set([key])
        : new Set(llmDialogSelectedKeys);
      if (!singleSelect) {
        if (next.has(key)) next.delete(key);
        else next.add(key);
      }
      persistLlmDialogSelection(next);
    },
    [llmDialogSelectedKeys, llmDialogStage, persistLlmDialogSelection],
  );

  const selectAllLlmTargets = useCallback(() => {
    persistLlmDialogSelection(
      new Set(getCompatibleTargets(llmDialogProviders).map(targetKey)),
    );
  }, [llmDialogProviders, persistLlmDialogSelection]);

  const clearLlmTargets = useCallback(() => {
    persistLlmDialogSelection(new Set());
  }, [persistLlmDialogSelection]);

  const resetDefaultLlmTargets = useCallback(() => {
    if (!llmDialogStage) return;
    persistLlmDialogSelection(
      new Set(
        getDefaultStageTargets(llmDialogStage, llmDialogProviders).map(
          targetKey,
        ),
      ),
    );
  }, [llmDialogProviders, llmDialogStage, persistLlmDialogSelection]);

  const navigateForStage = useCallback(
    (
      portfolio: WorkflowPortfolio,
      stage: WorkflowStageKey,
      info?: StageInfo,
    ) => {
      if (info?.state === "failed" && info.error) {
        window.alert(info.error);
        return;
      }
      const zerodha = portfolio === "zerodha";
      const hrefByStage: Record<WorkflowStageKey, string> = {
        sync: zerodha
          ? URLs.routes.console.zerodha()
          : URLs.routes.console.indmoneyUs(),
        swing: zerodha
          ? `${URLs.routes.console.zerodhaSwingTrade()}#recent-jobs`
          : `${URLs.routes.console.indmoneyUsSwingTrade()}#recent-jobs`,
        threats: zerodha
          ? URLs.routes.console.zerodhaThreats()
          : URLs.routes.console.indmoneyUsThreats(),
        rebalance: zerodha
          ? URLs.routes.console.zerodhaRebalance()
          : URLs.routes.console.indmoneyUsRebalance(),
        technical: `${URLs.routes.console.dashboard()}#final-actionables`,
        actionables: `${URLs.routes.console.dashboard()}#final-actionables`,
      };
      if ((stage === "technical" || stage === "actionables") && window.location.pathname === URLs.routes.console.dashboard()) {
        document.getElementById("final-actionables")?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      window.open(hrefByStage[stage], "_blank", "noopener,noreferrer");
    },
    [],
  );

  const showStagePrompt = useCallback(
    (portfolio: WorkflowPortfolio, stage: PromptPreviewStage) => {
      const portfolioLabel = portfolio === "zerodha" ? "Zerodha" : "INDmoney US";
      setPromptDialog({
        portfolio,
        stage,
        title: `${portfolioLabel} ${getStageTileLabel(stage)} prompt`,
        body: getStagePromptPreview(portfolio, stage),
      });
    },
    [],
  );

  const buildZerodhaPopupFeatures = useCallback(() => {
    const width = 560;
    const height = 760;
    const left = Math.max(window.screenX + (window.outerWidth - width) / 2, 0);
    const top = Math.max(window.screenY + (window.outerHeight - height) / 2, 0);
    return `popup=yes,width=${width},height=${height},left=${Math.round(left)},top=${Math.round(top)}`;
  }, []);

  const ensureZerodhaConnectedForSync = useCallback(async (preOpenedPopup?: Window | null) => {
    const status = await apiService.zerodhaStatus();
    if (status.connected) {
      preOpenedPopup?.close();
      return;
    }

    const login = await apiService.zerodhaLoginUrl();
    if (!login.configured || !login.login_url) {
      preOpenedPopup?.close();
      throw new Error("Zerodha is not configured on this server.");
    }

    const canReusePreOpenedPopup = Boolean(preOpenedPopup && !preOpenedPopup.closed);
    const popup = canReusePreOpenedPopup
      ? preOpenedPopup
      : window.open(
          login.login_url,
          "zerodha-connect",
          buildZerodhaPopupFeatures(),
        );

    if (!popup) {
      throw new Error(
        "Zerodha login popup was blocked. Allow popups and click Sync Now or Refresh Board again.",
      );
    }

    if (canReusePreOpenedPopup) {
      popup.location.href = login.login_url;
    }
    popup.focus();

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeoutMs = 5 * 60 * 1000;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        window.removeEventListener("message", handleMessage);
        window.clearInterval(popupPoll);
        window.clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const handleMessage = (event: MessageEvent) => {
        if (event.origin !== window.location.origin) return;
        const data = event.data as
          | { type?: string; message?: string }
          | null
          | undefined;
        if (data?.type === "zerodha_connected") {
          finish();
        } else if (data?.type === "zerodha_error") {
          finish(new Error(data.message || "Zerodha connection failed."));
        }
      };
      const popupPoll = window.setInterval(() => {
        if (popup.closed) {
          finish(new Error("Zerodha login popup was closed before connection completed."));
        }
      }, 500);
      const timeout = window.setTimeout(() => {
        finish(new Error("Zerodha login timed out before connection completed."));
      }, timeoutMs);
      window.addEventListener("message", handleMessage);
    });

    await sleep(1200);
  }, [buildZerodhaPopupFeatures]);

  const runWorkflow = useCallback(
    async (
      portfolio: WorkflowPortfolio,
      indmoneyPayload?: IndMoneyUsPortfolioSnapshotCreateRequest,
    ) => {
      const market: SwingTradeMarket = portfolio === "zerodha" ? "india" : "us";
      const runSpecificMode = specificMode[portfolio];
      const stagesToRun = new Set(selectedStages[portfolio]);
      if (runSpecificMode && stagesToRun.size === 0) {
        window.alert("Select at least one stage to run.");
        return;
      }
      const runMetadata = await reserveAutoRebalanceRunMetadata(portfolio);
      const shouldRunCurrentStage = (stage: WorkflowStageKey) =>
        !runSpecificMode || stagesToRun.has(stage);
      const stopIfPaused = () => {
        if (!pauseRequestedRef.current) return false;
        const timestamp = new Date().toISOString();
        setStates((current) => ({
          ...current,
          [portfolio]: STAGE_ORDER.reduce((acc, stage) => {
            const info = current[portfolio][stage];
            acc[stage] =
              info.state === "queued"
                ? {
                    ...info,
                    state: "idle",
                    endedAt: timestamp,
                    runStatus: "Paused before this stage",
                  }
                : info;
            return acc;
          }, {} as WorkflowState),
        }));
        pauseRequestedRef.current = false;
        return true;
      };
      setRunningPortfolio(portfolio);
      resetPortfolio(portfolio);
      activeExecutionRefsRef.current = [];
      cancelRequestedRef.current = false;
      pauseRequestedRef.current = false;
      setWorkflowPaused(false);

      const zerodhaPopup =
        portfolio === "zerodha" && shouldRunCurrentStage("sync")
          ? window.open("about:blank", "zerodha-connect", buildZerodhaPopupFeatures())
          : null;

      let currentStage: WorkflowStageKey = "sync";
      let generatedThreatMarkdown = "";
      let generatedSwingRun: RunResponse | null = null;
      let generatedRebalanceRun: RunResponse | null = null;

      try {
        currentStage = "sync";
        if (shouldRunCurrentStage("sync")) {
          markRunning(portfolio, "sync");
          if (portfolio === "zerodha") {
            await ensureZerodhaConnectedForSync(zerodhaPopup);
            const previousOverview = await apiService.zerodhaPortfolioOverview();
            const synced = await apiService.zerodhaSyncPortfolio();
            const overview = await waitForZerodhaPortfolioSync(
              previousOverview.latest?.captured_at,
            );
            markCompleted(portfolio, "sync", {
              completedAt: overview.latest?.captured_at,
              runStatus:
                overview.latest?.captured_at !== previousOverview.latest?.captured_at
                  ? "synced"
                  : synced.status,
            });
          } else if (indmoneyPayload) {
            const snapshot =
              await apiService.indmoneyUsCreatePortfolioSnapshot(
                indmoneyPayload,
              );
            markCompleted(portfolio, "sync", {
              completedAt: snapshot.captured_at,
              runStatus: snapshot.parse_status,
            });
          } else {
            const overview = await apiService.indmoneyUsPortfolioOverview();
            markCompleted(portfolio, "sync", {
              completedAt: overview.latest?.captured_at,
              runStatus: overview.latest?.parse_status ?? "last snapshot",
            });
          }
          await onDashboardRefresh();
        } else {
          completeSkippedStage(
            portfolio,
            "sync",
            "Using last synced portfolio",
          );
        }

        if (stopIfPaused()) return;

        const needsModelMix =
          shouldRunCurrentStage("swing") || shouldRunCurrentStage("rebalance");
        const needsSingleModel =
          shouldRunCurrentStage("threats") ||
          shouldRunCurrentStage("technical");
        if (needsSingleModel && shouldRunCurrentStage("threats")) {
          currentStage = "threats";
        } else if (needsModelMix) {
          currentStage = shouldRunCurrentStage("swing") ? "swing" : "rebalance";
        } else if (needsSingleModel) {
          currentStage = "technical";
        }

        const providers =
          needsModelMix || needsSingleModel
            ? await apiService.getProviders({
                prompt: buildSwingTradePrompt(
                  market,
                  getSwingTradeDefaultInvestmentAmount(market),
                ),
              })
            : [];
        const swingTargets = shouldRunCurrentStage("swing")
          ? getSavedStageTargets("swing", providers)
          : [];
        const rebalanceTargets = shouldRunCurrentStage("rebalance")
          ? getSavedStageTargets("rebalance", providers)
          : [];
        if (shouldRunCurrentStage("swing") && swingTargets.length === 0) {
          throw new Error(
            `No compatible targets found for Swing Scan. Open the stage LLM selector and choose the exact LLMs you want this stage to use.`,
          );
        }
        if (
          shouldRunCurrentStage("rebalance") &&
          rebalanceTargets.length === 0
        ) {
          throw new Error(
            `No compatible targets found for Rebalance. Open the stage LLM selector and choose the exact LLMs you want this stage to use.`,
          );
        }
        const threatTargets = shouldRunCurrentStage("threats")
          ? getSavedStageTargets("threats", providers)
          : [];
        const technicalTargets = shouldRunCurrentStage("technical")
          ? getSavedStageTargets("technical", providers)
          : [];
        if (shouldRunCurrentStage("threats") && threatTargets.length === 0)
          throw new Error(
            `No compatible target is available for Threats & Guardrails. Open the stage LLM selector and choose one configured model.`,
          );
        if (shouldRunCurrentStage("technical") && technicalTargets.length === 0)
          throw new Error(
            `No compatible target is available for Technical Validation. Open the stage LLM selector and choose one configured model.`,
          );

        currentStage = "threats";
        if (shouldRunCurrentStage("threats")) {
          markRunning(portfolio, "threats", { totalLlms: 1, completedLlms: 0 });
          const queuedThreat =
            portfolio === "zerodha"
              ? await apiService.zerodhaRunThreats({ ...threatTargets[0], ...runMetadata })
              : await apiService.indmoneyUsRunThreats({ ...threatTargets[0], ...runMetadata });
          activeExecutionRefsRef.current = [
            ...activeExecutionRefsRef.current.filter(
              (entry) => !(entry.kind === "job" && entry.id === queuedThreat.job_id),
            ),
            { kind: "job", id: queuedThreat.job_id },
          ];
          updateStage(portfolio, "threats", {
            activeRunId: queuedThreat.job_id,
          });
          const completedThreat = await waitForThreatCompletion(
            portfolio,
            queuedThreat.job_id,
            () => cancelRequestedRef.current,
          );
          if ((completedThreat.status || "").toLowerCase() !== "completed")
            throw new Error(
              `Threats scan failed: ${completedThreat.error_message ?? "Job failed."}`,
            );
          generatedThreatMarkdown = completedThreat.report?.raw_markdown ?? "";
          markCompleted(portfolio, "threats", {
            ...summarizeThreat(completedThreat),
            completedLlms: 1,
            totalLlms: 1,
          });
        } else {
          completeSkippedStage(
            portfolio,
            "threats",
            "Using latest threats scan",
          );
        }

        if (stopIfPaused()) return;

        currentStage = "swing";
        if (shouldRunCurrentStage("swing")) {
          markRunning(portfolio, "swing", {
            totalLlms: swingTargets.length,
            completedLlms: 0,
          });
          const swingInputSelection = selectedInputs[portfolio].swing;
          const selectedThreatParts: string[] = [];
          if (
            swingInputSelection.has("swing:next") &&
            generatedThreatMarkdown.trim()
          ) {
            selectedThreatParts.push(
              `## Next Threat Scan output\n\n${generatedThreatMarkdown.trim()}`,
            );
          }
          if ([...swingInputSelection].some((id) => id.startsWith("threat:"))) {
            const latestThreat =
              portfolio === "zerodha"
                ? (await apiService.zerodhaThreatsLatest()).analysis
                : (await apiService.indmoneyUsThreatsLatest()).analysis;
            if (
              latestThreat?.report?.raw_markdown &&
              swingInputSelection.has(`threat:${latestThreat.job_id}`)
            ) {
              selectedThreatParts.push(
                `## Selected Threat Scan #${latestThreat.job_id}\n\n${latestThreat.report.raw_markdown.trim()}`,
              );
            }
          }
          const threatAppendix = selectedThreatParts.length
            ? `\n\n---\n\n# User-selected Threat Scan Inputs\n\n${selectedThreatParts.join("\n\n---\n\n")}`
            : "";
          const swingRun = await apiService.createRun(
            buildRunPayload({
              prompt: `${buildSwingTradePrompt(
                market,
                getSwingTradeDefaultInvestmentAmount(market),
              )}${threatAppendix}`,
              targets: swingTargets,
              sheetName: getSwingTradeDefaultExportSheetName(market),
              runMetadata,
              scanLabel: "Swing Scan",
            }),
          );
          const completedSwingRun = await waitForRunWithStageHandling(
            portfolio,
            "swing",
            swingRun.id,
          );
          generatedSwingRun = completedSwingRun;
          markCompleted(portfolio, "swing", {
            ...summarizeRun(completedSwingRun),
            ...getRunProgress(completedSwingRun),
            lastRunId: completedSwingRun.id,
            recommendedStocks: countUniqueStocksFromRun(completedSwingRun),
          });
        } else {
          completeSkippedStage(
            portfolio,
            "swing",
            "Using latest completed swing scan",
          );
        }

        if (stopIfPaused()) return;

        currentStage = "rebalance";
        if (shouldRunCurrentStage("rebalance")) {
          markRunning(portfolio, "rebalance", {
            totalLlms: rebalanceTargets.length,
            completedLlms: 0,
          });
          const [portfolioRes, threatsRes, runsRes] = await Promise.all([
            portfolio === "zerodha"
              ? apiService.zerodhaPortfolioOverview()
              : apiService.indmoneyUsPortfolioOverview(),
            portfolio === "zerodha"
              ? apiService.zerodhaThreatsLatest()
              : apiService.indmoneyUsThreatsLatest(),
            apiService.getRuns({ page: 1, limit: 50, summary: true }),
          ]);
          const previousClose = getPreviousMarketClose(market);
          const recentCompletedRuns = runsRes.items
            .filter((run) => (run.status || "").toLowerCase() === "completed")
            .filter(
              (run) =>
                parseTimestampMs(run.created_at) > previousClose.getTime(),
            )
            .slice(0, 24);
          const fullRunCandidates = await Promise.all(
            recentCompletedRuns.map((run) => apiService.getRun(run.id)),
          );
          const swingCandidates = buildRunJobCandidates(
            fullRunCandidates.filter((run) =>
              isRunInSwingTradeMarket(run.prompt, market),
            ),
            "Swing Scan",
            market,
          );
          const selectedRebalanceInputs = selectedInputs[portfolio].rebalance;
          const selectedSwingRuns = selectedRebalanceInputs.size
            ? uniqueRunsBySelectedCandidates(
                swingCandidates,
                selectedRebalanceInputs,
              )
            : [];
          const swingRuns = [
            ...(selectedRebalanceInputs.has("rebalance:next") &&
            generatedSwingRun
              ? [generatedSwingRun]
              : []),
            ...(selectedSwingRuns.length
              ? selectedSwingRuns
              : fullRunCandidates
                  .filter((run) => isRunInSwingTradeMarket(run.prompt, market))
                  .slice(0, 12)),
          ];
          const inputBundle = buildRebalanceInputBundle({
            market,
            previousClose,
            portfolio: portfolioRes.latest,
            threats: threatsRes.analysis,
            swingRuns,
            swingDisplayMode: "full",
          });
          const rebalanceRun = await apiService.createRun(
            buildRunPayload({
              prompt:
                `${ensureRebalanceFlowMarker(buildRebalancePrompt(market), market)}\n\n---\n\n${inputBundle}`.trim(),
              targets: rebalanceTargets,
              sheetName: getRebalanceDefaultExportSheetName(market),
              runMetadata,
              scanLabel: "Rebalance Scan",
            }),
          );
          const completedRebalanceRun = await waitForRunWithStageHandling(
            portfolio,
            "rebalance",
            rebalanceRun.id,
          );
          generatedRebalanceRun = completedRebalanceRun;
          markCompleted(portfolio, "rebalance", {
            ...summarizeRun(completedRebalanceRun),
            ...getRunProgress(completedRebalanceRun),
            lastRunId: completedRebalanceRun.id,
            recommendedStocks:
              buildConsensusRows(
                getLatestMatchingRebalanceRuns([completedRebalanceRun], market),
                market,
              ).length || null,
          });
        } else {
          completeSkippedStage(
            portfolio,
            "rebalance",
            "Using latest rebalance output",
          );
        }

        if (stopIfPaused()) return;

        currentStage = "technical";
        if (shouldRunCurrentStage("technical")) {
          markRunning(portfolio, "technical", {
            totalLlms: 1,
            completedLlms: 0,
          });
          const allRuns = await fetchAllFullRuns();
          const selectedTechnicalInputs = selectedInputs[portfolio].technical;
          const selectedRebalanceRuns = selectedTechnicalInputs.size
            ? uniqueRunsBySelectedCandidates(
                buildRunJobCandidates(
                  allRuns.filter((run) => isCompletedRebalanceRun(run, market)),
                  "Rebalance Scan",
                  market,
                ),
                selectedTechnicalInputs,
              )
            : [];
          const rebalanceInputs = [
            ...(selectedTechnicalInputs.has("technical:next") &&
            generatedRebalanceRun
              ? [generatedRebalanceRun]
              : []),
            ...(selectedRebalanceRuns.length
              ? selectedRebalanceRuns
              : getLatestMatchingRebalanceRuns(allRuns, market)),
          ];
          const consensus = buildConsensusRows(rebalanceInputs, market);
          if (consensus.length === 0)
            throw new Error(
              "No fresh rebalance consensus rows were available for technical scan. Consensus rows are the normalized stock/action rows parsed from completed Rebalance LLM outputs. Run or keep the Rebalance stage selected, select completed Rebalance outputs in Select Inputs, or allow this stage to use the latest completed rebalance output.",
            );
          const technicalRun = await apiService.createRun(
            buildRunPayload({
              prompt: buildTechnicalScanPrompt(consensus, market),
              targets: [technicalTargets[0]],
              runMetadata,
              scanLabel: "Technical Scan",
            }),
          );
          const completedTechnicalRun = await waitForRunWithStageHandling(
            portfolio,
            "technical",
            technicalRun.id,
          );
          markCompleted(portfolio, "technical", {
            ...summarizeRun(completedTechnicalRun),
            ...getRunProgress(completedTechnicalRun),
            lastRunId: completedTechnicalRun.id,
            recommendedStocks: countUniqueStocksFromRun(completedTechnicalRun),
          });
        } else {
          completeSkippedStage(
            portfolio,
            "technical",
            "Using latest technical scan",
          );
        }

        if (stopIfPaused()) return;

        currentStage = "actionables";
        if (shouldRunCurrentStage("actionables")) {
          const rebalanceInputCount = generatedRebalanceRun
            ? 1
            : selectedInputs[portfolio].actionables.size;
          const actionableStockCount = generatedRebalanceRun
            ? buildConsensusRows([generatedRebalanceRun], market).length || null
            : null;
          markRunning(portfolio, "actionables", {
            rebalanceInputs: rebalanceInputCount || null,
            recommendedStocks: actionableStockCount,
          });
          await onDashboardRefresh();
          const actionablesCompletedAt = new Date().toISOString();
          markCompleted(portfolio, "actionables", {
            completedAt: actionablesCompletedAt,
            runStatus: "fresh data loaded",
            rebalanceInputs: rebalanceInputCount || null,
            recommendedStocks: actionableStockCount,
          });
          window.dispatchEvent(new CustomEvent("final-actionables-refresh", {
            detail: {
              market,
              completedAt: actionablesCompletedAt,
            },
          }));
          try {
            await apiService.queueAutoRebalanceCompletionEmail({
              portfolio: runMetadata.auto_rebalance_portfolio,
              sequence: runMetadata.auto_rebalance_sequence,
              label: runMetadata.auto_rebalance_label,
              completed_at: actionablesCompletedAt,
              stages_completed: STAGE_ORDER.filter(shouldRunCurrentStage).map(
                getStageTileLabel,
              ),
            });
          } catch (emailError) {
            console.error("Failed to queue auto-rebalance success email", emailError);
          }
        } else {
          completeSkippedStage(
            portfolio,
            "actionables",
            "Leaving current actionables unchanged",
          );
        }
        if (pauseRequestedRef.current) pauseRequestedRef.current = false;
        setWorkflowPaused(false);
        window.setTimeout(() => {
          setStates((current) => {
            const lastCost = getWorkflowRunCost(current[portfolio], usdInrRate);
            setLastAutoRebalanceCosts((costs) => ({
              ...costs,
              [portfolio]: lastCost,
            }));
            return {
              ...current,
              [portfolio]: STAGE_ORDER.reduce((acc, stage) => {
                const info = current[portfolio][stage];
                acc[stage] =
                  info.state === "completed"
                    ? { ...info, state: "idle" }
                    : info;
                return acc;
              }, {} as WorkflowState),
            };
          });
          setSpecificMode((current) => ({ ...current, [portfolio]: false }));
          setSelectedStages((current) => ({
            ...current,
            [portfolio]: new Set(),
          }));
          setSelectedInputs((current) => ({
            ...current,
            [portfolio]: {
              threats: new Set(["threats:next"]),
              swing: new Set(["swing:next"]),
              rebalance: new Set(["rebalance:next"]),
              technical: new Set(["technical:next"]),
              actionables: new Set(["actionables:next"]),
            },
          }));
        }, WORKFLOW_COMPLETION_RESET_DELAY_MS);
      } catch (error) {
        const message = normalizeError(error);
        updateStage(portfolio, currentStage, {
          state: "failed",
          endedAt: new Date().toISOString(),
          error: message,
          runStatus: "failed",
        });
        if (
          !cancelRequestedRef.current &&
          promptToContinueAfterProblem(currentStage, message)
        ) {
          completeSkippedStage(
            portfolio,
            currentStage,
            "Skipped after user approval",
          );
        }
        window.setTimeout(() => {
          setStates((current) => ({
            ...current,
            [portfolio]: STAGE_ORDER.reduce((acc, stage) => {
              const info = current[portfolio][stage];
              acc[stage] =
                info.state === "failed" ? { ...info, state: "idle" } : info;
              return acc;
            }, {} as WorkflowState),
          }));
          setSpecificMode((current) => ({ ...current, [portfolio]: false }));
          setSelectedStages((current) => ({
            ...current,
            [portfolio]: new Set(),
          }));
        }, WORKFLOW_COMPLETION_RESET_DELAY_MS);
      } finally {
        const wasCancelled = cancelRequestedRef.current;
        activeExecutionRefsRef.current = [];
        setRunningPortfolio(null);
        if (wasCancelled) {
          const timestamp = new Date().toISOString();
          setStates((current) => ({
            ...current,
            [portfolio]: STAGE_ORDER.reduce((acc, stage) => {
              const info = current[portfolio][stage];
              acc[stage] = ["running", "queued"].includes(info.state)
                ? {
                    ...info,
                    state: "failed",
                    endedAt: timestamp,
                    runStatus: "killed",
                    error: "Auto-rebalance flow was killed by user.",
                  }
                : info;
              return acc;
            }, {} as WorkflowState),
          }));
          window.setTimeout(() => {
            setStates((current) => ({
              ...current,
              [portfolio]: STAGE_ORDER.reduce((acc, stage) => {
                const info = current[portfolio][stage];
                acc[stage] =
                  info.state === "failed" ? { ...info, state: "idle" } : info;
                return acc;
              }, {} as WorkflowState),
            }));
            setSpecificMode((current) => ({ ...current, [portfolio]: false }));
            setSelectedStages((current) => ({
              ...current,
              [portfolio]: new Set(),
            }));
          }, WORKFLOW_COMPLETION_RESET_DELAY_MS);
        }
      }
    },
    [
      buildZerodhaPopupFeatures,
      completeSkippedStage,
      markCompleted,
      markRunning,
      ensureZerodhaConnectedForSync,
      onDashboardRefresh,
      promptToContinueAfterProblem,
      resetPortfolio,
      selectedInputs,
      selectedStages,
      specificMode,
      updateStage,
      usdInrRate,
      waitForRunWithStageHandling,
    ],
  );

  const syncPortfolioNow = useCallback(
    async (
      portfolio: WorkflowPortfolio,
      payload?: IndMoneyUsPortfolioSnapshotCreateRequest,
    ) => {
      const zerodhaPopup =
        portfolio === "zerodha"
          ? window.open("about:blank", "zerodha-connect", buildZerodhaPopupFeatures())
          : null;
      try {
        markRunning(portfolio, "sync");
        if (portfolio === "zerodha") {
          await ensureZerodhaConnectedForSync(zerodhaPopup);
          const previousOverview = await apiService.zerodhaPortfolioOverview();
          const synced = await apiService.zerodhaSyncPortfolio();
          const overview = await waitForZerodhaPortfolioSync(
            previousOverview.latest?.captured_at,
          );
          markCompleted(portfolio, "sync", {
            completedAt: overview.latest?.captured_at,
            runStatus:
              overview.latest?.captured_at !== previousOverview.latest?.captured_at
                ? "synced"
                : synced.status,
          });
        } else if (payload) {
          const snapshot =
            await apiService.indmoneyUsCreatePortfolioSnapshot(payload);
          markCompleted(portfolio, "sync", {
            completedAt: snapshot.captured_at,
            runStatus: snapshot.parse_status,
          });
        } else {
          const overview = await apiService.indmoneyUsPortfolioOverview();
          markCompleted(portfolio, "sync", {
            completedAt: overview.latest?.captured_at,
            runStatus: overview.latest?.parse_status ?? "last snapshot",
          });
        }
        await onDashboardRefresh();
      } catch (error) {
        updateStage(portfolio, "sync", {
          state: "failed",
          endedAt: new Date().toISOString(),
          error: normalizeError(error),
          runStatus: "failed",
        });
      }
    },
    [
      buildZerodhaPopupFeatures,
      ensureZerodhaConnectedForSync,
      markCompleted,
      markRunning,
      onDashboardRefresh,
      updateStage,
    ],
  );

  useEffect(() => {
    const handleDashboardSync = () => {
      if (runningPortfolio) return;
      void syncPortfolioNow("zerodha");
    };
    window.addEventListener(
      ZERODHA_DASHBOARD_SYNC_NOW_EVENT,
      handleDashboardSync,
    );
    return () =>
      window.removeEventListener(
        ZERODHA_DASHBOARD_SYNC_NOW_EVENT,
        handleDashboardSync,
      );
  }, [runningPortfolio, syncPortfolioNow]);

  const handleIndMoneyContinue = useCallback(
    (
      mode: IndMoneySyncMode,
      payload?: IndMoneyUsPortfolioSnapshotCreateRequest,
    ) => {
      setDialogError(null);
      setDialogOpen(false);
      if (indMoneySyncOnly) {
        setIndMoneySyncOnly(false);
        void syncPortfolioNow(
          "indmoneyUs",
          mode === "paste" ? payload : undefined,
        );
        return;
      }
      void runWorkflow("indmoneyUs", mode === "paste" ? payload : undefined);
    },
    [indMoneySyncOnly, runWorkflow, syncPortfolioNow],
  );

  const lastRunByPortfolio = useMemo(() => {
    const result: Record<WorkflowPortfolio, string | null> = {
      zerodha: null,
      indmoneyUs: null,
    };
    (Object.keys(states) as WorkflowPortfolio[]).forEach((portfolio) => {
      const latest = STAGE_ORDER.map(
        (stage) => states[portfolio][stage].completedAt,
      )
        .filter(Boolean)
        .sort((a, b) => parseTimestampMs(b) - parseTimestampMs(a))[0];
      result[portfolio] = latest ?? null;
    });
    return result;
  }, [states]);

  const sections = useMemo(
    () => [
      {
        portfolio: "zerodha" as const,
        title: "Run Zerodha Auto-Rebalance",
        buttonLabel: "Run",
      },
      {
        portfolio: "indmoneyUs" as const,
        title: "Run Indmoney Auto-Rebalance",
        buttonLabel: "Run",
      },
    ],
    [],
  );

  const renderSectionCard = (section: (typeof sections)[number]) => {
    const isSectionRunning = runningPortfolio === section.portfolio;
    const queuedStages = getQueuedStages(
      section.portfolio,
      states,
      runningPortfolio,
      specificMode,
      selectedStages,
    );

    return (
      <div
        key={section.portfolio}
        className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-md shadow-slate-200/70"
      >
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <h2 className="text-xl font-extrabold text-slate-950">
              {section.title}
            </h2>
            <p className="mt-2 text-base leading-6 text-slate-500">
              Last run on{" "}
              {formatTimestamp(lastRunByPortfolio[section.portfolio])}
            </p>
          </div>
          <div className="flex w-full min-w-0 flex-col items-start gap-3 xl:w-auto xl:max-w-full xl:items-end">
            <div
              className={
                isSectionRunning
                  ? "grid w-full min-w-0 grid-cols-2 gap-2 xl:w-60"
                  : "flex w-full min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end xl:w-auto"
              }
            >
              {isSectionRunning ? (
                <>
                  <Button
                    type="button"
                    onClick={() => {
                      pauseRequestedRef.current = !pauseRequestedRef.current;
                      setWorkflowPaused(pauseRequestedRef.current);
                    }}
                    className={cn(
                      "h-auto w-full shrink-0 justify-center whitespace-normal rounded-full px-6 py-2 text-center leading-5 text-white shadow-sm transition",
                      workflowPaused
                        ? "bg-emerald-600 hover:bg-emerald-700"
                        : "bg-orange-500 hover:bg-orange-600",
                    )}
                  >
                    {workflowPaused ? (
                      <Play className="mr-2 size-4 fill-current" />
                    ) : (
                      <Pause className="mr-2 size-4 fill-current" />
                    )}
                    {workflowPaused ? "Resume" : "Pause"}
                  </Button>
                  <Button
                    type="button"
                    onClick={() => {
                      cancelRequestedRef.current = true;
                      pauseRequestedRef.current = false;
                      setWorkflowPaused(false);
                      void Promise.allSettled(
                        activeExecutionRefsRef.current.map((execution) =>
                          execution.kind === "job"
                            ? apiService.cancelJob(execution.id)
                            : apiService.cancelRun(execution.id),
                        ),
                      );
                    }}
                    className="h-auto w-full shrink-0 justify-center whitespace-normal rounded-full bg-red-600 px-6 py-2 text-center leading-5 text-white hover:bg-red-700"
                  >
                    <X className="mr-2 size-4" />
                    Kill
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  disabled={isBusy}
                  onClick={() => {
                    if (isBusy) return;
                    if (section.portfolio === "indmoneyUs") {
                      setDialogError(null);
                      setIndMoneySyncOnly(false);
                      setDialogOpen(true);
                      return;
                    }
                    void runWorkflow("zerodha");
                  }}
                  className="h-11 w-full justify-center gap-3 rounded-full bg-slate-950 px-7 text-xs font-extrabold uppercase tracking-[0.18em] text-white shadow-lg shadow-slate-950/15 hover:bg-slate-900 disabled:opacity-50 xl:w-auto"
                >
                  <Play className="size-4" />
                  {section.buttonLabel.toUpperCase()}
                </Button>
              )}
            </div>
            <button
              type="button"
              disabled={isBusy}
              onClick={() => toggleSpecificMode(section.portfolio)}
              className={
                specificMode[section.portfolio]
                  ? "rounded-full bg-blue-950 px-3 py-1 text-xs font-extrabold text-white shadow-sm hover:bg-blue-900 disabled:opacity-50"
                  : "text-xs font-semibold text-slate-700 underline-offset-4 hover:underline disabled:opacity-50"
              }
            >
              Run specific Stages
            </button>
          </div>
        </div>

        <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {STAGE_ORDER.map((stage) => (
            <WorkflowStageTile
              key={stage}
              stage={stage}
              info={
                queuedStages.has(stage)
                  ? { ...states[section.portfolio][stage], state: "queued" }
                  : states[section.portfolio][stage]
              }
              now={now}
              selectable={specificMode[section.portfolio] && !isBusy}
              selected={selectedStages[section.portfolio].has(stage)}
              onClick={
                specificMode[section.portfolio] && !isBusy
                  ? () => toggleStageSelection(section.portfolio, stage)
                  : () =>
                      navigateForStage(
                        section.portfolio,
                        stage,
                        states[section.portfolio][stage],
                      )
              }
              onInfoClick={
                stage !== "sync" && stage !== "actionables"
                  ? () => void showStageLlmInfo(section.portfolio, stage)
                  : undefined
              }
              onInputClick={
                stage === "threats" ||
                stage === "swing" ||
                stage === "rebalance" ||
                stage === "technical" ||
                stage === "actionables"
                  ? () => openInputSelection(section.portfolio, stage)
                  : undefined
              }
              onPromptClick={
                stage === "threats" ||
                stage === "swing" ||
                stage === "rebalance" ||
                stage === "technical"
                  ? () => showStagePrompt(section.portfolio, stage)
                  : undefined
              }
              onOutputClick={() =>
                void showStageOutput(section.portfolio, stage)
              }
              onSyncNowClick={
                stage === "sync"
                  ? () => {
                      if (section.portfolio === "indmoneyUs") {
                        setDialogError(null);
                        setIndMoneySyncOnly(true);
                        setDialogOpen(true);
                        return;
                      }
                      void syncPortfolioNow("zerodha");
                    }
                  : undefined
              }
              onPlaceOrderClick={
                stage === "actionables" && section.portfolio === "zerodha"
                  ? () => void openZerodhaBasketPreview()
                  : undefined
              }
              onCalculationsClick={
                stage === "actionables"
                  ? () => {
                      window.dispatchEvent(new CustomEvent("open-actionables-calculations", {
                        detail: { market: section.portfolio === "zerodha" ? "india" : "us" },
                      }));
                      window.location.hash = "final-actionables";
                    }
                  : undefined
              }
            />
          ))}
        </div>
        <div className="mt-5 flex items-center justify-between gap-3 rounded-2xl border border-emerald-100 bg-emerald-50 px-5 py-4 text-base font-normal text-emerald-950">
          <div>
            {getWorkflowRunDuration(states[section.portfolio], now)
              ? `Cumulative LLM time: ${getWorkflowRunDuration(states[section.portfolio], now)} · `
              : ""}
            Total cost incurred in last Auto-rebalance:{" "}
            {formatInrCost(
              getWorkflowRunCost(states[section.portfolio], usdInrRate) ||
                lastAutoRebalanceCosts[section.portfolio],
            )}
          </div>
          <button
            type="button"
            onClick={() => void openAutoRebalanceCostHistory(section.portfolio)}
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-emerald-200 bg-white text-emerald-700 shadow-sm transition hover:border-emerald-300 hover:bg-emerald-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            aria-label={`Open ${section.title} cost history`}
            title="Open previous scan cost history"
          >
            <History className="size-5" />
          </button>
        </div>
      </div>
    );
  };

  const zerodhaSection = sections[0];
  const indmoneySection = sections[1];

  return (
    <>
      <section className="grid gap-6 xl:grid-cols-2">
        {renderSectionCard(zerodhaSection)}
        {renderSectionCard(indmoneySection)}
      </section>

      <section className="mt-6">
        <ZerodhaRebalanceFlowCard />
      </section>

      <AutoRebalanceCostHistoryDialog
        open={Boolean(costHistoryPortfolio)}
        portfolio={costHistoryPortfolio}
        groups={costHistoryGroups}
        loading={costHistoryLoading}
        error={costHistoryError}
        usdInrRate={usdInrRate}
        selectedGroup={selectedCostGroup}
        onSelectGroup={setSelectedCostGroup}
        onClose={closeAutoRebalanceCostHistory}
        onCloseBreakdown={() => setSelectedCostGroup(null)}
      />

      <StageLlmSelectorDialog
        open={Boolean(llmDialogStage)}
        stage={llmDialogStage}
        portfolio={llmDialogPortfolio}
        providers={llmDialogProviders}
        selectedKeys={llmDialogSelectedKeys}
        historicalEstimatedCostInrByTarget={llmDialogHistoricalCosts}
        onToggle={toggleLlmTarget}
        onSelectAll={selectAllLlmTargets}
        onClear={clearLlmTargets}
        onResetDefaults={resetDefaultLlmTargets}
        onReplaceSelection={persistLlmDialogSelection}
        lastRunCostInr={
          llmDialogStage && llmDialogPortfolio
            ? getStageCostInr(
                states[llmDialogPortfolio][llmDialogStage],
                usdInrRate,
              )
            : null
        }
        onClose={() => {
          setLlmDialogStage(null);
          setLlmDialogPortfolio(null);
        }}
      />

      <InputSelectionDialog
        open={Boolean(inputDialog)}
        stage={inputDialog?.stage ?? null}
        candidates={inputCandidates}
        selectedIds={
          inputDialog
            ? selectedInputs[inputDialog.portfolio][inputDialog.stage]
            : new Set()
        }
        usdInrRate={usdInrRate}
        loading={inputCandidatesLoading}
        onToggle={toggleInputCandidate}
        onToggleAll={toggleAllInputCandidates}
        onResetDefaults={resetDefaultInputCandidates}
        onClose={() => setInputDialog(null)}
      />

      <ZerodhaBasketPreviewDialog
        open={zerodhaBasketOpen}
        loading={zerodhaBasketLoading}
        error={zerodhaBasketError}
        orders={zerodhaBasketOrders}
        selectedIds={selectedZerodhaBasketIds}
        onClose={() => setZerodhaBasketOpen(false)}
        onToggle={toggleZerodhaBasketOrder}
        onToggleAll={toggleAllZerodhaBasketOrders}
        onToggleSection={toggleZerodhaBasketSection}
        onOrderKindChange={updateZerodhaBasketOrderKind}
        onPercentChange={updateZerodhaBasketPercent}
        onUnitsChange={updateZerodhaBasketUnits}
        onPlaceOrder={placeSelectedZerodhaBasketOrders}
        placing={zerodhaBasketPlacing}
        directMarketAvailable={zerodhaDirectMarketAvailable}
        executionMode={zerodhaExecutionMode}
        onExecutionModeChange={changeZerodhaExecutionMode}
        onRefreshLtp={refreshZerodhaBasketLtp}
        ltpRefreshing={zerodhaBasketLtpRefreshing}
        ltpRefreshedAt={zerodhaBasketLtpRefreshedAt}
        submission={zerodhaBasketSubmission}
        detailsData={zerodhaBasketDetailsData}
        formulaConfig={scoreMatrixFormulaConfig}
        onFormulaConfigChange={handleScoreMatrixFormulaConfigChange}
        buyThreshold={zerodhaBasketBuyThreshold}
        buyThresholdDraft={zerodhaBasketBuyThresholdDraft}
        onBuyThresholdDraftChange={updateZerodhaBasketBuyThresholdDraft}
      />

      {promptDialog ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-sm" onClick={() => setPromptDialog(null)}>
          <div className="max-h-[85vh] w-full max-w-[calc(100vw-2rem)] overflow-hidden rounded-3xl bg-white shadow-2xl xl:max-w-[95vw]" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 p-5">
              <div>
                <h3 className="text-lg font-semibold text-slate-950">
                  {promptDialog.title}
                </h3>
                <p className="mt-1 text-sm text-slate-500">
                  Prompt template used by this Auto-Rebalance stage. Runtime input bundles are added when the workflow runs.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPromptDialog(null)}
                className="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                aria-label="Close prompt view"
              >
                <X className="size-5" />
              </button>
            </div>
            <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap p-5 text-sm leading-6 text-slate-700">
              {promptDialog.body}
            </pre>
          </div>
        </div>
      ) : null}

      {outputDialog ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/50 p-4" onClick={() => setOutputDialog(null)}>
          <div className="max-h-[85vh] w-full max-w-[calc(100vw-2rem)] overflow-hidden rounded-3xl bg-white shadow-2xl xl:max-w-[95vw]" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 p-5">
              <div>
                <h3 className="text-lg font-semibold text-slate-950">
                  {outputDialog.title}
                </h3>
                <p className="mt-1 text-sm text-slate-500">
                  Latest saved stage output for the selected portfolio.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOutputDialog(null)}
                className="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                aria-label="Close output view"
              >
                <X className="size-5" />
              </button>
            </div>
            <div className="max-h-[72vh] overflow-auto bg-white p-0 text-slate-900">
              {outputDialog.loading ? (
                <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
                  <Loader2 className="size-4 animate-spin" /> Loading output…
                </div>
              ) : outputDialog.error ? (
                <div className="m-5 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                  {outputDialog.error}
                </div>
              ) : outputDialog.routeUrl ? (
                <iframe
                  src={outputDialog.routeUrl}
                  title={outputDialog.title}
                  className="h-[72vh] w-full border-0 bg-white"
                />
              ) : outputDialog.run ? (
                <RunOutputDetails run={outputDialog.run} />
              ) : (
                <pre className="m-5 whitespace-pre-wrap break-words rounded-2xl bg-slate-950 p-5 text-xs leading-6 text-slate-100">
                  {outputDialog.body}
                </pre>
              )}
            </div>
          </div>
        </div>
      ) : null}

      <IndMoneySnapshotDialog
        open={dialogOpen}
        saving={runningPortfolio === "indmoneyUs"}
        error={dialogError}
        onClose={() => {
          if (runningPortfolio === "indmoneyUs") return;
          setDialogOpen(false);
          setIndMoneySyncOnly(false);
        }}
        onContinue={handleIndMoneyContinue}
      />
    </>
  );
}

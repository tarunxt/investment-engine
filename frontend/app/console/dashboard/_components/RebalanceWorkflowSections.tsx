"use client";

import {
  type SVGProps,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useUsdInrRate } from "@/hooks/useUsdInrRate";
import { AlertCircle, CheckCircle2, Loader2, Play, X } from "lucide-react";

import {
  buildConsensusRows,
  buildTechnicalScanPrompt,
  extractRebalanceInputFingerprint,
  fetchAllFullRuns,
  isCompletedRebalanceRun,
} from "@/app/console/_components/FinalActionablesConsole";
import { Button } from "@/components/ui/button";
import { LlmModelSelectionPanel } from "@/components/shared/LlmModelSelectionPanel";
import {
  buildRebalanceInputBundle,
  buildRebalancePrompt,
  ensureRebalanceFlowMarker,
  getPreviousMarketClose,
  getRebalanceDefaultExportSheetName,
} from "@/lib/rebalance";
import {
  buildSwingTradePrompt,
  getSwingTradeDefaultExportSheetName,
  getSwingTradeDefaultInvestmentAmount,
  type SwingTradeMarket,
} from "@/lib/swingTrade";
import { isRunInSwingTradeMarket } from "@/lib/runPresentation";
import { APIError, apiService } from "@/services/api";
import { URLs } from "@/lib/urls";
import type {
  IndMoneyUsPortfolioSnapshotCreateRequest,
  IndMoneyUsThreatAnalysis,
  ProviderInfo,
  ProviderModelTarget,
  RunCreate,
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
type InputSelectionStage = "swing" | "rebalance" | "technical" | "actionables";
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
};
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
};
type WorkflowState = Record<WorkflowStageKey, StageInfo>;
type IndMoneySyncMode = "reuse" | "paste";

type SavedModelMix = {
  id: string;
  name: string;
  targets: string[];
};

const MODEL_MIX_STORAGE_KEY = "investor:model-mixes:v1";
const AUTO_REBALANCE_MIX_NAME = "Auto Rebalance Model Mix";
const AUTO_REBALANCE_MIX_ALIASES = [
  AUTO_REBALANCE_MIX_NAME,
  "Auto rebalance Models Mix",
];
const GPT_4O_MINI_MODEL = "gpt-4o-mini";
const POLL_INTERVAL_MS = 3000;
const MAX_RUN_POLLS = 160;
const MAX_JOB_POLLS = 120;
const WORKFLOW_STORAGE_KEY = "investor:rebalance-workflow-state:v1";
const STAGE_LLM_SELECTION_STORAGE_KEY = "investor:dashboard-stage-llms:v1";
const WORKFLOW_COMPLETION_RESET_DELAY_MS = 5000;
export const ZERODHA_DASHBOARD_SYNC_NOW_EVENT =
  "investor:dashboard:zerodha-sync-now";

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
  if (state === "failed")
    return "border-red-300 bg-red-50 text-red-950 shadow-red-100 ring-1 ring-red-100";
  return "border-slate-200 bg-white text-slate-950 shadow-slate-100";
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

function summarizeRun(run: RunResponse) {
  const jobs = run.run_jobs?.map((link) => link.job).filter(Boolean) ?? [];
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

  return sourceTargets
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
    if (status === "completed" || status === "failed") return run;
    await sleep(POLL_INTERVAL_MS);
  }
  const lastRun = await apiService.getRun(runId);
  onProgress?.(lastRun);
  return lastRun;
}

async function waitForThreatCompletion(
  portfolio: WorkflowPortfolio,
  jobId: number,
): Promise<ZerodhaThreatAnalysis | IndMoneyUsThreatAnalysis> {
  for (let attempt = 0; attempt < MAX_JOB_POLLS; attempt += 1) {
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

function targetKey(target: ProviderModelTarget) {
  return `${target.provider}::${target.model}`;
}

function parseTargetKey(key: string): ProviderModelTarget | null {
  const [provider, model] = key.split("::");
  return provider && model ? { provider, model } : null;
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
  const savedTargets = readStageLlmSelection(stage)
    .filter((key) => compatibleKeys.has(key))
    .map(parseTargetKey)
    .filter((target): target is ProviderModelTarget => Boolean(target));

  return savedTargets.length > 0
    ? savedTargets
    : getDefaultStageTargets(stage, providers);
}

function buildRunPayload({
  prompt,
  targets,
  sheetName,
}: {
  prompt: string;
  targets: ProviderModelTarget[];
  sheetName?: string;
}): RunCreate {
  return {
    prompt,
    targets,
    allow_parallel: true,
    auto_export_enabled: Boolean(sheetName),
    export_sheet_name: sheetName,
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

function getCompletedLlmProgress(run: RunResponse) {
  const jobs = run.run_jobs?.map((link) => link.job).filter(Boolean) ?? [];
  return {
    completedLlms: jobs.filter(
      (job) => (job.status || "").toLowerCase() === "completed",
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
  };
}

function buildRunJobCandidates(runs: RunResponse[], stageLabel: string) {
  return runs.flatMap(
    (run) =>
      (run.run_jobs ?? [])
        .map((link) => buildRunJobCandidate(run, link.job?.id, stageLabel))
        .filter(Boolean) as InputSelectionCandidate[],
  );
}

function buildNextCandidate(
  stage: InputSelectionStage,
): InputSelectionCandidate {
  const labelByStage: Record<InputSelectionStage, string> = {
    swing: "Next Threat Scan output",
    rebalance: "Next Swing Scan output",
    technical: "Next Rebalance Scan output",
    actionables: "Next Technical Scan output",
  };
  return {
    id: `${stage}:next`,
    source: "next",
    label: labelByStage[stage],
    jobNo: "Next run",
    timestamp: null,
    status: "reserved",
    costUsd: null,
    error: null,
  };
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
  return run.updated_at ?? run.exported_at ?? run.created_at;
}

function sortRunsByLatestTimestamp(runs: RunResponse[]) {
  return [...runs].sort(
    (a, b) =>
      parseTimestampMs(getLatestRunTimestamp(b)) -
      parseTimestampMs(getLatestRunTimestamp(a)),
  );
}

function isCompletedTechnicalScanRun(
  run: RunResponse,
  market: SwingTradeMarket,
) {
  if ((run.status || "").toLowerCase() !== "completed") return false;
  if (!/##\s*Technical Scan Input Bundle/i.test(run.prompt)) return false;
  return market === "us"
    ? /Market:\s*US equities/i.test(run.prompt)
    : /Market:\s*India equities/i.test(run.prompt);
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
      ...getCompletedLlmProgress(run),
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

function getRunOutputSummary(run: RunResponse) {
  const jobs = run.run_jobs?.map((link) => link.job).filter(Boolean) ?? [];
  const completed = jobs.filter(
    (job) => (job.status || "").toLowerCase() === "completed",
  ).length;
  const failed = jobs.filter(
    (job) => (job.status || "").toLowerCase() === "failed",
  ).length;
  const partial = jobs.filter((job) => {
    const status = (job.status || "").toLowerCase();
    return (
      status === "partial" ||
      (Boolean(job.response?.trim()) && status !== "completed")
    );
  }).length;
  const costUsd = jobs.reduce(
    (total, job) => total + (job.estimated_cost ?? 0),
    0,
  );
  const duration = getRunDuration(run);
  return [
    `Run #${run.id} · ${formatTimestamp(run.created_at)} · LLMs used: ${jobs.length}`,
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

function formatLlmRun(info: StageInfo) {
  return (
    [info.provider, info.model].filter(Boolean).join(" / ") || "Not available"
  );
}

function getIdleStageRows(stage: WorkflowStageKey, info: StageInfo) {
  if (stage === "sync") {
    return [{ label: "Latest sync", value: formatTimestamp(info.completedAt) }];
  }
  if (stage === "swing") {
    return [
      {
        label: "Last swing job",
        value: info.lastRunId ? `#${info.lastRunId}` : "Not available",
      },
      { label: "Timestamp", value: formatTimestamp(info.completedAt) },
      { label: "LLMs completed", value: formatLlmCompletion(info) },
      {
        label: "Stocks recommended",
        value: info.recommendedStocks?.toString() ?? "n/a",
      },
      { label: "Cost incurred", value: formatInrCost(info.costInr) },
    ];
  }
  if (stage === "threats") {
    return [
      {
        label: "Latest guardrail scan",
        value: formatTimestamp(info.completedAt),
      },
      { label: "LLM run", value: formatLlmRun(info) },
      { label: "Cost incurred", value: formatInrCost(info.costInr) },
    ];
  }
  if (stage === "rebalance") {
    return [
      {
        label: "Last rebalance job",
        value: info.lastRunId ? `#${info.lastRunId}` : "Not available",
      },
      { label: "Timestamp", value: formatTimestamp(info.completedAt) },
      { label: "LLMs completed", value: formatLlmCompletion(info) },
      {
        label: "Stocks recommended",
        value: info.recommendedStocks?.toString() ?? "n/a",
      },
      { label: "Cost incurred", value: formatInrCost(info.costInr) },
    ];
  }
  if (stage === "technical") {
    return [
      { label: "Latest validation", value: formatTimestamp(info.completedAt) },
      { label: "LLM run", value: formatLlmRun(info) },
      { label: "Cost incurred", value: formatInrCost(info.costInr) },
    ];
  }
  return [
    {
      label: "Latest actionables refresh",
      value: formatTimestamp(info.completedAt),
    },
  ];
}

function SelectInputsIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M188 188V88h236v336H188V324"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="36"
      />
      <path
        d="M88 256h300"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="36"
      />
      <path
        d="M300 144l112 112-112 112"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="36"
      />
    </svg>
  );
}

function LlmDetailsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M23 7c-5.4 0-9.8 4.4-9.8 9.8v.7C8.9 18.8 5.8 22.8 5.8 27.6c0 2.8 1 5.4 2.9 7.4-2.4 2.3-3.9 5.6-3.9 9.2 0 7 5.6 12.6 12.6 12.6H23V7Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="3.4"
      />
      <path
        d="M41 7c5.4 0 9.8 4.4 9.8 9.8v.7c4.3 1.3 7.4 5.3 7.4 10.1 0 2.8-1 5.4-2.9 7.4 2.4 2.3 3.9 5.6 3.9 9.2 0 7-5.6 12.6-12.6 12.6H41V7Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="3.4"
      />
      <path
        d="M23 42V30l-8-8m8 8 8 8V13m10 29V31l8-8m-8 8-8 8V13"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="3.4"
      />
      {["15,22", "31,13", "49,23", "23,46", "41,46"].map((point) => {
        const [cx, cy] = point.split(",");
        return (
          <circle
            key={point}
            cx={cx}
            cy={cy}
            r="3.8"
            stroke="currentColor"
            strokeWidth="3.2"
          />
        );
      })}
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
  onOutputClick,
  onSyncNowClick,
}: {
  stage: WorkflowStageKey;
  info: StageInfo;
  now: number;
  selectable?: boolean;
  selected?: boolean;
  onClick?: () => void;
  onInfoClick?: () => void;
  onInputClick?: () => void;
  onOutputClick?: () => void;
  onSyncNowClick?: () => void;
}) {
  const isRunning = info.state === "running";
  const isQueued = info.state === "queued";
  const isCompleted = info.state === "completed";
  const stageMeta = STAGE_METADATA[stage];
  const showPromptShortcut = stage !== "sync" && Boolean(onClick);
  const iconButtonClasses =
    "inline-flex size-10 items-center justify-center rounded-full border border-blue-200 bg-blue-50 text-slate-800 shadow-sm transition hover:border-blue-400 hover:bg-blue-100 hover:text-blue-700";

  return (
    <button
      type="button"
      onClick={() => {
        onClick?.();
      }}
      disabled={!onClick}
      className={`relative flex min-h-[17rem] flex-col items-start justify-start rounded-2xl border p-5 text-left align-top shadow-sm transition hover:-translate-y-0.5 hover:shadow-md disabled:cursor-default disabled:hover:translate-y-0 ${selectable && selected ? "border-blue-400 bg-white text-slate-950 shadow-slate-100 ring-2 ring-blue-500" : getStageClasses(info.state)} ${selectable && !selected ? "bg-white opacity-100" : ""}`}
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
          className={`absolute right-5 top-5 ${iconButtonClasses} text-blue-700`}
          aria-label={`Show ${stageMeta.idle} LLM details`}
          title="LLM models and expected cost"
        >
          <LlmDetailsIcon className="size-6" />
        </span>
      ) : null}

      <div className="w-full px-10 text-center text-base font-extrabold text-slate-950">
        <div className="flex min-w-0 items-center justify-center gap-2">
          {isRunning ? (
            <Loader2 className="size-4 shrink-0 animate-spin text-amber-600" />
          ) : isQueued ? (
            <Play className="size-4 shrink-0 text-sky-600" />
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
          getIdleStageRows(stage, info).map((row) => (
            <p key={row.label}>
              <span className="font-extrabold text-slate-500">
                {row.label}:
              </span>{" "}
              {row.value}
            </p>
          ))
        ) : (
          <>
            {info.lastRunId ? (
              <p>
                <span className="font-extrabold text-slate-500">
                  Job Number:
                </span>{" "}
                #{info.lastRunId}
              </p>
            ) : null}
            {info.completedAt ? (
              <p>
                <span className="font-extrabold text-slate-500">
                  Timestamp:
                </span>{" "}
                {formatTimestamp(info.completedAt)}
              </p>
            ) : null}
            {formatDuration(info.startedAt, info.endedAt, now) ? (
              <p>
                <span className="font-extrabold text-slate-500">Duration:</span>{" "}
                {formatDuration(info.startedAt, info.endedAt, now)}
              </p>
            ) : null}
            {info.totalLlms ? (
              <p>
                <span className="font-extrabold text-slate-500">
                  LLMs completed:
                </span>{" "}
                {info.completedLlms ?? 0}/{info.totalLlms}
              </p>
            ) : null}
            {info.recommendedStocks ? (
              <p>
                <span className="font-extrabold text-slate-500">
                  Stocks recommended:
                </span>{" "}
                {info.recommendedStocks}
              </p>
            ) : null}
            {stage !== "sync" &&
            (info.provider ||
              info.model ||
              info.runStatus ||
              info.exportStatus ||
              info.costUsd ||
              info.error) ? (
              <>
                <p>
                  <span className="font-extrabold text-slate-500">
                    LLM run:
                  </span>{" "}
                  {[info.provider, info.model].filter(Boolean).join(" / ") ||
                    "LLM details not available yet"}
                </p>
                <p>
                  <span className="font-extrabold text-slate-500">
                    Run status:
                  </span>{" "}
                  {info.runStatus ?? "Waiting for job status"}
                </p>
                <p>
                  <span className="font-extrabold text-slate-500">
                    Sheets export:
                  </span>{" "}
                  {info.exportStatus ?? "No sheet export status yet"}
                </p>
                <p>
                  <span className="font-extrabold text-slate-500">
                    Cost incurred:
                  </span>{" "}
                  {formatInrCost(info.costInr)}
                </p>
                {info.error ? (
                  <p className="text-red-700">
                    <span className="font-extrabold">Error:</span> {info.error}
                  </p>
                ) : null}
              </>
            ) : null}
          </>
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
          className="mt-6 inline-flex h-10 items-center justify-center rounded-full bg-blue-600 px-6 text-sm font-extrabold text-white shadow-md shadow-blue-600/25 transition hover:bg-blue-700"
        >
          Sync Now
        </span>
      ) : null}

      <div className="mt-auto flex w-full items-end justify-between gap-3 pt-5">
        {showPromptShortcut ? (
          <span
            role="button"
            tabIndex={0}
            onClick={(event) => {
              event.stopPropagation();
              onClick?.();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                event.stopPropagation();
                onClick?.();
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
            <SelectInputsIcon className="size-6" />
          </span>
        ) : null}
      </div>
    </button>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
      <div className="w-full max-w-2xl rounded-3xl bg-white p-5 shadow-2xl">
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
            className="bg-blue-600 text-white hover:bg-blue-500"
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
  onClose: () => void;
}) {
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const allSelected =
    candidates.length > 0 &&
    candidates.every((candidate) => selectedIds.has(candidate.id));
  const someSelected = candidates.some((candidate) =>
    selectedIds.has(candidate.id),
  );

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someSelected && !allSelected;
    }
  }, [allSelected, someSelected]);

  if (!open || !stage) return null;

  const titleByStage: Record<InputSelectionStage, string> = {
    swing: "Select Threat Scan inputs",
    rebalance: "Select Swing Scan inputs",
    technical: "Select Rebalance Scan inputs",
    actionables: "Select Technical Scan inputs",
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
      <div className="max-h-[85vh] w-full max-w-5xl overflow-hidden rounded-3xl bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 p-5">
          <div>
            <h3 className="text-lg font-semibold text-slate-950">
              {titleByStage[stage]}
            </h3>
            <p className="mt-1 text-sm text-slate-500">
              Pick the previous-stage outputs this stage should consider. The
              reserved next-row is replaced by the live output when that earlier
              stage finishes.
            </p>
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
        <div className="max-h-[65vh] overflow-auto p-5">
          {loading ? (
            <div className="flex items-center justify-center gap-2 rounded-2xl border border-slate-200 p-8 text-sm text-slate-500">
              <Loader2 className="size-4 animate-spin" /> Loading eligible
              outputs…
            </div>
          ) : candidates.length === 0 ? (
            <div className="rounded-2xl border border-slate-200 p-8 text-sm text-slate-500">
              No eligible outputs are available yet.
            </div>
          ) : (
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="w-12 px-3 py-3">
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      checked={allSelected}
                      onChange={onToggleAll}
                      aria-label="Select or deselect all inputs"
                    />
                  </th>
                  <th className="px-3 py-3">Job / Run No</th>
                  <th className="px-3 py-3">Timestamp</th>
                  <th className="px-3 py-3">Status</th>
                  <th className="px-3 py-3">LLM / Source</th>
                  <th className="px-3 py-3">Cost (INR)</th>
                  <th className="px-3 py-3">Error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {candidates.map((candidate) => (
                  <tr
                    key={candidate.id}
                    className={
                      candidate.source === "next" ? "bg-blue-50/60" : "bg-white"
                    }
                  >
                    <td className="px-3 py-3 align-top">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(candidate.id)}
                        onChange={() => onToggle(candidate.id)}
                        aria-label={`Select ${candidate.label}`}
                      />
                    </td>
                    <td className="px-3 py-3 align-top font-semibold text-slate-900">
                      {candidate.jobNo}
                    </td>
                    <td className="px-3 py-3 align-top text-slate-600">
                      {candidate.timestamp
                        ? formatTimestamp(candidate.timestamp)
                        : "Reserved for next output"}
                    </td>
                    <td className="px-3 py-3 align-top">
                      <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">
                        {candidate.status}
                      </span>
                    </td>
                    <td className="px-3 py-3 align-top text-slate-700">
                      {candidate.label}
                    </td>
                    <td className="px-3 py-3 align-top text-slate-600">
                      {typeof candidate.costUsd === "number"
                        ? `₹${(candidate.costUsd * usdInrRate).toFixed(2)}`
                        : "n/a"}
                    </td>
                    <td className="max-w-xs px-3 py-3 align-top text-xs text-red-700">
                      {candidate.error || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="flex justify-end border-t border-slate-200 p-4">
          <Button
            type="button"
            onClick={onClose}
            className="bg-blue-600 text-white hover:bg-blue-500"
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

function StageLlmSelectorDialog({
  open,
  stage,
  providers,
  selectedKeys,
  onToggle,
  onSelectAll,
  onClear,
  onResetDefaults,
  onClose,
}: {
  open: boolean;
  stage: WorkflowStageKey | null;
  providers: ProviderInfo[];
  selectedKeys: Set<string>;
  onToggle: (key: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onResetDefaults: () => void;
  onClose: () => void;
}) {
  if (!open || !stage) return null;

  const singleSelect = stage === "threats" || stage === "technical";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 px-4 py-6 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">
              Select LLMs
            </p>
            <h3 className="mt-1 text-xl font-bold text-slate-950">
              {getStageLabel(stage, "idle")}
            </h3>
            <p className="mt-1 text-sm text-slate-500">
              Choose the provider/model targets this dashboard stage should use.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close LLM selector"
          >
            <X className="size-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <LlmModelSelectionPanel
            providers={providers}
            selectedKeys={selectedKeys}
            selectionMode={singleSelect ? "single" : "multiple"}
            emptyMessage="Loading provider models..."
            showBulkActions={!singleSelect}
            onToggle={onToggle}
            onSelectAll={singleSelect ? undefined : onSelectAll}
            onClear={onClear}
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
  const [llmDialogProviders, setLlmDialogProviders] = useState<ProviderInfo[]>(
    [],
  );
  const [llmDialogSelectedKeys, setLlmDialogSelectedKeys] = useState<
    Set<string>
  >(new Set());
  const [outputDialog, setOutputDialog] = useState<{
    portfolio: WorkflowPortfolio;
    stage: WorkflowStageKey;
    title: string;
    body: string;
    loading: boolean;
    error: string | null;
  } | null>(null);
  const activeRunIdsRef = useRef<number[]>([]);
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
          swing: Array.from(selectedInputs.zerodha.swing),
          rebalance: Array.from(selectedInputs.zerodha.rebalance),
          technical: Array.from(selectedInputs.zerodha.technical),
        },
        indmoneyUs: {
          swing: Array.from(selectedInputs.indmoneyUs.swing),
          rebalance: Array.from(selectedInputs.indmoneyUs.rebalance),
          technical: Array.from(selectedInputs.indmoneyUs.technical),
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

  const loadLatestIdleStageInfo = useCallback(async () => {
    const [
      zerodhaOverview,
      indmoneyOverview,
      zerodhaThreat,
      indmoneyThreat,
      runs,
    ] = await Promise.all([
      apiService.zerodhaPortfolioOverview(),
      apiService.indmoneyUsPortfolioOverview(),
      apiService.zerodhaThreatsLatest(),
      apiService.indmoneyUsThreatsLatest(),
      fetchAllFullRuns(),
    ]);

    const nextByPortfolio = (
      ["zerodha", "indmoneyUs"] as WorkflowPortfolio[]
    ).reduce(
      (acc, portfolio) => {
        const market: SwingTradeMarket =
          portfolio === "zerodha" ? "india" : "us";
        const latestSwingRun = sortRunsByLatestTimestamp(
          runs.filter(
            (run) =>
              (run.status || "").toLowerCase() === "completed" &&
              isRunInSwingTradeMarket(run.prompt, market),
          ),
        )[0];
        const latestRebalanceRun = sortRunsByLatestTimestamp(
          runs.filter((run) => isCompletedRebalanceRun(run, market)),
        )[0];
        const latestTechnicalRun = sortRunsByLatestTimestamp(
          runs.filter((run) => isCompletedTechnicalScanRun(run, market)),
        )[0];
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

        const overview =
          portfolio === "zerodha" ? zerodhaOverview : indmoneyOverview;
        const threat =
          portfolio === "zerodha"
            ? zerodhaThreat.analysis
            : indmoneyThreat.analysis;
        const syncStatus =
          portfolio === "zerodha"
            ? "last synced portfolio"
            : (indmoneyOverview.latest?.parse_status ?? "last snapshot");

        acc[portfolio] = {
          sync: {
            completedAt: overview.latest?.captured_at ?? null,
            runStatus: syncStatus,
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
          ),
          actionables: {
            completedAt: latestActionablesTimestamp ?? null,
            runStatus: latestActionablesTimestamp
              ? "derived from latest rebalance/technical scan"
              : null,
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
      [portfolio]: initialWorkflowState(),
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
              completedLlms: status === "completed" ? 1 : 0,
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
          const runSummary = withInrCost(
            { ...summarizeRun(run), ...getRunProgress(run), lastRunId: run.id },
            usdInrRate,
          );
          updateStage(runningPortfolio, stage, runSummary);
          if (status === "completed") {
            const market: SwingTradeMarket =
              runningPortfolio === "zerodha" ? "india" : "us";
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
        const nextCandidate = buildNextCandidate(stage);
        let candidates: InputSelectionCandidate[] = [nextCandidate];

        if (stage === "swing") {
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
              ),
            );
          } else if (stage === "technical") {
            candidates = candidates.concat(
              buildRunJobCandidates(
                sortRunsByLatestTimestamp(
                  runs.filter((run) => isCompletedRebalanceRun(run, market)),
                ),
                "Rebalance Scan",
              ),
            );
          } else {
            candidates = candidates.concat(
              buildRunJobCandidates(
                sortRunsByLatestTimestamp(
                  runs.filter((run) =>
                    isCompletedTechnicalScanRun(run, market),
                  ),
                ),
                "Technical Scan",
              ),
            );
          }
        }

        setInputCandidates(candidates);
        setSelectedInputs((current) => {
          const currentSet = current[portfolio][stage];
          const onlyReservedNext =
            currentSet.size === 1 && currentSet.has(nextCandidate.id);
          if (currentSet.size > 0 && !onlyReservedNext) return current;
          const defaultIds =
            stage === "rebalance"
              ? candidates.map((candidate) => candidate.id)
              : ([
                  nextCandidate.id,
                  candidates.find((candidate) => candidate.source !== "next")
                    ?.id,
                ].filter(Boolean) as string[]);
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
      activeRunIdsRef.current = Array.from(
        new Set([...activeRunIdsRef.current, runId]),
      );
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
        if (status === "completed") return run;

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

  const showStageLlmInfo = useCallback(async (stage: WorkflowStageKey) => {
    if (stage === "sync" || stage === "actionables") return;
    setLlmDialogStage(stage);
    setLlmDialogProviders([]);
    setLlmDialogSelectedKeys(new Set());
    try {
      const providers = await apiService.getProviders({
        prompt: buildSwingTradePrompt(
          "india",
          getSwingTradeDefaultInvestmentAmount("india"),
        ),
      });
      const targets = getSavedStageTargets(stage, providers);
      setLlmDialogProviders(providers);
      setLlmDialogSelectedKeys(new Set(targets.map(targetKey)));
    } catch (error) {
      setLlmDialogStage(null);
      window.alert(`Could not load LLM details: ${normalizeError(error)}`);
    }
  }, []);

  const showStageOutput = useCallback(
    async (portfolio: WorkflowPortfolio, stage: WorkflowStageKey) => {
      const title = `${portfolio === "zerodha" ? "Zerodha India" : "INDmoney US"} · ${STAGE_METADATA[stage].idle}`;
      setOutputDialog({
        portfolio,
        stage,
        title,
        body: "",
        loading: true,
        error: null,
      });
      try {
        const market: SwingTradeMarket =
          portfolio === "zerodha" ? "india" : "us";
        let body = "No saved output is available yet.";
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
          const latestRun = sortRunsByLatestTimestamp(
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
            latestRun?.run_jobs?.map((link) => link.job).filter(Boolean) ?? [];
          body = jobs.length
            ? [
                `## Last run summary\n${latestRun ? getRunOutputSummary(latestRun) : "Not available"}`,
                jobs
                  .map(
                    (job) =>
                      `# Run ${latestRun?.id} / Job ${job?.id} · ${job?.provider ?? "LLM"}/${job?.model ?? "model"}\n\n${job?.response?.trim() || job?.error_message || "No response text saved."}`,
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
        });
      } catch (error) {
        setOutputDialog({
          portfolio,
          stage,
          title,
          body: "",
          loading: false,
          error: normalizeError(error),
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
        technical: URLs.routes.console.dashboard(),
        actionables: `${URLs.routes.console.dashboard()}#final-actionables`,
      };
      window.open(hrefByStage[stage], "_blank", "noopener,noreferrer");
    },
    [],
  );

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
      activeRunIdsRef.current = [];
      cancelRequestedRef.current = false;
      pauseRequestedRef.current = false;
      setWorkflowPaused(false);

      let currentStage: WorkflowStageKey = "sync";
      let generatedThreatMarkdown = "";
      let generatedSwingRun: RunResponse | null = null;
      let generatedRebalanceRun: RunResponse | null = null;

      try {
        currentStage = "sync";
        if (shouldRunCurrentStage("sync")) {
          markRunning(portfolio, "sync");
          if (portfolio === "zerodha") {
            const synced = await apiService.zerodhaSyncPortfolio();
            const overview = await apiService.zerodhaPortfolioOverview();
            markCompleted(portfolio, "sync", {
              completedAt: overview.latest?.captured_at,
              runStatus: synced.status,
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
              ? await apiService.zerodhaRunThreats(threatTargets[0])
              : await apiService.indmoneyUsRunThreats(threatTargets[0]);
          updateStage(portfolio, "threats", {
            activeRunId: queuedThreat.job_id,
          });
          const completedThreat = await waitForThreatCompletion(
            portfolio,
            queuedThreat.job_id,
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
          markRunning(portfolio, "actionables");
          await onDashboardRefresh();
          markCompleted(portfolio, "actionables", {
            runStatus: "fresh data loaded",
          });
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
              swing: new Set(["swing:next"]),
              rebalance: new Set(["rebalance:next"]),
              technical: new Set(["technical:next"]),
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
      } finally {
        activeRunIdsRef.current = [];
        if (!cancelRequestedRef.current) setRunningPortfolio(null);
      }
    },
    [
      completeSkippedStage,
      markCompleted,
      markRunning,
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
      try {
        markRunning(portfolio, "sync");
        if (portfolio === "zerodha") {
          const synced = await apiService.zerodhaSyncPortfolio();
          const overview = await apiService.zerodhaPortfolioOverview();
          markCompleted(portfolio, "sync", {
            completedAt: overview.latest?.captured_at,
            runStatus: synced.status,
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
    [markCompleted, markRunning, onDashboardRefresh, updateStage],
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
        subtitle:
          "Queue the India sync, scans, rebalance, technical scan, and final actionable refresh.",
      },
      {
        portfolio: "indmoneyUs" as const,
        title: "Run Indmoney Auto-Rebalance",
        buttonLabel: "Run",
        subtitle:
          "Use the latest INDmoney snapshot or paste a fresh screen before the US rebalance workflow.",
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
              {section.subtitle}
            </p>
          </div>
          <div className="flex w-full flex-col items-start gap-3 xl:w-64 xl:items-end">
            <div className="flex w-full flex-col gap-2 sm:flex-row xl:w-auto">
              {isSectionRunning ? (
                <>
                  <Button
                    type="button"
                    onClick={() => {
                      pauseRequestedRef.current = !pauseRequestedRef.current;
                      setWorkflowPaused(pauseRequestedRef.current);
                    }}
                    className="h-auto w-full justify-center whitespace-normal rounded-full bg-orange-500 py-2 text-center leading-5 text-white hover:bg-orange-600 xl:w-auto"
                  >
                    {workflowPaused ? "Resume" : "Pause"}
                  </Button>
                  <Button
                    type="button"
                    onClick={() => {
                      cancelRequestedRef.current = true;
                      pauseRequestedRef.current = false;
                      setWorkflowPaused(false);
                    }}
                    className="h-auto w-full justify-center whitespace-normal rounded-full bg-red-600 py-2 text-center leading-5 text-white hover:bg-red-700 xl:w-auto"
                  >
                    <X className="mr-2 size-4" />
                    Kill Rebalance
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
            <p className="text-xs text-slate-500">
              Last run on{" "}
              {formatTimestamp(lastRunByPortfolio[section.portfolio])}
            </p>
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

        {specificMode[section.portfolio] ? (
          <p className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            Select only the stages to run. No stages are selected by default;
            unselected stages are skipped and use the latest saved output only
            when a later selected stage needs context.
          </p>
        ) : null}

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
                  ? () => void showStageLlmInfo(stage)
                  : undefined
              }
              onInputClick={
                stage === "swing" ||
                stage === "rebalance" ||
                stage === "technical" ||
                stage === "actionables"
                  ? () => openInputSelection(section.portfolio, stage)
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
            />
          ))}
        </div>
        <div className="mt-5 rounded-2xl border border-emerald-100 bg-emerald-50 px-5 py-4 text-base font-extrabold text-emerald-950">
          {getWorkflowRunDuration(states[section.portfolio], now)
            ? `Cumulative LLM time: ${getWorkflowRunDuration(states[section.portfolio], now)} · `
            : ""}
          Total cost incurred in last Auto-rebalance:{" "}
          {formatInrCost(
            getWorkflowRunCost(states[section.portfolio], usdInrRate) ||
              lastAutoRebalanceCosts[section.portfolio],
          )}
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

      <StageLlmSelectorDialog
        open={Boolean(llmDialogStage)}
        stage={llmDialogStage}
        providers={llmDialogProviders}
        selectedKeys={llmDialogSelectedKeys}
        onToggle={toggleLlmTarget}
        onSelectAll={selectAllLlmTargets}
        onClear={clearLlmTargets}
        onResetDefaults={resetDefaultLlmTargets}
        onClose={() => setLlmDialogStage(null)}
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
        onClose={() => setInputDialog(null)}
      />

      {outputDialog ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <div className="max-h-[85vh] w-full max-w-5xl overflow-hidden rounded-3xl bg-white shadow-2xl">
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
            <div className="max-h-[65vh] overflow-auto bg-slate-950 p-5 text-slate-100">
              {outputDialog.loading ? (
                <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-300">
                  <Loader2 className="size-4 animate-spin" /> Loading output…
                </div>
              ) : outputDialog.error ? (
                <div className="rounded-2xl border border-red-300 bg-red-950/40 p-4 text-sm text-red-100">
                  {outputDialog.error}
                </div>
              ) : (
                <pre className="whitespace-pre-wrap break-words text-xs leading-6">
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

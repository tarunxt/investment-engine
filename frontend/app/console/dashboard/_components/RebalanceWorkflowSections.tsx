"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useUsdInrRate } from "@/hooks/useUsdInrRate";
import {
  AlertCircle,
  CheckCircle2,
  Info,
  Loader2,
  Play,
  SlidersHorizontal,
  X,
} from "lucide-react";

import {
  buildConsensusRows,
  buildTechnicalScanPrompt,
  extractRebalanceInputFingerprint,
  fetchAllFullRuns,
  isCompletedRebalanceRun,
} from "@/app/console/_components/FinalActionablesConsole";
import { Button } from "@/components/ui/button";
import {
  buildRebalanceInputBundle,
  buildRebalancePrompt,
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
import { apiService } from "@/services/api";
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
type InputSelectionStage = "swing" | "rebalance" | "technical";
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

const STAGE_ORDER: WorkflowStageKey[] = [
  "sync",
  "threats",
  "swing",
  "rebalance",
  "technical",
  "actionables",
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
  selectedInputs?: Record<WorkflowPortfolio, Partial<Record<InputSelectionStage, string[]>>>;
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
      return specificMode[portfolio] ? selectedStages[portfolio].has(stage) : true;
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
  if (state === "queued") return `Queued ${STAGE_METADATA[stage].idle}`;
  if (state === "completed") return STAGE_METADATA[stage].completed;
  return STAGE_METADATA[stage].idle;
}

function getStageClasses(state: StageState) {
  if (state === "completed")
    return "border-emerald-300 bg-emerald-50 text-emerald-950 shadow-emerald-100";
  if (state === "running")
    return "border-amber-300 bg-amber-50 text-amber-950 shadow-amber-100";
  if (state === "queued")
    return "border-sky-300 bg-sky-50 text-sky-950 shadow-sky-100 ring-1 ring-sky-200";
  if (state === "failed")
    return "border-red-300 bg-red-50 text-red-950 shadow-red-100";
  return "border-slate-200 bg-white text-slate-950 shadow-slate-100";
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

function describeTargets(
  targets: ProviderModelTarget[],
  providers: ProviderInfo[],
) {
  const providerMap = new Map(
    providers.map((provider) => [provider.name, provider]),
  );
  const totalCostInr = targets.reduce((total, target) => {
    const provider = providerMap.get(target.provider);
    const cost = provider?.model_estimated_cost_inr?.[target.model];
    return total + (typeof cost === "number" ? cost : 0);
  }, 0);
  return {
    totalCostInr,
    lines: targets.map((target) => {
      const provider = providerMap.get(target.provider);
      const cost = provider?.model_estimated_cost_inr?.[target.model];
      return `${target.provider} / ${target.model}${typeof cost === "number" ? ` — est. ₹${cost.toFixed(2)}` : ""}`;
    }),
  };
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
  return status === "completed" || status === "partial" || Boolean(job?.response?.trim());
}

function getRunJobTimestamp(run: RunResponse, job?: { updated_at?: string | null; created_at?: string | null }) {
  return job?.updated_at ?? job?.created_at ?? getLatestRunTimestamp(run);
}

function buildRunJobCandidate(run: RunResponse, jobId: number | undefined, stageLabel: string): InputSelectionCandidate | null {
  const link = run.run_jobs?.find((item) => item.job?.id === jobId);
  const job = link?.job;
  if (!job || !isUsableStageJob(job)) return null;
  const costUsd = typeof job.estimated_cost === "number" ? job.estimated_cost : null;
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
  return runs.flatMap((run) =>
    (run.run_jobs ?? [])
      .map((link) => buildRunJobCandidate(run, link.job?.id, stageLabel))
      .filter(Boolean) as InputSelectionCandidate[],
  );
}

function buildNextCandidate(stage: InputSelectionStage): InputSelectionCandidate {
  const labelByStage: Record<InputSelectionStage, string> = {
    swing: "Next Threat Scan output",
    rebalance: "Next Swing Scan output",
    technical: "Next Rebalance Scan output",
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

function filterRunToSelectedJobs(run: RunResponse, selectedIds: Set<string>): RunResponse | null {
  const runJobs = (run.run_jobs ?? []).filter((link) =>
    selectedIds.has(`run:${run.id}:job:${link.job?.id}`),
  );
  if (runJobs.length === 0) return null;
  return { ...run, run_jobs: runJobs };
}

function uniqueRunsBySelectedCandidates(candidates: InputSelectionCandidate[], selectedIds: Set<string>) {
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
      { label: "Latest guardrail scan", value: formatTimestamp(info.completedAt) },
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

function WorkflowStageTile({
  stage,
  info,
  now,
  selectable,
  selected,
  onClick,
  onInfoClick,
  onInputClick,
}: {
  stage: WorkflowStageKey;
  info: StageInfo;
  now: number;
  selectable?: boolean;
  selected?: boolean;
  onClick?: () => void;
  onInfoClick?: () => void;
  onInputClick?: () => void;
}) {
  const isRunning = info.state === "running";
  const isQueued = info.state === "queued";
  const isCompleted = info.state === "completed";
  const showRunTag = selectable && selected && !isQueued;
  const stageMeta = STAGE_METADATA[stage];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick || isRunning}
      className={`relative flex min-h-44 flex-col items-start justify-start rounded-2xl border p-4 text-left align-top shadow-sm transition hover:-translate-y-0.5 hover:shadow-md disabled:cursor-default disabled:hover:translate-y-0 ${selectable && selected ? "border-emerald-400 bg-emerald-50 text-emerald-950 shadow-emerald-100 ring-2 ring-emerald-500" : getStageClasses(info.state)} ${selectable && !selected ? "bg-white opacity-100" : ""}`}
    >
      {showRunTag ? (
        <span className="absolute right-3 top-3 rounded-full border border-green-500 bg-green-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
          Run
        </span>
      ) : isQueued ? (
        <span className="absolute right-3 top-3 rounded-full border border-sky-500 bg-sky-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
          Queued
        </span>
      ) : isCompleted ? (
        <CheckCircle2 className="absolute right-3 top-3 size-5 text-emerald-600" />
      ) : null}
      <span className="mb-2 inline-flex rounded-full border border-slate-200 bg-slate-100 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-600">
        Step {stageMeta.step}
      </span>
      <div className="flex items-start gap-2 pr-7 text-sm font-semibold">
        {isRunning ? (
          <Loader2 className="size-4 animate-spin text-amber-600" />
        ) : isQueued ? (
          <Play className="size-4 text-sky-600" />
        ) : info.state === "failed" ? (
          <AlertCircle className="size-4 text-red-600" />
        ) : isCompleted ? (
          <CheckCircle2 className="size-4 text-emerald-600" />
        ) : null}
        {getStageLabel(stage, info.state)}
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
            className="inline-flex size-5 items-center justify-center rounded-full border border-blue-200 bg-blue-50 text-blue-700 hover:border-blue-400 hover:bg-blue-100"
            aria-label={`Show ${stageMeta.idle} LLM details`}
            title="LLM models and expected cost"
          >
            <Info className="size-3" />
          </span>
        ) : null}
      </div>
      {onInputClick ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onInputClick();
          }}
          className="mt-3 inline-flex items-center rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700 hover:border-indigo-400 hover:bg-indigo-100"
        >
          <SlidersHorizontal className="mr-1.5 size-3.5" />
          Select Inputs
        </button>
      ) : null}
      <p className="mt-2 text-xs leading-5 text-slate-500">
        {stageMeta.tileDescription}
      </p>
      <div className="mt-3 w-full space-y-1 text-xs leading-5 text-slate-600">
        {info.state === "idle" || info.state === "queued" ? (
          getIdleStageRows(stage, info).map((row) => (
            <p key={row.label}>
              <span className="font-semibold text-slate-500">{row.label}:</span>{" "}
              {row.value}
            </p>
          ))
        ) : (
          <>
            {info.lastRunId ? <p>Job Number: #{info.lastRunId}</p> : null}
            {info.completedAt ? (
              <p>Timestamp: {formatTimestamp(info.completedAt)}</p>
            ) : null}
            {formatDuration(info.startedAt, info.endedAt, now) ? (
              <p>
                Duration: {formatDuration(info.startedAt, info.endedAt, now)}
              </p>
            ) : null}
            {info.totalLlms ? (
              <p>
                {info.completedLlms ?? 0}/{info.totalLlms} LLMs completed
              </p>
            ) : null}
            {info.recommendedStocks ? (
              <p>Stocks recommended: {info.recommendedStocks}</p>
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
                  LLM:{" "}
                  {[info.provider, info.model].filter(Boolean).join(" / ") ||
                    "LLM details not available yet"}
                </p>
                <p>
                  LLM Run Status: {info.runStatus ?? "Waiting for job status"}
                </p>
                <p>
                  Sheets Export Status:{" "}
                  {info.exportStatus ?? "No sheet export status yet"}
                </p>
                <p>
                  Cost (USD / INR):{" "}
                  {info.costUsd ? `$${info.costUsd.toFixed(4)}` : "n/a"} /{" "}
                  {info.costInr ? `₹${info.costInr.toFixed(2)}` : "n/a"}
                </p>
                {info.error ? (
                  <p className="text-red-700">Error: {info.error}</p>
                ) : null}
              </>
            ) : null}
          </>
        )}
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
  const allSelected = candidates.length > 0 && candidates.every((candidate) => selectedIds.has(candidate.id));
  const someSelected = candidates.some((candidate) => selectedIds.has(candidate.id));

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
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
      <div className="max-h-[85vh] w-full max-w-5xl overflow-hidden rounded-3xl bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 p-5">
          <div>
            <h3 className="text-lg font-semibold text-slate-950">{titleByStage[stage]}</h3>
            <p className="mt-1 text-sm text-slate-500">
              Pick the previous-stage outputs this stage should consider. The reserved next-row is replaced by the live output when that earlier stage finishes.
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
              <Loader2 className="size-4 animate-spin" /> Loading eligible outputs…
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
                  <tr key={candidate.id} className={candidate.source === "next" ? "bg-blue-50/60" : "bg-white"}>
                    <td className="px-3 py-3 align-top">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(candidate.id)}
                        onChange={() => onToggle(candidate.id)}
                        aria-label={`Select ${candidate.label}`}
                      />
                    </td>
                    <td className="px-3 py-3 align-top font-semibold text-slate-900">{candidate.jobNo}</td>
                    <td className="px-3 py-3 align-top text-slate-600">{candidate.timestamp ? formatTimestamp(candidate.timestamp) : "Reserved for next output"}</td>
                    <td className="px-3 py-3 align-top">
                      <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">{candidate.status}</span>
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
          )}
        </div>
        <div className="flex justify-end border-t border-slate-200 p-4">
          <Button type="button" onClick={onClose} className="bg-blue-600 text-white hover:bg-blue-500">
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}

function RebalanceFlowIcon({ className = "size-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" className={className} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="5">
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
        <span className="h-0.5 w-12 rounded-full bg-blue-600" aria-hidden="true" />
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
                <p className="text-sm font-semibold text-slate-900">{item.label}</p>
                <p className="text-xs leading-5 text-slate-500">{item.description}</p>
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
            The sync stage feeds a risk and guardrail lane plus an opportunity
            lane. Those inputs combine in rebalance, move through technical
            validation, and finally publish buy or add, sell or trim, and hold
            or watch outputs.
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

          <text x="316" y="88" fill="#881337" fontSize="15" fontWeight="700">
            Risk / guardrail lane
          </text>
          <text x="316" y="112" fill="#9f1239" fontSize="12">
            Threats decide what should block adds, force trims, or preserve cash.
          </text>
          <text x="316" y="320" fill="#115e59" fontSize="15" fontWeight="700">
            Opportunity lane
          </text>
          <text x="316" y="344" fill="#0f766e" fontSize="12">
            Swing scan surfaces where fresh capital or adds have the best setup.
          </text>
          <text x="1152" y="128" fill="#334155" fontSize="12" fontWeight="700">
            Step 06
          </text>
          <text x="1152" y="152" fill="#0f172a" fontSize="18" fontWeight="700">
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
          <text x="564" y="132" fill="#9f1239" fontSize="12" fontWeight="700">
            Risk inputs into rebalance
          </text>
          <text x="564" y="154" fill="#881337" fontSize="12">
            Threat score, downside flags, concentration and cash discipline.
          </text>
          <text x="564" y="402" fill="#115e59" fontSize="12" fontWeight="700">
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
          <text x="708" y="122" fill="#991b1b" fontSize="12" fontWeight="700">
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
          <text x="926" y="366" fill="#991b1b" fontSize="12" fontWeight="700">
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
              <text x="1170" y={output.y + 44} fill="#475569" fontSize="11.5">
                {output.subtitleLines.map((line, index) => (
                  <tspan key={`${output.title}-${line}`} x="1170" dy={index === 0 ? 0 : 14}>
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

export function RebalanceWorkflowSections({
  onDashboardRefresh,
}: {
  onDashboardRefresh: () => Promise<void>;
}) {
  const router = useRouter();
  const usdInrRate = useUsdInrRate();
  const [initialPersisted] = useState<PersistedWorkflow | null>(() =>
    readPersistedWorkflow(),
  );
  const [states, setStates] = useState<
    Record<WorkflowPortfolio, WorkflowState>
  >(() => initialPersisted?.states ?? buildInitialStates());
  const [runningPortfolio, setRunningPortfolio] = useState<WorkflowPortfolio | null>(
    () => initialPersisted?.runningPortfolio ?? null,
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [specificMode, setSpecificMode] = useState<
    Record<WorkflowPortfolio, boolean>
  >(() => initialPersisted?.specificMode ?? { zerodha: false, indmoneyUs: false });
  const [selectedStages, setSelectedStages] = useState<
    Record<WorkflowPortfolio, Set<WorkflowStageKey>>
  >(() => ({
    zerodha: new Set(initialPersisted?.selectedStages?.zerodha ?? []),
    indmoneyUs: new Set(initialPersisted?.selectedStages?.indmoneyUs ?? []),
  }));
  const [selectedInputs, setSelectedInputs] = useState<
    Record<WorkflowPortfolio, Record<InputSelectionStage, Set<string>>>
  >(() => ({
    zerodha: {
      swing: new Set(initialPersisted?.selectedInputs?.zerodha?.swing ?? ["swing:next"]),
      rebalance: new Set(initialPersisted?.selectedInputs?.zerodha?.rebalance ?? ["rebalance:next"]),
      technical: new Set(initialPersisted?.selectedInputs?.zerodha?.technical ?? ["technical:next"]),
    },
    indmoneyUs: {
      swing: new Set(initialPersisted?.selectedInputs?.indmoneyUs?.swing ?? ["swing:next"]),
      rebalance: new Set(initialPersisted?.selectedInputs?.indmoneyUs?.rebalance ?? ["rebalance:next"]),
      technical: new Set(initialPersisted?.selectedInputs?.indmoneyUs?.technical ?? ["technical:next"]),
    },
  }));
  const [inputDialog, setInputDialog] = useState<{
    portfolio: WorkflowPortfolio;
    stage: InputSelectionStage;
  } | null>(null);
  const [inputCandidates, setInputCandidates] = useState<InputSelectionCandidate[]>([]);
  const [inputCandidatesLoading, setInputCandidatesLoading] = useState(false);
  const activeRunIdsRef = useRef<number[]>([]);
  const cancelRequestedRef = useRef(false);

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
      savedAt: new Date().toISOString(),
    });
  }, [runningPortfolio, selectedInputs, selectedStages, specificMode, states]);

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
          persistWorkflow({ ...persisted, states: next, savedAt: new Date().toISOString() });
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
          : { startedAt: timestamp, endedAt: timestamp, completedAt: timestamp }),
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
        const market: SwingTradeMarket = portfolio === "zerodha" ? "india" : "us";
        const nextCandidate = buildNextCandidate(stage);
        let candidates: InputSelectionCandidate[] = [nextCandidate];

        if (stage === "swing") {
          const latest =
            portfolio === "zerodha"
              ? (await apiService.zerodhaThreatsLatest()).analysis
              : (await apiService.indmoneyUsThreatsLatest()).analysis;
          if (latest && isUsableStageJob({ status: latest.status, response: latest.report?.raw_markdown })) {
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
                    .filter((run) => parseTimestampMs(run.created_at) > previousClose.getTime())
                    .filter((run) => isRunInSwingTradeMarket(run.prompt, market)),
                ),
                "Swing Scan",
              ),
            );
          } else {
            candidates = candidates.concat(
              buildRunJobCandidates(
                sortRunsByLatestTimestamp(runs.filter((run) => isCompletedRebalanceRun(run, market))),
                "Rebalance Scan",
              ),
            );
          }
        }

        setInputCandidates(candidates);
        setSelectedInputs((current) => {
          const currentSet = current[portfolio][stage];
          const onlyReservedNext = currentSet.size === 1 && currentSet.has(nextCandidate.id);
          if (currentSet.size > 0 && !onlyReservedNext) return current;
          const defaultIds = stage === "rebalance"
            ? candidates.map((candidate) => candidate.id)
            : [nextCandidate.id, candidates.find((candidate) => candidate.source !== "next")?.id]
                .filter(Boolean) as string[];
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
      if (stage !== "swing" && stage !== "rebalance" && stage !== "technical") return;
      const inputStage = stage as InputSelectionStage;
      setInputDialog({ portfolio, stage: inputStage });
      void loadInputCandidates(portfolio, inputStage).catch((error) => {
        setInputCandidates([]);
        window.alert(`Could not load selectable inputs: ${normalizeError(error)}`);
      });
    },
    [loadInputCandidates],
  );

  const toggleInputCandidate = useCallback((id: string) => {
    if (!inputDialog) return;
    setSelectedInputs((current) => {
      const nextSet = new Set(current[inputDialog.portfolio][inputDialog.stage]);
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
  }, [inputDialog]);

  const toggleAllInputCandidates = useCallback(() => {
    if (!inputDialog) return;
    setSelectedInputs((current) => {
      const allSelected = inputCandidates.every((candidate) => current[inputDialog.portfolio][inputDialog.stage].has(candidate.id));
      return {
        ...current,
        [inputDialog.portfolio]: {
          ...current[inputDialog.portfolio],
          [inputDialog.stage]: allSelected ? new Set() : new Set(inputCandidates.map((candidate) => candidate.id)),
        },
      };
    });
  }, [inputDialog, inputCandidates]);

  const cancelActiveWorkflow = useCallback(async () => {
    cancelRequestedRef.current = true;
    const runIds = Array.from(new Set(activeRunIdsRef.current));
    await Promise.allSettled(
      runIds.map((runId) => apiService.cancelRun(runId)),
    );
    if (runningPortfolio) {
      STAGE_ORDER.forEach((stage) => {
        const info = states[runningPortfolio][stage];
        if (info.state === "running") {
          updateStage(runningPortfolio, stage, {
            state: "failed",
            endedAt: new Date().toISOString(),
            runStatus: "cancelled",
            error:
              "Killed by user. Any queued/pending LLM jobs were marked failed; in-flight provider calls are ignored if they return later.",
          });
        }
      });
    }
    setRunningPortfolio(null);
  }, [runningPortfolio, states, updateStage]);

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
        const run = await waitForRunCompletion(
          runId,
          (progressRun) =>
            updateStage(portfolio, stage, getRunProgress(progressRun)),
          () => cancelRequestedRef.current,
        );
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
    try {
      const providers = await apiService.getProviders({
        prompt: buildSwingTradePrompt(
          "india",
          getSwingTradeDefaultInvestmentAmount("india"),
        ),
      });
      const targets =
        stage === "threats" || stage === "technical"
          ? getGpt4oMiniTarget(providers)
            ? [getGpt4oMiniTarget(providers)!]
            : []
          : getRunTargetsFromStoredMix(providers);
      if (targets.length === 0) {
        window.alert(
          `No compatible LLM targets found for ${getStageLabel(stage, "idle")}. For Swing Scan and Rebalance, save models in "${AUTO_REBALANCE_MIX_NAME}".`,
        );
        return;
      }
      const details = describeTargets(targets, providers);
      window.alert(
        [
          `${getStageLabel(stage, "idle")} will use:`,
          "",
          ...details.lines,
          "",
          `Expected cost: ₹${details.totalCostInr.toFixed(2)}`,
        ].join("\n"),
      );
    } catch (error) {
      window.alert(`Could not load LLM details: ${normalizeError(error)}`);
    }
  }, []);

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
        actionables: zerodha
          ? `${URLs.routes.console.dashboard()}#final-actionable-zerodha`
          : `${URLs.routes.console.dashboard()}#final-actionable-us`,
      };
      router.push(hrefByStage[stage]);
    },
    [router],
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
      setRunningPortfolio(portfolio);
      resetPortfolio(portfolio);
      activeRunIdsRef.current = [];
      cancelRequestedRef.current = false;

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
        const modelMixTargets = needsModelMix
          ? getRunTargetsFromStoredMix(providers)
          : [];
        if (needsModelMix && modelMixTargets.length === 0) {
          throw new Error(
            `No compatible targets found in "${AUTO_REBALANCE_MIX_NAME}". Open the model mix picker and add the exact LLMs you want the swing scan and rebalance stages to use; legacy "Auto rebalance Models Mix" is also accepted.`,
          );
        }
        const gpt4oMiniTarget = needsSingleModel
          ? getGpt4oMiniTarget(providers)
          : null;
        if (needsSingleModel && !gpt4oMiniTarget)
          throw new Error(
            `${GPT_4O_MINI_MODEL} is not available from a configured provider. This means the provider is not configured, the model is not listed for that provider, or the model compatibility check marked it unavailable.`,
          );

        currentStage = "threats";
        if (shouldRunCurrentStage("threats")) {
          markRunning(portfolio, "threats", { totalLlms: 1, completedLlms: 0 });
          const queuedThreat =
            portfolio === "zerodha"
              ? await apiService.zerodhaRunThreats(gpt4oMiniTarget!)
              : await apiService.indmoneyUsRunThreats(gpt4oMiniTarget!);
          updateStage(portfolio, "threats", { activeRunId: queuedThreat.job_id });
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

        currentStage = "swing";
        if (shouldRunCurrentStage("swing")) {
          markRunning(portfolio, "swing", {
            totalLlms: modelMixTargets.length,
            completedLlms: 0,
          });
          const swingInputSelection = selectedInputs[portfolio].swing;
          const selectedThreatParts: string[] = [];
          if (swingInputSelection.has("swing:next") && generatedThreatMarkdown.trim()) {
            selectedThreatParts.push(`## Next Threat Scan output\n\n${generatedThreatMarkdown.trim()}`);
          }
          if ([...swingInputSelection].some((id) => id.startsWith("threat:"))) {
            const latestThreat =
              portfolio === "zerodha"
                ? (await apiService.zerodhaThreatsLatest()).analysis
                : (await apiService.indmoneyUsThreatsLatest()).analysis;
            if (latestThreat?.report?.raw_markdown && swingInputSelection.has(`threat:${latestThreat.job_id}`)) {
              selectedThreatParts.push(`## Selected Threat Scan #${latestThreat.job_id}\n\n${latestThreat.report.raw_markdown.trim()}`);
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
              targets: modelMixTargets,
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

        currentStage = "rebalance";
        if (shouldRunCurrentStage("rebalance")) {
          markRunning(portfolio, "rebalance", {
            totalLlms: modelMixTargets.length,
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
            fullRunCandidates.filter((run) => isRunInSwingTradeMarket(run.prompt, market)),
            "Swing Scan",
          );
          const selectedRebalanceInputs = selectedInputs[portfolio].rebalance;
          const selectedSwingRuns = selectedRebalanceInputs.size
            ? uniqueRunsBySelectedCandidates(swingCandidates, selectedRebalanceInputs)
            : [];
          const swingRuns = [
            ...(selectedRebalanceInputs.has("rebalance:next") && generatedSwingRun ? [generatedSwingRun] : []),
            ...(selectedSwingRuns.length ? selectedSwingRuns : fullRunCandidates
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
                `${buildRebalancePrompt(market)}\n\n---\n\n${inputBundle}`.trim(),
              targets: modelMixTargets,
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
                buildRunJobCandidates(allRuns.filter((run) => isCompletedRebalanceRun(run, market)), "Rebalance Scan"),
                selectedTechnicalInputs,
              )
            : [];
          const rebalanceInputs = [
            ...(selectedTechnicalInputs.has("technical:next") && generatedRebalanceRun ? [generatedRebalanceRun] : []),
            ...(selectedRebalanceRuns.length ? selectedRebalanceRuns : getLatestMatchingRebalanceRuns(allRuns, market)),
          ];
          const consensus = buildConsensusRows(
            rebalanceInputs,
            market,
          );
          if (consensus.length === 0)
            throw new Error(
              "No fresh rebalance consensus rows were available for technical scan. Run or keep the Rebalance stage selected, or allow this stage to use the latest completed rebalance output.",
            );
          const technicalRun = await apiService.createRun(
            buildRunPayload({
              prompt: buildTechnicalScanPrompt(consensus, market),
              targets: [gpt4oMiniTarget!],
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
      waitForRunWithStageHandling,
    ],
  );


  const handleIndMoneyContinue = useCallback(
    (
      mode: IndMoneySyncMode,
      payload?: IndMoneyUsPortfolioSnapshotCreateRequest,
    ) => {
      setDialogError(null);
      setDialogOpen(false);
      void runWorkflow("indmoneyUs", mode === "paste" ? payload : undefined);
    },
    [runWorkflow],
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
        title: "Run Zerodha Rebalance",
        buttonLabel: "Run Zerodha Auto-Rebalance",
        subtitle:
          "Queue the India sync, scans, rebalance, technical scan, and final actionable refresh.",
      },
      {
        portfolio: "indmoneyUs" as const,
        title: "Run IndMoney Rebalance",
        buttonLabel: "Run Indmoney Auto-Rebalance",
        subtitle:
          "Use the latest INDmoney snapshot or paste a fresh screen before the US rebalance workflow.",
      },
    ],
    [],
  );

  const renderSectionCard = (section: (typeof sections)[number]) => {
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
        className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm"
      >
        <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-slate-950">
              {section.title}
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              {section.subtitle}
            </p>
          </div>
          <div className="flex w-full flex-col items-start gap-2 xl:w-auto xl:items-end">
            <Button
              type="button"
              disabled={isBusy && runningPortfolio !== section.portfolio}
              onClick={() => {
                if (runningPortfolio === section.portfolio) {
                  void cancelActiveWorkflow();
                  return;
                }
                if (section.portfolio === "indmoneyUs") {
                  setDialogError(null);
                  setDialogOpen(true);
                  return;
                }
                void runWorkflow("zerodha");
              }}
              className={
                runningPortfolio === section.portfolio
                  ? "h-auto w-full justify-center whitespace-normal rounded-full py-2 text-center leading-5 bg-red-600 text-white hover:bg-red-500 xl:w-auto"
                  : "h-auto w-full justify-center whitespace-normal rounded-full py-2 text-center leading-5 bg-slate-950 text-white hover:bg-slate-800 xl:w-auto"
              }
            >
              {runningPortfolio === section.portfolio ? (
                <X className="mr-2 size-4" />
              ) : (
                <Play className="mr-2 size-4" />
              )}
              {runningPortfolio === section.portfolio
                ? `Kill ${section.portfolio === "zerodha" ? "Zerodha" : "IndMoney"} Rebalance`
                : section.buttonLabel}
            </Button>
            <p className="text-xs text-slate-500">
              Last run on {formatTimestamp(lastRunByPortfolio[section.portfolio])}
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

        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
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
                stage === "swing" || stage === "rebalance" || stage === "technical"
                  ? () => openInputSelection(section.portfolio, stage)
                  : undefined
              }
            />
          ))}
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

      <InputSelectionDialog
        open={Boolean(inputDialog)}
        stage={inputDialog?.stage ?? null}
        candidates={inputCandidates}
        selectedIds={inputDialog ? selectedInputs[inputDialog.portfolio][inputDialog.stage] : new Set()}
        usdInrRate={usdInrRate}
        loading={inputCandidatesLoading}
        onToggle={toggleInputCandidate}
        onToggleAll={toggleAllInputCandidates}
        onClose={() => setInputDialog(null)}
      />

      <IndMoneySnapshotDialog
        open={dialogOpen}
        saving={runningPortfolio === "indmoneyUs"}
        error={dialogError}
        onClose={() => {
          if (runningPortfolio === "indmoneyUs") return;
          setDialogOpen(false);
        }}
        onContinue={handleIndMoneyContinue}
      />
    </>
  );
}

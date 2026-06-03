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
  RebalanceWorkflowChart,
  type RebalanceStageOutput,
  type RebalanceStageStatus,
  type RebalanceWorkflowStage,
} from "@/components/RebalanceWorkflowChart";
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

const STAGE_COPY: Record<
  WorkflowStageKey,
  { idle: string; running: string; completed: string }
> = {
  sync: {
    idle: "Sync Portfolio",
    running: "Syncing Portfolio",
    completed: "Portfolio Synced",
  },
  swing: {
    idle: "Swing Scan",
    running: "Running Swing Scan",
    completed: "Swing Scan",
  },
  threats: {
    idle: "Threats Scan",
    running: "Running Threats Scan",
    completed: "Threats Scan",
  },
  rebalance: {
    idle: "Rebalance",
    running: "Running Rebalance",
    completed: "Rebalance",
  },
  technical: {
    idle: "Technical Scan",
    running: "Running Technical Scan",
    completed: "Technical Scan",
  },
  actionables: {
    idle: "Actionables",
    running: "Updating Actionables",
    completed: "Actionables Updated",
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
  if (state === "running") return STAGE_COPY[stage].running;
  if (state === "queued") return `Queued ${STAGE_COPY[stage].idle}`;
  if (state === "completed") return STAGE_COPY[stage].completed;
  return STAGE_COPY[stage].idle;
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
    costInr: null,
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
    costInr: null,
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
    return [{ label: "Last sync", value: formatTimestamp(info.completedAt) }];
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
      { label: "Last scan", value: formatTimestamp(info.completedAt) },
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
      { label: "Last scan", value: formatTimestamp(info.completedAt) },
      { label: "LLM run", value: formatLlmRun(info) },
      { label: "Cost incurred", value: formatInrCost(info.costInr) },
    ];
  }
  return [{ label: "Last updated", value: formatTimestamp(info.completedAt) }];
}

function WorkflowStageTile({
  stage,
  info,
  now,
  selectable,
  selected,
  onClick,
  onInfoClick,
}: {
  stage: WorkflowStageKey;
  info: StageInfo;
  now: number;
  selectable?: boolean;
  selected?: boolean;
  onClick?: () => void;
  onInfoClick?: () => void;
}) {
  const isRunning = info.state === "running";
  const isQueued = info.state === "queued";
  const isCompleted = info.state === "completed";
  const showRunTag = selectable && selected && !isQueued;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick || isRunning}
      className={`relative flex min-h-36 flex-col items-start justify-start rounded-2xl border p-4 text-left align-top shadow-sm transition hover:-translate-y-0.5 hover:shadow-md disabled:cursor-default disabled:hover:translate-y-0 ${selectable && selected ? "border-emerald-400 bg-emerald-50 text-emerald-950 shadow-emerald-100 ring-2 ring-emerald-500" : getStageClasses(info.state)} ${selectable && !selected ? "bg-white opacity-100" : ""}`}
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
            aria-label={`Show ${getStageLabel(stage, "idle")} LLM details`}
            title="LLM models and expected cost"
          >
            <Info className="size-3" />
          </span>
        ) : null}
      </div>
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

function formatWorkflowDate(value?: string | null) {
  if (!value) return "Not recorded";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function mapStageStatus(
  info: StageInfo | undefined,
  selected: boolean,
  selectable: boolean,
): RebalanceStageStatus {
  if (selectable && !selected) return "skipped";
  if (!info || info.state === "idle" || info.state === "queued") return "pending";
  if (info.state === "running") return "running";
  if (info.state === "failed") return "blocked";
  if (info.error || info.exportStatus === "failed") return "warning";
  return "completed";
}

function buildStageOutputs(stage: WorkflowStageKey, info: StageInfo): RebalanceStageOutput[] {
  const outputs: RebalanceStageOutput[] = [];

  outputs.push({
    label: "Workflow state",
    value: info.runStatus ?? info.state,
    tone: info.state === "failed" ? "danger" : info.state === "completed" ? "success" : "default",
  });

  if (info.activeRunId || info.lastRunId) {
    outputs.push({
      label: info.activeRunId ? "Active run" : "Last run",
      value: `#${info.activeRunId ?? info.lastRunId}`,
      tone: info.activeRunId ? "default" : "muted",
    });
  }

  if (info.completedLlms !== null && info.completedLlms !== undefined) {
    outputs.push({
      label: "LLM completion",
      value: `${info.completedLlms}/${info.totalLlms ?? info.completedLlms} models completed`,
      tone:
        info.totalLlms && info.completedLlms < info.totalLlms ? "warning" : "success",
    });
  }

  if (info.recommendedStocks !== null && info.recommendedStocks !== undefined) {
    outputs.push({
      label: "Candidates",
      value: `${info.recommendedStocks} recommendations surfaced`,
      tone: "success",
    });
  }

  if (info.provider || info.model) {
    outputs.push({
      label: "Provider / model",
      value: [info.provider, info.model].filter(Boolean).join(" · "),
      tone: "default",
    });
  }

  if (info.costUsd !== null && info.costUsd !== undefined) {
    outputs.push({
      label: "Estimated cost",
      value: `$${info.costUsd.toFixed(4)}${
        info.costInr !== null && info.costInr !== undefined
          ? ` / ₹${info.costInr.toFixed(2)}`
          : ""
      }`,
      tone: "muted",
    });
  }

  if (info.completedAt || info.endedAt || info.startedAt) {
    outputs.push({
      label: info.completedAt || info.endedAt ? "Last updated" : "Started",
      value: formatWorkflowDate(info.completedAt ?? info.endedAt ?? info.startedAt),
      tone: "muted",
    });
  }

  if (info.error) {
    outputs.push({ label: "Error", value: info.error, tone: "danger" });
  }

  if (outputs.length <= 1) {
    const fallback: Record<WorkflowStageKey, RebalanceStageOutput[]> = {
      sync: [
        { label: "Holdings", value: "Positions, cash, and prices feed both lanes", tone: "default" },
        { label: "Next", value: "Risk and opportunity checks start downstream", tone: "muted" },
      ],
      threats: [
        { label: "Risk output", value: "Threats can trim, skip, or block unsafe trades", tone: "danger" },
        { label: "Run details", value: "Drawdown, news, concentration, and risk flags", tone: "warning" },
      ],
      swing: [
        { label: "Opportunity output", value: "Momentum and setup candidates", tone: "success" },
        { label: "Run details", value: "Buy/add confirmations for rebalance input", tone: "default" },
      ],
      rebalance: [
        { label: "Decision output", value: "Target vs current weights, cash, trims, and adds", tone: "default" },
        { label: "Run details", value: "Consensus rows and LLM cost tracking", tone: "muted" },
      ],
      technical: [
        { label: "Validation output", value: "Entry, exit, volume, and price checks", tone: "success" },
        { label: "Run details", value: "Technical guardrail context for final actionables", tone: "default" },
      ],
      actionables: [
        { label: "Buy / add", value: "Approved order candidates", tone: "success" },
        { label: "Sell / trim", value: "Risk-led exits and reductions", tone: "danger" },
        { label: "Hold / watch", value: "Watchlist or no-trade rows", tone: "muted" },
      ],
    };
    return fallback[stage];
  }

  return outputs;
}

function ZerodhaRebalanceFlowCard({
  state,
  selectedStages,
  specificMode,
}: {
  state: WorkflowState;
  selectedStages: Set<WorkflowStageKey>;
  specificMode: boolean;
}) {
  const stages = useMemo<RebalanceWorkflowStage[]>(() => {
    const stageStatus = (stage: WorkflowStageKey) =>
      mapStageStatus(state[stage], selectedStages.has(stage), specificMode);

    return [
      {
        id: "sync",
        title: "Sync",
        subtitle: "Pull holdings, cash, prices",
        icon: "sync",
        status: stageStatus("sync"),
        position: { x: 0, y: 170 },
        outputs: buildStageOutputs("sync", state.sync),
      },
      {
        id: "risk",
        title: "Risk lane",
        subtitle: "Threats reduce exposure or block unsafe trades",
        icon: "risk",
        status: stageStatus("threats"),
        position: { x: 260, y: 35 },
        outputs: buildStageOutputs("threats", state.threats),
      },
      {
        id: "opportunity",
        title: "Opportunity lane",
        subtitle: "Swing setups raise buy/add candidates",
        icon: "opportunity",
        status: stageStatus("swing"),
        position: { x: 260, y: 310 },
        outputs: buildStageOutputs("swing", state.swing),
      },
      {
        id: "rebalance",
        title: "Rebalance",
        subtitle: "Target vs current weights",
        icon: "rebalance",
        status: stageStatus("rebalance"),
        position: { x: 560, y: 175 },
        outputs: buildStageOutputs("rebalance", state.rebalance),
      },
      {
        id: "allocation",
        title: "Allocation",
        subtitle: "Weights + cash decision",
        icon: "allocation",
        status: stageStatus("rebalance"),
        position: { x: 805, y: 35 },
        outputs: [
          { label: "Sizing", value: "Target weight vs current exposure", tone: "default" },
          { label: "Cash", value: "Cash buffer is preserved before orders", tone: "muted" },
          ...buildStageOutputs("rebalance", state.rebalance).slice(0, 1),
        ],
      },
      {
        id: "guardrails",
        title: "Execution guardrails",
        subtitle: "Price trend, volume, stop checks",
        icon: "guardrails",
        status:
          state.threats.state === "failed" || state.technical.state === "failed"
            ? "blocked"
            : stageStatus("technical"),
        position: { x: 1040, y: 70 },
        outputs: [
          { label: "Risk gate", value: "Blocks unsafe entries or exits", tone: "danger" },
          { label: "Liquidity", value: "Volume, trend, and stop checks", tone: "warning" },
          ...buildStageOutputs("technical", state.technical).slice(0, 1),
        ],
      },
      {
        id: "technical",
        title: "Technical",
        subtitle: "Entry / exit checks",
        icon: "technical",
        status: stageStatus("technical"),
        position: { x: 820, y: 310 },
        outputs: buildStageOutputs("technical", state.technical),
      },
      {
        id: "actionables",
        title: "Actionables",
        subtitle: "Orders + watchlist",
        icon: "actionables",
        status: stageStatus("actionables"),
        position: { x: 1265, y: 190 },
        outputs: buildStageOutputs("actionables", state.actionables),
      },
    ];
  }, [selectedStages, specificMode, state]);

  return (
    <div className="rounded-[1.75rem] border border-slate-200 bg-white p-[clamp(1rem,2vw,1.5rem)] shadow-sm">
      <div>
        <h2 className="text-[clamp(1.05rem,1.6vw,1.35rem)] font-semibold text-slate-950">
          Zerodha Rebalance Flow
        </h2>
        <p className="mt-[0.35em] text-[clamp(0.82rem,1.1vw,0.95rem)] text-slate-500">
          Interactive path for how synced Zerodha positions become risk checks,
          opportunity signals, allocation decisions, technical validation, and
          final actionables. Open any stage card for inline run details.
        </p>
      </div>

      <div className="mt-[1rem] grid gap-[0.6rem] rounded-[1rem] border border-slate-200 bg-slate-50 p-[0.85rem] text-[clamp(0.75rem,1vw,0.85rem)] text-slate-600 sm:grid-cols-3">
        <div className="flex items-center gap-[0.5rem]">
          <span className="h-[0.25rem] w-[4rem] rounded-full bg-blue-600" />
          <span><strong className="text-slate-800">Primary workflow</strong> — queued execution path</span>
        </div>
        <div className="flex items-center gap-[0.5rem]">
          <span className="h-[0.25rem] w-[4rem] rounded-full border-t-[0.25rem] border-dashed border-teal-700" />
          <span><strong className="text-slate-800">Opportunity signal</strong> — positive confirmations</span>
        </div>
        <div className="flex items-center gap-[0.5rem]">
          <span className="h-[0.25rem] w-[4rem] rounded-full border-t-[0.25rem] border-dashed border-red-600" />
          <span><strong className="text-slate-800">Risk / guardrail</strong> — threats and blocks</span>
        </div>
      </div>

      <div className="mt-[1.25rem]">
        <RebalanceWorkflowChart stages={stages} />
      </div>
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
      savedAt: new Date().toISOString(),
    });
  }, [runningPortfolio, selectedStages, specificMode, states]);

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
          const swingRun = await apiService.createRun(
            buildRunPayload({
              prompt: buildSwingTradePrompt(
                market,
                getSwingTradeDefaultInvestmentAmount(market),
              ),
              targets: modelMixTargets,
              sheetName: getSwingTradeDefaultExportSheetName(market),
            }),
          );
          const completedSwingRun = await waitForRunWithStageHandling(
            portfolio,
            "swing",
            swingRun.id,
          );
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
          const swingRuns = fullRunCandidates
            .filter((run) => isRunInSwingTradeMarket(run.prompt, market))
            .slice(0, 12);
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
          const consensus = buildConsensusRows(
            getLatestMatchingRebalanceRuns(allRuns, market),
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
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-slate-950">
              {section.title}
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              {section.subtitle}
            </p>
          </div>
          <div className="flex w-full flex-col items-start gap-2 lg:w-auto lg:items-end">
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
                  ? "w-full max-w-full rounded-full bg-red-600 text-center leading-tight whitespace-normal text-white hover:bg-red-500 lg:w-auto"
                  : "w-full max-w-full rounded-full bg-slate-950 text-center leading-tight whitespace-normal text-white hover:bg-slate-800 lg:w-auto"
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
      <section className="grid gap-6">
        <div className="grid gap-6 xl:grid-cols-2 xl:items-start">
          {renderSectionCard(zerodhaSection)}
          {renderSectionCard(indmoneySection)}
        </div>
        <ZerodhaRebalanceFlowCard
          state={states.zerodha}
          selectedStages={selectedStages.zerodha}
          specificMode={specificMode.zerodha}
        />
      </section>

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

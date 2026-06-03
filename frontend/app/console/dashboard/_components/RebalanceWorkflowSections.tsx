"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
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
type StageState = "idle" | "running" | "completed" | "failed";
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
  completedLlms?: number | null;
  totalLlms?: number | null;
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

const STAGE_ORDER: WorkflowStageKey[] = [
  "sync",
  "swing",
  "threats",
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
    idle: "Threats",
    running: "Running Threats",
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
  if (state === "completed") return STAGE_COPY[stage].completed;
  return STAGE_COPY[stage].idle;
}

function getStageClasses(state: StageState) {
  if (state === "completed")
    return "border-emerald-300 bg-emerald-50 text-emerald-950 shadow-emerald-100";
  if (state === "running")
    return "border-amber-300 bg-amber-50 text-amber-950 shadow-amber-100";
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
  const isCompleted = info.state === "completed";
  const showRunTag = selectable && selected;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick || isRunning}
      className={`relative min-h-36 rounded-2xl border p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md disabled:cursor-default disabled:hover:translate-y-0 ${selectable && selected ? "border-emerald-400 bg-emerald-50 text-emerald-950 shadow-emerald-100 ring-2 ring-emerald-500" : getStageClasses(info.state)} ${selectable && !selected ? "bg-white opacity-100" : ""}`}
    >
      {showRunTag ? (
        <span className="absolute right-3 top-3 rounded-full border border-emerald-300 bg-white px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700">
          Run
        </span>
      ) : isCompleted ? (
        <CheckCircle2 className="absolute right-3 top-3 size-5 text-emerald-600" />
      ) : null}
      <div className="flex items-center gap-2 pr-7 text-sm font-semibold">
        {isRunning ? (
          <Loader2 className="size-4 animate-spin text-amber-600" />
        ) : (
          <Clock3 className="size-4 text-slate-400" />
        )}
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
      <div className="mt-3 space-y-1 text-xs leading-5 text-slate-600">
        {info.completedAt ? (
          <p>Timestamp: {formatTimestamp(info.completedAt)}</p>
        ) : null}
        {formatDuration(info.startedAt, info.endedAt, now) ? (
          <p>Duration: {formatDuration(info.startedAt, info.endedAt, now)}</p>
        ) : null}
        {info.totalLlms ? (
          <p>
            {info.completedLlms ?? 0}/{info.totalLlms} LLMs completed
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
              LLM:{" "}
              {[info.provider, info.model].filter(Boolean).join(" / ") ||
                "LLM details not available yet"}
            </p>
            <p>LLM Run Status: {info.runStatus ?? "Waiting for job status"}</p>
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

export function RebalanceWorkflowSections({
  onDashboardRefresh,
}: {
  onDashboardRefresh: () => Promise<void>;
}) {
  const router = useRouter();
  const [states, setStates] = useState<
    Record<WorkflowPortfolio, WorkflowState>
  >({
    zerodha: initialWorkflowState(),
    indmoneyUs: initialWorkflowState(),
  });
  const [runningPortfolio, setRunningPortfolio] =
    useState<WorkflowPortfolio | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [specificMode, setSpecificMode] = useState<
    Record<WorkflowPortfolio, boolean>
  >({ zerodha: false, indmoneyUs: false });
  const [selectedStages, setSelectedStages] = useState<
    Record<WorkflowPortfolio, Set<WorkflowStageKey>>
  >(() => ({
    zerodha: new Set(),
    indmoneyUs: new Set(),
  }));
  const activeRunIdsRef = useRef<number[]>([]);
  const cancelRequestedRef = useRef(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const isBusy = Boolean(runningPortfolio);

  const updateStage = useCallback(
    (
      portfolio: WorkflowPortfolio,
      stage: WorkflowStageKey,
      info: Partial<StageInfo>,
    ) => {
      setStates((current) => ({
        ...current,
        [portfolio]: {
          ...current[portfolio],
          [stage]: { ...current[portfolio][stage], ...info },
        },
      }));
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
        startedAt: specificMode[portfolio] ? null : timestamp,
        endedAt: specificMode[portfolio] ? null : timestamp,
        completedAt: specificMode[portfolio] ? null : timestamp,
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
      updateStage(portfolio, stage, {
        state: "completed",
        endedAt: timestamp,
        completedAt: info.completedAt ?? timestamp,
        activeRunId: null,
        ...info,
      });
    },
    [updateStage],
  );

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
        if (needsModelMix) {
          currentStage = shouldRunCurrentStage("swing") ? "swing" : "rebalance";
        } else if (needsSingleModel) {
          currentStage = shouldRunCurrentStage("threats")
            ? "threats"
            : "technical";
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
          });
        } else {
          completeSkippedStage(
            portfolio,
            "swing",
            "Using latest completed swing scan",
          );
        }

        currentStage = "threats";
        if (shouldRunCurrentStage("threats")) {
          markRunning(portfolio, "threats", { totalLlms: 1, completedLlms: 0 });
          const queuedThreat =
            portfolio === "zerodha"
              ? await apiService.zerodhaRunThreats(gpt4oMiniTarget!)
              : await apiService.indmoneyUsRunThreats(gpt4oMiniTarget!);
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
        subtitle:
          "Queue the India sync, scans, rebalance, technical scan, and final actionable refresh.",
      },
      {
        portfolio: "indmoneyUs" as const,
        title: "Run IndMoney Rebalance",
        subtitle:
          "Use the latest INDmoney snapshot or paste a fresh screen before the US rebalance workflow.",
      },
    ],
    [],
  );

  return (
    <>
      <section className="grid gap-6 xl:grid-cols-2">
        {sections.map((section) => (
          <div
            key={section.portfolio}
            className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold text-slate-950">
                  {section.title}
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  {section.subtitle}
                </p>
              </div>
              <div className="flex flex-col items-start gap-2 sm:items-end">
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
                      ? "rounded-full bg-red-600 text-white hover:bg-red-500"
                      : "rounded-full bg-slate-950 text-white hover:bg-slate-800"
                  }
                >
                  {runningPortfolio === section.portfolio ? (
                    <X className="mr-2 size-4" />
                  ) : (
                    <Play className="mr-2 size-4" />
                  )}
                  {runningPortfolio === section.portfolio
                    ? `Kill ${section.portfolio === "zerodha" ? "Zerodha" : "IndMoney"} Rebalance`
                    : section.title}
                </Button>
                <p className="text-xs text-slate-500">
                  Last run on{" "}
                  {formatTimestamp(lastRunByPortfolio[section.portfolio])}
                </p>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() =>
                    setSpecificMode((current) => ({
                      ...current,
                      [section.portfolio]: !current[section.portfolio],
                    }))
                  }
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
                Select the stages to run. Unselected stages stay linear but use
                the latest saved output wherever the next stage needs input.
              </p>
            ) : null}

            <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {STAGE_ORDER.map((stage) => (
                <WorkflowStageTile
                  key={stage}
                  stage={stage}
                  info={states[section.portfolio][stage]}
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
        ))}
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

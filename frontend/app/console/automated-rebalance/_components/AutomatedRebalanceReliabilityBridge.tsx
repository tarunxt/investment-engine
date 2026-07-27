"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { Loader2, X } from "lucide-react";

import { normalizeError } from "@/app/console/dashboard/_components/dashboardOverviewUtils";
import { apiService } from "@/services/api";
import type { ApiRequestControl } from "@/services/api.types";
import type {
  AutoRebalanceHistoryDetailResponse,
  AutoRebalanceJobDetailResponse,
  AutoRebalancePortfolioKey,
  AutoRebalanceStageKey,
  JobResponse,
  RunListItem,
  RunResponse,
} from "@/types/api";

type LlmStage = Exclude<AutoRebalanceStageKey, "sync" | "actionables">;
type LlmMetricContext = {
  portfolio: AutoRebalancePortfolioKey;
  stage: LlmStage;
  expectedTotal: number | null;
};
type StageJobRow = {
  job: AutoRebalanceJobDetailResponse;
  runtime: string;
};
type CachedRun = {
  expiresAt: number;
  promise: Promise<RunResponse>;
};
type LoadedStageJobs = {
  label: string;
  jobs: AutoRebalanceJobDetailResponse[];
};

const BACKEND_RUN_PAGE_LIMIT = 100;
const MAX_FULL_RUN_HYDRATION = 48;
const MAX_AUTO_REBALANCE_SEQUENCES_PER_PORTFOLIO = 4;
const MAX_RELEVANT_MANUAL_RUNS = 12;
const MAX_OTHER_MANUAL_RUNS = 4;
const RUN_DETAIL_CONCURRENCY = 6;
const RUN_DETAIL_TIMEOUT_MS = 15_000;
const ACTIVE_RUN_CACHE_MS = 2_500;
const TERMINAL_RUN_CACHE_MS = 60_000;
const runDetailCache = new Map<number, CachedRun>();
let safeFullRunAdapterInstalled = false;

const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "partial",
  "failed",
  "cancelled",
  "interrupted",
  "skipped",
]);
const ACTIVE_RUN_STATUSES = new Set([
  "queued",
  "pending",
  "processing",
  "running",
  "scheduled",
]);

function abortError() {
  const error = new Error("Request aborted");
  error.name = "AbortError";
  return error;
}

function wait(delayMs: number) {
  return new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs));
}

function parseTimestamp(value: string | null | undefined) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

async function mapWithConcurrency<TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  mapper: (item: TInput, index: number) => Promise<TOutput>,
) {
  const results = new Array<TOutput>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        results[index] = await mapper(items[index], index);
      }
    }),
  );

  return results;
}

function pruneRunDetailCache() {
  const now = Date.now();
  for (const [runId, cached] of runDetailCache) {
    if (cached.expiresAt <= now) runDetailCache.delete(runId);
  }
  while (runDetailCache.size > 300) {
    const oldestKey = runDetailCache.keys().next().value as number | undefined;
    if (oldestKey === undefined) break;
    runDetailCache.delete(oldestKey);
  }
}

async function loadRunDetailWithRetry(
  runId: number,
  options?: ApiRequestControl,
): Promise<RunResponse> {
  if (options?.signal?.aborted) throw abortError();
  const requestOptions: ApiRequestControl = {
    ...options,
    timeoutMs: Math.max(options?.timeoutMs ?? 0, RUN_DETAIL_TIMEOUT_MS),
  };
  try {
    return await apiService.getRun(runId, requestOptions);
  } catch (error) {
    if (options?.signal?.aborted) throw abortError();
    await wait(250);
    return apiService.getRun(runId, requestOptions);
  }
}

function getCachedRunDetail(runId: number, options?: ApiRequestControl) {
  if (options?.signal) return loadRunDetailWithRetry(runId, options);

  pruneRunDetailCache();
  const cached = runDetailCache.get(runId);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const entry: CachedRun = {
    expiresAt: Date.now() + ACTIVE_RUN_CACHE_MS,
    promise: Promise.resolve(null as unknown as RunResponse),
  };
  entry.promise = loadRunDetailWithRetry(runId)
    .then((run) => {
      entry.expiresAt =
        Date.now() +
        (TERMINAL_RUN_STATUSES.has((run.status || "").toLowerCase())
          ? TERMINAL_RUN_CACHE_MS
          : ACTIVE_RUN_CACHE_MS);
      return run;
    })
    .catch((error) => {
      runDetailCache.delete(runId);
      throw error;
    });
  runDetailCache.set(runId, entry);
  return entry.promise;
}

function hasAutoRebalanceMetadata(item: RunListItem) {
  return Boolean(
    item.auto_rebalance_portfolio &&
      typeof item.auto_rebalance_sequence === "number" &&
      Number.isFinite(item.auto_rebalance_sequence),
  );
}

function looksRelevantToRebalance(item: RunListItem) {
  const text = `${item.auto_rebalance_label || ""}\n${item.prompt_preview || ""}`;
  return /(auto[- ]?rebalance|rebalance|swing scan|swing trade|technical scan|technical validation|portfolio)/i.test(
    text,
  );
}

function selectRecentRunSummaries(items: RunListItem[]) {
  const selectedSequences = new Map<AutoRebalancePortfolioKey, Set<number>>();
  for (const portfolio of ["india", "indmoney_us"] as const) {
    const sequences = Array.from(
      new Set(
        items
          .filter(
            (item) =>
              item.auto_rebalance_portfolio === portfolio &&
              typeof item.auto_rebalance_sequence === "number",
          )
          .map((item) => item.auto_rebalance_sequence as number),
      ),
    )
      .sort((left, right) => right - left)
      .slice(0, MAX_AUTO_REBALANCE_SEQUENCES_PER_PORTFOLIO);
    selectedSequences.set(portfolio, new Set(sequences));
  }

  const active = items.filter((item) =>
    ACTIVE_RUN_STATUSES.has((item.status || "").toLowerCase()),
  );
  const autoRebalance = items.filter((item) => {
    const portfolio = item.auto_rebalance_portfolio;
    const sequence = item.auto_rebalance_sequence;
    return Boolean(
      portfolio &&
        typeof sequence === "number" &&
        selectedSequences.get(portfolio)?.has(sequence),
    );
  });
  const manualRuns = items.filter((item) => !hasAutoRebalanceMetadata(item));
  const relevantManual = manualRuns
    .filter(looksRelevantToRebalance)
    .slice(0, MAX_RELEVANT_MANUAL_RUNS);
  const otherManual = manualRuns
    .filter((item) => !looksRelevantToRebalance(item))
    .slice(0, MAX_OTHER_MANUAL_RUNS);

  const unique = new Map<number, RunListItem>();
  for (const item of [
    ...active,
    ...autoRebalance,
    ...relevantManual,
    ...otherManual,
  ]) {
    unique.set(item.id, item);
  }

  return Array.from(unique.values())
    .sort(
      (left, right) =>
        parseTimestamp(right.created_at) - parseTimestamp(left.created_at) ||
        right.id - left.id,
    )
    .slice(0, MAX_FULL_RUN_HYDRATION);
}

function toFallbackJob(job: RunListItem["run_jobs"][number]["job"]): JobResponse {
  return {
    id: job.id,
    prompt: "",
    response: null,
    error_message: job.error_message ?? null,
    provider: job.provider,
    model: job.model,
    status: job.status,
    tokens_in: job.tokens_in ?? null,
    tokens_out: job.tokens_out ?? null,
    estimated_cost: job.estimated_cost ?? null,
    request_context_json: job.request_context_json ?? null,
    export_status: job.export_status ?? null,
    export_error: job.export_error ?? null,
    exported_at: job.exported_at ?? null,
    exported_sheet_url: job.exported_sheet_url ?? null,
    auto_rebalance_portfolio: job.auto_rebalance_portfolio ?? null,
    auto_rebalance_sequence: job.auto_rebalance_sequence ?? null,
    auto_rebalance_label: job.auto_rebalance_label ?? null,
    scheduled_at: job.scheduled_at ?? null,
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
}

function toFallbackRun(item: RunListItem): RunResponse {
  return {
    id: item.id,
    prompt: item.prompt_preview || "",
    prompt_id: item.prompt_id,
    status: item.status,
    current_stage: item.current_stage,
    run_jobs: item.run_jobs.map((link) => ({
      id: link.id,
      run_id: link.run_id,
      job_id: link.job_id,
      stage: link.stage,
      job: toFallbackJob(link.job),
    })),
    synthesis_response: null,
    decision_response: null,
    auto_export_enabled: item.auto_export_enabled,
    export_spreadsheet_url: null,
    export_sheet_name: null,
    export_investment_amount: null,
    export_title: null,
    export_status: item.export_status,
    export_error: item.export_error,
    exported_at: item.exported_at,
    exported_sheet_url: item.exported_sheet_url,
    auto_rebalance_portfolio: item.auto_rebalance_portfolio ?? null,
    auto_rebalance_sequence: item.auto_rebalance_sequence ?? null,
    auto_rebalance_label: item.auto_rebalance_label ?? null,
    created_at: item.created_at,
    updated_at: item.updated_at,
  };
}

async function loadSummaryPageWithRetry(options?: ApiRequestControl) {
  if (options?.signal?.aborted) throw abortError();
  try {
    return await apiService.getRuns({
      page: 1,
      limit: BACKEND_RUN_PAGE_LIMIT,
      summary: true,
    });
  } catch (error) {
    if (options?.signal?.aborted) throw abortError();
    await wait(250);
    return apiService.getRuns({
      page: 1,
      limit: BACKEND_RUN_PAGE_LIMIT,
      summary: true,
    });
  }
}

async function buildBoundedFullRunPage(options?: ApiRequestControl) {
  const summaryPage = await loadSummaryPageWithRetry(options);
  if (options?.signal?.aborted) throw abortError();
  const selected = selectRecentRunSummaries(summaryPage.items);
  const items = await mapWithConcurrency(
    selected,
    RUN_DETAIL_CONCURRENCY,
    async (item) => {
      try {
        return await getCachedRunDetail(item.id, options);
      } catch (error) {
        // A single oversized or temporarily unavailable historic run must not
        // block provider selection, later-stage inputs, or the current workflow.
        console.warn(
          `Using compact fallback for run #${item.id}: ${normalizeError(error)}`,
        );
        return toFallbackRun(item);
      }
    },
  );

  return {
    items,
    total: items.length,
    page: 1,
    limit: BACKEND_RUN_PAGE_LIMIT,
    size: items.length,
    pages: 1,
  };
}

/**
 * The legacy helper asks for every full run page (historically with limit=200),
 * then downloads every prompt and model response. That request grows forever,
 * exceeds the backend limit, and lets one slow old run fail the current stage.
 * On the dedicated automated-rebalance route, replace it with a bounded recent
 * summary selection and hydrate only the runs needed by current stage inputs,
 * cost history, output dialogs, and order previews. Failed historic details are
 * represented by compact summaries rather than rejecting the entire operation.
 */
function installSafeFullRunAdapter() {
  if (safeFullRunAdapterInstalled) return;
  safeFullRunAdapterInstalled = true;

  apiService.getFullRuns = async (_params, options) =>
    buildBoundedFullRunPage(options);
}

installSafeFullRunAdapter();

function compactText(value: string | null | undefined) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function findMetricElement(target: HTMLElement, root: HTMLElement) {
  let element: HTMLElement | null = target;
  while (element && element !== root) {
    const text = compactText(element.textContent);
    if (text.length <= 180 && /^LLMs completed\s*:/i.test(text)) return element;
    element = element.parentElement;
  }
  return null;
}

function inferStageFromText(text: string): LlmStage | null {
  const value = text.toLowerCase();
  if (value.includes("technical scan") || value.includes("technical validation")) {
    return "technical";
  }
  if (value.includes("rebalance")) return "rebalance";
  if (value.includes("threats scan") || value.includes("threats & guardrails")) {
    return "threats";
  }
  if (value.includes("swing scan") || value.includes("swing opportunities")) {
    return "swing";
  }
  return null;
}

function inferMetricContext(
  metricElement: HTMLElement,
  root: HTMLElement,
): LlmMetricContext | null {
  const metricText = compactText(metricElement.textContent);
  const countMatch = metricText.match(/LLMs completed\s*:\s*\d+\s*\/\s*(\d+)/i);
  let stage: LlmStage | null = null;
  let portfolio: AutoRebalancePortfolioKey | null = null;
  let element: HTMLElement | null = metricElement;

  while (element && element !== root.parentElement) {
    const text = compactText(element.textContent);
    stage ||= inferStageFromText(text);

    const hasZerodha = text.includes("Run Zerodha Auto-Rebalance");
    const hasIndMoney = text.includes("Run Indmoney Auto-Rebalance");
    if (hasZerodha !== hasIndMoney) {
      portfolio = hasZerodha ? "india" : "indmoney_us";
    }
    if (stage && portfolio) break;
    if (element === root) break;
    element = element.parentElement;
  }

  if (!stage || !portfolio) return null;
  return {
    portfolio,
    stage,
    expectedTotal: countMatch ? Number(countMatch[1]) : null,
  };
}

function inferStageFromPrompt(prompt: string): LlmStage {
  const value = prompt.toLowerCase();
  if (
    value.includes("technical scan") ||
    value.includes("## technical scan input bundle")
  ) {
    return "technical";
  }
  if (value.includes("rebalance scan") || value.includes("[rebalance_flow:")) {
    return "rebalance";
  }
  if (
    value.includes("[zerodha_threats]") ||
    value.includes("[indmoney_us_threats]") ||
    value.includes("threat")
  ) {
    return "threats";
  }
  return "swing";
}

function collectStageJobs(
  detail: AutoRebalanceHistoryDetailResponse,
  stage: LlmStage,
) {
  const stageSummary = detail.stages.find((item) => item.stage === stage);
  const explicitRunId = stageSummary?.run_id ?? null;
  const explicitJobId = stageSummary?.job_id ?? null;
  const candidates = [
    ...detail.runs.flatMap((run) =>
      run.jobs.map((job) => ({
        runId: run.id,
        job,
        prompt: `${run.prompt}\n${job.prompt}`,
      })),
    ),
    ...detail.standalone_jobs.map((job) => ({
      runId: null,
      job,
      prompt: job.prompt,
    })),
  ];

  const matching = candidates.filter(
    ({ runId, job, prompt }) =>
      (explicitRunId !== null && runId === explicitRunId) ||
      (explicitJobId !== null && job.id === explicitJobId) ||
      inferStageFromPrompt(prompt) === stage,
  );
  const unique = new Map<number, AutoRebalanceJobDetailResponse>();
  for (const { job } of matching) unique.set(job.id, job);
  return [...unique.values()].sort((left, right) => left.id - right.id);
}

function toStageJob(job: JobResponse): AutoRebalanceJobDetailResponse {
  return {
    id: job.id,
    provider: job.provider,
    model: job.model,
    status: job.status,
    prompt: job.prompt,
    response: job.response,
    error_message: job.error_message ?? null,
    tokens_in: job.tokens_in ?? null,
    tokens_out: job.tokens_out ?? null,
    estimated_cost: job.estimated_cost ?? null,
    web_search_used: job.web_search_used ?? null,
    web_search_queries: job.web_search_queries ?? null,
    web_sources: job.web_sources ?? null,
    runtime_metadata_json: job.runtime_metadata_json ?? null,
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
}

function runMatchesPortfolio(run: RunResponse, portfolio: AutoRebalancePortfolioKey) {
  if (run.auto_rebalance_portfolio) {
    return run.auto_rebalance_portfolio === portfolio;
  }
  const text = `${run.auto_rebalance_label || ""}\n${run.prompt || ""}`.toLowerCase();
  return portfolio === "india"
    ? /zerodha|india equities|market:\s*india/.test(text)
    : /indmoney|us equities|market:\s*us/.test(text);
}

function collectStageJobsFromRuns(
  runs: RunResponse[],
  context: LlmMetricContext,
) {
  const matchingRuns = runs
    .filter((run) => runMatchesPortfolio(run, context.portfolio))
    .filter(
      (run) =>
        inferStageFromPrompt(`${run.auto_rebalance_label || ""}\n${run.prompt}`) ===
        context.stage,
    )
    .sort(
      (left, right) =>
        parseTimestamp(right.created_at) - parseTimestamp(left.created_at),
    );
  const exact = matchingRuns.find(
    (run) =>
      context.expectedTotal === null ||
      run.run_jobs.length === context.expectedTotal,
  );
  const selected = exact || matchingRuns[0];
  return selected
    ? selected.run_jobs
        .map((link) => link.job)
        .filter(Boolean)
        .map(toStageJob)
    : [];
}

async function loadThreatFallback(
  context: LlmMetricContext,
): Promise<LoadedStageJobs | null> {
  if (context.stage !== "threats") return null;
  const latest =
    context.portfolio === "india"
      ? await apiService.zerodhaThreatsLatest()
      : await apiService.indmoneyUsThreatsLatest();
  const analysis = latest.analysis;
  if (!analysis) return null;
  return {
    label: `Latest saved ${stageLabel(context.stage)}`,
    jobs: [
      {
        id: analysis.job_id,
        provider: analysis.provider,
        model: analysis.model,
        status: analysis.status,
        prompt: "",
        response: analysis.report?.raw_markdown ?? null,
        error_message: analysis.error_message ?? null,
        tokens_in: analysis.tokens_in ?? null,
        tokens_out: analysis.tokens_out ?? null,
        estimated_cost: analysis.estimated_cost ?? null,
        web_search_used: null,
        web_search_queries: null,
        web_sources: null,
        runtime_metadata_json: null,
        created_at: analysis.created_at,
        updated_at: analysis.updated_at,
      },
    ],
  };
}

async function loadRecentRunFallback(
  context: LlmMetricContext,
): Promise<LoadedStageJobs | null> {
  const page = await buildBoundedFullRunPage();
  const jobs = collectStageJobsFromRuns(page.items, context);
  if (!jobs.length) return null;
  return {
    label: `Recent saved ${stageLabel(context.stage)}`,
    jobs,
  };
}

async function retryRead<T>(reader: () => Promise<T>) {
  try {
    return await reader();
  } catch (error) {
    await wait(250);
    try {
      return await reader();
    } catch {
      throw error;
    }
  }
}

async function loadSavedStageJobs(
  context: LlmMetricContext,
): Promise<LoadedStageJobs> {
  let primaryError: unknown = null;
  try {
    const history = await retryRead(() =>
      apiService.getAutoRebalanceHistory(context.portfolio, { limit: 25 }),
    );
    const withExactCount = history.items.find((item) =>
      item.stages.some(
        (stage) =>
          stage.stage === context.stage &&
          (context.expectedTotal === null ||
            stage.provider_count === context.expectedTotal),
      ),
    );
    const selected =
      withExactCount ||
      history.items.find((item) =>
        item.stages.some((stage) => stage.stage === context.stage),
      );
    if (selected) {
      const detail = await retryRead(() =>
        apiService.getAutoRebalanceHistoryDetail(
          context.portfolio,
          selected.sequence,
        ),
      );
      const jobs = collectStageJobs(detail, context.stage);
      if (jobs.length) return { label: detail.label, jobs };
    }
  } catch (error) {
    primaryError = error;
  }

  try {
    const threatFallback = await loadThreatFallback(context);
    if (threatFallback) return threatFallback;
  } catch (error) {
    primaryError ||= error;
  }

  try {
    const runFallback = await loadRecentRunFallback(context);
    if (runFallback) return runFallback;
  } catch (error) {
    primaryError ||= error;
  }

  if (primaryError) throw primaryError;
  throw new Error(`No saved ${stageLabel(context.stage)} run was found.`);
}

function metadataNumber(
  metadata: Record<string, unknown> | null | undefined,
  keys: string[],
) {
  for (const key of keys) {
    const value = metadata?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return null;
}

function formatDurationSeconds(seconds: number) {
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} sec`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

function getJobRuntime(job: AutoRebalanceJobDetailResponse) {
  const metadata = job.runtime_metadata_json;
  const seconds = metadataNumber(metadata, [
    "duration_seconds",
    "runtime_seconds",
    "latency_seconds",
    "elapsed_seconds",
    "total_duration_seconds",
  ]);
  if (seconds !== null) return formatDurationSeconds(seconds);

  const milliseconds = metadataNumber(metadata, [
    "duration_ms",
    "runtime_ms",
    "latency_ms",
    "time_taken_ms",
  ]);
  if (milliseconds !== null) return formatDurationSeconds(milliseconds / 1000);

  const startedAt = Date.parse(job.created_at);
  const endedAt = Date.parse(job.updated_at);
  if (Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt >= startedAt) {
    return formatDurationSeconds((endedAt - startedAt) / 1000);
  }
  return "Not available";
}

function formatCost(value?: number | null) {
  if (value === null || value === undefined) return "Not available";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value < 0.01 ? 4 : 2,
    maximumFractionDigits: 4,
  }).format(value);
}

function stageLabel(stage: LlmStage) {
  return {
    threats: "Threats Scan",
    swing: "Swing Scan",
    rebalance: "Rebalance",
    technical: "Technical Scan",
  }[stage];
}

function statusTone(status: string) {
  const value = status.toLowerCase();
  if (value === "failed") return "border-rose-200 bg-rose-50 text-rose-800";
  if (value === "partial") return "border-amber-200 bg-amber-50 text-amber-800";
  if (["completed", "success", "passed"].includes(value)) {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }
  if (["queued", "pending", "processing", "running"].includes(value)) {
    return "border-sky-200 bg-sky-50 text-sky-800";
  }
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function LlmDetailsDialog({
  context,
  onClose,
}: {
  context: LlmMetricContext;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<StageJobRow[]>([]);
  const [runLabel, setRunLabel] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const loaded = await loadSavedStageJobs(context);
        const jobs = loaded.jobs.map((job) => ({
          job,
          runtime: getJobRuntime(job),
        }));
        if (!cancelled) {
          setRunLabel(loaded.label);
          setRows(jobs);
        }
      } catch (reason) {
        if (!cancelled) setError(normalizeError(reason));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [context]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const passed = rows.filter(({ job }) =>
    ["completed", "success", "passed", "partial"].includes(
      job.status.toLowerCase(),
    ),
  ).length;
  const failed = rows.filter(({ job }) => job.status.toLowerCase() === "failed").length;

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/55 p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={`${stageLabel(context.stage)} LLM details`}
        className="max-h-[88vh] w-full max-w-5xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-indigo-600">
              {stageLabel(context.stage)} · LLM details
            </p>
            <h2 className="mt-1 text-xl font-bold text-slate-950">
              {runLabel || "Loading saved run…"}
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              {rows.length} LLMs returned · {passed} passed · {failed} failed
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-slate-200 p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close LLM details"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="max-h-[calc(88vh-105px)] overflow-auto p-5">
          {loading ? (
            <div className="flex min-h-52 items-center justify-center gap-2 text-sm text-slate-600">
              <Loader2 className="size-4 animate-spin" /> Loading LLM details…
            </div>
          ) : null}
          {error ? (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
              {error}
            </div>
          ) : null}
          {!loading && !error && rows.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-600">
              This stage has no saved model-level rows yet.
            </div>
          ) : null}
          {!loading && !error && rows.length > 0 ? (
            <div className="overflow-hidden rounded-xl border border-slate-200">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-left text-sm">
                  <thead className="bg-slate-50 text-xs font-bold uppercase tracking-[0.12em] text-slate-600">
                    <tr>
                      <th className="px-4 py-3">Provider</th>
                      <th className="px-4 py-3">Model</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Runtime</th>
                      <th className="px-4 py-3 text-right">Cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 bg-white">
                    {rows.map(({ job, runtime }) => (
                      <tr key={job.id} className="align-top">
                        <td className="px-4 py-3 font-semibold text-slate-900">
                          {job.provider || "Unknown"}
                        </td>
                        <td className="px-4 py-3 text-slate-700">
                          {job.model || "Unknown"}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${statusTone(job.status)}`}
                          >
                            {job.status || "Unknown"}
                          </span>
                          {job.error_message ? (
                            <p className="mt-2 max-w-md text-xs leading-5 text-rose-700">
                              {job.error_message}
                            </p>
                          ) : null}
                        </td>
                        <td className="px-4 py-3 text-slate-700">{runtime}</td>
                        <td className="px-4 py-3 text-right font-medium text-slate-900">
                          {formatCost(job.estimated_cost)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

export function AutomatedRebalanceReliabilityBridge({
  children,
}: {
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [llmMetric, setLlmMetric] = useState<LlmMetricContext | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const enhanceMetrics = () => {
      root.querySelectorAll<HTMLElement>("p, span, a, button").forEach((element) => {
        const text = compactText(element.textContent);
        const nestedMetric = [...element.children].some((child) =>
          /^LLMs completed\s*:/i.test(compactText(child.textContent)),
        );
        if (!nestedMetric && /^LLMs completed\s*:/i.test(text)) {
          element.dataset.autoRebalanceLlmMetric = "true";
          if (!element.matches("button, a, [role='button']")) {
            element.setAttribute("role", "button");
            element.tabIndex = 0;
          }
          element.style.cursor = "pointer";
          element.style.textDecorationLine = "underline";
          element.style.textDecorationStyle = "dotted";
          element.style.textUnderlineOffset = "3px";
          element.title = "Open provider/model runtime and cost details";
        }
      });
    };

    enhanceMetrics();
    const observer = new MutationObserver(enhanceMetrics);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, []);

  const openFromElement = (target: HTMLElement) => {
    const root = rootRef.current;
    if (!root) return false;
    const metricElement = findMetricElement(target, root);
    if (!metricElement) return false;
    const context = inferMetricContext(metricElement, root);
    if (!context) return false;
    setLlmMetric(context);
    return true;
  };

  const handleClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLElement)) return;
    if (openFromElement(event.target)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const handleKeyDownCapture = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["Enter", " "].includes(event.key)) return;
    if (!(event.target instanceof HTMLElement)) return;
    if (event.target.dataset.autoRebalanceLlmMetric !== "true") return;
    if (openFromElement(event.target)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  return (
    <>
      <div
        ref={rootRef}
        onClickCapture={handleClickCapture}
        onKeyDownCapture={handleKeyDownCapture}
      >
        {children}
      </div>
      {llmMetric ? (
        <LlmDetailsDialog
          context={llmMetric}
          onClose={() => setLlmMetric(null)}
        />
      ) : null}
    </>
  );
}

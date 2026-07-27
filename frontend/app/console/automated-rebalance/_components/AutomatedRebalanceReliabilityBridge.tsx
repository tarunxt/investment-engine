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

import { apiService } from "@/services/api";
import type { ApiRequestControl } from "@/services/api.types";
import type {
  AutoRebalanceHistoryDetailResponse,
  AutoRebalanceJobDetailResponse,
  AutoRebalancePortfolioKey,
  AutoRebalanceStageKey,
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

const RUN_DETAIL_CONCURRENCY = 8;
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

function abortError() {
  const error = new Error("Request aborted");
  error.name = "AbortError";
  return error;
}

function wait(delayMs: number) {
  return new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs));
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
  try {
    return await apiService.getRun(runId, options);
  } catch (error) {
    if (options?.signal?.aborted) throw abortError();
    await wait(150);
    return apiService.getRun(runId, options);
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

/**
 * The full /runs collection can exceed the backend response budget because every
 * prompt and model response is embedded in one payload. Keep the existing caller
 * contract, but load the lightweight summary page first and hydrate only those
 * selected run IDs through /runs/{id}. This fixes the LLM, Inputs and Outputs
 * dialogs without re-introducing an unbounded collection response.
 */
function installSafeFullRunAdapter() {
  if (safeFullRunAdapterInstalled) return;
  safeFullRunAdapterInstalled = true;

  apiService.getFullRuns = async (params, options) => {
    if (options?.signal?.aborted) throw abortError();
    const summaryPage = await apiService.getRuns({
      page: params?.page,
      limit: params?.limit,
      summary: true,
    });
    if (options?.signal?.aborted) throw abortError();

    const items = await mapWithConcurrency(
      summaryPage.items,
      RUN_DETAIL_CONCURRENCY,
      (item) => getCachedRunDetail(item.id, options),
    );

    return {
      ...summaryPage,
      items,
    };
  };
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
  return [...unique.values()].sort((a, b) => a.id - b.id);
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
        const history = await apiService.getAutoRebalanceHistory(context.portfolio, {
          limit: 25,
        });
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
        if (!selected) {
          throw new Error(`No saved ${stageLabel(context.stage)} run was found.`);
        }

        const detail = await apiService.getAutoRebalanceHistoryDetail(
          context.portfolio,
          selected.sequence,
        );
        const jobs = collectStageJobs(detail, context.stage).map((job) => ({
          job,
          runtime: getJobRuntime(job),
        }));
        if (!cancelled) {
          setRunLabel(detail.label);
          setRows(jobs);
        }
      } catch (reason) {
        if (!cancelled) {
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not load the saved LLM details.",
          );
        }
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
    if (!(["Enter", " "].includes(event.key))) return;
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

"use client";

import { useState, useRef, useCallback, useEffect, type SVGProps } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, CheckCircle2, FileSpreadsheet, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatCompactStageTime } from "@/lib/datetime";
import { StageDurationBreakdownDialog } from "@/app/console/dashboard/_components/StageDurationBreakdownDialog";

export type WorkflowStageKey =
  | "sync"
  | "swing"
  | "threats"
  | "rebalance"
  | "technical"
  | "actionables";

export type StageState = "idle" | "queued" | "running" | "completed" | "failed";

export type StageErrorDetail = {
  provider: string | null;
  model: string | null;
  message: string;
  status?: string | null;
  jobId?: number | null;
  runId?: number | null;
  httpStatus?: number | null;
  providerResponseBody?: string | null;
  correlationId?: string | null;
  exceptionType?: string | null;
  traceReference?: string | null;
  retrySafe?: boolean | null;
  attempt?: number | null;
};

export type StageInfo = {
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
  errorDetails?: StageErrorDetail[];
  activeRunId?: number | null;
  lastRunId?: number | null;
  completedLlms?: number | null;
  passedLlms?: number | null;
  partialLlms?: number | null;
  partialNotice?: string | null;
  failedLlms?: number | null;
  totalLlms?: number | null;
  recommendedStocks?: number | null;
  rebalanceInputs?: number | null;
  frozenFinal?: Record<string, unknown>;
};

export type StageTileRow = { label: string; value: string; detail?: string | null; errorDetails?: StageErrorDetail[] };

export const STAGE_ORDER: WorkflowStageKey[] = [
  "sync",
  "threats",
  "swing",
  "rebalance",
  "technical",
  "actionables",
];

export const STAGE_METADATA: Record<
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

export const LLM_STAGE_TILE_KEYS = new Set<WorkflowStageKey>([
  "threats",
  "swing",
  "rebalance",
  "technical",
]);

export function getStageClasses(state: StageState) {
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

export function getStageTileLabel(stage: WorkflowStageKey) {
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

export function isActionablesFresh(completedAt: string | null | undefined, now: number) {
  const completedMs = completedAt ? parseTimestampMs(completedAt) : 0;
  return Boolean(completedMs && now - completedMs >= 0 && now - completedMs < 60 * 60 * 1000);
}

export function parseTimestampMs(value?: string | null) {
  if (!value) return 0;
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const date = /[zZ]|[+-]\d{2}:\d{2}$/.test(normalized)
    ? new Date(normalized)
    : new Date(`${normalized}Z`);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : 0;
}

export function formatDuration(
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

export function formatInrCost(value?: number | null) {
  return typeof value === "number" && value > 0
    ? `₹${value.toFixed(2)}`
    : "n/a";
}

export function formatLlmCompletion(info: StageInfo) {
  const count = (value: number | null | undefined) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const total = count(info.totalLlms), completed = count(info.completedLlms);
  const partial = count(info.partialLlms), failed = count(info.failedLlms);
  // completedLlms includes every terminal response. The requested display
  // numerator counts only passed LLMs; underlying run progress stays unchanged.
  const passed = count(info.passedLlms) ?? (completed === 0 || total === 0 ? 0
    : completed !== null && partial !== null && failed !== null ? Math.max(0, completed - partial - failed) : null);
  if (total === null && passed === null && partial === null && failed === null) return "Not available";
  const parts = [`Passed:${passed ?? "?"}`];
  if (partial !== null && partial > 0) parts.push(`Partial:${partial}`);
  if (failed !== null && failed > 0) parts.push(`Failed:${failed}`);
  // Unfinished/missing classifications must not masquerade as passed or failed.
  const unresolved = total === null ? 0 : Math.max(0, total - (passed ?? 0) - (partial ?? 0) - (failed ?? 0));
  if (unresolved > 0) parts.push(`Unresolved:${unresolved}`);
  return `${passed ?? "?"}/${total ?? "?"} (${parts.join(", ")})`;
}

export function formatRecommendedStockProgress(info: StageInfo) {
  return info.recommendedStocks === null || info.recommendedStocks === undefined
    ? "n/a" : String(info.recommendedStocks);
}

export function isSheetExportError(error?: string | null) {
  const normalized = error?.trim().replace(/\s+/g, " ") ?? "";
  if (!normalized) return false;
  return /\b\d+\s*\/\s*\d+\s*exported\b/i.test(normalized) || /google\s+sheets?|sheet\s+export|export(?:ed|ing)?\s+(?:to\s+)?sheets?/i.test(normalized);
}

export function isInsufficientBalanceError(error?: string | null) {
  return /insufficient\s+(?:balance|quota)|no\s+credits?\s+remaining|add\s+credits?\s+to\s+continue/i.test(error ?? "");
}

export function formatBriefTileError(error?: string | null) {
  if (!error?.trim() || isSheetExportError(error)) return "None";
  if (isInsufficientBalanceError(error)) return "DeepSeek credits were insufficient for this run";
  const trimmed = error.trim().replace(/\s+/g, " ");
  return trimmed.length > 96 ? `${trimmed.slice(0, 93)}…` : trimmed;
}

export function getTileErrorDetail(error?: string | null) {
  if (!error?.trim() || isSheetExportError(error)) return null;
  return error.trim();
}

export function getLlmStageTileRows(info: StageInfo, now: number): StageTileRow[] {
  return [
    { label: "Last Scan", value: formatCompactStageTime(info.completedAt ?? info.startedAt) },
    { label: "LLMs completed", value: formatLlmCompletion(info) },
    { label: "Stocks recommended", value: formatRecommendedStockProgress(info) },
    { label: "Duration", value: formatDuration(info.startedAt, info.endedAt, now) ?? "n/a" },
    { label: "Cost incurred", value: formatInrCost(info.costInr) },
    ...(info.partialNotice ? [{ label: "Partial use", value: info.partialNotice }] : []),
    { label: "Error", value: formatBriefTileError(info.error), detail: getTileErrorDetail(info.error), errorDetails: info.errorDetails },
  ];
}

export function getActionablesStageTileRows(info: StageInfo): StageTileRow[] {
  return [
    { label: "Last update", value: formatCompactStageTime(info.completedAt ?? info.startedAt) },
    { label: "Rebalance inputs", value: info.rebalanceInputs?.toString() ?? "n/a" },
    { label: "Stocks recommended", value: info.recommendedStocks?.toString() ?? "n/a" },
    ...(info.partialNotice ? [{ label: "Partial use", value: info.partialNotice }] : []),
    { label: "Error", value: formatBriefTileError(info.error), detail: getTileErrorDetail(info.error), errorDetails: info.errorDetails },
  ];
}

export function getIdleStageRows(stage: WorkflowStageKey, info: StageInfo, now: number): StageTileRow[] {
  if (stage === "sync") {
    const rows: StageTileRow[] = [
      { label: "Latest sync", value: formatCompactStageTime(info.completedAt) },
    ];
    if (info.error) rows.push({ label: "Error", value: info.error });
    return rows;
  }
  if (LLM_STAGE_TILE_KEYS.has(stage)) {
    return getLlmStageTileRows(info, now);
  }
  return getActionablesStageTileRows(info);
}

export function BoxArrowIcon({
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

export function SelectInputsIcon({ className }: { className?: string }) {
  return <BoxArrowIcon className={className} variant="input" />;
}

export function ViewOutputIcon({ className }: { className?: string }) {
  return <BoxArrowIcon className={className} variant="output" />;
}

export function LlmDetailsIcon(props: SVGProps<SVGSVGElement>) {
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

export function PromptIcon(props: SVGProps<SVGSVGElement>) {
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

export function WorkflowStageTile({
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
  placeOrderLabel = "Place Order",
  onCalculationsClick,
  historical = false,
}: {
  historical?: boolean;
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
  placeOrderLabel?: string;
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
  const [openErrorDetail, setOpenErrorDetail] = useState<string | null>(null);
  const lastAutoOpenedErrorRef = useRef<string | null>(null);
  const [durationDialogOpen, setDurationDialogOpen] = useState(false);
  const closeDurationDialog = useCallback(
    () => setDurationDialogOpen(false),
    [],
  );
  const stageRows =
    info.state === "idle" || info.state === "queued"
      ? getIdleStageRows(stage, info, now)
      : LLM_STAGE_TILE_KEYS.has(stage)
        ? getLlmStageTileRows(info, now)
        : stage === "actionables"
          ? getActionablesStageTileRows(info)
          : getIdleStageRows(stage, info, now);
  const stageErrorRow = stageRows.find(
    (row) => row.label === "Error" && row.detail,
  );
  // Deliberately exclude status and errorDetails. Polling can hydrate those
  // fields after the first failure render; they enrich the open dialog but do
  // not represent a second failure and must not reopen a dialog the user
  // already closed.
  const stageErrorFingerprint = stageErrorRow
    ? JSON.stringify({
        stage,
        detail: stageErrorRow.detail,
        runId: info.activeRunId ?? info.lastRunId ?? null,
      })
    : null;

  useEffect(() => {
    // Historical idle-stage errors remain manually reopenable from the tile,
    // but only a newly failed active stage should interrupt the user.
    if (historical || !stageErrorFingerprint || info.state !== "failed") return;
    if (lastAutoOpenedErrorRef.current === stageErrorFingerprint) return;
    lastAutoOpenedErrorRef.current = stageErrorFingerprint;
    setOpenErrorDetail(stageErrorFingerprint);
  }, [historical, info.state, stageErrorFingerprint]);

  const renderStageRow = (row: StageTileRow) => {
    if (historical && row.label === "Duration" && !info.endedAt) {
      return <p key={row.label}><span className="font-semibold">Duration:</span> n/a</p>;
    }
    if (row.label === "Duration") {
      return (
        <p key={row.label}>
          <button
            type="button"
            aria-haspopup="dialog"
            aria-label={`Show duration breakdown for ${stageMeta.idle}`}
            title="Show duration breakdown"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setDurationDialogOpen(true);
            }}
            className="pointer-events-auto inline-flex cursor-pointer items-baseline rounded px-0.5 text-blue-700 underline decoration-blue-300 underline-offset-2 transition hover:text-blue-800 hover:decoration-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
          >
            <span className="font-semibold">{row.label}:</span>{" "}
            {row.value}
          </button>
        </p>
      );
    }

    return (
      <p
        key={row.label}
        className={
          row.label === "Error" && row.value !== "None"
            ? "text-red-700"
            : row.label === "Partial use" ? "text-amber-700" : undefined
        }
      >
        <span
          className={cn(
            "font-semibold text-slate-600",
            row.label === "LLMs completed" && "pointer-events-auto",
          )}
        >
          {row.label}:
        </span>{" "}
        {row.label === "Error" && row.detail ? (
          <span className="relative inline-flex align-middle">
            <button
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setOpenErrorDetail((current) =>
                  current === stageErrorFingerprint
                    ? null
                    : stageErrorFingerprint,
                );
              }}
              className="pointer-events-auto cursor-pointer rounded text-left text-red-700 underline decoration-red-300 underline-offset-2 transition hover:text-red-800 hover:decoration-red-500 focus:outline-none focus:ring-2 focus:ring-red-200"
              aria-label="Show detailed LLM error"
              title="Show detailed LLM error"
            >
              {row.value}
            </button>
            {openErrorDetail === stageErrorFingerprint &&
            typeof document !== "undefined"
              ? createPortal(
                  <div
                    role="dialog"
                    aria-modal="true"
                    aria-label="Detailed LLM error"
                    className="pointer-events-auto fixed inset-0 z-[200] flex items-start justify-center overflow-y-auto bg-slate-950/60 px-4 py-10"
                    onClick={() => setOpenErrorDetail(null)}
                  >
                    <div
                      className="w-full max-w-2xl overflow-hidden rounded-2xl border border-red-200 bg-white text-left text-sm text-slate-700 shadow-2xl"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <div className="flex items-start justify-between gap-4 border-b border-red-100 bg-red-50 px-5 py-4">
                        <div>
                          <span className="block text-xs font-bold uppercase tracking-[0.16em] text-red-700">Stage failed</span>
                          <span className="mt-1 block text-xl font-bold text-slate-950">{stageMeta.idle}</span>
                          <span className="mt-1 block text-xs text-slate-600">
                            Status: {info.runStatus || info.state}
                            {info.activeRunId || info.lastRunId
                              ? ` · Run #${info.activeRunId ?? info.lastRunId}`
                              : ""}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => setOpenErrorDetail(null)}
                          className="rounded-full p-2 text-slate-500 hover:bg-red-100 hover:text-slate-900"
                          aria-label="Close detailed error"
                        >
                          <X className="size-5" />
                        </button>
                      </div>
                      <div className="space-y-5 px-5 py-5">
                        <section>
                          <span className="block font-bold text-slate-950">Error message</span>
                          <span className="mt-2 block whitespace-pre-wrap break-words rounded-xl border border-red-200 bg-red-50 p-3 font-medium text-red-800">
                            {row.detail}
                          </span>
                        </section>
                        <section>
                          <span className="block font-bold text-slate-950">Provider and job details</span>
                          {row.errorDetails?.length ? (
                            <span className="mt-2 block space-y-3">
                              {row.errorDetails.map((detail, index) => (
                                <span
                                  key={`${detail.provider ?? "unknown"}-${detail.model ?? "unknown"}-${detail.jobId ?? index}`}
                                  className="block rounded-xl border border-slate-200 bg-slate-50 p-3"
                                >
                                  <span className="block font-semibold text-slate-900">
                                    {detail.provider || "Unknown provider"} / {detail.model || "Unknown model"}
                                  </span>
                                  <span className="mt-0.5 block text-xs text-slate-500">
                                    {detail.jobId ? `Job #${detail.jobId}` : "Job ID unavailable"}
                                    {detail.runId ? ` · Run #${detail.runId}` : " · Run ID unavailable"}
                                    {detail.status ? ` · Status: ${detail.status}` : ""}
                                  </span>
                                  <span className="mt-2 block whitespace-pre-wrap break-words">{detail.message}</span>
                                  <span className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                                    <span className="block"><b>HTTP status:</b> {detail.httpStatus ?? "Unavailable"}</span>
                                    <span className="block"><b>Retry safe:</b> {detail.retrySafe === true ? "Yes" : detail.retrySafe === false ? "No" : "Unavailable"}</span>
                                    <span className="block"><b>Correlation ID:</b> {detail.correlationId || "Unavailable"}</span>
                                    <span className="block"><b>Attempt:</b> {detail.attempt ?? "Unavailable"}</span>
                                    <span className="block sm:col-span-2"><b>Exception type:</b> {detail.exceptionType || "Unavailable"}</span>
                                    <span className="block break-all sm:col-span-2"><b>Trace reference:</b> {detail.traceReference || "Unavailable"}</span>
                                  </span>
                                  <span className="mt-3 block">
                                    <span className="block text-xs font-bold uppercase tracking-wide text-slate-500">Provider response body</span>
                                    <code className="mt-1 block max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-2 text-xs text-slate-100">
                                      {detail.providerResponseBody || "Unavailable"}
                                    </code>
                                  </span>
                                </span>
                              ))}
                            </span>
                          ) : (
                            <span className="mt-2 block rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-900">
                              The backend did not return an underlying provider exception or job identifier. The message above is the complete diagnostic currently available; inspect the server logs for this run and preserve the original exception in the API response.
                            </span>
                          )}
                        </section>
                        <section>
                          <span className="block font-bold text-slate-950">What to do next</span>
                          <ol className="mt-2 list-decimal space-y-1.5 pl-5">
                            <li>Check the provider/job detail above and correct the reported authentication, quota, timeout, parsing, or upstream-service issue.</li>
                            <li>If no underlying cause was returned, inspect backend and worker logs using the run or job ID shown above.</li>
                            <li>Retry this stage only after the cause is corrected; completed stages and their outputs remain unchanged.</li>
                          </ol>
                        </section>
                        <div className="flex justify-end border-t pt-4">
                          <Button type="button" onClick={() => setOpenErrorDetail(null)}>Close</Button>
                        </div>
                      </div>
                    </div>
                  </div>,
                  document.body,
                )
              : null}
          </span>
        ) : (
          <span>{row.value}</span>
        )}
      </p>
    );
  };

  return (
    <>
    <article
      className={`relative flex min-h-[17rem] flex-col items-start justify-start rounded-2xl border p-5 text-left align-top shadow-sm transition hover:-translate-y-0.5 hover:shadow-md disabled:cursor-default disabled:hover:translate-y-0 ${getStageClasses(info.state)} ${selectionClasses}`}
    >
      <button
        type="button"
        onClick={() => {
          onClick?.();
        }}
        disabled={!onClick}
        className="absolute inset-0 z-0 rounded-2xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-default"
        aria-label={`${selectable ? (selected ? "Deselect" : "Select") : "Open"} ${stageMeta.idle} stage`}
      >
        <span className="sr-only">{stageMeta.idle}</span>
      </button>
      {onInputClick ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onInputClick();
          }}
          className={`absolute left-5 top-5 z-20 ${iconButtonClasses}`}
          aria-label={`Select inputs for ${stageMeta.idle}`}
          title="Select Inputs"
        >
          <SelectInputsIcon className="size-6" />
        </button>
      ) : null}
      {onInfoClick ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onInfoClick();
          }}
          className={`absolute right-5 top-5 z-20 ${iconButtonClasses}`}
          aria-label={`Show ${stageMeta.idle} LLM details`}
          title="LLM models and expected cost"
        >
          <LlmDetailsIcon className="size-6" />
        </button>
      ) : null}

      {onCalculationsClick ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onCalculationsClick();
          }}
          className={`absolute right-5 top-5 z-20 ${iconButtonClasses}`}
          aria-label={`Open ${stageMeta.idle} Actionables Calculations`}
          title="Actionables Calculations"
        >
          <FileSpreadsheet className="size-6" />
        </button>
      ) : null}

      <div className="pointer-events-none relative z-10 w-full px-10 text-center text-base font-semibold text-slate-950">
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

      <div className="pointer-events-none relative z-10 mt-6 w-full space-y-2 text-sm leading-5 text-slate-600">
        {historical ? <p><span className="font-semibold">Status:</span> {info.runStatus || "Not recorded"}</p> : null}
        {stageRows.map(renderStageRow)}
      </div>

      {onSyncNowClick && stage === "sync" ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onSyncNowClick();
          }}
          className="relative z-20 mt-6 inline-flex h-10 items-center justify-center self-center rounded-full bg-blue-600 px-6 text-sm font-semibold text-white shadow-md shadow-blue-600/25 transition hover:bg-blue-700"
        >
          Sync Now
        </button>
      ) : null}

      {onPlaceOrderClick && stage === "actionables" ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onPlaceOrderClick();
          }}
          className={cn(
            "relative z-20 mt-6 inline-flex h-10 items-center justify-center self-center rounded-full px-6 text-sm font-semibold text-white shadow-md transition",
            isFreshActionables
              ? "bg-emerald-600 shadow-emerald-600/25 hover:bg-emerald-700"
              : "bg-blue-600 shadow-blue-600/25 hover:bg-blue-700",
          )}
        >
          {placeOrderLabel}
        </button>
      ) : null}

      <div className="pointer-events-none relative z-10 mt-auto flex w-full items-end justify-between gap-3 pt-5">
        {showPromptShortcut ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onPromptClick?.();
            }}
            className="pointer-events-auto inline-flex size-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-950 shadow-sm transition hover:border-slate-300 hover:bg-slate-50"
            aria-label={`Open prompt for ${stageMeta.idle}`}
            title="Prompt"
          >
            <PromptIcon className="size-6" />
          </button>
        ) : (
          <span aria-hidden="true" />
        )}
        {onOutputClick ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onOutputClick();
            }}
            className={`pointer-events-auto ${iconButtonClasses}`}
            aria-label={`View output for ${stageMeta.idle}`}
            title="View Output"
          >
            <ViewOutputIcon className="size-6" />
          </button>
        ) : null}
      </div>
    </article>
    <StageDurationBreakdownDialog
      open={durationDialogOpen}
      stageLabel={stageMeta.idle}
      info={info}
      now={now}
      onClose={closeDurationDialog}
    />
    </>
  );
}

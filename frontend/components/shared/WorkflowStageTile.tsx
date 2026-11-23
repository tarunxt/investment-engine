"use client";

import { technicalReason } from "@/lib/technicalReason";

import { useState, useCallback, type SVGProps } from "react";
import { FileSpreadsheet, LoaderCircle } from "lucide-react";
import { StageErrorDetails } from "@/components/shared/StageErrorDetails";
import { formatRebalanceCost, type StageCost } from "@/lib/rebalanceCost";
import { cn } from "@/lib/utils";
import { formatCompactStageTime } from "@/lib/datetime";
import { StageDurationBreakdownDialog } from "@/app/console/dashboard/_components/StageDurationBreakdownDialog";

export type WorkflowStageKey =
  | "sync"
  | "swing"
  | "threats"
  | "rebalance"
  | "pairwise"
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

export type StageInfo = StageCost & {
  state: StageState;
  evidence?: { kind: "saved" | "derived"; references: string[] };
  startedAt?: string | null;
  endedAt?: string | null;
  completedAt?: string | null;
  provider?: string | null;
  model?: string | null;
  runStatus?: string | null;
  exportStatus?: string | null;
  error?: string | null;
  errorDetails?: StageErrorDetail[];
  activeRunId?: number | null;
  lastRunId?: number | null;
  workflowSequence?: number | null;
  portfolioStockCount?: number | null;
  jobId?: number | null;
  completedLlms?: number | null;
  passedLlms?: number | null;
  partialLlms?: number | null;
  partialNotice?: string | null;
  failedLlms?: number | null;
  totalLlms?: number | null;
  recommendedStocks?: number | null;
  commonStocks?: number | null;
  finalSummary?: import("@/lib/independentScorecards").FinalCounts;
  rebalanceInputs?: number | null;
  sourceRevision?: number;
  sourceListingCount?: number;
  finalInputs?: Record<string, unknown>;
  published?: import("@/lib/independentScorecards").AvailableOutput;
  evidenceCoverage?: string;
  threatCounts?: {diagnostics?:import("@/lib/independentScorecards").ThreatDiagnostics;expected:number;returned:number;scored:number;complete:number;status:string};
  distinctModels?: number;
  pairCoverage?: string;
  pairStatus?: "completed" | "partial";
  portfolioThreat?: string;
  frozenFinal?: Record<string, unknown>;
};

export type StageTileRow = { label: string; value: string; detail?: string | null; errorDetails?: StageErrorDetail[] };

export const STAGE_ORDER: WorkflowStageKey[] = [
  "sync",
  "swing",
  "threats",
  "rebalance",
  "technical",
  "pairwise",
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
    idle: getStageTileLabel("sync"),
    running: "Syncing Portfolio",
    completed: "Portfolio Synced",
    tileDescription:
      "Refresh Zerodha holdings, cash, and exposure before any risk or opportunity logic runs.",
    chartTitle: "Sync",
    chartLines: ["Latest holdings, cash,", "and exposure snapshot"],
  },
  swing: {
    step: "02",
    idle: getStageTileLabel("swing"),
    running: "Running Swing Scan",
    completed: "Swing Scan Ready",
    tileDescription:
      "Surface fresh setups, momentum, and catalyst-driven names worth new capital or adds.",
    chartTitle: "Swing",
    chartLines: ["Momentum, catalysts,", "and opportunity signals"],
  },
  pairwise: {step:"03.4", idle:"Pairwise scorecard", running:"Running Pairwise scorecard", completed:"Pairwise scorecard ready", tileDescription:"Compare each pair of Stage 2 listings over the swing horizon.", chartTitle:"Pairwise", chartLines:["Head-to-head comparisons"]},
  threats: {
    step: "03.3",
    idle: getStageTileLabel("threats"),
    running: "Running Threats Scan",
    completed: "Threats Scan Ready",
    tileDescription:
      "Check risks in the economy, sectors, and your holdings before adding, reducing, or holding investments.",
    chartTitle: "Threats",
    chartLines: ["Macro, sector, and", "position-level guardrails"],
  },
  rebalance: {
    step: "03.1",
    idle: getStageTileLabel("rebalance"),
    running: "Building Rebalance",
    completed: "Rebalance Ready",
    tileDescription:
      "Evaluate the Stage 2 portfolio and contenders for adds, trims and holds.",
    chartTitle: "Rebalance",
    chartLines: ["Merge signals into target", "weights, adds, trims, holds"],
  },
  technical: {
    step: "03.2",
    idle: getStageTileLabel("technical"),
    running: "Running Technical Scan",
    completed: "Technical Scan Ready",
    tileDescription:
      "Validate entry quality, trim timing, and whether each proposed action still fits the chart.",
    chartTitle: "Technical",
    chartLines: ["Validate entries, trims,", "and execution timing"],
  },
  actionables: {
    step: "04",
    idle: getStageTileLabel("actionables"),
    running: "Preparing Actionables",
    completed: "Actionables Ready",
    tileDescription:
      "Publish the validated buy/add, sell/trim, and hold/watch outputs for execution.",
    chartTitle: "Actionables",
    chartLines: ["Publish trade-ready", "buy, sell, and watch outputs"],
  },
};

export const LLM_STAGE_TILE_KEYS = new Set<WorkflowStageKey>([
  "pairwise",
  "threats",
  "swing",
  "rebalance",
  "technical",
]);

export function getStageBackgroundClass(state: StageState) {
  if (state === "running") return "bg-yellow-50";
  if (state === "queued") return "bg-sky-50";
  if (state === "completed") return "bg-emerald-50";
  if (state === "failed") return "bg-red-100";
  return "bg-slate-100";
}

export function getStageClasses(state: StageState) {
  return `${getStageBackgroundClass(state)} ${getStageToneClasses(state)}`;
}

function getStageToneClasses(state: StageState) {
  if (state === "running")
    return "border-amber-300 text-amber-950 shadow-amber-100 ring-1 ring-amber-100";
  if (state === "queued")
    return "border-sky-200 text-sky-950 shadow-sky-100 ring-1 ring-sky-100";
  if (state === "completed")
    return "border-emerald-300 text-emerald-950 shadow-emerald-100 ring-1 ring-emerald-100";
  if (state === "failed")
    return "border-red-300 text-red-950 shadow-red-100 ring-1 ring-red-100";
  return "border-slate-200 text-slate-950 shadow-slate-100";
}

export function getStageTileLabel(stage: WorkflowStageKey) {
  const labels: Record<WorkflowStageKey, string> = {
    sync: "Sync Portfolio",
    threats: "Threats Scan",
    pairwise: "Pairwise scorecard",
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
  if (ended < started) return "Invalid interval (end before start)";
  const totalSeconds = Math.floor((ended - started) / 1000);
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
  if (info.recommendedStocks == null) return "n/a";
  return info.commonStocks == null ? String(info.recommendedStocks) : `${info.recommendedStocks} (${info.commonStocks} common)`;
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
  if (!error?.trim() || isSheetExportError(error)) return "-";
  if (/different (?:portfolio )?snapshots|selected portfolio capture is no longer available/i.test(error)) return "Portfolio snapshot mismatch";
  if (/partial(?:ly)?/i.test(error)) return "LLM output partial";
  if (isInsufficientBalanceError(error)) return "Provider credits insufficient";
  if (/timeout|timed?\s*out|deadline/i.test(error)) return "Request timed out";
  if (/quota|rate.?limit|\b429\b/i.test(error)) return "Provider quota exceeded";
  if (/authenticat|unauthori[sz]ed|invalid.*key|\b40[13]\b/i.test(error)) return "Provider authentication failed";
  if (/invalid.*output|output.*contract|parsing|parse.*fail|malformed/i.test(error)) return "Invalid LLM output";
  if (/cancelled|canceled|interrupted/i.test(error)) return "Stage execution interrupted";
  return "Stage execution failed";
}

export function getTileErrorDetail(error?: string | null) {
  if (!error?.trim() || /^(?:none|[-–—])$/i.test(error.trim()) || isSheetExportError(error)) return null;
  return error;
}

/** Execution state and saved result are distinct: an idle page can still show a terminal result. */
export function getStageOutcome(info: StageInfo) {
  const status = info.runStatus?.trim().toLowerCase() ?? "";
  const pair = info.published?.pair_counts;
  if (pair && info.published?.run_id==null && !info.activeRunId && info.published?.recovery?.phase!=="judging") {
    return pair.judged===pair.expected && pair.expected>0 && !pair.errors ? "completed" : pair.judged ? "partial" : "unassessed";
  }
  if (info.published && info.published.run_id == null && !info.activeRunId && (info.threatCounts || info.published.counts)) {
    if (info.threatCounts) return info.threatCounts.status==="completed" ? "completed" : info.threatCounts.scored ? "partial" : "unassessed";
    return info.published.counts!.complete===info.published.expected && info.published.expected>0 ? "completed" : info.published.covered ? "partial" : "unassessed";
  }
  if (info.published?.recovery?.phase==="judging") return "running";
  if (info.state === "running" || info.state === "queued") return info.state;
  if (info.state === "idle" && ["processing", "running"].includes(status)) return "running";
  if (info.threatCounts && info.state!=="failed") {
    const {status}=info.threatCounts;
    return status==="completed" ? "completed" : status==="unassessed" ? "unassessed" : "partial";
  }
  if (info.published) {
    const t=info.published.technical_counts;
    if(t) return t.complete===t.expected ? "completed" : t.complete||t.provisional ? "partial" : "unassessed";
    if (info.published.counts) {
      const c=info.published.counts;
      return !c.assessed ? "unassessed" : c.complete===info.published.expected ? "completed" : "partial";
    }
    if (!info.published.covered) return "unassessed";
    if (info.published.pair_counts?.errors) return "partial";
    return info.published.covered === info.published.expected ? "completed" : "partial";
  }
  if (info.state === "failed" || ["failed", "verification failed", "error", "canceled", "cancelled", "interrupted", "killed", "start failed", "auth expired"].includes(status)) return "failed";
  if (status === "completion unconfirmed" && info.error?.startsWith("Final calculation could not be verified:")) return "failed";
  if (status === "completion unconfirmed") return "unconfirmed";
  if (status === "stale") return "stale";
  if (hasStagePartialOutput(info)) return "partial";
  if (info.evidence?.kind === "derived") return "derived";
  if (status.startsWith("using ") || status === "skipped") return "skipped";
  if (status === "interrupted before launch") return "paused";
  if (status.startsWith("paused")) return "paused";
  if (["pending", "queued"].includes(status)) return "queued";
  if (["processing", "running"].includes(status)) return "running";
  if (info.state === "completed" || ["completed", "saved calculation", "synced", "last synced portfolio", "succeeded", "success"].includes(status)) return "completed";
  return "idle";
}

export function getStageLedgerTone(info: StageInfo) {
  const outcome = getStageOutcome(info);
  if (outcome === "partial" || outcome === "unassessed" || outcome === "unconfirmed" || outcome === "stale") return "bg-amber-50";
  if (outcome === "derived" || outcome === "paused" || outcome === "skipped") return getStageBackgroundClass("idle");
  return getStageBackgroundClass(outcome);
}

export function stageTileBorder(info: StageInfo, fallback: string) {
  const outcome = getStageOutcome(info);
  if (info.published?.pair_counts && info.published.run_id==null) return fallback;
  return outcome === "partial" || (outcome === "unassessed" && hasStagePartialOutput(info))
    ? "border-2 border-red-500" : fallback;
}

export function StageStatusIcon({ info }: { info: StageInfo }) {
  const outcome = getStageOutcome(info);
  if (outcome === "running") return <span className="ml-1 inline-flex items-center gap-1 align-middle text-xs">
    <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> (Running)
  </span>;
  const recovering=info.published?.technical_recovery?.state;
  if(recovering==="scheduled"||recovering==="recovering") return <span className="ml-1 text-xs">⏳ Recovering evidence</span>;
  const pair=info.published?.pair_counts;
  if (pair && info.published?.run_id==null && outcome!=="queued" && pair.judged<pair.expected) {
    const phase=info.published?.recovery?.phase;
    return <span className="ml-1 inline-block align-middle text-xs font-medium">{phase==="needs attention" || phase==="evidence recovery exhausted" ? "Needs attention" : pair.ready<pair.listings ? "Waiting for market evidence" : "Awaiting judgments"}</span>;
  }
  const symbols = {
    completed: "✅", failed: "❌", partial: "⚠️✅", stale: "⚠️", unconfirmed: "⚠️", unassessed: "Unassessed", queued: "⏳",
    derived: "ℹ️", skipped: "⏭️", paused: "⏸️", idle: "Idle",
  };
  const description = info.published ? `Output #${info.published.output_id} · ${info.published.covered}/${info.published.expected} covered` : info.runStatus || outcome;
  return <span role="img" aria-label={outcome} title={description} className="ml-1 inline-block align-middle text-xs">{symbols[outcome]}</span>;
}

export function hasStagePartialOutput(info: StageInfo) {
  if (info.state === "running" || info.state === "queued") return false;
  return info.runStatus?.trim().toLowerCase() === "partial" ||
    (info.partialLlms ?? 0) > 0 || Boolean(info.partialNotice?.trim());
}

export function getStageTileError(info: StageInfo): StageTileRow {
  const error = getTileErrorDetail(info.error);
  const t=info.published?.technical_counts;
  if(t && (!error||/partial/i.test(error))) {
    const work=info.published?.technical_recovery;
    const pending=Object.entries(work?.pending??{}).map(([k,v])=>k+" · "+technicalReason(v.reason)).join("\n");
    return {label:"Evidence status",value:t.complete===t.expected?"Complete":work?.state==="exhausted"?"Retries exhausted":
      work?.state==="scheduled"||work?.state==="recovering"?"Recovering evidence":"Missing verified evidence",
      detail:pending||(t.complete<t.expected?"Open Saved stock scores for individual evidence and recovery controls.":null)};
  }
  if (!error && info.threatCounts) {
    const t=info.threatCounts;
    const cause=t.scored<t.expected ? "Insufficient verified risk categories" : t.complete<t.expected ? "Some risk categories unresolved" : "Unresolved validation errors";
    return {label:"Assessment",value:t.status==="completed"?"Complete":cause,detail:t.status==="completed"?null:
      `${t.scored}/${t.expected} listings meet the three-category threshold. ${t.complete}/${t.expected} have all eight categories resolved.`};
  }
  const partial = info.partialNotice?.trim() ? info.partialNotice :
    info.runStatus === "partial" || (info.partialLlms ?? 0) > 0
      ? `Recorded partial output${info.partialLlms != null ? `: ${info.partialLlms} partial LLM responses` : ""}.` : null;
  const detail = [error, partial && partial !== error ? partial : null].filter(Boolean).join("\n\n") ||
    (info.errorDetails?.length ? info.errorDetails.map(item => item.message).join("\n\n") : null);
  return { label: "Error", value: error ? formatBriefTileError(error) : partial ? "LLM output partial" : detail ? "Stage execution failed" : "-", detail, errorDetails: info.errorDetails };
}

function stageErrorRows(info: StageInfo): StageTileRow[] {
  const row = getStageTileError(info);
  return row.detail ? [row] : [];
}

export function getLlmStageTileRows(info: StageInfo, now: number, stage?: WorkflowStageKey): StageTileRow[] {
  const cost = formatRebalanceCost(info);
  const pairs=info.published?.pair_counts;
  const tech=info.published?.technical_counts;
  const work=info.published?.technical_recovery;
  const evidenceOnly=Boolean(info.published && (pairs || info.threatCounts || info.published.counts) && info.published.run_id==null && !info.activeRunId);
  return [
    { label: evidenceOnly ? "Last evidence update" : "Last Scan", value: formatCompactStageTime(info.completedAt ?? info.startedAt) },
    ...(evidenceOnly ? [{ label:"Model jobs",value:"0 · evidence only" }] : [{ label: "LLMs Used", value: formatLlmCompletion(info) }]),
    ...(info.published ? [
      {label:"Available output",value:`#${info.published.output_id} · ${info.published.run_id ? "run #"+info.published.run_id : "evidence only"}`},
      {label:"Recorded execution",value:evidenceOnly ? "Evidence only" : `${info.lastRunId ? "#"+info.lastRunId+" · " : ""}${info.runStatus || info.state}`},
      ...(stage === "technical" || tech ? [] : [{label:"Stage 4 used",value:info.published.used_output_id ? `Output #${info.published.used_output_id} · final #${info.published.final_id}` : "No saved reference"}]),
    ] : []),
    ...(!tech && info.evidenceCoverage ? [{label: "Score coverage", value: info.evidenceCoverage}] : []),
    ...(!evidenceOnly && info.distinctModels != null ? [{label: "Model coverage", value: `${info.totalLlms ?? "?"} jobs · ${info.distinctModels} distinct model${info.distinctModels === 1 ? "" : "s"}`}] : []),
    ...(tech ? [
      {label:"Model rows",value:tech.commentary+"/"+(tech.source_rows??tech.expected)},
      {label:"Complete scores",value:tech.complete+"/"+tech.expected+" unique listings"},
      {label:"Missing evidence",value:String(tech.expected-tech.complete)+" listings"},
      ...(tech.source_rows && tech.source_rows!==tech.expected?[{label:"Source references",value:String(tech.source_rows)}]:[]),
      ...(tech.bullish!=null?[{label:"Bullish Technical scores",value:tech.bullish+" · complete score >55"}]:[]),
      ...(work?.next_retry?[{label:"Next evidence retry",value:new Date(work.next_retry).toLocaleTimeString("en-IN",{timeZone:"Asia/Kolkata"})+" IST"}]:[]),
    ] : pairs ? [
      {label:"Listings in scope",value:String(pairs.listings)},
      {label:"Evidence ready",value:`${pairs.ready}/${pairs.listings} listings`},
      {label:"Ready to judge",value:`${Math.max(0,pairs.eligible-pairs.judged)} pairs · ${pairs.one_missing+pairs.both_missing} blocked`},
      ...(info.published?.recovery ? [
        {label:"Recovery",value:info.published.recovery.phase,detail:info.published.recovery.error ?? undefined},
        ...(info.published.recovery.next_at ? [{label:"Next check",value:formatCompactStageTime(new Date(info.published.recovery.next_at*1000).toISOString())}] : []),
        ...(Object.keys(info.published.recovery.listings).length ? [{label:"Missing inputs",value:`${Object.keys(info.published.recovery.listings).length} listings`,detail:Object.entries(info.published.recovery.listings).map(([k,v])=>`${k} · ${v.reason} · ${v.attempts} attempts`).join("\n")}] : [])
      ] : []),
      {label:"Results recorded",value:`${pairs.returned}/${pairs.expected} · ${pairs.jobs} model job${pairs.jobs===1?"":"s"}`},
      {label:"Missing evidence",value:`${pairs.one_missing} pairs on one side · ${pairs.both_missing} on both`},
      {label:"Fully compared",value:`${pairs.complete_stocks}/${pairs.listings} listings · ${pairs.mode}`},
    ] : info.threatCounts ? [
      {label:"Listings in scope",value:String(info.threatCounts.expected)},
      {label:"Listings returned",value:`${info.threatCounts.returned}/${info.threatCounts.expected}`},
      ...(info.threatCounts.diagnostics ? [
        {label:"Sources for ≥3 categories",value:`${info.threatCounts.diagnostics.scoreable}/${info.threatCounts.expected} listings`},
        {label:"No assigned sources",value:String(info.threatCounts.diagnostics.without_sources)},
        ...(info.threatCounts.diagnostics.confidence_rejected ? [{label:"Confidence format rejected",value:`${info.threatCounts.diagnostics.confidence_rejected} assessments · recheck saved evidence`}] : []),
        ...(info.threatCounts.diagnostics.confidence_recovered ? [{label:"Confidence format recovered",value:`${info.threatCounts.diagnostics.confidence_recovered} assessments`}] : []),
      ] : []),
      {label:"Fully assessed",value:`${info.threatCounts.complete}/${info.threatCounts.expected}`},
    ] : info.published?.counts ? [
      ...(info.published.readiness ? [{label:"Source readiness",value:info.published.readiness.ready+" full · "+info.published.readiness.provisional+" partial · "+info.published.readiness.awaiting+" awaiting evidence"}] : []),
      {label:"Listings assessed",value:String(info.published.counts.assessed)},
      {label:"Score quality",value:`${info.published.counts.complete} complete · ${info.published.counts.provisional} provisional · ${info.published.counts.unassessed} unassessed`},
      {label:"Actions",value:Object.entries(info.published.actions ?? {}).map(([k,v])=>`${k} ${v}`).join(" · ")||"—"},
    ] : [{ label: "Stocks recommended", value: formatRecommendedStockProgress(info) }]),
    ...(!evidenceOnly ? [{ label: "Duration", value: formatDuration(info.startedAt, info.endedAt, now) ?? "n/a" }] : []),
    { label: "Cost incurred", value: evidenceOnly ? "₹0.00 · evidence only" : cost === "Usage unavailable" && getStageOutcome(info) === "running" ? "Task running" : cost },
    ...(pairs && pairs.ready<pairs.listings && !getTileErrorDetail(info.error)
      ? [{label:"Coverage issue",value:"Missing market evidence",detail:"Open Scorecard controls to repair missing evidence."}]
      : evidenceOnly && pairs ? [{label:"Assessment",value:pairs.judged<pairs.expected ? "Awaiting judgments" : pairs.expected ? "All pairs judged" : "No pairs assigned"}]
      : evidenceOnly && info.threatCounts ? [{label:"Assessment",value:info.threatCounts.scored ? "Saved risk assessments" : "No consolidated scores yet · see category evidence"}]
      : evidenceOnly && info.published?.counts ? [{label:"Assessment",value:info.published.covered ? "Saved factor scores" : "No verified factor scores recorded"}] : stageErrorRows(info)),
  ];
}

export function getActionablesStageTileRows(info: StageInfo): StageTileRow[] {
  return [
    { label: "Last update", value: formatCompactStageTime(info.completedAt ?? info.startedAt) },
    ...(info.finalSummary ? [
      {label:"Rebalance inputs",value:info.finalSummary.rebalance_output ? `${info.finalSummary.rebalance_inputs ?? "—"} listings · Output #${info.finalSummary.rebalance_output}` : "No Rebalance output selected"},
      ...(info.finalSummary.pairwise && info.finalSummary.pairwise.judged<info.finalSummary.pairwise.expected ? [{label:"Pairwise input",value:`Pending · ${info.finalSummary.pairwise.judged}/${info.finalSummary.pairwise.expected} judged in #${info.finalSummary.pairwise.used}${info.finalSummary.pairwise.completed_output ? " · completed output #"+info.finalSummary.pairwise.completed_output+" available for recalculation" : ""}`}] : []),
      ...(info.finalSummary.scored!=null ? [{label:"Listings with a final score",value:`${info.finalSummary.scored}/${info.finalSummary.assessed}`}] : []),
      {label:"Fully assessed",value:`${info.finalSummary.complete}/${info.finalSummary.assessed}`},
      {label:"Eligibility",value:`${info.finalSummary.eligible} trade-eligible · ${info.finalSummary.holds} Hold · ${info.finalSummary.blocked} blocked`},
    ] : [{ label: "Rebalance inputs", value: info.rebalanceInputs?.toString() ?? "n/a" }]),
    { label: "Stocks recommended", value: info.recommendedStocks?.toString() ?? "n/a" },
    ...(info.finalSummary && info.finalSummary.complete < info.finalSummary.assessed && (!getTileErrorDetail(info.error) || /partial/i.test(info.error ?? "")) ?
      [{label:"Assessment",value:"Incomplete scorecard inputs",detail:"Open Final Actionables to inspect saved scores or update this final using recovered outputs."}] : stageErrorRows(info)),
  ];
}

export function getIdleStageRows(stage: WorkflowStageKey, info: StageInfo, now: number): StageTileRow[] {
  if (info.runStatus === "not started" || info.runStatus === "interrupted before launch") {
    const interrupted = info.runStatus === "interrupted before launch";
    const rows = [{ label: "Workflow", value: `#${info.workflowSequence} · ${interrupted ? "Interrupted before launch" : "Not started"}` }];
    if (interrupted) rows.push({ label: "Model jobs launched", value: "0" });
    return rows;
  }
  if (stage === "sync") {
    const rows: StageTileRow[] = [
      { label: "Latest sync", value: formatCompactStageTime(info.completedAt) },
    ];
    rows.push(...stageErrorRows(info));
    return rows;
  }
  if (LLM_STAGE_TILE_KEYS.has(stage)) {
    return getLlmStageTileRows(info, now, stage);
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
  const stageMeta = STAGE_METADATA[stage];
  const showPromptShortcut = Boolean(onPromptClick);
  const iconButtonClasses =
    "inline-flex size-10 items-center justify-center rounded-full border border-blue-200 bg-white text-slate-800 shadow-sm transition hover:border-blue-400 hover:bg-white hover:text-blue-700";
  const selectionClasses = selectable
    ? selected
      ? "ring-2 ring-blue-500"
      : info.state === "idle"
        ? "opacity-100"
        : ""
    : "";
  const isFreshActionables = isActionablesFresh(info.completedAt, now);
  const [durationDialogOpen, setDurationDialogOpen] = useState(false);
  const closeDurationDialog = useCallback(
    () => setDurationDialogOpen(false),
    [],
  );
  const stageRows =
    info.state === "idle" || info.state === "queued"
      ? getIdleStageRows(stage, info, now)
      : LLM_STAGE_TILE_KEYS.has(stage)
        ? getLlmStageTileRows(info, now, stage)
        : stage === "actionables"
          ? getActionablesStageTileRows(info)
          : getIdleStageRows(stage, info, now);
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

    if (row.label === "Error") {
      return <p key={row.label} className={row.detail ? "text-red-700" : undefined}>
        <span className="font-semibold text-slate-600">Error:</span>{" "}
        <span>{row.value}</span>{" "}
        {row.detail ? <StageErrorDetails stageLabel={stageMeta.idle} info={info} row={row} /> : null}
      </p>;
    }
    return <p key={row.label}>
      <span className={cn("font-semibold text-slate-600", row.label === "LLMs Used" && "pointer-events-auto")}>{row.label}:</span>{" "}
      <span>{row.value}</span>
    </p>;
  };

  return (
    <>
    <article
      className={`relative flex min-h-[17rem] flex-col items-start justify-start rounded-2xl border p-5 text-left align-top shadow-sm transition hover:-translate-y-0.5 hover:shadow-md disabled:cursor-default disabled:hover:translate-y-0 ${getStageLedgerTone(info)} ${stageTileBorder(info, getStageToneClasses(info.state))} ${selectionClasses}`}
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
          <span className="truncate">{getStageTileLabel(stage)}</span><StageStatusIcon info={info} />
        </div>
      </div>

      <div className="pointer-events-none relative z-10 mt-6 w-full space-y-2 text-sm leading-5 text-slate-600">
        {stage === "threats" ? <p>{stageMeta.tileDescription}</p> : null}
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
      stagePurpose={stage === "threats" ? stageMeta.tileDescription : undefined}
      info={info}
      now={now}
      onClose={closeDurationDialog}
    />
    </>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Info, Loader2, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createBullpenQuestionRow, type BullpenQuestionRow } from "@/lib/bullpen-ai";
import { formatApiTimestamp } from "@/lib/datetime";
import type { BullpenAutoLiveEventTrend, BullpenAutoLiveEventTrendsResponse, BullpenAutoLiveHistoryItem, BullpenAutoLiveHistoryPage } from "@/types/api";
import { BullpenLlmBreakdownDialog } from "./BullpenLlmBreakdownDialog";
import { BullpenClusterJsonDialog, useBullpenEventClusters } from "./BullpenEventClusters";
import type { ClusterMode } from "@/lib/bullpen-event-clusters";
import { BullpenEventTrendsTable } from "./BullpenEventTrendsTable";
import { BullpenClaimReturnsDialog } from "./BullpenClaimReturnsDialog";
import { applyClaimReturns } from "@/lib/bullpen-claim-returns";
import clusterMetadata from "@/data/bullpen-event-clusters-metadata.json";

type ClusterMetadata = {
  status?: "completed" | "failed";
  completed_at?: string | null;
  failed_at?: string | null;
  failure_reason?: string | null;
  source_run_id?: string | null;
  source_stage1_completed_at?: string | null;
  filtered_count?: number | null;
  counts?: {
    unique_inspected?: number;
    eligible?: number;
    classified?: number;
    unresolved?: number;
    clusters?: number;
  };
};

const formatTime = (value?: string | null) => formatApiTimestamp(value, { emptyValue: "—", timeZone: "Asia/Kolkata", timeZoneName: "short", second: "2-digit" });

const findLatestOperationalStage = (
  runs: BullpenAutoLiveHistoryItem[],
  key: BullpenAutoLiveHistoryItem["stages"][number]["key"],
) => {
  for (const run of runs) {
    const stage = run.stages.find((candidate) => candidate.key === key);
    if (!stage || stage.status === "skipped") continue;
    return stage;
  }
  return null;
};

const formatOperationalStage = (
  stage: BullpenAutoLiveHistoryItem["stages"][number] | null,
) => {
  if (!stage) return "Not recorded";
  if (stage.status === "fail") {
    return stage.completed_at ? `Failed at ${formatTime(stage.completed_at)}` : "Failed";
  }
  if (stage.completed_at) return formatTime(stage.completed_at);
  return stage.started_at ? `In progress since ${formatTime(stage.started_at)}` : "In progress";
};

const formatOperationalTimestamp = (value?: string | null) =>
  value ? formatTime(value) : "Not recorded";

const formatHourlyRebalance = (
  status?: "completed" | "failed" | null,
  attemptedAt?: string | null,
  legacyCompletedAt?: string | null,
) => {
  if (status && attemptedAt) {
    return status === "completed"
      ? formatTime(attemptedAt)
      : `Failed at ${formatTime(attemptedAt)}`;
  }
  if (status === "failed") return "Failed";
  return legacyCompletedAt ? formatTime(legacyCompletedAt) : "Not recorded";
};

const formatClusteringStatus = (
  metadata: ClusterMetadata,
  latestStage1CompletedAt?: string | null,
) => {
  if (metadata.status === "failed") {
    return metadata.failed_at
      ? `Failed at ${formatTime(metadata.failed_at)}`
      : "Failed";
  }
  const clusteredAt = Date.parse(metadata.completed_at ?? "");
  const stage1At = Date.parse(latestStage1CompletedAt ?? "");
  if (metadata.status === "completed" && Number.isFinite(clusteredAt)) {
    if (!Number.isFinite(stage1At) || clusteredAt >= stage1At) {
      return formatTime(metadata.completed_at);
    }
    return `Pending since ${formatTime(latestStage1CompletedAt)}`;
  }
  return Number.isFinite(stage1At)
    ? `Pending since ${formatTime(latestStage1CompletedAt)}`
    : "Not recorded";
};

export const calculateTrendDaysUntilClose = (event: BullpenAutoLiveEventTrend) => {
  if (!event.close_time) return null;
  const closeTime = new Date(event.close_time).getTime();
  const latestScan = event.scan_timestamps.find(Boolean);
  const scanTime = latestScan ? new Date(latestScan).getTime() : Number.NaN;
  if (!Number.isFinite(closeTime) || !Number.isFinite(scanTime)) return null;
  const days = Number(((closeTime - scanTime) / 86_400_000).toFixed(1));
  return days;
};

export const trendQuestion = (event: BullpenAutoLiveEventTrend): BullpenQuestionRow => createBullpenQuestionRow({
  id: event.market_id,
  question: event.market_title,
  marketId: event.market_id,
  questionId: event.market_id,
  closeTime: event.close_time ?? null,
  category: "",
  yesOdds: event.current_yes_odds ?? null,
  noOdds: event.current_no_odds ?? null,
  volume: null,
  liquidity: null,
  sourceUrl: event.market_url ?? "",
  slug: null,
  marketUrl: event.market_url ?? null,
  outcomeLabels: ["Yes", "No"],
  outcomeCount: 2,
  isBinaryYesNo: true,
  daysUntilClose: calculateTrendDaysUntilClose(event),
  rules: null,
  marketContext: null,
  resolutionSource: null,
  llmYesOdds: event.llm_yes_odds ?? null,
  llmNoOdds: event.llm_no_odds ?? null,
  returnsPerDay: event.returns_per_day ?? null,
});

function ScoreCalculation({ event, onClose }: { event: BullpenAutoLiveEventTrend; onClose: () => void }) {
  const terms = event.scan_scores.slice(0, 3).map((value, index) => ({ value: value ?? 0, weight: [1, .5, .25][index] }));
  return <div className="fixed inset-0 z-[160] flex items-center justify-center bg-slate-950/55 p-4" onMouseDown={e => e.target === e.currentTarget && onClose()}>
    <div role="dialog" aria-modal="true" className="w-full max-w-lg rounded-3xl bg-white p-6 shadow-2xl">
      <div className="flex justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-widest text-slate-500">Score calculation</p><h3 className="mt-2 font-bold text-slate-950">{event.market_title}</h3></div><button onClick={onClose} aria-label="Close score calculation"><X className="h-5 w-5" /></button></div>
      <div className="mt-5 space-y-2 text-sm">{terms.map((term, i) => <div key={i} className="flex justify-between rounded-xl bg-slate-50 px-4 py-3"><span>{i === 0 ? "Latest" : i === 1 ? "Previous" : "Third-latest"}: {term.value.toFixed(2)} × {term.weight}</span><strong>{(term.value * term.weight).toFixed(2)}</strong></div>)}</div>
      <div className="mt-3 flex justify-between rounded-xl bg-slate-950 px-4 py-3 text-white"><span>Weighted score</span><strong>{event.score.toFixed(2)}</strong></div>
    </div>
  </div>;
}

type OperationalStatusDetail = {
  title: string;
  status: string;
  timestampLabel: string;
  timestamp: string;
  reason: string;
  rows: Array<{ label: string; value: string }>;
};

function OperationalStatusDialog({ detail, onClose }: { detail: OperationalStatusDetail; onClose: () => void }) {
  return <div className="fixed inset-0 z-[170] flex items-center justify-center bg-slate-950/55 p-4" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <div role="dialog" aria-modal="true" aria-labelledby="bullpen-operational-status-title" className="w-full max-w-xl rounded-3xl bg-white p-6 shadow-2xl">
      <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-widest text-slate-500">Operational status</p><h3 id="bullpen-operational-status-title" className="mt-2 text-lg font-bold text-slate-950">{detail.title}</h3></div><button type="button" onClick={onClose} aria-label="Close operational status details"><X className="h-5 w-5" /></button></div>
      <dl className="mt-5 grid gap-3 text-sm">
        <div className="rounded-xl bg-slate-50 px-4 py-3"><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Status</dt><dd className="mt-1 font-bold text-slate-950">{detail.status}</dd></div>
        <div className="rounded-xl bg-slate-50 px-4 py-3"><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{detail.timestampLabel}</dt><dd className="mt-1 font-semibold text-slate-800">{detail.timestamp}</dd></div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3"><dt className="text-xs font-semibold uppercase tracking-wide text-amber-800">Reason</dt><dd className="mt-1 leading-6 text-amber-950">{detail.reason}</dd></div>
        {detail.rows.map(row => <div key={row.label} className="grid gap-1 rounded-xl border border-slate-200 px-4 py-3 sm:grid-cols-[11rem_1fr]"><dt className="font-semibold text-slate-600">{row.label}</dt><dd className="break-words text-slate-900">{row.value}</dd></div>)}
      </dl>
    </div>
  </div>;
}

export type BullpenRunHistoryContentProps = {
  page: BullpenAutoLiveHistoryPage | null; trends: BullpenAutoLiveEventTrendsResponse | null;
  loading: boolean; trendsLoading: boolean; error: string | null; trendsError: string | null;
  detailLoadingId?: string | null; onRefresh: () => void; onPage: (page: number) => void;
  onOpenRun: (run: BullpenAutoLiveHistoryItem) => void; onClose?: () => void; showFullScreen?: boolean;
  eyebrow?: string; title?: string; fullScreenPath?: string;
  lastRebalanceAt?: string | null;
  hourlyRebalanceStatus?: "completed" | "failed" | null;
  hourlyRebalanceAt?: string | null;
  hourlyRebalanceDetail?: string | null;
  hourlyRebalanceLastError?: string | null;
  hourlyRebalanceLastAction?: string | null;
  latestRuns?: BullpenAutoLiveHistoryItem[];
  loadReturnsFormula?: () => Promise<string>;
  saveReturnsFormula?: (formula: string) => Promise<string>;
};

export function BullpenRunHistoryContent({ page, trends, loading, trendsLoading, error, trendsError, detailLoadingId, onRefresh, onPage, onOpenRun, onClose, showFullScreen = true, eyebrow = "Run History", title = "Bullpen Auto and Manual Runs", fullScreenPath = "/console/bullpen-ai/history", lastRebalanceAt, hourlyRebalanceStatus, hourlyRebalanceAt, hourlyRebalanceDetail, hourlyRebalanceLastError, hourlyRebalanceLastAction, latestRuns, loadReturnsFormula, saveReturnsFormula }: BullpenRunHistoryContentProps) {
  const [scoreEvent, setScoreEvent] = useState<BullpenAutoLiveEventTrend | null>(null);
  const [llmQuestion, setLlmQuestion] = useState<BullpenQuestionRow | null>(null);
  const [returnsMarketId, setReturnsMarketId] = useState<string | null>(null);
  const [showReturnsFormula, setShowReturnsFormula] = useState(false);
  const [operationalDetail, setOperationalDetail] = useState<OperationalStatusDetail | null>(null);
  const clusterState = useBullpenEventClusters();
  const [claimNow, setClaimNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClaimNow(Date.now()), 30_000);
    const refresh = () => setClaimNow(Date.now());
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, []);
  const claimEvents = useMemo(() => applyClaimReturns(trends?.events ?? [], clusterState.rows, claimNow), [trends, clusterState.rows, claimNow]);
  const returnsEvent = claimEvents.find(event => event.market_id === returnsMarketId);
  const [showClusterJson, setShowClusterJson] = useState(false);
  const [clusterMode, setClusterMode] = useState<ClusterMode>(2);
  const [showStrongestOnly, setShowStrongestOnly] = useState(false);
  const operationalRuns = latestRuns ?? (page?.page === 1 ? page.items : []);
  const latestScoredScanAt = trends?.events.flatMap(event => event.scan_timestamps.map((timestamp, index) => event.scan_scores[index] == null ? null : timestamp)).find(Boolean) ?? null;
  const currentOddsUpdatedAt = trends?.current_odds_fetched_at ?? latestScoredScanAt ?? trends?.generated_at ?? null;
  const latestStage1 = findLatestOperationalStage(operationalRuns, "scan");
  const latestStage2 = findLatestOperationalStage(operationalRuns, "llm");
  const latestStage3 = findLatestOperationalStage(operationalRuns, "invest");
  const latestStage1Run = operationalRuns.find(run => run.stages.some(stage => stage.key === "scan" && stage.status !== "skipped")) ?? null;
  const clusteringStatus = formatClusteringStatus(
    clusterMetadata as ClusterMetadata,
    latestStage1?.completed_at,
  );
  const metadata = clusterMetadata as ClusterMetadata;
  const clusteringPending = clusteringStatus.startsWith("Pending since");
  const clusteringFailed = clusteringStatus.startsWith("Failed");
  const clusteringReason = clusteringFailed
    ? metadata.failure_reason || "The latest clustering attempt reported failure. No newer completed clustering metadata has been published."
    : clusteringPending
      ? `Stage 1 run ${latestStage1Run?.id ?? "—"} completed after the latest published clustering${metadata.source_run_id ? ` for run ${metadata.source_run_id}` : ""}. The clustering workflow has not yet published and deployed completed metadata for this scan.`
      : "The latest completed clustering metadata is deployed and matches the newest completed Stage 1 scan.";
  const rebalanceDisplay = formatHourlyRebalance(hourlyRebalanceStatus, hourlyRebalanceAt, lastRebalanceAt);
  const genericHandoffDetail = "Reported by the authenticated Hourly Bullpen Rebalance browser handoff.";
  const specificRebalanceDetail = hourlyRebalanceDetail && hourlyRebalanceDetail !== genericHandoffDetail
    ? hourlyRebalanceDetail
    : null;
  const rebalanceReason = hourlyRebalanceStatus === "failed"
    ? specificRebalanceDetail || "The latest hourly workflow reported failure without persisting a workflow-specific cause. The Cred-X runner fields below are included for diagnosis but may describe a separate process."
    : hourlyRebalanceStatus === "completed" || lastRebalanceAt
      ? hourlyRebalanceDetail || "The hourly workflow reported successful completion."
      : "No completed or failed hourly workflow result has been recorded yet.";
  return <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,.45)]">
    <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5"><div><p className="text-xs font-semibold uppercase tracking-[.22em] text-slate-500">{eyebrow}</p><h1 className="mt-2 text-xl font-semibold text-slate-950">{title}</h1><p className="mt-1 text-xs text-slate-500">{loading ? "Loading compact history…" : page ? `${page.total.toLocaleString("en-IN")} saved run${page.total === 1 ? "" : "s"}` : "History has not been loaded"}</p></div>
      <div className="flex flex-wrap justify-end gap-2">{showFullScreen && <Button variant="outline" onClick={() => window.open(fullScreenPath, "_blank", "noopener,noreferrer")}><ExternalLink className="mr-2 h-4 w-4" />Full Screen</Button>}<Button variant="outline" onClick={onRefresh} disabled={loading}><RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />Refresh</Button>{onClose && <Button variant="outline" size="icon" onClick={onClose} aria-label="Close Bullpen run history"><X className="h-4 w-4" /></Button>}</div>
    </header>
    <div className="max-h-[74vh] overflow-y-auto px-6 py-5">
      <section className="mb-5 overflow-hidden rounded-2xl border border-slate-200 bg-slate-50/70"><div className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-200 bg-white px-4 py-3"><div><h2 className="text-sm font-bold text-slate-950">Recurring Events Across the Last 20 Scans</h2><div className="mt-1 grid gap-x-6 gap-y-0.5 text-[11px] font-semibold text-slate-600 sm:grid-cols-2"><p>Latest Stage 1: {formatOperationalStage(latestStage1)}</p><button type="button" className="flex items-center gap-1 text-left underline decoration-dotted underline-offset-2 hover:text-blue-700" onClick={() => setOperationalDetail({ title: "Latest Stage 1 Clustering", status: clusteringStatus, timestampLabel: clusteringPending ? "Pending since" : clusteringFailed ? "Failed at" : "Completed at", timestamp: clusteringPending ? formatTime(latestStage1?.completed_at) : clusteringFailed ? formatTime(metadata.failed_at) : formatTime(metadata.completed_at), reason: clusteringReason, rows: [{ label: "Latest Stage 1 run", value: latestStage1Run?.id ?? "Not recorded" }, { label: "Latest published run", value: metadata.source_run_id ?? "Not recorded" }, { label: "Published source Stage 1", value: formatTime(metadata.source_stage1_completed_at) }, { label: "Published filtered count", value: metadata.filtered_count == null ? "Not recorded" : metadata.filtered_count.toLocaleString("en-IN") }, { label: "Published classification", value: metadata.counts ? `${metadata.counts.classified ?? "—"} classified · ${metadata.counts.unresolved ?? "—"} unresolved · ${metadata.counts.clusters ?? "—"} clusters` : "Not recorded" }] })}>Latest Stage 1 Clustering: {clusteringStatus}<Info className="h-3 w-3 shrink-0" /></button><p>Current Bullpen Odds fetched/updated: {formatOperationalTimestamp(currentOddsUpdatedAt)}</p><button type="button" className="flex items-center gap-1 text-left underline decoration-dotted underline-offset-2 hover:text-blue-700" onClick={() => setOperationalDetail({ title: "Latest Bullpen Rebalance", status: rebalanceDisplay, timestampLabel: hourlyRebalanceStatus === "failed" ? "Failed at" : "Recorded at", timestamp: formatTime(hourlyRebalanceAt ?? lastRebalanceAt), reason: rebalanceReason, rows: [{ label: "Reported status", value: hourlyRebalanceStatus ?? (lastRebalanceAt ? "completed (legacy)" : "Not recorded") }, { label: "Automation detail", value: specificRebalanceDetail || "No workflow-specific detail was recorded." }, { label: "Cred-X runner error (may be separate)", value: hourlyRebalanceLastError || "No runner error was recorded." }, { label: "Cred-X runner action (may be separate)", value: hourlyRebalanceLastAction || "No runner action was recorded." }, { label: "Legacy rebalance time", value: formatTime(lastRebalanceAt) }] })}>Latest Bullpen Rebalance: {rebalanceDisplay}<Info className="h-3 w-3 shrink-0" /></button><p>Latest Stage 2 LLM scan: {formatOperationalStage(latestStage2)}</p><p>Latest Stage 3 completion: {formatOperationalStage(latestStage3)}</p></div></div><div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setShowClusterJson(true)} className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-[10px] font-bold uppercase text-slate-600 hover:border-sky-400">Add Cluster json</button>
          <button type="button" aria-pressed={clusterMode !== 0} data-cluster-mode={clusterMode} title={clusterMode === 0 ? "All events. Click to group clusters." : clusterMode === 1 ? "Grouped clusters. Click to show only each cluster’s top event." : "Top event per cluster. Click to show all events."} onClick={() => setClusterMode(value => ((value + 1) % 3) as ClusterMode)} className={`rounded-full border px-3 py-1.5 text-[10px] font-bold uppercase transition-colors ${clusterMode === 2 ? "border-blue-800 bg-blue-800 text-white" : clusterMode === 1 ? "border-sky-300 bg-sky-200 text-sky-950" : "border-slate-300 bg-slate-100 text-slate-600"}`}>Cluster Top Events</button>
          <button type="button" role="switch" aria-checked={showStrongestOnly} onClick={() => setShowStrongestOnly(value => !value)} className={`rounded-full border px-3 py-1.5 text-[10px] font-bold uppercase transition-colors ${showStrongestOnly ? "border-violet-700 bg-violet-700 text-white" : "border-slate-300 bg-white text-slate-600 hover:border-violet-400 hover:text-violet-700"}`}>Strongest LLM odds ≥80%</button></div></div>
        {clusterState.error && <p role="alert" className="px-4 py-2 text-xs text-red-700">{clusterState.error}</p>}
        {clusterMode !== 0 && <p role="status" className="px-4 py-2 text-xs text-sky-800">{clusterMode === 1 ? "Grouped clusters" : "Top event per cluster"} · Highest Returns/day first · Assigned events with valid Current Odds and Returns/day{showStrongestOnly ? " · Strongest LLM filter is also on" : ""}</p>}
        {trendsLoading && !trends ? <div className="flex gap-2 p-4 text-xs"><Loader2 className="h-4 w-4 animate-spin" />Loading event trends…</div> : trendsError ? <p className="p-4 text-xs text-amber-800">{trendsError}</p> : trends?.events.length ? <BullpenEventTrendsTable events={claimEvents} clusters={clusterState.clusters} clusterMode={clusterMode} onClusterEdit={clusterState.edit} showStrongestOnly={showStrongestOnly} onScore={setScoreEvent} onLlm={setLlmQuestion} onClaimReturns={event => setReturnsMarketId(event.market_id)} onReturnsFormula={() => setShowReturnsFormula(true)} /> : <p className="p-4 text-xs text-slate-500">No events were covered in the latest 20 saved scans.</p>}
      </section>
      {error && !loading && <div className="mb-4 rounded-2xl bg-amber-50 p-4 text-sm text-amber-900">{error}</div>}
      {loading && !page?.items.length ? <div className="flex justify-center gap-2 p-8"><Loader2 className="h-4 w-4 animate-spin" />Loading saved Bullpen runs…</div> : <div className="space-y-3">{page?.items.map(run => <button key={run.id} onClick={() => onOpenRun(run)} disabled={detailLoadingId != null} className="w-full rounded-2xl border bg-slate-50 p-4 text-left hover:bg-blue-50"><div className="flex justify-between gap-3"><div><div className="flex flex-wrap gap-2"><span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800">{run.triggered_by === "scheduler" ? "Auto Run" : "Manual Run"}</span><span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold capitalize">{run.status}</span><span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-bold">{formatTime(run.started_at)}</span></div><p className="mt-2 text-sm font-semibold">{run.summary || "Run summary unavailable."}</p><p className="mt-1 text-xs text-slate-600">Run {run.id}</p></div>{detailLoadingId === run.id && <Loader2 className="h-4 w-4 animate-spin" />}</div><div className="mt-3 flex flex-wrap gap-2">{run.stages.map(stage => <span key={`${stage.key}-${stage.stage_number}`} className="rounded-full border bg-white px-2.5 py-1 text-[11px] font-semibold">{stage.label}: {stage.status}</span>)}</div></button>)}</div>}
      {page && page.pages > 1 && <div className="mt-5 flex items-center justify-between border-t pt-4"><Button variant="outline" disabled={loading || page.page <= 1} onClick={() => onPage(page.page - 1)}>Previous</Button><span className="text-xs font-semibold">Page {page.page} of {page.pages}</span><Button variant="outline" disabled={loading || !page.has_next} onClick={() => onPage(page.page + 1)}>Next</Button></div>}
    </div>{showClusterJson && <BullpenClusterJsonDialog rows={clusterState.rows} marketIds={new Set(trends?.events.map(event => event.market_id) ?? [])} onApply={clusterState.save} onClose={() => setShowClusterJson(false)} />}{scoreEvent && <ScoreCalculation event={scoreEvent} onClose={() => setScoreEvent(null)} />}{llmQuestion && <BullpenLlmBreakdownDialog question={llmQuestion} onClose={() => setLlmQuestion(null)} />}{(returnsEvent || showReturnsFormula) && <BullpenClaimReturnsDialog event={returnsEvent} onClose={() => { setReturnsMarketId(null); setShowReturnsFormula(false); }} />}{operationalDetail && <OperationalStatusDialog detail={operationalDetail} onClose={() => setOperationalDetail(null)} />}
  </div>;
}

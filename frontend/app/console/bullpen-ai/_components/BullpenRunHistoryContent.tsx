"use client";

import { useState } from "react";
import { ExternalLink, Loader2, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createBullpenQuestionRow, type BullpenQuestionRow } from "@/lib/bullpen-ai";
import { formatApiTimestamp } from "@/lib/datetime";
import type { BullpenAutoLiveEventTrend, BullpenAutoLiveEventTrendsResponse, BullpenAutoLiveHistoryItem, BullpenAutoLiveHistoryPage } from "@/types/api";
import { BullpenInvestmentMathDialog } from "./BullpenInvestmentMathDialog";
import { BullpenLlmBreakdownDialog } from "./BullpenLlmBreakdownDialog";
import { BullpenEventTrendsTable } from "./BullpenEventTrendsTable";
import { BullpenReturnsPerDayFormulaDialog } from "./BullpenReturnsPerDayInfo";

const formatTime = (value?: string | null) => formatApiTimestamp(value, { emptyValue: "—", timeZone: "Asia/Kolkata", timeZoneName: "short", second: "2-digit" });

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

export type BullpenRunHistoryContentProps = {
  page: BullpenAutoLiveHistoryPage | null; trends: BullpenAutoLiveEventTrendsResponse | null;
  loading: boolean; trendsLoading: boolean; error: string | null; trendsError: string | null;
  detailLoadingId?: string | null; onRefresh: () => void; onPage: (page: number) => void;
  onOpenRun: (run: BullpenAutoLiveHistoryItem) => void; onClose?: () => void; showFullScreen?: boolean;
  eyebrow?: string; title?: string; fullScreenPath?: string;
  loadReturnsFormula?: () => Promise<string>;
  saveReturnsFormula?: (formula: string) => Promise<string>;
};

export function BullpenRunHistoryContent({ page, trends, loading, trendsLoading, error, trendsError, detailLoadingId, onRefresh, onPage, onOpenRun, onClose, showFullScreen = true, eyebrow = "Run History", title = "Bullpen Auto and Manual Runs", fullScreenPath = "/console/bullpen-ai/history", loadReturnsFormula, saveReturnsFormula }: BullpenRunHistoryContentProps) {
  const [scoreEvent, setScoreEvent] = useState<BullpenAutoLiveEventTrend | null>(null);
  const [llmQuestion, setLlmQuestion] = useState<BullpenQuestionRow | null>(null);
  const [returnsQuestion, setReturnsQuestion] = useState<BullpenQuestionRow | null>(null);
  const [showReturnsFormula, setShowReturnsFormula] = useState(false);
  const [showStrongestOnly, setShowStrongestOnly] = useState(true);
  const latestScoredScanAt = trends?.events.flatMap(event => event.scan_timestamps ?? []).find(Boolean) ?? null;
  const latestSavedRunAt = page?.page === 1 ? page.items[0]?.started_at ?? null : null;
  const currentOddsUpdatedAt = trends?.current_odds_fetched_at ?? latestScoredScanAt ?? trends?.generated_at ?? null;
  return <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,.45)]">
    <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5"><div><p className="text-xs font-semibold uppercase tracking-[.22em] text-slate-500">{eyebrow}</p><h1 className="mt-2 text-xl font-semibold text-slate-950">{title}</h1><p className="mt-1 text-xs text-slate-500">{loading ? "Loading compact history…" : page ? `${page.total.toLocaleString("en-IN")} saved run${page.total === 1 ? "" : "s"}` : "History has not been loaded"}</p></div>
      <div className="flex flex-wrap justify-end gap-2">{showFullScreen && <Button variant="outline" onClick={() => window.open(fullScreenPath, "_blank", "noopener,noreferrer")}><ExternalLink className="mr-2 h-4 w-4" />Full Screen</Button>}<Button variant="outline" onClick={onRefresh} disabled={loading}><RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />Refresh</Button>{onClose && <Button variant="outline" size="icon" onClick={onClose} aria-label="Close Bullpen run history"><X className="h-4 w-4" /></Button>}</div>
    </header>
    <div className="max-h-[74vh] overflow-y-auto px-6 py-5">
      <section className="mb-5 overflow-hidden rounded-2xl border border-slate-200 bg-slate-50/70"><div className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-200 bg-white px-4 py-3"><div><h2 className="text-sm font-bold text-slate-950">Recurring Events Across the Last 20 Scans</h2><p className="mt-0.5 text-[11px] text-slate-500">Latest scan is leftmost. Score = latest + 0.5 × previous + 0.25 × third-latest.</p><p className="mt-1 text-[11px] font-semibold text-slate-600">Latest saved run: {formatTime(latestSavedRunAt ?? latestScoredScanAt ?? trends?.generated_at)}{latestScoredScanAt ? <> · Latest scored LLM scan: {formatTime(latestScoredScanAt)}</> : null}</p>{currentOddsUpdatedAt ? <p className="mt-0.5 text-[11px] font-semibold text-slate-600">Current Bullpen Odds fetched/updated: {formatTime(currentOddsUpdatedAt)}</p> : null}</div><div className="flex items-center gap-3"><button type="button" role="switch" aria-checked={showStrongestOnly} onClick={() => setShowStrongestOnly(value => !value)} className={`rounded-full border px-3 py-1.5 text-[10px] font-bold uppercase transition-colors ${showStrongestOnly ? "border-violet-700 bg-violet-700 text-white" : "border-slate-300 bg-white text-slate-600 hover:border-violet-400 hover:text-violet-700"}`}>Strongest LLM odds ≥80%</button><span className="text-[10px] font-semibold uppercase text-slate-500">Grey = not covered / no valid LLM score</span></div></div>
        {trendsLoading && !trends ? <div className="flex gap-2 p-4 text-xs"><Loader2 className="h-4 w-4 animate-spin" />Loading event trends…</div> : trendsError ? <p className="p-4 text-xs text-amber-800">{trendsError}</p> : trends?.events.length ? <BullpenEventTrendsTable events={trends.events} showStrongestOnly={showStrongestOnly} onScore={setScoreEvent} onLlm={setLlmQuestion} onReturns={setReturnsQuestion} onReturnsFormula={() => setShowReturnsFormula(true)} /> : <p className="p-4 text-xs text-slate-500">No events were covered in the latest 20 saved scans.</p>}
      </section>
      {error && !loading && <div className="mb-4 rounded-2xl bg-amber-50 p-4 text-sm text-amber-900">{error}</div>}
      {loading && !page?.items.length ? <div className="flex justify-center gap-2 p-8"><Loader2 className="h-4 w-4 animate-spin" />Loading saved Bullpen runs…</div> : <div className="space-y-3">{page?.items.map(run => <button key={run.id} onClick={() => onOpenRun(run)} disabled={detailLoadingId != null} className="w-full rounded-2xl border bg-slate-50 p-4 text-left hover:bg-blue-50"><div className="flex justify-between gap-3"><div><div className="flex flex-wrap gap-2"><span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800">{run.triggered_by === "scheduler" ? "Auto Run" : "Manual Run"}</span><span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold capitalize">{run.status}</span><span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-bold">{formatTime(run.started_at)}</span></div><p className="mt-2 text-sm font-semibold">{run.summary || "Run summary unavailable."}</p><p className="mt-1 text-xs text-slate-600">Run {run.id}</p></div>{detailLoadingId === run.id && <Loader2 className="h-4 w-4 animate-spin" />}</div><div className="mt-3 flex flex-wrap gap-2">{run.stages.map(stage => <span key={`${stage.key}-${stage.stage_number}`} className="rounded-full border bg-white px-2.5 py-1 text-[11px] font-semibold">{stage.label}: {stage.status}</span>)}</div></button>)}</div>}
      {page && page.pages > 1 && <div className="mt-5 flex items-center justify-between border-t pt-4"><Button variant="outline" disabled={loading || page.page <= 1} onClick={() => onPage(page.page - 1)}>Previous</Button><span className="text-xs font-semibold">Page {page.page} of {page.pages}</span><Button variant="outline" disabled={loading || !page.has_next} onClick={() => onPage(page.page + 1)}>Next</Button></div>}
    </div>{scoreEvent && <ScoreCalculation event={scoreEvent} onClose={() => setScoreEvent(null)} />}{llmQuestion && <BullpenLlmBreakdownDialog question={llmQuestion} onClose={() => setLlmQuestion(null)} />}{returnsQuestion && <BullpenInvestmentMathDialog focus="returnsPerDay" question={returnsQuestion} onClose={() => setReturnsQuestion(null)} />}{showReturnsFormula && <BullpenReturnsPerDayFormulaDialog loadFormula={loadReturnsFormula} saveFormula={saveReturnsFormula} onClose={() => setShowReturnsFormula(false)} />}
  </div>;
}

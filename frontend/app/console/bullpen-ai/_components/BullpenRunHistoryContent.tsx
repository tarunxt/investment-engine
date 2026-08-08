"use client";

import { useState } from "react";
import { Check, ExternalLink, Loader2, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createBullpenQuestionRow, type BullpenQuestionRow } from "@/lib/bullpen-ai";
import { formatApiTimestamp } from "@/lib/datetime";
import type { BullpenAutoLiveEventTrend, BullpenAutoLiveEventTrendsResponse, BullpenAutoLiveHistoryItem, BullpenAutoLiveHistoryPage } from "@/types/api";
import { BullpenInvestmentMathDialog } from "./BullpenInvestmentMathDialog";
import { BullpenLlmBreakdownDialog } from "./BullpenLlmBreakdownDialog";

const formatTime = (value?: string | null) => formatApiTimestamp(value, { emptyValue: "—", timeZone: "Asia/Kolkata", timeZoneName: "short", second: "2-digit" });
const odds = (value?: number | null) => value == null ? "—" : `${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`;
const color = (score: number | null) => {
  if (score === null) return "rgb(203 213 225)";
  const clamped = Math.max(0, Math.min(100, score));
  const [start, end, progress] = clamped <= 65 ? [[244,166,160],[255,255,255],(clamped-50)/15] : [[255,255,255],[82,183,126],(clamped-65)/35];
  const p = Math.max(0, Math.min(1, progress));
  return `rgb(${start.map((v, i) => Math.round(v + (end[i] - v) * p)).join(" ")})`;
};

const trendQuestion = (event: BullpenAutoLiveEventTrend): BullpenQuestionRow => createBullpenQuestionRow({
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
  daysUntilClose: null,
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
};

export function BullpenRunHistoryContent({ page, trends, loading, trendsLoading, error, trendsError, detailLoadingId, onRefresh, onPage, onOpenRun, onClose, showFullScreen = true }: BullpenRunHistoryContentProps) {
  const [scoreEvent, setScoreEvent] = useState<BullpenAutoLiveEventTrend | null>(null);
  const [llmQuestion, setLlmQuestion] = useState<BullpenQuestionRow | null>(null);
  const [returnsQuestion, setReturnsQuestion] = useState<BullpenQuestionRow | null>(null);
  return <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,.45)]">
    <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5"><div><p className="text-xs font-semibold uppercase tracking-[.22em] text-slate-500">Run History</p><h1 className="mt-2 text-xl font-semibold text-slate-950">Bullpen Auto and Manual Runs</h1><p className="mt-1 text-xs text-slate-500">{loading ? "Loading compact history…" : page ? `${page.total.toLocaleString("en-IN")} saved run${page.total === 1 ? "" : "s"}` : "History has not been loaded"}</p></div>
      <div className="flex flex-wrap justify-end gap-2">{showFullScreen && <Button variant="outline" onClick={() => window.open("/console/bullpen-ai/history", "_blank", "noopener,noreferrer")}><ExternalLink className="mr-2 h-4 w-4" />Full Screen</Button>}<Button variant="outline" onClick={onRefresh} disabled={loading}><RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />Refresh</Button>{onClose && <Button variant="outline" size="icon" onClick={onClose} aria-label="Close Bullpen run history"><X className="h-4 w-4" /></Button>}</div>
    </header>
    <div className="max-h-[74vh] overflow-y-auto px-6 py-5">
      <section className="mb-5 overflow-hidden rounded-2xl border border-slate-200 bg-slate-50/70"><div className="flex items-end justify-between gap-4 border-b border-slate-200 bg-white px-4 py-3"><div><h2 className="text-sm font-bold text-slate-950">Recurring Events Across the Last 20 Scans</h2><p className="mt-0.5 text-[11px] text-slate-500">Latest scan is leftmost. Score = latest + 0.5 × previous + 0.25 × third-latest.</p><p className="mt-1 text-[11px] font-semibold text-slate-600">Latest run: {formatTime(trends?.events.flatMap(e => e.scan_timestamps ?? []).find(Boolean) ?? trends?.generated_at)}</p></div><span className="text-[10px] font-semibold uppercase text-slate-500">Grey = not covered</span></div>
        {trendsLoading && !trends ? <div className="flex gap-2 p-4 text-xs"><Loader2 className="h-4 w-4 animate-spin" />Loading event trends…</div> : trendsError ? <p className="p-4 text-xs text-amber-800">{trendsError}</p> : trends?.events.length ? <div className="overflow-x-auto px-4 py-2"><div className="min-w-[88rem]">
          <div className="grid grid-cols-[minmax(20rem,1fr)_6rem_10rem_10rem_8rem_25rem] gap-3 border-b px-1 pb-2 text-[10px] font-bold uppercase text-slate-500"><span>Event</span><span className="text-right">Score</span><span>Current Odds</span><span>LLM Odds</span><span>Returns/day</span><span>20 scans · newest to oldest</span></div>
          {trends.events.map((event, rowIndex) => <div key={event.market_id} className={`grid grid-cols-[minmax(20rem,1fr)_6rem_10rem_10rem_8rem_25rem] items-center gap-3 border-b px-1 py-1.5 ${rowIndex === 9 ? "border-b-4 border-b-red-500" : "border-slate-200/70"}`}><span className="flex min-w-0 items-center gap-2">{event.is_active_position && <span className="flex w-5 shrink-0 flex-col items-center text-emerald-700"><Check className="h-4 w-4 stroke-[3]" aria-label="Active Bullpen position" /><span className="text-[8px] font-bold leading-none">{event.active_position_side === "YES" ? "Yes" : event.active_position_side === "NO" ? "No" : "—"}</span></span>}{event.market_url ? <a className="truncate text-xs font-semibold hover:text-sky-700 hover:underline" title={event.market_title} href={event.market_url} target="_blank" rel="noreferrer">{event.market_title}</a> : <span className="truncate text-xs font-semibold" title={event.market_title}>{event.market_title}</span>}</span><button className="text-right text-xs font-bold underline decoration-dotted" onClick={() => setScoreEvent(event)}>{event.score.toFixed(2)}</button><span className="text-xs font-semibold">Yes {odds(event.current_yes_odds)}<br/>No {odds(event.current_no_odds)}</span><button type="button" className="text-left text-xs font-semibold text-violet-700 underline decoration-violet-300 underline-offset-2" onClick={() => setLlmQuestion(trendQuestion(event))} aria-label={`Open LLM odds breakdown for ${event.market_title}`}>Yes {odds(event.llm_yes_odds)}<br/>No {odds(event.llm_no_odds)}</button><button type="button" className="text-left text-xs font-bold underline decoration-dotted" disabled={event.returns_per_day == null} onClick={() => setReturnsQuestion(trendQuestion(event))} aria-label={`Show Returns/day calculation for ${event.market_title}`}>{odds(event.returns_per_day)}</button><span className="flex gap-1">{event.scan_scores.map((score, i) => { const side = event.scan_sides?.[i]; return <span key={i} title={score == null ? `Scan ${i + 1}: not covered` : `${formatTime(event.scan_timestamps?.[i])} · Strongest LLM side: ${side ?? "—"} · ${score.toFixed(2)}%`} className={`relative flex h-4 w-4 items-center justify-center rounded-full border ${score != null && score >= 80 ? "border-[1.5px] border-black" : "border-slate-900/10"}`} style={{ backgroundColor: color(score) }}>{score != null && side === "YES" ? <Check className="h-2.5 w-2.5 stroke-[4] text-blue-600" /> : score != null && side === "NO" ? <X className="h-2.5 w-2.5 stroke-[4] text-red-600" /> : null}</span>})}</span></div>)}
        </div></div> : <p className="p-4 text-xs text-slate-500">No events were covered in the latest 20 saved scans.</p>}
      </section>
      {error && !loading && <div className="mb-4 rounded-2xl bg-amber-50 p-4 text-sm text-amber-900">{error}</div>}
      {loading && !page?.items.length ? <div className="flex justify-center gap-2 p-8"><Loader2 className="h-4 w-4 animate-spin" />Loading saved Bullpen runs…</div> : <div className="space-y-3">{page?.items.map(run => <button key={run.id} onClick={() => onOpenRun(run)} disabled={detailLoadingId != null} className="w-full rounded-2xl border bg-slate-50 p-4 text-left hover:bg-blue-50"><div className="flex justify-between gap-3"><div><div className="flex flex-wrap gap-2"><span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800">{run.triggered_by === "scheduler" ? "Auto Run" : "Manual Run"}</span><span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold capitalize">{run.status}</span><span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-bold">{formatTime(run.started_at)}</span></div><p className="mt-2 text-sm font-semibold">{run.summary || "Run summary unavailable."}</p><p className="mt-1 text-xs text-slate-600">Run {run.id}</p></div>{detailLoadingId === run.id && <Loader2 className="h-4 w-4 animate-spin" />}</div><div className="mt-3 flex flex-wrap gap-2">{run.stages.map(stage => <span key={stage.key} className="rounded-full border bg-white px-2.5 py-1 text-[11px] font-semibold">{stage.label}: {stage.status}</span>)}</div></button>)}</div>}
      {page && page.pages > 1 && <div className="mt-5 flex items-center justify-between border-t pt-4"><Button variant="outline" disabled={loading || page.page <= 1} onClick={() => onPage(page.page - 1)}>Previous</Button><span className="text-xs font-semibold">Page {page.page} of {page.pages}</span><Button variant="outline" disabled={loading || !page.has_next} onClick={() => onPage(page.page + 1)}>Next</Button></div>}
    </div>{scoreEvent && <ScoreCalculation event={scoreEvent} onClose={() => setScoreEvent(null)} />}{llmQuestion && <BullpenLlmBreakdownDialog question={llmQuestion} onClose={() => setLlmQuestion(null)} />}{returnsQuestion && <BullpenInvestmentMathDialog focus="returnsPerDay" question={returnsQuestion} onClose={() => setReturnsQuestion(null)} />}
  </div>;
}

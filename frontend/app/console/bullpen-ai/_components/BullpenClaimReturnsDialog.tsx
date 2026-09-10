"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { CLAIM_RETURNS_FORMULA, type claimReturns } from "@/lib/bullpen-claim-returns";
import { formatApiTimestamp } from "@/lib/datetime";

type Event = ReturnType<typeof claimReturns> & { market_title: string };
export function BullpenClaimReturnsDialog({ event, onClose }: { event?: Event; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} onCancel={onClose} aria-labelledby="claim-returns-title"
    className="m-auto w-[min(44rem,95vw)] rounded-2xl border border-slate-200 bg-white p-6 text-slate-950 shadow-2xl backdrop:bg-slate-950/55">
    <div className="flex justify-between gap-4"><h2 id="claim-returns-title" className="text-lg font-bold">Returns/day calculation</h2><button aria-label="Close Returns/day calculation" onClick={onClose}><X className="h-5 w-5" /></button></div>
    {event && <h3 className="mt-3 font-semibold">{event.market_title}</h3>}
    <p className="mt-4 rounded-xl bg-slate-50 p-4 font-mono text-sm">{CLAIM_RETURNS_FORMULA}</p>
    <p className="mt-3 text-sm">Days left for claim = (Claim date − now) / 24 hours. The calculation uses fractional days without rounding or a four-day buffer.</p>
    <p className="mt-3 text-sm text-slate-600">Claim date is a best guess, not a guaranteed payout time. A missing or expired estimate makes Returns/day unavailable until refreshed. Claimable positions also show no projected return.</p>
    <p className="mt-3 text-sm text-slate-600">When LLM odds are unavailable, the stronger current market side is used.</p>
    {event && <dl className="mt-5 space-y-3 text-sm">
      <div><dt className="text-slate-500">Claim date (estimated)</dt><dd className="font-semibold">{formatApiTimestamp(event.claim_date, { emptyValue: "Unavailable" })}</dd></div>
      <div><dt className="text-slate-500">Calculated at</dt><dd>{formatApiTimestamp(event.calculated_at)}</dd></div>
      <div><dt className="text-slate-500">Side used</dt><dd>{event.current_side ?? "Unavailable"} · {event.side_source}</dd></div>
      <div><dt className="text-slate-500">Days left for claim</dt><dd>{event.days_left_for_claim?.toFixed(6) ?? "Unavailable"}</dd></div>
      <div><dt className="text-slate-500">Actual calculation</dt><dd className="font-mono font-semibold">{event.returns_per_day == null ? "Unavailable" : `(100 - ${event.current_odds}) / ${event.days_left_for_claim?.toFixed(6)} = ${event.returns_per_day.toFixed(2)}%`}</dd></div>
    </dl>}
  </dialog>;
}

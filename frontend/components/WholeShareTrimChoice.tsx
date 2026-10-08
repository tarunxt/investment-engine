import type { WholeShareChoice } from "@/lib/wholeShareReview";

export function WholeShareTrimChoice({ symbol, choice, onChoose, locked = false }: { symbol: string; choice: WholeShareChoice; onChoose: (choice: "keep" | "exit") => void; locked?: boolean }) {
  return <fieldset disabled={locked} className="min-w-0 max-w-sm space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 [overflow-wrap:anywhere] disabled:opacity-70">
    <legend className="px-1 font-semibold">⚠ Whole-share review for {symbol}</legend>
    <p>A 50% trim of one share cannot be sold as a whole share. Default: no order.</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" aria-pressed={choice === "keep"} onClick={() => onChoose("keep")} className="rounded border border-slate-400 bg-white px-3 py-2 text-slate-950 focus-visible:outline-2 focus-visible:outline-blue-700">Keep position · no order</button>
      <button type="button" aria-pressed={choice === "exit"} onClick={() => onChoose("exit")} className="rounded border border-red-400 bg-white px-3 py-2 text-red-950 focus-visible:outline-2 focus-visible:outline-blue-700">Review full exit · sell 1 share</button>
    </div>
    <p role="status">{locked ? "Choices locked while submission is in progress or recorded. Check the submission status." : choice === "exit" ? "Full exit reviewed. Requires separate row selection before order review." : choice === "keep" ? "Keep position chosen. This row cannot create an order." : "Choice required. This row cannot create an order."}</p>
  </fieldset>;
}

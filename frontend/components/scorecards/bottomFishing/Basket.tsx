"use client";
import {useState} from "react";
import {createPortal} from "react-dom";
import {X} from "lucide-react";
import {renderBasketAllocation} from "@/components/BasketAllocationTable";
import {BasketDraftUnits} from "@/components/BasketDraftUnits";
import {BasketResizeHandles} from "@/components/BasketResizeHandles";
import {useReviewDialog} from "@/hooks/useReviewDialog";
import {formatBasketDisplayCurrency as money} from "@/lib/basketDisplayCalculations";
import {editableDraftAmount} from "@/lib/basketEditableDraft";
import {date, num, type Output} from "./model";

const columns = ["Stock", "Decision", "Score /100", "Buy price ₹", "Breakout ₹", "Max buy ₹",
  "Qty", "Amount ₹", "Stop ₹", "Target ₹", "Return", "Net R/R"];

function potentialReturn(price?: number, target?: number) {
  if (price == null || target == null || !Number.isFinite(price) || !Number.isFinite(target) || price <= 0 || target <= 0) return "—";
  return ((target - price) / price).toLocaleString("en-IN", {style:"percent", minimumFractionDigits:2, maximumFractionDigits:2});
}

export function Basket({output,owner,onClose}:{output:Output;owner:number;onClose:()=>void}) {
  const dialog = useReviewDialog<HTMLDivElement>(true, onClose);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const {state, settings} = output;
  const rows = (state.rows ?? []).map(row => {
    const strategyQty = row.qty ?? 0;
    const qty = Number(edits[row.symbol] ?? strategyQty);
    return {...row, strategyQty, qty, amount:qty === 0 ? 0 : editableDraftAmount(qty, row.price ?? null)};
  });
  const total = (draft: boolean) => rows.reduce<number | null>((sum, row) => {
    const amount = draft ? row.amount : row.strategyQty === 0 ? 0 : editableDraftAmount(row.strategyQty, row.price ?? null);
    return sum == null || amount == null ? null : sum + amount;
  }, 0);
  const selected = total(true);
  const recommended = total(false);
  const selectedCount = rows.filter(row => row.qty > 0).length;
  const recommendedCount = rows.filter(row => row.strategyQty > 0).length;
  const capital = settings?.capital;
  const assets = capital == null ? null : capital + (state.realized ?? 0);
  const held = Object.values(state.positions ?? {}).reduce((sum, position) => sum + position.qty * position.price, 0);
  const allocation = (buys: number | null) => ({
    investments:buys == null ? null : held + buys,
    cash:assets == null || buys == null ? null : assets - held - buys,
  });
  function changeQty(symbol: string, value: string) {
    if (/^\d*$/.test(value) && Number.isSafeInteger(Number(value))) {
      setEdits(previous => ({...previous, [symbol]:value}));
    }
  }

  return createPortal(<div className="basket-review-backdrop" onClick={onClose}>
    <div {...dialog} role="dialog" aria-modal="true" aria-label="Bottom Fishing Final Basket" className="basket-review-panel" onClick={event => event.stopPropagation()}>
      <BasketResizeHandles panelRef={dialog.ref} owner={owner}/>
      <div className="basket-review-layout">
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 p-5">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.35em] text-slate-400">Bottom Fishing · {output.mode}</div>
            <h3 className="mt-2 text-xl font-bold text-slate-950">Bottom Fishing Final Basket</h3>
            {output.finished_at && <p className="mt-2 text-xs font-semibold text-slate-600">Run #{output.request_id} · Saved {date(output.finished_at)} IST</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close Bottom Fishing basket preview" className="rounded-full border border-slate-200 p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><X className="size-5"/></button>
        </header>
        <div role="region" aria-label="Bottom Fishing basket, scroll to inspect" tabIndex={0} className="basket-review-content">
          <div className="sticky left-5 pt-3">
            {renderBasketAllocation(allocation(0), allocation(recommended), allocation(selected), assets, "INR")}
            <div className="mb-5 grid gap-3 md:grid-cols-2">
              <section className="rounded-2xl border border-emerald-100 bg-emerald-50 p-4">
                <h4 className="text-xs font-bold uppercase tracking-wide text-emerald-700">Buy Basket</h4>
                <p className="mt-2 text-2xl font-black text-emerald-950" aria-label="Preview basket amount">{money(selected)}</p>
                <p className="mt-2 text-sm text-emerald-900">{selectedCount} selected · {recommendedCount} sized by the strategy</p>
              </section>
              <section className="rounded-2xl border border-violet-200 bg-violet-50 p-4">
                <h4 className="text-xs font-bold uppercase tracking-wide text-violet-700">Paper portfolio</h4>
                <p className="mt-2 text-sm">Assigned capital <strong>{money(capital)}</strong></p>
                <p className="mt-1 text-xs text-slate-600">Holdings at entry cost · Preview amounts before fees</p>
                <p className="mt-1 text-xs text-slate-600">Market data {date(state.market_as_of ?? state.at)} IST</p>
              </section>
            </div>
            {state.status === "partial" && <p className="mb-3 text-sm text-amber-800">Partial coverage. Decisions use the available market data.</p>}
            {state.error && <p role="alert" className="mb-3 text-sm text-red-700">{state.error}</p>}
            <h4 className="mb-2 text-lg font-bold text-slate-900">Basket decisions</h4>
          </div>
          <div className="basket-preview-scroll mb-5 w-max min-w-full rounded-2xl border border-slate-200">
            <table aria-label="Bottom Fishing basket decisions" className="tabular-nums">
              <thead><tr>{columns.map(column => <th scope="col" className="whitespace-nowrap" key={column}
                title={column === "Return" ? "(Target − Buy price) / Buy price, before fees" : undefined}>{column}</th>)}</tr></thead>
              <tbody>
                {rows.map(row => <tr key={row.symbol} className="whitespace-nowrap bg-white text-slate-700">
                  <td className="font-bold text-slate-950">{row.symbol}</td>
                  <td><span className={'rounded-full px-3 py-1 text-xs font-bold ' + (row.strategyQty > 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-700')}>{row.reason}</span></td>
                  <td className="font-semibold text-slate-800">{num(row.score)}</td>
                  <td>{num(row.price)}</td><td>{num(row.breakout)}</td><td>{num(row.max_buy)}</td>
                  <td><BasketDraftUnits symbol={row.symbol} action="Buy" units={row.qty}
                    onChange={value => changeQty(row.symbol, String(value))}>
                    <input aria-label={row.symbol + " preview Qty"} inputMode="numeric" pattern="[0-9]*" autoComplete="off"
                      className="w-16 bg-transparent py-2 text-center text-inherit focus-visible:outline-blue-600"
                      value={edits[row.symbol] ?? row.strategyQty} onFocus={event => event.currentTarget.select()}
                      onChange={event => changeQty(row.symbol, event.target.value)}
                      onBlur={() => { if (edits[row.symbol] !== undefined) changeQty(row.symbol, String(row.qty)); }}/>
                  </BasketDraftUnits></td>
                  <td>{money(row.amount)}</td><td>{num(row.stop)}</td><td>{num(row.target)}</td>
                  <td>{potentialReturn(row.price, row.target)}</td><td>{num(row.rr)}</td>
                </tr>)}
                {!rows.length && <tr><td colSpan={columns.length} className="text-slate-500">{state.error ? "No final basket was produced." : state.at ? "No entry qualified in this run." : "Awaiting the first completed run."}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-5 py-3 text-sm">
          <p><strong>{selectedCount} selected</strong> · Edits apply to this preview only.</p>
          <button type="button" className="rounded-full border border-slate-200 px-4 py-2 font-semibold text-blue-700 disabled:text-slate-400"
            disabled={!Object.keys(edits).length} onClick={() => { dialog.ref.current?.focus(); setEdits({}); }}>Reset quantities</button>
        </footer>
      </div>
    </div></div>, document.body);
}

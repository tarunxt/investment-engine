"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DEFAULT_MAXIMUM_STOCKS, parseMaximumStocks, defaultPortfolioParameters, displayPortfolioParameter, editPortfolioParameter, stepPortfolioParameter, type PortfolioParameterKey } from "@/lib/portfolioParameters";

type Props = { currency: "INR" | "USD"; portfolioValue: number | null; availableMargin: number | null; totalAssets: number | null; capturedAt: string | null };
const labels: Record<PortfolioParameterKey, string> = { cash: "Min Cash in Portfolio", max: "Max Weight per Stock", normalised: "Normalised Max Weight per Stock" };
export function PortfolioParametersTile(props: Props) {
  const [open, setOpen] = useState(false);
  const [pastDays, setPastDays] = useState("5");
  const pastDaysInvalid = parseMaximumStocks(pastDays) === null;
  const [maximumStocks, setMaximumStocks] = useState(DEFAULT_MAXIMUM_STOCKS);
  const [maximumStocksDraft, setMaximumStocksDraft] = useState<string | null>(null);
  const maximumStocksInvalid = maximumStocksDraft !== null && parseMaximumStocks(maximumStocksDraft) === null;
  const [parameters, setParameters] = useState(defaultPortfolioParameters);
  const [draft, setDraft] = useState<{ key: PortfolioParameterKey; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => { opener?.focus(); };
  }, [open]);
  const money = (value: number | null) => value === null ? "Unavailable" : new Intl.NumberFormat("en-IN", { style: "currency", currency: props.currency }).format(value);
  const commit = (result: ReturnType<typeof editPortfolioParameter>) => {
    if (!result.state) { setError(result.error); return; }
    setParameters(result.state); setDraft(null); setError(null);
  };
  return <>
    <button type="button" onClick={() => setOpen(true)} className="rounded-2xl border border-violet-200 bg-violet-50 p-4 text-left focus:outline-none focus:ring-2 focus:ring-violet-500" aria-haspopup="dialog">
      <span className="block text-xs font-bold uppercase tracking-wide text-violet-800">Portfolio Parameters</span>
      <span className="mt-2 block text-sm text-violet-950">Min Cash {displayPortfolioParameter(parameters, "cash").text}% · Max Weight {displayPortfolioParameter(parameters, "max").text}%</span>
    </button>
    {open ? createPortal(<div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="portfolio-parameters-title" className="fixed inset-0 z-[90] flex items-center justify-center overflow-auto bg-slate-950/55 p-4" onClick={event => { event.stopPropagation(); setOpen(false); }} onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); }
      if (event.key === "Tab") {
        const nodes = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? []), first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first?.focus(); }
      }
    }}><div className="max-h-[85vh] w-full max-w-lg overflow-auto rounded-2xl bg-white p-5 shadow-2xl" onClick={event => event.stopPropagation()}>
      <div className="flex items-center justify-between gap-3"><h2 id="portfolio-parameters-title" className="text-xl font-bold">Portfolio Parameters</h2><button type="button" onClick={() => setOpen(false)} aria-label="Close Portfolio Parameters" className="rounded border px-3 py-2">Close</button></div>
      <p className="mt-2 text-sm text-slate-600">Fields only. These values do not change basket selections, allocations, thresholds, or orders.</p>
      <div className="mt-5"><label htmlFor="portfolio-maximum-stocks" className="font-semibold">Maximum Stocks</label>
        <input id="portfolio-maximum-stocks" type="number" inputMode="numeric" min="1" step="1" value={maximumStocksDraft ?? maximumStocks} aria-invalid={maximumStocksInvalid} aria-describedby={maximumStocksInvalid ? "portfolio-maximum-stocks-error" : undefined} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2" onChange={event => { const value = event.target.value; setMaximumStocksDraft(value); const parsed = parseMaximumStocks(value); if (parsed !== null) setMaximumStocks(parsed); }} onBlur={() => { if (!maximumStocksInvalid) setMaximumStocksDraft(null); }} />
        {maximumStocksInvalid ? <p id="portfolio-maximum-stocks-error" role="alert" className="mt-1 text-sm text-red-700">Enter a positive whole number of stocks.</p> : null}
      </div>
      <div className="mt-5 space-y-4">{(Object.keys(labels) as PortfolioParameterKey[]).map(key => {
        const display = displayPortfolioParameter(parameters, key);
        return <div key={key}><label htmlFor={`portfolio-parameter-${key}`} className="font-semibold">{labels[key]}</label><div className="mt-1 flex overflow-hidden rounded-lg border border-slate-300"><input id={`portfolio-parameter-${key}`} type="number" inputMode="decimal" min="0" max="100" step="0.01" value={draft?.key === key ? draft.value : display.text} aria-describedby="portfolio-parameter-formula" aria-invalid={Boolean(error && draft?.key === key)} className="min-w-0 flex-1 appearance-textfield px-3 py-2 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" onBlur={() => { if (!error) setDraft(null); }} onChange={event => { const value = event.target.value; setDraft({ key, value }); const result = editPortfolioParameter(parameters, key, value); if (result.state) { setParameters(result.state); setError(null); } else setError(result.error); }} /><span className="self-center px-2">%</span><div className="flex flex-col border-l"><button type="button" aria-label={`Increase ${labels[key]}`} className="px-3" onClick={() => commit(stepPortfolioParameter(parameters, key, 1))}>▲</button><button type="button" aria-label={`Decrease ${labels[key]}`} className="px-3" onClick={() => commit(stepPortfolioParameter(parameters, key, -1))}>▼</button></div></div>{display.rounded ? <p className="mt-1 text-xs text-slate-500">Shown rounded; the full calculated value is retained.</p> : null}</div>;
      })}</div>
      <div className="mt-4"><label htmlFor="portfolio-history-days" className="font-semibold">Past days considered for Weighted Score</label><div className="mt-1 flex items-center gap-2"><input id="portfolio-history-days" type="number" inputMode="numeric" min="1" step="1" value={pastDays} aria-invalid={pastDaysInvalid} className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2" onChange={event => setPastDays(event.target.value)} /><span>Days</span></div>{pastDaysInvalid ? <p role="alert" className="mt-1 text-sm text-red-700">Enter a positive whole number of days.</p> : null}</div>
      <p id="portfolio-parameter-formula" className="mt-4 text-sm text-slate-600">Normalised Max Weight = (1 − Min Cash / 100) × Max Weight. At 100% Min Cash, Normalised Max Weight is 0% and Max Weight is retained.</p>
      {error ? <p role="alert" className="mt-3 text-sm text-red-700">{error}</p> : null}
      <dl className="mt-5 space-y-3 rounded-xl bg-slate-50 p-4">{[["Portfolio Value", props.portfolioValue], ["Available Margin", props.availableMargin], ["Total Assets", props.totalAssets]].map(([label, value]) => <div key={String(label)} className="flex flex-wrap justify-between gap-2"><dt>{label}</dt><dd className="font-semibold">{money(value as number | null)}</dd></div>)}</dl>
      <p className="mt-3 text-xs text-slate-500">{props.currency} · {props.capturedAt ? `Selected portfolio snapshot: ${props.capturedAt}` : "Selected portfolio snapshot unavailable"}. Available Margin matches the Buy Basket tile.</p>
    </div></div>, document.body) : null}
  </>;
}

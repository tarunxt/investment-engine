"use client";

import { useMemo, useState } from "react";
import { X } from "lucide-react";

import { buildTradingViewChartUrl, type TradingViewMarket } from "@/lib/tradingview";
import { cn } from "@/lib/utils";

export type TradingViewUrlListItem = {
  symbol: string;
  market: TradingViewMarket;
  exchange?: string | null;
};

function TradingViewLogoIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 512 512" aria-hidden="true" className={className}>
      <rect width="512" height="512" rx="96" fill="white" />
      <path fill="currentColor" d="M54 141h144v183h72V141h-72v72H54z" />
      <circle cx="252" cy="176" r="36" fill="currentColor" />
      <path fill="currentColor" d="M323 141h135L382 324H247z" />
    </svg>
  );
}

export function TradingViewUrlListButton({
  items,
  title,
  ariaLabel,
  className,
}: {
  items: TradingViewUrlListItem[];
  title: string;
  ariaLabel: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const urls = useMemo(() => {
    const seen = new Set<string>();
    return items.flatMap((item) => {
      const url = buildTradingViewChartUrl(item);
      if (!url || seen.has(url)) return [];
      seen.add(url);
      return [url];
    });
  }, [items]);
  const copyText = urls.join("\n");

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-blue-100 bg-white text-blue-600 shadow-sm transition hover:border-blue-300 hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500",
          className,
        )}
        aria-label={ariaLabel}
        title={ariaLabel}
      >
        <TradingViewLogoIcon className="size-6" />
      </button>

      {open ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-sm" onClick={() => setOpen(false)}>
          <div className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 p-5">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.25em] text-blue-500">TradingView URLs</div>
                <h3 className="mt-2 text-xl font-bold text-slate-950">{title}</h3>
                <p className="mt-1 text-sm text-slate-500">{urls.length} URL{urls.length === 1 ? "" : "s"}, one per line and ready to copy.</p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-full border border-slate-200 p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                aria-label="Close TradingView URLs popup"
              >
                <X className="size-5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-5">
              <textarea
                readOnly
                value={copyText}
                className="min-h-[20rem] w-full resize-y rounded-2xl border border-slate-200 bg-slate-50 p-4 font-mono text-sm leading-6 text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                onFocus={(event) => event.currentTarget.select()}
                aria-label={`${title} TradingView URL list`}
              />
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

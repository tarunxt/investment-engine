import { resolveIexBasketDisplay, isIexQuoteStale } from '@/lib/alpacaIexDisplay';
import type { IexDisplayState } from '@/lib/alpacaIexDisplaySession';
import { formatCompactQuoteTime } from '@/lib/datetime';

/** Returns only a display cell. Never exposes a price to basket arithmetic or readiness. */
export function alpacaIexBasketCell(state: IexDisplayState, symbol: string, exchange: string, now: number) {
  const { listing, quote, reason } = resolveIexBasketDisplay(state.listings, state.result, symbol, exchange);
  const identity = listing ? `${listing.instrument} · ${listing.listing_mic} · ${listing.share_class} · ${listing.security_id} · Alpaca symbol ${listing.vendor_symbol}` : reason;
  const loading = state.loading;
  return <td className="whitespace-nowrap px-4 py-3 text-slate-700" data-provider="alpaca-iex" title={`${quote && isIexQuoteStale(quote, now) ? "Older IEX last trade · " : ""}${identity} · IEX only; partial market coverage. Display only, not used for executable sizing or order approval.`}>
    {quote ? <>
      <div>{new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(quote.price)}</div>
      <time dateTime={quote.as_of} className="block text-[10px] text-slate-500">{formatCompactQuoteTime(quote.as_of)}</time>
    </> : <><span>{loading ? 'Loading…' : 'Unavailable'}</span><span className="block text-[10px] text-slate-500">{loading ? 'Checking verified last trades' : state.error ?? reason}</span></>}
  </td>;
}

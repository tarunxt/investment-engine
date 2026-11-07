'use client';

import { formatPortfolioTimestamp } from '@/lib/portfolioTimestamp';
import { isIexQuoteStale } from '@/lib/alpacaIexDisplay';
import { useAlpacaIexDisplay } from '@/hooks/useAlpacaIexDisplay';
import { AlpacaIexDisplayControls } from '@/components/AlpacaIexDisplayControls';

export function AlpacaIexDisplayPanel() {
  const state = useAlpacaIexDisplay();
  const { listings, result, now } = state;
  const quoted = new Map(result?.quotes.map((item) => [item.instrument, item]));
  const missing = new Map(result?.missing.map((item) => [item.instrument, item.reason]));

  return (
    <section aria-labelledby="alpaca-iex-heading" className="rounded-md border border-gray-200 bg-white p-4">
      <h2 id="alpaca-iex-heading" className="font-semibold text-gray-950">Alpaca IEX display estimates</h2>
      <p className="mt-1 text-sm text-gray-700">IEX only, not consolidated US market LTP. These estimates are separate from the saved portfolio snapshot and are not used to approve orders.</p>
      <p className="mt-1 text-sm text-gray-600">Only account-bound, verified configured listings appear here. This is not a statement of portfolio coverage or current wallet balance.</p>
      <AlpacaIexDisplayControls state={state} />
      <p className="mb-3 text-sm text-gray-600">{listings.length} verified configured listings · {result?.quotes.length ?? 0} available IEX last trades</p>
      {listings.length ? <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Verified IEX display estimates">
        <table className="w-full text-left text-sm">
          <thead><tr><th scope="col" className="p-2">Verified listing</th><th scope="col" className="p-2">Share class and security ID</th><th scope="col" className="p-2">IEX estimate (USD)</th><th scope="col" className="p-2">Source trade time</th><th scope="col" className="p-2">Freshness and availability</th></tr></thead>
          <tbody>{listings.map((listing) => {
            const quote = quoted.get(listing.instrument);
            return <tr key={listing.instrument} className="border-t border-gray-100">
              <th scope="row" className="p-2">{listing.instrument}<span className="block font-normal text-gray-600">Listing MIC {listing.listing_mic} · Alpaca symbol {listing.vendor_symbol}</span></th>
              <td className="p-2">{listing.share_class}<span className="block text-gray-600">{listing.security_id}</span></td>
              <td className="p-2">{quote ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(quote.price) : '—'}</td>
              <td className="p-2">{quote ? <><time dateTime={quote.as_of}>{formatPortfolioTimestamp(quote.as_of)}</time><span className="block text-gray-600">Received {formatPortfolioTimestamp(quote.received_at)}</span></> : 'Unavailable'}</td>
              <td className="p-2">{quote ? <><strong>{isIexQuoteStale(quote, now) ? 'Stale IEX last trade' : 'IEX last trade within 120 seconds'}</strong><span className="block text-gray-600">{quote.session === 'regular_hours_time_window_unverified_calendar' ? 'Regular-hours time window; holiday calendar unverified' : 'Outside regular-hours time window'}</span></> : missing.get(listing.instrument) ?? 'Not requested'}</td>
            </tr>;
          })}</tbody>
        </table>
      </div> : null}
    </section>
  );
}

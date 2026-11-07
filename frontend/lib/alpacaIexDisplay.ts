/** Display provenance only. This module never joins quotes to saved portfolio values. */
export type VerifiedIexListing = {
  instrument: string;
  symbol: string;
  listing_mic: string;
  share_class: string;
  security_id: string;
  vendor_symbol: string;
  currency: 'USD';
  verified: true;
};

export type IexDisplayQuote = VerifiedIexListing & {
  price: number;
  as_of: string;
  received_at: string;
  stale: boolean;
  session: 'regular_hours_time_window_unverified_calendar' | 'outside_regular_hours_time_window';
};

export type IexDisplayResult = {
  quotes: IexDisplayQuote[];
  missing: { instrument: string; reason: string }[];
};

const MIC: Record<string, string> = { NASDAQ: 'XNAS', NYSE: 'XNYS', NYSEARCA: 'ARCX', NYSEAMERICAN: 'XASE' };
const identityFields = ['instrument', 'symbol', 'listing_mic', 'share_class', 'security_id', 'vendor_symbol', 'currency'] as const;
const invalid = () => new Error('IEX estimates are unavailable because verified source metadata could not be validated.');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

export function parseIexListings(value: unknown): { listings: VerifiedIexListing[]; reason: string | null } {
  if (!record(value) || !Array.isArray(value.listings) || value.listings.length > 50) throw invalid();
  const instruments = new Set<string>();
  const vendors = new Set<string>();
  const listings = value.listings.map((item) => {
    if (!record(item) || !identityFields.every((field) => text(item[field])) || item.verified !== true || item.currency !== 'USD') throw invalid();
    const instrument = item.instrument as string;
    const match = /^(NASDAQ|NYSE|NYSEARCA|NYSEAMERICAN):([A-Z0-9.-]{1,24})$/.exec(instrument);
    if (!match || item.symbol !== match[2] || item.listing_mic !== MIC[match[1]] || !/^[A-Z0-9.-]{1,24}$/.test(item.vendor_symbol as string)) throw invalid();
    if (instruments.has(instrument) || vendors.has(item.vendor_symbol as string)) throw invalid();
    instruments.add(instrument);
    vendors.add(item.vendor_symbol as string);
    return Object.fromEntries([...identityFields.map((field) => [field, item[field]]), ['verified', true]]) as VerifiedIexListing;
  });
  return { listings, reason: text(value.reason) ? value.reason : listings.length ? null : 'Verified US listings are not configured for this account.' };
}

function instant(value: unknown): number {
  if (!text(value) || !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) throw invalid();
  const stamp = Date.parse(value);
  if (!Number.isFinite(stamp) || stamp <= 0) throw invalid();
  return stamp;
}

export function parseIexDisplay(value: unknown, listings: VerifiedIexListing[], now: number): IexDisplayResult {
  if (!Number.isFinite(now) || !record(value) || value.provider !== 'Alpaca' || value.feed !== 'iex' || !Array.isArray(value.quotes) || !Array.isArray(value.missing)) throw invalid();
  const identities = new Map(listings.map((item) => [item.instrument, item]));
  const seen = new Set<string>();
  const quotes = value.quotes.map((item) => {
    if (!record(item) || !text(item.instrument)) throw invalid();
    const listing = identities.get(item.instrument);
    if (!listing || seen.has(item.instrument) || identityFields.some((field) => item[field] !== listing[field])) throw invalid();
    if (item.provider !== 'Alpaca' || item.feed !== 'iex' || item.eligible_for_readiness !== false || typeof item.stale !== 'boolean') throw invalid();
    if (typeof item.price !== 'number' || !Number.isFinite(item.price) || item.price <= 0) throw invalid();
    const traded = instant(item.as_of);
    const received = instant(item.received_at);
    if (traded > now || traded > received || received > now + 10_000) throw invalid();
    if (item.session !== 'regular_hours_time_window_unverified_calendar' && item.session !== 'outside_regular_hours_time_window') throw invalid();
    seen.add(item.instrument);
    return { ...listing, price: item.price, as_of: item.as_of as string, received_at: item.received_at as string, stale: item.stale || now - traded > 120_000, session: item.session } as IexDisplayQuote;
  });
  const missing = value.missing.map((item) => {
    if (!record(item) || !text(item.instrument) || !identities.has(item.instrument) || !text(item.reason) || seen.has(item.instrument)) throw invalid();
    seen.add(item.instrument);
    return { instrument: item.instrument, reason: item.reason };
  });
  for (const listing of listings) {
    if (!seen.has(listing.instrument)) missing.push({ instrument: listing.instrument, reason: 'No valid IEX last trade was returned.' });
  }
  return { quotes, missing };
}

export function isIexQuoteStale(quote: IexDisplayQuote, now: number): boolean {
  const age = now - Date.parse(quote.as_of);
  return quote.stale || !Number.isFinite(age) || age < 0 || age > 120_000;
}

/** Reviewed account-bound metadata is the identity bridge, never ticker-only inference.
 * The source row must supply the exact configured exchange and symbol. The quote
 * must also match every stable listing identity field. No snapshot-price fallback.
 */
export function resolveIexBasketDisplay(listings: VerifiedIexListing[], result: IexDisplayResult | null, symbol: string, exchange: string) {
  const instrument = `${exchange}:${symbol}`;
  const matches = listings.filter(item => item.instrument === instrument && item.symbol === symbol && item.verified === true);
  const listing = matches.length === 1 ? matches[0] : null;
  if (!listing) return { listing: null, quote: null, reason: 'No verified identity mapping for this exact listing.' };
  const quotes = result?.quotes.filter(item => item.instrument === instrument) ?? [];
  if (quotes.length === 1 && quotes[0].verified === true && identityFields.every(field => quotes[0][field] === listing[field])) {
    return { listing, quote: quotes[0], reason: null };
  }
  return { listing, quote: null, reason: quotes.length ? 'Quote identity did not match the verified listing.' : result?.missing.find(item => item.instrument === instrument)?.reason ?? 'IEX estimates not requested for this listing.' };
}

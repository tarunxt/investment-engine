import type { VerifiedIexListing } from './alpacaIexDisplay';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const amount = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** The caller supplies the same owner's USD-only INDmoney snapshot. The basket's
 * exact venue-qualified identity is resolved first. Its reviewed listing then
 * supplies the exact broker symbol; duplicates or aliases never resolve a match.
 */
export function indmoneyBasketHolding(snapshot: unknown, listing: VerifiedIexListing | null, listings: VerifiedIexListing[]) {
  const unavailable = (reason: string) => ({ investedAmount: null, currentValue: null, sourceAsOf: null, unavailableReason: reason });
  if (!listing) return unavailable('No verified identity mapping for this exact basket listing.');
  if (!record(snapshot) || snapshot.parse_status !== 'parsed' || !Array.isArray(snapshot.holdings)
    || snapshot.holdings_count !== snapshot.holdings.length || (snapshot.reported_holdings_count !== null && snapshot.reported_holdings_count !== snapshot.holdings.length)
    || typeof snapshot.captured_at !== 'string' || !Number.isFinite(Date.parse(snapshot.captured_at))
    || ('currency' in snapshot && snapshot.currency !== 'USD')) {
    return unavailable('A complete saved holdings snapshot is required for this stock’s current value and invested amount.');
  }
  if (listings.filter(item => item.symbol === listing.symbol && item.verified === true).length !== 1) {
    return unavailable('The reviewed listing does not identify one unique broker symbol.');
  }
  const matches = snapshot.holdings.filter(item => record(item) && item.symbol === listing.symbol);
  if (matches.length > 1) return unavailable('Duplicate holdings for this exact listing; invested amount is ambiguous.');
  if (matches.length === 1) {
    const holding = matches[0] as Record<string, unknown>;
    return { investedAmount: amount(holding.invested_value), currentValue: amount(holding.current_value), sourceAsOf: snapshot.captured_at,
      unavailableReason: amount(holding.invested_value) === null || amount(holding.current_value) === null ? 'The saved holding is missing a valid invested amount or current value.' : null };
  }
  const instruments = new Set<string>();
  const allExact = snapshot.holdings.every(item => {
    if (!record(item) || typeof item.symbol !== 'string' || instruments.has(item.symbol)) return false;
    instruments.add(item.symbol);
    return listings.filter(candidate => candidate.verified === true && candidate.symbol === item.symbol).length === 1;
  });
  if (!allExact || snapshot.reported_holdings_count !== snapshot.holdings.length || !Array.isArray(snapshot.parse_warnings) || snapshot.parse_warnings.length || (!snapshot.holdings.length && snapshot.current_value !== 0)) {
    return unavailable('No unique reviewed holding match, or the saved snapshot cannot prove that this stock is not held.');
  }
  return { investedAmount: 0, currentValue: 0, sourceAsOf: snapshot.captured_at, unavailableReason: null };
}

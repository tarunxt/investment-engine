import type { ZerodhaDisplayQuoteResponse } from "@/types/api";

/** Quotes stay venue-specific; a same-symbol listing cannot substitute. */
export function technicalPriceEvidence(instruments: string[], result: ZerodhaDisplayQuoteResponse, now = Date.now()) {
  if (!Number.isFinite(now)) throw new Error('Quote validation time is unavailable; Technical validation did not start.');
  if (!result || !Array.isArray(result.quotes)) throw new Error('Malformed broker quote response; Technical validation did not start.');
  const requested = [...new Set(instruments)];
  const anchors = requested.map(instrument => {
    const matches = result.quotes.filter(quote => quote?.instrument === instrument);
    if (matches.length !== 1) throw new Error(`Missing or ambiguous broker quote for ${instrument}.`);
    const quote = matches[0];
    const age = now - Date.parse(quote.as_of);
    const stopped = 'Technical validation has not started; this attempt cannot produce final actionables. Review the exact-listing quote before retrying. No scan or order was started by this price check.';
    if (!(quote.price > 0) || !Number.isFinite(quote.price)) {
      throw new Error(`Invalid broker price for ${instrument}: expected a finite positive price. ${stopped}`);
    }
    if (!Number.isFinite(age)) {
      throw new Error(`Invalid broker quote timestamp for ${instrument}: no usable quote time was returned. ${stopped}`);
    }
    if (age < -60000) {
      throw new Error(`Future-dated broker quote for ${instrument}: quote time ${quote.as_of}; validation time ${new Date(now).toISOString()}; ahead by ${(-age / 1000).toFixed(3)} seconds (maximum 60 seconds). ${stopped}`);
    }
    if (age > 900000) {
      throw new Error(`Stale broker quote for ${instrument}: quote time ${quote.as_of}; validation time ${new Date(now).toISOString()}; age ${(age / 1000).toFixed(3)} seconds (maximum 900 seconds / 15 minutes). ${stopped}`);
    }
    return { instrument, price: quote.price, as_of: quote.as_of, source: quote.source };
  });
  return `\n\n[TECHNICAL_PRICE_ANCHORS_V1]\n${JSON.stringify(anchors)}\n[/TECHNICAL_PRICE_ANCHORS_V1]\nUse these exact-venue broker prices as the common price basis. Check corporate actions and adjusted charts. Trigger and invalidation must be numeric levels on this basis and within 25% of the anchor; if evidence cannot be reconciled, do not invent a setup. Unreconciled output is rejected.\n`;
}

/** Only a confirmed market-data entitlement denial permits research-only mode.
 * Authentication, transport and quote-integrity failures still stop the stage.
 */
export async function resolveTechnicalPriceEvidence(
  instruments: string[],
  readQuotes: (instruments: string[]) => Promise<ZerodhaDisplayQuoteResponse>,
  now?: number,
): Promise<string> {
  let result: ZerodhaDisplayQuoteResponse;
  try {
    result = await readQuotes(instruments);
  } catch (error) {
    const failure = error as { status?: number; message?: string } | null;
    if (failure?.status !== 403 || !failure.message?.includes("Zerodha denied market-data access (PermissionException)")) {
      throw error;
    }
    return `\n\n[TECHNICAL_PRICE_MODE_V1]internet_research_no_broker_quotes[/TECHNICAL_PRICE_MODE_V1]\nKite market-data permission is unavailable. Continue the technical internet research requested above using fresh exact-exchange sources. No broker price anchors were supplied: do not describe researched prices as broker-verified or live Kite quotes. Check source dates and corporate actions; do not invent prices or setups when evidence is unavailable.\n`;
  }
  // Default clock is read after the response, not before network latency.
  // Explicit time remains available for deterministic fixtures.
  return technicalPriceEvidence(instruments, result, now ?? Date.now());
}

import type { ZerodhaDisplayQuoteResponse } from "@/types/api";

/** Quotes stay venue-specific; a same-symbol listing cannot substitute. */
export function technicalPriceEvidence(instruments: string[], result: ZerodhaDisplayQuoteResponse, now = Date.now()) {
  const requested = [...new Set(instruments)];
  const anchors = requested.map(instrument => {
    const matches = result.quotes.filter(quote => quote.instrument === instrument);
    if (matches.length !== 1) throw new Error(`Missing or ambiguous broker quote for ${instrument}.`);
    const quote = matches[0];
    const age = now - Date.parse(quote.as_of);
    if (!(quote.price > 0) || !Number.isFinite(quote.price) || !Number.isFinite(age) || age < -60000 || age > 900000) {
      throw new Error(`Invalid or stale broker quote for ${instrument}; refresh before Technical validation.`);
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
  now = Date.now(),
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
  return technicalPriceEvidence(instruments, result, now);
}

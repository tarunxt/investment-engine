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

const BULLPEN_EVENT_BASE_URL =
  "https://app.bullpen.fi/predictions/polymarket/event";
const BULLPEN_LINK_RESOLVER_PATH = "/api/bullpen-ai/market-link";
export const BULLPEN_REFERRAL_CODE = "intrepid-crane-3";

export type BullpenCanonicalMarketLink = {
  marketId: string;
  eventSlug: string;
  marketSlug?: string | null;
  outcome?: "Yes" | "No";
};

function requireNonEmpty(value: string, field: string) {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} is required to build a Bullpen market URL.`);
  }
  return normalized;
}

/**
 * Browser-facing event-name link. The resolver looks up the canonical
 * Polymarket event + market slugs before redirecting to Bullpen, because the
 * legacy /predictions/market/:id route now returns 404 for these markets.
 */
export function buildBullpenMarketUrl(marketId: string) {
  const normalizedMarketId = requireNonEmpty(marketId, "marketId");
  const params = new URLSearchParams();
  params.set("marketId", normalizedMarketId);
  return `${BULLPEN_LINK_RESOLVER_PATH}?${params.toString()}`;
}

/** Build the canonical Bullpen Polymarket event URL used after resolution. */
export function buildBullpenCanonicalMarketUrl({
  marketId,
  eventSlug,
  marketSlug,
  outcome = "Yes",
}: BullpenCanonicalMarketLink) {
  const normalizedMarketId = requireNonEmpty(marketId, "marketId");
  const normalizedEventSlug = requireNonEmpty(eventSlug, "eventSlug");
  const normalizedMarketSlug = marketSlug?.trim() || null;
  const url = new URL(
    `${BULLPEN_EVENT_BASE_URL}/${encodeURIComponent(normalizedEventSlug)}`,
  );

  // Preserve the parameter shape Bullpen itself emits for Polymarket markets.
  if (normalizedMarketSlug) {
    url.searchParams.set("marketSlug", normalizedMarketSlug);
  }
  url.searchParams.set("outcome", outcome);
  url.searchParams.set("ref", BULLPEN_REFERRAL_CODE);
  url.searchParams.set("marketId", normalizedMarketId);
  return url.toString();
}

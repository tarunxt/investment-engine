import type { ClusterAssignment } from "./bullpen-event-clusters";

export const CLAIM_RETURNS_FORMULA_VERSION = "history-claim-date-v1";
export const CLAIM_RETURNS_FORMULA = "(100 - current odds on strongest LLM side) / days left for claim";
type ClaimEvent = {
  market_id: string;
  current_yes_odds?: number | null;
  current_no_odds?: number | null;
  llm_yes_odds?: number | null;
  llm_no_odds?: number | null;
  is_claimable_position?: boolean;
  returns_per_day?: number | null;
};
const validOdds = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;

export function claimReturns(event: ClaimEvent, claimDate: string | null | undefined, now: number) {
  const days = (Date.parse(claimDate ?? "") - now) / 86_400_000;
  const hasLlm = validOdds(event.llm_yes_odds) && validOdds(event.llm_no_odds);
  const side = hasLlm
    ? event.llm_yes_odds! >= event.llm_no_odds! ? "Yes" : "No"
    : validOdds(event.current_yes_odds) && validOdds(event.current_no_odds)
      ? event.current_yes_odds >= event.current_no_odds ? "Yes" : "No"
      : null;
  const currentOdds = side === "Yes" ? event.current_yes_odds : side === "No" ? event.current_no_odds : null;
  const result = !event.is_claimable_position && Number.isFinite(days) && days > 0 && validOdds(currentOdds)
    ? (100 - currentOdds) / days : null;
  return {
    formula_version: CLAIM_RETURNS_FORMULA_VERSION,
    claim_date: claimDate ?? null,
    calculated_at: new Date(now).toISOString(),
    days_left_for_claim: Number.isFinite(days) ? days : null,
    current_side: side,
    current_odds: currentOdds ?? null,
    side_source: hasLlm ? "Strongest LLM side" : "Strongest current side (LLM unavailable)",
    returns_per_day: result !== null && Number.isFinite(result) ? result : null,
  };
}

export function applyClaimReturns<T extends ClaimEvent>(events: T[], assignments: ClusterAssignment[], now: number) {
  const claims = new Map(assignments
    .filter(row => row.claim_date !== undefined)
    .map(row => [row.market_id, row.claim_date ?? null] as const));
  return events.map(event => {
    const claimDate = claims.get(event.market_id);
    // An explicit null is a researched "unavailable" estimate and must clear a
    // stale backend projection. Legacy three-field rows still preserve the
    // History API's authoritative Returns/day.
    if (claims.has(event.market_id)) return { ...event, ...claimReturns(event, claimDate, now) };
    const sourceReturn = typeof event.returns_per_day === "number" && Number.isFinite(event.returns_per_day)
      ? event.returns_per_day : null;
    return { ...event, ...claimReturns(event, null, now), returns_per_day: sourceReturn };
  });
}

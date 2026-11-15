import {
  isActiveBullpenPosition,
  isClaimableBullpenPosition,
  type BullpenActivePositionView,
} from "@/lib/bullpenPositions";

const VALUE_EPSILON = 0.000001;
const TERMINAL_PRICE_EPSILON = 0.0005;
const OPEN_STATUS_PATTERN =
  /\b(?:open|active|live|trading|unresolved|pending)\b/i;
const RESOLVED_STATUS_PATTERN =
  /\b(?:won|resolved|closed|expired|settled|redeemed|claimable|redeemable|final)\b/i;

function hasPositiveExposure(position: BullpenActivePositionView) {
  return (
    position.shares > VALUE_EPSILON &&
    ((position.currentValue ?? 0) > VALUE_EPSILON ||
      (position.currentPrice ?? 0) > VALUE_EPSILON)
  );
}

function hasNonTerminalLivePrice(position: BullpenActivePositionView) {
  const price = position.currentPrice;
  return (
    typeof price === "number" &&
    Number.isFinite(price) &&
    price > VALUE_EPSILON &&
    price < 1 - TERMINAL_PRICE_EPSILON
  );
}

/**
 * History/portfolio display semantics intentionally follow the current wallet.
 *
 * The execution classifier is conservative around a passed event date. That can
 * quarantine or mark as claimable a still-open Bullpen contract when its stated
 * date has passed but Bullpen continues to hold/trade it (for example a market
 * awaiting official resolution). For the console, a positive wallet holding is
 * still an active position when Bullpen explicitly says it is open, or when the
 * held token still has a non-terminal live price and there is no explicit
 * resolution status.
 *
 * This helper is display-only. It does not weaken execution/claim safeguards.
 */
export function isBullpenHistoryActivePosition(
  position: BullpenActivePositionView,
) {
  if (isActiveBullpenPosition(position)) return true;
  if (!hasPositiveExposure(position)) return false;

  const status = position.resolutionStatus?.trim() || "";
  const explicitlyResolved = RESOLVED_STATUS_PATTERN.test(status);
  if (explicitlyResolved) return false;

  return OPEN_STATUS_PATTERN.test(status) || hasNonTerminalLivePrice(position);
}

export function isBullpenHistoryClaimablePosition(
  position: BullpenActivePositionView,
) {
  return (
    isClaimableBullpenPosition(position) &&
    !isBullpenHistoryActivePosition(position)
  );
}

export function sumBullpenHistoryPortfolioPositionValue(
  positions: BullpenActivePositionView[],
) {
  return positions.reduce((total, position) => {
    if (isBullpenHistoryActivePosition(position)) {
      return total + Math.max(0, position.currentValue ?? 0);
    }
    if (isBullpenHistoryClaimablePosition(position)) {
      return (
        total +
        Math.max(
          0,
          position.claimableValue ??
            position.expectedPayoutUsd ??
            position.currentValue ??
            0,
        )
      );
    }
    return total;
  }, 0);
}

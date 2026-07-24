import {
  calculateBullpenPositionReturnsPerDay,
  type BullpenActivePositionView,
} from "./bullpenPositions";
import type { BullpenAutoLiveRun } from "@/types/api";

const ACTIVE_CLASSIFICATION = "active";

export type VerifiedBullpenStage1Portfolio = {
  runId: string;
  verifiedAt: string | null;
  activePositions: BullpenActivePositionView[];
  cashInHandUsd: number | null;
  occupiedPositions: number;
  availableSlots: number | null;
  maxPositions: number | null;
  tradeAmountUsd: number | null;
};

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "claimable", "redeemable"].includes(
    value.trim().toLowerCase(),
  );
}

function round(value: number, digits: number) {
  return Number(value.toFixed(digits));
}

function centsToPrice(value: number | null) {
  if (value === null) return null;
  return value > 1 ? value / 100 : value;
}

function readVerifiedPosition(value: unknown): BullpenActivePositionView | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const classification = readString(row.classification);
  if (
    (classification && classification !== ACTIVE_CLASSIFICATION) ||
    readBoolean(row.is_claimable ?? row.isClaimable)
  ) {
    return null;
  }

  const marketId = readString(row.market_id);
  const marketTitle =
    readString(row.market_title) ?? readString(row.question);
  if (!marketId || !marketTitle) return null;

  const rawSide = readString(row.side)?.toUpperCase() ?? "—";
  const heldSide = rawSide === "YES" || rawSide === "NO" ? rawSide : null;
  const shares = Math.max(0, readNumber(row.shares) ?? 0);
  const averagePrice = centsToPrice(readNumber(row.average_price_cents));
  const currentYesOdds = readNumber(row.current_yes_odds);
  const currentNoOdds = readNumber(row.current_no_odds);
  const currentPrice =
    centsToPrice(readNumber(row.current_price_cents)) ??
    centsToPrice(heldSide === "YES" ? currentYesOdds : heldSide === "NO" ? currentNoOdds : null);
  const costBasis =
    readNumber(row.exposure_usd) ??
    (averagePrice !== null ? shares * averagePrice : 0);
  const currentValue =
    readNumber(row.current_value_usd) ??
    (currentPrice !== null ? shares * currentPrice : null);
  const unrealizedPnl =
    currentValue === null ? null : currentValue - costBasis;
  const unrealizedPnlPercent =
    costBasis > 0 && unrealizedPnl !== null
      ? (unrealizedPnl / costBasis) * 100
      : null;
  const closeTime = readString(row.close_time);

  return {
    key:
      readString(row.position_key) ??
      `${marketId}::${heldSide ?? rawSide}`,
    marketId,
    slug: readString(row.slug),
    conditionId: readString(row.condition_id),
    marketTitle,
    outcome: rawSide,
    heldSide,
    shares: round(shares, 4),
    averagePrice: averagePrice === null ? null : round(averagePrice, 4),
    costBasis: round(costBasis, 2),
    yesOdds: currentYesOdds,
    noOdds: currentNoOdds,
    bestBidPrice: null,
    bestAskPrice: null,
    currentPrice: currentPrice === null ? null : round(currentPrice, 4),
    currentValue: currentValue === null ? null : round(currentValue, 2),
    expectedPayoutUsd: readNumber(
      row.expected_payout_usdc ?? row.expected_payout_usd,
    ),
    unrealizedPnl:
      unrealizedPnl === null ? null : round(unrealizedPnl, 2),
    unrealizedPnlPercent:
      unrealizedPnlPercent === null ? null : round(unrealizedPnlPercent, 2),
    marketUrl: readString(row.market_url),
    closeTime,
    resolutionStatus: readString(row.resolution_status),
    economicClassification: "active",
    classificationReason:
      readString(row.classification_reason) ??
      "Verified as economically active by the latest completed Stage 1 Bullpen scan.",
    isClaimable: false,
    claimableSignal: false,
    upstreamRedeemable: readBoolean(row.upstream_redeemable),
    claimableValue: readNumber(row.claimable_value_usd),
    returnsPerDay: calculateBullpenPositionReturnsPerDay({
      closeTime,
      currentPrice,
    }),
    rules: null,
    marketContext: readString(row.theme),
    resolutionSource: "verified-stage1-scan",
  };
}

function timestampMs(value: string | null) {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

export function shouldUseVerifiedStage1PortfolioFallback({
  hasActivePositionsSnapshot,
  verifiedPortfolio,
}: {
  hasActivePositionsSnapshot: boolean;
  verifiedPortfolio: VerifiedBullpenStage1Portfolio | null;
}) {
  return !hasActivePositionsSnapshot && verifiedPortfolio !== null;
}

/**
 * Stage 1 and the portfolio panel historically used separate wallet reads. A
 * completed Stage 1 snapshot is the worker-verified source used by Stage 2/3,
 * so the console must reconcile its portfolio count and slot preview to it.
 */
export function resolveLatestVerifiedStage1Portfolio(
  runs: Array<BullpenAutoLiveRun | null | undefined>,
): VerifiedBullpenStage1Portfolio | null {
  const seenRunIds = new Set<string>();
  const candidates: Array<{
    order: number;
    run: BullpenAutoLiveRun;
    stage: BullpenAutoLiveRun["stage_results"][number];
    outputs: Record<string, unknown>;
    verifiedAt: string | null;
  }> = [];

  runs.forEach((run, order) => {
    if (!run || seenRunIds.has(run.id)) return;
    seenRunIds.add(run.id);
    const stages = [...(run.stage_results ?? [])].reverse();
    const stage = stages.find((candidate) => {
      const outputs = candidate.outputs;
      if (!outputs || typeof outputs !== "object") return false;
      const workflowKey = readString(outputs.workflow_stage_key);
      const phaseStatus = readString(outputs.phase_status);
      const isStageOne = candidate.stage_number === 1 || workflowKey === "scan";
      const isComplete =
        Boolean(candidate.completed_at) ||
        phaseStatus === "completed" ||
        phaseStatus === "partial" ||
        (!phaseStatus &&
          (candidate.status === "pass" || candidate.status === "warning"));
      return (
        isStageOne &&
        isComplete &&
        Array.isArray(outputs.active_positions_found)
      );
    });
    if (!stage || !stage.outputs || typeof stage.outputs !== "object") return;
    candidates.push({
      order,
      run,
      stage,
      outputs: stage.outputs,
      verifiedAt:
        stage.completed_at ?? run.completed_at ?? stage.started_at ?? run.started_at,
    });
  });

  candidates.sort((left, right) => {
    const timestampDelta =
      timestampMs(right.verifiedAt) - timestampMs(left.verifiedAt);
    return timestampDelta || left.order - right.order;
  });
  const latest = candidates[0];
  if (!latest) return null;

  const activePositions = (
    latest.outputs.active_positions_found as unknown[]
  )
    .map(readVerifiedPosition)
    .filter((position): position is BullpenActivePositionView => Boolean(position));
  const maxPositions = readNumber(latest.outputs.console_trade_max_positions);
  // The serialized rows are the verified evidence. Do not let a contradictory
  // scalar count reintroduce the same zero-position bug in another shape.
  const occupiedPositions = activePositions.length;
  const availableSlots =
    maxPositions === null
      ? readNumber(latest.outputs.console_trade_available_slots)
      : Math.max(0, maxPositions - occupiedPositions);

  return {
    runId: latest.run.id,
    verifiedAt: latest.verifiedAt,
    activePositions,
    cashInHandUsd: readNumber(
      latest.outputs.console_trade_cash_in_hand_usd,
    ),
    occupiedPositions,
    availableSlots,
    maxPositions,
    tradeAmountUsd: readNumber(latest.outputs.console_trade_amount_usd),
  };
}

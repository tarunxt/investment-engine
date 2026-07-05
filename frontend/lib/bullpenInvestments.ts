import {
  hasBullpenStrongLlmOdds,
  type BullpenQuestionRow,
} from "@/lib/bullpen-ai";
import {
  evaluateBullpenEventExits,
  getBullpenEventExitBadgeLabel,
  type BullpenExitSignal,
  type BullpenExitState,
} from "@/lib/bullpenEventExits";
import type { BullpenActivePositionView } from "@/lib/bullpenPositions";
import type { BullpenAutoLiveDecision } from "@/types/api";

export type BullpenInvestmentRow =
  | {
      kind: "active";
      key: string;
      returnsPerDay: number | null;
      position: BullpenActivePositionView;
    }
  | {
      kind: "candidate";
      key: string;
      returnsPerDay: number | null;
      question: BullpenQuestionRow;
    };

export type BullpenActivePositionAttentionEntry = {
  position: BullpenActivePositionView;
  question: BullpenQuestionRow | null;
  exitSignals: BullpenExitSignal[];
  exitState: BullpenExitState;
  reasonBadges: string[];
  estimatedFreeableValue: number | null;
  successfulExitAt: string | null;
};

const BULLPEN_INVESTMENT_ROW_LIMIT = 10;

function readLatestSuccessfulExitTimestampByPositionKey(
  recentDecisions: BullpenAutoLiveDecision[],
) {
  const latestByPositionKey = new Map<string, string>();

  for (const decision of recentDecisions) {
    const orderPlan = decision.order_plan;
    const side = decision.side?.trim().toUpperCase();
    if (
      !decision.market_id ||
      !side ||
      (orderPlan?.action !== "sell" &&
        decision.exit_state !== "SELL_SUBMITTED" &&
        decision.exit_state !== "PARTIALLY_FILLED" &&
        decision.exit_state !== "SOLD")
    ) {
      continue;
    }
    if (
      orderPlan &&
      orderPlan.action === "sell" &&
      orderPlan.status !== "submitted" &&
      decision.exit_state !== "PARTIALLY_FILLED" &&
      decision.exit_state !== "SOLD"
    ) {
      continue;
    }

    const timestamp =
      orderPlan?.executed_at?.trim() ||
      decision.updated_at?.trim() ||
      decision.created_at?.trim() ||
      null;
    if (!timestamp) continue;

    const positionKey = `${decision.market_id}::${side}`;
    const existingTimestamp = latestByPositionKey.get(positionKey);
    const existingMs = existingTimestamp ? Date.parse(existingTimestamp) : Number.NaN;
    const nextMs = Date.parse(timestamp);
    if (
      !existingTimestamp ||
      (Number.isFinite(nextMs) &&
        (!Number.isFinite(existingMs) || nextMs >= existingMs))
    ) {
      latestByPositionKey.set(positionKey, timestamp);
    }
  }

  return latestByPositionKey;
}

export function buildBullpenInvestmentDisplay({
  activePositions,
  activePositionQuestions,
  candidates,
  recentDecisions = [],
}: {
  activePositions: BullpenActivePositionView[];
  activePositionQuestions: BullpenQuestionRow[];
  candidates: BullpenQuestionRow[];
  recentDecisions?: BullpenAutoLiveDecision[];
}) {
  const activePositionQuestionByKey = new Map(
    activePositionQuestions.map((question) => [question.id, question] as const),
  );
  const latestSuccessfulExitTimestampByPositionKey =
    readLatestSuccessfulExitTimestampByPositionKey(recentDecisions);
  const rankingEligibleActivePositions = activePositions.filter((position) =>
    hasBullpenStrongLlmOdds(activePositionQuestionByKey.get(position.key)),
  );
  const rankingTopRows: BullpenInvestmentRow[] = [
    ...rankingEligibleActivePositions.map((position) => ({
      kind: "active" as const,
      key: position.key,
      returnsPerDay: position.returnsPerDay,
      position,
    })),
    ...candidates.map((question) => ({
      kind: "candidate" as const,
      key: question.id,
      returnsPerDay: question.returnsPerDay,
      question,
    })),
  ]
    .sort((left, right) => (right.returnsPerDay ?? -Infinity) - (left.returnsPerDay ?? -Infinity))
    .slice(0, BULLPEN_INVESTMENT_ROW_LIMIT);
  const rankingTopActivePositionKeys = new Set(
    rankingTopRows
      .filter((row): row is Extract<BullpenInvestmentRow, { kind: "active" }> => row.kind === "active")
      .map((row) => row.key),
  );
  const evaluatedActivePositions = activePositions.map((position) => {
    const question = activePositionQuestionByKey.get(position.key) ?? null;
    const hasStrongLlmOdds = hasBullpenStrongLlmOdds(question);
    const positionSide = position.heldSide ?? position.outcome?.trim().toUpperCase() ?? null;
    const positionKeyForExitLookup =
      position.marketId && positionSide ? `${position.marketId}::${positionSide}` : null;
    const evaluation = evaluateBullpenEventExits({
      position,
      question,
      topActivePositionKeys: hasStrongLlmOdds
        ? rankingTopActivePositionKeys
        : new Set([...rankingTopActivePositionKeys, position.key]),
    });

    return {
      position,
      question,
      ...evaluation,
      reasonBadges: evaluation.exitSignals.map((signal) =>
        getBullpenEventExitBadgeLabel(signal),
      ),
      successfulExitAt:
        latestSuccessfulExitTimestampByPositionKey.get(position.key) ??
        (positionKeyForExitLookup
          ? latestSuccessfulExitTimestampByPositionKey.get(positionKeyForExitLookup)
          : null) ??
        null,
    };
  });
  const investableActivePositions = evaluatedActivePositions.filter(
    (entry) =>
      entry.exitState !== "EVENT_EXIT_PLANNED" && entry.exitState !== "DUST_LOST",
  );
  const topInvestmentRows: BullpenInvestmentRow[] = [
    ...investableActivePositions.map(({ position }) => ({
      kind: "active" as const,
      key: position.key,
      returnsPerDay: position.returnsPerDay,
      position,
    })),
    ...candidates.map((question) => ({
      kind: "candidate" as const,
      key: question.id,
      returnsPerDay: question.returnsPerDay,
      question,
    })),
  ]
    .sort((left, right) => (right.returnsPerDay ?? -Infinity) - (left.returnsPerDay ?? -Infinity))
    .slice(0, BULLPEN_INVESTMENT_ROW_LIMIT);
  const activePositionsNeedingAttention = evaluatedActivePositions.filter(
    (entry) =>
      entry.exitState === "EVENT_EXIT_PLANNED" || entry.exitState === "DUST_LOST",
  );
  const watchFastPositionKeys = new Set(
    evaluatedActivePositions
      .filter((entry) => entry.exitState === "WATCH_FAST")
      .map((entry) => entry.position.key),
  );
  const eventExitCounts = {
    total: activePositionsNeedingAttention.length,
    rankingOrLlm: activePositionsNeedingAttention.filter((entry) =>
      entry.exitSignals.some(
        (signal) =>
          signal.strategy === "OUTSIDE_TOP_10_RETURNS_DAY" ||
          signal.strategy === "LLM_OR_ODDS_FILTER_EXIT",
      ),
    ).length,
    forced: activePositionsNeedingAttention.filter((entry) =>
      entry.exitSignals.some(
        (signal) => signal.strategy === "CAPITAL_AWARE_FORCED_EXIT",
      ),
    ).length,
    watchFast: watchFastPositionKeys.size,
  };

  return {
    activePositionQuestionByKey,
    activePositionsNeedingAttention,
    eventExitCounts,
    topInvestmentRows,
    watchFastPositionKeys,
  };
}

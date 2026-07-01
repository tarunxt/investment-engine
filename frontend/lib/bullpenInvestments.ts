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
};

const BULLPEN_INVESTMENT_ROW_LIMIT = 10;

export function buildBullpenInvestmentDisplay({
  activePositions,
  activePositionQuestions,
  candidates,
}: {
  activePositions: BullpenActivePositionView[];
  activePositionQuestions: BullpenQuestionRow[];
  candidates: BullpenQuestionRow[];
}) {
  const activePositionQuestionByKey = new Map(
    activePositionQuestions.map((question) => [question.id, question] as const),
  );
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

import {
  hasBullpenStrongLlmOdds,
  type BullpenQuestionRow,
} from "@/lib/bullpen-ai";
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
  reasons: string[];
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
  const eligibleActivePositions = activePositions.filter((position) =>
    hasBullpenStrongLlmOdds(activePositionQuestionByKey.get(position.key)),
  );
  const topInvestmentRows: BullpenInvestmentRow[] = [
    ...eligibleActivePositions.map((position) => ({
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
  const topActivePositionKeys = new Set(
    topInvestmentRows
      .filter((row): row is Extract<BullpenInvestmentRow, { kind: "active" }> => row.kind === "active")
      .map((row) => row.key),
  );
  const activePositionsNeedingAttention: BullpenActivePositionAttentionEntry[] =
    activePositions
      .map((position) => {
        const question = activePositionQuestionByKey.get(position.key) ?? null;
        const hasStrongLlmOdds = hasBullpenStrongLlmOdds(question);
        const reasons = [
          !hasStrongLlmOdds ? "LLM Yes/No odds are not above 80%" : null,
          hasStrongLlmOdds && !topActivePositionKeys.has(position.key)
            ? "not in the top 10 by returns/day"
            : null,
        ].filter((reason): reason is string => Boolean(reason));

        return { position, question, reasons };
      })
      .filter((entry) => entry.reasons.length > 0);

  return {
    activePositionQuestionByKey,
    activePositionsNeedingAttention,
    topInvestmentRows,
  };
}

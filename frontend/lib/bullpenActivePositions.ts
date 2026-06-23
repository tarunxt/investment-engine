import {
  createBullpenQuestionRow,
  type BullpenQuestionAnalysis,
  type BullpenQuestionRow,
} from "./bullpen-ai";
import {
  getBullpenPositionDaysUntilClose,
  type BullpenActivePositionView,
} from "./bullpenPositions";

export type BullpenActivePositionLlmAnalysis = Pick<
  BullpenQuestionAnalysis,
  | "llmYesOdds"
  | "llmNoOdds"
  | "llmAverageYesOdds"
  | "llmMedianYesOdds"
  | "llmTrimmedMeanYesOdds"
  | "llmMinYesOdds"
  | "llmMaxYesOdds"
  | "llmSpreadYesOdds"
  | "llmDisagreementLevel"
  | "adjudicationRequired"
  | "evidenceStatus"
  | "eventState"
  | "llmNotes"
  | "llmProvider"
  | "llmModel"
  | "llmRunId"
  | "llmCompletedAt"
  | "preflightEvidenceBlock"
  | "llmBreakdown"
>;

export type BullpenLlmRunTargetLink =
  | {
      kind: "position";
      positionKey: string;
    }
  | {
      kind: "snapshot";
      questionId: string;
    };

type BuildBullpenLlmRunTargetSetArgs = {
  activePositions: BullpenActivePositionView[];
  analysesByPositionKey: Record<string, BullpenActivePositionLlmAnalysis>;
  selectedQuestions: BullpenQuestionRow[];
};

function normalizeQuestionTitle(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function scoreBullpenLlmTargetQuestion(question: BullpenQuestionRow) {
  let score = 0;
  if (question.marketUrl) score += 8;
  if (question.slug) score += 4;
  if (question.yesOdds !== null) score += 2;
  if (question.noOdds !== null) score += 2;
  if (question.closeTime) score += 1;
  if (question.category && question.category !== "Uncategorized") score += 1;
  return score;
}

export function buildBullpenLlmTargetId(
  question: Pick<BullpenQuestionRow, "question" | "slug" | "marketUrl">,
) {
  if (question.marketUrl?.trim()) {
    return `market-url:${question.marketUrl.trim().toLowerCase()}`;
  }

  if (question.slug?.trim()) {
    return `slug:${question.slug.trim().toLowerCase()}`;
  }

  return `question:${normalizeQuestionTitle(question.question)}`;
}

function createEmptyBullpenActivePositionLlmAnalysis(): BullpenActivePositionLlmAnalysis {
  return {
    llmYesOdds: null,
    llmNoOdds: null,
    llmAverageYesOdds: null,
    llmMedianYesOdds: null,
    llmTrimmedMeanYesOdds: null,
    llmMinYesOdds: null,
    llmMaxYesOdds: null,
    llmSpreadYesOdds: null,
    llmDisagreementLevel: null,
    adjudicationRequired: false,
    evidenceStatus: null,
    eventState: null,
    llmNotes: null,
    llmProvider: null,
    llmModel: null,
    llmRunId: null,
    llmCompletedAt: null,
    preflightEvidenceBlock: null,
    llmBreakdown: [],
  };
}

export function buildBullpenQuestionRowFromActivePosition(
  position: BullpenActivePositionView,
  analysis?: Partial<BullpenActivePositionLlmAnalysis> | null,
) {
  return createBullpenQuestionRow({
    id: position.key,
    question: position.marketTitle,
    closeTime: position.closeTime,
    category: "Active Position",
    yesOdds: position.yesOdds,
    noOdds: position.noOdds,
    volume: null,
    liquidity: null,
    sourceUrl: position.marketUrl || "",
    slug: position.marketId || null,
    marketUrl: position.marketUrl,
    outcomeLabels: ["Yes", "No"],
    outcomeCount: 2,
    isBinaryYesNo: position.yesOdds !== null || position.noOdds !== null,
    daysUntilClose: getBullpenPositionDaysUntilClose(position.closeTime),
    rules: position.rules,
    marketContext: position.marketContext,
    resolutionSource: position.resolutionSource,
    ...createEmptyBullpenActivePositionLlmAnalysis(),
    ...analysis,
  });
}

export function extractBullpenActivePositionLlmAnalysis(
  question: BullpenQuestionRow,
): BullpenActivePositionLlmAnalysis {
  return {
    llmYesOdds: question.llmYesOdds,
    llmNoOdds: question.llmNoOdds,
    llmAverageYesOdds: question.llmAverageYesOdds,
    llmMedianYesOdds: question.llmMedianYesOdds,
    llmTrimmedMeanYesOdds: question.llmTrimmedMeanYesOdds,
    llmMinYesOdds: question.llmMinYesOdds,
    llmMaxYesOdds: question.llmMaxYesOdds,
    llmSpreadYesOdds: question.llmSpreadYesOdds,
    llmDisagreementLevel: question.llmDisagreementLevel,
    adjudicationRequired: question.adjudicationRequired,
    evidenceStatus: question.evidenceStatus,
    eventState: question.eventState,
    llmNotes: question.llmNotes,
    llmProvider: question.llmProvider,
    llmModel: question.llmModel,
    llmRunId: question.llmRunId,
    llmCompletedAt: question.llmCompletedAt,
    preflightEvidenceBlock: question.preflightEvidenceBlock ?? null,
    llmBreakdown: question.llmBreakdown,
  };
}

export function buildBullpenLlmRunTargetSet({
  activePositions,
  analysesByPositionKey,
  selectedQuestions,
}: BuildBullpenLlmRunTargetSetArgs) {
  const linksByQuestionId: Record<string, BullpenLlmRunTargetLink[]> = {};
  const targetIdByKey = new Map<string, string>();
  const questionsById = new Map<string, BullpenQuestionRow>();
  const activePositionQuestions = activePositions.map((position) =>
    buildBullpenQuestionRowFromActivePosition(
      position,
      analysesByPositionKey[position.key],
    ),
  );

  const registerQuestion = (
    question: BullpenQuestionRow,
    link: BullpenLlmRunTargetLink,
  ) => {
    const targetKey = buildBullpenLlmTargetId(question);
    const existingId = targetIdByKey.get(targetKey);

    if (existingId) {
      linksByQuestionId[existingId] = [...(linksByQuestionId[existingId] || []), link];
      const existingQuestion = questionsById.get(existingId);
      if (
        existingQuestion &&
        scoreBullpenLlmTargetQuestion(question) >
          scoreBullpenLlmTargetQuestion(existingQuestion)
      ) {
        questionsById.set(existingId, {
          ...question,
          id: existingId,
        });
      }
      return;
    }

    targetIdByKey.set(targetKey, targetKey);
    questionsById.set(targetKey, {
      ...question,
      id: targetKey,
    });
    linksByQuestionId[targetKey] = [link];
  };

  selectedQuestions.forEach((question) => {
    registerQuestion(question, {
      kind: "snapshot",
      questionId: question.id,
    });
  });

  activePositionQuestions.forEach((question) => {
    registerQuestion(question, {
      kind: "position",
      positionKey: question.id,
    });
  });

  return {
    activePositionQuestions,
    linksByQuestionId,
    questions: [...questionsById.values()],
    selectedQuestions,
  };
}

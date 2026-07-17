import {
  createBullpenQuestionRow,
  type BullpenQuestionAnalysis,
  type BullpenQuestionRow,
} from "./bullpen-ai";
import {
  canonicalizeBullpenMarketUrl,
  type BullpenEventMatchMethod,
} from "./bullpenEventIdentityResolver";
import {
  getBullpenPositionDaysUntilClose,
  type BullpenActivePositionView,
} from "./bullpenPositions";

export type BullpenActivePositionLlmRecoveryStatus =
  | "recovered"
  | "last-known-good/stale"
  | "ambiguous"
  | "unrecoverable";

export type BullpenActivePositionLlmRecoverySource =
  | "current-run"
  | "latest-snapshot"
  | "last-known-good"
  | "decision-fallback";

export type BullpenActivePositionLlmTelemetry = {
  llmRecoveryStatus: BullpenActivePositionLlmRecoveryStatus | null;
  llmRecoverySource: BullpenActivePositionLlmRecoverySource | null;
  llmRecoveryMatchMethod: BullpenEventMatchMethod | null;
  llmRecoveryRunId: string | number | null;
  llmRecoveryReason: string | null;
};

export type BullpenActivePositionLlmAnalysis = Pick<
  BullpenQuestionAnalysis,
  | "llmYesOdds"
  | "llmNoOdds"
  | "llmAverageYesOdds"
  | "llmMedianYesOdds"
  | "llmTrimmedMeanYesOdds"
  | "llmIqrYesOdds"
  | "llmTrimmedRangeYesOdds"
  | "llmMinYesOdds"
  | "llmMaxYesOdds"
  | "llmSpreadYesOdds"
  | "llmDisagreementCategory"
  | "llmDisagreementLevel"
  | "llmRationaleMismatchCount"
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
> &
  BullpenActivePositionLlmTelemetry;

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
  const canonicalMarketUrl = canonicalizeBullpenMarketUrl(question.marketUrl);
  if (canonicalMarketUrl) {
    return `market-url:${canonicalMarketUrl}`;
  }

  if (question.slug?.trim()) {
    return `slug:${question.slug.trim().toLowerCase()}`;
  }

  return `question:${normalizeQuestionTitle(question.question)}`;
}

export function createEmptyBullpenActivePositionLlmAnalysis(): BullpenActivePositionLlmAnalysis {
  return {
    llmYesOdds: null,
    llmNoOdds: null,
    llmAverageYesOdds: null,
    llmMedianYesOdds: null,
    llmTrimmedMeanYesOdds: null,
    llmIqrYesOdds: null,
    llmTrimmedRangeYesOdds: null,
    llmMinYesOdds: null,
    llmMaxYesOdds: null,
    llmSpreadYesOdds: null,
    llmDisagreementCategory: null,
    llmDisagreementLevel: null,
    llmRationaleMismatchCount: 0,
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
    llmRecoveryStatus: null,
    llmRecoverySource: null,
    llmRecoveryMatchMethod: null,
    llmRecoveryRunId: null,
    llmRecoveryReason: null,
  };
}

export function buildBullpenQuestionRowFromActivePosition(
  position: BullpenActivePositionView,
  analysis?: Partial<BullpenActivePositionLlmAnalysis> | null,
) {
  return createBullpenQuestionRow({
    id: position.key,
    question: position.marketTitle,
    positionKey: position.key,
    conditionId: position.conditionId,
    marketId: position.marketId,
    questionId: null,
    closeTime: position.closeTime,
    category: "Active Position",
    yesOdds: position.yesOdds,
    noOdds: position.noOdds,
    volume: null,
    liquidity: null,
    sourceUrl: position.marketUrl || "",
    slug: position.slug,
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
    llmIqrYesOdds: question.llmIqrYesOdds,
    llmTrimmedRangeYesOdds: question.llmTrimmedRangeYesOdds,
    llmMinYesOdds: question.llmMinYesOdds,
    llmMaxYesOdds: question.llmMaxYesOdds,
    llmSpreadYesOdds: question.llmSpreadYesOdds,
    llmDisagreementCategory: question.llmDisagreementCategory,
    llmDisagreementLevel: question.llmDisagreementLevel,
    llmRationaleMismatchCount: question.llmRationaleMismatchCount,
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
    llmRecoveryStatus:
      (question as Partial<BullpenActivePositionLlmAnalysis>).llmRecoveryStatus ??
      null,
    llmRecoverySource:
      (question as Partial<BullpenActivePositionLlmAnalysis>).llmRecoverySource ??
      null,
    llmRecoveryMatchMethod:
      (question as Partial<BullpenActivePositionLlmAnalysis>).llmRecoveryMatchMethod ??
      null,
    llmRecoveryRunId:
      (question as Partial<BullpenActivePositionLlmAnalysis>).llmRecoveryRunId ??
      null,
    llmRecoveryReason:
      (question as Partial<BullpenActivePositionLlmAnalysis>).llmRecoveryReason ??
      null,
  };
}

export function hasBullpenValidActivePositionOdds(
  analysis: BullpenActivePositionLlmAnalysis | null | undefined,
) {
  return Boolean(
    analysis &&
      analysis.llmYesOdds !== null &&
      analysis.llmNoOdds !== null &&
      Number.isFinite(analysis.llmYesOdds) &&
      Number.isFinite(analysis.llmNoOdds),
  );
}

export function hasSavedBullpenActivePositionAnalysis(
  analysis: BullpenActivePositionLlmAnalysis | null | undefined,
) {
  return Boolean(
    analysis &&
      (hasBullpenValidActivePositionOdds(analysis) ||
        analysis.llmCompletedAt ||
        analysis.llmBreakdown.length > 0 ||
        analysis.llmRecoveryStatus ||
        analysis.llmRecoveryReason),
  );
}

export function getBullpenActivePositionAnalysisCapturedAt(
  analysis: Pick<
    BullpenActivePositionLlmAnalysis,
    "llmCompletedAt" | "llmBreakdown"
  >,
) {
  if (analysis.llmCompletedAt) return analysis.llmCompletedAt;

  return (
    [...analysis.llmBreakdown]
      .map((entry) => entry.timestamp)
      .filter((timestamp): timestamp is string => Boolean(timestamp))
      .sort()
      .at(-1) || null
  );
}

export function getBullpenActivePositionAnalysisTimestampMs(
  analysis: BullpenActivePositionLlmAnalysis | null | undefined,
) {
  if (!analysis) return 0;
  const capturedAt = getBullpenActivePositionAnalysisCapturedAt(analysis);
  if (!capturedAt) return 0;

  const timestampMs = Date.parse(capturedAt);
  return Number.isFinite(timestampMs) ? timestampMs : 0;
}

export function pickPreferredBullpenActivePositionAnalysis(
  left: BullpenActivePositionLlmAnalysis | null | undefined,
  right: BullpenActivePositionLlmAnalysis | null | undefined,
) {
  const normalizedLeft = hasSavedBullpenActivePositionAnalysis(left) ? left : null;
  const normalizedRight = hasSavedBullpenActivePositionAnalysis(right)
    ? right
    : null;

  if (!normalizedLeft) return normalizedRight;
  if (!normalizedRight) return normalizedLeft;

  const leftValid = hasBullpenValidActivePositionOdds(normalizedLeft);
  const rightValid = hasBullpenValidActivePositionOdds(normalizedRight);
  if (leftValid !== rightValid) {
    return rightValid ? normalizedRight : normalizedLeft;
  }

  return getBullpenActivePositionAnalysisTimestampMs(normalizedRight) >
    getBullpenActivePositionAnalysisTimestampMs(normalizedLeft)
    ? normalizedRight
    : normalizedLeft;
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

"use client";

import {
  BULLPEN_SOURCE_URLS,
  archiveBullpenScanSnapshot,
  computeBullpenLlmConsensus,
  createBullpenScanFilters,
  createBullpenQuestionRow,
  normalizeBullpenOddsPair,
  summarizeBullpenLlmNotes,
  type BullpenLlmDisagreementCategory,
  type BullpenLlmDisagreementLevel,
  type BullpenQuestionLlmBreakdownItem,
  type BullpenQuestionRow,
  type BullpenScanSnapshot,
  type BullpenSnapshotHistory,
  type ScanMode,
} from "@/lib/bullpen-ai";
import {
  createEmptyBullpenActivePositionLlmAnalysis,
  hasBullpenValidActivePositionOdds,
  pickPreferredBullpenActivePositionAnalysis,
  type BullpenActivePositionLlmAnalysis,
} from "@/lib/bullpenActivePositions";
import {
  BullpenEventIdentityResolver,
  buildBullpenEventIdentityFromDecision,
  buildBullpenEventIdentityFromPosition,
  buildBullpenEventIdentityFromQuestion,
  buildBullpenEventIdentityFromRecord,
  describeBullpenEventMatchMethod,
} from "@/lib/bullpenEventIdentityResolver";
import type { BullpenActivePositionView } from "@/lib/bullpenPositions";
import type {
  BullpenAutoLiveDecision,
  BullpenAutoLiveLlmOutput,
  BullpenAutoLiveRun,
  BullpenAutoLiveStageResult,
  BullpenAutoLiveSummaryResponse,
} from "@/types/api";

type SnapshotMap = Record<ScanMode, BullpenSnapshotHistory>;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_SYNCED_SNAPSHOT_HISTORY = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readCandidateCategory(
  record: Record<string, unknown>,
  fallback: string | null = null,
) {
  return (
    readString(record.category) ??
    readString(record.theme) ??
    readString(record.categoryName) ??
    readString(record.primaryCategory) ??
    readString(record.topic) ??
    fallback ??
    "Uncategorized"
  );
}

function readBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return null;
}

function readStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => readString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function readDisagreementLevel(value: unknown): BullpenLlmDisagreementLevel | null {
  return value === "Low" || value === "Medium" || value === "High" ? value : null;
}

function readDisagreementCategory(value: unknown): BullpenLlmDisagreementCategory | null {
  return value === "CONSENSUS" ||
    value === "MOSTLY_CONSENSUS_SOME_UNCERTAINTY" ||
    value === "CONSENSUS_WITH_OUTLIER" ||
    value === "HIGH_DISAGREEMENT"
    ? value
    : null;
}

function readStageOutputs(stage: BullpenAutoLiveStageResult | null) {
  return isRecord(stage?.outputs) ? stage.outputs : {};
}

function findWorkflowStage(
  run: BullpenAutoLiveRun | null | undefined,
  workflowStageKey: "scan" | "llm" | "invest",
  stageNumber: number,
) {
  if (!run) return null;
  return (
    run.stage_results.find((stage) => {
      const outputs = readStageOutputs(stage);
      return readString(outputs.workflow_stage_key) === workflowStageKey;
    }) ??
    run.stage_results.find((stage) => stage.stage_number === stageNumber) ??
    null
  );
}

function readScanMode(value: unknown): ScanMode | null {
  return value === "end-of-month" || value === "30-days" ? value : null;
}

function readAcceptedCandidates(stage: BullpenAutoLiveStageResult | null) {
  const outputs = readStageOutputs(stage);
  return Array.isArray(outputs.accepted_candidates) ? outputs.accepted_candidates : [];
}

function readReviewedCandidates(stage: BullpenAutoLiveStageResult | null) {
  const outputs = readStageOutputs(stage);
  return Array.isArray(outputs.llm_reviewed_candidates)
    ? outputs.llm_reviewed_candidates
    : [];
}

function stringifyNumericValue(value: unknown) {
  const numeric = readNumber(value);
  return numeric === null ? null : String(numeric);
}

function calculateDaysUntilClose(closeTime: string | null) {
  if (!closeTime) return null;

  const closeDate = new Date(closeTime);
  if (Number.isNaN(closeDate.getTime())) return null;

  return Number(
    ((closeDate.getTime() - Date.now()) / MILLISECONDS_PER_DAY).toFixed(1),
  );
}

function createBaseQuestionRow({
  marketId,
  conditionId,
  questionKey,
  questionId,
  question,
  closeTime,
  category,
  yesOdds,
  noOdds,
  volume,
  liquidity,
  sourceUrl,
  slug,
  marketUrl,
  rules,
}: {
  marketId: string | null;
  conditionId: string | null;
  questionKey: string | null;
  questionId: string;
  question: string;
  closeTime: string | null;
  category: string;
  yesOdds: number | null;
  noOdds: number | null;
  volume: string | null;
  liquidity: string | null;
  sourceUrl: string;
  slug: string | null;
  marketUrl: string | null;
  rules: string | null;
}) {
  return createBullpenQuestionRow({
    id: questionId,
    question,
    positionKey: null,
    conditionId,
    marketId,
    questionId: questionKey ?? questionId,
    closeTime,
    category,
    yesOdds,
    noOdds,
    volume,
    liquidity,
    sourceUrl,
    slug,
    marketUrl,
    outcomeLabels: ["Yes", "No"],
    outcomeCount: 2,
    isBinaryYesNo: true,
    daysUntilClose: null,
    rules,
    marketContext: null,
    resolutionSource: null,
  });
}

function buildQuestionFromAcceptedCandidate({
  candidate,
  existingQuestion,
  sourceUrl,
  preserveExistingLlm = true,
}: {
  candidate: unknown;
  existingQuestion: BullpenQuestionRow | null;
  sourceUrl: string;
  preserveExistingLlm?: boolean;
}) {
  const record = isRecord(candidate) ? candidate : {};
  const marketId = readString(record.market_id);
  const questionKey =
    readString(record.question_id) ??
    marketId ??
    readString(record.slug) ??
    readString(record.question) ??
    readString(record.market_title) ??
    `bullpen-auto-run-${Math.random().toString(36).slice(2, 10)}`;
  const questionId = questionKey;
  const questionLabel =
    readString(record.question) ??
    readString(record.market_title) ??
    existingQuestion?.question ??
    questionId;
  const baseQuestion =
    existingQuestion ??
    createBaseQuestionRow({
      marketId,
      conditionId: readString(record.condition_id),
      questionKey,
      questionId,
      question: questionLabel,
      closeTime: readString(record.close_time),
      category: readCandidateCategory(record),
      yesOdds: readNumber(record.current_yes_odds),
      noOdds: readNumber(record.current_no_odds),
      volume: stringifyNumericValue(record.volume_usd),
      liquidity: stringifyNumericValue(record.liquidity_usd),
      sourceUrl,
      slug: readString(record.slug),
      marketUrl: readString(record.market_url),
      rules: readString(record.rules),
    });

  return createBullpenQuestionRow({
    ...baseQuestion,
    id: questionId,
    question: questionLabel,
    conditionId:
      readString(record.condition_id) ?? baseQuestion.conditionId ?? null,
    marketId: marketId ?? baseQuestion.marketId ?? null,
    questionId: questionKey ?? baseQuestion.questionId ?? questionId,
    closeTime: readString(record.close_time) ?? baseQuestion.closeTime,
    category: readCandidateCategory(record, baseQuestion.category),
    yesOdds: readNumber(record.current_yes_odds) ?? baseQuestion.yesOdds,
    noOdds: readNumber(record.current_no_odds) ?? baseQuestion.noOdds,
    volume: stringifyNumericValue(record.volume_usd) ?? baseQuestion.volume,
    liquidity: stringifyNumericValue(record.liquidity_usd) ?? baseQuestion.liquidity,
    sourceUrl: sourceUrl || baseQuestion.sourceUrl,
    slug: readString(record.slug) ?? baseQuestion.slug,
    marketUrl: readString(record.market_url) ?? baseQuestion.marketUrl,
    rules: readString(record.rules) ?? baseQuestion.rules,
    llmYesOdds:
      readNumber(record.llm_yes_odds) ??
      (preserveExistingLlm ? baseQuestion.llmYesOdds : null),
    llmNoOdds:
      readNumber(record.llm_no_odds) ??
      (preserveExistingLlm ? baseQuestion.llmNoOdds : null),
    llmDisagreementLevel:
      readDisagreementLevel(record.llm_disagreement_level) ??
      (preserveExistingLlm ? baseQuestion.llmDisagreementLevel : null),
    llmDisagreementCategory:
      readDisagreementCategory(record.llm_disagreement_category) ??
      (preserveExistingLlm ? baseQuestion.llmDisagreementCategory : null),
    adjudicationRequired:
      readBoolean(record.adjudication_required) ??
      (preserveExistingLlm ? baseQuestion.adjudicationRequired : false),
    evidenceStatus:
      readString(record.evidence_status) ??
      (preserveExistingLlm ? baseQuestion.evidenceStatus : null),
    eventState:
      readString(record.event_state) ??
      (preserveExistingLlm ? baseQuestion.eventState : null),
    llmNotes: preserveExistingLlm ? baseQuestion.llmNotes : null,
    llmProvider: preserveExistingLlm ? baseQuestion.llmProvider : null,
    llmModel: preserveExistingLlm ? baseQuestion.llmModel : null,
    llmRunId: preserveExistingLlm ? baseQuestion.llmRunId : null,
    llmCompletedAt: preserveExistingLlm ? baseQuestion.llmCompletedAt : null,
    llmBreakdown: preserveExistingLlm ? baseQuestion.llmBreakdown : [],
    daysUntilClose:
      calculateDaysUntilClose(readString(record.close_time) ?? baseQuestion.closeTime) ??
      baseQuestion.daysUntilClose,
  });
}

function buildDecisionBreakdownItem({
  llmOutput,
  stage2,
}: {
  llmOutput: BullpenAutoLiveLlmOutput;
  stage2: BullpenAutoLiveStageResult | null;
}): BullpenQuestionLlmBreakdownItem {
  const stage2Outputs = readStageOutputs(stage2);
  return {
    provider: llmOutput.provider,
    model: llmOutput.model,
    jobId: null,
    runId: null,
    timestamp: readString(llmOutput.completed_at) ?? null,
    llmYesOdds: readNumber(llmOutput.llm_yes_odds),
    llmNoOdds: readNumber(llmOutput.llm_no_odds),
    yesDefinition: readString(stage2Outputs.yes_definition),
    deadlineEt: readString(stage2Outputs.deadline_et),
    hoursRemaining: readNumber(stage2Outputs.hours_remaining),
    evidenceStatus: readString(llmOutput.evidence_status),
    eventState: readString(llmOutput.event_state),
    confidence: readString(llmOutput.confidence),
    keyEvidence: readStringArray(llmOutput.key_evidence),
    redFlags: readStringArray(llmOutput.red_flags),
    rationale: readString(llmOutput.rationale),
    direction: null,
    rationaleOddsMismatch: false,
    rationaleOddsMismatchReason: null,
    effectiveWeight: null,
    webSearchUsed: null,
    webSearchQueries: [],
    webSources: [],
    internetVerified: null,
    evidenceBlockUsed: false,
    staleFactDetected: false,
    invalidReason: null,
    invalidStaleFact: false,
    staleFactReason: null,
  };
}

function buildReviewedCandidateBreakdownItem({
  llmOutput,
  reviewedCandidate,
}: {
  llmOutput: BullpenAutoLiveLlmOutput;
  reviewedCandidate: Record<string, unknown>;
}): BullpenQuestionLlmBreakdownItem {
  return {
    provider: llmOutput.provider,
    model: llmOutput.model,
    jobId: null,
    runId: null,
    timestamp: readString(llmOutput.completed_at) ?? null,
    llmYesOdds: readNumber(llmOutput.llm_yes_odds),
    llmNoOdds: readNumber(llmOutput.llm_no_odds),
    yesDefinition: readString(reviewedCandidate.yes_definition),
    deadlineEt: readString(reviewedCandidate.deadline_et),
    hoursRemaining: readNumber(reviewedCandidate.hours_remaining),
    evidenceStatus:
      readString(llmOutput.evidence_status) ??
      readString(reviewedCandidate.evidence_status),
    eventState:
      readString(llmOutput.event_state) ?? readString(reviewedCandidate.event_state),
    confidence:
      readString(llmOutput.confidence) ?? readString(reviewedCandidate.confidence),
    keyEvidence: readStringArray(llmOutput.key_evidence),
    redFlags: readStringArray(llmOutput.red_flags),
    rationale: readString(llmOutput.rationale),
    direction: null,
    rationaleOddsMismatch: false,
    rationaleOddsMismatchReason: null,
    effectiveWeight: null,
    webSearchUsed: null,
    webSearchQueries: [],
    webSources: [],
    internetVerified: null,
    evidenceBlockUsed: false,
    staleFactDetected: false,
    invalidReason: readString(llmOutput.error),
    invalidStaleFact: false,
    staleFactReason: null,
  };
}

function buildReviewedCandidateBreakdown(
  reviewedCandidate: Record<string, unknown>,
) {
  if (!Array.isArray(reviewedCandidate.llm_outputs)) return [];

  return reviewedCandidate.llm_outputs
    .map((item) =>
      isRecord(item)
        ? buildReviewedCandidateBreakdownItem({
            llmOutput: item as unknown as BullpenAutoLiveLlmOutput,
            reviewedCandidate,
          })
        : null,
    )
    .filter(
      (item): item is BullpenQuestionLlmBreakdownItem => Boolean(item),
    );
}


function getLatestLlmFetchError(reviewedCandidate: Record<string, unknown>) {
  const directError =
    readString(reviewedCandidate.llm_error) ??
    readString(reviewedCandidate.error) ??
    readString(reviewedCandidate.review_error);
  if (directError) return directError;

  const outputs = Array.isArray(reviewedCandidate.llm_outputs)
    ? reviewedCandidate.llm_outputs
    : [];
  const outputErrors = outputs
    .map((item) => (isRecord(item) ? readString(item.error) : null))
    .filter((item): item is string => Boolean(item));

  if (outputErrors.length > 0) {
    return outputErrors.slice(0, 2).join("; ");
  }

  if (outputs.length === 0) {
    return "Latest scan did not return LLM outputs for this event.";
  }

  return "Latest scan returned no usable LLM odds for this event.";
}

function latestBreakdownTimestamp(
  llmBreakdown: BullpenQuestionLlmBreakdownItem[],
) {
  return (
    [...llmBreakdown]
      .map((entry) => entry.timestamp)
      .filter((timestamp): timestamp is string => Boolean(timestamp))
      .sort()
      .at(-1) ?? null
  );
}

function hasCompleteOddsPair(odds: { yes: number | null; no: number | null }) {
  return odds.yes !== null && odds.no !== null;
}

function buildReviewedCandidateConsensusOdds(
  reviewedCandidate: Record<string, unknown>,
  llmBreakdown: BullpenQuestionLlmBreakdownItem[],
) {
  const consensus = computeBullpenLlmConsensus(llmBreakdown);
  const normalizedConsensus = normalizeBullpenOddsPair(
    consensus.consensusYesOdds,
    consensus.consensusNoOdds,
  );
  const normalizedTopLevelOdds = normalizeBullpenOddsPair(
    readNumber(reviewedCandidate.fair_yes_probability_pct),
    readNumber(reviewedCandidate.fair_no_probability_pct),
  );

  return {
    consensus,
    normalizedOdds: hasCompleteOddsPair(normalizedConsensus)
      ? normalizedConsensus
      : normalizedTopLevelOdds,
    recoveredFromValidOutputs: hasCompleteOddsPair(normalizedConsensus),
  };
}

function buildActivePositionAnalysisFromReviewedCandidate(
  reviewedCandidate: Record<string, unknown>,
  {
    runId,
    recoveryStatus,
    recoverySource,
    recoveryMatchMethod,
    recoveryReason,
    completedAtFallback,
  }: {
    runId: string | number | null;
    recoveryStatus: BullpenActivePositionLlmAnalysis["llmRecoveryStatus"];
    recoverySource: BullpenActivePositionLlmAnalysis["llmRecoverySource"];
    recoveryMatchMethod: BullpenActivePositionLlmAnalysis["llmRecoveryMatchMethod"];
    recoveryReason: string | null;
    completedAtFallback: string | null;
  },
): BullpenActivePositionLlmAnalysis | null {
  const llmBreakdown = buildReviewedCandidateBreakdown(reviewedCandidate);
  const { consensus, normalizedOdds } = buildReviewedCandidateConsensusOdds(
    reviewedCandidate,
    llmBreakdown,
  );
  const llmCompletedAt =
    latestBreakdownTimestamp(llmBreakdown) ?? completedAtFallback ?? null;
  const llmProvider =
    llmBreakdown.length === 1 ? llmBreakdown[0]?.provider ?? null : null;
  const llmModel =
    llmBreakdown.length === 1 ? llmBreakdown[0]?.model ?? null : null;
  const llmYesOdds = normalizedOdds.yes;
  const llmNoOdds = normalizedOdds.no;

  if (
    llmYesOdds === null &&
    llmNoOdds === null &&
    llmBreakdown.length === 0 &&
    !llmCompletedAt
  ) {
    return null;
  }

  return {
    llmYesOdds,
    llmNoOdds,
    llmAverageYesOdds: consensus.llmAverageYesOdds,
    llmMedianYesOdds: consensus.llmMedianYesOdds,
    llmTrimmedMeanYesOdds: consensus.llmTrimmedMeanYesOdds,
    llmIqrYesOdds: consensus.llmIqrYesOdds,
    llmTrimmedRangeYesOdds: consensus.llmTrimmedRangeYesOdds,
    llmMinYesOdds: consensus.llmMinYesOdds,
    llmMaxYesOdds: consensus.llmMaxYesOdds,
    llmSpreadYesOdds: consensus.llmSpreadYesOdds,
    llmDisagreementCategory:
      readDisagreementCategory(reviewedCandidate.disagreement_category) ??
      consensus.llmDisagreementCategory,
    llmDisagreementLevel:
      readDisagreementLevel(reviewedCandidate.disagreement_level) ??
      consensus.llmDisagreementLevel,
    llmRationaleMismatchCount: consensus.llmRationaleMismatchCount,
    adjudicationRequired:
      readBoolean(reviewedCandidate.adjudication_required) ??
      consensus.adjudicationRequired,
    evidenceStatus: readString(reviewedCandidate.evidence_status),
    eventState: readString(reviewedCandidate.event_state),
    llmNotes:
      llmBreakdown.length > 0 ? summarizeBullpenLlmNotes(llmBreakdown) : null,
    llmProvider,
    llmModel,
    llmRunId: runId,
    llmCompletedAt,
    preflightEvidenceBlock: null,
    llmBreakdown,
    llmRecoveryStatus: recoveryStatus,
    llmRecoverySource: recoverySource,
    llmRecoveryMatchMethod: recoveryMatchMethod,
    llmRecoveryRunId: runId,
    llmRecoveryReason: recoveryReason,
  };
}

function findSnapshotQuestionMatch({
  targetIdentity,
  questions,
}: {
  targetIdentity: ReturnType<typeof buildBullpenEventIdentityFromQuestion>;
  questions: BullpenQuestionRow[];
}) {
  return BullpenEventIdentityResolver.resolveMatch({
    target: targetIdentity,
    candidates: questions,
    getIdentity: (question) => buildBullpenEventIdentityFromQuestion(question),
    getSortTimestamp: (question) => question.llmCompletedAt ?? question.closeTime,
  });
}

function mergeStage2QuestionAnalysis({
  question,
  reviewedCandidate,
  llmBreakdown,
  llmCompletedAt,
  runId,
}: {
  question: BullpenQuestionRow;
  reviewedCandidate: Record<string, unknown>;
  llmBreakdown: BullpenQuestionLlmBreakdownItem[];
  llmCompletedAt: string | null;
  runId: string | number | null;
}) {
  const { consensus, normalizedOdds } = buildReviewedCandidateConsensusOdds(
    reviewedCandidate,
    llmBreakdown,
  );
  const hasLatestLlmOdds = hasCompleteOddsPair(normalizedOdds);
  const latestLlmFetchError = getLatestLlmFetchError(reviewedCandidate);

  return createBullpenQuestionRow({
    ...question,
    marketId: readString(reviewedCandidate.market_id) ?? question.marketId ?? null,
    questionId:
      readString(reviewedCandidate.question_id) ?? question.questionId ?? question.id,
    marketUrl: readString(reviewedCandidate.market_url) ?? question.marketUrl,
    slug: readString(reviewedCandidate.slug) ?? question.slug,
    category: readCandidateCategory(reviewedCandidate, question.category),
    closeTime: readString(reviewedCandidate.close_time) ?? question.closeTime,
    llmYesOdds: hasLatestLlmOdds ? normalizedOdds.yes : question.llmYesOdds,
    llmNoOdds: hasLatestLlmOdds ? normalizedOdds.no : question.llmNoOdds,
    llmDisagreementLevel:
      readDisagreementLevel(reviewedCandidate.disagreement_level) ??
      consensus.llmDisagreementLevel ??
      question.llmDisagreementLevel,
    llmDisagreementCategory:
      readDisagreementCategory(reviewedCandidate.disagreement_category) ??
      consensus.llmDisagreementCategory ??
      question.llmDisagreementCategory,
    adjudicationRequired:
      readBoolean(reviewedCandidate.adjudication_required) ??
      question.adjudicationRequired,
    evidenceStatus:
      readString(reviewedCandidate.evidence_status) ?? question.evidenceStatus,
    eventState: readString(reviewedCandidate.event_state) ?? question.eventState,
    llmNotes:
      llmBreakdown.length > 0
        ? summarizeBullpenLlmNotes(llmBreakdown)
        : hasLatestLlmOdds
          ? question.llmNotes
          : latestLlmFetchError,
    llmProvider:
      llmBreakdown.length === 1
        ? llmBreakdown[0]?.provider ?? null
        : question.llmProvider,
    llmModel:
      llmBreakdown.length === 1 ? llmBreakdown[0]?.model ?? null : question.llmModel,
    llmCompletedAt: hasLatestLlmOdds ? llmCompletedAt : question.llmCompletedAt,
    llmRunId: hasLatestLlmOdds ? runId : question.llmRunId,
    llmBreakdown: llmBreakdown.length > 0 ? llmBreakdown : question.llmBreakdown,
    daysUntilClose:
      calculateDaysUntilClose(
        readString(reviewedCandidate.close_time) ?? question.closeTime,
      ) ?? question.daysUntilClose,
  });
}

function applyDecisionOutputsToSnapshot({
  snapshot,
  run,
  decisions,
}: {
  snapshot: BullpenScanSnapshot;
  run: BullpenAutoLiveRun;
  decisions: BullpenAutoLiveDecision[];
}) {
  if (decisions.length === 0) return snapshot;

  const questionById = new Map(snapshot.questions.map((question) => [question.id, question] as const));
  let changed = false;

  for (const decision of decisions) {
    if (!Array.isArray(decision.llm_outputs) || decision.llm_outputs.length === 0) {
      continue;
    }
    const questionMatch = findSnapshotQuestionMatch({
      targetIdentity: buildBullpenEventIdentityFromDecision(decision),
      questions: snapshot.questions,
    });
    if (questionMatch.status !== "matched" || !questionMatch.match) continue;
    const question = questionMatch.match.item;

    const stage2 = decision.stage_results.find((stage) => stage.stage_number === 2) ?? null;
    const llmBreakdown = decision.llm_outputs.map((llmOutput) =>
      buildDecisionBreakdownItem({
        llmOutput,
        stage2,
      }),
    );
    const nextCloseTime = decision.close_time ?? question.closeTime;
    const normalizedOdds = normalizeBullpenOddsPair(
      decision.fair_yes_probability_pct ?? null,
      decision.fair_no_probability_pct ?? null,
    );
    const hasLatestOdds = hasCompleteOddsPair(normalizedOdds);
    const nextQuestion = createBullpenQuestionRow({
      ...question,
      marketId: decision.market_id ?? question.marketId ?? null,
      questionId: question.questionId ?? question.id,
      marketUrl: decision.market_url ?? question.marketUrl,
      slug: decision.slug ?? question.slug,
      closeTime: nextCloseTime,
      category: readCandidateCategory(
        decision as unknown as Record<string, unknown>,
        question.category,
      ),
      llmYesOdds: hasLatestOdds ? normalizedOdds.yes : question.llmYesOdds,
      llmNoOdds: hasLatestOdds ? normalizedOdds.no : question.llmNoOdds,
      evidenceStatus: decision.evidence_status ?? question.evidenceStatus,
      eventState: decision.event_state ?? question.eventState,
      adjudicationRequired: decision.adjudication_required,
      llmDisagreementLevel:
        readDisagreementLevel(decision.disagreement_level) ??
        question.llmDisagreementLevel,
      daysUntilClose:
        calculateDaysUntilClose(nextCloseTime) ?? question.daysUntilClose,
      llmCompletedAt:
        hasLatestOdds
          ? llmBreakdown
              .map((entry) => entry.timestamp)
              .filter((timestamp): timestamp is string => Boolean(timestamp))
              .sort()
              .at(-1) ?? run.completed_at ?? question.llmCompletedAt
          : question.llmCompletedAt,
      llmRunId: hasLatestOdds ? run.id : question.llmRunId,
      llmBreakdown: llmBreakdown.length > 0 ? llmBreakdown : question.llmBreakdown,
    });

    if (JSON.stringify(nextQuestion) !== JSON.stringify(question)) {
      questionById.set(question.id, nextQuestion);
      changed = true;
    }
  }

  if (!changed) return snapshot;

  return {
    ...snapshot,
    questions: snapshot.questions.map((question) => questionById.get(question.id) ?? question),
  };
}

function applyStage2OutputsToSnapshot({
  snapshot,
  run,
}: {
  snapshot: BullpenScanSnapshot;
  run: BullpenAutoLiveRun;
}) {
  const stage2 = findWorkflowStage(run, "llm", 2);
  const reviewedCandidates = readReviewedCandidates(stage2);
  if (reviewedCandidates.length === 0) return snapshot;

  const questionById = new Map(snapshot.questions.map((question) => [question.id, question] as const));
  let changed = false;

  for (const reviewedCandidate of reviewedCandidates) {
    if (!isRecord(reviewedCandidate)) continue;
    const questionMatch = findSnapshotQuestionMatch({
      targetIdentity: buildBullpenEventIdentityFromRecord(reviewedCandidate),
      questions: snapshot.questions,
    });
    if (questionMatch.status !== "matched" || !questionMatch.match) continue;
    const question = questionMatch.match.item;
    const llmBreakdown = buildReviewedCandidateBreakdown(reviewedCandidate);
    const llmCompletedAt = latestBreakdownTimestamp(llmBreakdown) ?? stage2?.completed_at ?? null;
    const nextQuestion = mergeStage2QuestionAnalysis({
      question,
      reviewedCandidate,
      llmBreakdown,
      llmCompletedAt,
      runId: run.id,
    });

    if (JSON.stringify(nextQuestion) !== JSON.stringify(question)) {
      questionById.set(question.id, nextQuestion);
      changed = true;
    }
  }

  if (!changed) return snapshot;

  return {
    ...snapshot,
    questions: snapshot.questions.map((question) => questionById.get(question.id) ?? question),
  };
}

export function syncBullpenAutoRunActivePositionAnalyses({
  currentAnalyses,
  run,
  activePositions = [],
  snapshotAnalysesByKey = {},
}: {
  currentAnalyses: Record<string, BullpenActivePositionLlmAnalysis>;
  run: BullpenAutoLiveRun | null;
  activePositions?: BullpenActivePositionView[];
  snapshotAnalysesByKey?: Record<string, BullpenActivePositionLlmAnalysis>;
}) {
  if (!run) return currentAnalyses;

  const stage2 = findWorkflowStage(run, "llm", 2);
  const reviewedCandidates = readReviewedCandidates(stage2);
  if (reviewedCandidates.length === 0) return currentAnalyses;

  type MatchedCandidateResolution = {
    analysis: BullpenActivePositionLlmAnalysis | null;
    matchMethod: BullpenActivePositionLlmAnalysis["llmRecoveryMatchMethod"];
    reason: string;
    score: number;
    completedAt: string | null;
  };

  type AmbiguousCandidateResolution = {
    matchMethod: BullpenActivePositionLlmAnalysis["llmRecoveryMatchMethod"];
    reason: string;
  };

  const matchedCandidatesByPositionKey = new Map<
    string,
    MatchedCandidateResolution[]
  >();
  const ambiguousCandidatesByPositionKey = new Map<
    string,
    AmbiguousCandidateResolution[]
  >();

  const completedAtFallback = stage2?.completed_at ?? run.completed_at ?? run.started_at;

  for (const reviewedCandidate of reviewedCandidates) {
    if (!isRecord(reviewedCandidate)) continue;
    const explicitPositionKey = readString(reviewedCandidate.position_key);
    if (explicitPositionKey) {
      const analysis = buildActivePositionAnalysisFromReviewedCandidate(
        reviewedCandidate,
        {
          runId: run.id,
          recoveryStatus: "recovered",
          recoverySource: "current-run",
          recoveryMatchMethod: "position_key",
          recoveryReason:
            "Recovered from the latest Stage 2 reviewed candidate matched by position key.",
          completedAtFallback,
        },
      );
      const current = matchedCandidatesByPositionKey.get(explicitPositionKey) ?? [];
      current.push({
        analysis,
        matchMethod: "position_key",
        reason:
          "Recovered from the latest Stage 2 reviewed candidate matched by position key.",
        score: 100,
        completedAt:
          analysis?.llmCompletedAt ?? latestBreakdownTimestamp(analysis?.llmBreakdown ?? []),
      });
      matchedCandidatesByPositionKey.set(explicitPositionKey, current);
      continue;
    }

    const positionMatch = BullpenEventIdentityResolver.resolveMatch({
      target: buildBullpenEventIdentityFromRecord(reviewedCandidate),
      candidates: activePositions,
      getIdentity: (position) => buildBullpenEventIdentityFromPosition(position),
      getSortTimestamp: (position) => position.closeTime,
    });
    const primaryMethod =
      positionMatch.match?.primaryMethod ?? positionMatch.matches[0]?.primaryMethod ?? null;
    const matchLabel = describeBullpenEventMatchMethod(primaryMethod);

    if (positionMatch.status === "matched" && positionMatch.match) {
      const analysis = buildActivePositionAnalysisFromReviewedCandidate(
        reviewedCandidate,
        {
          runId: run.id,
          recoveryStatus: "recovered",
          recoverySource: "current-run",
          recoveryMatchMethod: primaryMethod,
          recoveryReason: `Recovered from the latest Stage 2 reviewed candidate matched by ${matchLabel}.`,
          completedAtFallback,
        },
      );
      const positionKey = positionMatch.match.item.key;
      const current = matchedCandidatesByPositionKey.get(positionKey) ?? [];
      current.push({
        analysis,
        matchMethod: primaryMethod,
        reason: `Recovered from the latest Stage 2 reviewed candidate matched by ${matchLabel}.`,
        score: positionMatch.match.score,
        completedAt:
          analysis?.llmCompletedAt ?? latestBreakdownTimestamp(analysis?.llmBreakdown ?? []),
      });
      matchedCandidatesByPositionKey.set(positionKey, current);
      continue;
    }

    if (positionMatch.status === "ambiguous" && positionMatch.matches.length > 0) {
      for (const candidate of positionMatch.matches) {
        const current = ambiguousCandidatesByPositionKey.get(candidate.item.key) ?? [];
        current.push({
          matchMethod: primaryMethod,
          reason: positionMatch.reason,
        });
        ambiguousCandidatesByPositionKey.set(candidate.item.key, current);
      }
    }
  }

  const selectBestMatchedCandidate = (
    candidates: MatchedCandidateResolution[],
  ) =>
    [...candidates].sort((left, right) => {
      const leftValid = hasBullpenValidActivePositionOdds(left.analysis);
      const rightValid = hasBullpenValidActivePositionOdds(right.analysis);
      if (leftValid !== rightValid) return rightValid ? 1 : -1;
      if (right.score !== left.score) return right.score - left.score;
      const rightTime = right.completedAt ? Date.parse(right.completedAt) : 0;
      const leftTime = left.completedAt ? Date.parse(left.completedAt) : 0;
      return rightTime - leftTime;
    })[0] ?? null;

  const buildFallbackAnalysis = ({
    currentAnalysis,
    snapshotAnalysis,
    unresolvedStatus,
    unresolvedReason,
    matchMethod,
  }: {
    currentAnalysis: BullpenActivePositionLlmAnalysis | null | undefined;
    snapshotAnalysis: BullpenActivePositionLlmAnalysis | null | undefined;
    unresolvedStatus:
      | "last-known-good/stale"
      | "ambiguous"
      | "unrecoverable";
    unresolvedReason: string;
    matchMethod: BullpenActivePositionLlmAnalysis["llmRecoveryMatchMethod"];
  }) => {
    const preferredFallback = pickPreferredBullpenActivePositionAnalysis(
      snapshotAnalysis,
      currentAnalysis,
    );
    const fallbackSource =
      preferredFallback === snapshotAnalysis
        ? "latest-snapshot"
        : preferredFallback
          ? "last-known-good"
          : null;

    if (preferredFallback && hasBullpenValidActivePositionOdds(preferredFallback)) {
      return {
        ...preferredFallback,
        llmRecoveryStatus: "last-known-good/stale",
        llmRecoverySource: fallbackSource,
        llmRecoveryMatchMethod: matchMethod,
        llmRecoveryRunId: run.id,
        llmRecoveryReason: unresolvedReason,
      } satisfies BullpenActivePositionLlmAnalysis;
    }

    return {
      ...createEmptyBullpenActivePositionLlmAnalysis(),
      llmRecoveryStatus: unresolvedStatus,
      llmRecoverySource: fallbackSource,
      llmRecoveryMatchMethod: matchMethod,
      llmRecoveryRunId: run.id,
      llmRecoveryReason: unresolvedReason,
    } satisfies BullpenActivePositionLlmAnalysis;
  };

  let changed = false;
  const nextAnalyses = { ...currentAnalyses };

  for (const position of activePositions) {
    const matchedCandidates = matchedCandidatesByPositionKey.get(position.key) ?? [];
    const ambiguousCandidates =
      ambiguousCandidatesByPositionKey.get(position.key) ?? [];
    if (matchedCandidates.length === 0 && ambiguousCandidates.length === 0) {
      continue;
    }

    const currentAnalysis = currentAnalyses[position.key];
    const snapshotAnalysis = snapshotAnalysesByKey[position.key];
    const bestMatchedCandidate = selectBestMatchedCandidate(matchedCandidates);
    let nextAnalysis: BullpenActivePositionLlmAnalysis | null = null;

    if (bestMatchedCandidate?.analysis) {
      if (hasBullpenValidActivePositionOdds(bestMatchedCandidate.analysis)) {
        nextAnalysis =
          pickPreferredBullpenActivePositionAnalysis(
          currentAnalysis,
          bestMatchedCandidate.analysis,
          ) ?? bestMatchedCandidate.analysis;
      } else {
        nextAnalysis = buildFallbackAnalysis({
          currentAnalysis,
          snapshotAnalysis,
          unresolvedStatus: "unrecoverable",
          unresolvedReason:
            bestMatchedCandidate.reason +
            " The latest run did not yield a valid normalized Yes/No consensus pair.",
          matchMethod: bestMatchedCandidate.matchMethod,
        });
      }
    } else if (ambiguousCandidates.length > 0) {
      nextAnalysis = buildFallbackAnalysis({
        currentAnalysis,
        snapshotAnalysis,
        unresolvedStatus: "ambiguous",
        unresolvedReason: ambiguousCandidates[0]?.reason ?? "The latest run matched multiple active positions ambiguously.",
        matchMethod: ambiguousCandidates[0]?.matchMethod ?? "title",
      });
    }

    if (!nextAnalysis) continue;
    if (JSON.stringify(nextAnalyses[position.key]) === JSON.stringify(nextAnalysis)) {
      continue;
    }

    nextAnalyses[position.key] = nextAnalysis;
    changed = true;
  }

  const knownPositionKeys = new Set(activePositions.map((position) => position.key));
  for (const [positionKey, matchedCandidates] of matchedCandidatesByPositionKey.entries()) {
    if (knownPositionKeys.has(positionKey)) continue;
    const bestMatchedCandidate = selectBestMatchedCandidate(matchedCandidates);
    if (!bestMatchedCandidate?.analysis) continue;

    const nextAnalysis =
      hasBullpenValidActivePositionOdds(bestMatchedCandidate.analysis)
        ? pickPreferredBullpenActivePositionAnalysis(
            currentAnalyses[positionKey],
            bestMatchedCandidate.analysis,
          ) ?? bestMatchedCandidate.analysis
        : buildFallbackAnalysis({
            currentAnalysis: currentAnalyses[positionKey],
            snapshotAnalysis: snapshotAnalysesByKey[positionKey],
            unresolvedStatus: "unrecoverable",
            unresolvedReason:
              bestMatchedCandidate.reason +
              " The latest run did not yield a valid normalized Yes/No consensus pair.",
            matchMethod: bestMatchedCandidate.matchMethod,
          });

    if (JSON.stringify(nextAnalyses[positionKey]) === JSON.stringify(nextAnalysis)) {
      continue;
    }

    nextAnalyses[positionKey] = nextAnalysis;
    changed = true;
  }

  return changed ? nextAnalyses : currentAnalyses;
}

export function syncBullpenAutoRunSummarySnapshots({
  snapshotsByMode,
  summary,
  run,
  fallbackMode = null,
}: {
  snapshotsByMode: SnapshotMap;
  summary: BullpenAutoLiveSummaryResponse;
  run: BullpenAutoLiveRun | null;
  fallbackMode?: ScanMode | null;
}) {
  if (!run) return snapshotsByMode;

  const stage1 = findWorkflowStage(run, "scan", 1);
  const stage1Outputs = readStageOutputs(stage1);
  const mode = readScanMode(stage1Outputs.mode) ?? fallbackMode;
  if (!mode) return snapshotsByMode;

  const acceptedCandidates = readAcceptedCandidates(stage1);
  const stage2 = findWorkflowStage(run, "llm", 2);
  const reviewedCandidateFallback = readReviewedCandidates(stage2).filter(
    (candidate) => {
      if (!isRecord(candidate)) return false;
      const sourceKind = readString(candidate.source_kind);
      return (
        sourceKind === "candidate" ||
        (sourceKind !== "active_position" && !readString(candidate.position_key))
      );
    },
  );
  // Older or aggressively compacted projections may omit Stage 1's candidate
  // rows while retaining Stage 2's reviewed candidate identities. Never leave
  // Auto Scan pinned to an old snapshot when the completed run still contains
  // enough durable evidence to rebuild the table.
  const snapshotCandidates =
    acceptedCandidates.length > 0
      ? acceptedCandidates
      : reviewedCandidateFallback;
  if (snapshotCandidates.length === 0) return snapshotsByMode;

  const currentHistory = snapshotsByMode[mode];
  const currentSnapshot = currentHistory.current;
  const snapshotId =
    readString(stage1Outputs.snapshot_id) ??
    currentSnapshot?.snapshotId ??
    `bullpen-auto-live-${run.id}`;
  const sourceLabel =
    readString(stage1Outputs.scan_source_label) ??
    currentSnapshot?.sourceLabel ??
    "Bullpen Auto-Run";
  const sourceUrl =
    readString(stage1Outputs.scan_source_url) ??
    currentSnapshot?.sourceUrl ??
    BULLPEN_SOURCE_URLS[mode];
  const scannedAt =
    stage1?.completed_at ?? readString(stage1Outputs.scanned_at) ?? run.completed_at ?? run.started_at;
  const totalCandidates =
    readNumber(stage1Outputs.scanned_candidates) ?? snapshotCandidates.length;
  const existingQuestionById = new Map(
    (currentSnapshot?.questions ?? []).map((question) => [question.id, question] as const),
  );
  const nextSnapshotBase: BullpenScanSnapshot = {
    mode,
    snapshotId,
    archivedAt: null,
    sourceLabel,
    sourceUrl,
    scannedAt,
    filters: currentSnapshot?.filters ?? snapshotsByMode[mode].current?.filters ?? {
      ...createBullpenScanFilters(mode),
    },
    totalCandidates,
    questions: snapshotCandidates.map((candidate) => {
      const record = isRecord(candidate) ? candidate : {};
      const questionId =
        readString(record.question_id) ??
        readString(record.market_id) ??
        readString(record.slug);
      return buildQuestionFromAcceptedCandidate({
        candidate,
        existingQuestion: questionId ? existingQuestionById.get(questionId) ?? null : null,
        sourceUrl,
        preserveExistingLlm: false,
      });
    }),
  };
  const runDecisions = summary.recent_decisions.filter((decision) => decision.run_id === run.id);
  const snapshotWithStage2Outputs = applyStage2OutputsToSnapshot({
    snapshot: nextSnapshotBase,
    run,
  });
  const nextSnapshot = applyDecisionOutputsToSnapshot({
    snapshot: snapshotWithStage2Outputs,
    run,
    decisions: runDecisions,
  });

  if (JSON.stringify(currentSnapshot) === JSON.stringify(nextSnapshot)) {
    return snapshotsByMode;
  }

  const nextHistory =
    currentSnapshot && currentSnapshot.snapshotId !== nextSnapshot.snapshotId
      ? [
          archiveBullpenScanSnapshot(currentSnapshot),
          ...currentHistory.history.filter(
            (snapshot) => snapshot.snapshotId !== currentSnapshot.snapshotId,
          ),
        ].slice(0, MAX_SYNCED_SNAPSHOT_HISTORY)
      : currentHistory.history;

  return {
    ...snapshotsByMode,
    [mode]: {
      current: nextSnapshot,
      history: nextHistory,
    },
  };
}

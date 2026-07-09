"use client";

import {
  BULLPEN_SOURCE_URLS,
  archiveBullpenScanSnapshot,
  computeBullpenLlmConsensus,
  createBullpenScanFilters,
  createBullpenQuestionRow,
  summarizeBullpenLlmNotes,
  type BullpenLlmDisagreementCategory,
  type BullpenLlmDisagreementLevel,
  type BullpenQuestionLlmBreakdownItem,
  type BullpenQuestionRow,
  type BullpenScanSnapshot,
  type BullpenSnapshotHistory,
  type ScanMode,
} from "@/lib/bullpen-ai";
import type { BullpenActivePositionLlmAnalysis } from "@/lib/bullpenActivePositions";
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
}: {
  candidate: unknown;
  existingQuestion: BullpenQuestionRow | null;
  sourceUrl: string;
}) {
  const record = isRecord(candidate) ? candidate : {};
  const questionId =
    readString(record.question_id) ??
    readString(record.market_id) ??
    readString(record.slug) ??
    readString(record.question) ??
    readString(record.market_title) ??
    `bullpen-auto-run-${Math.random().toString(36).slice(2, 10)}`;
  const questionLabel =
    readString(record.question) ??
    readString(record.market_title) ??
    existingQuestion?.question ??
    questionId;
  const baseQuestion =
    existingQuestion ??
    createBaseQuestionRow({
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
    llmYesOdds: readNumber(record.llm_yes_odds) ?? baseQuestion.llmYesOdds,
    llmNoOdds: readNumber(record.llm_no_odds) ?? baseQuestion.llmNoOdds,
    llmDisagreementLevel:
      readDisagreementLevel(record.llm_disagreement_level) ??
      baseQuestion.llmDisagreementLevel,
    llmDisagreementCategory:
      readDisagreementCategory(record.llm_disagreement_category) ??
      baseQuestion.llmDisagreementCategory,
    adjudicationRequired:
      readBoolean(record.adjudication_required) ?? baseQuestion.adjudicationRequired,
    evidenceStatus: readString(record.evidence_status) ?? baseQuestion.evidenceStatus,
    eventState: readString(record.event_state) ?? baseQuestion.eventState,
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

function buildActivePositionAnalysisFromReviewedCandidate(
  reviewedCandidate: Record<string, unknown>,
): BullpenActivePositionLlmAnalysis | null {
  const llmBreakdown = buildReviewedCandidateBreakdown(reviewedCandidate);
  const consensus = computeBullpenLlmConsensus(llmBreakdown);
  const llmCompletedAt = latestBreakdownTimestamp(llmBreakdown);
  const llmProvider =
    llmBreakdown.length === 1 ? llmBreakdown[0]?.provider ?? null : null;
  const llmModel =
    llmBreakdown.length === 1 ? llmBreakdown[0]?.model ?? null : null;
  const llmYesOdds =
    readNumber(reviewedCandidate.fair_yes_probability_pct) ??
    consensus.consensusYesOdds;
  const llmNoOdds =
    readNumber(reviewedCandidate.fair_no_probability_pct) ??
    consensus.consensusNoOdds;

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
    llmRunId: null,
    llmCompletedAt,
    preflightEvidenceBlock: null,
    llmBreakdown,
  };
}

function buildQuestionIdMaps(stage: BullpenAutoLiveStageResult | null) {
  const marketIdToQuestionId = new Map<string, string>();
  const slugToQuestionId = new Map<string, string>();

  for (const candidate of readAcceptedCandidates(stage)) {
    if (!isRecord(candidate)) continue;
    const questionId = readString(candidate.question_id) ?? readString(candidate.market_id);
    const marketId = readString(candidate.market_id);
    const slug = readString(candidate.slug);
    if (questionId && marketId) {
      marketIdToQuestionId.set(marketId, questionId);
    }
    if (questionId && slug) {
      slugToQuestionId.set(slug, questionId);
    }
  }

  return { marketIdToQuestionId, slugToQuestionId };
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

  const stage1 = findWorkflowStage(run, "scan", 1);
  const { marketIdToQuestionId, slugToQuestionId } = buildQuestionIdMaps(stage1);
  const questionById = new Map(snapshot.questions.map((question) => [question.id, question] as const));
  let changed = false;

  for (const decision of decisions) {
    if (!Array.isArray(decision.llm_outputs) || decision.llm_outputs.length === 0) {
      continue;
    }
    const targetQuestionId =
      marketIdToQuestionId.get(decision.market_id) ??
      (decision.slug ? slugToQuestionId.get(decision.slug) : null) ??
      decision.market_id;
    const question = questionById.get(targetQuestionId);
    if (!question) continue;

    const stage2 = decision.stage_results.find((stage) => stage.stage_number === 2) ?? null;
    const llmBreakdown = decision.llm_outputs.map((llmOutput) =>
      buildDecisionBreakdownItem({
        llmOutput,
        stage2,
      }),
    );
    const nextCloseTime = decision.close_time ?? question.closeTime;
    const nextQuestion = createBullpenQuestionRow({
      ...question,
      marketUrl: decision.market_url ?? question.marketUrl,
      slug: decision.slug ?? question.slug,
      closeTime: nextCloseTime,
      category: readCandidateCategory(
        decision as unknown as Record<string, unknown>,
        question.category,
      ),
      llmYesOdds: decision.fair_yes_probability_pct ?? question.llmYesOdds,
      llmNoOdds: decision.fair_no_probability_pct ?? question.llmNoOdds,
      evidenceStatus: decision.evidence_status ?? question.evidenceStatus,
      eventState: decision.event_state ?? question.eventState,
      adjudicationRequired: decision.adjudication_required,
      llmDisagreementLevel:
        readDisagreementLevel(decision.disagreement_level) ??
        question.llmDisagreementLevel,
      daysUntilClose:
        calculateDaysUntilClose(nextCloseTime) ?? question.daysUntilClose,
      llmCompletedAt:
        llmBreakdown
          .map((entry) => entry.timestamp)
          .filter((timestamp): timestamp is string => Boolean(timestamp))
          .sort()
          .at(-1) ?? question.llmCompletedAt,
      llmBreakdown,
    });

    if (JSON.stringify(nextQuestion) !== JSON.stringify(question)) {
      questionById.set(targetQuestionId, nextQuestion);
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
  const stage1 = findWorkflowStage(run, "scan", 1);
  const stage2 = findWorkflowStage(run, "llm", 2);
  const reviewedCandidates = readReviewedCandidates(stage2);
  if (reviewedCandidates.length === 0) return snapshot;

  const { marketIdToQuestionId, slugToQuestionId } = buildQuestionIdMaps(stage1);
  const questionById = new Map(snapshot.questions.map((question) => [question.id, question] as const));
  let changed = false;

  for (const reviewedCandidate of reviewedCandidates) {
    if (!isRecord(reviewedCandidate)) continue;

    const marketId = readString(reviewedCandidate.market_id);
    const slug = readString(reviewedCandidate.slug);
    const targetQuestionId =
      (marketId ? marketIdToQuestionId.get(marketId) : null) ??
      (slug ? slugToQuestionId.get(slug) : null) ??
      marketId ??
      slug;
    if (!targetQuestionId) continue;

    const question = questionById.get(targetQuestionId);
    if (!question) continue;

    const nextCloseTime = readString(reviewedCandidate.close_time) ?? question.closeTime;
    const llmBreakdown = buildReviewedCandidateBreakdown(reviewedCandidate);
    const consensus = computeBullpenLlmConsensus(llmBreakdown);
    const llmCompletedAt =
      latestBreakdownTimestamp(llmBreakdown) ??
      stage2?.completed_at ??
      question.llmCompletedAt;
    const nextQuestion = createBullpenQuestionRow({
      ...question,
      marketUrl: readString(reviewedCandidate.market_url) ?? question.marketUrl,
      category: readCandidateCategory(reviewedCandidate, question.category),
      closeTime: nextCloseTime,
      llmYesOdds:
        readNumber(reviewedCandidate.fair_yes_probability_pct) ??
        consensus.consensusYesOdds ??
        question.llmYesOdds,
      llmNoOdds:
        readNumber(reviewedCandidate.fair_no_probability_pct) ??
        consensus.consensusNoOdds ??
        question.llmNoOdds,
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
          : question.llmNotes,
      llmProvider:
        llmBreakdown.length === 1 ? llmBreakdown[0]?.provider ?? null : question.llmProvider,
      llmModel:
        llmBreakdown.length === 1 ? llmBreakdown[0]?.model ?? null : question.llmModel,
      llmCompletedAt,
      llmBreakdown: llmBreakdown.length > 0 ? llmBreakdown : question.llmBreakdown,
      daysUntilClose:
        calculateDaysUntilClose(nextCloseTime) ?? question.daysUntilClose,
    });

    if (JSON.stringify(nextQuestion) !== JSON.stringify(question)) {
      questionById.set(targetQuestionId, nextQuestion);
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
}: {
  currentAnalyses: Record<string, BullpenActivePositionLlmAnalysis>;
  run: BullpenAutoLiveRun | null;
}) {
  if (!run) return currentAnalyses;

  const stage2 = findWorkflowStage(run, "llm", 2);
  const reviewedCandidates = readReviewedCandidates(stage2);
  if (reviewedCandidates.length === 0) return currentAnalyses;

  let changed = false;
  const nextAnalyses = { ...currentAnalyses };

  for (const reviewedCandidate of reviewedCandidates) {
    if (!isRecord(reviewedCandidate)) continue;
    if (readString(reviewedCandidate.source_kind) !== "active_position") continue;

    const positionKey = readString(reviewedCandidate.position_key);
    if (!positionKey) continue;

    const analysis = buildActivePositionAnalysisFromReviewedCandidate(reviewedCandidate);
    if (!analysis) continue;

    if (JSON.stringify(nextAnalyses[positionKey]) === JSON.stringify(analysis)) {
      continue;
    }

    nextAnalyses[positionKey] = analysis;
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
  if (acceptedCandidates.length === 0) return snapshotsByMode;

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
    readNumber(stage1Outputs.scanned_candidates) ?? acceptedCandidates.length;
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
    questions: acceptedCandidates.map((candidate) => {
      const record = isRecord(candidate) ? candidate : {};
      const questionId =
        readString(record.question_id) ??
        readString(record.market_id) ??
        readString(record.slug);
      return buildQuestionFromAcceptedCandidate({
        candidate,
        existingQuestion: questionId ? existingQuestionById.get(questionId) ?? null : null,
        sourceUrl,
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

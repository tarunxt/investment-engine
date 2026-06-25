"use client";

import {
  BULLPEN_SOURCE_URLS,
  createBullpenScanFilters,
  createBullpenQuestionRow,
  type BullpenLlmDisagreementCategory,
  type BullpenLlmDisagreementLevel,
  type BullpenQuestionLlmBreakdownItem,
  type BullpenQuestionRow,
  type BullpenScanSnapshot,
  type BullpenSnapshotHistory,
  type ScanMode,
} from "@/lib/bullpen-ai";
import type {
  BullpenAutoLiveDecision,
  BullpenAutoLiveLlmOutput,
  BullpenAutoLiveRun,
  BullpenAutoLiveStageResult,
  BullpenAutoLiveSummaryResponse,
} from "@/types/api";

type SnapshotMap = Record<ScanMode, BullpenSnapshotHistory>;

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

function stringifyNumericValue(value: unknown) {
  const numeric = readNumber(value);
  return numeric === null ? null : String(numeric);
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
      category: readString(record.theme) ?? "Uncategorized",
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
    category: readString(record.theme) ?? baseQuestion.category,
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
    const nextQuestion = createBullpenQuestionRow({
      ...question,
      marketUrl: decision.market_url ?? question.marketUrl,
      slug: decision.slug ?? question.slug,
      closeTime: decision.close_time ?? question.closeTime,
      category: decision.theme || question.category,
      llmYesOdds: decision.fair_yes_probability_pct ?? question.llmYesOdds,
      llmNoOdds: decision.fair_no_probability_pct ?? question.llmNoOdds,
      evidenceStatus: decision.evidence_status ?? question.evidenceStatus,
      eventState: decision.event_state ?? question.eventState,
      adjudicationRequired: decision.adjudication_required,
      llmDisagreementLevel:
        readDisagreementLevel(decision.disagreement_level) ??
        question.llmDisagreementLevel,
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
  const nextSnapshot = applyDecisionOutputsToSnapshot({
    snapshot: nextSnapshotBase,
    run,
    decisions: runDecisions,
  });

  if (JSON.stringify(currentSnapshot) === JSON.stringify(nextSnapshot)) {
    return snapshotsByMode;
  }

  return {
    ...snapshotsByMode,
    [mode]: {
      ...currentHistory,
      current: nextSnapshot,
    },
  };
}

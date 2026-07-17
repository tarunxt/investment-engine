import type {
  BullpenLlmDirection,
  BullpenQuestionLlmBreakdownItem,
  BullpenQuestionRow,
} from "./bullpen-ai";
import { classifyBullpenLlmDirection } from "./bullpen-ai";
import {
  BullpenEventIdentityResolver,
  buildBullpenEventIdentity,
  buildBullpenEventIdentityFromDecision,
  buildBullpenEventIdentityFromPosition,
  buildBullpenEventIdentityFromQuestion,
  buildBullpenEventIdentityFromRecord,
} from "./bullpenEventIdentityResolver";
import type { BullpenActivePositionView } from "./bullpenPositions";
import type {
  BullpenAutoLiveDecision,
  BullpenAutoLiveRun,
  BullpenAutoLiveStageResult,
} from "@/types/api";

export type BullpenHistoricalAssessmentRow = {
  id: string;
  provider: string;
  model: string;
  direction: BullpenLlmDirection | null;
  llmYesOdds: number | null;
  llmNoOdds: number | null;
  timestamp: string | null;
  rationale: string | null;
  evidenceStatus: string | null;
  eventState: string | null;
  confidence: string | null;
  keyEvidence: string[];
  redFlags: string[];
  rationaleOddsMismatch: boolean;
  rationaleOddsMismatchReason: string | null;
  effectiveWeight: number | null;
  webSearchUsed: boolean | null;
  webSearchQueries: string[];
  webSources: string[];
  internetVerified: boolean | null;
  evidenceBlockUsed: boolean;
  staleFactDetected: boolean;
  invalidReason: string | null;
  invalidStaleFact: boolean;
  staleFactReason: string | null;
  runId: string | number | null;
  runTimestamp: string | null;
  runDecisionLabel: string | null;
  runDecisionSummary: string | null;
  source: "question-breakdown" | "auto-live-run";
};

export type BullpenHistoricalAssessmentGroup = {
  id: string;
  isLatest: boolean;
  latestTimestamp: string | null;
  decisionLabel: string | null;
  decisionSummary: string | null;
  rows: BullpenHistoricalAssessmentRow[];
};

type BuildBullpenHistoricalAssessmentRowsArgs = {
  question?: BullpenQuestionRow | null;
  position?: BullpenActivePositionView | null;
  runs?: BullpenAutoLiveRun[] | null;
  decisions?: BullpenAutoLiveDecision[] | null;
};

function compareIsoTimestampsDesc(
  left: string | null | undefined,
  right: string | null | undefined,
) {
  const leftTime = left ? Date.parse(left) : Number.NEGATIVE_INFINITY;
  const rightTime = right ? Date.parse(right) : Number.NEGATIVE_INFINITY;
  return rightTime - leftTime;
}

function readRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
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
  return typeof value === "boolean" ? value : null;
}

function readStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : null))
    .filter((item): item is string => Boolean(item));
}

function findStageTwo(run: BullpenAutoLiveRun) {
  return run.stage_results.find((stage) => stage.stage_number === 2) ?? null;
}

function getReviewedRows(stage: BullpenAutoLiveStageResult | null) {
  if (!stage) return [];
  const candidateRows = stage.outputs?.llm_reviewed_candidates;
  if (!Array.isArray(candidateRows)) return [];
  return candidateRows
    .map((row) => readRecord(row))
    .filter((row): row is Record<string, unknown> => Boolean(row));
}

function formatDecisionActionLabel(
  decision: BullpenAutoLiveDecision | null,
) {
  if (!decision) return null;

  const actionLabel = {
    BUY_NEW: "Buy",
    ADD_MORE: "Add More",
    HOLD: "Hold",
    TRIM: "Trim",
    EXIT: "Exit",
    SKIP: "Skip",
  }[decision.decision] ?? decision.decision;

  return decision.side ? `${actionLabel} ${decision.side}` : actionLabel;
}

function buildQuestionBreakdownRowId(
  entry: BullpenQuestionLlmBreakdownItem,
  question: BullpenQuestionRow,
) {
  return [
    "question",
    question.id,
    question.llmRunId ?? "run",
    entry.provider,
    entry.model,
    entry.timestamp ?? "timestamp",
  ].join("::");
}

function buildQuestionBreakdownRow(
  question: BullpenQuestionRow,
  entry: BullpenQuestionLlmBreakdownItem,
): BullpenHistoricalAssessmentRow {
  const direction =
    entry.direction ??
    classifyBullpenLlmDirection(entry.llmYesOdds) ??
    null;
  return {
    id: buildQuestionBreakdownRowId(entry, question),
    provider: entry.provider,
    model: entry.model,
    direction,
    llmYesOdds: entry.llmYesOdds,
    llmNoOdds: entry.llmNoOdds,
    timestamp: entry.timestamp ?? null,
    rationale: entry.rationale ?? null,
    evidenceStatus: entry.evidenceStatus ?? null,
    eventState: entry.eventState ?? null,
    confidence: entry.confidence ?? null,
    keyEvidence: entry.keyEvidence ?? [],
    redFlags: entry.redFlags ?? [],
    rationaleOddsMismatch: Boolean(entry.rationaleOddsMismatch),
    rationaleOddsMismatchReason: entry.rationaleOddsMismatchReason ?? null,
    effectiveWeight: entry.effectiveWeight ?? null,
    webSearchUsed: entry.webSearchUsed ?? null,
    webSearchQueries: entry.webSearchQueries ?? [],
    webSources: entry.webSources ?? [],
    internetVerified: entry.internetVerified ?? null,
    evidenceBlockUsed: Boolean(entry.evidenceBlockUsed),
    staleFactDetected: Boolean(entry.staleFactDetected),
    invalidReason: entry.invalidReason ?? null,
    invalidStaleFact: Boolean(entry.invalidStaleFact),
    staleFactReason: entry.staleFactReason ?? null,
    runId: question.llmRunId ?? entry.runId ?? null,
    runTimestamp: question.llmCompletedAt ?? entry.timestamp ?? null,
    runDecisionLabel: null,
    runDecisionSummary: null,
    source: "question-breakdown",
  };
}

function buildRunBreakdownRowId(
  run: BullpenAutoLiveRun,
  output: Record<string, unknown>,
  index: number,
) {
  return [
    "run",
    run.id,
    readString(output.provider) ?? "provider",
    readString(output.model) ?? "model",
    readString(output.completed_at) ?? `output-${index}`,
  ].join("::");
}

function buildRunBreakdownRows({
  run,
  reviewedRow,
  decision,
}: {
  run: BullpenAutoLiveRun;
  reviewedRow: Record<string, unknown>;
  decision: BullpenAutoLiveDecision | null;
}) {
  const outputsValue = reviewedRow.llm_outputs;
  if (!Array.isArray(outputsValue)) return [];

  const questionRuntime = readRecord(reviewedRow.question_runtime);
  const webSearchQueries = readStringArray(
    questionRuntime?.web_search_queries ??
      questionRuntime?.webSearchQueries ??
      [],
  );
  const webSources = readStringArray(
    questionRuntime?.web_sources ?? questionRuntime?.webSources ?? [],
  );
  const webSearchUsed = readBoolean(
    questionRuntime?.web_search_used ?? questionRuntime?.webSearchUsed,
  );
  const evidenceBlockUsed =
    readBoolean(
      questionRuntime?.evidence_block_used ??
        questionRuntime?.evidenceBlockUsed,
    ) ?? false;
  const internetVerified = readBoolean(
    questionRuntime?.internet_verified ?? questionRuntime?.internetVerified,
  );
  const staleFactDetected =
    readBoolean(
      questionRuntime?.stale_fact_detected ??
        questionRuntime?.staleFactDetected,
    ) ?? false;
  const staleFactReason =
    readString(
      questionRuntime?.stale_fact_reason ?? questionRuntime?.staleFactReason,
    ) ?? null;
  const defaultInvalidReason =
    readString(
      questionRuntime?.invalid_reason ?? questionRuntime?.invalidReason,
    ) ?? null;

  return outputsValue
    .map((item) => readRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((output, index) => {
      const yesOdds = readNumber(output.llm_yes_odds ?? output.llmYesOdds);
      const direction =
        (readString(output.direction) as BullpenLlmDirection | null) ??
        classifyBullpenLlmDirection(yesOdds) ??
        null;
      const rationale =
        readString(output.rationale) ??
        readString(output.error) ??
        readString(output.invalid_reason) ??
        defaultInvalidReason;

      return {
        id: buildRunBreakdownRowId(run, output, index),
        provider: readString(output.provider) ?? "Unknown",
        model: readString(output.model) ?? "Unknown",
        direction,
        llmYesOdds: yesOdds,
        llmNoOdds: readNumber(output.llm_no_odds ?? output.llmNoOdds),
        timestamp:
          readString(output.completed_at) ??
          readString(output.created_at) ??
          readString(output.started_at) ??
          run.completed_at ??
          run.started_at,
        rationale,
        evidenceStatus:
          readString(output.evidence_status) ??
          readString(reviewedRow.evidence_status),
        eventState:
          readString(output.event_state) ??
          readString(reviewedRow.event_state),
        confidence:
          readString(output.confidence) ?? readString(reviewedRow.confidence),
        keyEvidence: readStringArray(output.key_evidence),
        redFlags: readStringArray(output.red_flags),
        rationaleOddsMismatch:
          readBoolean(
            output.rationale_odds_mismatch ?? output.rationaleOddsMismatch,
          ) ?? false,
        rationaleOddsMismatchReason:
          readString(
            output.rationale_odds_mismatch_reason ??
              output.rationaleOddsMismatchReason,
          ) ?? null,
        effectiveWeight:
          readNumber(output.effective_weight ?? output.effectiveWeight) ?? null,
        webSearchUsed,
        webSearchQueries,
        webSources,
        internetVerified,
        evidenceBlockUsed,
        staleFactDetected,
        invalidReason:
          readString(output.invalid_reason) ??
          readString(output.error) ??
          defaultInvalidReason,
        invalidStaleFact: staleFactDetected,
        staleFactReason,
        runId: run.id,
        runTimestamp: run.completed_at ?? run.started_at,
        runDecisionLabel: formatDecisionActionLabel(decision),
        runDecisionSummary: decision?.summary ?? decision?.reason ?? null,
        source: "auto-live-run",
      } satisfies BullpenHistoricalAssessmentRow;
    });
}

function buildDedupeKey(row: BullpenHistoricalAssessmentRow) {
  return [
    row.runId ?? "no-run",
    row.provider.trim().toLowerCase(),
    row.model.trim().toLowerCase(),
    row.timestamp ?? row.runTimestamp ?? "no-time",
    row.llmYesOdds ?? "no-yes",
    row.llmNoOdds ?? "no-no",
    (row.rationale ?? row.invalidReason ?? "empty")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ") || "empty",
  ].join("::");
}

export function isBullpenHistoricalAssessmentRowInvalid(
  row: BullpenHistoricalAssessmentRow,
) {
  const hasOutOfRangeOdds =
    row.llmYesOdds === null ||
    row.llmNoOdds === null ||
    row.llmYesOdds < 0 ||
    row.llmYesOdds > 100 ||
    row.llmNoOdds < 0 ||
    row.llmNoOdds > 100;
  return (
    hasOutOfRangeOdds ||
    Boolean(row.invalidReason) ||
    Boolean(row.invalidStaleFact)
  );
}

export function buildBullpenHistoricalAssessmentRows({
  question,
  position,
  runs,
  decisions,
}: BuildBullpenHistoricalAssessmentRowsArgs) {
  const rows: BullpenHistoricalAssessmentRow[] = [];
  const targetIdentity = question
    ? buildBullpenEventIdentityFromQuestion(question)
    : position
      ? buildBullpenEventIdentityFromPosition(position)
      : buildBullpenEventIdentity({});
  const allRuns = runs ?? [];
  const allDecisions = decisions ?? [];

  if (question?.llmBreakdown.length) {
    question.llmBreakdown.forEach((entry) => {
      rows.push(buildQuestionBreakdownRow(question, entry));
    });
  }

  allRuns.forEach((run) => {
    const reviewedRows = getReviewedRows(findStageTwo(run));
    if (reviewedRows.length === 0) return;
    const decisionMatch = BullpenEventIdentityResolver.resolveMatch({
      target: targetIdentity,
      candidates: allDecisions.filter((decision) => decision.run_id === run.id),
      getIdentity: (decision) => buildBullpenEventIdentityFromDecision(decision),
      getSortTimestamp: (decision) => decision.updated_at,
    });
    const reviewedRowMatch = BullpenEventIdentityResolver.resolveMatch({
      target: targetIdentity,
      candidates: reviewedRows,
      getIdentity: (reviewedRow) => buildBullpenEventIdentityFromRecord(reviewedRow),
    });
    if (reviewedRowMatch.status !== "matched" || !reviewedRowMatch.match) return;

    rows.push(
      ...buildRunBreakdownRows({
        run,
        reviewedRow: reviewedRowMatch.match.item,
        decision:
          decisionMatch.status === "matched" ? decisionMatch.match?.item ?? null : null,
      }),
    );
  });

  const deduped = new Map<string, BullpenHistoricalAssessmentRow>();
  rows.forEach((row) => {
    const key = buildDedupeKey(row);
    const existing = deduped.get(key);
    if (
      !existing ||
      compareIsoTimestampsDesc(existing.timestamp, row.timestamp) > 0
    ) {
      deduped.set(key, row);
    }
  });

  return [...deduped.values()].sort((left, right) => {
    const timestampOrder = compareIsoTimestampsDesc(left.timestamp, right.timestamp);
    if (timestampOrder !== 0) return timestampOrder;
    const runOrder = compareIsoTimestampsDesc(left.runTimestamp, right.runTimestamp);
    if (runOrder !== 0) return runOrder;
    const providerOrder = left.provider.localeCompare(right.provider);
    if (providerOrder !== 0) return providerOrder;
    return left.model.localeCompare(right.model);
  });
}

function buildGroupId(row: BullpenHistoricalAssessmentRow) {
  if (row.runId !== null && row.runId !== undefined) {
    return `run:${String(row.runId)}`;
  }
  if (row.runTimestamp) {
    return `timestamp:${row.runTimestamp}`;
  }
  return `row:${row.id}`;
}

export function buildBullpenHistoricalAssessmentGroups(
  rows: BullpenHistoricalAssessmentRow[],
) {
  const groupsById = new Map<
    string,
    {
      id: string;
      latestTimestamp: string | null;
      decisionLabel: string | null;
      decisionSummary: string | null;
      rows: BullpenHistoricalAssessmentRow[];
    }
  >();

  rows.forEach((row) => {
    const groupId = buildGroupId(row);
    const group = groupsById.get(groupId) ?? {
      id: groupId,
      latestTimestamp: row.timestamp ?? row.runTimestamp,
      decisionLabel: row.runDecisionLabel,
      decisionSummary: row.runDecisionSummary,
      rows: [],
    };
    const candidateTimestamp = row.timestamp ?? row.runTimestamp;
    if (
      compareIsoTimestampsDesc(group.latestTimestamp, candidateTimestamp) > 0
    ) {
      group.latestTimestamp = candidateTimestamp;
    }
    if (!group.decisionLabel && row.runDecisionLabel) {
      group.decisionLabel = row.runDecisionLabel;
    }
    if (!group.decisionSummary && row.runDecisionSummary) {
      group.decisionSummary = row.runDecisionSummary;
    }
    group.rows.push(row);
    groupsById.set(groupId, group);
  });

  return [...groupsById.values()]
    .sort((left, right) =>
      compareIsoTimestampsDesc(left.latestTimestamp, right.latestTimestamp),
    )
    .map((group, index) => ({
      id: group.id,
      isLatest: index === 0,
      latestTimestamp: group.latestTimestamp,
      decisionLabel: group.decisionLabel,
      decisionSummary: group.decisionSummary,
      rows: [...group.rows].sort((left, right) => {
        const timestampOrder = compareIsoTimestampsDesc(
          left.timestamp,
          right.timestamp,
        );
        if (timestampOrder !== 0) return timestampOrder;
        const providerOrder = left.provider.localeCompare(right.provider);
        if (providerOrder !== 0) return providerOrder;
        return left.model.localeCompare(right.model);
      }),
    })) satisfies BullpenHistoricalAssessmentGroup[];
}

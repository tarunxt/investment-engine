import type { BullpenQuestionRow } from "@/lib/bullpen-ai";
import type { BullpenAutoLiveDecision, BullpenAutoLiveRun } from "@/types/api";

import { buildBullpenAutoRunWorkflowView } from "./bullpenAutoRunProgress";
import {
  buildStageTwoEventsSummaryRows,
  getStageTwoLlmReviewedRows,
} from "./bullpenAutoRunStageTwoHistory";
import { DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MAX_POSITIONS } from "./bullpenStage2To3Strategy";

export type BullpenStage2TopTenHandoffRowStatus =
  | "planned"
  | "submitted"
  | "queued"
  | "blocked"
  | "missing-stage3";

export type BullpenStage2TopTenHandoffRow = {
  rank: number;
  marketId: string;
  question: BullpenQuestionRow;
  decision: BullpenAutoLiveDecision | null;
  displayDecision: BullpenAutoLiveDecision;
  status: BullpenStage2TopTenHandoffRowStatus;
  reason: string;
  missingFromStage3: boolean;
  missingFromBuyPlan: boolean;
};

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readStringArray(value: unknown) {
  return Array.isArray(value)
    ? value
        .map((item) => readString(item))
        .filter((item): item is string => Boolean(item))
    : [];
}

function readNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeDecisionTimestamp(
  decision: BullpenAutoLiveDecision | null | undefined,
) {
  if (!decision) return Number.NEGATIVE_INFINITY;
  const value =
    decision.order_plan?.executed_at ??
    decision.updated_at ??
    decision.created_at ??
    null;
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function rankStageResultPriority(decision: BullpenAutoLiveDecision) {
  if (decision.order_plan?.action === "buy") return 0;
  if (decision.decision === "BUY_NEW") return 1;
  if (decision.stage3_result === "SELECTED") return 2;
  return 3;
}

function selectBestDecision(decisions: BullpenAutoLiveDecision[]) {
  return [...decisions].sort((left, right) => {
    const priorityDelta =
      rankStageResultPriority(left) - rankStageResultPriority(right);
    if (priorityDelta !== 0) return priorityDelta;

    const leftRank = left.stage3_final_rank ?? Number.POSITIVE_INFINITY;
    const rightRank = right.stage3_final_rank ?? Number.POSITIVE_INFINITY;
    if (leftRank !== rightRank) return leftRank - rightRank;

    return normalizeDecisionTimestamp(right) - normalizeDecisionTimestamp(left);
  })[0] ?? null;
}

function buildDecisionLookup(decisions: BullpenAutoLiveDecision[]) {
  const grouped = new Map<string, BullpenAutoLiveDecision[]>();

  for (const decision of decisions) {
    const marketId = readString(decision.market_id);
    if (!marketId) continue;
    const existing = grouped.get(marketId) ?? [];
    existing.push(decision);
    grouped.set(marketId, existing);
  }

  const lookup = new Map<string, BullpenAutoLiveDecision>();
  for (const [marketId, groupedDecisions] of grouped.entries()) {
    const bestDecision = selectBestDecision(groupedDecisions);
    if (bestDecision) {
      lookup.set(marketId, bestDecision);
    }
  }
  return lookup;
}

function buildFallbackQuestion(
  marketId: string,
  decision: BullpenAutoLiveDecision | null,
): BullpenQuestionRow {
  const title = decision?.market_title ?? marketId;
  const llmYesOdds = decision?.fair_yes_probability_pct ?? null;
  const llmNoOdds = decision?.fair_no_probability_pct ?? null;

  return {
    id: marketId,
    question: title,
    positionKey: null,
    conditionId: null,
    marketId,
    questionId: null,
    closeTime: decision?.close_time ?? null,
    category: decision?.theme ?? "Uncategorized",
    yesOdds: decision?.current_yes_odds ?? null,
    noOdds: decision?.current_no_odds ?? null,
    currentOddsUpdatedAt: null,
    investmentTableAddedAt: null,
    volume: null,
    liquidity: null,
    sourceUrl: decision?.market_url ?? "",
    slug: decision?.slug ?? null,
    marketUrl: decision?.market_url ?? null,
    outcomeLabels: ["Yes", "No"],
    outcomeCount: 2,
    isBinaryYesNo: true,
    daysUntilClose: null,
    rules: null,
    marketContext: null,
    resolutionSource: null,
    llmYesOdds,
    llmNoOdds,
    llmAverageYesOdds: null,
    llmMedianYesOdds: null,
    llmTrimmedMeanYesOdds: null,
    llmIqrYesOdds: null,
    llmTrimmedRangeYesOdds: null,
    llmMinYesOdds: null,
    llmMaxYesOdds: null,
    llmSpreadYesOdds: null,
    llmDisagreementLevel: null,
    llmDisagreementCategory: null,
    llmRationaleMismatchCount: 0,
    adjudicationRequired: false,
    evidenceStatus: decision?.evidence_status ?? null,
    eventState: decision?.event_state ?? null,
    currentVsLlmOddsDifference: null,
    returnsPerDay: null,
    amountToBeInvested: null,
    isAmountToBeInvestedHighlighted: false,
    llmNotes: decision?.summary ?? decision?.reason ?? null,
    llmProvider: null,
    llmModel: null,
    llmRunId: decision?.run_id ?? null,
    llmCompletedAt: null,
    preflightEvidenceBlock: null,
    llmBreakdown: [],
  };
}

function findStrongerSide(question: BullpenQuestionRow) {
  const yesOdds = question.llmYesOdds ?? Number.NEGATIVE_INFINITY;
  const noOdds = question.llmNoOdds ?? Number.NEGATIVE_INFINITY;
  return yesOdds > noOdds ? "YES" : "NO";
}

function strongerCurrentOdds(question: BullpenQuestionRow, side: "YES" | "NO") {
  return side === "YES" ? question.yesOdds : question.noOdds;
}

function strongerFairOdds(question: BullpenQuestionRow, side: "YES" | "NO") {
  return side === "YES" ? question.llmYesOdds : question.llmNoOdds;
}

function buildMissingStage3Decision({
  runId,
  rank,
  question,
  reason,
}: {
  runId: string;
  rank: number;
  question: BullpenQuestionRow;
  reason: string;
}): BullpenAutoLiveDecision {
  const side = findStrongerSide(question);
  const currentOdds = strongerCurrentOdds(question, side) ?? 0;
  const fairOdds = strongerFairOdds(question, side) ?? 0;

  return {
    id: `stage2-top10-missing-${runId}-${question.marketId ?? question.id}`,
    run_id: runId,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    market_id: question.marketId ?? question.id,
    market_title: question.question,
    market_url: question.marketUrl,
    slug: question.slug,
    close_time: question.closeTime,
    theme: question.category,
    side,
    decision: "BUY_NEW",
    risk_status: "Blocked",
    price_cents: currentOdds,
    current_yes_odds: question.yesOdds,
    current_no_odds: question.noOdds,
    fair_probability_pct: fairOdds,
    fair_yes_probability_pct: question.llmYesOdds,
    fair_no_probability_pct: question.llmNoOdds,
    edge_pp:
      fairOdds !== null && currentOdds !== null
        ? Number((fairOdds - currentOdds).toFixed(2))
        : 0,
    score: question.amountToBeInvested ?? 0,
    confidence: "Medium",
    evidence_status:
      question.evidenceStatus === "Low" ||
      question.evidenceStatus === "Moderate" ||
      question.evidenceStatus === "Strong"
        ? question.evidenceStatus
        : "Moderate",
    event_state: question.eventState,
    adjudication_required: question.adjudicationRequired,
    disagreement_level: question.llmDisagreementLevel ?? null,
    current_exposure_usd: 0,
    target_exposure_usd: question.amountToBeInvested ?? 0,
    realized_pnl_usd: null,
    hours_remaining: question.daysUntilClose === null ? null : question.daysUntilClose * 24,
    key_evidence: [],
    red_flags: [],
    rationale: question.llmNotes,
    reason,
    summary: reason,
    stage3_result: "BLOCKED",
    stage3_result_reason: reason,
    stage3_final_rank: rank,
    stage3_max_positions: DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MAX_POSITIONS,
    selection_required: true,
    selected_for_auto_invest: true,
    selection_block_reason: reason,
    order_plan: null,
    exit_signals: [],
    exit_state: "ACTIVE",
    llm_outputs: [],
    stage_results: [],
    guardrail_checks: [],
  };
}

function buildStage2TopTenQuestionLookup(
  run: BullpenAutoLiveRun,
  decisions: BullpenAutoLiveDecision[],
) {
  const workflowView = buildBullpenAutoRunWorkflowView(run);
  const scanStage =
    workflowView.stages.find((stage) => stage.key === "scan") ?? null;
  const llmStage = workflowView.stages.find((stage) => stage.key === "llm") ?? null;
  if (!llmStage) return new Map<string, BullpenQuestionRow>();

  const reviewedRows = getStageTwoLlmReviewedRows(
    llmStage,
    scanStage?.scanCandidates ?? [],
  );
  const questionRows = buildStageTwoEventsSummaryRows({
    reviewedRows,
    decisions,
    runId: run.id,
    asOfTimestamp: run.completed_at ?? run.started_at,
  });
  const lookup = new Map<string, BullpenQuestionRow>();
  for (const question of questionRows) {
    const marketId = readString(question.marketId);
    if (marketId && !lookup.has(marketId)) {
      lookup.set(marketId, question);
    }
  }
  return lookup;
}

function buildTopCandidateMarketIdOrder(run: BullpenAutoLiveRun) {
  const stageResults = [...run.stage_results];
  const rankingOutputs = asRecord(
    stageResults.find((stage) => stage.stage_number === 6)?.outputs,
  );
  const investOutputs = asRecord(
    stageResults.find((stage) => {
      const outputs = asRecord(stage.outputs);
      return (
        readString(outputs?.workflow_stage_key) === "invest" ||
        stage.stage_number === 3
      );
    })?.outputs,
  );

  const marketIds = readStringArray(
    rankingOutputs?.ranking_top_candidate_market_id_order ??
      rankingOutputs?.top_candidate_market_ids ??
      rankingOutputs?.ranked_top_candidate_market_ids ??
      investOutputs?.ranking_top_candidate_market_id_order ??
      investOutputs?.top_candidate_market_ids ??
      investOutputs?.ranked_top_candidate_market_ids,
  );
  if (marketIds.length > 0) {
    return marketIds;
  }

  return decisionsFallbackFromRun(run);
}

function decisionsFallbackFromRun(run: BullpenAutoLiveRun) {
  const rankedDecisions = (run.stage_results ?? [])
    .flatMap((stage) => {
      const outputs = asRecord(stage.outputs);
      return Array.isArray(outputs?.decision_rows)
        ? outputs.decision_rows
            .map((item) => asRecord(item))
            .filter((item): item is Record<string, unknown> => Boolean(item))
        : [];
    })
    .map((record) => ({
      marketId: readString(record.market_id),
      finalRank: readNumber(record.stage3_final_rank),
    }))
    .filter(
      (
        item,
      ): item is {
        marketId: string;
        finalRank: number | null;
      } => Boolean(item.marketId),
    )
    .sort((left, right) => {
      const leftRank = left.finalRank ?? Number.POSITIVE_INFINITY;
      const rightRank = right.finalRank ?? Number.POSITIVE_INFINITY;
      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }
      return left.marketId.localeCompare(right.marketId);
    });

  return rankedDecisions.map((item) => item.marketId);
}

function buildReason(decision: BullpenAutoLiveDecision | null) {
  if (!decision) {
    return "Stage 2 Top 10 row never reached the saved Stage 3 decision rows, so it could not be planned or executed.";
  }
  return (
    readString(decision.order_plan?.detail) ??
    readString(decision.stage3_result_reason) ??
    readString(decision.summary) ??
    readString(decision.reason) ??
    "Stage 3 did not record a more specific reason."
  );
}

function buildStatus(decision: BullpenAutoLiveDecision | null): BullpenStage2TopTenHandoffRowStatus {
  if (!decision) return "missing-stage3";
  const orderStatus = readString(decision.order_plan?.status)?.toLowerCase();
  if (decision.order_plan?.action === "buy") {
    if (
      orderStatus &&
      [
        "submitted",
        "confirming",
        "partially_filled",
        "settlement_pending",
        "confirmed",
        "filled",
      ].includes(orderStatus)
    ) {
      return "submitted";
    }
    if (orderStatus === "planned") return "planned";
    return "blocked";
  }
  if (decision.decision === "BUY_NEW" && decision.stage3_result === "SELECTED") {
    return "queued";
  }
  return "blocked";
}

export function buildBullpenStage2TopTenHandoffRows({
  run,
  decisions,
}: {
  run: BullpenAutoLiveRun | null;
  decisions: BullpenAutoLiveDecision[];
}) {
  if (!run) return [] as BullpenStage2TopTenHandoffRow[];

  const topCandidateMarketIdOrder = buildTopCandidateMarketIdOrder(run);
  if (topCandidateMarketIdOrder.length === 0) {
    return [] as BullpenStage2TopTenHandoffRow[];
  }

  const questionByMarketId = buildStage2TopTenQuestionLookup(run, decisions);
  const decisionByMarketId = buildDecisionLookup(decisions);

  return topCandidateMarketIdOrder.map((marketId, index) => {
    const decision = decisionByMarketId.get(marketId) ?? null;
    const question =
      questionByMarketId.get(marketId) ?? buildFallbackQuestion(marketId, decision);
    const reason = buildReason(decision);
    const displayDecision =
      decision ??
      buildMissingStage3Decision({
        runId: run.id,
        rank: index + 1,
        question,
        reason,
      });

    return {
      rank: index + 1,
      marketId,
      question,
      decision,
      displayDecision,
      status: buildStatus(decision),
      reason,
      missingFromStage3: decision === null,
      missingFromBuyPlan: decision?.order_plan?.action !== "buy",
    } satisfies BullpenStage2TopTenHandoffRow;
  });
}

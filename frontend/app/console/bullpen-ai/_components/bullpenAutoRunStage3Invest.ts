import type {
  BullpenAutoLiveConsoleCandidateInput,
  BullpenAutoLiveDecision,
  BullpenAutoLiveLlmOutput,
  BullpenAutoLiveRun,
  BullpenAutoLiveRunOnceRequest,
} from "@/types/api";
import {
  isActiveBullpenPosition,
  type BullpenActivePositionView,
} from "@/lib/bullpenPositions";
import {
  mergeBullpenStage2To3StrategyOutputs,
  readBullpenStage2To3StrategyMetadata,
  readBullpenStage2UniverseStatus,
} from "@/lib/bullpenStage2To3Strategy";

export type BullpenStage3OnlyInvestPlan = {
  request: BullpenAutoLiveRunOnceRequest | null;
  qualifiedCandidateCount: number;
  blockedReason: string | null;
};

export const NO_STAGE2_QUALIFIED_EVENTS_REASON =
  "No Stage 2-qualified events are available to invest yet.";

export type BullpenStage3OnlyInvestSource = {
  run: BullpenAutoLiveRun | null;
  plan: BullpenStage3OnlyInvestPlan;
};

export type BullpenStage3AlreadyInvestedSource =
  | "live-position"
  | "saved-run-position"
  | "submitted-buy";

export type BullpenStage3AlreadyInvestedRecord = {
  marketId: string;
  timestamp: string | null;
  reason: string | null;
  source: BullpenStage3AlreadyInvestedSource;
};

export type BullpenStage3OnlyInvestCandidatePreview = {
  candidate: BullpenAutoLiveConsoleCandidateInput;
  status: "ready" | "already-invested";
  reason: string | null;
  investedAt: string | null;
  investedSource: BullpenStage3AlreadyInvestedSource | null;
};

export type BullpenStage3OnlyInvestExecutionPlan = {
  request: BullpenAutoLiveRunOnceRequest | null;
  qualifiedCandidateCount: number;
  readyCandidateCount: number;
  alreadyInvestedCandidateCount: number;
  alreadyInvestedMarketIds: string[];
  alreadyInvestedRecords: BullpenStage3AlreadyInvestedRecord[];
  candidatePreviews: BullpenStage3OnlyInvestCandidatePreview[];
  blockedReason: string | null;
};

export type BullpenStage3InvestPreviewStepStatus =
  | "pending"
  | "blocked"
  | "completed";

export type BullpenStage3InvestPreviewStep = {
  key: "sell" | "buy";
  stepNumber: number;
  stepTotal: number;
  label: string;
  status: BullpenStage3InvestPreviewStepStatus;
  displayStatusLabel?: string;
  detail: string;
  plannedOrders: number | null;
  processedOrders: number | null;
  submittedOrders: number | null;
  eventExitRows?: number | null;
  rankingLlmPlannedOrders?: number | null;
  forcedExitPlannedOrders?: number | null;
};

export type BullpenStage3OnlyInvestExecutionPlanOptions = {
  activePositions?: BullpenActivePositionView[];
  hasActivePositionsSnapshot?: boolean;
};

const SAVED_RUN_NON_ACTIVE_CLASSIFICATIONS = new Set([
  "closed",
  "positive_payout_claimable",
  "resolved_zero_payout",
  "settlement_pending",
  "stale_or_unknown",
]);
const RECONCILING_EXIT_ACTIONS = new Set(["sell", "redeem"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function readStringArray(value: unknown): string[] {
  return asArray(value)
    .map((item) => readString(item))
    .filter((item): item is string => Boolean(item));
}

function workflowStageOutputs(
  run: BullpenAutoLiveRun,
  workflowStageKey: string,
): Record<string, unknown> | null {
  for (const stage of run.stage_results) {
    const outputs = asRecord(stage.outputs);
    if (readString(outputs?.workflow_stage_key) === workflowStageKey) {
      return outputs;
    }
  }
  return null;
}

function stageNumberOutputs(
  run: BullpenAutoLiveRun,
  stageNumber: number,
): Record<string, unknown> | null {
  for (const stage of run.stage_results) {
    if (stage.stage_number === stageNumber) {
      return asRecord(stage.outputs);
    }
  }
  return null;
}

function resolveStage2To3StrategyOutputs(
  run: BullpenAutoLiveRun,
): Record<string, unknown> | null {
  return mergeBullpenStage2To3StrategyOutputs(
    workflowStageOutputs(run, "llm"),
    workflowStageOutputs(run, "invest"),
    stageNumberOutputs(run, 6),
  );
}

function cloneCandidateRow(
  row: BullpenAutoLiveConsoleCandidateInput,
): BullpenAutoLiveConsoleCandidateInput {
  return {
    ...row,
    llm_outputs: row.llm_outputs.map((output) => ({
      ...output,
      key_evidence: [...output.key_evidence],
      red_flags: [...output.red_flags],
    })),
  };
}

function buildAcceptedCandidateLookup(
  scanOutputs: Record<string, unknown> | null,
): Map<string, Record<string, unknown>> {
  const lookup = new Map<string, Record<string, unknown>>();
  for (const item of asArray(scanOutputs?.accepted_candidates)) {
    const record = asRecord(item);
    const marketId = readString(record?.market_id);
    if (record && marketId) {
      lookup.set(marketId, record);
    }
  }
  return lookup;
}

function synthesizeLegacyResolutionRules(
  reviewedCandidate: Record<string, unknown>,
): string | null {
  const yesDefinition = readString(reviewedCandidate.yes_definition);
  if (!yesDefinition) {
    return null;
  }
  return `This market resolves to "Yes" if ${yesDefinition}. Otherwise, it resolves to "No".`;
}

function buildExactResolutionRules(
  reviewedCandidate: Record<string, unknown>,
  acceptedCandidate: Record<string, unknown> | undefined,
): string | null {
  const stage2Context = asRecord(reviewedCandidate.stage2_context);
  const preparedQuestionPayload = asRecord(reviewedCandidate.prepared_question_payload);

  return (
    readString(stage2Context?.exact_resolution_rules) ??
    readString(preparedQuestionPayload?.polymarket_rules) ??
    readString(acceptedCandidate?.rules) ??
    readString(acceptedCandidate?.event_description) ??
    readString(acceptedCandidate?.description) ??
    synthesizeLegacyResolutionRules(reviewedCandidate)
  );
}

function buildMarketContext(
  reviewedCandidate: Record<string, unknown>,
  acceptedCandidate: Record<string, unknown> | undefined,
): string | null {
  const stage2Context = asRecord(reviewedCandidate.stage2_context);
  const preparedQuestionPayload = asRecord(reviewedCandidate.prepared_question_payload);

  return (
    readString(acceptedCandidate?.market_context) ??
    readString(stage2Context?.market_context) ??
    readString(preparedQuestionPayload?.polymarket_market_context) ??
    null
  );
}

function buildResolutionSource(
  reviewedCandidate: Record<string, unknown>,
  acceptedCandidate: Record<string, unknown> | undefined,
): string | null {
  const stage2Context = asRecord(reviewedCandidate.stage2_context);
  const preparedQuestionPayload = asRecord(reviewedCandidate.prepared_question_payload);

  return (
    readString(acceptedCandidate?.resolution_source) ??
    readString(stage2Context?.resolution_source) ??
    readString(preparedQuestionPayload?.polymarket_resolution_source) ??
    null
  );
}

function buildEventDescription(
  reviewedCandidate: Record<string, unknown>,
  acceptedCandidate: Record<string, unknown> | undefined,
  exactResolutionRules: string | null,
): string | null {
  return (
    readString(acceptedCandidate?.event_description) ??
    readString(acceptedCandidate?.description) ??
    exactResolutionRules
  );
}

function buildPreflightEvidenceBlock(
  reviewedCandidate: Record<string, unknown>,
  acceptedCandidate: Record<string, unknown> | undefined,
): string | null {
  const preparedQuestionPayload = asRecord(reviewedCandidate.prepared_question_payload);

  return (
    readString(acceptedCandidate?.preflight_evidence_block) ??
    readString(reviewedCandidate.preflight_evidence_block) ??
    readString(preparedQuestionPayload?.preflight_evidence_block) ??
    null
  );
}

function buildLlmOutputs(value: unknown): BullpenAutoLiveLlmOutput[] {
  return asArray(value)
    .map((item) => asRecord(item))
    .flatMap((record) => {
      const provider = readString(record?.provider);
      const model = readString(record?.model);
      if (!record || !provider || !model) {
        return [];
      }

      return [
        {
          provider,
          model,
          llm_yes_odds: readNumber(record.llm_yes_odds),
          llm_no_odds: readNumber(record.llm_no_odds),
          confidence: readString(record.confidence),
          evidence_status: readString(record.evidence_status),
          event_state: readString(record.event_state),
          key_evidence: readStringArray(record.key_evidence),
          red_flags: readStringArray(record.red_flags),
          rationale: readString(record.rationale),
          error: readString(record.error),
          completed_at: readString(record.completed_at),
        },
      ];
    });
}

function buildCandidateRow(
  reviewedCandidate: Record<string, unknown>,
  acceptedCandidateByMarketId: Map<string, Record<string, unknown>>,
): BullpenAutoLiveConsoleCandidateInput | null {
  const marketId = readString(reviewedCandidate.market_id);
  const marketTitle = readString(reviewedCandidate.question);
  const fairYesProbability = readNumber(reviewedCandidate.fair_yes_probability_pct);
  const fairNoProbability = readNumber(reviewedCandidate.fair_no_probability_pct);

  if (!marketId || !marketTitle || (fairYesProbability === null && fairNoProbability === null)) {
    return null;
  }

  const acceptedCandidate = acceptedCandidateByMarketId.get(marketId);
  const exactResolutionRules = buildExactResolutionRules(
    reviewedCandidate,
    acceptedCandidate,
  );

  return {
    question_id: readString(acceptedCandidate?.question_id) ?? marketId,
    market_id: marketId,
    market_title: marketTitle,
    slug: readString(reviewedCandidate.slug) ?? readString(acceptedCandidate?.slug),
    market_url:
      readString(reviewedCandidate.market_url) ?? readString(acceptedCandidate?.market_url),
    close_time:
      readString(reviewedCandidate.close_time) ?? readString(acceptedCandidate?.close_time),
    theme: readString(acceptedCandidate?.theme) ?? "Uncategorized",
    current_yes_odds: readNumber(acceptedCandidate?.current_yes_odds),
    current_no_odds: readNumber(acceptedCandidate?.current_no_odds),
    volume_usd: readNumber(acceptedCandidate?.volume_usd),
    liquidity_usd: readNumber(acceptedCandidate?.liquidity_usd),
    best_bid_cents: readNumber(acceptedCandidate?.best_bid_cents),
    best_ask_cents: readNumber(acceptedCandidate?.best_ask_cents),
    spread_cents: readNumber(acceptedCandidate?.spread_cents),
    llm_yes_odds: fairYesProbability,
    llm_no_odds: fairNoProbability,
    returns_per_day: readNumber(reviewedCandidate.returns_per_day),
    amount_to_be_invested: readNumber(acceptedCandidate?.amount_to_be_invested),
    llm_disagreement_level: readString(reviewedCandidate.disagreement_level),
    llm_disagreement_category: readString(reviewedCandidate.disagreement_category),
    adjudication_required: readBoolean(reviewedCandidate.adjudication_required),
    confidence: readString(reviewedCandidate.confidence),
    evidence_status: readString(reviewedCandidate.evidence_status),
    event_state: readString(reviewedCandidate.event_state),
    rules: exactResolutionRules,
    market_context: buildMarketContext(reviewedCandidate, acceptedCandidate),
    resolution_source: buildResolutionSource(reviewedCandidate, acceptedCandidate),
    event_description: buildEventDescription(
      reviewedCandidate,
      acceptedCandidate,
      exactResolutionRules,
    ),
    preflight_evidence_block: buildPreflightEvidenceBlock(
      reviewedCandidate,
      acceptedCandidate,
    ),
    selected: true,
    llm_outputs: buildLlmOutputs(reviewedCandidate.llm_outputs),
  };
}

export function buildBullpenStage3OnlyInvestPlan(
  run: BullpenAutoLiveRun | null,
): BullpenStage3OnlyInvestPlan {
  if (!run) {
    return {
      request: null,
      qualifiedCandidateCount: 0,
      blockedReason: "Stage 2 needs to finish before Invest can reuse qualified events.",
    };
  }

  const llmOutputs = workflowStageOutputs(run, "llm");
  if (!llmOutputs || readString(llmOutputs.phase_status) !== "completed") {
    return {
      request: null,
      qualifiedCandidateCount: 0,
      blockedReason: "Stage 2 must complete before Invest can reuse its qualified rows.",
    };
  }

  const scanOutputs = workflowStageOutputs(run, "scan");
  const topTableOutputs = stageNumberOutputs(run, 6);
  const strategyOutputs = resolveStage2To3StrategyOutputs(run);
  const strategyMetadata = readBullpenStage2To3StrategyMetadata(strategyOutputs);
  const universeStatus = readBullpenStage2UniverseStatus(strategyOutputs);
  const acceptedCandidateByMarketId = buildAcceptedCandidateLookup(scanOutputs);
  const topCandidateMarketIdOrder = readStringArray(
    topTableOutputs?.ranking_top_candidate_market_id_order ??
      topTableOutputs?.top_candidate_market_ids ??
      topTableOutputs?.ranked_top_candidate_market_ids,
  );
  const topCandidateMarketIds = new Set(topCandidateMarketIdOrder);
  const candidateRowsByMarketId = new Map<
    string,
    BullpenAutoLiveConsoleCandidateInput
  >();

  for (const item of asArray(llmOutputs.llm_reviewed_candidates)) {
    const record = asRecord(item);
    if (!record) {
      continue;
    }
    const marketId = readString(record.market_id);
    if (
      readString(record.source_kind) === "active_position" ||
      !readBoolean(record.qualified) ||
      (marketId && topCandidateMarketIds.size > 0 && !topCandidateMarketIds.has(marketId))
    ) {
      continue;
    }

    const row = buildCandidateRow(record, acceptedCandidateByMarketId);
    if (!row || candidateRowsByMarketId.has(row.market_id)) {
      continue;
    }
    candidateRowsByMarketId.set(row.market_id, row);
  }

  const topCandidateOrderIndex = new Map(
    topCandidateMarketIdOrder.map((marketId, index) => [marketId, index] as const),
  );
  const candidateRows = [...candidateRowsByMarketId.values()].sort((left, right) => {
    const leftIndex = topCandidateOrderIndex.get(left.market_id);
    const rightIndex = topCandidateOrderIndex.get(right.market_id);
    if (leftIndex !== undefined || rightIndex !== undefined) {
      if (leftIndex === undefined) return 1;
      if (rightIndex === undefined) return -1;
      return leftIndex - rightIndex;
    }
    return left.market_id.localeCompare(right.market_id);
  });

  if (candidateRows.length === 0) {
    return {
      request: null,
      qualifiedCandidateCount: 0,
      blockedReason: NO_STAGE2_QUALIFIED_EVENTS_REASON,
    };
  }

  if (!universeStatus.isComplete) {
    const reviewedRowsText =
      universeStatus.reviewedRows !== null
        ? universeStatus.reviewedRows.toLocaleString("en-IN")
        : "the reviewed rows";
    const totalEligibleRowsText =
      universeStatus.totalEligibleRows !== null
        ? universeStatus.totalEligibleRows.toLocaleString("en-IN")
        : "the full eligible universe";
    const blockerSummary = universeStatus.blockerSummary;
    const blockerFix = universeStatus.blockerFix;
    const blockerDetail = blockerSummary
      ? ` ${blockerSummary}`
      : ` the saved run reviewed only ${reviewedRowsText} of ${totalEligibleRowsText}.`;
    const blockerFixDetail = blockerFix ? ` What to do: ${blockerFix}` : "";

    return {
      request: null,
      qualifiedCandidateCount: candidateRows.length,
      blockedReason: `Stage 3 reuse is blocked because${blockerDetail} The combined top-${strategyMetadata.maxPositions} ranking is incomplete.${blockerFixDetail}`,
    };
  }

  return {
    request: {
      console_profile: {
        source_label:
          readString(llmOutputs.scan_source_label) ??
          readString(scanOutputs?.scan_source_label) ??
          "Saved Stage 2 output",
        source_url:
          readString(llmOutputs.scan_source_url) ??
          readString(scanOutputs?.scan_source_url),
        scanned_at:
          readString(scanOutputs?.scanned_at) ?? run.completed_at ?? run.started_at,
        snapshot_id: readString(scanOutputs?.snapshot_id) ?? run.id,
        mode: readString(scanOutputs?.mode) ?? "stage-3-invest-only",
        total_candidates: candidateRows.length,
        candidate_rows_prefiltered: true,
        reuse_saved_llm_outputs: true,
        candidate_rows: candidateRows,
      },
    },
    qualifiedCandidateCount: candidateRows.length,
    blockedReason: null,
  };
}

function buildSavedRunActivePositionMarketIdSet(
  run: BullpenAutoLiveRun | null,
): Set<string> {
  if (!run) return new Set<string>();

  const scanOutputs = workflowStageOutputs(run, "scan");
  const marketIds = asArray(scanOutputs?.active_positions_found)
    .map((item) => asRecord(item))
    .filter((record) => {
      const classification = readString(record?.classification);
      if (classification) {
        return classification === "active";
      }
      return (
        !readBoolean(record?.is_claimable) &&
        !readBoolean(record?.isClaimable) &&
        !(
          readString(record?.economic_classification) &&
          SAVED_RUN_NON_ACTIVE_CLASSIFICATIONS.has(
            readString(record?.economic_classification) ?? "",
          )
        )
      );
    })
    .map((record) => readString(record?.market_id))
    .filter((marketId): marketId is string => Boolean(marketId));
  return new Set(marketIds);
}

function buildLiveActivePositionMarketIdSet(
  activePositions: BullpenActivePositionView[],
): Set<string> {
  return new Set(
    activePositions
      .filter(isActiveBullpenPosition)
      .map((position) => readString(position.marketId))
      .filter((marketId): marketId is string => Boolean(marketId)),
  );
}

function buildSubmittedBuyMarketIdSet(
  run: BullpenAutoLiveRun | null,
  decisions: BullpenAutoLiveDecision[],
): Set<string> {
  return new Set(
    buildSubmittedBuyTimestampLookup(run, decisions).keys(),
  );
}

function readTimestampMs(value: string | null): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function shouldPreferTimestamp(next: string, current: string | null | undefined) {
  if (!current) {
    return true;
  }

  const nextMs = readTimestampMs(next);
  const currentMs = readTimestampMs(current);
  if (nextMs === null) {
    return currentMs === null;
  }
  if (currentMs === null) {
    return true;
  }
  return nextMs >= currentMs;
}

function isCompletedInvestOrderStatus(status: string | null | undefined) {
  return (
    status === "submitted" ||
    status === "confirming" ||
    status === "partially_filled" ||
    status === "confirmed" ||
    status === "filled"
  );
}

function buildLatestSubmittedExitTimestampLookup(
  decisions: BullpenAutoLiveDecision[],
): Map<string, string> {
  const lookup = new Map<string, string>();

  for (const decision of decisions) {
    if (
      !isCompletedInvestOrderStatus(decision.order_plan?.status) ||
      !RECONCILING_EXIT_ACTIONS.has(decision.order_plan.action)
    ) {
      continue;
    }

    const marketId = readString(decision.market_id);
    const timestamp = readDecisionExecutionTimestamp(decision);
    if (!marketId || !timestamp) {
      continue;
    }

    if (shouldPreferTimestamp(timestamp, lookup.get(marketId))) {
      lookup.set(marketId, timestamp);
    }
  }

  return lookup;
}

function buildSubmittedBuyTimestampLookup(
  run: BullpenAutoLiveRun | null,
  decisions: BullpenAutoLiveDecision[],
): Map<string, string> {
  if (!run) return new Map<string, string>();

  const lookup = new Map<string, string>();
  const latestExitTimestampByMarketId =
    buildLatestSubmittedExitTimestampLookup(decisions);

  for (const decision of decisions) {
    if (
      decision.run_id !== run.id ||
      !isCompletedInvestOrderStatus(decision.order_plan?.status) ||
      decision.order_plan.action !== "buy"
    ) {
      continue;
    }

    const marketId = readString(decision.market_id);
    const timestamp = readDecisionExecutionTimestamp(decision);
    if (!marketId || !timestamp) {
      continue;
    }

    const latestExitTimestamp = latestExitTimestampByMarketId.get(marketId);
    if (
      latestExitTimestamp &&
      shouldPreferTimestamp(latestExitTimestamp, timestamp)
    ) {
      continue;
    }

    if (shouldPreferTimestamp(timestamp, lookup.get(marketId))) {
      lookup.set(marketId, timestamp);
    }
  }

  return lookup;
}

function readDecisionExecutionTimestamp(decision: BullpenAutoLiveDecision): string | null {
  return (
    readString(decision.order_plan?.executed_at) ??
    readString(decision.updated_at) ??
    readString(decision.created_at)
  );
}

function buildLatestSubmittedBuyTimestampLookup(
  run: BullpenAutoLiveRun | null,
  decisions: BullpenAutoLiveDecision[],
): Map<string, string> {
  return buildSubmittedBuyTimestampLookup(run, decisions);
}

export function buildBullpenStage3OnlyInvestExecutionPlan(
  run: BullpenAutoLiveRun | null,
  decisions: BullpenAutoLiveDecision[] = [],
  options: BullpenStage3OnlyInvestExecutionPlanOptions = {},
): BullpenStage3OnlyInvestExecutionPlan {
  const plan = buildBullpenStage3OnlyInvestPlan(run);
  if (!plan.request?.console_profile) {
    return {
      request: null,
      qualifiedCandidateCount: plan.qualifiedCandidateCount,
      readyCandidateCount: 0,
      alreadyInvestedCandidateCount: 0,
      alreadyInvestedMarketIds: [],
      alreadyInvestedRecords: [],
      candidatePreviews: [],
      blockedReason: plan.blockedReason,
    };
  }

  const {
    activePositions = [],
    hasActivePositionsSnapshot = false,
  } = options;
  const savedRunActivePositionMarketIds = buildSavedRunActivePositionMarketIdSet(run);
  const liveActivePositionMarketIds = buildLiveActivePositionMarketIdSet(activePositions);
  const activePositionMarketIds =
    liveActivePositionMarketIds.size > 0 || hasActivePositionsSnapshot
      ? liveActivePositionMarketIds
      : savedRunActivePositionMarketIds;
  const submittedBuyMarketIds = buildSubmittedBuyMarketIdSet(run, decisions);
  const latestSubmittedBuyTimestampByMarketId =
    buildLatestSubmittedBuyTimestampLookup(run, decisions);
  const alreadyInvestedMarketIds = new Set([
    ...activePositionMarketIds,
    ...submittedBuyMarketIds,
  ]);

  const candidatePreviews = plan.request.console_profile.candidate_rows.map((candidate) => {
    const alreadyActive = activePositionMarketIds.has(candidate.market_id);
    const alreadyActiveFromLive = liveActivePositionMarketIds.has(candidate.market_id);
    const alreadySubmitted = submittedBuyMarketIds.has(candidate.market_id);
    const investedAt =
      latestSubmittedBuyTimestampByMarketId.get(candidate.market_id) ?? null;
    const investedSource = alreadyActive
      ? alreadyActiveFromLive
        ? "live-position"
        : "saved-run-position"
      : alreadySubmitted
        ? "submitted-buy"
        : null;
    const reason =
      investedSource === "live-position" || investedSource === "saved-run-position"
        ? "Already present in the Bullpen wallet for this market."
        : investedSource === "submitted-buy"
          ? "A live Stage 3 buy from this saved run was already submitted."
          : null;

    return {
      candidate: cloneCandidateRow(candidate),
      status: reason ? "already-invested" : "ready",
      reason,
      investedAt,
      investedSource,
    } satisfies BullpenStage3OnlyInvestCandidatePreview;
  });

  const alreadyInvestedRecords = candidatePreviews
    .filter(
      (preview): preview is BullpenStage3OnlyInvestCandidatePreview & {
        investedSource: BullpenStage3AlreadyInvestedSource;
      } => preview.status === "already-invested" && preview.investedSource !== null,
    )
    .map((preview) => ({
      marketId: preview.candidate.market_id,
      timestamp: preview.investedAt,
      reason: preview.reason,
      source: preview.investedSource,
    }));
  const readyRows = candidatePreviews
    .filter((preview) => preview.status === "ready")
    .map((preview) => cloneCandidateRow(preview.candidate));
  const readyCandidateCount = readyRows.length;
  const alreadyInvestedCandidateCount =
    candidatePreviews.length - readyCandidateCount;

  if (readyCandidateCount === 0) {
    return {
      request:
        alreadyInvestedCandidateCount > 0
          ? {
              console_profile: {
                ...plan.request.console_profile,
                total_candidates: 0,
                candidate_rows: [],
              },
            }
          : null,
      qualifiedCandidateCount: plan.qualifiedCandidateCount,
      readyCandidateCount,
      alreadyInvestedCandidateCount,
      alreadyInvestedMarketIds: [...alreadyInvestedMarketIds],
      alreadyInvestedRecords,
      candidatePreviews,
      blockedReason:
        alreadyInvestedCandidateCount > 0 ? null : plan.blockedReason,
    };
  }

  return {
    request: {
      console_profile: {
        ...plan.request.console_profile,
        total_candidates: readyCandidateCount,
        candidate_rows: readyRows,
      },
    },
    qualifiedCandidateCount: plan.qualifiedCandidateCount,
    readyCandidateCount,
    alreadyInvestedCandidateCount,
    alreadyInvestedMarketIds: [...alreadyInvestedMarketIds],
    alreadyInvestedRecords,
    candidatePreviews,
    blockedReason: null,
  };
}

export function buildBullpenStage3InvestPreviewSteps(
  plan: BullpenStage3OnlyInvestExecutionPlan,
): BullpenStage3InvestPreviewStep[] {
  const readyLabel =
    plan.readyCandidateCount === 1 ? "event is" : "events are";
  const noQualifiedCandidates =
    plan.readyCandidateCount === 0 &&
    plan.blockedReason === NO_STAGE2_QUALIFIED_EVENTS_REASON;
  const onlyAlreadyInvestedCandidates =
    plan.readyCandidateCount === 0 &&
    plan.alreadyInvestedCandidateCount > 0 &&
    plan.blockedReason === null;
  const sellDetail =
    noQualifiedCandidates || onlyAlreadyInvestedCandidates
      ? "No executable Step 1 Event Exits were needed."
      : "Stage 3 first processes Event Exits, waits for settlement, refreshes live cash plus occupied slots, and only then sizes any new buys.";
  const sellStatus: BullpenStage3InvestPreviewStepStatus =
    noQualifiedCandidates || onlyAlreadyInvestedCandidates ? "completed" : "pending";
  const buyStatus: BullpenStage3InvestPreviewStepStatus =
    noQualifiedCandidates || onlyAlreadyInvestedCandidates
      ? "completed"
      : plan.blockedReason && plan.readyCandidateCount === 0
        ? "blocked"
        : "pending";
  const buyDetail = noQualifiedCandidates
    ? "No Stage 2-qualified events were available for the planned queue."
    : onlyAlreadyInvestedCandidates
      ? "All Stage 2-qualified events were already invested, so no new planned orders were needed."
      : plan.blockedReason ??
        (plan.readyCandidateCount > 0
          ? [
              `${plan.readyCandidateCount} Stage 2-qualified ${readyLabel} in the transfer queue.`,
              "Concrete buy plans are created only after post-exit sizing, when Step 1 settles and the worker refreshes live cash plus occupied slots.",
            ].join(" ")
          : "Stage 3 will invest the planned orders after Step 1 settles and live state refreshes.");

  return [
    {
      key: "sell",
      stepNumber: 1,
      stepTotal: 2,
      label: "Event Exits",
      status: sellStatus,
      displayStatusLabel: sellStatus === "completed" ? "N/A" : undefined,
      detail: sellDetail,
      plannedOrders: sellStatus === "completed" ? 0 : null,
      processedOrders: sellStatus === "completed" ? 0 : null,
      submittedOrders: sellStatus === "completed" ? 0 : null,
    },
    {
      key: "buy",
      stepNumber: 2,
      stepTotal: 2,
      label: "Prepare investment queue",
      status: buyStatus,
      detail: buyDetail,
      plannedOrders: 0,
      processedOrders: 0,
      submittedOrders: 0,
    },
  ];
}

function uniqueRuns(
  runs: Array<BullpenAutoLiveRun | null | undefined>,
): BullpenAutoLiveRun[] {
  const seen = new Set<string>();
  const ordered: BullpenAutoLiveRun[] = [];
  for (const run of runs) {
    if (!run || seen.has(run.id)) {
      continue;
    }
    seen.add(run.id);
    ordered.push(run);
  }
  return ordered;
}

export function selectBullpenStage3OnlyInvestSource(
  runs: Array<BullpenAutoLiveRun | null | undefined>,
): BullpenStage3OnlyInvestSource {
  const orderedRuns = uniqueRuns(runs);
  if (orderedRuns.length === 0) {
    return {
      run: null,
      plan: buildBullpenStage3OnlyInvestPlan(null),
    };
  }

  const fallbackRun: BullpenAutoLiveRun | null = orderedRuns[0] ?? null;
  const fallbackPlan = buildBullpenStage3OnlyInvestPlan(fallbackRun);

  for (const run of orderedRuns) {
    const plan = buildBullpenStage3OnlyInvestPlan(run);
    if (plan.request) {
      return {
        run,
        plan,
      };
    }
  }

  return {
    run: fallbackRun,
    plan: fallbackPlan,
  };
}

import type {
  BullpenAutoLiveConsoleCandidateInput,
  BullpenAutoLiveDecision,
  BullpenAutoLiveLlmOutput,
  BullpenAutoLiveRun,
  BullpenAutoLiveRunOnceRequest,
} from "@/types/api";
import type { BullpenActivePositionView } from "@/lib/bullpenPositions";

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

function buildRulesSummary(reviewedCandidate: Record<string, unknown>): string | null {
  const yesDefinition = readString(reviewedCandidate.yes_definition);
  const deadlineEt = readString(reviewedCandidate.deadline_et);
  const rulesFailReason = readString(reviewedCandidate.rules_fail_reason);

  if (rulesFailReason) {
    return rulesFailReason;
  }

  const parts = [yesDefinition];
  if (deadlineEt) {
    parts.push(`Deadline ET: ${deadlineEt}`);
  }
  const summary = parts.filter(Boolean).join(" | ");
  return summary.length > 0 ? summary : null;
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
    rules: buildRulesSummary(reviewedCandidate),
    market_context: readString(acceptedCandidate?.market_context),
    resolution_source: readString(acceptedCandidate?.resolution_source),
    event_description: readString(acceptedCandidate?.event_description),
    preflight_evidence_block: readString(acceptedCandidate?.preflight_evidence_block),
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
  const acceptedCandidateByMarketId = buildAcceptedCandidateLookup(scanOutputs);

  const candidateRows = asArray(llmOutputs.llm_reviewed_candidates)
    .map((item) => asRecord(item))
    .filter((record): record is Record<string, unknown> => {
      if (!record) {
        return false;
      }
      return (
        readString(record.source_kind) !== "active_position" &&
        readBoolean(record.qualified)
      );
    })
    .map((record) => buildCandidateRow(record, acceptedCandidateByMarketId))
    .filter((row): row is BullpenAutoLiveConsoleCandidateInput => Boolean(row));

  if (candidateRows.length === 0) {
    return {
      request: null,
      qualifiedCandidateCount: 0,
      blockedReason: NO_STAGE2_QUALIFIED_EVENTS_REASON,
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
    .map((record) => readString(record?.market_id))
    .filter((marketId): marketId is string => Boolean(marketId));
  return new Set(marketIds);
}

function buildLiveActivePositionMarketIdSet(
  activePositions: BullpenActivePositionView[],
): Set<string> {
  return new Set(
    activePositions
      .filter((position) => !position.isClaimable)
      .map((position) => readString(position.marketId))
      .filter((marketId): marketId is string => Boolean(marketId)),
  );
}

function buildSubmittedBuyMarketIdSet(
  run: BullpenAutoLiveRun | null,
  decisions: BullpenAutoLiveDecision[],
): Set<string> {
  if (!run) return new Set<string>();

  const marketIds = decisions
    .filter(
      (decision) =>
        decision.run_id === run.id &&
        decision.order_plan?.status === "submitted" &&
        decision.order_plan.action === "buy",
    )
    .map((decision) => decision.market_id)
    .filter((marketId) => typeof marketId === "string" && marketId.trim().length > 0);
  return new Set(marketIds);
}

function readDecisionExecutionTimestamp(decision: BullpenAutoLiveDecision): string | null {
  return (
    readString(decision.order_plan?.executed_at) ??
    readString(decision.updated_at) ??
    readString(decision.created_at)
  );
}

function buildLatestSubmittedBuyTimestampLookup(
  decisions: BullpenAutoLiveDecision[],
): Map<string, string> {
  const lookup = new Map<string, string>();

  for (const decision of decisions) {
    if (
      decision.order_plan?.status !== "submitted" ||
      decision.order_plan.action !== "buy"
    ) {
      continue;
    }

    const marketId = readString(decision.market_id);
    const timestamp = readDecisionExecutionTimestamp(decision);
    if (!marketId || !timestamp) {
      continue;
    }

    const current = lookup.get(marketId);
    const currentMs = current ? Date.parse(current) : Number.NaN;
    const nextMs = Date.parse(timestamp);

    if (!current) {
      lookup.set(marketId, timestamp);
      continue;
    }

    if (Number.isFinite(nextMs) && (!Number.isFinite(currentMs) || nextMs >= currentMs)) {
      lookup.set(marketId, timestamp);
    }
  }

  return lookup;
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
    buildLatestSubmittedBuyTimestampLookup(decisions);
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
      : "Stage 3 first evaluates Event Exits, combining the existing ranking / LLM exit logic with the new capital-aware forced-exit safety checks.";
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
          ? `${plan.readyCandidateCount} Stage 2-qualified ${readyLabel} ready for the invest-only pass after Step 1 clears.`
          : "Stage 3 will invest the planned orders after Step 1 clears.");

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
      label: "Invest planned orders",
      status: buyStatus,
      detail: buyDetail,
      plannedOrders: plan.readyCandidateCount,
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

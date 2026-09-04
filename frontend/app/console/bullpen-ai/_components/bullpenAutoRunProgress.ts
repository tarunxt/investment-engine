import type {
  BullpenAutoLiveRun,
  BullpenAutoLiveStageResult,
} from "@/types/api";

type WorkflowTone = "yellow" | "green" | "blue" | "red";
type WorkflowState = "current" | "finished" | "queued";
type WorkflowStageKey = "scan" | "llm" | "invest";

export type BullpenAutoRunScanCandidateView = {
  questionId: string | null;
  marketId: string | null;
  conditionId: string | null;
  question: string;
  marketUrl: string | null;
  slug: string | null;
  closeTime: string | null;
  theme: string | null;
  currentYesOdds: number | null;
  currentNoOdds: number | null;
  volumeUsd: number | null;
  liquidityUsd: number | null;
  bestBidCents?: number | null;
  bestAskCents?: number | null;
  spreadCents?: number | null;
  returnsPerDay: number | null;
  forceInclude: boolean;
  forceIncludedPosition?: boolean;
  selected?: boolean | null;
  rules?: string | null;
  eventDescription?: string | null;
  marketContext?: string | null;
  resolutionSource?: string | null;
  preflightEvidenceBlock?: string | null;
  scanStatus: "passed" | "filtered";
  filterReasons: string[];
};

export type BullpenAutoRunActivePositionView = {
  positionKey: string;
  marketId: string;
  marketTitle: string;
  marketUrl: string | null;
  slug: string | null;
  theme: string | null;
  side: string | null;
  shares: number | null;
  exposureUsd: number | null;
  averagePriceCents: number | null;
  currentYesOdds: number | null;
  currentNoOdds: number | null;
  closeTime: string | null;
  conditionId: string | null;
  isClaimable: boolean;
  classification: string | null;
  returnsPerDay: number | null;
};

export type BullpenAutoRunWorkflowStageView = {
  key: WorkflowStageKey;
  title: string;
  subtitle: string;
  tone: WorkflowTone;
  state: WorkflowState;
  detail: string;
  progressCommentary: string[];
  progressLabel: string;
  progressPercent: number;
  isCurrent: boolean;
  timerStartedAt: string | null;
  timerCompletedAt: string | null;
  scanCandidates: BullpenAutoRunScanCandidateView[];
  scannedCandidates: BullpenAutoRunScanCandidateView[];
  activePositionsFound: BullpenAutoRunActivePositionView[];
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
};

export type BullpenAutoRunWorkflowView = {
  stages: BullpenAutoRunWorkflowStageView[];
  currentStageLabel: string;
  statusCopy: string;
  runStatus: BullpenAutoLiveRun["status"] | "idle";
};

/**
 * Celery acceptance and actual workflow execution are intentionally shown as
 * separate states.  In particular, a QUEUED run has not begun Stage 1 yet.
 */
export function getBullpenAutoLiveTaskLifecycleLabel(
  run: BullpenAutoLiveRun | null | undefined,
): string | null {
  const lifecycle = run?.task_lifecycle;
  if (!lifecycle) return null;

  const detail = lifecycle.detail?.trim().toLowerCase() ?? "";
  if (detail.includes("absolute timeout")) return "Absolute timeout";

  switch (lifecycle.state) {
    case "QUEUED":
      return "Queued — waiting for Auto-Live worker";
    case "RESERVED":
      return "Received — waiting for pool slot";
    case "STARTED":
      return "Running — heartbeat healthy";
    case "RETRYING":
      return "Retrying — waiting for Auto-Live worker";
    case "WORKER_LOST":
      return "Worker heartbeat lost";
    case "FAILURE":
      return "Worker returned failure";
    case "REVOKED":
      return "Task revoked";
    default:
      return null;
  }
}

export function isBullpenAutoRunWorkflowSettled(
  workflowView: BullpenAutoRunWorkflowView,
) {
  const hasQueuedStage = workflowView.stages.some(
    (stage) => stage.state === "queued",
  );
  return (
    !hasQueuedStage &&
    workflowView.stages.every((stage) => stage.state === "finished")
  );
}

type WorkflowDefinition = {
  key: WorkflowStageKey;
  title: string;
  subtitle: string;
  defaultDetail: string;
  defaultItemLabel: string;
};

const WORKFLOW_DEFINITIONS: WorkflowDefinition[] = [
  {
    key: "scan",
    title: "Stage 1 · Bullpen Scan",
    subtitle: "",
    defaultDetail: "Waiting for the worker to begin the Bullpen scan.",
    defaultItemLabel: "events",
  },
  {
    key: "llm",
    title: "Stage 2 · Run LLM",
    subtitle: "",
    defaultDetail: "Waiting for Stage 1 to finish so LLM review can begin.",
    defaultItemLabel: "events",
  },
  {
    key: "invest",
    title: "Stage 3 · Exit and Invest",
    subtitle: "",
    defaultDetail:
      "Waiting for Stage 2 to finish before exit and investment planning starts.",
    defaultItemLabel: "rows",
  },
];

const NON_ACTIVE_POSITION_CLASSIFICATIONS = new Set([
  "closed",
  "positive_payout_claimable",
  "resolved_zero_payout",
  "settlement_pending",
  "stale_or_unknown",
]);

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

const RAW_PAYLOAD_START_PATTERN =
  /\s+(?=\{["']?(?:action|fail_count|results|status)["']?\s*:)/i;

function formatBullpenRunSummaryForMonitor(
  summary: string | null | undefined,
  fallback: string,
) {
  const text = readString(summary);
  if (!text) return fallback;

  const [humanPrefix] = text.split(RAW_PAYLOAD_START_PATTERN, 1);
  const concise = readString(humanPrefix) ?? text;
  const rejectedCount = (
    text.match(/relayer rejected redeem submission/gi) ?? []
  ).length;
  const rateLimitedCount = (text.match(/429 Too Many Requests/gi) ?? []).length;
  const payoutPreflightCount = (text.match(/payout preflight failed/gi) ?? [])
    .length;
  const notes: string[] = [];

  if (rejectedCount > 0) {
    notes.push(
      `${rejectedCount} redeem submission${rejectedCount === 1 ? "" : "s"} rejected by the relayer`,
    );
  }
  if (payoutPreflightCount > 0) {
    notes.push(
      `${payoutPreflightCount} payout preflight check${payoutPreflightCount === 1 ? "" : "s"} failed`,
    );
  }
  if (rateLimitedCount > 0) {
    notes.push(`Polygon RPC returned HTTP 429 rate-limit responses`);
  }

  const suffix = notes.length > 0 ? ` Details: ${notes.join("; ")}.` : "";
  const combined = `${concise.replace(/\s+/g, " ").trim()}${suffix}`;

  return combined.length > 360
    ? `${combined.slice(0, 357).trimEnd()}…`
    : combined;
}

function appendStageDetail(detail: string, suffix: string) {
  return detail.endsWith(".") ? `${detail} ${suffix}` : `${detail}. ${suffix}`;
}

function readLlmExecutionMode(value: unknown) {
  return value === "single_combined" || value === "chunked_parallel"
    ? value
    : null;
}

function readStringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => readString(item))
    .filter((item): item is string => item !== null);
}

function readBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return false;
}

function buildStageDetail(
  stage: BullpenAutoLiveStageResult | null,
  detail: string,
  workflowDefinition: WorkflowDefinition,
  run: BullpenAutoLiveRun | null,
) {
  let nextDetail = detail;
  if (
    workflowDefinition.key === "llm" &&
    readBoolean(stage?.outputs?.reused_existing_llm_outputs)
  ) {
    nextDetail = appendStageDetail(
      nextDetail,
      "Reused the current Bullpen x AI table's saved LLM outputs instead of making fresh LLM calls.",
    );
  }
  if (workflowDefinition.key === "llm") {
    const executionMode = readLlmExecutionMode(
      stage?.outputs?.llm_execution_mode,
    );
    const eventsPerPrompt = readNumber(stage?.outputs?.llm_events_per_prompt);
    const executionDetail =
      executionMode === "single_combined"
        ? "Execution mode: Single combined."
        : executionMode === "chunked_parallel"
          ? `Execution mode: Batched parallel${eventsPerPrompt !== null ? ` with up to ${eventsPerPrompt} events per prompt` : ""}.`
          : null;
    if (executionDetail && !nextDetail.includes(executionDetail)) {
      nextDetail = appendStageDetail(nextDetail, executionDetail);
    }
  }
  if (workflowDefinition.key === "invest") {
    const executionGateReason = readString(
      stage?.outputs?.execution_gate_reason,
    );
    const executionModeReason = readString(
      stage?.outputs?.execution_mode_reason,
    );
    const investDetail = executionGateReason
      ? `Execution gate: ${executionGateReason}`
      : executionModeReason
        ? `Execution mode: ${executionModeReason}`
        : null;
    if (investDetail && !nextDetail.includes(investDetail)) {
      nextDetail = appendStageDetail(nextDetail, investDetail);
    }
  }
  const stageError = readString(stage?.outputs?.error_message);
  if (stageError) {
    const failureDetail = `Worker error: ${stageError}`;
    if (!nextDetail.includes(failureDetail)) {
      nextDetail = appendStageDetail(nextDetail, failureDetail);
    }
  } else if (
    run?.status === "failed" &&
    (stage?.completed_at === null || getPhaseStatus(stage) === "running")
  ) {
    const fallbackFailure =
      readString(run.error_message) ?? readString(run.summary);
    if (fallbackFailure) {
      const failureDetail = `Worker error: ${fallbackFailure}`;
      if (!nextDetail.includes(failureDetail)) {
        nextDetail = appendStageDetail(nextDetail, failureDetail);
      }
    }
  }
  return nextDetail;
}

function readNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readTimestampMs(value: string | null | undefined) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function latestTimestamp(
  first: string | null | undefined,
  second: string | null | undefined,
) {
  const firstMs = readTimestampMs(first);
  const secondMs = readTimestampMs(second);
  if (firstMs === null) return second ?? null;
  if (secondMs === null) return first ?? null;
  return secondMs > firstMs ? (second ?? null) : (first ?? null);
}

function earliestTimestamp(
  first: string | null | undefined,
  second: string | null | undefined,
) {
  const firstMs = readTimestampMs(first);
  const secondMs = readTimestampMs(second);
  if (firstMs === null) return second ?? null;
  if (secondMs === null) return first ?? null;
  return secondMs < firstMs ? (second ?? null) : (first ?? null);
}

function findWorkflowStageResult(
  run: BullpenAutoLiveRun | null | undefined,
  workflowDefinition: WorkflowDefinition,
  stageNumber: number,
) {
  if (!run) return null;
  return (
    run.stage_results.find((stage) => {
      const workflowStageKey = readString(stage.outputs?.workflow_stage_key);
      return workflowStageKey === workflowDefinition.key;
    }) ??
    run.stage_results.find((stage) => stage.stage_number === stageNumber) ??
    null
  );
}

function readStageRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function readInputs(stage: BullpenAutoLiveStageResult | null) {
  return readStageRecord(stage?.inputs);
}

function readOutputs(stage: BullpenAutoLiveStageResult | null) {
  return readStageRecord(stage?.outputs);
}

const STAGE2_ACTIONABLE_DISPLAY_KEYS = [
  "stage2_actionable_contract_version",
  "stage2_actionable_contract_authoritative",
  "stage2_actionable_contract_execution_mode",
  "stage2_actionable_handoff_used",
  "stage2_actionable_handoff_source",
  "stage2_actionable_exit_market_ids",
  "stage2_actionable_buy_market_ids",
  "stage2_actionable_exit_count",
  "stage2_actionable_buy_count",
  "missing_stage2_actionable_exit_market_ids",
  "missing_stage2_actionable_buy_market_ids",
] as const;

function stage2ActionableEvidenceScore(outputs: Record<string, unknown>) {
  const hasExactMarketIds =
    Array.isArray(outputs.stage2_actionable_exit_market_ids) &&
    Array.isArray(outputs.stage2_actionable_buy_market_ids);
  const hasAuthoritativeFlag = readBoolean(
    outputs.stage2_actionable_contract_authoritative,
  );
  const hasCounts =
    readNumber(outputs.stage2_actionable_exit_count) !== null &&
    readNumber(outputs.stage2_actionable_buy_count) !== null;

  if (hasExactMarketIds) return 3;
  if (hasAuthoritativeFlag) return 2;
  if (hasCounts) return 1;
  return 0;
}

function stage2ActionableDisplaySourceLabel(
  stage: BullpenAutoLiveStageResult,
) {
  return (
    readString(stage.outputs?.workflow_stage_key) ??
    `stage-${stage.stage_number}`
  );
}

function readStage2DisplayOutputs(
  run: BullpenAutoLiveRun | null,
  stage: BullpenAutoLiveStageResult | null,
) {
  const primaryOutputs = readOutputs(stage);
  if (stage2ActionableEvidenceScore(primaryOutputs) > 0 || !run) {
    return primaryOutputs;
  }

  const fallback = run.stage_results
    .filter((candidate) => candidate !== stage)
    .map((candidate) => ({
      stage: candidate,
      outputs: readOutputs(candidate),
      score: stage2ActionableEvidenceScore(readOutputs(candidate)),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score)[0];

  if (fallback) {
    const recoveredOutputs: Record<string, unknown> = {
      ...primaryOutputs,
      stage2_actionable_contract_display_recovered: true,
      stage2_actionable_contract_display_source:
        stage2ActionableDisplaySourceLabel(fallback.stage),
    };
    for (const key of STAGE2_ACTIONABLE_DISPLAY_KEYS) {
      if (key in fallback.outputs) {
        recoveredOutputs[key] = fallback.outputs[key];
      }
    }
    return recoveredOutputs;
  }

  const investStage =
    run.stage_results.find(
      (candidate) =>
        readString(candidate.outputs?.workflow_stage_key) === "invest",
    ) ??
    run.stage_results.find((candidate) => candidate.stage_number === 3) ??
    null;
  const investOutputs = readOutputs(investStage);
  const exitCount =
    readNumber(investOutputs.stage2_actionable_exit_count) ??
    readNumber(investOutputs.event_exit_planned);
  const buyCount =
    readNumber(investOutputs.stage2_actionable_buy_count) ??
    readNumber(investOutputs.orders_planned);

  if (exitCount === null || buyCount === null) {
    return primaryOutputs;
  }

  // Display-only recovery: Stage 3's durable plan counts are derivative evidence
  // of the already-completed Stage 2 handoff. They must never become an execution
  // input or be described as row-level authoritative when compact market IDs are
  // unavailable.
  return {
    ...primaryOutputs,
    stage2_actionable_exit_count: exitCount,
    stage2_actionable_buy_count: buyCount,
    stage2_actionable_contract_display_recovered: true,
    stage2_actionable_contract_display_source: "invest-plan-counts",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readInvestStageDecisionRows(stage: BullpenAutoLiveStageResult | null) {
  const rawDecisionRows = stage?.outputs?.decision_rows;
  if (!Array.isArray(rawDecisionRows)) return [];

  return rawDecisionRows.filter((decision) => {
    if (!isRecord(decision)) return false;
    return (
      typeof decision.id === "string" &&
      typeof decision.market_id === "string" &&
      typeof decision.market_title === "string"
    );
  });
}

function isCompletedInvestOrderStatus(status: string | null | undefined) {
  return status === "submitted" || status === "confirmed";
}

function isInvestStageEffectivelyCompleted(
  workflowDefinition: WorkflowDefinition,
  stage: BullpenAutoLiveStageResult | null,
) {
  if (workflowDefinition.key !== "invest") return false;
  if (getPhaseStatus(stage) !== "running") return false;
  if (readString(stage?.outputs?.execution_gate_reason)) return false;

  const plannedOrders = readNumber(stage?.outputs?.orders_planned) ?? 0;
  const submittedOrders = readNumber(stage?.outputs?.orders_submitted) ?? 0;
  if (plannedOrders < 1 || submittedOrders < plannedOrders) return false;

  const plannedDecisionRows = readInvestStageDecisionRows(stage).filter(
    (decision) => {
      if (!isRecord(decision.order_plan)) return false;
      return typeof decision.order_plan.status === "string";
    },
  );
  if (plannedDecisionRows.length < plannedOrders) return false;

  return plannedDecisionRows.every((decision) =>
    isCompletedInvestOrderStatus(decision.order_plan?.status),
  );
}

function buildDerivedInputs(
  workflowDefinition: WorkflowDefinition,
  previousStage: BullpenAutoLiveStageResult | null,
) {
  const previousOutputs = readOutputs(previousStage);

  if (workflowDefinition.key === "llm") {
    const derivedInputs: Record<string, unknown> = {};
    if (Array.isArray(previousOutputs.accepted_candidates)) {
      derivedInputs.accepted_candidates = previousOutputs.accepted_candidates;
    }
    if (Array.isArray(previousOutputs.active_positions_found)) {
      derivedInputs.active_positions_found =
        previousOutputs.active_positions_found;
    }
    return derivedInputs;
  }

  if (workflowDefinition.key === "invest") {
    return Array.isArray(previousOutputs.llm_reviewed_candidates)
      ? { llm_review_rows: previousOutputs.llm_reviewed_candidates }
      : {};
  }

  return {};
}

function readWorkflowInputs(
  workflowDefinition: WorkflowDefinition,
  stage: BullpenAutoLiveStageResult | null,
  previousStage: BullpenAutoLiveStageResult | null,
) {
  const directInputs = readInputs(stage);
  const derivedInputs = buildDerivedInputs(workflowDefinition, previousStage);
  return Object.keys(directInputs).length > 0
    ? { ...derivedInputs, ...directInputs }
    : derivedInputs;
}

function getPhaseStatus(stage: BullpenAutoLiveStageResult | null) {
  return readString(stage?.outputs?.phase_status);
}

function getCompletedItems(stage: BullpenAutoLiveStageResult | null) {
  return readNumber(stage?.outputs?.completed_items);
}

function getTotalItems(stage: BullpenAutoLiveStageResult | null) {
  return readNumber(stage?.outputs?.total_items);
}

function getItemLabel(
  stage: BullpenAutoLiveStageResult | null,
  workflowDefinition: WorkflowDefinition,
) {
  return (
    readString(stage?.outputs?.item_label) ??
    workflowDefinition.defaultItemLabel
  );
}

function getProgressItemLabel(
  stage: BullpenAutoLiveStageResult | null,
  workflowDefinition: WorkflowDefinition,
) {
  const defaultLabel = getItemLabel(stage, workflowDefinition);
  if (workflowDefinition.key !== "invest") return defaultLabel;

  const activePositionRows = readNumber(stage?.outputs?.active_position_rows);
  const candidateDecisionRows = readNumber(
    stage?.outputs?.candidate_decision_rows,
  );
  if (activePositionRows === null && candidateDecisionRows === null) {
    return defaultLabel;
  }

  return "review rows";
}

function readScanCandidates(stage: BullpenAutoLiveStageResult | null) {
  const acceptedCandidates = Array.isArray(stage?.outputs?.accepted_candidates)
    ? stage.outputs.accepted_candidates
    : [];
  const rejectedCandidates = Array.isArray(stage?.outputs?.rejected_candidates)
    ? stage.outputs.rejected_candidates
    : [];

  return [
    ...acceptedCandidates.map((candidate) => ({ candidate, scanStatus: "passed" as const })),
    ...rejectedCandidates.map((candidate) => ({ candidate, scanStatus: "filtered" as const })),
  ]
    .map(({ candidate, scanStatus }) => {
      if (!candidate || typeof candidate !== "object") return null;
      const record = candidate as Record<string, unknown>;
      const question = readString(record.question);
      if (!question) return null;

      return {
        questionId: readString(record.question_id),
        marketId: readString(record.market_id),
        conditionId: readString(record.condition_id),
        question,
        marketUrl: readString(record.market_url),
        slug: readString(record.slug),
        closeTime: readString(record.close_time),
        theme: readString(record.theme),
        currentYesOdds: readNumber(record.current_yes_odds),
        currentNoOdds: readNumber(record.current_no_odds),
        volumeUsd: readNumber(record.volume_usd),
        liquidityUsd: readNumber(record.liquidity_usd),
        bestBidCents: readNumber(record.best_bid_cents),
        bestAskCents: readNumber(record.best_ask_cents),
        spreadCents: readNumber(record.spread_cents),
        returnsPerDay: readNumber(record.returns_per_day),
        forceInclude: readBoolean(record.force_include),
        forceIncludedPosition: readBoolean(record.force_included_position),
        selected:
          typeof record.selected === "boolean" ? record.selected : null,
        rules: readString(record.rules),
        eventDescription: readString(record.event_description),
        marketContext: readString(record.market_context),
        resolutionSource: readString(record.resolution_source),
        preflightEvidenceBlock: readString(record.preflight_evidence_block),
        scanStatus,
        filterReasons: Array.isArray(record.reasons)
          ? record.reasons.filter(
              (reason): reason is string => typeof reason === "string",
            )
          : [],
      } satisfies BullpenAutoRunScanCandidateView;
    })
    .filter((candidate): candidate is BullpenAutoRunScanCandidateView =>
      Boolean(candidate),
    );
}

function readActivePositionsFound(stage: BullpenAutoLiveStageResult | null) {
  const rawPositions = stage?.outputs?.active_positions_found;
  if (!Array.isArray(rawPositions)) return [];

  return rawPositions
    .map((position) => {
      if (!position || typeof position !== "object") return null;
      const record = position as Record<string, unknown>;
      const marketId = readString(record.market_id);
      const marketTitle =
        readString(record.market_title) ?? readString(record.question);
      if (!marketId || !marketTitle) return null;

      const classification = readString(record.classification);
      if (classification && classification !== "active") {
        return null;
      }
      if (
        !classification &&
        (readBoolean(record.is_claimable) ||
          readBoolean(record.isClaimable) ||
          NON_ACTIVE_POSITION_CLASSIFICATIONS.has(
            readString(record.economic_classification) ?? "",
          ))
      ) {
        return null;
      }

      return {
        positionKey:
          readString(record.position_key) ??
          `${marketId}::${readString(record.side) ?? "UNKNOWN"}`,
        marketId,
        marketTitle,
        marketUrl: readString(record.market_url),
        slug: readString(record.slug),
        theme: readString(record.theme),
        side: readString(record.side),
        shares: readNumber(record.shares),
        exposureUsd: readNumber(record.exposure_usd),
        averagePriceCents: readNumber(record.average_price_cents),
        currentYesOdds: readNumber(record.current_yes_odds),
        currentNoOdds: readNumber(record.current_no_odds),
        closeTime: readString(record.close_time),
        conditionId: readString(record.condition_id),
        isClaimable:
          readBoolean(record.is_claimable) || readBoolean(record.isClaimable),
        classification,
        returnsPerDay: readNumber(record.returns_per_day),
      } satisfies BullpenAutoRunActivePositionView;
    })
    .filter((position): position is BullpenAutoRunActivePositionView =>
      Boolean(position),
    );
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function buildBullpenAutoRunWorkflowView(
  run: BullpenAutoLiveRun | null | undefined,
  pendingRunId?: string | null,
  pendingRunStartedAt?: string | null,
): BullpenAutoRunWorkflowView {
  const normalizedRun = run ?? null;
  const taskLifecycleLabel = getBullpenAutoLiveTaskLifecycleLabel(normalizedRun);
  const runStatus =
    normalizedRun?.status ?? (pendingRunId ? "running" : "idle");
  const stageResults = WORKFLOW_DEFINITIONS.map((definition, index) =>
    findWorkflowStageResult(normalizedRun, definition, index + 1),
  );
  const hasPersistedStageEvidence = stageResults.some(
    (stage) => stage !== null,
  );
  const activeStageEvidenceUnavailable =
    normalizedRun !== null &&
    !hasPersistedStageEvidence &&
    (runStatus === "running" || runStatus === "confirming");
  const completedStageCount = stageResults.filter(
    (stage) => {
      const phase = getPhaseStatus(stage);
      return phase === "completed" || phase === "partial";
    },
  ).length;
  const currentStageIndex = (() => {
    const runningStageIndex = stageResults.findIndex(
      (stage) => {
        const phase = getPhaseStatus(stage);
        return phase === "running" || phase === "confirming";
      },
    );
    if (runningStageIndex >= 0) return runningStageIndex;
    if (runStatus === "confirming") return WORKFLOW_DEFINITIONS.length - 1;
    if (runStatus !== "running") return -1;
    if (!hasPersistedStageEvidence) {
      // A locally acknowledged run may briefly precede its persisted
      // projection. Once an exact run exists, however, missing stage evidence
      // must stay explicit; inventing Stage 1 made the dashboard contradict
      // History for the same Stage 3 run.
      return normalizedRun === null && pendingRunId ? 0 : -1;
    }
    return Math.min(completedStageCount, WORKFLOW_DEFINITIONS.length - 1);
  })();

  const stages = WORKFLOW_DEFINITIONS.map((definition, index) => {
    const stage = stageResults[index];
    const previousStage = index > 0 ? stageResults[index - 1] : null;
    const nextStage = stageResults[index + 1] ?? null;
    const explicitPhase = getPhaseStatus(stage);
    const investStageEffectivelyCompleted = isInvestStageEffectivelyCompleted(
      definition,
      stage,
    );
    let state: WorkflowState;
    if (
      explicitPhase === "completed" ||
      explicitPhase === "partial" ||
      explicitPhase === "blocked" ||
      explicitPhase === "failed" ||
      explicitPhase === "cancelled" ||
      explicitPhase === "aborted" ||
      runStatus === "completed" ||
      investStageEffectivelyCompleted
    ) {
      state = "finished";
    } else if (
      index === currentStageIndex &&
      (runStatus === "running" ||
        runStatus === "confirming" ||
        runStatus === "failed" ||
        runStatus === "skipped")
    ) {
      state = "current";
    } else if (index < completedStageCount) {
      state = "finished";
    } else {
      state = "queued";
    }

    const tone: WorkflowTone =
      explicitPhase === "aborted" ||
      explicitPhase === "blocked" ||
      (definition.key === "invest" &&
        runStatus === "failed" &&
        readBoolean(stage?.outputs?.recovery_required))
        ? "red"
        : state === "finished" &&
            stage?.status !== "fail" &&
            !(runStatus === "partial_success" && definition.key === "invest")
          ? "green"
          : state === "current"
            ? "yellow"
            : "blue";
    const shouldShowStageData = state !== "queued";
    const stageInputs = readWorkflowInputs(definition, stage, previousStage);
    const stageOutputs = shouldShowStageData
      ? definition.key === "llm"
        ? readStage2DisplayOutputs(normalizedRun, stage)
        : readOutputs(stage)
      : {};
    const completedItems = shouldShowStageData
      ? getCompletedItems(stage)
      : null;
    const totalItems = shouldShowStageData ? getTotalItems(stage) : null;
    const itemLabel = shouldShowStageData
      ? getProgressItemLabel(stage, definition)
      : definition.defaultItemLabel;
    const progressPercent =
      totalItems && totalItems > 0 && completedItems !== null
        ? clampPercent((completedItems / totalItems) * 100)
        : state === "finished"
          ? 100
          : state === "current"
            ? 45
            : 0;
    const llmExecutionMode =
      definition.key === "llm"
        ? (readString(stage?.outputs?.llm_execution_mode) ??
          readString(stage?.inputs?.llm_execution_mode))
        : null;
    const progressLabel = !shouldShowStageData
      ? "Queued"
      : explicitPhase === "cancelled"
        ? "Cancelled"
      : explicitPhase === "aborted"
        ? "Interrupted"
      : explicitPhase === "blocked"
        ? "Blocked"
      : explicitPhase === "failed"
        ? "Failed"
        : definition.key === "llm" && llmExecutionMode === "single_combined"
        ? state === "finished"
          ? "Single combined finished"
          : state === "current"
            ? "Single combined in progress"
            : "Single combined"
        : totalItems !== null
          ? `${completedItems ?? (state === "finished" ? totalItems : 0)}/${totalItems} ${itemLabel}`
          : state === "finished"
            ? "Finished"
            : state === "current"
              ? "In progress"
              : "Queued";
    const stageTimerStartedAt = !shouldShowStageData
      ? null
      : latestTimestamp(
          stage?.started_at ??
            (index === 0
              ? (pendingRunStartedAt ?? normalizedRun?.started_at ?? null)
              : (previousStage?.completed_at ?? previousStage?.started_at ?? null)),
          index === 0 || explicitPhase === "running" || explicitPhase === "confirming"
            ? null
            : previousStage?.completed_at,
        );
    const nextStageStartedAt = nextStage?.started_at ?? null;
    const nextStageStartedMs = readTimestampMs(nextStageStartedAt);
    const stageTimerStartedMs = readTimestampMs(stageTimerStartedAt);
    const nextStageStartBoundary =
      nextStageStartedMs !== null &&
      stageTimerStartedMs !== null &&
      nextStageStartedMs > stageTimerStartedMs
        ? nextStageStartedAt
        : null;
    const stageTimerCompletedAt = !shouldShowStageData
      ? null
      : explicitPhase === "running" && runStatus === "running"
        ? null
        : explicitPhase === "confirming" || runStatus === "confirming"
          ? null
        : state === "finished"
          ? earliestTimestamp(
              stage?.completed_at ??
                (index === WORKFLOW_DEFINITIONS.length - 1
                  ? (normalizedRun?.completed_at ?? null)
                  : null),
              nextStageStartBoundary,
            )
          : null;
    let detail =
      (shouldShowStageData ? stage?.reason : null) ||
      (state === "current" && index === 0 && runStatus === "running"
        ? "Bullpen scan started. Waiting for the worker handoff to complete."
        : state === "finished"
          ? `${definition.title} finished in the latest run.`
          : definition.defaultDetail);
    if (
      !stage?.reason &&
      normalizedRun?.summary &&
      index === WORKFLOW_DEFINITIONS.length - 1 &&
      state === "finished"
    ) {
      detail = formatBullpenRunSummaryForMonitor(
        normalizedRun.summary,
        `${definition.title} finished in the latest run.`,
      );
    }
    detail = buildStageDetail(stage, detail, definition, normalizedRun);
    const progressCommentary = shouldShowStageData
      ? readStringList(stageOutputs.progress_commentary)
      : [];

    return {
      key: definition.key,
      title: definition.title,
      subtitle: definition.subtitle,
      tone,
      state,
      detail,
      progressCommentary,
      progressLabel,
      progressPercent,
      isCurrent: state === "current",
      timerStartedAt: stageTimerStartedAt,
      timerCompletedAt: stageTimerCompletedAt,
      scanCandidates:
        definition.key === "scan" && shouldShowStageData
          ? readScanCandidates(stage).filter(
              (candidate) => candidate.scanStatus === "passed",
            )
          : [],
      scannedCandidates:
        definition.key === "scan" && shouldShowStageData
          ? readScanCandidates(stage)
          : [],
      activePositionsFound:
        definition.key === "scan" && shouldShowStageData
          ? readActivePositionsFound(stage)
          : [],
      inputs: Object.keys(stageInputs).length > 0 ? stageInputs : {},
      outputs: stageOutputs,
    } satisfies BullpenAutoRunWorkflowStageView;
  });

  const currentStage = stages.find((stage) => stage.isCurrent) ?? null;
  const allStagesFinished = stages.every((stage) => stage.state === "finished");
  const currentStageLabel = taskLifecycleLabel ?? (currentStage
    ? currentStage.title
    : activeStageEvidenceUnavailable
      ? "Current stage evidence unavailable"
    : runStatus === "partial_success"
      ? "Stage 3 finished with partial success"
      : allStagesFinished
        ? "All 3 stages finished"
        : runStatus === "completed"
          ? "All 3 stages finished"
          : runStatus === "confirming"
            ? "Stage 3 confirming"
          : runStatus === "failed"
            ? "Last run failed"
            : runStatus === "skipped"
              ? "Last run was skipped"
              : "Queued for the next auto-run");
  const statusCopy =
    taskLifecycleLabel ??
    (runStatus === "failed"
      ? formatBullpenRunSummaryForMonitor(
          normalizedRun?.summary,
          normalizedRun?.error_message ||
            "The latest Bullpen Scan + LLM + Exit and Invest run failed before finishing.",
        )
      : currentStage
        ? `Current stage: ${currentStage.title}`
        : activeStageEvidenceUnavailable
          ? formatBullpenRunSummaryForMonitor(
              normalizedRun?.summary,
              "The run is active, but its compact stage evidence is unavailable. Refresh or open History for the exact run.",
            )
        : runStatus === "confirming"
          ? formatBullpenRunSummaryForMonitor(
              normalizedRun?.summary,
              "Stage 3 queued durable intents and is still confirming terminal order state.",
            )
          : runStatus === "partial_success"
            ? formatBullpenRunSummaryForMonitor(
                normalizedRun?.summary,
                "The latest Bullpen Scan + LLM + Exit and Invest run finished with mixed order outcomes.",
              )
        : allStagesFinished || runStatus === "completed"
          ? "The latest Bullpen Scan + LLM + Exit and Invest run finished all 3 stages."
          : runStatus === "skipped"
            ? formatBullpenRunSummaryForMonitor(
                normalizedRun?.summary,
                "The latest Bullpen Scan + LLM + Exit and Invest run was skipped.",
              )
            : "The next Bullpen Scan + LLM + Exit and Invest run is waiting in queue.");

  return {
    stages,
    currentStageLabel,
    statusCopy,
    runStatus,
  };
}

import type { BullpenAutoLiveRun, BullpenAutoLiveStageResult } from "@/types/api";

type WorkflowTone = "yellow" | "green" | "blue";
type WorkflowState = "current" | "finished" | "queued";
type WorkflowStageKey = "scan" | "llm" | "invest";

export type BullpenAutoRunScanCandidateView = {
  question: string;
  marketUrl: string | null;
  slug: string | null;
  closeTime: string | null;
  theme: string | null;
  currentYesOdds: number | null;
  currentNoOdds: number | null;
  volumeUsd: number | null;
  liquidityUsd: number | null;
  forceInclude: boolean;
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
};

export type BullpenAutoRunWorkflowStageView = {
  key: WorkflowStageKey;
  title: string;
  subtitle: string;
  tone: WorkflowTone;
  state: WorkflowState;
  detail: string;
  progressLabel: string;
  progressPercent: number;
  isCurrent: boolean;
  timerStartedAt: string | null;
  timerCompletedAt: string | null;
  scanCandidates: BullpenAutoRunScanCandidateView[];
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

export function isBullpenAutoRunWorkflowSettled(
  workflowView: BullpenAutoRunWorkflowView,
) {
  const hasQueuedStage = workflowView.stages.some((stage) => stage.state === "queued");
  return !hasQueuedStage && workflowView.stages.every((stage) => stage.state === "finished");
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
    subtitle: "Scans Bullpen while honoring the current exclusions, filters, and active-position rules.",
    defaultDetail: "Waiting for the worker to begin the Bullpen scan.",
    defaultItemLabel: "events",
  },
  {
    key: "llm",
    title: "Stage 2 · Run LLM",
    subtitle: "Runs LLM review on every new event that survives Stage 1.",
    defaultDetail: "Waiting for Stage 1 to finish so LLM review can begin.",
    defaultItemLabel: "events",
  },
  {
    key: "invest",
    title: "Stage 3 · Invest",
    subtitle: "Plans buys and exits, then submits orders when the guardrails allow live execution.",
    defaultDetail: "Waiting for Stage 2 to finish before investment planning starts.",
    defaultItemLabel: "rows",
  },
];

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function appendStageDetail(detail: string, suffix: string) {
  return detail.endsWith(".") ? `${detail} ${suffix}` : `${detail}. ${suffix}`;
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
  if (workflowDefinition.key === "invest") {
    const executionGateReason = readString(stage?.outputs?.execution_gate_reason);
    const executionModeReason = readString(stage?.outputs?.execution_mode_reason);
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
      derivedInputs.active_positions_found = previousOutputs.active_positions_found;
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
  return readString(stage?.outputs?.item_label) ?? workflowDefinition.defaultItemLabel;
}

function getProgressItemLabel(
  stage: BullpenAutoLiveStageResult | null,
  workflowDefinition: WorkflowDefinition,
) {
  const defaultLabel = getItemLabel(stage, workflowDefinition);
  if (workflowDefinition.key !== "invest") return defaultLabel;

  const activePositionRows = readNumber(stage?.outputs?.active_position_rows);
  const candidateDecisionRows = readNumber(stage?.outputs?.candidate_decision_rows);
  if (activePositionRows === null && candidateDecisionRows === null) {
    return defaultLabel;
  }

  return "review rows";
}

function readScanCandidates(stage: BullpenAutoLiveStageResult | null) {
  const rawCandidates = stage?.outputs?.accepted_candidates;
  if (!Array.isArray(rawCandidates)) return [];

  return rawCandidates
    .map((candidate) => {
      if (!candidate || typeof candidate !== "object") return null;
      const record = candidate as Record<string, unknown>;
      const question = readString(record.question);
      if (!question) return null;

      return {
        question,
        marketUrl: readString(record.market_url),
        slug: readString(record.slug),
        closeTime: readString(record.close_time),
        theme: readString(record.theme),
        currentYesOdds: readNumber(record.current_yes_odds),
        currentNoOdds: readNumber(record.current_no_odds),
        volumeUsd: readNumber(record.volume_usd),
        liquidityUsd: readNumber(record.liquidity_usd),
        forceInclude: readBoolean(record.force_include),
      } satisfies BullpenAutoRunScanCandidateView;
    })
    .filter((candidate): candidate is BullpenAutoRunScanCandidateView => Boolean(candidate));
}

function readActivePositionsFound(stage: BullpenAutoLiveStageResult | null) {
  const rawPositions = stage?.outputs?.active_positions_found;
  if (!Array.isArray(rawPositions)) return [];

  return rawPositions
    .map((position) => {
      if (!position || typeof position !== "object") return null;
      const record = position as Record<string, unknown>;
      const marketId = readString(record.market_id);
      const marketTitle = readString(record.market_title) ?? readString(record.question);
      if (!marketId || !marketTitle) return null;

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
      } satisfies BullpenAutoRunActivePositionView;
    })
    .filter((position): position is BullpenAutoRunActivePositionView => Boolean(position));
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
  const runStatus = normalizedRun?.status ?? (pendingRunId ? "running" : "idle");
  const stageResults = WORKFLOW_DEFINITIONS.map((definition, index) =>
    findWorkflowStageResult(normalizedRun, definition, index + 1),
  );
  const completedStageCount = stageResults.filter(
    (stage) => getPhaseStatus(stage) === "completed",
  ).length;
  const currentStageIndex = (() => {
    const runningStageIndex = stageResults.findIndex(
      (stage) => getPhaseStatus(stage) === "running",
    );
    if (runningStageIndex >= 0) return runningStageIndex;
    if (runStatus !== "running") return -1;
    return Math.min(completedStageCount, WORKFLOW_DEFINITIONS.length - 1);
  })();

  const stages = WORKFLOW_DEFINITIONS.map((definition, index) => {
    const stage = stageResults[index];
    const previousStage = index > 0 ? stageResults[index - 1] : null;
    const explicitPhase = getPhaseStatus(stage);
    let state: WorkflowState;
    if (explicitPhase === "completed" || runStatus === "completed") {
      state = "finished";
    } else if (
      index === currentStageIndex &&
      (runStatus === "running" || runStatus === "failed" || runStatus === "skipped")
    ) {
      state = "current";
    } else if (index < completedStageCount) {
      state = "finished";
    } else {
      state = "queued";
    }

    const tone: WorkflowTone =
      state === "finished" ? "green" : state === "current" ? "yellow" : "blue";
    const shouldShowStageData = state !== "queued";
    const stageInputs = readWorkflowInputs(definition, stage, previousStage);
    const completedItems = shouldShowStageData ? getCompletedItems(stage) : null;
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
    const progressLabel =
      !shouldShowStageData
        ? "Queued"
        : totalItems !== null
        ? `${completedItems ?? (state === "finished" ? totalItems : 0)}/${totalItems} ${itemLabel}`
        : state === "finished"
          ? "Finished"
          : state === "current"
            ? "In progress"
            : "Queued";
    const stageTimerStartedAt =
      !shouldShowStageData
        ? null
        : stage?.started_at ??
      (index === 0 && runStatus === "running"
        ? pendingRunStartedAt ?? normalizedRun?.started_at ?? null
        : null);
    const stageTimerCompletedAt =
      !shouldShowStageData
        ? null
        : explicitPhase === "running" && runStatus === "running"
        ? null
        : stage?.completed_at ?? null;
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
      detail = normalizedRun.summary;
    }
    detail = buildStageDetail(stage, detail, definition, normalizedRun);

    return {
      key: definition.key,
      title: definition.title,
      subtitle: definition.subtitle,
      tone,
      state,
      detail,
      progressLabel,
      progressPercent,
      isCurrent: state === "current",
      timerStartedAt: stageTimerStartedAt,
      timerCompletedAt: stageTimerCompletedAt,
      scanCandidates:
        definition.key === "scan" && shouldShowStageData ? readScanCandidates(stage) : [],
      activePositionsFound:
        definition.key === "scan" && shouldShowStageData
          ? readActivePositionsFound(stage)
          : [],
      inputs:
        Object.keys(stageInputs).length > 0 ? stageInputs : {},
      outputs: shouldShowStageData ? readOutputs(stage) : {},
    } satisfies BullpenAutoRunWorkflowStageView;
  });

  const currentStage = stages.find((stage) => stage.isCurrent) ?? null;
  const currentStageLabel = currentStage
    ? currentStage.title
    : runStatus === "completed"
      ? "All 3 stages finished"
      : runStatus === "failed"
        ? "Last run failed"
        : runStatus === "skipped"
          ? "Last run was skipped"
      : "Queued for the next auto-run";
  const statusCopy =
    runStatus === "failed"
      ? normalizedRun?.summary ||
        normalizedRun?.error_message ||
        "The latest Bullpen Scan + LLM + Invest run failed before finishing."
      : currentStage
        ? `Current stage: ${currentStage.title}`
        : runStatus === "completed"
          ? "The latest Bullpen Scan + LLM + Invest run finished all 3 stages."
          : runStatus === "skipped"
          ? normalizedRun?.summary ||
            "The latest Bullpen Scan + LLM + Invest run was skipped."
          : "The next Bullpen Scan + LLM + Invest run is waiting in queue.";

  return {
    stages,
    currentStageLabel,
    statusCopy,
    runStatus,
  };
}

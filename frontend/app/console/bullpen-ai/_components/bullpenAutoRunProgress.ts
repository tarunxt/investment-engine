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
  outputs: Record<string, unknown>;
};

export type BullpenAutoRunWorkflowView = {
  stages: BullpenAutoRunWorkflowStageView[];
  currentStageLabel: string;
  statusCopy: string;
  runStatus: BullpenAutoLiveRun["status"] | "idle";
};

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
    defaultItemLabel: "orders",
  },
];

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
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

function readOutputs(stage: BullpenAutoLiveStageResult | null) {
  if (!stage?.outputs || typeof stage.outputs !== "object" || Array.isArray(stage.outputs)) {
    return {};
  }
  return stage.outputs as Record<string, unknown>;
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
    const completedItems = getCompletedItems(stage);
    const totalItems = getTotalItems(stage);
    const itemLabel = getItemLabel(stage, definition);
    const progressPercent =
      totalItems && totalItems > 0 && completedItems !== null
        ? clampPercent((completedItems / totalItems) * 100)
        : state === "finished"
          ? 100
          : state === "current"
            ? 45
            : 0;
    const progressLabel =
      totalItems !== null
        ? `${completedItems ?? (state === "finished" ? totalItems : 0)}/${totalItems} ${itemLabel}`
        : state === "finished"
          ? "Finished"
          : state === "current"
            ? "In progress"
            : "Queued";
    const stageTimerStartedAt =
      stage?.started_at ??
      (index === 0 && runStatus === "running"
        ? pendingRunStartedAt ?? normalizedRun?.started_at ?? null
        : null);
    let detail =
      stage?.reason ||
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
      timerCompletedAt: stage?.completed_at ?? null,
      scanCandidates: definition.key === "scan" ? readScanCandidates(stage) : [],
      outputs: readOutputs(stage),
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
  const statusCopy = currentStage
    ? `Current stage: ${currentStage.title}`
    : runStatus === "completed"
      ? "The latest Bullpen Scan + LLM + Invest run finished all 3 stages."
      : runStatus === "failed"
        ? normalizedRun?.summary ||
          "The latest Bullpen Scan + LLM + Invest run failed before finishing."
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

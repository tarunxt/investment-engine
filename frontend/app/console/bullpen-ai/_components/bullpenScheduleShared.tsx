"use client";
import { deferBullpenDetail } from "./BullpenDeferredDetail";
const BullpenStage2ActionablesDialog = deferBullpenDetail(() => import("./BullpenStage2ActionablesDialog").then(module => module.BullpenStage2ActionablesDialog));

import { useState } from "react";
import { ChevronDown, FileSpreadsheet, Filter, Info, Wallet, Menu, SlidersHorizontal, X } from "lucide-react";
import { type BullpenQuestionRow, getBullpenAmountToBeInvestedBreakdown, getBullpenReturnsPerDayBreakdown } from "@/lib/bullpen-ai";
import { formatApiTimestamp } from "@/lib/datetime";
import { type BullpenWorkspaceProfile } from "@/lib/bullpenStageOneSettings";
import type { BullpenAutoLiveDecision, BullpenAutoLiveRun, BullpenAutoLiveRunOnceRequest } from "@/types/api";
import { buildBullpenAutoRunWorkflowView } from "./bullpenAutoRunProgress";
import { downloadCompleteStageOneRunExcel, downloadIndependentStageOneExcel, downloadStageOneAllScannedEventsExcel, downloadStageOneFilteredEventsExcel } from "./bullpenStageOneExcel";
import { deriveInvestExecutionStepStatus, getInvestStepMetricDialogKind, getSellInvestMetricDialogKind, summarizeInvestStepCountsFromDecisions, type InvestExecutionStepStatus, type InvestMetricDialogKind } from "./bullpenAutoRunInvestMetrics";
import { buildStageTwoEventsSummaryRows as buildHistoricalStageTwoEventsSummaryRows, getStageTwoLlmReviewedRows as getHistoricalStageTwoLlmReviewedRows, resolveStageTwoEventsSummaryUpdatedAt, resolveStageTwoHistoricalAsOfTimestamp } from "./bullpenAutoRunStageTwoHistory";

import { buildBullpenStage2Actionables } from "./bullpenStage2Actionables";
import { SimpleInfoDialog } from "./BullpenScheduleLazyDetails";

export type InvestMetricDialogState = {
  kind: InvestMetricDialogKind;
  run: BullpenAutoLiveRun;
  stage:
    | ReturnType<typeof buildBullpenAutoRunWorkflowView>["stages"][number]
    | null;
  decisions: BullpenAutoLiveDecision[];
};

export type Stage3PreviewDialogState = {
  sourceRun: BullpenAutoLiveRun | null;
  request: BullpenAutoLiveRunOnceRequest | null;
  decisions: BullpenAutoLiveDecision[];
  plannedOrders: number;
  sellPlannedOrders: number;
  buyPlannedOrders: number;
};

export type ScanCandidateDialogMode =
  | "all-scanned"
  | "fresh-opportunities"
  | "active-positions";

export type RunDetailDialogState = {
  run: BullpenAutoLiveRun;
  decisions: BullpenAutoLiveDecision[];
  decisionListTruncated?: boolean;
  decisionListLimit?: number | null;
};

export type StageTwoInvestEventsDialogState = {
  rows: BullpenQuestionRow[];
  stage: WorkflowStageView | null;
  decisions: BullpenAutoLiveDecision[];
  updatedAt: string | null;
  updateUnavailableReason?: string;
};

export type StageTwoLlmRunDialogState = {
  run: BullpenAutoLiveRun | null;
  stage: WorkflowStageView;
  decisions: BullpenAutoLiveDecision[];
};

export type StageTwoBypassDialogState = {
  reason: string;
  steps: string[];
};

export type ScanCandidateDialogState = {
  runId?: string | null;
  mode: ScanCandidateDialogMode;
  isIndependentStageOne: boolean;
  scanExportId: string | null;
  scanCompletedAt: string | null;
  totalScanned: number;
  passedFilterCount: number;
  rejectedFilterCount: number | null;
  emptyRowsReason: string | null;
  candidates: ScanCandidateDialogCandidate[];
  activePositions: ReturnType<
    typeof buildBullpenAutoRunWorkflowView
  >["stages"][number]["activePositionsFound"];
  activePositionCount: number;
  claimablePositionCount: number;
};

export type ScanCandidateDialogCandidate = ReturnType<
  typeof buildBullpenAutoRunWorkflowView
>["stages"][number]["scanCandidates"][number] & {
  llmYesOdds: number | null;
  llmNoOdds: number | null;
  returnsPerDay: number | null;
  amountToBeInvested: number | null;
};

export const RUN_TIMER_INTERVAL_MS = 5_000;

export function isRequestAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

export function formatIstDateTime(value: string | null | undefined) {
  return formatApiTimestamp(value, {
    emptyValue: "—",
    timeZone: "Asia/Kolkata",
    timeZoneName: "short",
    second: "2-digit",
  });
}

export function formatOddsPercent(value: number | null) {
  if (value === null) return "—";
  return `${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`;
}

export function formatReturnsPerDay(value: number | null) {
  if (value === null) return "—";
  return `${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`;
}

export function formatMoney(value: number | null) {
  if (value === null) return "—";
  return `$${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

export function readStageOutputNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export type WorkflowStageView = ReturnType<
  typeof buildBullpenAutoRunWorkflowView
>["stages"][number];

export function getStageActivePositionCounts(stage: WorkflowStageView) {
  const claimableFromOutputs = Array.isArray(stage.outputs.available_for_claim)
    ? stage.outputs.available_for_claim.length
    : null;
  const claimableFromSnapshot = stage.activePositionsFound.filter(
    (position) => position.isClaimable,
  ).length;
  const openFromOutputs =
    readStageOutputNumber(stage.outputs.active_position_rows_before_llm) ??
    readStageOutputNumber(stage.outputs.active_position_rows) ??
    readStageOutputNumber(stage.outputs.active_positions_total);
  const openFromSnapshot = stage.activePositionsFound.length;

  return {
    open: openFromOutputs ?? openFromSnapshot,
    claimable: claimableFromOutputs ?? claimableFromSnapshot,
  };
}

export function getStageOneStats(stage: WorkflowStageView) {
  const { open: activePositions, claimable: claimablePositions } =
    getStageActivePositionCounts(stage);
  const totalScanned =
    readStageOutputNumber(stage.outputs.scanned_candidates) ??
    readStageOutputNumber(stage.outputs.total_items) ??
    stage.scanCandidates.length;
  const passedFilters =
    readStageOutputNumber(stage.outputs.accepted_candidates_count) ??
    readStageOutputNumber(stage.outputs.candidate_rows_before_llm) ??
    stage.scanCandidates.length;

  return { activePositions, claimablePositions, totalScanned, passedFilters };
}

export function stageOneNotEvaluated(stage: WorkflowStageView) {
  return ["failed", "blocked", "aborted", "cancelled"].includes(String(stage.outputs.phase_status))
    && !stage.outputs.filters_completed_at;
}

export function getStageOneIncludedActiveCount(
  stage: WorkflowStageView,
  stats: ReturnType<typeof getStageOneStats>,
  llmStage?: WorkflowStageView,
  decisions: BullpenAutoLiveDecision[] = [],
  run: BullpenAutoLiveRun | null = null,
) {
  if (stats.activePositions === 0 || stats.passedFilters === 0) return 0;

  if (llmStage) {
    const llmStats = getStageTwoStats(llmStage, decisions, run);
    const aggregatesDescribeSameStageOneInput =
      llmStats.llmRanOn > 0 &&
      llmStats.activePositions === stats.activePositions &&
      llmStats.newOpportunities === stats.passedFilters;

    if (aggregatesDescribeSameStageOneInput) {
      return Math.min(
        stats.activePositions,
        stats.passedFilters,
        Math.max(
          0,
          stats.activePositions + stats.passedFilters - llmStats.llmRanOn,
        ),
      );
    }
  }

  const activeRows = stage.activePositionsFound.filter(
    (position) => !position.isClaimable,
  );
  // Compact historical projections may retain aggregate counts without the
  // corresponding event rows. In that case the exact overlap is unknowable,
  // so omit the suffix instead of presenting the full active count as though
  // every active position passed the fresh-event filters.
  if (
    activeRows.length !== stats.activePositions ||
    stage.scanCandidates.length !== stats.passedFilters
  ) {
    return null;
  }

  const passedFilterKeys = new Set(
    stage.scanCandidates
      .flatMap((candidate) => [
        candidate.marketId,
        candidate.slug,
        candidate.marketUrl,
        candidate.question,
      ])
      .map(normalizeMatchKey)
      .filter((key): key is string => Boolean(key)),
  );

  return activeRows.filter((position) =>
    [
      position.marketId,
      position.slug,
      position.marketUrl,
      position.marketTitle,
    ].some((value) => {
      const key = normalizeMatchKey(value);
      return key ? passedFilterKeys.has(key) : false;
    }),
  ).length;
}

export function getStageTwoStats(
  stage: WorkflowStageView,
  decisions: BullpenAutoLiveDecision[] = [],
  run: BullpenAutoLiveRun | null = null,
) {
  const { open: activePositions, claimable: claimablePositions } =
    getStageActivePositionCounts(stage);
  const explicitNewOpportunities =
    readStageOutputNumber(stage.outputs.stage1_accepted_candidate_count) ??
    readStageOutputNumber(stage.outputs.candidate_rows_before_llm) ??
    readStageOutputNumber(stage.inputs.candidate_rows_before_llm) ??
    (stage.scanCandidates.length > 0 ? stage.scanCandidates.length : null);
  const llmRanOn =
    readStageOutputNumber(stage.outputs.llm_candidate_count) ??
    readStageOutputNumber(stage.outputs.total_items) ??
    activePositions + (explicitNewOpportunities ?? 0);
  // A compact or legacy run can retain the authoritative LLM total while its
  // Stage 1 row arrays/count aliases are absent. Keep the displayed equation
  // internally consistent instead of reporting “44 unique rows (0 + 0)”.
  const newOpportunities =
    explicitNewOpportunities ?? Math.max(0, llmRanOn - activePositions);

  const llmsCompleted = getStageTwoCompletedLlmCount(stage);
  const llmOutcomeCounts = getStageTwoLlmOutcomeCounts(stage, llmsCompleted);
  const stageTwoTargets = getStageTwoLlmTargets(stage);
  const llmsSelected =
    readStageOutputNumber(stage.outputs.llm_provider_target_count) ??
    readStageOutputNumber(stage.outputs.llm_selected_target_count) ??
    readStageOutputNumber(stage.outputs.llm_target_count) ??
    readStageOutputNumber(stage.inputs.llm_provider_target_count) ??
    readStageOutputNumber(stage.inputs.llm_selected_target_count) ??
    readStageOutputNumber(stage.inputs.llm_target_count) ??
    (stageTwoTargets.length > 0
      ? stageTwoTargets.filter((target) => hasStageTwoLlmIdentity(target)).length
      : null) ??
    Math.max(llmsCompleted, 0);
  const actionableContract = readStageTwoActionableDisplayContract(stage.outputs);
  const newEventsToInvestIn = actionableContract.buyCount ?? 0;

  return {
    activePositions,
    claimablePositions,
    newOpportunities,
    llmRanOn,
    llmsCompleted,
    llmsPassed: llmOutcomeCounts.passed,
    llmsFailed: llmOutcomeCounts.failed,
    llmsSelected,
    newEventsToInvestIn,
  };
}

export function buildStageTwoInvestEventsDialogState({
  run,
  decisions,
}: {
  run: BullpenAutoLiveRun | null;
  decisions: BullpenAutoLiveDecision[];
}): StageTwoInvestEventsDialogState | null {
  if (!run) return null;

  const workflowView = buildBullpenAutoRunWorkflowView(run);
  const scanWorkflowStage =
    workflowView.stages.find((stage) => stage.key === "scan") ?? null;
  const llmWorkflowStage =
    workflowView.stages.find((stage) => stage.key === "llm") ?? null;

  if (!llmWorkflowStage) {
    return {
      rows: [],
      stage: null,
      decisions,
      updatedAt: null,
      updateUnavailableReason:
        "Timestamp unavailable because this run did not save a Stage 2 Events Summary.",
    };
  }

  const scanStageResult = getRunWorkflowStageResult(run, "scan", 1);
  const llmStageResult = getRunWorkflowStageResult(run, "llm", 2);
  const reviewedRows = getStageTwoLlmReviewedRows(
    llmWorkflowStage,
    scanWorkflowStage?.scanCandidates ?? [],
    decisions,
  );
  const eventsSummaryAsOfTimestamp = resolveStageTwoHistoricalAsOfTimestamp({
    reviewedRows,
    scanCompletedAt:
      scanStageResult?.completed_at ?? scanWorkflowStage?.timerCompletedAt ?? null,
    stageCompletedAt:
      llmStageResult?.completed_at ?? llmWorkflowStage.timerCompletedAt,
    runStartedAt: run.started_at ?? llmWorkflowStage.timerStartedAt,
    runCompletedAt: run.completed_at ?? null,
    nowMs: Date.now(),
  });
  const eventsSummaryRows = buildHistoricalStageTwoEventsSummaryRows({
    reviewedRows,
    decisions,
    runId: run.id,
    asOfTimestamp: eventsSummaryAsOfTimestamp,
  });
  const updatedAt = resolveStageTwoEventsSummaryUpdatedAt({
    reviewedRows,
    stageCompletedAt:
      llmStageResult?.completed_at ?? llmWorkflowStage.timerCompletedAt,
    scanCompletedAt:
      scanStageResult?.completed_at ?? scanWorkflowStage?.timerCompletedAt ?? null,
  });
  const actionableContract = readStageTwoActionableDisplayContract(
    llmWorkflowStage.outputs,
  );
  const authoritativeBuyMarketIds = actionableContract.buyMarketIds;

  const authoritativeBuyRows = authoritativeBuyMarketIds
    .map((marketId) => {
      const normalizedMarketId = normalizeMatchKey(marketId);
      if (!normalizedMarketId) return null;
      return (
        eventsSummaryRows.find((row) =>
          getStageTwoSummaryRowMatchKeys(row).includes(normalizedMarketId),
        ) ?? null
      );
    })
    .filter((row): row is BullpenQuestionRow => row !== null);

  return {
    stage: llmWorkflowStage,
    decisions,
    rows: actionableContract.hasExactMarketIds ? authoritativeBuyRows : [],
    updatedAt,
    updateUnavailableReason: updatedAt
      ? undefined
      : "Timestamp unavailable because this view is reconstructed from the saved Stage 2 Events Summary.",
  };
}

export function getStageTwoLlmOutcomeCounts(
  stage: WorkflowStageView,
  completedCount: number,
) {
  const explicitPassed =
    readStageOutputNumber(stage.outputs.llm_usable_provider_target_count) ??
    readStageOutputNumber(stage.outputs.llm_passed_provider_target_count) ??
    readStageOutputNumber(stage.outputs.llm_successful_provider_target_count);
  const explicitFailed =
    readStageOutputNumber(stage.outputs.llm_failed_provider_target_count) ??
    readStageOutputNumber(stage.outputs.llm_failed_model_count);
  if (explicitPassed !== null || explicitFailed !== null) {
    const passed =
      explicitPassed ?? Math.max(0, completedCount - (explicitFailed ?? 0));
    const failed = explicitFailed ?? Math.max(0, completedCount - passed);
    return { passed, failed };
  }

  const targetRuns = getStageTwoLlmTargetRuns(stage);
  if (targetRuns.length) {
    const validTargetRuns = targetRuns.filter((run) => hasStageTwoLlmIdentity(run));
    const failed = validTargetRuns.filter((run) =>
      isFailedStageTwoTargetRun(run),
    ).length;
    const passed = validTargetRuns.filter((run) =>
      isUsableStageTwoTargetRun(run),
    ).length;
    return { passed, failed };
  }

  return { passed: completedCount, failed: 0 };
}

export function getStageTwoCompletedLlmCount(stage: WorkflowStageView) {
  const targetRuns = getStageTwoLlmTargetRuns(stage);
  if (targetRuns.length) {
    return targetRuns.filter((run) => {
      if (!hasStageTwoLlmIdentity(run)) return false;
      const status = normalizeStageTwoRunStatus(
        readLlmContextString(run, "status"),
      );
      return (
        status === "completed" || status === "partial" || status === "failed"
      );
    }).length;
  }

  const completedFromOutput =
    readStageOutputNumber(stage.outputs.llm_completed_provider_target_count) ??
    readStageOutputNumber(stage.outputs.llms_completed) ??
    readStageOutputNumber(stage.outputs.llm_completed_model_count);
  if (completedFromOutput !== null) return completedFromOutput;

  const completedTargets = new Set<string>();
  const addTarget = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const provider =
      typeof record.provider === "string" ? record.provider.trim() : "";
    const model = typeof record.model === "string" ? record.model.trim() : "";
    if (provider || model) completedTargets.add(`${provider}/${model}`);
  };

  const reviewedCandidates = stage.outputs.llm_reviewed_candidates;
  if (Array.isArray(reviewedCandidates)) {
    reviewedCandidates.forEach((candidate) => {
      if (!candidate || typeof candidate !== "object") return;
      const llmOutputs = (candidate as Record<string, unknown>).llm_outputs;
      if (Array.isArray(llmOutputs)) llmOutputs.forEach(addTarget);
    });
  }

  return completedTargets.size;
}

export function StageOneRunStats({
  stage,
  llmStage,
  decisions = [],
  run = null,
  hideNumbers = false,
  filtersOnly = false,
  renderInteractiveRows = false,
  onOpenScanCandidateDialog,
  onOpenScanFilters,
  onOpenExcelHistory,
  onRecoverLegacyExport,
  workspaceProfile = "bullpen007",
}: {
  stage: WorkflowStageView;
  llmStage?: WorkflowStageView;
  decisions?: BullpenAutoLiveDecision[];
  run?: BullpenAutoLiveRun | null;
  hideNumbers?: boolean;
  filtersOnly?: boolean;
  renderInteractiveRows?: boolean;
  onOpenScanCandidateDialog?: (
    stage: WorkflowStageView,
    mode: ScanCandidateDialogMode,
  ) => void;
  onOpenScanFilters?: () => void;
  onOpenExcelHistory?: () => void;
  onRecoverLegacyExport?: (
    exportScope: "filtered" | "all-scanned",
  ) => void;
  workspaceProfile?: BullpenWorkspaceProfile;
}) {
  const stats = getStageOneStats(stage);
  const includedActiveCount = getStageOneIncludedActiveCount(
    stage,
    stats,
    llmStage,
    decisions,
    run,
  );
  hideNumbers = hideNumbers || stageOneNotEvaluated(stage);
  const includedActiveLabel =
    !hideNumbers && includedActiveCount !== null
      ? ` (Includes ${includedActiveCount} active event${includedActiveCount === 1 ? "" : "s"})`
      : "";
  const displayStat = (value: number) => (hideNumbers ? "—" : value);
  const scanScope = readStageOutputString(stage.outputs.scan_scope);
  const scanCompleteness = readStageOutputString(
    stage.outputs.scan_completeness,
  );
  const fullUniverseMetrics = [
    ["Bullpen trending rows", stage.outputs.bullpen_trending_rows],
    ["Complete catalogue markets", stage.outputs.complete_catalogue_markets],
    ["Active wallet positions", stage.outputs.active_wallet_positions],
    ["Filter-eligible markets", stage.outputs.accepted_candidates_count],
    [
      "Wallet markets added to union",
      stage.outputs.active_wallet_markets_added_to_union,
    ],
    ["Missing wallet markets", stage.outputs.missing_active_market_count],
  ] as const;
  const rowClassName = renderInteractiveRows
    ? "block text-left underline-offset-2 transition hover:underline focus:outline-none focus:ring-2 focus:ring-emerald-300"
    : undefined;
  const filteredEventRows = buildScanCandidateDialogRows({
    candidates: stage.scanCandidates,
    run,
    decisions,
  });
  const allScannedEventRows = buildScanCandidateDialogRows({
    candidates: stage.scannedCandidates,
    run,
    decisions,
  });
  const isIndependentStageOne = stage.outputs.independent_stage1_scan === true;
  const independentExportId = readStageOutputString(
    stage.outputs.scan_export_id,
  );
  const downloadAllScannedEvents = () => {
    if (isIndependentStageOne) {
      if (independentExportId) {
        downloadIndependentStageOneExcel(
          independentExportId,
          "all-scanned",
          workspaceProfile,
        );
      } else {
        onRecoverLegacyExport?.("all-scanned");
      }
      return;
    }
    if (run?.id) {
      downloadCompleteStageOneRunExcel(run.id);
      return;
    }
    void downloadStageOneAllScannedEventsExcel({
      candidates: allScannedEventRows,
      scanCompletedAt: stage.timerCompletedAt,
    });
  };
  const allScannedDownloadUnavailable =
    hideNumbers ||
    stats.totalScanned === 0 ||
    (isIndependentStageOne
      ? !independentExportId && !onRecoverLegacyExport
      : !run?.id && allScannedEventRows.length === 0);
  const isLegacyExportRecovery =
    isIndependentStageOne && !independentExportId;
  const filteredDownloadUnavailable =
    hideNumbers ||
    stats.passedFilters === 0 ||
    (isIndependentStageOne
      ? !independentExportId && !onRecoverLegacyExport
      : !run?.id && filteredEventRows.length === 0);
  const filteredDownloadLabel = hideNumbers
    ? "Download Excel · filtered event count unknown"
    : `Download Excel with all ${stats.passedFilters} filtered events`;
  const allScannedDownloadLabel = hideNumbers
    ? "Download Excel · scanned event count unknown"
    : isLegacyExportRecovery
    ? `Rescan and download Excel with all currently active events; legacy scan contained ${stats.totalScanned} events`
    : `Download Excel with all ${stats.totalScanned} scanned events`;
  const allScannedDownloadTitle = hideNumbers
    ? "Scanned event count unknown; source evidence unavailable."
    : isLegacyExportRecovery
    ? "Run a fresh exhaustive scan and download all events Excel"
    : "Download all scanned events Excel";
  const downloadFilteredEvents = () => {
    if (isIndependentStageOne) {
      if (independentExportId) {
        downloadIndependentStageOneExcel(
          independentExportId,
          "filtered",
          workspaceProfile,
        );
      } else {
        onRecoverLegacyExport?.("filtered");
      }
      return;
    }
    if (run?.id) {
      downloadCompleteStageOneRunExcel(run.id, "filtered");
      return;
    }
    void downloadStageOneFilteredEventsExcel({
      candidates: filteredEventRows,
      scanCompletedAt: stage.timerCompletedAt,
    });
  };

  if (filtersOnly) {
    const formattedPassedFilters = hideNumbers
      ? "Not evaluated"
      : stats.passedFilters.toLocaleString("en-IN");
    const formattedIncludedActive =
      hideNumbers || includedActiveCount === null
        ? "—"
        : includedActiveCount.toLocaleString("en-IN");

    return (
      <div className="flex h-full flex-col gap-3">
        <button
          type="button"
          onClick={() => onOpenScanCandidateDialog?.(stage, "fresh-opportunities")}
          disabled={!renderInteractiveRows || !onOpenScanCandidateDialog}
          className="group flex w-full items-center gap-3 rounded-xl border border-emerald-200/80 bg-white/80 p-3 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-emerald-300 hover:bg-white hover:shadow-md focus:outline-none focus:ring-2 focus:ring-emerald-300 disabled:pointer-events-none"
          aria-label={hideNumbers ? "Open events that passed filters · count unknown" : `Open ${stats.passedFilters} events that passed filters`}
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700 ring-1 ring-inset ring-emerald-200">
            <Filter className="h-5 w-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-semibold uppercase tracking-[0.12em] text-emerald-700">
              Events that Passed Filters
            </span>
            <span className="mt-0.5 block text-2xl font-bold tabular-nums text-emerald-950">
              {formattedPassedFilters}
            </span>
          </span>
          <ChevronDown className="h-4 w-4 -rotate-90 text-emerald-500 transition-transform group-hover:translate-x-0.5" />
        </button>

        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-emerald-200/80 bg-emerald-100/65 p-3">
            <div className="flex items-center gap-2 text-emerald-700">
              <Wallet className="h-4 w-4" />
              <span className="text-[11px] font-semibold uppercase tracking-[0.1em]">
                Active included
              </span>
            </div>
            <p className="mt-2 text-xl font-bold tabular-nums text-emerald-950">
              {formattedIncludedActive}
            </p>
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_2.75rem] overflow-hidden rounded-xl border border-emerald-200/80 bg-white/75 transition hover:border-emerald-300 hover:bg-white focus-within:ring-2 focus-within:ring-emerald-300">
            <button
              type="button"
              onClick={downloadFilteredEvents}
              disabled={filteredDownloadUnavailable}
              className="p-3 text-left disabled:cursor-not-allowed disabled:opacity-45"
              aria-label={filteredDownloadLabel}
              title="Download filtered events Excel"
            >
              <div className="flex items-center gap-2 text-emerald-700">
                <FileSpreadsheet className="h-4 w-4" />
                <span className="text-[11px] font-semibold uppercase tracking-[0.1em]">
                  Export
                </span>
              </div>
              <p className="mt-2 text-sm font-bold text-emerald-950">
                Download Excel
              </p>
            </button>
            <button
              type="button"
              onClick={onOpenExcelHistory}
              className="inline-flex items-center justify-center border-l border-emerald-200 text-emerald-700 transition hover:bg-emerald-100 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-emerald-400"
              aria-label="Open last 10 Excel scans"
              title="Last 10 Excel scans"
            >
              <Menu className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>

        {onOpenScanFilters ? (
          <button
            type="button"
            onClick={onOpenScanFilters}
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-emerald-300 bg-emerald-700 px-4 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-emerald-800 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-emerald-300 focus:ring-offset-2"
            aria-label="Open scan filters"
          >
            <SlidersHorizontal className="h-4 w-4" />
            View & edit filters
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      {!filtersOnly ? <>
      {scanScope ? (
        <div className="pb-1 text-xs font-semibold text-slate-700">
          Scan: {scanScope === "full_universe" ? "Full Universe" : "Trending"}
          {scanCompleteness
            ? ` · ${scanCompleteness.charAt(0).toUpperCase()}${scanCompleteness.slice(1)}`
            : ""}
        </div>
      ) : null}
      {scanScope === "full_universe" ? (
        <dl className="mb-2 grid grid-cols-2 gap-x-3 gap-y-0.5 rounded-lg border border-emerald-100 bg-white/70 p-2 text-[11px]">
          {fullUniverseMetrics.map(([label, rawValue]) => (
            <div key={label} className="contents">
              <dt className="text-slate-500">{label}</dt>
              <dd className="text-right font-semibold tabular-nums text-slate-800">
                {hideNumbers
                  ? "—"
                  : (readStageOutputNumber(rawValue) ?? "—")}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {renderInteractiveRows && onOpenScanCandidateDialog ? (
        <button
          type="button"
          onClick={() => onOpenScanCandidateDialog(stage, "active-positions")}
          className={`${rowClassName} pt-2`}
        >
          Available for Claim:{" "}
          <span className="font-semibold tabular-nums">
            {displayStat(stats.claimablePositions)}
          </span>
          <br />
          Active Positions:{" "}
          <span className="font-semibold tabular-nums">
            {displayStat(stats.activePositions)}
          </span>
        </button>
      ) : (
        <div className="pt-2">
          Available for Claim:{" "}
          <span className="font-semibold tabular-nums">
            {displayStat(stats.claimablePositions)}
          </span>
          <br />
          Active Positions:{" "}
          <span className="font-semibold tabular-nums">
            {displayStat(stats.activePositions)}
          </span>
        </div>
      )}
      {scanScope === "full_universe" && scanCompleteness !== "complete" && (
        <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
          Full Universe is incomplete. This count covers only collected markets.
          {readStageOutputString(stage.outputs.scan_details) || readStageOutputString(stage.outputs.scan_warning)
            ? ` ${readStageOutputString(stage.outputs.scan_details) || readStageOutputString(stage.outputs.scan_warning)}`
            : " Completion of the final API page has not been verified."}
        </p>
      )}
      {renderInteractiveRows && onOpenScanCandidateDialog ? (
        <div className="flex items-center gap-1.5 pt-2">
          <button
            type="button"
            onClick={() => onOpenScanCandidateDialog(stage, "all-scanned")}
            className={rowClassName}
          >
            Total Events Scanned:{" "}
            <span className="font-semibold tabular-nums">
              {displayStat(stats.totalScanned)}
            </span>
          </button>
          <button
            type="button"
            onClick={downloadAllScannedEvents}
            disabled={allScannedDownloadUnavailable}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-emerald-700 transition hover:bg-emerald-100 focus:outline-none focus:ring-2 focus:ring-emerald-300 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label={allScannedDownloadLabel}
            title={allScannedDownloadTitle}
          >
            <FileSpreadsheet className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 pt-2">
          <span>
            Total Events Scanned:{" "}
            <span className="font-semibold tabular-nums">
              {displayStat(stats.totalScanned)}
            </span>
          </span>
          <button
            type="button"
            onClick={downloadAllScannedEvents}
            disabled={allScannedDownloadUnavailable}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-emerald-700 transition hover:bg-emerald-100 focus:outline-none focus:ring-2 focus:ring-emerald-300 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label={allScannedDownloadLabel}
            title={allScannedDownloadTitle}
          >
            <FileSpreadsheet className="h-4 w-4" />
          </button>
        </div>
      )}
      </> : null}
      {renderInteractiveRows && onOpenScanCandidateDialog ? (
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() =>
                onOpenScanCandidateDialog(stage, "fresh-opportunities")
              }
              className={rowClassName}
            >
              Events that passed Filters:{" "}
              <span className="font-semibold tabular-nums">
                {displayStat(stats.passedFilters)}
              </span>
            </button>
            <button
              type="button"
              onClick={downloadFilteredEvents}
              disabled={filteredDownloadUnavailable}
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-emerald-700 transition hover:bg-emerald-100 focus:outline-none focus:ring-2 focus:ring-emerald-300 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label={filteredDownloadLabel}
              title="Download Excel"
            >
              <FileSpreadsheet className="h-4 w-4" />
            </button>
            {includedActiveLabel ? <span>{includedActiveLabel}</span> : null}
          </div>
          {onOpenScanFilters ? (
            <button
              type="button"
              onClick={onOpenScanFilters}
              className="ml-auto inline-flex items-center rounded-full border border-emerald-200 bg-white px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-emerald-700 shadow-sm transition hover:border-emerald-300 hover:bg-emerald-50 focus:outline-none focus:ring-2 focus:ring-emerald-300"
              aria-label="Open scan filters"
            >
              Filters
            </button>
          ) : null}
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            <span>
              Events that passed Filters:{" "}
              <span className="font-semibold tabular-nums">
                {displayStat(stats.passedFilters)}
              </span>
            </span>
            <button
              type="button"
              onClick={downloadFilteredEvents}
              disabled={filteredDownloadUnavailable}
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-emerald-700 transition hover:bg-emerald-100 focus:outline-none focus:ring-2 focus:ring-emerald-300 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label={filteredDownloadLabel}
              title="Download Excel"
            >
              <FileSpreadsheet className="h-4 w-4" />
            </button>
            {includedActiveLabel ? <span>{includedActiveLabel}</span> : null}
          </span>
          {onOpenScanFilters ? (
            <button
              type="button"
              onClick={onOpenScanFilters}
              className="ml-auto inline-flex items-center rounded-full border border-emerald-200 bg-white px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-emerald-700 shadow-sm transition hover:border-emerald-300 hover:bg-emerald-50 focus:outline-none focus:ring-2 focus:ring-emerald-300"
              aria-label="Open scan filters"
            >
              Filters
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function StageTwoRunStats({
  run,
  stage,
  hideNumbers = false,
  decisions = [],
  onOpenInvestEvents,
  onOpenLlmRunDetails,
  onOpenScanCandidateDialog,
  scanStageForPositionSnapshot,
  activePositionRowsFallback = [],
  activePositionQuestions = [],
}: {
  run: BullpenAutoLiveRun | null;
  stage: WorkflowStageView;
  hideNumbers?: boolean;
  decisions?: BullpenAutoLiveDecision[];
  scanStageForPositionSnapshot?: WorkflowStageView;
  activePositionRowsFallback?: WorkflowStageView["activePositionsFound"];
  activePositionQuestions?: BullpenQuestionRow[];
  onOpenInvestEvents?: (state: StageTwoInvestEventsDialogState) => void;
  onOpenLlmRunDetails?: (state: StageTwoLlmRunDialogState) => void;
  onOpenScanCandidateDialog?: (
    stage: WorkflowStageView,
    mode: ScanCandidateDialogMode,
  ) => void;
}) {
  const [isActionablesDialogOpen, setIsActionablesDialogOpen] =
    useState(false);
  const stage2InvestEventsState = buildStageTwoInvestEventsDialogState({
    run,
    decisions,
  });
  const stats = getStageTwoStats(stage, decisions, run);
  const positionDialogStage = scanStageForPositionSnapshot ?? stage;
  const actionableActivePositions =
    positionDialogStage.activePositionsFound.length > 0
      ? positionDialogStage.activePositionsFound
      : activePositionRowsFallback;
  const positionStats = scanStageForPositionSnapshot
    ? getStageOneStats(scanStageForPositionSnapshot)
    : {
        activePositions: stats.activePositions,
        claimablePositions: stats.claimablePositions,
      };
  const deDuplicatedCount = Math.max(
    0,
    positionStats.activePositions + stats.newOpportunities - stats.llmRanOn,
  );
  const displayStat = (value: number) => (hideNumbers ? "—" : value);
  const actionableContract = readStageTwoActionableDisplayContract(stage.outputs);
  const hasActionableDisplay = actionableContract.hasDisplayCounts;
  const canOpenActionablesDialog = actionableContract.hasExactMarketIds;
  const actionables = canOpenActionablesDialog
      ? buildBullpenStage2Actionables({
        activePositions: actionableActivePositions,
        activePositionQuestions,
        decisions,
        selectedRows: stage2InvestEventsState?.rows ?? [],
        authoritativeActionables: {
          exitMarketIds: actionableContract.exitMarketIds,
          buyMarketIds: actionableContract.buyMarketIds,
        },
      })
    : { eventExits: [], buyNew: [], hold: [] };

  return (
    <div className="space-y-0.5 pt-2">
      <div>
        {onOpenScanCandidateDialog ? (
          <button
            type="button"
            onClick={() =>
              onOpenScanCandidateDialog(positionDialogStage, "active-positions")
            }
            className="text-left underline-offset-2 transition hover:underline focus:outline-none focus:ring-2 focus:ring-amber-300"
          >
            Available for Claim:{" "}
            <span className="font-semibold tabular-nums">
              {displayStat(positionStats.claimablePositions)}
            </span>
            <br />
            Active Positions:{" "}
            <span className="font-semibold tabular-nums">
              {displayStat(positionStats.activePositions)}
            </span>
          </button>
        ) : (
          <>
            Available for Claim:{" "}
            <span className="font-semibold tabular-nums">
              {displayStat(positionStats.claimablePositions)}
            </span>
            <br />
            Active Positions:{" "}
            <span className="font-semibold tabular-nums">
              {displayStat(positionStats.activePositions)}
            </span>
          </>
        )}
      </div>
      <div>
        {onOpenScanCandidateDialog ? (
          <button
            type="button"
            onClick={() =>
              onOpenScanCandidateDialog(
                positionDialogStage,
                "fresh-opportunities",
              )
            }
            className="text-left underline-offset-2 transition hover:underline focus:outline-none focus:ring-2 focus:ring-amber-300"
          >
            New Opportunities:{" "}
            <span className="font-semibold tabular-nums">
              {displayStat(stats.newOpportunities)}
            </span>
          </button>
        ) : (
          <>
            New Opportunities:{" "}
            <span className="font-semibold tabular-nums">
              {displayStat(stats.newOpportunities)}
            </span>
          </>
        )}
      </div>
      <div>
        {onOpenLlmRunDetails ? (
          <button
            type="button"
            onClick={() => onOpenLlmRunDetails({ run, stage, decisions })}
            className="text-left font-medium text-amber-800 underline-offset-2 transition hover:underline focus:outline-none focus:ring-2 focus:ring-amber-300"
            aria-label={`Open details for ${displayStat(stats.llmRanOn)} LLM-reviewed rows`}
          >
            LLM ran on:{" "}
            <span className="font-semibold tabular-nums">
              {displayStat(stats.llmRanOn)}
            </span>{" "}
            unique rows ({" "}
            <span className="font-semibold tabular-nums">
              {displayStat(positionStats.activePositions)}
            </span>{" "}
            Active +{" "}
            <span className="font-semibold tabular-nums">
              {displayStat(stats.newOpportunities)}
            </span>{" "}
            New Opportunities
            {deDuplicatedCount > 0 ? (
              <>
                ,{" "}
                <span className="font-semibold tabular-nums">
                  {displayStat(deDuplicatedCount)}
                </span>{" "}
                overlap/de-duped
              </>
            ) : null}
            )
          </button>
        ) : (
          <>
            LLM ran on:{" "}
            <span className="font-semibold tabular-nums">
              {displayStat(stats.llmRanOn)}
            </span>{" "}
            unique rows ({displayStat(positionStats.activePositions)} Active +{" "}
            {displayStat(stats.newOpportunities)} New Opportunities
            {deDuplicatedCount > 0
              ? `, ${displayStat(deDuplicatedCount)} overlap/de-duped`
              : ""}
            )
          </>
        )}
      </div>
      <div>
        {onOpenLlmRunDetails ? (
          <div className="flex items-start gap-1.5">
            <button
              type="button"
              onClick={() => onOpenLlmRunDetails({ run, stage, decisions })}
              className="text-left font-medium text-amber-800 underline-offset-2 transition hover:underline focus:outline-none focus:ring-2 focus:ring-amber-300"
              aria-label={`Open details for ${displayStat(stats.llmsCompleted)} completed LLM runs`}
            >
              Current run LLMs completed:{" "}
              <span className="font-semibold tabular-nums">
                {displayStat(stats.llmsCompleted)}
              </span>
              /
              <span className="font-semibold tabular-nums">
                {displayStat(stats.llmsSelected)}
              </span>{" "}
              (Passed:{" "}
              <span className="font-semibold tabular-nums">
                {displayStat(stats.llmsPassed)}
              </span>{" "}
              | Failed:{" "}
              <span className="font-semibold tabular-nums">
                {displayStat(stats.llmsFailed)}
              </span>
              )
            </button>
            <button
              type="button"
              onClick={() => onOpenLlmRunDetails({ run, stage, decisions })}
              className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-amber-300 bg-amber-50 text-amber-700 shadow-sm transition hover:border-amber-400 hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-300"
              aria-label="Open LLM completion diagnostics, including selected targets, failures, and captured errors"
              title="Why can selected LLMs show as zero? Open diagnostics"
            >
              <Info className="h-3 w-3" aria-hidden="true" />
            </button>
          </div>
        ) : (
          <>
            Current run LLMs completed:{" "}
            <span className="font-semibold tabular-nums">
              {displayStat(stats.llmsCompleted)}
            </span>
            /
            <span className="font-semibold tabular-nums">
              {displayStat(stats.llmsSelected)}
            </span>{" "}
            (Passed:{" "}
            <span className="font-semibold tabular-nums">
              {displayStat(stats.llmsPassed)}
            </span>{" "}
            | Failed:{" "}
            <span className="font-semibold tabular-nums">
              {displayStat(stats.llmsFailed)}
            </span>
            )
          </>
        )}
      </div>
      <div>
        {onOpenInvestEvents && (stage2InvestEventsState?.rows.length ?? 0) > 0 ? (
          <button
            type="button"
            onClick={() => {
              if (stage2InvestEventsState) {
                onOpenInvestEvents(stage2InvestEventsState);
              }
            }}
            className="text-left font-medium text-emerald-800 underline-offset-2 transition hover:underline focus:outline-none focus:ring-2 focus:ring-emerald-300"
            aria-label={`Open details for ${displayStat(stats.newEventsToInvestIn)} new events to invest in`}
          >
            New Events to Invest in:{" "}
            <span className="font-semibold tabular-nums">
              {hasActionableDisplay
                ? displayStat(stats.newEventsToInvestIn)
                : "—"}
            </span>
          </button>
        ) : (
          <>
            New Events to Invest in:{" "}
            <span className="font-semibold tabular-nums">
              {hasActionableDisplay
                ? displayStat(stats.newEventsToInvestIn)
                : "—"}
            </span>
          </>
        )}
      </div>
      <div>
        {hasActionableDisplay && canOpenActionablesDialog ? (
          <button
            type="button"
            onClick={() => setIsActionablesDialogOpen(true)}
            className="text-left font-medium text-slate-950 underline-offset-2 transition hover:underline focus:outline-none focus:ring-2 focus:ring-amber-300"
            aria-label={`Open authoritative Stage 2 actionables with ${actionables.eventExits.length} exits and ${actionables.buyNew.length} buys`}
            aria-haspopup="dialog"
            aria-expanded={isActionablesDialogOpen}
          >
            Actionables: Exit=
            <span className="font-semibold tabular-nums">
              {displayStat(actionables.eventExits.length)}
            </span>
            {" | Buy="}
            <span className="font-semibold tabular-nums">
              {displayStat(actionables.buyNew.length)}
            </span>
          </button>
        ) : hasActionableDisplay ? (
          <span
            className="font-medium text-slate-950"
            title="Persisted Stage 2 action counts are available; compact row IDs were unavailable for this run."
          >
            Actionables: Exit=
            <span className="font-semibold tabular-nums">
              {displayStat(actionableContract.exitCount ?? 0)}
            </span>
            {" | Buy="}
            <span className="font-semibold tabular-nums">
              {displayStat(actionableContract.buyCount ?? 0)}
            </span>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setIsActionablesDialogOpen(true)}
            className="text-left font-medium text-slate-600 underline-offset-2 transition hover:text-slate-900 hover:underline focus:outline-none focus:ring-2 focus:ring-amber-300"
            aria-label="Explain why Stage 2 actionables are awaiting the authoritative contract"
          >
            Actionables: awaiting authoritative Stage 2 contract
          </button>
        )}
      </div>
      {isActionablesDialogOpen ? (
        canOpenActionablesDialog ? (
          <BullpenStage2ActionablesDialog
            actionables={actionables}
            onClose={() => setIsActionablesDialogOpen(false)}
          />
        ) : (
          <SimpleInfoDialog
            eyebrow="Stage 2 actionables"
            title="Awaiting authoritative Stage 2 contract"
            onClose={() => setIsActionablesDialogOpen(false)}
            sections={[
              { title: "Meaning", body: "Stage 2 has not yet persisted the exact authoritative Exit and Buy market-id contract that Stage 3 is allowed to execute. The UI intentionally avoids guessing actionables from partial or compact progress data." },
              { title: "What is happening now", body: "Stage 2 may still be running selected LLM targets, parsing model output, validating probabilities, ranking rows, or writing the final action contract. Until that durable contract exists, Stage 3 should wait or continue from a previously saved contract only." },
              { title: "Done and waiting", body: `LLM selected: ${displayStat(stats.llmsSelected)}. Completed: ${displayStat(stats.llmsCompleted)}. Passed: ${displayStat(stats.llmsPassed)}. Failed: ${displayStat(stats.llmsFailed)}. New events currently visible: ${hasActionableDisplay ? displayStat(stats.newEventsToInvestIn) : "not authoritative yet"}.` },
              { title: "Current progress", body: "When Stage 2 finishes and saves exact Exit and Buy IDs, this line changes to clickable Exit and Buy counts. If it stays here after Stage 2 is finished, refresh the run detail and check worker logs for a Stage 2 persistence or validation error." },
            ]}
          />
        )
      ) : null}
    </div>
  );
}

export function readStageOutputString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export function readStageOutputBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return false;
}

export function readStageOutputStringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value
    .map((item) => readStageOutputString(item))
    .filter((item): item is string => {
      if (!item) return false;
      const key = item.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export type StageTwoActionableDisplayContract = {
  hasDisplayCounts: boolean;
  hasExactMarketIds: boolean;
  exitMarketIds: string[];
  buyMarketIds: string[];
  exitCount: number | null;
  buyCount: number | null;
};

export function readStageTwoActionableDisplayContract(
  outputs: Record<string, unknown>,
): StageTwoActionableDisplayContract {
  const exitMarketIds = readStageOutputStringList(
    outputs.stage2_actionable_exit_market_ids,
  );
  const buyMarketIds = readStageOutputStringList(
    outputs.stage2_actionable_buy_market_ids,
  );
  const hasExactMarketIds =
    Array.isArray(outputs.stage2_actionable_exit_market_ids) &&
    Array.isArray(outputs.stage2_actionable_buy_market_ids);
  const hasAuthoritativeContract =
    readStageOutputBoolean(
      outputs.stage2_actionable_contract_authoritative,
    ) ||
    readStageOutputBoolean(
      outputs.stage2_actionable_contract_display_recovered,
    );
  const exitCount = hasExactMarketIds
    ? exitMarketIds.length
    : readStageOutputNumber(outputs.stage2_actionable_exit_count);
  const buyCount = hasExactMarketIds
    ? buyMarketIds.length
    : readStageOutputNumber(outputs.stage2_actionable_buy_count);

  return {
    hasDisplayCounts:
      hasAuthoritativeContract && exitCount !== null && buyCount !== null,
    hasExactMarketIds,
    exitMarketIds,
    buyMarketIds,
    exitCount,
    buyCount,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function normalizeMatchKey(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

export function getStageTwoSummaryRowMatchKeys(row: BullpenQuestionRow) {
  return [row.marketId, row.slug, row.marketUrl, row.question]
    .map((key) => normalizeMatchKey(key))
    .filter((key): key is string => Boolean(key));
}

export function findRunStage(
  run: BullpenAutoLiveRun | null,
  workflowStageKey: "scan" | "llm" | "invest",
  fallbackStageNumber: number,
) {
  if (!run) return null;
  return (
    run.stage_results.find(
      (stage) =>
        readStageOutputString(stage.outputs?.workflow_stage_key) ===
        workflowStageKey,
    ) ??
    run.stage_results.find(
      (stage) => stage.stage_number === fallbackStageNumber,
    ) ??
    null
  );
}

export function calculateDaysUntilClose(closeTime: string | null) {
  if (!closeTime) return null;
  const closeDate = new Date(closeTime);
  if (Number.isNaN(closeDate.getTime())) return null;
  return Number(
    ((closeDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000)).toFixed(1),
  );
}

export function buildScanCandidateDialogRows({
  candidates,
  run,
  decisions,
}: {
  candidates: ReturnType<
    typeof buildBullpenAutoRunWorkflowView
  >["stages"][number]["scanCandidates"];
  run: BullpenAutoLiveRun | null;
  decisions: BullpenAutoLiveDecision[];
}): ScanCandidateDialogCandidate[] {
  const stage2 = findRunStage(run, "llm", 2);
  const rawReviewedCandidates = stage2?.outputs?.llm_reviewed_candidates;
  const reviewedCandidates = Array.isArray(rawReviewedCandidates)
    ? rawReviewedCandidates.filter(isRecord)
    : [];
  const reviewedCandidateByLookupKey = new Map<
    string,
    {
      llmYesOdds: number | null;
      llmNoOdds: number | null;
      returnsPerDay: number | null;
      amountToBeInvested: number | null;
    }
  >();

  const addReviewedCandidateLookup = (
    keys: Array<string | null>,
    lookupValue: {
      llmYesOdds: number | null;
      llmNoOdds: number | null;
      returnsPerDay: number | null;
      amountToBeInvested: number | null;
    },
  ) => {
    keys
      .map((key) => normalizeMatchKey(key))
      .filter((key): key is string => Boolean(key))
      .forEach((key) => {
        if (!reviewedCandidateByLookupKey.has(key)) {
          reviewedCandidateByLookupKey.set(key, lookupValue);
        }
      });
  };

  for (const reviewedCandidate of reviewedCandidates) {
    const llmYesOdds =
      readStageOutputNumber(reviewedCandidate.fair_yes_probability_pct) ??
      readStageOutputNumber(reviewedCandidate.llm_yes_odds);
    const llmNoOdds =
      readStageOutputNumber(reviewedCandidate.fair_no_probability_pct) ??
      readStageOutputNumber(reviewedCandidate.llm_no_odds);
    const returnsPerDay = readStageOutputNumber(
      reviewedCandidate.returns_per_day,
    );
    const amountToBeInvested =
      readStageOutputNumber(reviewedCandidate.amount_to_be_invested) ??
      getBullpenAmountToBeInvestedBreakdown({
        llmYesOdds,
        llmNoOdds,
        returnsPerDay,
      }).result;
    const lookupValue = {
      llmYesOdds,
      llmNoOdds,
      returnsPerDay,
      amountToBeInvested,
    };

    addReviewedCandidateLookup(
      [
        readStageOutputString(reviewedCandidate.market_id),
        readStageOutputString(reviewedCandidate.slug),
        readStageOutputString(reviewedCandidate.market_url),
        readStageOutputString(reviewedCandidate.question),
      ],
      lookupValue,
    );
  }

  for (const decision of decisions) {
    const llmYesOdds = readStageOutputNumber(decision.fair_yes_probability_pct);
    const llmNoOdds = readStageOutputNumber(decision.fair_no_probability_pct);
    const returnsPerDay = getDecisionReturnsPerDay(decision);
    addReviewedCandidateLookup(
      [
        decision.market_id,
        decision.slug ?? null,
        decision.market_url ?? null,
        decision.market_title,
      ],
      {
        llmYesOdds,
        llmNoOdds,
        returnsPerDay,
        amountToBeInvested: getBullpenAmountToBeInvestedBreakdown({
          llmYesOdds,
          llmNoOdds,
          returnsPerDay,
        }).result,
      },
    );
  }

  return candidates.map((candidate) => {
    const matchedReviewedCandidate =
      [
        normalizeMatchKey(candidate.marketId),
        normalizeMatchKey(candidate.slug),
        normalizeMatchKey(candidate.marketUrl),
        normalizeMatchKey(candidate.question),
      ]
        .map((key) =>
          key ? (reviewedCandidateByLookupKey.get(key) ?? null) : null,
        )
        .find((item) => item !== null) ?? null;
    const llmYesOdds = matchedReviewedCandidate?.llmYesOdds ?? null;
    const llmNoOdds = matchedReviewedCandidate?.llmNoOdds ?? null;
    const derivedReturnsPerDay =
      matchedReviewedCandidate?.returnsPerDay ??
      getBullpenReturnsPerDayBreakdown({
        yesOdds: candidate.currentYesOdds,
        noOdds: candidate.currentNoOdds,
        llmYesOdds,
        llmNoOdds,
        daysUntilClose: calculateDaysUntilClose(candidate.closeTime),
      }).result;
    const amountToBeInvested =
      matchedReviewedCandidate?.amountToBeInvested ??
      getBullpenAmountToBeInvestedBreakdown({
        llmYesOdds,
        llmNoOdds,
        returnsPerDay: derivedReturnsPerDay,
      }).result;

    return {
      ...candidate,
      llmYesOdds,
      llmNoOdds,
      returnsPerDay: derivedReturnsPerDay,
      amountToBeInvested,
    };
  });
}

export function isInvestMetricDecisionRow(
  value: unknown,
): value is BullpenAutoLiveDecision {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.run_id === "string" &&
    typeof value.market_id === "string" &&
    typeof value.market_title === "string" &&
    typeof value.decision === "string" &&
    typeof value.side === "string" &&
    typeof value.reason === "string"
  );
}

export function readInvestStageDecisionRows(
  stage:
    | ReturnType<typeof buildBullpenAutoRunWorkflowView>["stages"][number]
    | null,
) {
  if (!stage || stage.key !== "invest") return [];
  const rawDecisionRows = stage.outputs.decision_rows;
  if (!Array.isArray(rawDecisionRows)) return [];
  return rawDecisionRows.filter(isInvestMetricDecisionRow);
}

export function mergeInvestStageDecisionRows({
  stage,
  persistedDecisions,
}: {
  stage:
    | ReturnType<typeof buildBullpenAutoRunWorkflowView>["stages"][number]
    | null;
  persistedDecisions: BullpenAutoLiveDecision[];
}) {
  const merged = new Map<string, BullpenAutoLiveDecision>();

  for (const decision of readInvestStageDecisionRows(stage)) {
    merged.set(decision.id, decision);
  }
  for (const decision of persistedDecisions) {
    merged.set(decision.id, decision);
  }

  return [...merged.values()];
}

export type RunSummaryWarning = { label: string; detail: string };

export type RunSummaryDetails = {
  overview: string | null;
  warnings: RunSummaryWarning[];
};

export function getRunSummaryDetails(
  summary: string | null | undefined,
): RunSummaryDetails {
  const text = summary?.trim();
  if (!text) return { overview: null, warnings: [] };

  const normalized = text
    .replace(/\s+([✗✓✔])\s+/g, "\n$1 ")
    .replace(/\s+(?=0x[a-f0-9]{6,}:)/gi, "\n")
    .replace(/:\s+(\[(?:warn|warning|error|fail|info)\])/gi, ":\n$1")
    .replace(/\s+(?=\[(?:warn|warning|error|fail|info)\])/gi, "\n");

  const lineItems = normalized
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean);

  const firstDetailIndex = lineItems.findIndex((item) =>
    /^(?:0x[a-f0-9]{6,}:|[✗✓✔]|\[(?:warn|warning|error|fail|info)\])/i.test(
      item,
    ),
  );
  const overviewItems =
    firstDetailIndex === -1 ? lineItems : lineItems.slice(0, firstDetailIndex);
  const detailItems =
    firstDetailIndex === -1 ? [] : lineItems.slice(firstDetailIndex);

  return {
    overview: overviewItems.join(" ").trim() || null,
    warnings: detailItems.map((detail, index) => {
      const bracketMatch = detail.match(/^\[([^\]]+)\]\s*(.*)$/);
      if (bracketMatch) {
        return {
          label: bracketMatch[1].trim(),
          detail: bracketMatch[2].trim() || "—",
        };
      }
      const prefixedMatch = detail.match(/^(0x[a-f0-9]{6,}:)\s*(.*)$/i);
      if (prefixedMatch) {
        return {
          label: prefixedMatch[1],
          detail: prefixedMatch[2].trim() || "—",
        };
      }
      return { label: `Detail ${index + 1}`, detail };
    }),
  };
}

export function getInvestStageMetric(
  stage:
    | ReturnType<typeof buildBullpenAutoRunWorkflowView>["stages"][number]
    | null,
  key: string,
  fallback: number,
) {
  if (!stage || stage.key !== "invest") return fallback;
  return readStageOutputNumber(stage.outputs[key]) ?? fallback;
}

export function usesPersistedStage3ExecutionCounters(
  outputs: Record<string, unknown> | null | undefined,
) {
  if (!outputs) return false;
  const counters = outputs.persisted_execution_counters;
  return (
    isRecord(counters) &&
    readStageOutputString(counters.source) === "persisted_order_intents"
  );
}

export type InvestExecutionStepView = {
  key: "sell" | "buy";
  stepNumber: number;
  stepTotal: number;
  label: string;
  status: InvestExecutionStepStatus;
  displayStatusLabel?: string;
  detail: string | null;
  plannedOrders: number | null;
  processedOrders: number | null;
  submittedOrders: number | null;
  eventExitRows?: number | null;
  rankingLlmPlannedOrders?: number | null;
  forcedExitPlannedOrders?: number | null;
  redeemPlannedOrders?: number | null;
  redeemProcessedOrders?: number | null;
  redeemSubmittedOrders?: number | null;
  rankingLlmSubmittedOrders?: number | null;
  forcedExitSubmittedOrders?: number | null;
};

export function normalizeInvestExecutionStepStatus(
  value: unknown,
): InvestExecutionStepStatus | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "pending" ||
    normalized === "running" ||
    normalized === "completed" ||
    normalized === "blocked"
  ) {
    return normalized;
  }
  return null;
}

export function getSubmittedSellSubpartCounts(decisions: BullpenAutoLiveDecision[]) {
  const counts = summarizeInvestStepCountsFromDecisions("sell", decisions);

  return {
    redeem: counts.redeemSubmittedOrders ?? 0,
    rankingOrLlm: counts.rankingLlmSubmittedOrders ?? 0,
    forced: counts.forcedExitSubmittedOrders ?? 0,
  };
}

export function getInvestStageExecutionSteps(
  stage: ReturnType<typeof buildBullpenAutoRunWorkflowView>["stages"][number],
  decisions: BullpenAutoLiveDecision[] = [],
) {
  if (stage.key !== "invest") return [];

  const submittedSellSubpartCounts = getSubmittedSellSubpartCounts(decisions);
  const sellDecisionCounts = summarizeInvestStepCountsFromDecisions(
    "sell",
    decisions,
  );
  const buyDecisionCounts = summarizeInvestStepCountsFromDecisions(
    "buy",
    decisions,
  );
  const usePersistedCounters = usesPersistedStage3ExecutionCounters(
    stage.outputs,
  );

  const rawSteps = stage.outputs.execution_steps;
  if (!Array.isArray(rawSteps)) return [];

  return rawSteps
    .map((step): InvestExecutionStepView | null => {
      if (!isRecord(step)) return null;
      const key = readStageOutputString(step.key);
      const label = readStageOutputString(step.label);
      const status = normalizeInvestExecutionStepStatus(step.status);
      const stepNumber = readStageOutputNumber(step.step_number);
      const stepTotal = readStageOutputNumber(step.step_total);
      if (
        (key !== "sell" && key !== "buy") ||
        !label ||
        !status ||
        stepNumber === null ||
        stepTotal === null
      ) {
        return null;
      }

      const decisionCounts = key === "sell" ? sellDecisionCounts : buyDecisionCounts;
      const plannedOrders = usePersistedCounters
        ? (readStageOutputNumber(step.planned_orders) ?? 0)
        : Math.max(
            readStageOutputNumber(step.planned_orders) ?? 0,
            decisionCounts.plannedOrders,
          );
      const processedOrders = usePersistedCounters
        ? (readStageOutputNumber(step.processed_orders) ?? 0)
        : Math.max(
            readStageOutputNumber(step.processed_orders) ?? 0,
            decisionCounts.processedOrders,
          );

      return {
        key,
        stepNumber,
        stepTotal,
        label,
        status: deriveInvestExecutionStepStatus({
          status,
          plannedOrders,
          processedOrders,
        }),
        displayStatusLabel: undefined,
        detail: readStageOutputString(step.detail),
        plannedOrders,
        processedOrders,
        submittedOrders: usePersistedCounters
          ? (readStageOutputNumber(step.submitted_orders) ?? 0)
          : Math.max(
              readStageOutputNumber(step.submitted_orders) ?? 0,
              decisionCounts.submittedOrders,
            ),
        eventExitRows:
          key === "sell" && !usePersistedCounters
            ? Math.max(
                readStageOutputNumber(step.event_exit_rows) ?? 0,
                sellDecisionCounts.eventExitRows ?? 0,
              )
            : readStageOutputNumber(step.event_exit_rows),
        rankingLlmPlannedOrders:
          key === "sell" && !usePersistedCounters
            ? Math.max(
                readStageOutputNumber(step.ranking_llm_planned_orders) ?? 0,
                sellDecisionCounts.rankingLlmPlannedOrders ?? 0,
              )
            : readStageOutputNumber(step.ranking_llm_planned_orders),
        forcedExitPlannedOrders:
          key === "sell" && !usePersistedCounters
            ? Math.max(
                readStageOutputNumber(step.forced_exit_planned_orders) ?? 0,
                sellDecisionCounts.forcedExitPlannedOrders ?? 0,
              )
            : readStageOutputNumber(step.forced_exit_planned_orders),
        redeemPlannedOrders:
          key === "sell" && !usePersistedCounters
            ? Math.max(
                readStageOutputNumber(step.redeem_planned_orders) ?? 0,
                sellDecisionCounts.redeemPlannedOrders ?? 0,
              )
            : readStageOutputNumber(step.redeem_planned_orders),
        redeemProcessedOrders:
          key === "sell" && !usePersistedCounters
            ? Math.max(
                readStageOutputNumber(step.redeem_processed_orders) ?? 0,
                sellDecisionCounts.redeemProcessedOrders ?? 0,
              )
            : readStageOutputNumber(step.redeem_processed_orders),
        redeemSubmittedOrders:
          key === "sell" && !usePersistedCounters
            ? Math.max(
                readStageOutputNumber(step.redeem_submitted_orders) ?? 0,
                submittedSellSubpartCounts.redeem,
              )
            : readStageOutputNumber(step.redeem_submitted_orders),
        rankingLlmSubmittedOrders:
          key === "sell"
            ? Math.max(
                readStageOutputNumber(step.ranking_llm_submitted_orders) ?? 0,
                submittedSellSubpartCounts.rankingOrLlm,
              )
            : readStageOutputNumber(step.ranking_llm_submitted_orders),
        forcedExitSubmittedOrders:
          key === "sell"
            ? Math.max(
                readStageOutputNumber(step.forced_exit_submitted_orders) ?? 0,
                submittedSellSubpartCounts.forced,
              )
            : readStageOutputNumber(step.forced_exit_submitted_orders),
      };
    })
    .filter((step): step is InvestExecutionStepView => step !== null);
}

export function getLastInvestExecutionStep(
  run: BullpenAutoLiveRun | null,
  key: "sell" | "buy",
  decisions: BullpenAutoLiveDecision[] = [],
) {
  const investStage = run?.stage_results.find(
    (stage) => stage.stage_number === 3 || stage.stage_name === "invest",
  );
  const rawSteps = investStage?.outputs.execution_steps;
  if (!Array.isArray(rawSteps)) return null;
  const usePersistedCounters = usesPersistedStage3ExecutionCounters(
    investStage?.outputs,
  );
  const decisionCounts =
    !usePersistedCounters && decisions.length > 0
      ? summarizeInvestStepCountsFromDecisions(key, decisions)
      : null;

  for (const rawStep of rawSteps) {
    if (!isRecord(rawStep) || readStageOutputString(rawStep.key) !== key) {
      continue;
    }

    return {
      plannedOrders: Math.max(
        readStageOutputNumber(rawStep.planned_orders) ?? 0,
        decisionCounts?.plannedOrders ?? 0,
      ),
      processedOrders: Math.max(
        readStageOutputNumber(rawStep.processed_orders) ?? 0,
        decisionCounts?.processedOrders ?? 0,
      ),
      submittedOrders: Math.max(
        readStageOutputNumber(rawStep.submitted_orders) ?? 0,
        decisionCounts?.submittedOrders ?? 0,
      ),
      eventExitRows:
        key === "sell"
          ? Math.max(
              readStageOutputNumber(rawStep.event_exit_rows) ?? 0,
              decisionCounts?.eventExitRows ?? 0,
            )
          : readStageOutputNumber(rawStep.event_exit_rows),
      rankingLlmPlannedOrders:
        key === "sell"
          ? Math.max(
              readStageOutputNumber(rawStep.ranking_llm_planned_orders) ?? 0,
              decisionCounts?.rankingLlmPlannedOrders ?? 0,
            )
          : readStageOutputNumber(rawStep.ranking_llm_planned_orders),
      forcedExitPlannedOrders:
        key === "sell"
          ? Math.max(
              readStageOutputNumber(rawStep.forced_exit_planned_orders) ?? 0,
              decisionCounts?.forcedExitPlannedOrders ?? 0,
            )
          : readStageOutputNumber(rawStep.forced_exit_planned_orders),
      redeemPlannedOrders:
        key === "sell"
          ? Math.max(
              readStageOutputNumber(rawStep.redeem_planned_orders) ?? 0,
              decisionCounts?.redeemPlannedOrders ?? 0,
            )
          : readStageOutputNumber(rawStep.redeem_planned_orders),
      redeemProcessedOrders:
        key === "sell"
          ? Math.max(
              readStageOutputNumber(rawStep.redeem_processed_orders) ?? 0,
              decisionCounts?.redeemProcessedOrders ?? 0,
            )
          : readStageOutputNumber(rawStep.redeem_processed_orders),
      redeemSubmittedOrders:
        key === "sell"
          ? Math.max(
              readStageOutputNumber(rawStep.redeem_submitted_orders) ?? 0,
              decisionCounts?.redeemSubmittedOrders ?? 0,
            )
          : readStageOutputNumber(rawStep.redeem_submitted_orders),
      rankingLlmSubmittedOrders:
        key === "sell"
          ? Math.max(
              readStageOutputNumber(rawStep.ranking_llm_submitted_orders) ?? 0,
              decisionCounts?.rankingLlmSubmittedOrders ?? 0,
            )
          : readStageOutputNumber(rawStep.ranking_llm_submitted_orders),
      forcedExitSubmittedOrders:
        key === "sell"
          ? Math.max(
              readStageOutputNumber(rawStep.forced_exit_submitted_orders) ?? 0,
              decisionCounts?.forcedExitSubmittedOrders ?? 0,
            )
          : readStageOutputNumber(rawStep.forced_exit_submitted_orders),
    };
  }

  if (key !== "sell" || !investStage) return null;
  return {
    plannedOrders:
      readStageOutputNumber(investStage.outputs.event_exit_planned) ?? 0,
    processedOrders:
      readStageOutputNumber(investStage.outputs.event_exit_processed) ?? 0,
    submittedOrders:
      readStageOutputNumber(investStage.outputs.event_exit_submitted) ?? 0,
    eventExitRows: readStageOutputNumber(investStage.outputs.event_exit_rows),
    rankingLlmPlannedOrders: readStageOutputNumber(
      investStage.outputs.event_exit_ranking_llm_planned,
    ),
    forcedExitPlannedOrders: readStageOutputNumber(
      investStage.outputs.event_exit_forced_planned,
    ),
    redeemPlannedOrders: readStageOutputNumber(
      investStage.outputs.redeem_planned,
    ),
    redeemProcessedOrders: readStageOutputNumber(
      investStage.outputs.redeem_processed,
    ),
    redeemSubmittedOrders: readStageOutputNumber(
      investStage.outputs.redeem_submitted,
    ),
    rankingLlmSubmittedOrders: readStageOutputNumber(
      investStage.outputs.event_exit_ranking_llm_submitted,
    ),
    forcedExitSubmittedOrders: readStageOutputNumber(
      investStage.outputs.event_exit_forced_submitted,
    ),
  };
}

export function getInvestExecutionStepClasses(status: InvestExecutionStepStatus) {
  if (status === "completed") {
    return {
      container:
        "border-emerald-200 bg-emerald-50/80 dark:border-emerald-400/30 dark:bg-emerald-950/35",
      badge:
        "border-emerald-200 bg-emerald-100 text-emerald-900 dark:border-emerald-400/30 dark:bg-emerald-500/10 dark:text-emerald-100",
      text: "text-emerald-950 dark:text-emerald-50",
      muted: "text-emerald-900/80 dark:text-emerald-100/75",
    };
  }
  if (status === "blocked") {
    return {
      container:
        "border-rose-200 bg-rose-50/80 dark:border-rose-400/30 dark:bg-rose-950/35",
      badge:
        "border-rose-200 bg-rose-100 text-rose-900 dark:border-rose-400/30 dark:bg-rose-500/10 dark:text-rose-100",
      text: "text-rose-950 dark:text-rose-50",
      muted: "text-rose-900/80 dark:text-rose-100/75",
    };
  }
  if (status === "running") {
    return {
      container:
        "border-amber-200 bg-amber-50/80 dark:border-amber-400/30 dark:bg-amber-950/35",
      badge:
        "border-amber-200 bg-amber-100 text-amber-900 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-100",
      text: "text-amber-950 dark:text-amber-50",
      muted: "text-amber-900/80 dark:text-amber-100/75",
    };
  }
  return {
    container:
      "border-slate-200 bg-slate-50/80 dark:border-slate-700/80 dark:bg-slate-950/60",
    badge:
      "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700/80 dark:bg-slate-900 dark:text-slate-200",
    text: "text-slate-950 dark:text-slate-50",
    muted: "text-slate-600 dark:text-slate-300",
  };
}

export function extractErrorCodeFromDetail(detail: string | null | undefined) {
  const trimmed = detail?.trim();
  if (!trimmed) return null;

  const jsonStart = trimmed.indexOf("{");
  const jsonText = jsonStart >= 0 ? trimmed.slice(jsonStart) : trimmed;
  try {
    const parsed = JSON.parse(jsonText) as {
      error_code?: unknown;
      code?: unknown;
      status?: unknown;
    };
    const code =
      typeof parsed.error_code === "string" &&
      parsed.error_code.trim().length > 0
        ? parsed.error_code.trim()
        : typeof parsed.code === "string" && parsed.code.trim().length > 0
          ? parsed.code.trim()
          : null;
    if (code) return code;
  } catch {
    // Fall through to regex extraction for non-JSON / prefixed messages.
  }

  const errorCodeMatch = trimmed.match(
    /["']?error_code["']?\s*[:=]\s*["']?([A-Z0-9_:-]+)["']?/i,
  );
  if (errorCodeMatch?.[1]) return errorCodeMatch[1];

  if (
    /insufficient balance/i.test(trimmed) ||
    /balance_insufficient/i.test(trimmed)
  ) {
    return "BALANCE_INSUFFICIENT";
  }

  return null;
}

export function ErrorCodeWithDetails({
  detail,
  detailClassName = "text-slate-700",
  summaryPrefix,
}: {
  detail: string;
  detailClassName?: string;
  summaryPrefix?: string | null;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const code = extractErrorCodeFromDetail(detail);
  if (!code) return <>{detail}</>;

  return (
    <span className="block">
      <span className="inline-flex items-center gap-1.5 align-middle">
        {summaryPrefix ? <span>{summaryPrefix}</span> : null}
        <span className="font-semibold">{code}</span>
        <button
          type="button"
          onClick={() => setIsOpen((current) => !current)}
          className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-current/30 bg-white/60 transition hover:bg-white focus:outline-none focus:ring-2 focus:ring-sky-300"
          aria-expanded={isOpen}
          aria-label={isOpen ? "Hide error details" : "Show error details"}
          title={isOpen ? "Hide error details" : "Show error details"}
        >
          <Info className="h-3 w-3" />
        </button>
      </span>
      {isOpen ? (
        <span
          className="fixed inset-0 z-[180] flex items-center justify-center bg-slate-950/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="bullpen-error-detail-title"
          onClick={() => setIsOpen(false)}
        >
          <span
            className="flex max-h-[82vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white text-left shadow-[0_28px_80px_-24px_rgba(15,23,42,0.55)]"
            onClick={(event) => event.stopPropagation()}
          >
            <span className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
              <span>
                <span className="block text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
                  Error detail
                </span>
                <span
                  id="bullpen-error-detail-title"
                  className="mt-1 block text-lg font-semibold text-slate-950"
                >
                  {code}
                </span>
              </span>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
                aria-label="Close error details"
              >
                <X className="h-4 w-4" />
              </button>
            </span>
            <span
              className={`block flex-1 overflow-auto whitespace-pre-wrap break-words bg-rose-50/80 px-5 py-4 text-xs leading-6 ${detailClassName}`}
            >
              {detail}
            </span>
          </span>
        </span>
      ) : null}
    </span>
  );
}

export function getInvestExecutionStepStatusLabel(status: InvestExecutionStepStatus) {
  if (status === "completed") return "Finished";
  if (status === "blocked") return "Blocked";
  if (status === "running") return "Working";
  return "Pending";
}

export function getInvestStageCounters(
  stage: ReturnType<typeof buildBullpenAutoRunWorkflowView>["stages"][number],
  decisions: BullpenAutoLiveDecision[] = [],
) {
  if (stage.key !== "invest") return [];

  const sellCounts = summarizeInvestStepCountsFromDecisions("sell", decisions);
  const buyCounts = summarizeInvestStepCountsFromDecisions("buy", decisions);
  const rawPlanned = readStageOutputNumber(stage.outputs.orders_planned);
  const rawSubmitted = readStageOutputNumber(stage.outputs.orders_submitted);
  const usePersistedCounters = usesPersistedStage3ExecutionCounters(
    stage.outputs,
  );
  const derivedPlanned = sellCounts.plannedOrders + buyCounts.plannedOrders;
  const derivedSubmitted = sellCounts.submittedOrders + buyCounts.submittedOrders;
  if (
    rawPlanned === null &&
    rawSubmitted === null &&
    derivedPlanned === 0 &&
    derivedSubmitted === 0
  ) {
    return [];
  }
  const planned = usePersistedCounters
    ? (rawPlanned ?? 0)
    : Math.max(rawPlanned ?? 0, derivedPlanned);
  const submitted = usePersistedCounters
    ? (rawSubmitted ?? 0)
    : Math.max(rawSubmitted ?? 0, derivedSubmitted);

  return [
    { label: "Planned", value: planned ?? 0 },
    { label: "Submitted", value: submitted ?? 0 },
  ];
}

export function InvestExecutionStepsSummary({
  steps,
  compact = false,
  onOpenMetricDetails,
  onOpenEventExitInfo,
  onOpenInvestEligibilityInfo,
}: {
  steps: InvestExecutionStepView[];
  compact?: boolean;
  onOpenMetricDetails?: (kind: InvestMetricDialogKind) => void;
  onOpenEventExitInfo?: () => void;
  onOpenInvestEligibilityInfo?: (trigger: HTMLButtonElement | null) => void;
}) {
  if (steps.length === 0) return null;

  const gridClasses = compact ? "grid gap-2" : "grid gap-2 md:grid-cols-2";

  const renderMetricCard = ({
    label,
    value,
    kind,
    toneClasses,
    onOpenInfo,
  }: {
    label: string;
    value: number | null | undefined;
    kind?: InvestMetricDialogKind;
    toneClasses: ReturnType<typeof getInvestExecutionStepClasses>;
    onOpenInfo?: () => void;
  }) => {
    const body = (
      <>
        <p className="flex items-center gap-1 text-[10px] uppercase tracking-[0.1em]">
          <span>{label}</span>
          {onOpenInfo ? (
            <span
              role="button"
              tabIndex={0}
              onClick={(event) => {
                event.stopPropagation();
                onOpenInfo();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  event.stopPropagation();
                  onOpenInfo();
                }
              }}
              className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-current/30 bg-white/70"
              aria-label={`Explain ${label}`}
              title={`Explain ${label}`}
            >
              <Info className="h-2.5 w-2.5" />
            </span>
          ) : null}
        </p>
        <p className={`mt-1 text-sm font-semibold ${toneClasses.text}`}>
          {value ?? "—"}
        </p>
      </>
    );

    const className = `min-w-[5.25rem] flex-1 rounded-lg border border-white/70 bg-white/60 px-2.5 py-2 text-left`;
    if (!kind || !onOpenMetricDetails) {
      return <div className={className}>{body}</div>;
    }

    return (
      <button
        type="button"
        onClick={() => onOpenMetricDetails(kind)}
        className={`${className} transition hover:-translate-y-0.5 hover:bg-white focus:outline-none focus:ring-2 focus:ring-sky-300`}
      >
        {body}
      </button>
    );
  };

  return (
    <div className={gridClasses}>
      {steps.map((step) => {
        const renderedStatus = step.status;
        const renderedStatusLabel =
          step.displayStatusLabel ??
          getInvestExecutionStepStatusLabel(renderedStatus);
        const toneClasses = getInvestExecutionStepClasses(renderedStatus);
        return (
          <div
            key={step.key}
            className={`rounded-xl border px-3 py-3 ${toneClasses.container}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p
                  className={`text-[11px] font-semibold uppercase tracking-[0.14em] ${toneClasses.muted}`}
                >
                  Step {step.stepNumber} of {step.stepTotal}
                </p>
                <div className="mt-1 flex items-center gap-2">
                  <p className={`text-sm font-semibold ${toneClasses.text}`}>
                    {step.label}
                  </p>
                  {step.key === "sell" && onOpenEventExitInfo ? (
                    <button
                      type="button"
                      onClick={onOpenEventExitInfo}
                      className={`inline-flex h-6 w-6 items-center justify-center rounded-full border border-white/80 bg-white/70 ${toneClasses.text}`}
                      aria-label="Explain Event Exit strategies"
                      title="Explain Event Exit strategies"
                    >
                      <Info className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                  {step.key === "buy" && onOpenInvestEligibilityInfo ? (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onOpenInvestEligibilityInfo(event.currentTarget);
                      }}
                      className={`inline-flex h-6 w-6 items-center justify-center rounded-full border border-white/80 bg-white/70 ${toneClasses.text}`}
                      aria-label="Explain Stage 2 to Stage 3 planned strategy"
                      title="Explain Stage 2 to Stage 3 planned strategy"
                      aria-haspopup="dialog"
                    >
                      <Info className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
              </div>
              <span
                className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] ${toneClasses.badge}`}
              >
                {renderedStatusLabel}
              </span>
            </div>
            {step.key === "buy" && step.plannedOrders === 0 ? null : (
              <p className={`mt-3 text-xs leading-5 ${toneClasses.muted}`}>
                {step.detail ?? "Waiting for the worker to update this step."}
              </p>
            )}
            <div
              className={`mt-3 flex flex-wrap gap-2 text-xs ${toneClasses.muted}`}
            >
              {renderMetricCard({
                label: "Planned",
                value: step.plannedOrders,
                kind: getInvestStepMetricDialogKind(step.key, "planned"),
                toneClasses,
              })}
              {renderMetricCard({
                label: "Processed",
                value: step.processedOrders,
                kind: getInvestStepMetricDialogKind(step.key, "processed"),
                toneClasses,
              })}
              <div className="min-w-[5.25rem] flex-[2_1_14rem] rounded-lg border border-white/70 bg-white/60 px-2.5 py-2">
                {renderMetricCard({
                  label: "Submitted",
                  value: step.submittedOrders,
                  kind: getInvestStepMetricDialogKind(step.key, "submitted"),
                  toneClasses,
                })}
                {step.key === "sell" ? (
                  <div className="mt-2 border-t border-white/70 pt-2">
                    <p className={`text-[10px] font-semibold uppercase tracking-[0.12em] ${toneClasses.muted}`}>
                      Submitted sub-parts
                    </p>
                    <div className="mt-2 grid gap-2 sm:grid-cols-3">
                      {renderMetricCard({
                        label: "Redeem",
                        value: step.redeemSubmittedOrders,
                        kind: getSellInvestMetricDialogKind("redeem"),
                        toneClasses,
                        onOpenInfo: onOpenEventExitInfo,
                      })}
                      {renderMetricCard({
                        label: "Event out of Top 10",
                        value: step.rankingLlmSubmittedOrders,
                        kind: getSellInvestMetricDialogKind("ranking-llm"),
                        toneClasses,
                        onOpenInfo: onOpenEventExitInfo,
                      })}
                      {renderMetricCard({
                        label: "Forced Exit",
                        value: step.forcedExitSubmittedOrders,
                        kind: getSellInvestMetricDialogKind("forced-exit"),
                        toneClasses,
                        onOpenInfo: onOpenEventExitInfo,
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function buildRunDetailScanCandidateDialogState({
  run,
  decisions,
  stage,
  mode,
  activePositionsFallback = [],
}: {
  run: BullpenAutoLiveRun | null;
  decisions: BullpenAutoLiveDecision[];
  stage: WorkflowStageView;
  mode: ScanCandidateDialogMode;
  activePositionsFallback?: WorkflowStageView["activePositionsFound"];
}): ScanCandidateDialogState {
  const activePositionCounts = getStageActivePositionCounts(stage);
  const stageOneStats = getStageOneStats(stage);
  const retainedActivePositionRows =
    stage.activePositionsFound.length > 0
      ? stage.activePositionsFound
      : activePositionCounts.open === activePositionsFallback.length
        ? activePositionsFallback
        : [];
  const rejectedFilterCount =
    readStageOutputNumber(stage.outputs.rejected_candidates_count) ??
    (Array.isArray(stage.outputs.rejected_candidates)
      ? stage.outputs.rejected_candidates.length
      : null);
  const detailedRows =
    mode === "all-scanned" ? stage.scannedCandidates : stage.scanCandidates;
  const emptyRowsReason =
    detailedRows.length > 0
      ? null
      : stage.state === "current"
        ? "Stage 1 has reported its scan total, but the detailed rows have not been published yet. This dialog updates after the run refreshes."
        : stageOneStats.totalScanned > 0
          ? "This saved run retained aggregate scan counts only. Individual event names and per-event filter reasons cannot be reconstructed from those counts."
          : "No events were returned by the Stage 1 scan, so there are no event rows or per-event filter reasons to display.";

  return {
    mode,
    runId: run?.id ?? null,
    isIndependentStageOne: stage.outputs.independent_stage1_scan === true,
    scanExportId: readStageOutputString(stage.outputs.scan_export_id),
    scanCompletedAt: stage.timerCompletedAt,
    totalScanned: stageOneStats.totalScanned,
    passedFilterCount: stageOneStats.passedFilters,
    rejectedFilterCount,
    emptyRowsReason,
    candidates: buildScanCandidateDialogRows({
      candidates: detailedRows,
      run,
      decisions,
    }),
    activePositions: retainedActivePositionRows,
    activePositionCount: activePositionCounts.open,
    claimablePositionCount: activePositionCounts.claimable,
  };
}

export function getDecisionDaysUntilClose(decision: BullpenAutoLiveDecision) {
  if (decision.hours_remaining && decision.hours_remaining > 0) {
    return decision.hours_remaining / 24;
  }
  if (decision.close_time) {
    const closeMs = Date.parse(decision.close_time);
    if (Number.isFinite(closeMs)) {
      const days = (closeMs - Date.now()) / (24 * 60 * 60 * 1000);
      if (days > 0) return days;
    }
  }
  return null;
}

export function getDecisionReturnsPerDay(decision: BullpenAutoLiveDecision) {
  return getBullpenReturnsPerDayBreakdown({
    yesOdds: decision.current_yes_odds ?? null,
    noOdds: decision.current_no_odds ?? null,
    llmYesOdds: decision.fair_yes_probability_pct ?? null,
    llmNoOdds: decision.fair_no_probability_pct ?? null,
    daysUntilClose: getDecisionDaysUntilClose(decision),
  }).result;
}

export function readLlmContextString(
  record: Record<string, unknown> | null,
  key: string,
) {
  if (!record) return null;
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export function readLlmContextNumber(
  record: Record<string, unknown> | null,
  key: string,
) {
  if (!record) return null;
  return readStageOutputNumber(record[key]);
}

export function getStageTwoLlmReviewedRows(
  stage: WorkflowStageView,
  scanCandidates: WorkflowStageView["scanCandidates"] = [],
  decisions: BullpenAutoLiveDecision[] = [],
) {
  const retainedRows = getHistoricalStageTwoLlmReviewedRows(
    stage,
    scanCandidates,
  );
  if (retainedRows.length > 0 || decisions.length === 0) return retainedRows;

  // Terminal compact projections can retain exact aggregate counts while the
  // large Stage 2 row array is omitted. Persisted decisions still carry the
  // market identity, odds, rationale, and any surviving LLM evidence, so use
  // them as the dialog's honest row-level fallback instead of showing an empty
  // table beneath a non-zero "LLM ran on" total.
  return decisions.map((decision) => ({
    market_id: decision.market_id,
    slug: decision.slug ?? undefined,
    market_url: decision.market_url ?? undefined,
    question: decision.market_title,
    market_title: decision.market_title,
    close_time: decision.close_time ?? undefined,
    category: decision.theme,
    theme: decision.theme,
    current_yes_odds: decision.current_yes_odds ?? undefined,
    current_no_odds: decision.current_no_odds ?? undefined,
    fair_yes_probability_pct:
      decision.fair_yes_probability_pct ?? undefined,
    fair_no_probability_pct:
      decision.fair_no_probability_pct ?? undefined,
    llm_outputs: decision.llm_outputs,
  }));
}

export function getRunWorkflowStageResult(
  run: BullpenAutoLiveRun | null | undefined,
  workflowStageKey: "scan" | "llm" | "invest",
  stageNumber: number,
) {
  if (!run) return null;
  return (
    run.stage_results.find(
      (stage) =>
        readLlmContextString(
          (stage.outputs as Record<string, unknown> | null) ?? null,
          "workflow_stage_key",
        ) === workflowStageKey,
    ) ??
    run.stage_results.find((stage) => stage.stage_number === stageNumber) ??
    null
  );
}

export type StageTwoRunSummaryStatus =
  | "completed"
  | "failed"
  | "partial"
  | "pending"
  | "running";

export function normalizeStageTwoRunStatus(
  value: string | null,
): StageTwoRunSummaryStatus {
  if (
    value === "completed" ||
    value === "partial" ||
    value === "failed" ||
    value === "pending" ||
    value === "running"
  )
    return value;
  if (value === "processing") return "running";
  if (value === "queued") return "pending";
  return "failed";
}

export function readStageTwoLlmIdentity(
  value: Record<string, unknown> | null,
) {
  const provider = readLlmContextString(value, "provider")?.trim() ?? "";
  const model = readLlmContextString(value, "model")?.trim() ?? "";
  if (!provider || !model) return null;
  return { provider, model };
}

export function hasStageTwoLlmIdentity(
  value: Record<string, unknown> | null,
) {
  return readStageTwoLlmIdentity(value) !== null;
}

export function isUsableStageTwoTargetRun(run: Record<string, unknown>) {
  const usableEventCount = readLlmContextNumber(run, "usable_event_count");
  if (usableEventCount !== null) return usableEventCount > 0;
  const status = normalizeStageTwoRunStatus(readLlmContextString(run, "status"));
  return status === "completed" || status === "partial";
}

export function isFailedStageTwoTargetRun(run: Record<string, unknown>) {
  if (!hasStageTwoLlmIdentity(run)) return true;
  const usableEventCount = readLlmContextNumber(run, "usable_event_count");
  if (usableEventCount !== null) return usableEventCount <= 0;
  return normalizeStageTwoRunStatus(readLlmContextString(run, "status")) === "failed";
}

export function getStageTwoLlmTargets(stage: WorkflowStageView) {
  const targets = stage.outputs.llm_targets ?? stage.inputs.llm_targets;
  if (!Array.isArray(targets)) return [];
  return targets.filter(
    (target): target is Record<string, unknown> =>
      Boolean(target) && typeof target === "object",
  );
}

export function getStageTwoLlmTargetRuns(stage: WorkflowStageView) {
  const runs = stage.outputs.llm_target_runs;
  if (!Array.isArray(runs)) return [];
  return runs.filter(
    (run): run is Record<string, unknown> =>
      Boolean(run) && typeof run === "object",
  );
}

export function formatStageLastRunLabel(value: string | null) {
  return value ? formatIstDateTime(value) : "Not run yet";
}

export function getWorkflowToneClasses(tone: "yellow" | "green" | "blue" | "red" | "slate") {
  if (tone === "slate") {
    return {
      container:
        "border-slate-200 bg-white/90 dark:border-slate-700/80 dark:bg-slate-950/65",
      badge:
        "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700/80 dark:bg-slate-900 dark:text-slate-200",
      text: "text-slate-950 dark:text-slate-50",
      muted: "text-slate-600 dark:text-slate-300",
      progress: "bg-slate-300",
      progressTrack: "bg-slate-100 dark:bg-slate-800",
    };
  }
  if (tone === "red") {
    return {
      container:
        "border-rose-300 bg-rose-50/90 dark:border-rose-400/35 dark:bg-rose-950/45",
      badge:
        "border-rose-300 bg-rose-100 text-rose-900 dark:border-rose-400/35 dark:bg-rose-500/10 dark:text-rose-100",
      text: "text-rose-950 dark:text-rose-50",
      muted: "text-rose-900/80 dark:text-rose-100/75",
      progress: "bg-rose-500",
      progressTrack: "bg-rose-200/80 dark:bg-rose-500/20",
    };
  }
  if (tone === "yellow") {
    return {
      container:
        "border-amber-300 bg-amber-50/90 dark:border-amber-400/35 dark:bg-amber-950/45",
      badge:
        "border-amber-300 bg-amber-100 text-amber-900 dark:border-amber-400/35 dark:bg-amber-500/10 dark:text-amber-100",
      text: "text-amber-950 dark:text-amber-50",
      muted: "text-amber-900/80 dark:text-amber-100/75",
      progress: "bg-amber-500",
      progressTrack: "bg-amber-200/80 dark:bg-amber-500/20",
    };
  }
  if (tone === "green") {
    return {
      container:
        "border-emerald-300 bg-emerald-50/90 dark:border-emerald-400/35 dark:bg-emerald-950/45",
      badge:
        "border-emerald-300 bg-emerald-100 text-emerald-900 dark:border-emerald-400/35 dark:bg-emerald-500/10 dark:text-emerald-100",
      text: "text-emerald-950 dark:text-emerald-50",
      muted: "text-emerald-900/80 dark:text-emerald-100/75",
      progress: "bg-emerald-500",
      progressTrack: "bg-emerald-200/80 dark:bg-emerald-500/20",
    };
  }
  return {
    container:
      "border-sky-300 bg-sky-50/90 dark:border-sky-400/35 dark:bg-sky-950/45",
    badge:
      "border-sky-300 bg-sky-100 text-sky-900 dark:border-sky-400/35 dark:bg-sky-500/10 dark:text-sky-100",
    text: "text-sky-950 dark:text-sky-50",
    muted: "text-sky-900/80 dark:text-sky-100/75",
    progress: "bg-sky-500",
    progressTrack: "bg-sky-200/80 dark:bg-sky-500/20",
  };
}

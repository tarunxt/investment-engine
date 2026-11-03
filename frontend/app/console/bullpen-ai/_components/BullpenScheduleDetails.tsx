"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { ArrowLeft, CheckCircle2, ChevronDown, ChevronUp, Clock3, FileSpreadsheet, Info, Bot, Loader2, Square, X, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { type BullpenQuestionRow, getBullpenReturnsPerDayBreakdown } from "@/lib/bullpen-ai";
import { BullpenEventIdentityResolver, buildBullpenEventIdentityFromPosition } from "@/lib/bullpenEventIdentityResolver";
import { isActiveBullpenPosition, type BullpenActivePositionView } from "@/lib/bullpenPositions";
import { formatUnknownError } from "@/lib/apiErrors";
import { type BullpenWorkspaceProfile } from "@/lib/bullpenStageOneSettings";
import { bullpenWorkspaceHistoryPath } from "@/lib/bullpenWorkspaceRoutes";
import { mergeBullpenConsoleDecisionProjection, mergeBullpenConsoleRunProjection } from "@/lib/bullpenRunConsoleDetail";
import { apiService } from "@/services/api";
import type { BullpenAutoLiveDecision, BullpenAutoLiveRun } from "@/types/api";
import { buildBullpenAutoRunWorkflowView, isBullpenAutoRunWorkflowSettled } from "./bullpenAutoRunProgress";
import { downloadCompleteStageOneRunExcel, downloadIndependentStageOneExcel, downloadStageOneAllScannedEventsExcel, downloadStageOneFilteredEventsExcel } from "./bullpenStageOneExcel";
import { BullpenReturnsPerDayFormulaDialog, BullpenReturnsPerDayHeader, BullpenReturnsPerDayValueButton } from "./BullpenReturnsPerDayInfo";
import { BullpenEventTrendsTable, type BullpenEventTableSnapshot } from "./BullpenEventTrendsTable";
import { getStage2TransferQueueMetricInfo, getInvestMetricDialogDefinition, getInvestMetricRows, isCompletedWithoutSubmissionInvestDecision, isProcessedInvestOrderPlan, isSubmittedOrExecutedInvestOrderPlan, partitionInvestDecisionsByExecutionEvidence, type InvestMetricDialogKind, type Stage2TransferQueueMetricInfoKind } from "./bullpenAutoRunInvestMetrics";
import { getInvestStageImmediateSuccess } from "./bullpenAutoRunStageStatus";
import { getBullpenStage3SellExecutionTelemetry } from "./bullpenStage3SellExecution";
import { BullpenQuestionsTable, type BullpenQuestionsTableExtraColumn, type BullpenTableSortKey, type BullpenTableSortState } from "./BullpenQuestionsTable";
import { buildStageTwoEventsSummaryRows as buildHistoricalStageTwoEventsSummaryRows, getStageTwoLlmTableRows as getHistoricalStageTwoLlmTableRows, resolveStageTwoEventsSummaryUpdatedAt, resolveStageTwoHistoricalAsOfTimestamp } from "./bullpenAutoRunStageTwoHistory";
import { buildBullpenStage2TopTenHandoffRows, type BullpenStage2TopTenHandoffRow } from "./bullpenStage2TopTenHandoff";
import { formatStageElapsedTime } from "./bullpenAutoRunTimers";
import { type ScanCandidateDialogState, normalizeMatchKey, formatIstDateTime, formatMoney, formatOddsPercent, type ScanCandidateDialogCandidate, type WorkflowStageView, type ScanCandidateDialogMode, type StageTwoInvestEventsDialogState, type StageTwoLlmRunDialogState, getInvestStageCounters, getInvestStageExecutionSteps, getWorkflowToneClasses, formatStageLastRunLabel, StageOneRunStats, StageTwoRunStats, InvestExecutionStepsSummary, type RunDetailDialogState, getRunSummaryDetails, ErrorCodeWithDetails, getDecisionReturnsPerDay, formatReturnsPerDay, getDecisionDaysUntilClose, type RunSummaryWarning, type InvestMetricDialogState, mergeInvestStageDecisionRows, isRequestAbort, buildRunDetailScanCandidateDialogState, getStageTwoSummaryRowMatchKeys, getStageTwoStats, getRunWorkflowStageResult, getStageTwoLlmReviewedRows, readLlmContextString, RUN_TIMER_INTERVAL_MS, type StageTwoRunSummaryStatus, readLlmContextNumber, getStageTwoLlmTargetRuns, readStageTwoLlmIdentity, normalizeStageTwoRunStatus, getStageTwoLlmTargets, isRecord, readStageOutputStringList, getLastInvestExecutionStep, getInvestStageMetric, readStageOutputNumber, readStageOutputString, type InvestExecutionStepView, type StageTwoBypassDialogState, type Stage3PreviewDialogState } from "./bullpenScheduleShared";

export const BullpenInvestmentMathDialog = dynamic(
  () =>
    import("./BullpenInvestmentMathDialog").then(
      (module) => module.BullpenInvestmentMathDialog,
    ),
  { ssr: false },
);

export type BullpenEventSummaryHighlight =
  | "active-retained"
  | "event-exit"
  | "new-opportunity";

export type StageTwoDecisionDialogState = {
  decision: BullpenAutoLiveDecision;
  llmContext: Record<string, unknown> | null;
};

export type StageTwoDecisionDialogMode = "tag" | "llm-inputs";

export type StageTwoLlmEventInputDialogState = {
  title: string;
  llmContext: Record<string, unknown> | null;
};

export type StageTwoLlmRunBreakupKind =
  | "active-positions"
  | "new-opportunities"
  | "overlap"
  | "unique-llm-rows";

export function getLlmOddsHighlightClass(value: number | null) {
  if (value === null) return "font-semibold text-violet-700";
  if (value >= 95)
    return "rounded-md bg-lime-400 px-2 py-1 font-extrabold text-slate-950";
  if (value >= 90)
    return "rounded-md bg-lime-300 px-2 py-1 font-extrabold text-slate-950";
  if (value >= 85)
    return "rounded-md bg-emerald-300 px-2 py-1 font-extrabold text-slate-950";
  if (value >= 80)
    return "rounded-md bg-emerald-200 px-2 py-1 font-extrabold text-slate-950";
  return "font-semibold text-violet-700";
}

export function formatUsdCost(value: number | null) {
  if (value === null) return "—";
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })}`;
}

export function formatPriceCents(value: number | null) {
  if (value === null) return "—";
  return `${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}c`;
}

export function formatShares(value: number | null) {
  if (value === null) return "—";
  return value.toLocaleString("en-IN", { maximumFractionDigits: 6 });
}

export function isWorkflowActivePosition(position: WorkflowStageView["activePositionsFound"][number]) {
  return !position.isClaimable && (position.classification === null || position.classification === "active");
}

export function formatStageTwoInvestExecutionStatus(decision: BullpenAutoLiveDecision) {
  if (decision.order_plan?.action === "buy") {
    if (
      !isSubmittedOrExecutedInvestOrderPlan(decision.order_plan) &&
      [
        "submitted",
        "confirming",
        "partially_filled",
        "settlement_pending",
        "confirmed",
        "filled",
      ].includes(decision.order_plan.status)
    ) {
      return `${decision.order_plan.status.replaceAll("_", " ")} · no submission evidence`;
    }
    return decision.order_plan.status.replaceAll("_", " ");
  }
  if (
    decision.decision === "BUY_NEW" &&
    decision.stage3_result === "SELECTED"
  ) {
    return "queued for Stage 3";
  }
  return decision.decision.replaceAll("_", " ");
}

export function getStageTwoInvestExecutionTone(
  decision: BullpenAutoLiveDecision,
) {
  const status = decision.order_plan?.status ?? null;
  if (isSubmittedOrExecutedInvestOrderPlan(decision.order_plan)) {
    return "success";
  }
  if (
    status === "failed" ||
    status === "failed_permanent" ||
    status === "cancelled" ||
    status === "rejected" ||
    status === "timed_out" ||
    status === "deferred" ||
    status === "rpc_rate_limited" ||
    status === "waiting_for_collateral" ||
    status === "skipped"
  ) {
    return "warning";
  }
  if (decision.decision === "BUY_NEW") {
    return "info";
  }
  return "neutral";
}

export function formatStage2TopTenHandoffOutcome(row: BullpenStage2TopTenHandoffRow) {
  if (row.missingFromStage3) return "Missing from Stage 3";
  return row.displayDecision.stage3_result?.replaceAll("_", " ") ?? "Pending";
}

export function buildStage2TopTenEventsSummaryRows(
  rows: BullpenStage2TopTenHandoffRow[],
) {
  return rows.map((row) => {
    const plannedAmount =
      row.displayDecision.order_plan?.order_size_usd ??
      (row.displayDecision.target_exposure_usd > 0
        ? row.displayDecision.target_exposure_usd
        : row.question.amountToBeInvested);

    return {
      ...row.question,
      amountToBeInvested:
        plannedAmount && plannedAmount > 0
          ? plannedAmount
          : row.question.amountToBeInvested,
    };
  });
}

export function Stage2TopTenEventsSummaryTable({
  rows,
  run,
  displayDensity = "default",
  emptyMessage,
  headerContent,
  testId,
}: {
  rows: BullpenStage2TopTenHandoffRow[];
  run: BullpenAutoLiveRun | null;
  displayDensity?: "default" | "compact";
  emptyMessage: string;
  headerContent?: ReactNode;
  testId?: string;
}) {
  const [sortState, setSortState] = useState<BullpenTableSortState>({
    key: "returnsPerDay",
    direction: "desc",
  });
  const isCompact = displayDensity === "compact";
  const questionRows = buildStage2TopTenEventsSummaryRows(rows);
  const rowByQuestionId = new Map(
    questionRows.map((question, index) => [question.id, rows[index]]),
  );
  const extraColumns: BullpenQuestionsTableExtraColumn[] = [
    {
      id: "stage3-status",
      label: "Stage 3 status",
      width: 190,
      renderCell: (question) => {
        const row = rowByQuestionId.get(question.id);
        if (!row) return "—";
        const executionTone = row.missingFromStage3
          ? "warning"
          : getStageTwoInvestExecutionTone(row.displayDecision);
        const executionStatus = row.missingFromStage3
          ? "Missing from Stage 3"
          : formatStageTwoInvestExecutionStatus(row.displayDecision);
        const badgeClassName =
          executionTone === "success"
            ? "border-emerald-200 bg-emerald-50 text-emerald-800"
            : executionTone === "warning"
              ? "border-amber-200 bg-amber-50 text-amber-800"
              : executionTone === "info"
                ? "border-sky-200 bg-sky-50 text-sky-800"
                : "border-slate-200 bg-white text-slate-700";

        return (
          <div className={isCompact ? "space-y-0.5" : "space-y-1"}>
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Rank #{row.rank}
            </p>
            <span
              className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold capitalize ${badgeClassName}`}
            >
              {executionStatus}
            </span>
            <p
              className={`text-xs text-slate-500${isCompact ? " line-clamp-1" : ""}`}
              title={
                row.missingFromBuyPlan
                  ? "Still waiting for a concrete Step 2 buy plan."
                  : "Concrete Step 2 buy plan was created."
              }
            >
              {row.missingFromBuyPlan ? "Plan pending" : "Plan ready"}
            </p>
          </div>
        );
      },
    },
    {
      id: "stage3-outcome",
      label: "Stage 3 outcome",
      width: 200,
      renderCell: (question) => {
        const row = rowByQuestionId.get(question.id);
        if (!row) return "—";
        const decision = row.displayDecision;

        return (
          <div className={isCompact ? "space-y-0.5" : "space-y-1"}>
            <p
              className={`font-semibold text-slate-950${isCompact ? " line-clamp-1" : ""}`}
              title={formatStage2TopTenHandoffOutcome(row)}
            >
              {formatStage2TopTenHandoffOutcome(row)}
            </p>
            <p
              className={`text-xs text-slate-500${isCompact ? " line-clamp-1" : ""}`}
              title={`${decision.decision.replaceAll("_", " ")} · Side ${decision.side}`}
            >
              {decision.decision.replaceAll("_", " ")} · Side {decision.side}
            </p>
            {isCompact ? null : (
              <p className="text-xs text-slate-500">
                {decision.risk_status.replaceAll("_", " ")}
              </p>
            )}
          </div>
        );
      },
    },
    {
      id: "order-blocker",
      label: "Order / blocker",
      width: 300,
      renderCell: (question) => {
        const row = rowByQuestionId.get(question.id);
        if (!row) return "—";
        const decision = row.displayDecision;

        if (!decision.order_plan) {
          return (
            <div className={isCompact ? "space-y-0.5" : "space-y-1"}>
              <p className="truncate font-semibold text-slate-950">No order planned</p>
              <p
                className={`text-xs leading-5 text-slate-600${isCompact ? " line-clamp-2" : ""}`}
                title={row.reason}
              >
                {row.reason}
              </p>
            </div>
          );
        }

        return (
          <div className={isCompact ? "space-y-0.5" : "space-y-1"}>
            <p className="font-semibold capitalize text-slate-950">
              {decision.order_plan.status.replaceAll("_", " ")}
            </p>
            <p className="text-xs text-slate-500">
              {formatMoney(decision.order_plan.order_size_usd)} at{" "}
              {formatPriceCents(decision.order_plan.limit_price_cents)}
            </p>
            {isCompact ? (
              <p
                className="line-clamp-2 text-xs leading-5 text-slate-600"
                title={getPlannedOrderBrief(decision)}
              >
                {getPlannedOrderBrief(decision)}
              </p>
            ) : (
              <div className="text-xs leading-5 text-slate-600">
                <ErrorCodeWithDetails
                  detail={decision.order_plan.detail}
                  detailClassName="text-slate-600"
                />
              </div>
            )}
          </div>
        );
      },
    },
    {
      id: "details",
      label: "Details",
      width: 340,
      renderCell: (question) => {
        const row = rowByQuestionId.get(question.id);
        if (!row) return "—";
        const decision = row.displayDecision;
        const rationale =
          decision.rationale || decision.reason || row.question.llmNotes;
        const executionReason = row.reason;

        return (
          <div className={isCompact ? "space-y-0.5" : "space-y-1"}>
            <p
              className={
                isCompact
                  ? "line-clamp-2 text-xs leading-5 text-slate-700"
                  : "text-sm leading-6 text-slate-700"
              }
              title={rationale || "No in-depth details were captured for this row."}
            >
              {rationale || "No in-depth details were captured for this row."}
            </p>
            {executionReason !== rationale && !isCompact ? (
              <p className="text-xs leading-5 text-slate-500">
                <span className="font-semibold text-slate-700">
                  Execution blocker / detail:
                </span>{" "}
                {executionReason}
              </p>
            ) : null}
          </div>
        );
      },
    },
  ];

  return (
    <div data-testid={testId}>
      <BullpenQuestionsTable
        snapshot={null}
        rowsOverride={questionRows}
        emptyMessage={emptyMessage}
        headerContent={headerContent}
        updatedAt={run?.completed_at ?? run?.started_at ?? null}
        updateUnavailableReason="Timestamp unavailable because this view is reconstructed from the saved Stage 2 Top 10 handoff."
        scrollResetKey={`${run?.id ?? "stage2-top10"}-${rows.length}`}
        isLoading={false}
        historicalRuns={run ? [run] : undefined}
        historicalDecisions={rows.map((row) => row.decision ?? row.displayDecision)}
        visibleColumnIds={[
          "serialNumber",
          "question",
          "closeTime",
          "category",
          "yesOdds",
          "llmYesOdds",
          "returnsPerDay",
          "amountToBeInvested",
        ]}
        persistColumnPreferences={false}
        showPresetFilters={false}
        displayDensity={displayDensity}
        rowHighlightById={Object.fromEntries(
          rows.map((row) => [
            row.question.id,
            row.displayDecision.decision === "HOLD"
              ? "active-retained"
              : row.displayDecision.decision === "EXIT"
                ? "event-exit"
                : "new-opportunity",
          ] as const),
        )}
        extraColumns={extraColumns}
        onSortChange={(key) =>
          setSortState((current) => ({
            key,
            direction:
              current.key === key && current.direction === "desc"
                ? "asc"
                : "desc",
          }))
        }
        selectedQuestionIds={new Set<string>()}
        selectionEnabled={false}
        sortState={sortState}
        onToggleQuestion={() => undefined}
        onToggleSelectAll={() => undefined}
      />
    </div>
  );
}

export function getStageTwoActivePositionMatchKeys(
  position: WorkflowStageView["activePositionsFound"][number],
) {
  return [position.marketId, position.slug, position.marketUrl, position.marketTitle]
    .map((key) => normalizeMatchKey(key))
    .filter((key): key is string => Boolean(key));
}

export function buildStageTwoActivePositionKeySet(stage: WorkflowStageView) {
  return new Set(
    stage.activePositionsFound.flatMap((position) =>
      getStageTwoActivePositionMatchKeys(position),
    ),
  );
}

export function getStageTwoDecisionForSummaryRow(
  row: BullpenQuestionRow,
  decisions: BullpenAutoLiveDecision[],
) {
  const rowKeys = new Set(getStageTwoSummaryRowMatchKeys(row));
  return (
    decisions.find((decision) =>
      [decision.market_id, decision.slug ?? null]
        .map((key) => normalizeMatchKey(key))
        .some((key) => Boolean(key && rowKeys.has(key))),
    ) ?? null
  );
}

export function buildStageTwoEventsSummaryHighlightById({
  rows,
  stage,
  decisions,
  includeEventExits,
}: {
  rows: BullpenQuestionRow[];
  stage: WorkflowStageView | null;
  decisions: BullpenAutoLiveDecision[];
  includeEventExits: boolean;
}) {
  const activePositionKeys = stage
    ? buildStageTwoActivePositionKeySet(stage)
    : new Set<string>();

  return Object.fromEntries(
    rows.map((row) => {
      const rowKeys = getStageTwoSummaryRowMatchKeys(row);
      const isActivePosition = rowKeys.some((key) => activePositionKeys.has(key));
      const decision = isActivePosition
        ? getStageTwoDecisionForSummaryRow(row, decisions)
        : null;
      let highlight: BullpenEventSummaryHighlight = "new-opportunity";

      if (isActivePosition) {
        highlight =
          includeEventExits && decision?.decision === "EXIT"
            ? "event-exit"
            : "active-retained";
      }

      return [row.id, highlight] as const;
    }),
  );
}

export type PlannedOrderDetailState = {
  title: string;
  summary: string;
  detail: string;
};

export type DecisionLlmOddsState = { decision: BullpenAutoLiveDecision };

export function SimpleInfoDialog({
  eyebrow,
  title,
  sections,
  onClose,
}: {
  eyebrow: string;
  title: string;
  sections: Array<{ title: string; body: string }>;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[190] flex items-center justify-center bg-slate-950/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bullpen-simple-info-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white text-left shadow-[0_30px_90px_-28px_rgba(15,23,42,0.6)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
              {eyebrow}
            </p>
            <h2 id="bullpen-simple-info-title" className="mt-2 text-xl font-semibold text-slate-950">
              {title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close details"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto px-6 py-5">
          {sections.map((section) => (
            <section key={section.title} className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <h3 className="text-sm font-bold text-slate-950">{section.title}</h3>
              <p className="mt-1 text-sm leading-6 text-slate-700">{section.body}</p>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

export type InvestProgressLogEntry = {
  tone: "info" | "warning" | "error" | "success";
  label: string;
  detail: string;
};

export function getInvestProgressLogEntries({
  stage,
  run,
  decisions,
  steps,
}: {
  stage:
    | ReturnType<typeof buildBullpenAutoRunWorkflowView>["stages"][number]
    | null;
  run: BullpenAutoLiveRun;
  decisions: BullpenAutoLiveDecision[];
  steps: InvestExecutionStepView[];
}): InvestProgressLogEntry[] {
  const entries: InvestProgressLogEntry[] = [];
  if (!stage) return entries;

  const stageError = readStageOutputString(stage.outputs.error_message);
  const runError = readStageOutputString(run.error_message);
  const executionGateReason = readStageOutputString(
    stage.outputs.execution_gate_reason,
  );
  const executionModeReason = readStageOutputString(
    stage.outputs.execution_mode_reason,
  );
  const executionStepLabel = readStageOutputString(
    stage.outputs.execution_step_label,
  );
  const executionStepDetail = readStageOutputString(
    stage.outputs.execution_step_detail,
  );

  if (stageError || runError) {
    entries.push({
      tone: "error",
      label: "Worker error",
      detail: stageError ?? runError ?? "The worker reported an error.",
    });
  }
  if (executionGateReason) {
    entries.push({
      tone: "error",
      label: "Execution gate",
      detail: executionGateReason,
    });
  }
  if (executionModeReason) {
    entries.push({
      tone: "info",
      label: "Execution mode",
      detail: executionModeReason,
    });
  }
  if (executionStepDetail) {
    entries.push({
      tone: "warning",
      label: executionStepLabel ?? "Current worker step",
      detail: executionStepDetail,
    });
  }

  for (const step of steps) {
    if (step.status === "running" || step.status === "blocked") {
      entries.push({
        tone: step.status === "blocked" ? "error" : "warning",
        label: `Step ${step.stepNumber} of ${step.stepTotal} · ${step.label}`,
        detail: `${step.processedOrders} processed / ${step.plannedOrders} planned / ${step.submittedOrders} submitted. ${step.detail ?? "Waiting for the next worker update."}`,
      });
    }
  }

  for (const decision of [...decisions].reverse()) {
    const orderPlan = decision.order_plan;
    if (!orderPlan) continue;
    const status = orderPlan.status?.trim().toLowerCase();
    const detail = orderPlan.detail?.trim();
    if (!status || !detail) continue;
    if (
      status === "planned" ||
      status === "failed" ||
      status === "skipped" ||
      status === "cancelled"
    ) {
      entries.push({
        tone:
          status === "failed" || status === "cancelled"
            ? "error"
            : status === "skipped"
              ? "warning"
              : "info",
        label: `${status.replaceAll("_", " ")} · ${decision.market_title}`,
        detail,
      });
    }
    if (entries.length >= 8) break;
  }

  const completedItems = readStageOutputNumber(stage.outputs.completed_items);
  const totalItems = readStageOutputNumber(stage.outputs.total_items);
  if (stage.state === "current" && entries.length === 0) {
    entries.push({
      tone: "info",
      label: "Waiting for worker update",
      detail: totalItems
        ? `Stage 3 has reviewed ${completedItems ?? 0} of ${totalItems} rows. This panel refreshes as the worker saves each step.`
        : "This panel refreshes as the worker saves progress, errors, and order results.",
    });
  }

  return entries.slice(0, 8);
}

export function buildStageOnePositionTableEvent(
  position: ScanCandidateDialogState["activePositions"][number],
  index: number,
  asOf: number,
): BullpenEventTableSnapshot {
  const marketId = position.marketId || position.conditionId || position.slug || `active-position-${index + 1}`;
  const side = position.side?.trim().toUpperCase();
  return {
    market_id: marketId,
    market_title: position.marketTitle,
    market_url: position.marketUrl,
    close_time: position.closeTime,
    score: 0,
    scan_scores: [],
    scan_sides: [],
    scan_timestamps: [],
    current_yes_odds: position.currentYesOdds,
    current_no_odds: position.currentNoOdds,
    llm_yes_odds: null,
    llm_no_odds: null,
    returns_per_day:
      position.returnsPerDay ??
      calculateStageOneReturnsPerDay({
        currentYesOdds: position.currentYesOdds,
        currentNoOdds: position.currentNoOdds,
        llmYesOdds: side === "YES" ? 100 : side === "NO" ? 0 : null,
        llmNoOdds: side === "NO" ? 100 : side === "YES" ? 0 : null,
        closeTime: position.closeTime,
        asOf,
      }),
    is_active_position: true,
    active_position_side: side === "YES" || side === "NO" ? side : null,
    position_side: position.side,
    position_shares: position.shares,
    position_exposure_usd: position.exposureUsd,
    position_average_price_cents: position.averagePriceCents,
  };
}

export function calculateStageOneReturnsPerDay({
  currentYesOdds,
  currentNoOdds,
  llmYesOdds,
  llmNoOdds,
  closeTime,
  asOf,
}: {
  currentYesOdds: number | null;
  currentNoOdds: number | null;
  llmYesOdds: number | null;
  llmNoOdds: number | null;
  closeTime: string | null;
  asOf: number;
}) {
  const closeTimeMs = closeTime ? Date.parse(closeTime) : Number.NaN;
  const daysUntilClose = Number.isFinite(closeTimeMs)
    ? Number(((closeTimeMs - asOf) / 86_400_000).toFixed(1))
    : null;
  return getBullpenReturnsPerDayBreakdown({
    yesOdds: currentYesOdds,
    noOdds: currentNoOdds,
    llmYesOdds,
    llmNoOdds,
    daysUntilClose,
  }).result;
}

export function buildStageOneOpportunityTableEvent(
  candidate: ScanCandidateDialogCandidate,
  index: number,
): BullpenEventTableSnapshot {
  return {
    market_id: candidate.marketId || candidate.questionId || candidate.slug || `fresh-opportunity-${index + 1}`,
    market_title: candidate.question,
    market_url: candidate.marketUrl,
    close_time: candidate.closeTime,
    score: Math.max(candidate.llmYesOdds ?? 0, candidate.llmNoOdds ?? 0),
    scan_scores: [],
    scan_sides: [],
    scan_timestamps: [],
    current_yes_odds: candidate.currentYesOdds,
    current_no_odds: candidate.currentNoOdds,
    llm_yes_odds: candidate.llmYesOdds,
    llm_no_odds: candidate.llmNoOdds,
    returns_per_day: candidate.returnsPerDay,
    amount_to_be_invested: candidate.amountToBeInvested,
    volume_usd: candidate.volumeUsd,
    liquidity_usd: candidate.liquidityUsd,
  };
}

export function stageOneActiveOddsLookupId(
  position: ScanCandidateDialogState["activePositions"][number],
  index: number,
) {
  const exactIdentity =
    position.conditionId ??
    position.slug ??
    position.marketUrl ??
    position.marketId ??
    position.marketTitle;
  return `stage-one-active-odds-${index}-${exactIdentity}`;
}

export function stageOneCandidateOddsLookupId(
  candidate: ScanCandidateDialogCandidate,
  index: number,
) {
  const exactIdentity =
    candidate.conditionId ??
    candidate.slug ??
    candidate.marketUrl ??
    candidate.marketId ??
    candidate.questionId ??
    candidate.question;
  return `stage-one-candidate-odds-${index}-${exactIdentity}`;
}

export function StageOneOutputDialog({
  state,
  onClose,
  onRecoverLegacyExport,
  workspaceProfile = "bullpen007",
}: {
  state: ScanCandidateDialogState;
  onClose: () => void;
  onRecoverLegacyExport?: (
    exportScope: "filtered" | "all-scanned",
  ) => void;
  workspaceProfile?: BullpenWorkspaceProfile;
}) {
  const [isReturnsPerDayFormulaDialogOpen, setIsReturnsPerDayFormulaDialogOpen] =
    useState(false);
  const [returnsPerDayQuestion, setReturnsPerDayQuestion] =
    useState<BullpenQuestionRow | null>(null);
  const [latestOdds, setLatestOdds] = useState<
    Record<string, { yesOdds?: number | null; noOdds?: number | null }>
  >({});
  const [latestOddsFetchedAt, setLatestOddsFetchedAt] = useState<string | null>(
    null,
  );
  const [dialogOpenedAt] = useState(() => Date.now());
  useEffect(() => {
    if (state.mode === "all-scanned") return;
    const lookupRows = [
      ...state.activePositions.map((position, index) => ({
        id: stageOneActiveOddsLookupId(position, index),
        conditionId: position.conditionId,
        slug: position.slug,
        marketUrl: position.marketUrl,
        question: position.marketTitle,
        category: position.theme,
      })),
      ...state.candidates.map((candidate, index) => ({
        id: stageOneCandidateOddsLookupId(candidate, index),
        conditionId: candidate.conditionId,
        slug: candidate.slug,
        marketUrl: candidate.marketUrl,
        question: candidate.question,
        category: candidate.theme,
      })),
    ];
    if (lookupRows.length === 0) return;

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 20_000);
    void fetch("/api/bullpen-ai/current-odds", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        "Cache-Control": "no-cache",
        "content-type": "application/json",
      },
      body: JSON.stringify({ questions: lookupRows }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response.json()) as {
          markets?: Record<
            string,
            { yesOdds?: number | null; noOdds?: number | null }
          >;
          fetchedAt?: string | null;
        };
        if (!response.ok) return;
        setLatestOdds(payload.markets ?? {});
        setLatestOddsFetchedAt(payload.fetchedAt ?? new Date().toISOString());
      })
      .catch(() => undefined)
      .finally(() => window.clearTimeout(timeoutId));
    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [state]);
  if (state.mode === "all-scanned") {
    return <AllScannedEventsDialog state={state} onClose={onClose} />;
  }
  const showActivePositionsFirst = state.mode === "active-positions";
  const retainedCandidateCount = Math.max(
    state.passedFilterCount,
    state.candidates.length,
  );
  const claimablePositions = state.activePositions.filter(
    (position) => position.isClaimable,
  );
  const activePositions = state.activePositions.filter(isWorkflowActivePosition);
  const latestAsOf = latestOddsFetchedAt
    ? Date.parse(latestOddsFetchedAt)
    : dialogOpenedAt;
  const enrichLatestOdds = (
    event: BullpenEventTableSnapshot,
    chosenSide?: string | null,
    lookupId: string = event.market_id,
  ): BullpenEventTableSnapshot => {
    const market = latestOdds[lookupId];
    const currentYesOdds =
      typeof market?.yesOdds === "number"
        ? market.yesOdds
        : event.current_yes_odds ?? null;
    const currentNoOdds =
      typeof market?.noOdds === "number"
        ? market.noOdds
        : event.current_no_odds ?? null;
    const normalizedSide = chosenSide?.trim().toUpperCase();
    return {
      ...event,
      current_yes_odds: currentYesOdds,
      current_no_odds: currentNoOdds,
      returns_per_day: event.is_claimable_position
        ? null
        : calculateStageOneReturnsPerDay({
            currentYesOdds,
            currentNoOdds,
            llmYesOdds:
              normalizedSide === "YES"
                ? 100
                : normalizedSide === "NO"
                  ? 0
                  : event.llm_yes_odds ?? null,
            llmNoOdds:
              normalizedSide === "NO"
                ? 100
                : normalizedSide === "YES"
                  ? 0
                  : event.llm_no_odds ?? null,
            closeTime: event.close_time ?? null,
            asOf: latestAsOf,
          }) ?? event.returns_per_day ?? null,
    };
  };
  const activeSideByKey = new Map<string, string>();
  const candidateCloseTimeByKey = new Map<string, string>();
  for (const candidate of state.candidates) {
    if (!candidate.closeTime) continue;
    [
      candidate.conditionId,
      candidate.slug,
      candidate.marketUrl,
      candidate.question,
    ]
      .map(normalizeMatchKey)
      .filter((key): key is string => Boolean(key))
      .forEach((key) => candidateCloseTimeByKey.set(key, candidate.closeTime as string));
  }
  for (const position of activePositions) {
    if (!position.side) continue;
    [
      position.conditionId,
      position.slug,
      position.marketUrl,
      position.marketTitle,
    ]
      .map(normalizeMatchKey)
      .filter((key): key is string => Boolean(key))
      .forEach((key) => activeSideByKey.set(key, position.side as string));
  }
  const activePositionEvents = activePositions.map((position, index) => {
    const matchingCandidateCloseTime = [
      position.conditionId,
      position.slug,
      position.marketUrl,
      position.marketTitle,
    ]
      .map(normalizeMatchKey)
      .filter((key): key is string => Boolean(key))
      .map((key) => candidateCloseTimeByKey.get(key) ?? null)
      .find((closeTime) => closeTime !== null);
    const event = buildStageOnePositionTableEvent(position, index, dialogOpenedAt);
    return enrichLatestOdds(
      matchingCandidateCloseTime
        ? { ...event, close_time: matchingCandidateCloseTime }
        : event,
      position.side,
      stageOneActiveOddsLookupId(position, index),
    );
  });
  const freshOpportunityEvents = state.candidates.map((candidate, index) => {
    const activeSide = [
      candidate.conditionId,
      candidate.slug,
      candidate.marketUrl,
      candidate.question,
    ]
      .map(normalizeMatchKey)
      .filter((key): key is string => Boolean(key))
      .map((key) => activeSideByKey.get(key) ?? null)
      .find((side) => side !== null);
    return enrichLatestOdds(
      buildStageOneOpportunityTableEvent(candidate, index),
      activeSide,
      stageOneCandidateOddsLookupId(candidate, index),
    );
  });
  const filteredEventExportRows = state.candidates.map((candidate, index) => {
    const event = freshOpportunityEvents[index];
    return {
      ...candidate,
      currentYesOdds: event.current_yes_odds ?? candidate.currentYesOdds,
      currentNoOdds: event.current_no_odds ?? candidate.currentNoOdds,
      llmYesOdds: event.llm_yes_odds ?? candidate.llmYesOdds,
      llmNoOdds: event.llm_no_odds ?? candidate.llmNoOdds,
      returnsPerDay: event.returns_per_day ?? candidate.returnsPerDay,
      amountToBeInvested:
        event.amount_to_be_invested ?? candidate.amountToBeInvested,
      volumeUsd: event.volume_usd ?? candidate.volumeUsd,
      liquidityUsd: event.liquidity_usd ?? candidate.liquidityUsd,
    };
  });
  const downloadFilteredEvents = () => {
    if (state.scanExportId) {
      downloadIndependentStageOneExcel(
        state.scanExportId,
        state.mode === "all-scanned" ? "all-scanned" : "filtered",
        workspaceProfile,
      );
      return;
    }
    if (state.isIndependentStageOne && onRecoverLegacyExport) {
      onClose();
      onRecoverLegacyExport(state.mode === "all-scanned" ? "all-scanned" : "filtered");
      return;
    }
    if (state.runId && !state.isIndependentStageOne) {
      downloadCompleteStageOneRunExcel(state.runId, state.mode === "all-scanned" ? "all-scanned" : "filtered");
      return;
    }
    const download = state.mode === "all-scanned" ? downloadStageOneAllScannedEventsExcel : downloadStageOneFilteredEventsExcel;
    void download({
      candidates: filteredEventExportRows,
      scanCompletedAt: state.scanCompletedAt,
    });
  };
  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/55 p-4">
      <div className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.45)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
              {showActivePositionsFirst
                ? "Active Bullpen Positions"
                : "Fresh Bullpen Opportunities"}
            </p>
            <h2 className="text-xl font-semibold text-slate-950">
              {showActivePositionsFirst
                ? `Positions (${state.activePositionCount})`
                : `Fresh Bullpen Opportunities (${retainedCandidateCount})`}
            </h2>
            <p className="text-sm text-slate-600">
              Latest Bullpen Scan Stage 1 completed at{" "}
              {formatIstDateTime(state.scanCompletedAt)}.
            </p>
            {latestOddsFetchedAt ? (
              <p className="text-xs font-semibold text-slate-500">
                Current Bullpen odds fetched/updated at{" "}
                {formatIstDateTime(latestOddsFetchedAt)}.
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={downloadFilteredEvents}
              disabled={
                !state.scanExportId &&
                !(state.isIndependentStageOne && onRecoverLegacyExport) &&
                !(!state.isIndependentStageOne && state.runId) &&
                filteredEventExportRows.length === 0
              }
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 text-sm font-semibold text-emerald-700 transition hover:border-emerald-300 hover:bg-emerald-100 focus:outline-none focus:ring-2 focus:ring-emerald-300 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <FileSpreadsheet className="h-4 w-4" />
              Download Excel
            </button>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
              aria-label="Close Stage 1 output"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto px-6 py-5">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">
                Available for claim
              </p>
              <p className="mt-2 text-2xl font-semibold text-emerald-950">
                {state.claimablePositionCount}
              </p>
            </div>
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-700">
                Active Bullpen positions found
              </p>
              <p className="mt-2 text-2xl font-semibold text-amber-950">
                {state.activePositionCount}
              </p>
            </div>
            <div className="rounded-2xl border border-pink-200 bg-pink-50 px-4 py-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-pink-700">
                Fresh Bullpen Opportunities
              </p>
              <p className="mt-2 text-2xl font-semibold text-pink-950">
                {retainedCandidateCount}
              </p>
            </div>
          </div>

          <div className="mt-5 space-y-5">
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">
                    Available for Claim
                  </p>
                  <p className="mt-1 text-sm text-slate-600">
                    Claimable Bullpen wallet positions separated from active
                    positions.
                  </p>
                </div>
                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
                  {state.claimablePositionCount}{" "}
                  {state.claimablePositionCount === 1
                    ? "position"
                    : "positions"}
                </span>
              </div>

              {claimablePositions.length > 0 ? (
                <div className="overflow-hidden rounded-2xl border border-emerald-200">
                  <table className="min-w-full divide-y divide-slate-200 text-sm">
                    <thead className="bg-emerald-50 text-left text-xs font-semibold uppercase tracking-[0.14em] text-emerald-700">
                      <tr>
                        <th className="px-4 py-3">Position</th>
                        <th className="px-4 py-3">Side & size</th>
                        <th className="px-4 py-3">Odds</th>
                        <th className="px-4 py-3">Close time</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 bg-white">
                      {claimablePositions.map((position) => (
                        <tr key={position.positionKey}>
                          <td className="w-[24rem] max-w-[24rem] px-3 py-2 align-middle">
                            <div className="font-semibold text-slate-950">
                              {position.marketUrl ? (
                                <a
                                  className="hover:text-sky-700 hover:underline"
                                  href={position.marketUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {position.marketTitle}
                                </a>
                              ) : (
                                position.marketTitle
                              )}
                            </div>
                            <div className="mt-1 flex gap-2 overflow-hidden whitespace-nowrap text-[11px] text-slate-500">
                              {position.theme ? (
                                <span>{position.theme}</span>
                              ) : null}
                              {position.conditionId ? (
                                <span>{position.conditionId}</span>
                              ) : null}
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 align-middle text-slate-700">
                            {position.side ?? "—"}
                            <br />
                            Shares {formatShares(position.shares)}
                            <br />
                            Exposure {formatMoney(position.exposureUsd)}
                            <br />
                            Avg {formatPriceCents(position.averagePriceCents)}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 align-middle text-slate-700">
                            Yes {formatOddsPercent(position.currentYesOdds)}
                            <br />
                            No {formatOddsPercent(position.currentNoOdds)}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 align-middle text-slate-700">
                            {formatIstDateTime(position.closeTime)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-6 text-sm text-emerald-700">
                  No claimable Bullpen positions were recorded for this Stage 1
                  scan.
                </div>
              )}
            </section>

            <section className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Active Bullpen positions found
                  </p>
                  <p className="mt-1 text-sm text-slate-600">
                    These live wallet positions were synced into the run before
                    Stage 2 review.
                  </p>
                </div>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700">
                  {state.activePositionCount}{" "}
                  {state.activePositionCount === 1 ? "position" : "positions"}
                </span>
              </div>

              {activePositions.length > 0 ? (
                <div className="overflow-x-auto rounded-2xl border border-slate-200">
                  <BullpenEventTrendsTable
                    events={activePositionEvents}
                    variant="active-positions"
                    onReturnsFormula={() =>
                      setIsReturnsPerDayFormulaDialogOpen(true)
                    }
                  />
                </div>
              ) : state.activePositionCount > 0 ? (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-600">
                  {state.activePositionCount} active Bullpen{" "}
                  {state.activePositionCount === 1
                    ? "position was"
                    : "positions were"}{" "}
                  synced for this run, but the detailed rows were not stored in
                  this run record.
                </div>
              ) : (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-600">
                  No active Bullpen positions were recorded for this Stage 1
                  scan.
                </div>
              )}
            </section>

            <section className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Fresh Bullpen Opportunities
                  </p>
                  <p className="mt-1 text-sm text-slate-600">
                    Fresh Bullpen events that passed the Stage 1 scan filters.
                  </p>
                </div>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700">
                  {retainedCandidateCount}{" "}
                  {retainedCandidateCount === 1 ? "candidate" : "candidates"}
                </span>
              </div>

              {state.candidates.length > 0 ? (
                <div className="overflow-x-auto rounded-2xl border border-slate-200">
                  <BullpenEventTrendsTable
                    events={freshOpportunityEvents}
                    variant="fresh-opportunities"
                    onReturns={(question) => setReturnsPerDayQuestion(question)}
                    onReturnsFormula={() =>
                      setIsReturnsPerDayFormulaDialogOpen(true)
                    }
                  />
                </div>
              ) : (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-600">
                  No new event opportunity candidates were recorded for this
                  Stage 1 scan.
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
      {returnsPerDayQuestion ? (
        <BullpenInvestmentMathDialog
          focus="returnsPerDay"
          question={returnsPerDayQuestion}
          onClose={() => setReturnsPerDayQuestion(null)}
        />
      ) : null}
      {isReturnsPerDayFormulaDialogOpen ? (
        <BullpenReturnsPerDayFormulaDialog
          onClose={() => setIsReturnsPerDayFormulaDialogOpen(false)}
        />
      ) : null}
      {returnsPerDayQuestion ? (
        <BullpenInvestmentMathDialog
          focus="returnsPerDay"
          question={returnsPerDayQuestion}
          onClose={() => setReturnsPerDayQuestion(null)}
        />
      ) : null}
      {isReturnsPerDayFormulaDialogOpen ? (
        <BullpenReturnsPerDayFormulaDialog
          onClose={() => setIsReturnsPerDayFormulaDialogOpen(false)}
        />
      ) : null}
    </div>
  );
}

export function AllScannedEventsDialog({
  state,
  onClose,
}: {
  state: ScanCandidateDialogState;
  onClose: () => void;
}) {
  const retainedRowCount = state.candidates.length;
  const eventRowsPerPage = 100;
  const [eventQuery, setEventQuery] = useState("");
  const [eventPage, setEventPage] = useState(1);
  const omittedRowCount = Math.max(0, state.totalScanned - retainedRowCount);
  const [activeTab, setActiveTab] = useState<"events" | "analysis">("events");
  const [selectedFilterReason, setSelectedFilterReason] = useState<string | null>(null);
  const normalizedEventQuery = eventQuery.trim().toLowerCase();
  const matchingCandidates = normalizedEventQuery
    ? state.candidates.filter((candidate) =>
        [
          candidate.question,
          candidate.slug ?? "",
          candidate.filterReasons.join(" "),
        ]
          .join(" ")
          .toLowerCase()
          .includes(normalizedEventQuery),
      )
    : state.candidates;
  const eventPageCount = Math.max(
    1,
    Math.ceil(matchingCandidates.length / eventRowsPerPage),
  );
  const boundedEventPage = Math.min(eventPage, eventPageCount);
  const eventPageStart = (boundedEventPage - 1) * eventRowsPerPage;
  const visibleCandidates = matchingCandidates.slice(
    eventPageStart,
    eventPageStart + eventRowsPerPage,
  );
  const filteredCandidates = state.candidates.filter(
    (candidate) => candidate.filterReasons.length > 0,
  );
  const filterReasonGroups = Array.from(
    state.candidates.reduce((groups, candidate) => {
      candidate.filterReasons.forEach((reason) => {
        const matching = groups.get(reason) ?? [];
        matching.push(candidate);
        groups.set(reason, matching);
      });
      return groups;
    }, new Map<string, typeof state.candidates>()),
  )
    .map(([reason, candidates]) => ({ reason, candidates }))
    .sort(
      (left, right) =>
        right.candidates.length - left.candidates.length ||
        left.reason.localeCompare(right.reason),
    );
  const selectedFilterCandidates = selectedFilterReason
    ? filterReasonGroups.find((group) => group.reason === selectedFilterReason)
        ?.candidates ?? []
    : [];

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/55 p-4">
      <div className="flex max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.45)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700">Stage 1 scan</p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              {activeTab === "analysis" ? (
                <button
                  type="button"
                  onClick={() => setActiveTab("events")}
                  className="inline-flex h-9 items-center gap-2 rounded-xl border border-slate-200 px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                  aria-label="Back to all scanned events"
                >
                  <ArrowLeft className="h-4 w-4" />
                  Back
                </button>
              ) : null}
              <h2 className="text-xl font-semibold text-slate-950">
                {activeTab === "analysis" ? (
                  "Filtered Events Analysis"
                ) : (
                  <>All Events Scanned ({state.totalScanned})</>
                )}
              </h2>
            </div>
            <p className="mt-2 text-sm text-slate-600">
              {activeTab === "analysis"
                ? "Every assigned filter reason is counted. An event can appear under more than one reason."
                : `Scanned at ${formatIstDateTime(state.scanCompletedAt)}. Filtered rows are included.`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {activeTab === "events" ? (
              <button
                type="button"
                onClick={() => setActiveTab("analysis")}
                className="inline-flex h-10 items-center rounded-xl bg-emerald-700 px-4 text-sm font-semibold text-white transition hover:bg-emerald-800"
              >
                Analyse Filtered Events
              </button>
            ) : null}
            <button type="button" onClick={onClose} className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900" aria-label="Close all scanned events">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-6">
          {activeTab === "analysis" ? (
            <>
              <div className="mb-4 grid gap-3 sm:grid-cols-3">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Filtered events</p>
                  <p className="mt-1 text-2xl font-semibold text-slate-950">{filteredCandidates.length.toLocaleString("en-IN")}</p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Distinct reasons</p>
                  <p className="mt-1 text-2xl font-semibold text-slate-950">{filterReasonGroups.length.toLocaleString("en-IN")}</p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Total reason hits</p>
                  <p className="mt-1 text-2xl font-semibold text-slate-950">{filterReasonGroups.reduce((total, group) => total + group.candidates.length, 0).toLocaleString("en-IN")}</p>
                </div>
              </div>
              <div className="overflow-hidden rounded-2xl border border-slate-200">
                <table className="min-w-full divide-y divide-slate-200 text-sm">
                  <thead className="sticky top-0 bg-slate-50 text-left text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                    <tr>
                      <th className="px-4 py-3">#</th>
                      <th className="px-4 py-3">Filter reason</th>
                      <th className="px-4 py-3 text-right">Events caught</th>
                      <th className="px-4 py-3 text-right">% of scanned</th>
                      <th className="px-4 py-3 text-right">% of filtered</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {filterReasonGroups.map((group, index) => (
                      <tr key={group.reason}>
                        <td className="px-4 py-3 text-slate-500">{index + 1}</td>
                        <td className="px-4 py-3 font-medium text-slate-800">{group.reason}</td>
                        <td className="px-4 py-3 text-right">
                          <button
                            type="button"
                            onClick={() => setSelectedFilterReason(group.reason)}
                            className="inline-flex min-w-12 justify-center rounded-full bg-sky-50 px-3 py-1 font-semibold text-sky-700 transition hover:bg-sky-100 hover:underline"
                            aria-label={`Show ${group.candidates.length} events caught by ${group.reason}`}
                          >
                            {group.candidates.length.toLocaleString("en-IN")}
                          </button>
                        </td>
                        <td className="px-4 py-3 text-right text-slate-600">{state.totalScanned > 0 ? `${((group.candidates.length / state.totalScanned) * 100).toFixed(1)}%` : "—"}</td>
                        <td className="px-4 py-3 text-right text-slate-600">{filteredCandidates.length > 0 ? `${((group.candidates.length / filteredCandidates.length) * 100).toFixed(1)}%` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {filterReasonGroups.length === 0 ? (
                <div className="py-10 text-center text-sm text-slate-600">No per-event filter reasons are available for this run.</div>
              ) : null}
              {omittedRowCount > 0 ? (
                <p className="py-4 text-center text-sm text-amber-700">Analysis covers the {retainedRowCount.toLocaleString("en-IN")} retained event rows. {omittedRowCount.toLocaleString("en-IN")} additional rows were not retained in the saved run.</p>
              ) : null}
            </>
          ) : <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <label className="min-w-64 flex-1">
              <span className="sr-only">Search scanned events</span>
              <input
                type="search"
                aria-label="Search scanned events"
                value={eventQuery}
                onChange={(event) => {
                  setEventQuery(event.target.value);
                  setEventPage(1);
                }}
                placeholder="Search question, slug, or filter reason"
                className="h-10 w-full rounded-xl border border-slate-300 px-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
              />
            </label>
            <p className="text-sm text-slate-600">
              {matchingCandidates.length === 0
                ? "No matching rows."
                : `Showing ${eventPageStart + 1}–${Math.min(
                    eventPageStart + visibleCandidates.length,
                    matchingCandidates.length,
                  )} of ${matchingCandidates.length.toLocaleString("en-IN")} matching rows.`}
            </p>
          </div>
          <div className="overflow-hidden rounded-2xl border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="sticky top-0 bg-slate-50 text-left text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                <tr><th className="px-4 py-3">#</th><th className="px-4 py-3">Event</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Reason</th><th className="px-4 py-3">Yes odds</th><th className="px-4 py-3">No odds</th><th className="px-4 py-3">Close time</th><th className="px-4 py-3">Volume</th><th className="px-4 py-3">Liquidity</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {visibleCandidates.map((candidate, index) => (
                  <tr key={`${candidate.marketId ?? candidate.slug ?? candidate.question}-${index}`}>
                    <td className="px-4 py-3 text-slate-500">{eventPageStart + index + 1}</td>
                    <td className="px-4 py-3 font-semibold text-slate-950">{candidate.marketUrl ? <a className="hover:text-sky-700 hover:underline" href={candidate.marketUrl} target="_blank" rel="noreferrer">{candidate.question}</a> : candidate.question}</td>
                    <td className="px-4 py-3"><span title={candidate.filterReasons.join("; ") || undefined} className={`rounded-full px-2.5 py-1 text-xs font-semibold ${candidate.scanStatus === "passed" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>{candidate.scanStatus === "passed" ? "Passed" : "Filtered"}</span></td>
                    <td className="max-w-xs px-4 py-3 text-slate-600">{candidate.filterReasons.join("; ") || "Passed all Stage 1 filters."}</td>
                    <td className="px-4 py-3">{formatOddsPercent(candidate.currentYesOdds)}</td>
                    <td className="px-4 py-3">{formatOddsPercent(candidate.currentNoOdds)}</td>
                    <td className="px-4 py-3">{formatIstDateTime(candidate.closeTime)}</td>
                    <td className="px-4 py-3">{formatMoney(candidate.volumeUsd)}</td>
                    <td className="px-4 py-3">{formatMoney(candidate.liquidityUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {matchingCandidates.length > eventRowsPerPage ? (
            <div className="mt-4 flex items-center justify-center gap-3">
              <button
                type="button"
                disabled={boundedEventPage <= 1}
                onClick={() => setEventPage((page) => Math.max(1, page - 1))}
                className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Previous
              </button>
              <span className="text-sm text-slate-600">
                Page {boundedEventPage} of {eventPageCount}
              </span>
              <button
                type="button"
                disabled={boundedEventPage >= eventPageCount}
                onClick={() =>
                  setEventPage((page) => Math.min(eventPageCount, page + 1))
                }
                className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next
              </button>
            </div>
          ) : null}
          {retainedRowCount === 0 ? (
            <div className="mx-auto max-w-2xl py-8 text-center">
              <p className="font-semibold text-slate-800">No detailed event rows are available.</p>
              <p className="mt-2 text-sm text-slate-600">{state.emptyRowsReason ?? "The run payload contains the scan total, but it does not contain the individual scanned-event records."}</p>
              <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-left text-sm text-amber-950">
                <p className="font-semibold">What the saved run does show</p>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  <li>{state.totalScanned.toLocaleString("en-IN")} events were scanned.</li>
                  <li>{state.passedFilterCount.toLocaleString("en-IN")} events passed Stage 1 filters.</li>
                  <li>{state.rejectedFilterCount === null ? "The rejected-event count was not retained." : `${state.rejectedFilterCount.toLocaleString("en-IN")} events were filtered out.`}</li>
                </ul>
              </div>
            </div>
          ) : omittedRowCount > 0 ? (
            <p className="py-4 text-center text-sm text-amber-700">Showing {retainedRowCount.toLocaleString("en-IN")} retained rows. {omittedRowCount.toLocaleString("en-IN")} additional scanned rows were not retained in the console payload.</p>
          ) : null}</>}
        </div>
      </div>
      {selectedFilterReason ? (
        <div className="fixed inset-0 z-[140] flex items-center justify-center bg-slate-950/45 p-4">
          <div className="flex max-h-[82vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.55)]">
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-sky-700">Stage 1 filter drill-down</p>
                <h3 className="mt-2 text-lg font-semibold text-slate-950">{selectedFilterReason}</h3>
                <p className="mt-1 text-sm text-slate-600">{selectedFilterCandidates.length.toLocaleString("en-IN")} event(s) caught by this filter.</p>
              </div>
              <button type="button" onClick={() => setSelectedFilterReason(null)} className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900" aria-label="Close filtered event list">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-6">
              <div className="overflow-hidden rounded-2xl border border-slate-200">
                <table className="min-w-full divide-y divide-slate-200 text-sm">
                  <thead className="sticky top-0 bg-slate-50 text-left text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                    <tr><th className="px-4 py-3">#</th><th className="px-4 py-3">Event</th><th className="px-4 py-3">Yes odds</th><th className="px-4 py-3">No odds</th><th className="px-4 py-3">Close time</th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {selectedFilterCandidates.map((candidate, index) => (
                      <tr key={`${candidate.marketId ?? candidate.slug ?? candidate.question}-${index}`}>
                        <td className="px-4 py-3 text-slate-500">{index + 1}</td>
                        <td className="px-4 py-3 font-semibold text-slate-950">{candidate.marketUrl ? <a className="hover:text-sky-700 hover:underline" href={candidate.marketUrl} target="_blank" rel="noreferrer">{candidate.question}</a> : candidate.question}</td>
                        <td className="px-4 py-3">{formatOddsPercent(candidate.currentYesOdds)}</td>
                        <td className="px-4 py-3">{formatOddsPercent(candidate.currentNoOdds)}</td>
                        <td className="px-4 py-3">{formatIstDateTime(candidate.closeTime)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function getDecisionExitTypeDetails(decision: BullpenAutoLiveDecision) {
  const matchingSignals = decision.exit_signals.filter(
    (signal) =>
      signal.strategy === "OUTSIDE_TOP_10_RETURNS_DAY" ||
      signal.strategy === "LLM_OR_ODDS_FILTER_EXIT" ||
      signal.strategy === "CAPITAL_AWARE_FORCED_EXIT",
  );
  if (matchingSignals.length === 0) return null;

  const hasForcedExit = matchingSignals.some(
    (signal) => signal.strategy === "CAPITAL_AWARE_FORCED_EXIT",
  );
  const hasEventOutOfTop10 = matchingSignals.some(
    (signal) =>
      signal.strategy === "OUTSIDE_TOP_10_RETURNS_DAY" ||
      signal.strategy === "LLM_OR_ODDS_FILTER_EXIT",
  );

  const label = hasForcedExit
    ? hasEventOutOfTop10
      ? "Exit: Event out of Top 10 + Forced Exit"
      : "Exit: Forced Exit"
    : "Exit: Event out of Top 10";

  const details = [
    hasEventOutOfTop10
      ? "Exit: Event out of Top 10.\nCase 1: Position is outside top 10 by Returns/day.\nCase 2: Odds filter no longer qualifies the event."
      : null,
    hasForcedExit
      ? "Exit: Forced Exit.\nCase 1: Market is 99.5% or more against the held outcome.\nCase 2: Held-side best bid falls below 0.5c."
      : null,
  ]
    .filter(Boolean)
    .join(" ");

  return { label, details };
}

export function formatInvestMetricOrderStatus(decision: BullpenAutoLiveDecision) {
  if (!decision.order_plan) return "No order planned";
  return decision.order_plan.status.replaceAll("_", " ");
}

export function InvestMetricSummaryCard({
  label,
  value,
  onClick,
}: {
  label: string;
  value: ReactNode;
  onClick?: () => void;
}) {
  const classes =
    "rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-left transition";
  if (!onClick) {
    return (
      <div className={classes}>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
          {label}
        </p>
        <p className="mt-2 text-2xl font-semibold text-slate-950">{value}</p>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={`${classes} hover:-translate-y-0.5 hover:border-sky-200 hover:bg-white focus:outline-none focus:ring-2 focus:ring-sky-300`}
    >
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
        {label}
      </p>
      <p className="mt-2 text-2xl font-semibold text-slate-950">{value}</p>
    </button>
  );
}

export function Stage2TransferQueueMetricSummaryCard({
  kind,
  label,
  value,
  cardClassName,
  labelClassName,
  valueClassName,
  onOpenInfo,
}: {
  kind: Stage2TransferQueueMetricInfoKind;
  label: string;
  value: ReactNode;
  cardClassName: string;
  labelClassName: string;
  valueClassName: string;
  onOpenInfo: (kind: Stage2TransferQueueMetricInfoKind) => void;
}) {
  return (
    <div className={cardClassName}>
      <div className="flex items-center gap-1.5">
        <p className={labelClassName}>{label}</p>
        <button
          type="button"
          onClick={() => onOpenInfo(kind)}
          className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-current/20 text-current transition hover:bg-white/70 focus:outline-none focus:ring-2 focus:ring-slate-300"
          aria-label={`Show ${label} details`}
          title={`Show ${label} details`}
        >
          <Info className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>
      <p className={valueClassName}>{value}</p>
    </div>
  );
}

export function Stage2TransferQueueMetricInfoDialog({
  kind,
  onClose,
}: {
  kind: Stage2TransferQueueMetricInfoKind;
  onClose: () => void;
}) {
  const definition = getStage2TransferQueueMetricInfo(kind);

  return (
    <div className="fixed inset-0 z-[140] flex items-center justify-center bg-slate-950/45 p-4">
      <div className="w-full max-w-2xl rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.45)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
              Saved Stage 2 Transfer Queue
            </p>
            <h3 className="text-xl font-semibold text-slate-950">
              {definition.title}
            </h3>
            <p className="text-sm text-slate-600">{definition.summary}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label={`Close ${definition.title} details`}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-5 px-6 py-5">
          <section>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Conditions
            </p>
            <ul className="mt-2 space-y-2 text-sm leading-6 text-slate-700">
              {definition.conditions.map((item) => (
                <li key={item} className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                  {item}
                </li>
              ))}
            </ul>
          </section>
          <section>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Prerequisites
            </p>
            <ul className="mt-2 space-y-2 text-sm leading-6 text-slate-700">
              {definition.prerequisites.map((item) => (
                <li key={item} className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                  {item}
                </li>
              ))}
            </ul>
          </section>
          <section>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Workflow
            </p>
            <ul className="mt-2 space-y-2 text-sm leading-6 text-slate-700">
              {definition.workflow.map((item) => (
                <li key={item} className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                  {item}
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

export function RunDetailWorkerStages({
  run,
  decisions,
  onOpenScanFilters,
  onOpenScanCandidateDialog,
  onOpenStageTwoInvestEvents,
  onOpenStageTwoLlmRunDetails,
  onOpenMetricDetails,
}: {
  run: BullpenAutoLiveRun;
  decisions: BullpenAutoLiveDecision[];
  onOpenScanFilters?: () => void;
  onOpenScanCandidateDialog?: (
    stage: WorkflowStageView,
    mode: ScanCandidateDialogMode,
  ) => void;
  onOpenStageTwoInvestEvents?: (state: StageTwoInvestEventsDialogState) => void;
  onOpenStageTwoLlmRunDetails?: (state: StageTwoLlmRunDialogState) => void;
  onOpenMetricDetails?: (kind: InvestMetricDialogKind) => void;
}) {
  const workflowView = buildBullpenAutoRunWorkflowView(run);
  const scanStage =
    workflowView.stages.find((stage) => stage.key === "scan") ?? undefined;
  const timerNowMs = Date.parse(run.completed_at ?? run.started_at ?? "");
  const stableTimerNowMs = Number.isFinite(timerNowMs) ? timerNowMs : 0;

  return (
    <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
            Background execution monitor
          </p>
          <h3 className="mt-2 text-base font-semibold text-slate-950">
            {workflowView.statusCopy}
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            Run {run.id} · started {formatIstDateTime(run.started_at)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs font-semibold text-slate-700">
          <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1">
            {isBullpenAutoRunWorkflowSettled(workflowView)
              ? "All 3 stages finished"
              : workflowView.currentStageLabel}
          </span>
          <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1">
            {run.decisions_count} decisions
          </span>
          <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1">
            {run.orders_planned} planned
          </span>
          <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1">
            {run.orders_submitted} submitted
          </span>
        </div>
      </div>

      <p className="mt-5 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
        Worker stages
      </p>
      <div className="mt-3 grid gap-3 xl:grid-cols-3">
        {workflowView.stages.map((stage) => {
          const immediateSuccess = getInvestStageImmediateSuccess(stage);
          const investStageCounters = getInvestStageCounters(stage, decisions);
          const investExecutionSteps = getInvestStageExecutionSteps(stage, decisions);
          const toneClasses = getWorkflowToneClasses(
            immediateSuccess ? "green" : stage.tone,
          );
          const stageStatusLabel = immediateSuccess
            ? "Finished"
            : stage.progressLabel === "Interrupted"
              ? "Interrupted"
              : stage.state === "current"
                ? "Working"
                : stage.state === "finished"
                  ? "Finished"
                  : "In Queue";
          const progressPercent = immediateSuccess
            ? 100
            : stage.progressPercent;

          return (
            <div
              key={stage.key}
              className={`flex min-h-[28rem] flex-col rounded-2xl border p-4 shadow-sm ${toneClasses.container}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <p className={`text-sm font-semibold ${toneClasses.text}`}>
                    {stage.title}
                  </p>
                  {stage.subtitle ? (
                    <p className={`text-xs leading-5 ${toneClasses.muted}`}>
                      {stage.subtitle}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-col items-end gap-2">
                  <span
                    className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] ${toneClasses.badge}`}
                  >
                    {stageStatusLabel}
                  </span>
                  <span
                    className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold tabular-nums ${toneClasses.badge}`}
                  >
                    <Clock3 className="h-3 w-3" />
                    {formatStageElapsedTime(
                      stage.timerStartedAt,
                      stage.timerCompletedAt,
                      stableTimerNowMs,
                    )}
                  </span>
                </div>
              </div>

              <div
                className={`mt-3 rounded-xl border border-white/60 bg-white/50 px-3 py-2 text-[11px] leading-5 ${toneClasses.muted}`}
              >
                <div>
                  Last stage run:{" "}
                  <span className="font-semibold tabular-nums">
                    {formatStageLastRunLabel(
                      stage.timerCompletedAt ?? stage.timerStartedAt,
                    )}
                  </span>
                </div>
                <div>
                  Time taken:{" "}
                  <span className="font-semibold tabular-nums">
                    {formatStageElapsedTime(
                      stage.timerStartedAt,
                      stage.timerCompletedAt,
                      stableTimerNowMs,
                    )}
                  </span>
                </div>
                {stage.key === "scan" ? (
                  <StageOneRunStats
                    stage={stage}
                    llmStage={workflowView.stages.find(
                      (item) => item.key === "llm",
                    )}
                    decisions={decisions}
                    run={run}
                    renderInteractiveRows
                    onOpenScanCandidateDialog={onOpenScanCandidateDialog}
                    onOpenScanFilters={onOpenScanFilters}
                  />
                ) : null}
                {stage.key === "llm" ? (
                  <StageTwoRunStats
                    run={run}
                    stage={stage}
                    decisions={decisions}
                    onOpenInvestEvents={onOpenStageTwoInvestEvents}
                    onOpenLlmRunDetails={onOpenStageTwoLlmRunDetails}
                    onOpenScanCandidateDialog={onOpenScanCandidateDialog}
                    scanStageForPositionSnapshot={scanStage}
                  />
                ) : null}
              </div>

              {investStageCounters.length > 0 ? (
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {investStageCounters.map((counter) => (
                    <button
                      type="button"
                      key={counter.label}
                      onClick={() =>
                        onOpenMetricDetails?.(
                          counter.label.toLowerCase() as InvestMetricDialogKind,
                        )
                      }
                      disabled={!onOpenMetricDetails}
                      className="rounded-xl border border-white/70 bg-white/60 px-3 py-2 text-left transition enabled:hover:-translate-y-0.5 enabled:hover:bg-white enabled:focus:outline-none enabled:focus:ring-2 enabled:focus:ring-sky-300"
                    >
                      <p
                        className={`text-[10px] font-semibold uppercase tracking-[0.14em] ${toneClasses.muted}`}
                      >
                        {counter.label}
                      </p>
                      <p
                        className={`mt-1 text-sm font-semibold tabular-nums ${toneClasses.text}`}
                      >
                        {counter.value}
                      </p>
                    </button>
                  ))}
                </div>
              ) : null}

              {investExecutionSteps.length > 0 ? (
                <div className="mt-3">
                  <InvestExecutionStepsSummary
                    steps={investExecutionSteps}
                    compact
                    onOpenMetricDetails={onOpenMetricDetails}
                  />
                </div>
              ) : null}

              <div
                className={`mt-4 h-2 overflow-hidden rounded-full ${toneClasses.progressTrack}`}
              >
                <div
                  className={`h-full rounded-full ${toneClasses.progress}`}
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
              <p className={`mt-3 text-xs font-semibold ${toneClasses.text}`}>
                {immediateSuccess ? "Finished" : stage.progressLabel}
              </p>
              {stage.key === "invest" ? null : (
                <div className={`mt-3 text-xs leading-5 ${toneClasses.muted}`}>
                  <p>{stage.detail}</p>
                  {stage.state === "current" &&
                  stage.progressCommentary.length > 0 ? (
                    <div className="mt-3 rounded-xl border border-white/70 bg-white/45 px-3 py-2">
                      <p className={`font-semibold ${toneClasses.text}`}>
                        Progress commentary
                      </p>
                      <ul className="mt-2 space-y-1.5">
                        {stage.progressCommentary.map((item, index) => (
                          <li
                            key={`${stage.key}-commentary-${index}`}
                            className="flex gap-2"
                          >
                            <span aria-hidden="true">•</span>
                            <span>{item}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function RunDetailDialog({
  state,
  onClose,
  presentation = "dialog",
  onOpenScanFilters,
  onOpenScanCandidateDialog,
  onOpenStageTwoInvestEvents,
  onOpenStageTwoLlmRunDetails,
  onOpenMetricDetails,
}: {
  state: RunDetailDialogState;
  onClose: () => void;
  presentation?: "dialog" | "page";
  onOpenScanFilters?: () => void;
  onOpenScanCandidateDialog?: (
    stage: WorkflowStageView,
    mode: ScanCandidateDialogMode,
  ) => void;
  onOpenStageTwoInvestEvents?: (state: StageTwoInvestEventsDialogState) => void;
  onOpenStageTwoLlmRunDetails?: (state: StageTwoLlmRunDialogState) => void;
  onOpenMetricDetails?: (
    run: BullpenAutoLiveRun,
    kind: InvestMetricDialogKind,
    decisions?: BullpenAutoLiveDecision[],
  ) => void;
}) {
  const { run, decisions } = state;
  const summaryDetails = getRunSummaryDetails(run.summary);
  const [warningsDialogOpen, setWarningsDialogOpen] = useState(false);
  const [plannedOrderDetail, setPlannedOrderDetail] =
    useState<PlannedOrderDetailState | null>(null);
  const [decisionLlmOdds, setDecisionLlmOdds] =
    useState<DecisionLlmOddsState | null>(null);
  const isPage = presentation === "page";
  return (
    <div
      className={
        isPage
          ? "min-h-screen bg-slate-100 p-4 text-slate-950 md:p-8"
          : "fixed inset-0 z-[140] flex items-center justify-center bg-slate-950/60 p-4"
      }
    >
      <div
        className={
          isPage
            ? "mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-[92rem] flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-xl"
            : "flex max-h-[90vh] min-h-0 w-full max-w-[92rem] flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.55)]"
        }
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
              Run Details
            </p>
            <h2 className="max-w-5xl rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold leading-5 text-slate-950">
              {summaryDetails.overview ?? "Run summary unavailable."}
            </h2>
            <p className="text-xs text-slate-500">Run {run.id}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label={isPage ? "Back to run history" : "Close run details"}
            title={isPage ? "Back to run history" : "Close run details"}
          >
            {isPage ? (
              <ArrowLeft className="h-4 w-4" />
            ) : (
              <X className="h-4 w-4" />
            )}
          </button>
        </div>
        <div
          className={
            isPage
              ? "flex-1 px-6 py-5"
              : "min-h-0 flex-1 overflow-y-auto px-6 py-5"
          }
        >
          <div className="grid gap-3 md:grid-cols-3">
            <InvestMetricSummaryCard
              label="Decisions"
              value={run.decisions_count}
              onClick={
                onOpenMetricDetails
                  ? () => onOpenMetricDetails(run, "decisions", decisions)
                  : undefined
              }
            />
            <InvestMetricSummaryCard
              label="Planned"
              value={run.orders_planned}
              onClick={
                onOpenMetricDetails
                  ? () => onOpenMetricDetails(run, "planned", decisions)
                  : undefined
              }
            />
            <InvestMetricSummaryCard
              label="Submitted"
              value={run.orders_submitted}
              onClick={
                onOpenMetricDetails
                  ? () => onOpenMetricDetails(run, "submitted", decisions)
                  : undefined
              }
            />
          </div>
          {summaryDetails.warnings.length > 0 ? (
            <section className="mt-4 rounded-2xl border border-amber-200 bg-amber-50/60 px-3 py-2">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-800">
                <span>Brief warnings / errors</span>
                <button
                  type="button"
                  onClick={() => setWarningsDialogOpen(true)}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-amber-200 bg-white text-amber-800 transition hover:bg-amber-100"
                  aria-label="Open detailed warnings and errors"
                  title="Open detailed warnings and errors"
                >
                  <Info className="h-3.5 w-3.5" />
                </button>
              </div>
            </section>
          ) : null}
          {run.error_message ? (
            <div className="mt-4 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-800">
              <ErrorCodeWithDetails
                detail={run.error_message}
                detailClassName="text-rose-800"
              />
            </div>
          ) : null}
          <SubmittedExecutionEventsTable
            decisions={decisions}
            onOpenPlannedOrderDetail={setPlannedOrderDetail}
            onOpenLlmOdds={(decision) => setDecisionLlmOdds({ decision })}
          />
          {state.decisionListTruncated ? (
            <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Showing the newest {decisions.length} of {run.decisions_count}{" "}
              decisions while this run is active. The bounded live refresh
              preserves already loaded rows.
            </p>
          ) : null}
          <RunDetailWorkerStages
            run={run}
            decisions={decisions}
            onOpenScanFilters={onOpenScanFilters}
            onOpenScanCandidateDialog={onOpenScanCandidateDialog}
            onOpenStageTwoInvestEvents={onOpenStageTwoInvestEvents}
            onOpenStageTwoLlmRunDetails={onOpenStageTwoLlmRunDetails}
            onOpenMetricDetails={
              onOpenMetricDetails
                ? (kind) => onOpenMetricDetails(run, kind, decisions)
                : undefined
            }
          />
          <div className="mt-5 space-y-4">
            {run.stage_results.map((stage) => (
              <section
                key={`${stage.stage_number}-${stage.stage_name}`}
                className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                      Stage {stage.stage_number}
                    </p>
                    <h3 className="mt-1 text-base font-semibold text-slate-950">
                      {stage.stage_name}
                    </h3>
                  </div>
                  <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold capitalize text-slate-700">
                    {stage.status}
                  </span>
                </div>
                <p className="mt-2 text-xs text-slate-500">
                  Started {formatIstDateTime(stage.started_at)}
                  {stage.completed_at
                    ? ` · completed ${formatIstDateTime(stage.completed_at)}`
                    : ""}
                </p>
                <pre className="mt-3 max-h-64 overflow-auto rounded-xl bg-white p-3 text-xs leading-5 text-slate-700">
                  {JSON.stringify(stage.outputs ?? {}, null, 2)}
                </pre>
              </section>
            ))}
          </div>
        </div>
      </div>
      {warningsDialogOpen ? (
        <RunWarningsDialog
          warnings={summaryDetails.warnings}
          onClose={() => setWarningsDialogOpen(false)}
        />
      ) : null}
      {decisionLlmOdds ? (
        <DecisionLlmOddsDialog
          state={decisionLlmOdds}
          onClose={() => setDecisionLlmOdds(null)}
        />
      ) : null}
      {plannedOrderDetail ? (
        <PlannedOrderDetailDialog
          state={plannedOrderDetail}
          onClose={() => setPlannedOrderDetail(null)}
        />
      ) : null}
    </div>
  );
}

export function BullpenRunDetailScreen({
  runId,
  workspaceProfile = "bullpen007",
}: {
  runId: string;
  workspaceProfile?: BullpenWorkspaceProfile;
}) {
  const router = useRouter();
  const [state, setState] = useState<RunDetailDialogState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [scanCandidateDialog, setScanCandidateDialog] =
    useState<ScanCandidateDialogState | null>(null);
  const [stageTwoInvestEventsDialog, setStageTwoInvestEventsDialog] =
    useState<StageTwoInvestEventsDialogState | null>(null);
  const [stageTwoLlmRunDialog, setStageTwoLlmRunDialog] =
    useState<StageTwoLlmRunDialogState | null>(null);
  const [investMetricDialog, setInvestMetricDialog] =
    useState<InvestMetricDialogState | null>(null);
  const normalizedRunId = runId.trim();

  useEffect(() => {
    if (!normalizedRunId) {
      setError("A run id is required.");
      return;
    }

    const controller = new AbortController();
    setState(null);
    setError(null);

    void (async () => {
      try {
        const consoleDetail = await apiService.getBullpenAutoLiveRunConsole(
          normalizedRunId,
          {
            signal: controller.signal,
            timeoutMs: 10_000,
          },
        );
        if (controller.signal.aborted) return;
        const [run, decisions] = consoleDetail.projection_available
          ? [consoleDetail.run, consoleDetail.decisions]
          : await Promise.all([
              // Only legacy runs without a bounded projection may read the
              // immutable payload. Current Stage 1 snapshots can contain
              // hundreds of thousands of audited rows and must never make
              // this request merely to open the dedicated run page.
              apiService.getBullpenAutoLiveRun(normalizedRunId, {
                signal: controller.signal,
                timeoutMs: 10_000,
              }),
              apiService.getBullpenAutoLiveRunDecisions(normalizedRunId, {
                signal: controller.signal,
                timeoutMs: 10_000,
              }),
            ]);
        if (controller.signal.aborted) return;

        const fullStage =
          buildBullpenAutoRunWorkflowView(run).stages.find(
            (workflowStage) => workflowStage.key === "invest",
          ) ?? null;
        let detailRun = run;
        const persistedDecisions = Array.isArray(decisions) ? decisions : [];
        let detailDecisions = mergeInvestStageDecisionRows({
          stage: fullStage,
          persistedDecisions,
        });
        let decisionListTruncated = false;
        let decisionListLimit: number | undefined;

        if (consoleDetail.projection_available) {
          const projectedDecisions = Array.isArray(consoleDetail.decisions)
            ? consoleDetail.decisions
            : [];
          const visibleDecisionIds = Array.isArray(
            consoleDetail.visible_decision_ids,
          )
            ? consoleDetail.visible_decision_ids
            : [];
          const projectedStage =
            buildBullpenAutoRunWorkflowView(consoleDetail.run).stages.find(
              (workflowStage) => workflowStage.key === "invest",
            ) ?? null;
          detailRun = mergeBullpenConsoleRunProjection({
            existing: run,
            projected: consoleDetail.run,
            projectionAvailable: true,
          });
          detailDecisions = mergeBullpenConsoleDecisionProjection({
            existing: detailDecisions,
            projected: mergeInvestStageDecisionRows({
              stage: projectedStage,
              persistedDecisions: projectedDecisions,
            }),
            truncated: Boolean(consoleDetail.decisions_truncated),
            visibleDecisionIds,
            visibleDecisionIdsTruncated: Boolean(
              consoleDetail.visible_decision_ids_truncated,
            ),
          });
          decisionListTruncated =
            Boolean(consoleDetail.visible_decision_ids_truncated) ||
            (Boolean(consoleDetail.decisions_truncated) &&
              detailDecisions.length < visibleDecisionIds.length);
          decisionListLimit = consoleDetail.decisions_limit;
        }

        setState({
          run: detailRun,
          decisions: detailDecisions,
          decisionListTruncated,
          decisionListLimit,
        });
      } catch (nextError) {
        if (controller.signal.aborted || isRequestAbort(nextError)) return;
        setError(
          `Run ${normalizedRunId} details could not be loaded. ${formatUnknownError(nextError)}`,
        );
      }
    })();

    return () => controller.abort();
  }, [normalizedRunId, reloadKey]);

  const returnToHistory = () =>
    router.push(bullpenWorkspaceHistoryPath(workspaceProfile));

  if (state) {
    const openScanCandidateDialog = (
      stage: WorkflowStageView,
      mode: ScanCandidateDialogMode,
    ) =>
      setScanCandidateDialog(
        buildRunDetailScanCandidateDialogState({
          run: state.run,
          decisions: state.decisions,
          stage,
          mode,
        }),
      );
    const openInvestMetricDialog = (
      run: BullpenAutoLiveRun,
      kind: InvestMetricDialogKind,
      detailDecisions: BullpenAutoLiveDecision[] = state.decisions,
    ) => {
      const stage =
        buildBullpenAutoRunWorkflowView(run).stages.find(
          (workflowStage) => workflowStage.key === "invest",
        ) ?? null;
      setInvestMetricDialog({
        kind,
        run,
        stage,
        decisions: mergeInvestStageDecisionRows({
          stage,
          persistedDecisions: detailDecisions,
        }),
      });
    };

    return (
      <>
        <RunDetailDialog
          state={state}
          presentation="page"
          onClose={returnToHistory}
          onOpenScanCandidateDialog={openScanCandidateDialog}
          onOpenStageTwoInvestEvents={setStageTwoInvestEventsDialog}
          onOpenStageTwoLlmRunDetails={setStageTwoLlmRunDialog}
          onOpenMetricDetails={openInvestMetricDialog}
        />
        {scanCandidateDialog ? (
          <StageOneOutputDialog
            state={scanCandidateDialog}
            onClose={() => setScanCandidateDialog(null)}
            workspaceProfile={workspaceProfile}
          />
        ) : null}
        {stageTwoInvestEventsDialog ? (
          <StageTwoInvestEventsDialog
            state={stageTwoInvestEventsDialog}
            onClose={() => setStageTwoInvestEventsDialog(null)}
          />
        ) : null}
        {stageTwoLlmRunDialog ? (
          <StageTwoLlmRunDetailsDialog
            state={stageTwoLlmRunDialog}
            onClose={() => setStageTwoLlmRunDialog(null)}
          />
        ) : null}
        {investMetricDialog ? (
          <InvestMetricDetailsDialog
            state={investMetricDialog}
            onClose={() => setInvestMetricDialog(null)}
            onSelectKind={(kind) =>
              setInvestMetricDialog((current) =>
                current ? { ...current, kind } : null,
              )
            }
          />
        ) : null}
      </>
    );
  }

  return (
    <main className="min-h-screen bg-slate-100 p-4 text-slate-950 md:p-8">
      <div className="mx-auto min-h-[calc(100vh-4rem)] w-full max-w-[92rem] rounded-3xl border border-slate-200 bg-white p-6 shadow-xl">
        <button
          type="button"
          onClick={returnToHistory}
          className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to run history
        </button>
        {error ? (
          <div className="mt-8 rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-900">
            <p className="font-semibold">Run details unavailable</p>
            <p className="mt-2">{error}</p>
            <button
              type="button"
              onClick={() => setReloadKey((value) => value + 1)}
              className="mt-4 rounded-xl border border-rose-300 bg-white px-3 py-2 font-semibold transition hover:bg-rose-100"
            >
              Retry
            </button>
          </div>
        ) : (
          <div className="mt-10 flex items-center gap-3 text-sm font-semibold text-slate-600">
            <Loader2 className="h-5 w-5 animate-spin" />
            Loading run {normalizedRunId}…
          </div>
        )}
      </div>
    </main>
  );
}

export function RunWarningsDialog({
  warnings,
  onClose,
}: {
  warnings: RunSummaryWarning[];
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[155] flex items-center justify-center bg-slate-950/60 p-4">
      <div className="flex max-h-[80vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-amber-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.55)]">
        <div className="flex items-start justify-between gap-4 border-b border-amber-100 px-6 py-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-amber-700">
              Brief warnings / errors
            </p>
            <h3 className="mt-1 text-lg font-semibold text-slate-950">
              Detailed messages
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close warnings"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-y-auto px-6 py-5">
          <div className="space-y-3">
            {warnings.map((warning, index) => (
              <div
                key={`${warning.label}-${index}`}
                className="rounded-2xl border border-amber-100 bg-amber-50/60 p-4"
              >
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-800">
                  {warning.label}
                </p>
                <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">
                  {warning.detail}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function DecisionLlmOddsDialog({
  state,
  onClose,
}: {
  state: DecisionLlmOddsState;
  onClose: () => void;
}) {
  const { decision } = state;
  return (
    <div className="fixed inset-0 z-[155] flex items-center justify-center bg-slate-950/60 p-4">
      <div className="flex max-h-[82vh] w-full max-w-5xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.55)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-violet-700">
              LLM Odds Breakdown
            </p>
            <h3 className="mt-1 text-lg font-semibold text-slate-950">
              {decision.market_title}
            </h3>
            <p className="mt-2 text-sm text-slate-600">
              Consensus Yes{" "}
              {formatOddsPercent(decision.fair_yes_probability_pct ?? null)} ·
              Consensus No{" "}
              {formatOddsPercent(decision.fair_no_probability_pct ?? null)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close LLM odds breakdown"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-y-auto px-6 py-5">
          {decision.llm_outputs.length ? (
            <div className="space-y-3">
              {decision.llm_outputs.map((output, index) => (
                <div
                  key={`${output.provider}-${output.model}-${index}`}
                  className="rounded-2xl border border-violet-100 bg-violet-50/40 p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-slate-950">
                      {output.provider} · {output.model}
                    </p>
                    <div className="flex gap-2 text-xs font-semibold">
                      <span className="rounded-full border border-violet-200 bg-white px-2.5 py-1 text-violet-800">
                        Yes {formatOddsPercent(output.llm_yes_odds ?? null)}
                      </span>
                      <span className="rounded-full border border-violet-200 bg-white px-2.5 py-1 text-violet-800">
                        No {formatOddsPercent(output.llm_no_odds ?? null)}
                      </span>
                    </div>
                  </div>
                  {output.rationale ? (
                    <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-700">
                      {output.rationale}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <p className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
              No per-model LLM outputs were recorded for this decision.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export function PlannedOrderDetailDialog({
  state,
  onClose,
}: {
  state: PlannedOrderDetailState;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[155] flex items-center justify-center bg-slate-950/60 p-4">
      <div className="flex max-h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.55)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
              Planned but not submitted
            </p>
            <h3 className="mt-1 text-lg font-semibold text-slate-950">
              {state.title}
            </h3>
            <p className="mt-2 text-sm text-slate-600">{state.summary}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close planned order detail"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-y-auto px-6 py-5">
          <pre className="whitespace-pre-wrap break-words rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-700">
            {state.detail}
          </pre>
        </div>
      </div>
    </div>
  );
}

export function getDecisionDaysLeft(decision: BullpenAutoLiveDecision) {
  const days = getDecisionDaysUntilClose(decision);
  return days === null
    ? "—"
    : days.toLocaleString("en-IN", { maximumFractionDigits: 1 });
}

export function buildDecisionReturnsPerDayQuestion(
  decision: BullpenAutoLiveDecision,
): BullpenQuestionRow {
  return {
    question: decision.market_title,
    yesOdds: decision.current_yes_odds ?? null,
    noOdds: decision.current_no_odds ?? null,
    llmYesOdds: decision.fair_yes_probability_pct ?? null,
    llmNoOdds: decision.fair_no_probability_pct ?? null,
    daysUntilClose: getDecisionDaysUntilClose(decision),
    returnsPerDay: getDecisionReturnsPerDay(decision),
  } as BullpenQuestionRow;
}

export function humanizeStage3CapacityMessage(
  decision: BullpenAutoLiveDecision,
): string | null {
  const detail = (
    decision.order_plan?.detail ?? decision.reason ?? decision.summary ?? ""
  ).trim();
  const normalized = detail.toLowerCase();
  if (
    normalized.includes("open or unfilled") ||
    normalized.includes("still open") ||
    normalized.includes("unconfirmed after the polling timeout")
  ) {
    return "Event Exit order is still open or unfilled; its slot remains occupied.";
  }
  if (
    normalized.includes("partially filled") &&
    (normalized.includes("meaningful") || normalized.includes("exposure"))
  ) {
    return "Event Exit partially filled; meaningful remaining exposure still occupies the slot.";
  }
  if (normalized.includes("cached") || normalized.includes("stale snapshot")) {
    return "Bullpen returned a cached or stale positions snapshot; no replacement buy was planned.";
  }
  if (
    normalized.includes("dust") ||
    normalized.includes("resolved") ||
    normalized.includes("non-active")
  ) {
    return "A dust, resolved, or non-active position was excluded from slot usage; the replacement slot was released.";
  }
  if (normalized.includes("portfolio capacity is genuinely full")) {
    return "Portfolio capacity is genuinely reached: ten economically active markets already occupy the limit.";
  }
  if (normalized.includes("replacement slot successfully released")) {
    return "Replacement slot successfully released after the confirmed Event Exit and live refresh.";
  }
  return null;
}

export function getPlannedOrderBrief(decision: BullpenAutoLiveDecision) {
  const capacityMessage = humanizeStage3CapacityMessage(decision);
  if (capacityMessage) return capacityMessage;
  return (
    decision.order_plan?.detail ??
    decision.reason ??
    decision.summary ??
    "Planned buy order was not submitted."
  );
}

export function Stage3SellExecutionTelemetry({
  decision,
}: {
  decision: BullpenAutoLiveDecision;
}) {
  const telemetry = getBullpenStage3SellExecutionTelemetry(decision.order_plan);
  if (!telemetry) return null;

  return (
    <div className="my-1.5 space-y-1">
      <span
        className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] ${
          telemetry.sequence === 1
            ? "border-sky-200 bg-sky-50 text-sky-800"
            : "border-amber-200 bg-amber-50 text-amber-800"
        }`}
      >
        {telemetry.label}
      </span>
      {telemetry.reason ? (
        <p className="text-[11px] leading-4 text-amber-800">
          <span className="font-semibold">Fallback reason:</span>{" "}
          {telemetry.reason}
        </p>
      ) : null}
    </div>
  );
}

export function Stage3DecisionTable({
  title,
  rows,
  emptyMessage,
  plannedButNotSubmitted = false,
  onOpenPlannedOrderDetail,
  onOpenLlmOdds,
}: {
  title: string;
  rows: BullpenAutoLiveDecision[];
  emptyMessage: string;
  plannedButNotSubmitted?: boolean;
  onOpenPlannedOrderDetail?: (state: PlannedOrderDetailState) => void;
  onOpenLlmOdds?: (decision: BullpenAutoLiveDecision) => void;
}) {
  const [isReturnsPerDayFormulaDialogOpen, setIsReturnsPerDayFormulaDialogOpen] =
    useState(false);
  const [returnsPerDayQuestion, setReturnsPerDayQuestion] =
    useState<BullpenQuestionRow | null>(null);
  return (
    <div className="overflow-hidden rounded-2xl border border-white/80 bg-white/60">
      <div className="border-b border-white/80 px-4 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-700">
          {title}
        </p>
      </div>
      {rows.length ? (
        <div className="overflow-x-auto">
          <table className="min-w-[78rem] divide-y divide-white/80 text-left text-xs">
            <thead className="bg-white/70 font-semibold uppercase tracking-[0.12em] text-slate-600">
              <tr>
                <th className="px-4 py-3">Event</th>
                <th className="px-4 py-3">Side</th>
                <th className="px-4 py-3">Size</th>
                <th className="px-4 py-3">Limit</th>
                <th className="px-4 py-3">Event Closing time</th>
                <th className="px-4 py-3">Days left</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Current Yes odds %</th>
                <th className="px-4 py-3">Current No odds %</th>
                <th className="px-4 py-3">LLM Yes Odds</th>
                <th className="px-4 py-3">LLM No Odds</th>
                <th className="px-4 py-3">
                  <BullpenReturnsPerDayHeader
                    onOpen={() => setIsReturnsPerDayFormulaDialogOpen(true)}
                  />
                </th>
                <th className="px-4 py-3">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/80 bg-white/50">
              {rows.map((decision) => {
                const detail = plannedButNotSubmitted
                  ? getPlannedOrderBrief(decision)
                  : (decision.order_plan?.detail ??
                    "Submitted without extra execution detail.");
                return (
                  <tr key={decision.id} className="align-top hover:bg-white/70">
                    <td className="min-w-72 px-4 py-3">
                      <div className="font-semibold text-slate-950 line-clamp-2">
                        {decision.market_url ? (
                          <a
                            className="hover:text-sky-700 hover:underline"
                            href={decision.market_url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {decision.market_title}
                          </a>
                        ) : (
                          decision.market_title
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-semibold uppercase text-slate-800">
                      {decision.order_plan?.side ?? decision.side}
                    </td>
                    <td className="px-4 py-3 font-semibold tabular-nums text-slate-950">
                      {formatMoney(decision.order_plan?.order_size_usd ?? null)}
                      <div className="mt-1 text-[11px] font-normal text-slate-500">
                        {decision.order_plan?.shares.toLocaleString("en-IN", {
                          maximumFractionDigits: 4,
                        }) ?? "—"}{" "}
                        shares
                      </div>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-slate-700">
                      {formatPriceCents(
                        decision.order_plan?.limit_price_cents ?? null,
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-slate-700">
                      {formatIstDateTime(decision.close_time)}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-slate-700">
                      {getDecisionDaysLeft(decision)}
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {decision.theme || "—"}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-slate-700">
                      {formatOddsPercent(decision.current_yes_odds ?? null)}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-slate-700">
                      {formatOddsPercent(decision.current_no_odds ?? null)}
                    </td>
                    <td className="px-4 py-3 tabular-nums font-semibold text-violet-800">
                      <button
                        type="button"
                        onClick={() => onOpenLlmOdds?.(decision)}
                        className="underline decoration-violet-300 underline-offset-4 hover:text-violet-950"
                      >
                        {formatOddsPercent(
                          decision.fair_yes_probability_pct ?? null,
                        )}
                      </button>
                    </td>
                    <td className="px-4 py-3 tabular-nums font-semibold text-violet-800">
                      <button
                        type="button"
                        onClick={() => onOpenLlmOdds?.(decision)}
                        className="underline decoration-violet-300 underline-offset-4 hover:text-violet-950"
                      >
                        {formatOddsPercent(
                          decision.fair_no_probability_pct ?? null,
                        )}
                      </button>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-slate-700">
                      <BullpenReturnsPerDayValueButton
                        disabled={getDecisionReturnsPerDay(decision) === null}
                        onOpen={() =>
                          setReturnsPerDayQuestion(
                            buildDecisionReturnsPerDayQuestion(decision),
                          )
                        }
                        ariaLabel={`Show Returns/day calculation for ${decision.market_title}`}
                      >
                        {formatReturnsPerDay(getDecisionReturnsPerDay(decision))}
                      </BullpenReturnsPerDayValueButton>
                    </td>
                    <td className="min-w-64 px-4 py-3 text-slate-700">
                      <Stage3SellExecutionTelemetry decision={decision} />
                      {plannedButNotSubmitted && onOpenPlannedOrderDetail ? (
                        <div className="flex items-start gap-2">
                          <span className="line-clamp-2 break-words">
                            {detail}
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              onOpenPlannedOrderDetail({
                                title: decision.market_title,
                                summary: detail,
                                detail:
                                  [
                                    decision.order_plan?.detail,
                                    decision.order_plan?.execution_response,
                                    decision.reason,
                                    decision.summary,
                                  ]
                                    .filter(Boolean)
                                    .join("\n\n") || detail,
                              })
                            }
                            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-100"
                            aria-label="Open detailed planned order error"
                            title="Open detailed planned order error"
                          >
                            <Info className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ) : (
                        <ErrorCodeWithDetails
                          detail={detail}
                          detailClassName="text-slate-700"
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="px-4 py-5 text-sm text-slate-600">{emptyMessage}</p>
      )}
      {returnsPerDayQuestion ? (
        <BullpenInvestmentMathDialog
          focus="returnsPerDay"
          question={returnsPerDayQuestion}
          onClose={() => setReturnsPerDayQuestion(null)}
        />
      ) : null}
      {isReturnsPerDayFormulaDialogOpen ? (
        <BullpenReturnsPerDayFormulaDialog
          onClose={() => setIsReturnsPerDayFormulaDialogOpen(false)}
        />
      ) : null}
    </div>
  );
}

export type SubmittedExecutionStatus =
  | "not-submitted"
  | "submitted"
  | "in-progress"
  | "partial";

export function getSubmittedExecutionStatus(
  totalOrders: number,
  submittedOrders: number,
): SubmittedExecutionStatus {
  if (totalOrders < 1) return "in-progress";
  if (submittedOrders >= totalOrders) return "submitted";
  if (submittedOrders < 1) return "not-submitted";
  return "partial";
}

export function SubmittedExecutionStatusIcon({
  status,
}: {
  status: SubmittedExecutionStatus;
}) {
  const config: Record<
    SubmittedExecutionStatus,
    { label: string; className: string; icon: ReactNode }
  > = {
    "not-submitted": {
      label: "All not submitted",
      className: "border-rose-200 bg-rose-50 text-rose-700",
      icon: <X className="h-3.5 w-3.5 stroke-[3]" />,
    },
    submitted: {
      label: "All submitted",
      className: "border-emerald-200 bg-emerald-50 text-emerald-700",
      icon: <CheckCircle2 className="h-3.5 w-3.5 stroke-[2.75]" />,
    },
    "in-progress": {
      label: "In progress",
      className: "border-sky-200 bg-sky-50 text-sky-700",
      icon: <Loader2 className="h-3.5 w-3.5 animate-spin stroke-[2.75]" />,
    },
    partial: {
      label: "Partial",
      className: "border-amber-200 bg-amber-50 text-amber-700",
      icon: <Square className="h-3.5 w-3.5 fill-current stroke-[2.75]" />,
    },
  };
  const { label, className, icon } = config[status];

  return (
    <span
      className={`inline-flex h-6 w-6 items-center justify-center rounded-full border ${className}`}
      aria-label={label}
      title={label}
    >
      {icon}
    </span>
  );
}

export function SubmittedExecutionCountPill({
  children,
  className,
  status,
}: {
  children: ReactNode;
  className: string;
  status?: SubmittedExecutionStatus;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 ${className}`}
    >
      <span>{children}</span>
      {status ? <SubmittedExecutionStatusIcon status={status} /> : null}
    </span>
  );
}

export function SubmittedExecutionEventsTable({
  decisions,
  onOpenPlannedOrderDetail,
  onOpenLlmOdds,
}: {
  decisions: BullpenAutoLiveDecision[];
  onOpenPlannedOrderDetail: (state: PlannedOrderDetailState) => void;
  onOpenLlmOdds: (decision: BullpenAutoLiveDecision) => void;
}) {
  const {
    submittedOrExecuted: successfulOrPendingSubmittedDecisions,
    submittedButUnsuccessful,
    completedWithoutSubmission,
    notSubmitted,
  } = partitionInvestDecisionsByExecutionEvidence(decisions);
  const submittedDecisions = [
    ...successfulOrPendingSubmittedDecisions,
    ...submittedButUnsuccessful,
  ];
  const exitDecisions = decisions.filter(
    (decision) =>
      decision.order_plan?.action === "sell" ||
      decision.order_plan?.action === "redeem",
  );
  const buyDecisions = decisions.filter(
    (decision) => decision.order_plan?.action === "buy",
  );
  const successfulOrPendingExitDecisions =
    successfulOrPendingSubmittedDecisions.filter(
      (decision) =>
        decision.order_plan?.action === "sell" ||
        decision.order_plan?.action === "redeem",
    );
  const submittedExitDecisions = submittedDecisions.filter(
    (decision) =>
      decision.order_plan?.action === "sell" ||
      decision.order_plan?.action === "redeem",
  );
  const successfulOrPendingBuyDecisions =
    successfulOrPendingSubmittedDecisions.filter(
      (decision) => decision.order_plan?.action === "buy",
    );
  const submittedBuyDecisions = submittedDecisions.filter(
    (decision) => decision.order_plan?.action === "buy",
  );
  const actionableExitDecisions = exitDecisions.filter(
    (decision) => !isCompletedWithoutSubmissionInvestDecision(decision),
  );
  const plannedDecisions = [...exitDecisions, ...buyDecisions];
  const exitStatus = getSubmittedExecutionStatus(
    actionableExitDecisions.length,
    submittedExitDecisions.length,
  );
  const buyStatus = getSubmittedExecutionStatus(
    buyDecisions.length,
    submittedBuyDecisions.length,
  );

  return (
    <section className="mt-5 overflow-hidden rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50 via-sky-50 to-violet-50">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/80 px-4 py-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">
            Stage 3 Order Outcomes
          </p>
          <h3 className="mt-1 text-sm font-semibold text-slate-950">
            Step 1 Exit and Step 2 Buy submission and execution results
          </h3>
        </div>
        <div className="flex flex-wrap gap-2 text-xs font-semibold">
          <SubmittedExecutionCountPill className="border-emerald-200 bg-white/80 text-emerald-800">
            {plannedDecisions.length.toLocaleString("en-IN")} planned
          </SubmittedExecutionCountPill>
          <SubmittedExecutionCountPill className="border-sky-200 bg-sky-50 text-sky-800">
            {submittedDecisions.length.toLocaleString("en-IN")} submitted
          </SubmittedExecutionCountPill>
          <SubmittedExecutionCountPill
            className="border-rose-200 bg-rose-50 text-rose-800"
            status={exitStatus}
          >
            {submittedExitDecisions.length.toLocaleString("en-IN")}/
            {exitDecisions.length.toLocaleString("en-IN")} exits
          </SubmittedExecutionCountPill>
          <SubmittedExecutionCountPill
            className="border-blue-200 bg-blue-50 text-blue-800"
            status={buyStatus}
          >
            {submittedBuyDecisions.length.toLocaleString("en-IN")}/
            {buyDecisions.length.toLocaleString("en-IN")} buys
          </SubmittedExecutionCountPill>
          {completedWithoutSubmission.length > 0 ? (
            <SubmittedExecutionCountPill className="border-slate-200 bg-white/80 text-slate-700">
              {completedWithoutSubmission.length.toLocaleString("en-IN")} no new
              order
            </SubmittedExecutionCountPill>
          ) : null}
        </div>
      </div>
      <div className="space-y-4 p-4">
        <Stage3DecisionTable
          title="Step 1 Exit"
          rows={successfulOrPendingExitDecisions}
          emptyMessage="No pending or successful submitted Step 1 Exit events were returned for this run."
          onOpenLlmOdds={onOpenLlmOdds}
        />
        <Stage3DecisionTable
          title="Step 2 Buy"
          rows={successfulOrPendingBuyDecisions}
          emptyMessage="No pending or successful submitted Step 2 Buy events were returned for this run."
          onOpenLlmOdds={onOpenLlmOdds}
        />
        <Stage3DecisionTable
          title="Submitted but Unsuccessful"
          rows={submittedButUnsuccessful}
          emptyMessage="No submitted orders ended in a terminal unsuccessful state."
          onOpenLlmOdds={onOpenLlmOdds}
        />
        <Stage3DecisionTable
          title="Orders Planned but not Submitted"
          rows={notSubmitted}
          emptyMessage="No planned orders were left unsubmitted for this run."
          plannedButNotSubmitted
          onOpenPlannedOrderDetail={onOpenPlannedOrderDetail}
          onOpenLlmOdds={onOpenLlmOdds}
        />
        {completedWithoutSubmission.length > 0 ? (
          <Stage3DecisionTable
            title="Completed without a New Order"
            rows={completedWithoutSubmission}
            emptyMessage="No Stage 3 outcomes completed without a new order."
            onOpenLlmOdds={onOpenLlmOdds}
          />
        ) : null}
      </div>
    </section>
  );
}

export function readLlmContextRecord(
  record: Record<string, unknown> | null,
  key: string,
) {
  if (!record) return null;
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readLlmContextArray(
  record: Record<string, unknown> | null,
  key: string,
) {
  if (!record) return [];
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

export function getStageTwoLlmTableRows(
  state: StageTwoLlmRunDialogState,
  asOfTimestamp?: string | number | Date | null,
) {
  const scanCandidates =
    state.run
      ? (buildBullpenAutoRunWorkflowView(state.run).stages.find(
          (workflowStage) => workflowStage.key === "scan",
        )?.scanCandidates ?? [])
      : [];
  const reviewedRows = getStageTwoLlmReviewedRows(
    state.stage,
    scanCandidates,
    state.decisions,
  );
  return getHistoricalStageTwoLlmTableRows({
    reviewedRows,
    decisions: state.decisions,
    asOfTimestamp,
    runId: state.run?.id ?? null,
  });
}

export function buildStageTwoEventsSummaryRows(
  reviewedRows: ReturnType<typeof getStageTwoLlmReviewedRows>,
  decisions: BullpenAutoLiveDecision[],
  runId: string | number | null,
  asOfTimestamp?: string | number | Date | null,
): BullpenQuestionRow[] {
  return buildHistoricalStageTwoEventsSummaryRows({
    reviewedRows,
    decisions,
    runId,
    asOfTimestamp,
  });
}

export function buildStageTwoActivePositionQuestionIds({
  rows,
  activePositions,
}: {
  rows: BullpenQuestionRow[];
  activePositions: BullpenActivePositionView[];
}) {
  const activeQuestionIds = new Set<string>();
  const unmatchedRows = [...rows];

  activePositions
    .filter(isActiveBullpenPosition)
    .forEach((position) => {
      const result = BullpenEventIdentityResolver.resolveMatch({
        target: buildBullpenEventIdentityFromPosition(position),
        candidates: unmatchedRows,
        getIdentity: BullpenEventIdentityResolver.fromQuestion,
      });
      const matchedRow =
        result.status === "matched" ? (result.match?.item ?? null) : null;
      if (!matchedRow) return;

      activeQuestionIds.add(matchedRow.id);
      const matchedIndex = unmatchedRows.findIndex(
        (row) => row.id === matchedRow.id,
      );
      if (matchedIndex >= 0) unmatchedRows.splice(matchedIndex, 1);
    });

  return activeQuestionIds;
}

export function formatStageTwoSummaryMessage({
  completed,
  partial,
  failed,
}: {
  completed: number;
  partial: number;
  failed: number;
}) {
  if (partial <= 0 && failed <= 0) return null;

  const fragments = [
    `${completed} completed`,
    `${partial} partial`,
    `${failed} failed`,
  ].filter((fragment) => !fragment.startsWith("0 "));

  if (fragments.length === 0) return null;
  if (fragments.length === 1) return `Partial results: ${fragments[0]}.`;
  if (fragments.length === 2) {
    return `Partial results: ${fragments[0]} and ${fragments[1]}.`;
  }
  return `Partial results: ${fragments[0]}, ${fragments[1]} and ${fragments[2]}.`;
}

export function groupStageTwoLlmRowsByModel(
  rows: ReturnType<typeof getStageTwoLlmTableRows>,
) {
  const groups = new Map<
    string,
    {
      key: string;
      label: string;
      rows: typeof rows;
      sourceTimestamp: string | null;
      cost: number | null;
    }
  >();

  rows.forEach((row) => {
    const provider = row.provider || "—";
    const model = row.model || "—";
    const key = `${provider}::${model}`;
    const existing = groups.get(key);
    if (existing) {
      existing.rows.push(row);
      existing.sourceTimestamp =
        existing.sourceTimestamp ?? row.sourceTimestamp;
      const rowCost = readStageTwoLlmOutputCost(row.output);
      existing.cost =
        rowCost === null ? existing.cost : (existing.cost ?? 0) + rowCost;
      return;
    }
    groups.set(key, {
      key,
      label: provider === "—" ? model : `${provider} · ${model}`,
      rows: [row],
      sourceTimestamp: row.sourceTimestamp,
      cost: readStageTwoLlmOutputCost(row.output),
    });
  });

  return [...groups.values()].sort(
    (left, right) => (right.cost ?? 0) - (left.cost ?? 0),
  );
}

export function readStageTwoLlmOutputCost(output: Record<string, unknown> | null) {
  return (
    readLlmContextNumber(output, "estimated_cost") ??
    readLlmContextNumber(output, "cost") ??
    readLlmContextNumber(output, "cost_usd")
  );
}

export const STAGE_TWO_LLM_IDENTITY_ERROR =
  "Data integrity error: Stage 2 recorded an LLM target execution without a provider/model identity.";

export type StageTwoLlmRunSummaryRow = {
  key: string;
  provider: string;
  model: string;
  displayModel: string;
  requestedModel: string | null;
  status: StageTwoRunSummaryStatus;
  runtime: string;
  cost: number | null;
  error: string | null;
  failureCategory: string | null;
  firstError: Record<string, unknown> | null;
  lastError: Record<string, unknown> | null;
  batchErrors: Record<string, unknown>[];
  failedEventCount: number | null;
  invalidEventCount: number | null;
  blockedEventCount: number | null;
  retryRequestCount: number | null;
  recoveryBatchCount: number | null;
};

export type StageTwoLlmFailureDialogRow = StageTwoLlmRunSummaryRow;

export function formatStageTwoRuntimeSeconds(value: number | null) {
  if (value === null) return "—";
  const safeSeconds = Math.max(0, Math.round(value));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function getStageTwoLlmRunSummaryRows(
  stage: WorkflowStageView,
  groups: ReturnType<typeof groupStageTwoLlmRowsByModel>,
  nowMs = Date.now(),
): StageTwoLlmRunSummaryRow[] {
  const groupCostByKey = new Map<string, number | null>();
  groups.forEach((group) => {
    const costs = group.rows
      .map((row) => readStageTwoLlmOutputCost(row.output))
      .filter((value): value is number => value !== null);
    groupCostByKey.set(
      group.key,
      costs.length ? costs.reduce((total, value) => total + value, 0) : null,
    );
  });

  const targetRuns = getStageTwoLlmTargetRuns(stage);
  if (targetRuns.length) {
    const targetRunTotals = new Map<string, number>();
    targetRuns.forEach((run) => {
      const identity = readStageTwoLlmIdentity(run);
      const provider = identity?.provider ?? "—";
      const model = identity?.model ?? "—";
      const key = `${provider}::${model}`;
      targetRunTotals.set(key, (targetRunTotals.get(key) ?? 0) + 1);
    });
    const targetRunDisplayCounts = new Map<string, number>();
    const runRows = targetRuns.map((run, index) => {
      const identity = readStageTwoLlmIdentity(run);
      const provider = identity?.provider ?? "—";
      const model = identity?.model ?? "—";
      const key = `${provider}::${model}`;
      const duplicateIndex = (targetRunDisplayCounts.get(key) ?? 0) + 1;
      targetRunDisplayCounts.set(key, duplicateIndex);
      const rawStatus = normalizeStageTwoRunStatus(readLlmContextString(run, "status"));
      const status = identity ? rawStatus : "failed";
      return {
        key: `${key}-${index}`,
        provider,
        model,
        displayModel:
          (targetRunTotals.get(key) ?? 0) > 1
            ? `${model} ${duplicateIndex}`
            : model,
        requestedModel:
          readLlmContextString(run, "requested_model") ?? (identity ? model : null),
        status,
        runtime: (() => {
          const elapsedSeconds = readLlmContextNumber(run, "elapsed_seconds");
          if (status === "running" || status === "pending") {
            const startedAt =
              readLlmContextString(run, "started_at") ??
              readLlmContextString(run, "created_at") ??
              stage.timerStartedAt;
            return formatStageElapsedTime(startedAt, null, nowMs);
          }
          return formatStageTwoRuntimeSeconds(elapsedSeconds);
        })(),
        cost:
          readLlmContextNumber(run, "estimated_cost") ??
          readLlmContextNumber(run, "cost") ??
          groupCostByKey.get(key) ??
          null,
        error:
          (!identity ? STAGE_TWO_LLM_IDENTITY_ERROR : null) ??
          readLlmContextString(run, "error") ??
          readLlmContextString(run, "error_summary") ??
          readLlmContextString(
            readLlmContextRecord(run, "first_error"),
            "safe_message",
          ) ??
          readLlmContextString(run, "message") ??
          null,
        failureCategory:
          (!identity ? "data_integrity_error" : null) ??
          readLlmContextString(run, "failure_category") ??
          readLlmContextString(
            readLlmContextRecord(run, "first_error"),
            "execution_phase",
          ) ??
          null,
        firstError: readLlmContextRecord(run, "first_error"),
        lastError: readLlmContextRecord(run, "last_error"),
        batchErrors:
          readLlmContextArray(run, "batch_errors").filter(
            (item): item is Record<string, unknown> =>
              Boolean(item) && typeof item === "object",
          ) ?? [],
        failedEventCount: readLlmContextNumber(run, "failed_event_count"),
        invalidEventCount: readLlmContextNumber(run, "invalid_event_count"),
        blockedEventCount: readLlmContextNumber(run, "blocked_event_count"),
        retryRequestCount: readLlmContextNumber(run, "retry_request_count"),
        recoveryBatchCount: readLlmContextNumber(run, "recovery_batch_count"),
      };
    });
    const runCountsByKey = new Map<string, number>();
    runRows.forEach((row) => {
      if (row.provider === "—") return;
      const model = row.requestedModel ?? row.model;
      if (!model) return;
      const key = `${row.provider}::${model}`;
      runCountsByKey.set(key, (runCountsByKey.get(key) ?? 0) + 1);
    });
    const pendingTargets: Record<string, unknown>[] = [];
    const targetCountsByKey = new Map<string, number>();
    getStageTwoLlmTargets(stage).forEach((target) => {
      const identity = readStageTwoLlmIdentity(target);
      if (!identity) {
        pendingTargets.push(target);
        return;
      }
      const key = `${identity.provider}::${identity.model}`;
      const nextSeen = (targetCountsByKey.get(key) ?? 0) + 1;
      targetCountsByKey.set(key, nextSeen);
      if (nextSeen > (runCountsByKey.get(key) ?? 0)) pendingTargets.push(target);
    });
    const pendingDisplayCounts = new Map<string, number>(runCountsByKey);
    const pendingRunRows = pendingTargets.map((target, index) => {
      const identity = readStageTwoLlmIdentity(target);
      const provider = identity?.provider ?? "—";
      const model = identity?.model ?? "—";
      const isIntegrityFailure = !identity;
      const key = `${provider}::${model}`;
      const duplicateIndex = (pendingDisplayCounts.get(key) ?? 0) + 1;
      pendingDisplayCounts.set(key, duplicateIndex);
      const duplicateTotal = Math.max(
        targetCountsByKey.get(key) ?? 0,
        runCountsByKey.get(key) ?? 0,
      );
      return {
        key: `${provider}::${model}-pending-${index}`,
        provider,
        model,
        displayModel: duplicateTotal > 1 ? `${model} ${duplicateIndex}` : model,
        requestedModel: identity?.model ?? null,
        status: isIntegrityFailure
          ? ("failed" as StageTwoRunSummaryStatus)
          : ("pending" as StageTwoRunSummaryStatus),
        runtime: formatStageElapsedTime(stage.timerStartedAt, null, nowMs),
        cost: null,
        error: !identity ? STAGE_TWO_LLM_IDENTITY_ERROR : null,
        failureCategory: !identity ? "data_integrity_error" : null,
        firstError: null,
        lastError: null,
        batchErrors: [],
        failedEventCount: null,
        invalidEventCount: null,
        blockedEventCount: null,
        retryRequestCount: null,
        recoveryBatchCount: null,
      };
    });
    return [...runRows, ...pendingRunRows].sort(
      (left, right) => (right.cost ?? 0) - (left.cost ?? 0),
    );
  }

  const knownKeys = new Set(groups.map((group) => group.key));
  const pendingTargets = getStageTwoLlmTargets(stage).filter((target) => {
    const identity = readStageTwoLlmIdentity(target);
    if (!identity) return true;
    return !knownKeys.has(`${identity.provider}::${identity.model}`);
  });
  const pendingTargetTotals = new Map<string, number>();
  pendingTargets.forEach((target) => {
    const identity = readStageTwoLlmIdentity(target);
    const provider = identity?.provider ?? "—";
    const model = identity?.model ?? "—";
    const key = `${provider}::${model}`;
    pendingTargetTotals.set(key, (pendingTargetTotals.get(key) ?? 0) + 1);
  });
  const pendingDisplayCounts = new Map<string, number>();
  const pendingRows = pendingTargets.map((target, index) => {
    const identity = readStageTwoLlmIdentity(target);
    const provider = identity?.provider ?? "—";
    const model = identity?.model ?? "—";
    const key = `${provider}::${model}`;
    const duplicateIndex = (pendingDisplayCounts.get(key) ?? 0) + 1;
    pendingDisplayCounts.set(key, duplicateIndex);
    return {
      key: `${provider}::${model}-pending-${index}`,
      provider,
      model,
      displayModel:
        (pendingTargetTotals.get(key) ?? 0) > 1
          ? `${model} ${duplicateIndex}`
          : model,
      requestedModel: identity?.model ?? null,
      status:
        !identity
          ? ("failed" as StageTwoRunSummaryStatus)
          : ("pending" as StageTwoRunSummaryStatus),
      runtime: formatStageElapsedTime(stage.timerStartedAt, null, nowMs),
      cost: null,
      error: !identity ? STAGE_TWO_LLM_IDENTITY_ERROR : null,
      failureCategory: !identity ? "data_integrity_error" : null,
      firstError: null,
      lastError: null,
      batchErrors: [],
      failedEventCount: null,
      invalidEventCount: null,
      blockedEventCount: null,
      retryRequestCount: null,
      recoveryBatchCount: null,
    };
  });

  return [
    ...groups.map((group) => ({
      key: group.key,
      provider: group.rows[0]?.provider ?? "—",
      model: group.rows[0]?.model ?? group.label,
      displayModel: group.rows[0]?.model ?? group.label,
      requestedModel: group.rows[0]?.model ?? group.label,
      status:
        group.rows[0]?.provider === "—" || group.rows[0]?.model === "—"
          ? ("failed" as StageTwoRunSummaryStatus)
          : ("completed" as StageTwoRunSummaryStatus),
      runtime: "—",
      cost: groupCostByKey.get(group.key) ?? null,
      error:
        group.rows[0]?.provider === "—" || group.rows[0]?.model === "—"
          ? STAGE_TWO_LLM_IDENTITY_ERROR
          : readLlmContextString(
              group.rows.find((row) => readLlmContextString(row.output, "error"))
                ?.output ?? null,
              "error",
            ),
      failureCategory:
        group.rows[0]?.provider === "—" || group.rows[0]?.model === "—"
          ? "data_integrity_error"
          : null,
      firstError: null,
      lastError: null,
      batchErrors: [],
      failedEventCount: null,
      invalidEventCount: null,
      blockedEventCount: null,
      retryRequestCount: null,
      recoveryBatchCount: null,
    })),
    ...pendingRows,
  ].sort((left, right) => (right.cost ?? 0) - (left.cost ?? 0));
}

export function getStageTwoLlmFailureFixAdvice(row: StageTwoLlmFailureDialogRow) {
  const error = (row.error ?? "").toLowerCase();
  const provider = row.provider.toLowerCase();

  if (
    /api key|authentication|unauthorized|permission|credential|token/.test(
      error,
    )
  ) {
    return `Check the ${row.provider} API key/credentials in the backend environment, restart investor-backend and investor-celery-worker, then rerun Stage 2.`;
  }
  if (/rate limit|quota|429|resource exhausted|too many requests/.test(error)) {
    return `Reduce ${row.provider} concurrency or selected models, wait for quota to recover, verify billing/quota, then rerun this LLM.`;
  }
  if (
    /timeout|timed out|deadline|network|fetch failed|connection|econnreset/.test(
      error,
    )
  ) {
    return `Check provider connectivity from the worker, increase/retry-safe task timeout if needed, and rerun after the network/provider stabilizes.`;
  }
  if (/json|parse|schema|invalid|malformed|unusable/.test(error)) {
    return `Review the Stage 2 prompt/schema instructions for ${row.model}, keep the model response JSON-only, and rerun this model.`;
  }
  if (provider.includes("gemini")) {
    return "Verify Gemini model availability, API key, quota, and safety/block settings before rerunning this Gemini target.";
  }
  if (provider.includes("openai")) {
    return "Verify OpenAI model access, API key, project billing/quota, and request limits before rerunning this OpenAI target.";
  }
  if (provider.includes("deepseek")) {
    return "Verify Deepseek API key, model availability, account credits/quota, and request limits before rerunning this Deepseek target.";
  }
  return "Open backend/Celery logs for the exact traceback, fix the provider/configuration issue, then rerun Stage 2 for this model.";
}

export function StageTwoLlmFailureDialog({
  row,
  onClose,
}: {
  row: StageTwoLlmFailureDialogRow;
  onClose: () => void;
}) {
  const errorMessage =
    row.error || "No safe provider error was captured for this target.";
  const diagnosticJson = JSON.stringify(
    {
      provider: row.provider,
      requested_model: row.requestedModel,
      actual_model: row.model,
      failure_category: row.failureCategory,
      first_error: row.firstError,
      last_error: row.lastError,
      batch_errors: row.batchErrors,
    },
    null,
    2,
  );
  const diagnostics = [
    ["Runtime", row.runtime],
    ["Cost", formatUsdCost(row.cost)],
    ["Failure category", row.failureCategory ?? "—"],
    ["Requested model", row.requestedModel ?? "—"],
    ["Actual model", row.model],
    ["Failed events", row.failedEventCount?.toLocaleString("en-IN") ?? "—"],
    ["Invalid events", row.invalidEventCount?.toLocaleString("en-IN") ?? "—"],
    ["Blocked events", row.blockedEventCount?.toLocaleString("en-IN") ?? "—"],
    ["Retry requests", row.retryRequestCount?.toLocaleString("en-IN") ?? "—"],
    [
      "Recovery batches",
      row.recoveryBatchCount?.toLocaleString("en-IN") ?? "—",
    ],
  ];

  return (
    <div className="fixed inset-0 z-[170] flex items-center justify-center bg-slate-950/50 p-4">
      <div className="w-full max-w-2xl overflow-hidden rounded-3xl border border-red-200 bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-red-100 bg-red-50 px-6 py-5">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.22em] text-red-600">
              LLM failure details
            </p>
            <h3 className="mt-1 text-xl font-extrabold text-slate-950">
              {row.provider} · {row.model}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-red-200 bg-white text-red-600 transition hover:bg-red-100"
            aria-label="Close LLM failure details"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-5 px-6 py-5">
          <section>
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">
              Why it failed / error
            </p>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-2xl border border-red-100 bg-red-50 p-4 text-sm font-semibold text-red-800">
              {errorMessage}
            </pre>
          </section>
          <section>
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">
              What to do to fix it
            </p>
            <p className="mt-2 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-900">
              {getStageTwoLlmFailureFixAdvice(row)}
            </p>
          </section>
          <section>
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">
              Run diagnostics
            </p>
            <dl className="mt-2 grid gap-2 sm:grid-cols-2">
              {diagnostics.map(([label, value]) => (
                <div
                  key={label}
                  className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3"
                >
                  <dt className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
                    {label}
                  </dt>
                  <dd className="mt-1 font-mono text-sm font-bold text-slate-900">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
          <section>
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">
              Copyable diagnostic JSON
            </p>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs leading-5 text-slate-800">
              {diagnosticJson}
            </pre>
          </section>
        </div>
      </div>
    </div>
  );
}

export function getStageTwoRunSummaryStatusClass(status: StageTwoRunSummaryStatus) {
  if (status === "completed")
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "partial") return "border-sky-200 bg-sky-50 text-sky-700";
  if (status === "running")
    return "border-amber-200 bg-amber-50 text-amber-700";
  if (status === "pending")
    return "border-slate-200 bg-slate-50 text-slate-600";
  return "border-red-200 bg-red-50 text-red-700";
}

export function getStageTwoRunSummaryStatusLabel(status: StageTwoRunSummaryStatus) {
  if (status === "completed") return "Completed";
  if (status === "partial") return "Partial";
  if (status === "running") return "Running";
  if (status === "pending") return "Pending";
  return "Failed";
}

export function StageTwoLlmRunDetailsDialog({
  state,
  activePositions = [],
  onClose,
}: {
  state: StageTwoLlmRunDialogState;
  activePositions?: BullpenActivePositionView[];
  onClose: () => void;
}) {
  const [breakupKind, setBreakupKind] =
    useState<StageTwoLlmRunBreakupKind | null>(null);
  const [decisionDialog, setDecisionDialog] = useState<{
    mode: StageTwoDecisionDialogMode;
    state: StageTwoDecisionDialogState;
  } | null>(null);
  const [eventInputDialog, setEventInputDialog] =
    useState<StageTwoLlmEventInputDialogState | null>(null);
  const [stageTwoPromptDialogOpen, setStageTwoPromptDialogOpen] =
    useState(false);
  const [selectedFailureRow, setSelectedFailureRow] =
    useState<StageTwoLlmFailureDialogRow | null>(null);
  const [eventsSummarySortState, setEventsSummarySortState] =
    useState<BullpenTableSortState>({
      key: "returnsPerDay",
      direction: "desc",
    });
  const [dialogNowMs, setDialogNowMs] = useState(() => Date.now());
  const [isReturnsPerDayFormulaDialogOpen, setIsReturnsPerDayFormulaDialogOpen] =
    useState(false);
  const [returnsPerDayQuestion, setReturnsPerDayQuestion] =
    useState<BullpenQuestionRow | null>(null);
  const llmOutputGroupRefs = useRef(new Map<string, HTMLElement>());
  const stats = getStageTwoStats(state.stage, state.decisions, state.run);
  const overlapCount = Math.max(
    0,
    stats.activePositions + stats.newOpportunities - stats.llmRanOn,
  );
  const workflowView = state.run ? buildBullpenAutoRunWorkflowView(state.run) : null;
  const scanWorkflowStage =
    workflowView?.stages.find((workflowStage) => workflowStage.key === "scan") ?? null;
  const scanCandidates = scanWorkflowStage?.scanCandidates ?? [];
  const scanStageResult = getRunWorkflowStageResult(state.run, "scan", 1);
  const llmStageResult = getRunWorkflowStageResult(state.run, "llm", 2);
  const reviewedRows = getStageTwoLlmReviewedRows(
    state.stage,
    scanCandidates,
    state.decisions,
  );
  const eventsSummaryAsOfTimestamp = resolveStageTwoHistoricalAsOfTimestamp({
    reviewedRows,
    scanCompletedAt:
      scanStageResult?.completed_at ?? scanWorkflowStage?.timerCompletedAt ?? null,
    stageCompletedAt: llmStageResult?.completed_at ?? state.stage.timerCompletedAt,
    runStartedAt: state.run?.started_at ?? state.stage.timerStartedAt,
    runCompletedAt: state.run?.completed_at ?? null,
    nowMs: dialogNowMs,
  });
  const llmTableRows = getStageTwoLlmTableRows(
    state,
    eventsSummaryAsOfTimestamp,
  );
  const eventsSummaryRows = buildStageTwoEventsSummaryRows(
    reviewedRows,
    state.decisions,
    state.run?.id ?? null,
    eventsSummaryAsOfTimestamp,
  );
  const activePositionQuestionIds = buildStageTwoActivePositionQuestionIds({
    rows: eventsSummaryRows,
    activePositions,
  });
  const availableLlmDecisionRows = llmTableRows.filter(
    (row) => row.output && !readLlmContextString(row.output, "error"),
  );
  const llmModelGroups = groupStageTwoLlmRowsByModel(llmTableRows);
  const retainedSummaryRows = getStageTwoLlmRunSummaryRows(
    state.stage,
    llmModelGroups,
    dialogNowMs,
  );
  const identifiedRetainedSummaryRows = retainedSummaryRows.filter(
    (row) => row.provider !== "—" && row.model !== "—",
  );
  const savedTargets = state.run?.stage2_llm_targets_snapshot ?? [];
  const summaryRows: StageTwoLlmRunSummaryRow[] =
    identifiedRetainedSummaryRows.length > 0
      ? identifiedRetainedSummaryRows
      : savedTargets.map((target, index) => ({
          key: `${target.provider}::${target.model}::recovered-${index}`,
          provider: target.provider,
          model: target.model,
          displayModel: target.model,
          requestedModel: target.model,
          status:
            index < stats.llmsPassed
              ? "completed"
              : index < stats.llmsPassed + stats.llmsFailed
                ? "failed"
                : state.stage.state === "finished"
                  ? "completed"
                  : "pending",
          runtime: "—",
          cost: null,
          error: null,
          failureCategory: null,
          firstError: null,
          lastError: null,
          batchErrors: [],
          failedEventCount: null,
          invalidEventCount: null,
          blockedEventCount: null,
          retryRequestCount: null,
          recoveryBatchCount: null,
        }));
  const completedSummaryCount = summaryRows.filter(
    (row) => row.status === "completed",
  ).length;
  const partialSummaryCount = summaryRows.filter(
    (row) => row.status === "partial",
  ).length;
  const failedSummaryCount = summaryRows.filter(
    (row) => row.status === "failed",
  ).length;
  const runningSummaryCount = summaryRows.filter(
    (row) => row.status === "running",
  ).length;
  const explicitPendingSummaryCount = summaryRows.filter(
    (row) => row.status === "pending",
  ).length;
  const returnedSummaryCount =
    completedSummaryCount + partialSummaryCount + failedSummaryCount;
  const pendingSummaryCount = Math.max(
    explicitPendingSummaryCount,
    stats.llmsSelected - returnedSummaryCount,
  );
  const eventsSummaryUpdatedAt = resolveStageTwoEventsSummaryUpdatedAt({
    reviewedRows,
    stageCompletedAt: llmStageResult?.completed_at ?? state.stage.timerCompletedAt,
    scanCompletedAt:
      scanStageResult?.completed_at ?? scanWorkflowStage?.timerCompletedAt ?? null,
  });
  const eventsSummaryStatusMessage = formatStageTwoSummaryMessage({
    completed: completedSummaryCount,
    partial: partialSummaryCount,
    failed: failedSummaryCount,
  });
  const eventsSummaryUpdateUnavailableReason =
    eventsSummaryUpdatedAt
      ? undefined
      : runningSummaryCount > 0 || pendingSummaryCount > 0
      ? "Timestamp unavailable while Stage 2 results are still being fetched."
      : failedSummaryCount > 0 && completedSummaryCount === 0
        ? "Timestamp unavailable because Stage 2 did not return any completed model results."
        : "Timestamp was not included in this Stage 2 result.";
  const cumulativeCost = summaryRows.reduce(
    (total, row) => total + (row.cost ?? 0),
    0,
  );
  const stageRuntime = formatStageElapsedTime(
    state.stage.timerStartedAt,
    state.stage.timerCompletedAt,
    Date.parse(
      state.run?.completed_at ??
        state.run?.started_at ??
        state.stage.timerCompletedAt ??
        state.stage.timerStartedAt ??
        "",
    ) || 0,
  );
  const stageTwoPromptContext =
    llmTableRows.find((row) => row.row)?.row ?? null;
  const stagePromptTemplate = getStageTwoRunPromptTemplate(state.stage);
  const shouldTickDialogTimers = summaryRows.some(
    (row) => row.status === "running" || row.status === "pending",
  );

  useEffect(() => {
    if (!shouldTickDialogTimers) return;
    const intervalId = window.setInterval(
      () => setDialogNowMs(Date.now()),
      RUN_TIMER_INTERVAL_MS,
    );
    return () => window.clearInterval(intervalId);
  }, [shouldTickDialogTimers]);

  const handleEventsSummarySortChange = (key: BullpenTableSortKey) => {
    setEventsSummarySortState((current) => ({
      key,
      direction:
        current.key === key && current.direction === "desc" ? "asc" : "desc",
    }));
  };

  const scrollToLlmOutputGroup = (row: StageTwoLlmRunSummaryRow) => {
    const groupKey = `${row.provider}::${row.requestedModel ?? row.model}`;
    llmOutputGroupRefs.current.get(groupKey)?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };

  const unknownStageEvidence = !state.run && !state.stage.timerStartedAt && Object.keys(state.stage.outputs).length === 0;
  const diagnosticsReturnFocus = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  useEffect(() => {
    if (!unknownStageEvidence) return;
    const target = diagnosticsReturnFocus.current;
    return () => target?.focus();
  }, [unknownStageEvidence]);

  if (unknownStageEvidence) {
    return (
      <div data-testid="stage-two-llm-run-dialog" role="dialog" aria-modal="true" aria-label="Stage 2 LLM diagnostics" onKeyDown={(event) => { if (event.key === "Escape") onClose(); if (event.key === "Tab") event.preventDefault(); }} className="fixed inset-0 z-[150] flex items-center justify-center bg-slate-950/60 p-4">
        <div className="w-full max-w-xl rounded-3xl border border-slate-200 bg-white p-6 text-slate-950 shadow-xl">
          <h2 className="text-xl font-semibold">Stage 2 evidence unknown</h2>
          <p className="mt-3 text-sm">No saved run or stage evidence is available. LLM row counts, completion, runtime and position counts are unknown.</p>
          <p className="mt-2 text-xs text-slate-600">Source unavailable · observation age unknown. This view does not start or retry work.</p>
          <Button autoFocus className="mt-4" onClick={onClose} aria-label="Close LLM run details">Close</Button>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="stage-two-llm-run-dialog"
      className="fixed inset-0 z-[150] flex items-center justify-center bg-slate-950/60 p-4"
    >
      <div className="flex max-h-[92vh] w-[calc(100vw-2rem)] max-w-[1500px] flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.55)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
              Stage 2 LLM Run
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold text-slate-950">
                LLM ran on {stats.llmRanOn} unique rows
              </h2>
              <button
                type="button"
                onClick={() => setStageTwoPromptDialogOpen(true)}
                className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-violet-200 bg-violet-50 text-violet-700 transition hover:border-violet-300 hover:bg-violet-100"
                aria-label="Open Stage 2 input prompt"
                title="Show Stage 2 input prompt"
              >
                <Info className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close LLM run details"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div
          data-testid="stage-two-llm-run-dialog-body"
          className="flex-1 overflow-y-auto overflow-x-hidden px-6 py-5"
        >
          <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                  Last Run Summary
                </p>
                <h4 className="mt-2 text-lg font-extrabold text-slate-950">
                  Bullpen AI Run {state.run ? `#${state.run.id}` : "latest"} ·{" "}
                  {formatIstDateTime(
                    state.run?.started_at ?? state.stage.timerStartedAt,
                  )}
                  <span className="block text-sm font-semibold text-slate-600 sm:ml-2 sm:inline">
                    LLM progress: {returnedSummaryCount}/
                    {stats.llmsSelected || summaryRows.length} returned
                    {runningSummaryCount
                      ? ` · ${runningSummaryCount} running`
                      : ""}
                    {stageRuntime ? ` · Runtime: ${stageRuntime}` : ""}
                  </span>
                </h4>
              </div>
              <div className="grid grid-cols-4 gap-2 text-center text-xs font-bold uppercase tracking-[0.14em]">
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-5 py-3 text-emerald-700">
                  <span className="block text-xl">{completedSummaryCount}</span>
                  Completed
                </div>
                <div className="rounded-2xl border border-sky-200 bg-sky-50 px-5 py-3 text-sky-700">
                  <span className="block text-xl">{partialSummaryCount}</span>
                  Partial
                </div>
                <div className="rounded-2xl border border-red-200 bg-red-50 px-5 py-3 text-red-700">
                  <span className="block text-xl">{failedSummaryCount}</span>
                  Failed
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-5 py-3 text-slate-600">
                  <span className="block text-xl">{pendingSummaryCount}</span>
                  Pending
                </div>
              </div>
            </div>
            {cumulativeCost > 0 ? (
              <p className="mt-2 text-sm font-semibold text-slate-600">
                Cumulative cost: {formatUsdCost(cumulativeCost)}
              </p>
            ) : null}
            <div className="mt-4 overflow-hidden rounded-2xl border border-slate-200 bg-white">
              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-slate-50 text-[11px] uppercase tracking-[0.14em] text-slate-500">
                    <tr>
                      <th className="px-4 py-3 font-bold">Provider</th>
                      <th className="px-4 py-3 font-bold">Model</th>
                      <th className="px-4 py-3 font-bold">Status</th>
                      <th className="px-4 py-3 font-bold">Runtime</th>
                      <th className="px-4 py-3 font-bold">Cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {summaryRows.length ? (
                      summaryRows.map((row) => (
                        <tr
                          key={`stage-two-summary-${row.key}`}
                          onClick={() => scrollToLlmOutputGroup(row)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              scrollToLlmOutputGroup(row);
                            }
                          }}
                          tabIndex={0}
                          role="button"
                          className="cursor-pointer bg-white transition hover:bg-amber-50/50 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-amber-300"
                          aria-label={`Show LLM-wise output for ${row.provider} ${row.model}`}
                        >
                          <td className="px-4 py-3 font-bold capitalize text-slate-900">
                            {row.provider}
                          </td>
                          <td className="px-4 py-3 font-semibold text-slate-700">
                            {row.displayModel}
                          </td>
                          <td className="px-4 py-3">
                            {row.status === "failed" ? (
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setSelectedFailureRow(row);
                                }}
                                className={`rounded-full border px-2.5 py-1 text-xs font-bold transition hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-red-300 ${getStageTwoRunSummaryStatusClass(row.status)}`}
                                aria-label={`Open failure details for ${row.provider} ${row.model}`}
                                title="Click to see why this LLM failed"
                              >
                                {getStageTwoRunSummaryStatusLabel(row.status)}
                              </button>
                            ) : (
                              <span
                                className={`rounded-full border px-2.5 py-1 text-xs font-bold ${getStageTwoRunSummaryStatusClass(row.status)}`}
                              >
                                {getStageTwoRunSummaryStatusLabel(row.status)}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 font-mono text-xs text-slate-600">
                            {row.runtime}
                          </td>
                          <td className="px-4 py-3 font-bold text-slate-700">
                            {formatUsdCost(row.cost)}
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td
                          colSpan={5}
                          className="px-4 py-6 text-center text-sm text-slate-500"
                        >
                          No model-level summary was returned for this Stage 2
                          run.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            <div data-testid="stage-two-events-summary" className="mt-5">
              <BullpenQuestionsTable
                snapshot={null}
                rowsOverride={eventsSummaryRows}
                activePositionQuestionIds={activePositionQuestionIds}
                emptyMessage="No Events Summary rows were returned for this Stage 2 run."
                headerContent={null}
                updatedAt={eventsSummaryUpdatedAt}
                updateStatusMessage={eventsSummaryStatusMessage ?? undefined}
                updateUnavailableReason={eventsSummaryUpdateUnavailableReason}
                scrollResetKey={state.run?.id ?? "stage-two-llm-run"}
                isLoading={false}
                onSortChange={handleEventsSummarySortChange}
                selectedQuestionIds={new Set<string>()}
                selectionEnabled={false}
                sortState={eventsSummarySortState}
                onToggleQuestion={() => undefined}
                onToggleSelectAll={() => undefined}
                rowHighlightById={buildStageTwoEventsSummaryHighlightById({
                  rows: eventsSummaryRows,
                  stage: state.stage,
                  decisions: state.decisions,
                  includeEventExits: true,
                })}
              />
            </div>
          </section>

          {selectedFailureRow ? (
            <StageTwoLlmFailureDialog
              row={selectedFailureRow}
              onClose={() => setSelectedFailureRow(null)}
            />
          ) : null}

          <div className="mt-5 grid gap-3 md:grid-cols-4">
            {[
              {
                label: "Active positions",
                value: stats.activePositions,
                kind: "active-positions" as const,
              },
              {
                label: "New opportunities",
                value: stats.newOpportunities,
                kind: "new-opportunities" as const,
              },
              {
                label: "Overlap / de-duped",
                value: overlapCount,
                kind: "overlap" as const,
              },
              {
                label: "Unique LLM rows",
                value: stats.llmRanOn,
                kind: "unique-llm-rows" as const,
              },
            ].map((tile) => (
              <button
                key={tile.kind}
                type="button"
                onClick={() => setBreakupKind(tile.kind)}
                className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-left transition hover:-translate-y-0.5 hover:border-amber-200 hover:bg-white focus:outline-none focus:ring-2 focus:ring-amber-300"
                aria-label={`Open breakup details for ${tile.label}`}
              >
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                  {tile.label}
                </p>
                <p className="mt-2 text-2xl font-semibold tabular-nums text-slate-950">
                  {tile.value}
                </p>
              </button>
            ))}
          </div>
          <div className="mt-5 rounded-2xl border border-slate-200 bg-white">
            <div className="border-b border-slate-200 px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                LLM-wise output ({llmTableRows.length} rows)
              </p>
            </div>
            <div className="space-y-4 p-4">
              {llmModelGroups.length ? (
                llmModelGroups.map((group) => {
                  const promptContext =
                    group.rows.find((row) => row.row)?.row ?? null;
                  return (
                    <section
                      key={group.key}
                      ref={(element) => {
                        if (element) {
                          llmOutputGroupRefs.current.set(group.key, element);
                        } else {
                          llmOutputGroupRefs.current.delete(group.key);
                        }
                      }}
                      className="overflow-hidden rounded-2xl border border-slate-200 bg-white"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-600">
                              {group.label}
                            </p>
                            {group.sourceTimestamp ? (
                              <span
                                className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-semibold normal-case tracking-normal text-slate-500"
                                title="Timestamp for the LLM output values shown in this model table"
                              >
                                {formatIstDateTime(group.sourceTimestamp)}
                              </span>
                            ) : null}
                            <button
                              type="button"
                              onClick={() =>
                                setEventInputDialog({
                                  title: group.label,
                                  llmContext: promptContext,
                                })
                              }
                              className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-violet-200 bg-violet-50 text-violet-700 transition hover:border-violet-300 hover:bg-violet-100"
                              aria-label={`Open full prompt for ${group.label}`}
                              title="Show full prompt definition sent to this LLM model"
                            >
                              <Info className="h-3.5 w-3.5" />
                            </button>
                          </div>
                          <p className="mt-1 text-xs text-slate-500">
                            {group.rows.length} event/provider{" "}
                            {group.rows.length === 1 ? "row" : "rows"}
                            {group.cost !== null
                              ? ` · Cost: ${formatUsdCost(group.cost)}`
                              : ""}
                          </p>
                        </div>
                      </div>
                      <div className="overflow-auto">
                        <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
                          <thead className="bg-white text-[11px] uppercase tracking-[0.14em] text-slate-500">
                            <tr>
                              <th className="px-3 py-3">Event info</th>
                              <th className="px-3 py-3">S. No</th>
                              <th className="min-w-64 px-3 py-3">Question</th>
                              <th className="px-3 py-3">Closing time</th>
                              <th className="px-3 py-3">Days left</th>
                              <th className="px-3 py-3">Category</th>
                              <th className="px-3 py-3">Outcomes</th>
                              <th className="px-3 py-3">Current Yes odds %</th>
                              <th className="px-3 py-3">Current No odds %</th>
                              <th className="px-3 py-3">LLM Yes Odds</th>
                              <th className="px-3 py-3">LLM No Odds</th>
                              <th className="px-3 py-3">
                                <BullpenReturnsPerDayHeader
                                  onOpen={() => setIsReturnsPerDayFormulaDialogOpen(true)}
                                />
                              </th>
                              <th className="px-3 py-3">Action</th>
                              <th className="px-3 py-3">Risk</th>
                              <th className="min-w-80 px-3 py-3">
                                Summary / rationale
                              </th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 bg-white text-slate-700">
                            {group.rows.map((row) => {
                              const dialogState = row.decision
                                ? {
                                    decision: row.decision,
                                    llmContext: row.row,
                                  }
                                : null;
                              return (
                                <tr
                                  key={row.id}
                                  className="align-top hover:bg-amber-50/40"
                                >
                                  <td className="px-3 py-3">
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setEventInputDialog({
                                          title: row.title,
                                          llmContext: row.row,
                                        })
                                      }
                                      className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-sky-200 bg-sky-50 text-sky-700 transition hover:border-sky-300 hover:bg-sky-100"
                                      aria-label={`Open LLM input details for ${row.title}`}
                                      title="Show event input and common LLM prompt"
                                    >
                                      <Info className="h-3.5 w-3.5" />
                                    </button>
                                  </td>
                                  <td className="px-3 py-3 font-semibold tabular-nums text-slate-700">
                                    {row.serialNumber}
                                  </td>
                                  <td className="px-3 py-3 font-semibold text-slate-950">
                                    {row.question}
                                  </td>
                                  <td className="px-3 py-3 text-slate-600">
                                    {formatIstDateTime(row.closeTime)}
                                  </td>
                                  <td className="px-3 py-3 font-semibold tabular-nums text-slate-700">
                                    {row.daysLeft === null
                                      ? "—"
                                      : `${row.daysLeft}d`}
                                  </td>
                                  <td className="px-3 py-3 text-slate-600">
                                    {row.category}
                                  </td>
                                  <td className="px-3 py-3 text-slate-600">
                                    {row.outcomes}
                                  </td>
                                  <td className="px-3 py-3 font-semibold tabular-nums text-emerald-700">
                                    {formatOddsPercent(row.currentYesOdds)}
                                  </td>
                                  <td className="px-3 py-3 font-semibold tabular-nums text-rose-700">
                                    {formatOddsPercent(row.currentNoOdds)}
                                  </td>
                                  <td className="px-3 py-3 tabular-nums">
                                    <span
                                      className={getLlmOddsHighlightClass(
                                        row.yesOdds,
                                      )}
                                    >
                                      {formatOddsPercent(row.yesOdds)}
                                    </span>
                                  </td>
                                  <td className="px-3 py-3 tabular-nums">
                                    <span
                                      className={getLlmOddsHighlightClass(
                                        row.noOdds,
                                      )}
                                    >
                                      {formatOddsPercent(row.noOdds)}
                                    </span>
                                  </td>
                                  <td className="px-3 py-3 font-semibold tabular-nums text-slate-700">
                                    <BullpenReturnsPerDayValueButton
                                      disabled={row.returnsPerDay === null}
                                      onOpen={() => setReturnsPerDayQuestion(row.row as BullpenQuestionRow)}
                                      ariaLabel={`Show Returns/day calculation for ${row.question}`}
                                    >
                                      {formatReturnsPerDay(row.returnsPerDay)}
                                    </BullpenReturnsPerDayValueButton>
                                  </td>
                                  <td className="px-3 py-3">
                                    {dialogState ? (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setDecisionDialog({
                                            mode: "tag",
                                            state: dialogState,
                                          })
                                        }
                                        className="rounded-md underline decoration-slate-300 underline-offset-4 transition hover:text-sky-700"
                                        aria-label={`Explain action ${row.action} for ${row.title}`}
                                        title="Show reason and details behind this action tag"
                                      >
                                        {row.action}
                                      </button>
                                    ) : (
                                      row.action
                                    )}
                                  </td>
                                  <td className="px-3 py-3">
                                    {dialogState ? (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setDecisionDialog({
                                            mode: "tag",
                                            state: dialogState,
                                          })
                                        }
                                        className="rounded-md underline decoration-slate-300 underline-offset-4 transition hover:text-sky-700"
                                        aria-label={`Explain risk ${row.risk} for ${row.title}`}
                                        title="Show reason and details behind this risk tag"
                                      >
                                        {row.risk}
                                      </button>
                                    ) : (
                                      row.risk
                                    )}
                                  </td>
                                  <td className="px-3 py-3">
                                    <span className="font-semibold">
                                      {row.summary}
                                    </span>
                                    <br />
                                    <span className="text-slate-500">
                                      {row.rationale}
                                    </span>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </section>
                  );
                })
              ) : (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-3 py-6 text-center text-sm text-slate-500">
                  No LLM row-level output was returned for this run.
                </div>
              )}
            </div>
          </div>

          <div className="mt-5 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Indepth details (
              {state.decisions.length || availableLlmDecisionRows.length} decisions
              currently returned)
            </p>
            {state.decisions.length ? (
              state.decisions.map((decision) => {
                const llmContext = getStageTwoDecisionLlmContext(
                  state,
                  decision,
                );
                const dialogState = { decision, llmContext };
                return (
                  <article
                    key={decision.id}
                    className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-700"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <h3 className="font-semibold text-slate-950">
                        {decision.market_title}
                      </h3>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            setDecisionDialog({
                              mode: "llm-inputs",
                              state: dialogState,
                            })
                          }
                          className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-violet-200 bg-violet-50 text-violet-700 transition hover:border-violet-300 hover:bg-violet-100"
                          aria-label={`Open LLM prompt and inputs for ${decision.market_title}`}
                          title="Show LLM prompt and input packet"
                        >
                          <Bot className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setDecisionDialog({
                              mode: "tag",
                              state: dialogState,
                            })
                          }
                          className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700 transition hover:border-sky-200 hover:bg-sky-50 hover:text-sky-900"
                          aria-label={`Explain ${decision.decision} ${decision.risk_status} tag for ${decision.market_title}`}
                        >
                          {decision.decision} · {decision.risk_status}
                        </button>
                      </div>
                    </div>
                    <p className="mt-2 leading-6">
                      <span className="font-semibold">Summary:</span>{" "}
                      {decision.summary || decision.reason}
                    </p>
                    <p className="mt-2 leading-6">
                      <span className="font-semibold">Indepth details:</span>{" "}
                      {decision.rationale || decision.reason}
                    </p>
                  </article>
                );
              })
            ) : availableLlmDecisionRows.length ? (
              availableLlmDecisionRows.map((row) => (
                <article
                  key={`llm-decision-${row.id}`}
                  className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-700"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <h3 className="font-semibold text-slate-950">
                      {row.question}
                    </h3>
                    <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
                      {row.provider} · {row.model}
                    </span>
                  </div>
                  <p className="mt-2 leading-6">
                    <span className="font-semibold">Summary:</span>{" "}
                    {row.summary}
                  </p>
                  <p className="mt-2 leading-6">
                    <span className="font-semibold">Indepth details:</span>{" "}
                    {row.rationale}
                  </p>
                </article>
              ))
            ) : (
              <p className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                Decision rows are still loading or have not been returned yet
                for this run.
              </p>
            )}
          </div>
        </div>
      </div>
      {stageTwoPromptDialogOpen ? (
        <StageTwoInputPromptDialog
          llmContext={stageTwoPromptContext}
          promptTemplate={stagePromptTemplate}
          onClose={() => setStageTwoPromptDialogOpen(false)}
        />
      ) : null}
      {eventInputDialog ? (
        <StageTwoLlmEventInputDialog
          state={eventInputDialog}
          promptTemplate={stagePromptTemplate}
          onClose={() => setEventInputDialog(null)}
        />
      ) : null}
      {decisionDialog ? (
        <StageTwoDecisionDetailDialog
          mode={decisionDialog.mode}
          state={decisionDialog.state}
          promptTemplate={stagePromptTemplate}
          onClose={() => setDecisionDialog(null)}
        />
      ) : null}
      {breakupKind ? (
        <StageTwoLlmRunBreakupDialog
          kind={breakupKind}
          state={state}
          stats={stats}
          overlapCount={overlapCount}
          onClose={() => setBreakupKind(null)}
        />
      ) : null}
      {returnsPerDayQuestion ? (
        <BullpenInvestmentMathDialog
          focus="returnsPerDay"
          question={returnsPerDayQuestion}
          onClose={() => setReturnsPerDayQuestion(null)}
        />
      ) : null}
      {isReturnsPerDayFormulaDialogOpen ? (
        <BullpenReturnsPerDayFormulaDialog
          onClose={() => setIsReturnsPerDayFormulaDialogOpen(false)}
        />
      ) : null}
    </div>
  );
}

export function getStageTwoDecisionLlmContext(
  state: StageTwoLlmRunDialogState,
  decision: BullpenAutoLiveDecision,
) {
  const rows = Array.isArray(state.stage.outputs.llm_reviewed_candidates)
    ? state.stage.outputs.llm_reviewed_candidates
    : [];
  const decisionKeys = [
    decision.market_id,
    decision.slug ?? null,
    decision.market_url ?? null,
    decision.market_title,
  ]
    .map(getStageTwoBreakupMatchKey)
    .filter((key): key is string => Boolean(key));
  return (
    rows.find((row): row is Record<string, unknown> => {
      if (!row || typeof row !== "object") return false;
      const candidate = row as Record<string, unknown>;
      const rowKeys = [
        candidate.market_id,
        candidate.slug,
        candidate.market_url,
        candidate.question,
      ]
        .map((value) =>
          getStageTwoBreakupMatchKey(typeof value === "string" ? value : null),
        )
        .filter((key): key is string => Boolean(key));
      return rowKeys.some((key) => decisionKeys.includes(key));
    }) ?? null
  );
}

export function hasReturnedValue(value: unknown) {
  return value !== undefined && value !== null && value !== "";
}

export function formatJsonForDisplay(value: unknown) {
  if (!hasReturnedValue(value)) return "Not returned for this run.";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function readNestedRecord(
  value: unknown,
  keys: string[],
): Record<string, unknown> | null {
  let cursor = value;
  for (const key of keys) {
    if (!isRecord(cursor)) return null;
    cursor = cursor[key];
  }
  return isRecord(cursor) ? cursor : null;
}

export function readFirstReturnedValue(...values: unknown[]) {
  return values.find(hasReturnedValue);
}

export function getStageTwoRunPromptTemplate(
  stage: WorkflowStageView | null | undefined,
) {
  return readFirstReturnedValue(stage?.outputs?.llm_prompt_template);
}

export function getStageTwoDisplayedPrompt(
  llmContext: Record<string, unknown> | null,
  promptTemplate: unknown,
) {
  return readFirstReturnedValue(llmContext?.llm_prompt, promptTemplate);
}

export function getStageTwoLlmPromptInputs(
  llmContext: Record<string, unknown> | null,
) {
  return readFirstReturnedValue(
    llmContext?.llm_prompt_inputs,
    llmContext?.prompt_inputs,
  );
}

export function getStageTwoLlmPromptInputMarket(
  llmContext: Record<string, unknown> | null,
) {
  return readNestedRecord(getStageTwoLlmPromptInputs(llmContext), ["market"]);
}

export function getStageTwoLlmPromptInputEvidencePacket(
  llmContext: Record<string, unknown> | null,
) {
  return readFirstReturnedValue(
    llmContext?.evidence_packet,
    readNestedRecord(getStageTwoLlmPromptInputs(llmContext), [
      "evidence_packet",
    ]),
  );
}

export function getStageTwoLlmMissingValueReason(
  label: string,
  primaryValue: unknown,
  fallbackValue?: unknown,
) {
  if (hasReturnedValue(primaryValue)) return null;
  if (hasReturnedValue(fallbackValue)) {
    return `${label} was not returned as a top-level Stage 2 field for this run, so the console is showing it from the organised prompt inputs captured with the LLM review.`;
  }
  return `${label} was not returned in this run payload. This usually means the run was created before that field was persisted, or the upstream Polymarket scan did not supply that optional value for this market.`;
}

export function getStageTwoPromptMissingValueReason(
  label: string,
  llmContext: Record<string, unknown> | null,
  promptTemplate: unknown,
) {
  const prompt = llmContext?.llm_prompt;
  if (hasReturnedValue(prompt)) return null;
  if (hasReturnedValue(promptTemplate)) {
    return `${label} was not returned as a per-row Stage 2 field for this run, so the console is showing the saved Stage 2 prompt template used for shared LLM execution.`;
  }
  return getStageTwoLlmMissingValueReason(label, prompt);
}

export function MissingValueNote({ children }: { children: ReactNode }) {
  return (
    <p className="mt-1 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] leading-4 text-amber-800">
      {children}
    </p>
  );
}

export function StageTwoInputPromptDialog({
  llmContext,
  promptTemplate,
  onClose,
}: {
  llmContext: Record<string, unknown> | null;
  promptTemplate: unknown;
  onClose: () => void;
}) {
  const prompt = getStageTwoDisplayedPrompt(llmContext, promptTemplate);
  const missingReason = getStageTwoPromptMissingValueReason(
    "Stage 2 Input prompt",
    llmContext,
    promptTemplate,
  );

  return (
    <div className="fixed inset-0 z-[170] flex items-center justify-center bg-slate-950/60 p-4">
      <div className="flex max-h-[86vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.55)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
              Stage 2 Input prompt
            </p>
            <h2 className="mt-1 text-xl font-semibold text-slate-950">
              Stage 2 Input prompt
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close Stage 2 input prompt"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-auto px-6 py-5 text-sm text-slate-700">
          <pre className="max-h-[62vh] overflow-auto whitespace-pre-wrap rounded-2xl border border-violet-200 bg-violet-50/60 p-4 text-xs leading-5 text-slate-800">
            {formatJsonForDisplay(prompt)}
          </pre>
          {missingReason ? (
            <MissingValueNote>{missingReason}</MissingValueNote>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function StageTwoLlmEventInputDialog({
  state,
  promptTemplate,
  onClose,
}: {
  state: StageTwoLlmEventInputDialogState;
  promptTemplate: unknown;
  onClose: () => void;
}) {
  const { title, llmContext } = state;
  const prompt = getStageTwoDisplayedPrompt(llmContext, promptTemplate);
  const promptInputs = getStageTwoLlmPromptInputs(llmContext);
  const promptInputMarket = getStageTwoLlmPromptInputMarket(llmContext);
  const evidencePacket = getStageTwoLlmPromptInputEvidencePacket(llmContext);
  const promptMissingReason = getStageTwoPromptMissingValueReason(
    "Common prompt sent to LLM",
    llmContext,
    promptTemplate,
  );
  const eventInputEntries = [
    ["market_id", llmContext?.market_id, promptInputMarket?.market_id],
    ["slug", llmContext?.slug, promptInputMarket?.slug],
    [
      "question",
      llmContext?.question ?? llmContext?.market_title,
      promptInputMarket?.question,
    ],
    ["market_url", llmContext?.market_url, promptInputMarket?.market_url],
    [
      "current_yes_odds",
      llmContext?.current_yes_odds,
      promptInputMarket?.current_yes_odds,
    ],
    [
      "current_no_odds",
      llmContext?.current_no_odds,
      promptInputMarket?.current_no_odds,
    ],
    ["volume_usd", llmContext?.volume_usd, promptInputMarket?.volume_usd],
    [
      "liquidity_usd",
      llmContext?.liquidity_usd,
      promptInputMarket?.liquidity_usd,
    ],
    ["close_time", llmContext?.close_time, promptInputMarket?.close_time],
    ["theme", llmContext?.theme, promptInputMarket?.theme],
    ["source", llmContext?.source, promptInputMarket?.source],
  ] as const;

  return (
    <div className="fixed inset-0 z-[170] flex items-center justify-center bg-slate-950/60 p-4">
      <div className="flex max-h-[86vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.55)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
              Event LLM input
            </p>
            <h2 className="mt-1 text-xl font-semibold text-slate-950">
              {title}
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              Input data and common prompt used for the LLM review of this
              event.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close event LLM input"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-auto px-6 py-5 text-sm text-slate-700">
          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-2xl border border-sky-200 bg-sky-50/60 p-4">
              <p className="font-semibold text-sky-950">
                Easy-read event input
              </p>
              <dl className="mt-3 space-y-2">
                {eventInputEntries.map(([key, primaryValue, fallbackValue]) => {
                  const value = readFirstReturnedValue(
                    primaryValue,
                    fallbackValue,
                  );
                  const missingReason = getStageTwoLlmMissingValueReason(
                    key.replaceAll("_", " "),
                    primaryValue,
                    fallbackValue,
                  );
                  return (
                    <div key={key} className="rounded-xl bg-white/80 px-3 py-2">
                      <dt className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                        {key.replaceAll("_", " ")}
                      </dt>
                      <dd className="mt-1 break-words font-medium text-slate-900">
                        {formatJsonForDisplay(value)}
                      </dd>
                      {missingReason ? (
                        <MissingValueNote>{missingReason}</MissingValueNote>
                      ) : null}
                    </div>
                  );
                })}
              </dl>
            </section>
            <section className="rounded-2xl border border-violet-200 bg-violet-50/60 p-4">
              <p className="font-semibold text-violet-950">
                Common prompt sent to LLM
              </p>
              <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap rounded-xl bg-white p-4 text-xs leading-5 text-slate-800">
                {formatJsonForDisplay(prompt)}
              </pre>
              {promptMissingReason ? (
                <MissingValueNote>{promptMissingReason}</MissingValueNote>
              ) : null}
            </section>
          </div>
          <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
            <p className="font-semibold text-slate-950">
              Full organised prompt inputs
            </p>
            <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-xl bg-slate-50 p-4 text-xs leading-5 text-slate-800">
              {formatJsonForDisplay(promptInputs)}
            </pre>
          </section>
          <section className="mt-4 rounded-2xl border border-amber-200 bg-amber-50/70 p-4">
            <p className="font-semibold text-amber-950">Evidence packet</p>
            <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-xl bg-white p-4 text-xs leading-5 text-slate-800">
              {formatJsonForDisplay(evidencePacket)}
            </pre>
            {getStageTwoLlmMissingValueReason(
              "Evidence packet",
              llmContext?.evidence_packet,
              evidencePacket,
            ) ? (
              <MissingValueNote>
                {getStageTwoLlmMissingValueReason(
                  "Evidence packet",
                  llmContext?.evidence_packet,
                  evidencePacket,
                )}
              </MissingValueNote>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}

export function StageTwoDecisionDetailDialog({
  mode,
  state,
  promptTemplate,
  onClose,
}: {
  mode: StageTwoDecisionDialogMode;
  state: StageTwoDecisionDialogState;
  promptTemplate: unknown;
  onClose: () => void;
}) {
  const { decision, llmContext } = state;
  const prompt = getStageTwoDisplayedPrompt(llmContext, promptTemplate);
  const promptInputs = getStageTwoLlmPromptInputs(llmContext);
  const evidencePacket = getStageTwoLlmPromptInputEvidencePacket(llmContext);
  const title =
    mode === "tag" ? "Decision tag details" : "LLM prompt + input packet";
  const promptMissingReason = getStageTwoPromptMissingValueReason(
    "Prompt sent to the LLM",
    llmContext,
    promptTemplate,
  );

  return (
    <div className="fixed inset-0 z-[170] flex items-center justify-center bg-slate-950/60 p-4">
      <div className="flex max-h-[86vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.55)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
              {title}
            </p>
            <h2 className="mt-1 text-xl font-semibold text-slate-950">
              {decision.market_title}
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              {decision.decision} · {decision.risk_status} · {decision.side}{" "}
              side · Current YES/NO{" "}
              {formatPriceCents(decision.current_yes_odds ?? null)} /{" "}
              {formatPriceCents(decision.current_no_odds ?? null)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close decision details"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-auto px-6 py-5 text-sm text-slate-700">
          {mode === "tag" ? (
            <div className="space-y-4">
              <section className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="font-semibold text-slate-950">
                  What this tag means
                </p>
                <p className="mt-2 leading-6">
                  Action <b>{decision.decision}</b> with risk status{" "}
                  <b>{decision.risk_status}</b> means the Stage 2 LLM/rules
                  pipeline classified this event as{" "}
                  {decision.decision === "EXIT"
                    ? "an event exit candidate that should move to the exit flow"
                    : decision.decision === "SKIP"
                      ? "not currently actionable for investment"
                      : "an actionable portfolio decision"}
                  .
                </p>
              </section>
              <section className="rounded-2xl border border-slate-200 bg-white p-4">
                <p className="font-semibold text-slate-950">
                  Why this event was tagged this way
                </p>
                <p className="mt-2 leading-6">
                  <span className="font-semibold">Summary:</span>{" "}
                  {decision.summary || decision.reason}
                </p>
                <p className="mt-2 leading-6">
                  <span className="font-semibold">Rationale:</span>{" "}
                  {decision.rationale || decision.reason}
                </p>
                {decision.exit_signals.length ? (
                  <ul className="mt-3 list-disc space-y-1 pl-5">
                    {decision.exit_signals.map((signal, index) => (
                      <li key={`${signal.reasonCode}-${index}`}>
                        <b>{signal.label}:</b> {signal.description}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            </div>
          ) : (
            <div className="space-y-4">
              <section className="rounded-2xl border border-violet-200 bg-violet-50/60 p-4">
                <p className="font-semibold text-violet-950">
                  Prompt sent to the LLM
                </p>
                <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-white p-4 text-xs leading-5 text-slate-800">
                  {formatJsonForDisplay(prompt)}
                </pre>
                {promptMissingReason ? (
                  <MissingValueNote>{promptMissingReason}</MissingValueNote>
                ) : null}
              </section>
              <section className="rounded-2xl border border-slate-200 bg-white p-4">
                <p className="font-semibold text-slate-950">
                  Organised prompt inputs
                </p>
                <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-slate-50 p-4 text-xs leading-5 text-slate-800">
                  {formatJsonForDisplay(promptInputs)}
                </pre>
              </section>
              <section className="rounded-2xl border border-amber-200 bg-amber-50/70 p-4">
                <p className="font-semibold text-amber-950">Evidence packet</p>
                <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-white p-4 text-xs leading-5 text-slate-800">
                  {formatJsonForDisplay(evidencePacket)}
                </pre>
              </section>
              {!llmContext ? (
                <p className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-slate-600">
                  This run did not return a matching Stage 2 LLM review context
                  for this decision.
                </p>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function getStageTwoBreakupMatchKey(value: string | null | undefined) {
  return normalizeMatchKey(value);
}

export function getStageTwoBreakupRows(
  state: StageTwoLlmRunDialogState,
  kind: StageTwoLlmRunBreakupKind,
) {
  const activeRows = state.stage.activePositionsFound.map((position) => ({
    id: `active-${position.positionKey}`,
    title: position.marketTitle,
    summary: `${position.isClaimable ? "Claimable" : "Open"} ${position.side ?? "position"} position${position.exposureUsd !== null ? ` · ${formatMoney(position.exposureUsd)} exposure` : ""}.`,
    detail: `Shares: ${formatShares(position.shares)} · Avg price: ${formatPriceCents(position.averagePriceCents)} · Current YES/NO: ${formatPriceCents(position.currentYesOdds)} / ${formatPriceCents(position.currentNoOdds)}${position.closeTime ? ` · Closes ${formatIstDateTime(position.closeTime)}` : ""}.`,
    keys: [
      position.marketId,
      position.slug,
      position.marketUrl,
      position.marketTitle,
    ],
  }));
  const newRows = state.stage.scanCandidates.map((candidate) => ({
    id: `candidate-${candidate.marketId ?? candidate.questionId ?? candidate.question}`,
    title: candidate.question,
    summary: `${candidate.forceInclude ? "Force-included" : "Passed filters"} opportunity${candidate.theme ? ` · ${candidate.theme}` : ""}.`,
    detail: `Current YES/NO: ${formatPriceCents(candidate.currentYesOdds)} / ${formatPriceCents(candidate.currentNoOdds)} · Volume: ${formatMoney(candidate.volumeUsd)} · Liquidity: ${formatMoney(candidate.liquidityUsd)}${candidate.closeTime ? ` · Closes ${formatIstDateTime(candidate.closeTime)}` : ""}.`,
    keys: [
      candidate.marketId,
      candidate.slug,
      candidate.marketUrl,
      candidate.question,
    ],
  }));
  const newRowKeySet = new Set(
    newRows
      .flatMap((row) => row.keys.map(getStageTwoBreakupMatchKey))
      .filter((key): key is string => Boolean(key)),
  );
  const overlappingActiveRows = activeRows.filter((row) =>
    row.keys.some((key) => {
      const normalized = getStageTwoBreakupMatchKey(key);
      return normalized ? newRowKeySet.has(normalized) : false;
    }),
  );

  if (kind === "active-positions") return activeRows;
  if (kind === "new-opportunities") return newRows;
  if (kind === "overlap") return overlappingActiveRows;

  const decisionRows = state.decisions.map((decision) => ({
    id: `decision-${decision.id}`,
    title: decision.market_title,
    summary:
      decision.summary ||
      decision.reason ||
      `${decision.decision} · ${decision.risk_status}`,
    detail:
      decision.rationale ||
      decision.reason ||
      "No LLM rationale returned for this row yet.",
    keys: [
      decision.market_id,
      decision.slug ?? null,
      decision.market_url ?? null,
      decision.market_title,
    ],
  }));
  return decisionRows.length
    ? decisionRows
    : [...activeRows, ...newRows].slice(
        0,
        state.stage.outputs.llm_candidate_count
          ? Number(state.stage.outputs.llm_candidate_count)
          : undefined,
      );
}

export function StageTwoLlmRunBreakupDialog({
  kind,
  state,
  stats,
  overlapCount,
  onClose,
}: {
  kind: StageTwoLlmRunBreakupKind;
  state: StageTwoLlmRunDialogState;
  stats: ReturnType<typeof getStageTwoStats>;
  overlapCount: number;
  onClose: () => void;
}) {
  const config = {
    "active-positions": {
      title: "Active positions",
      count: stats.activePositions,
      summary:
        "Open wallet position rows that Stage 2 considers alongside fresh scan opportunities.",
    },
    "new-opportunities": {
      title: "New opportunities",
      count: stats.newOpportunities,
      summary:
        "Fresh Stage 1 scan candidates that passed filters and were eligible for Stage 2 review.",
    },
    overlap: {
      title: "Overlap / de-duped",
      count: overlapCount,
      summary:
        "Rows that appear in both active positions and new opportunities and are counted once for the LLM.",
    },
    "unique-llm-rows": {
      title: "Unique LLM rows",
      count: stats.llmRanOn,
      summary:
        "The de-duplicated Stage 2 review set after active positions and new opportunities are unioned.",
    },
  }[kind];
  const rows = getStageTwoBreakupRows(state, kind);

  return (
    <div className="fixed inset-0 z-[170] flex items-center justify-center bg-slate-950/50 p-4">
      <div className="flex max-h-[82vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.55)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
              Tile breakup
            </p>
            <h3 className="mt-1 text-xl font-semibold text-slate-950">
              {config.title}: {config.count}
            </h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              {config.summary}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close tile breakup details"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div
          className="flex-1 overflow-auto px-6 py-5"
          data-testid="stage-two-invest-events-summary"
        >
          <div className="rounded-2xl border border-amber-100 bg-amber-50/70 p-4 text-sm text-amber-950">
            <p className="font-semibold">Summary</p>
            <p className="mt-1 leading-6">
              {config.summary} Displayed count:{" "}
              <span className="font-semibold tabular-nums">{config.count}</span>
              . Rows available below:{" "}
              <span className="font-semibold tabular-nums">{rows.length}</span>.
            </p>
          </div>
          <div className="mt-5 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Indepth details
            </p>
            {rows.length ? (
              rows.map((row) => (
                <article
                  key={row.id}
                  className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-700"
                >
                  <h4 className="font-semibold text-slate-950">{row.title}</h4>
                  <p className="mt-2 leading-6">
                    <span className="font-semibold">Summary:</span>{" "}
                    {row.summary}
                  </p>
                  <p className="mt-2 leading-6">
                    <span className="font-semibold">Indepth details:</span>{" "}
                    {row.detail}
                  </p>
                </article>
              ))
            ) : (
              <p className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                No row-level details have been returned for this tile yet.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function StageTwoBypassDialog({
  state,
  onClose,
}: {
  state: StageTwoBypassDialogState;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[180] flex items-center justify-center bg-slate-950/60 p-4 text-slate-950">
      <div className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-3xl border border-amber-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.55)]">
        <div className="flex items-start justify-between gap-4 border-b border-amber-100 bg-amber-50 px-6 py-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-amber-700">
              Stage 2 bypass reason
            </p>
            <h3 className="mt-1 text-xl font-semibold text-amber-950">
              Stage 3 started while Stage 2 is In Queue
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-amber-200 bg-white p-2 text-amber-800 transition hover:bg-amber-50"
            aria-label="Close Stage 2 bypass reason"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-auto px-6 py-5">
          <div className="rounded-2xl border border-amber-200 bg-amber-50/80 p-4 text-sm text-amber-950">
            <p className="font-semibold">Detailed reason</p>
            <p className="mt-2 leading-6">{state.reason}</p>
          </div>
          <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Steps to rectify
            </p>
            <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-6 text-slate-700">
              {state.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}

export function StageTwoInvestEventsDialog({
  state,
  onClose,
}: {
  state: StageTwoInvestEventsDialogState;
  onClose: () => void;
}) {
  const [isCompactRows, setIsCompactRows] = useState(false);
  const [sortState, setSortState] = useState<BullpenTableSortState>({
    key: "returnsPerDay",
    direction: "desc",
  });

  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-slate-950/60 p-4">
      <div className="flex max-h-[92vh] w-[calc(100vw-2rem)] max-w-[1500px] flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.55)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
              Stage 2 Output
            </p>
            <div className="mt-1 flex items-center gap-2">
              <h2 className="text-xl font-semibold text-slate-950">
                New Events to Invest in: {state.rows.length}
              </h2>
              <button
                type="button"
                onClick={() => setIsCompactRows((current) => !current)}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-300"
                aria-pressed={isCompactRows}
                aria-label={
                  isCompactRows
                    ? "Expand Stage 2 invest rows"
                    : "Collapse Stage 2 invest rows"
                }
                title={
                  isCompactRows
                    ? "Expand Stage 2 invest rows"
                    : "Collapse Stage 2 invest rows"
                }
              >
                {isCompactRows ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronUp className="h-4 w-4" />
                )}
              </button>
            </div>
            <p className="mt-2 text-sm text-slate-600">
              Stage 2 Top 10 events ranked by Returns/day. This table comes
              straight from the saved Stage 2 Events Summary and does not
              depend on Stage 3 planning or execution.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close new events to invest details"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-auto px-6 py-5">
          <BullpenQuestionsTable
            snapshot={null}
            rowsOverride={state.rows}
            emptyMessage="No Stage 2 Top 10 rows were returned for this run."
            headerContent={
              <div className="rounded-2xl border border-blue-100 bg-blue-50/70 px-4 py-3 text-sm text-blue-950">
                This Events Summary view shows the saved Stage 2 Top 10 by
                Returns/day, independent of any later Stage 3 ranking,
                blockers, or order execution.
              </div>
            }
            updatedAt={state.updatedAt}
            updateUnavailableReason={state.updateUnavailableReason}
            scrollResetKey={`stage-two-invest-events-${state.rows.length}`}
            isLoading={false}
            onSortChange={(key) =>
              setSortState((current) => ({
                key,
                direction:
                  current.key === key && current.direction === "desc"
                    ? "asc"
                    : "desc",
              }))
            }
            selectedQuestionIds={new Set<string>()}
            selectionEnabled={false}
            sortState={sortState}
            onToggleQuestion={() => undefined}
            onToggleSelectAll={() => undefined}
            visibleColumnIds={[
              "serialNumber",
              "question",
              "closeTime",
              "category",
              "yesOdds",
              "noOdds",
              "llmYesOdds",
              "llmNoOdds",
              "returnsPerDay",
              "amountToBeInvested",
            ]}
            persistColumnPreferences={false}
            showPresetFilters={false}
            displayDensity={isCompactRows ? "compact" : "default"}
            rowHighlightById={buildStageTwoEventsSummaryHighlightById({
              rows: state.rows,
              stage: state.stage,
              decisions: state.decisions,
              includeEventExits: false,
            })}
          />
        </div>
      </div>
    </div>
  );
}

export function InvestMetricDetailsDialog({
  state,
  onClose,
  onSelectKind,
  onOpenEventExitInfo,
  onOpenInvestEligibilityInfo,
}: {
  state: InvestMetricDialogState;
  onClose: () => void;
  onSelectKind: (kind: InvestMetricDialogKind) => void;
  onOpenEventExitInfo?: () => void;
  onOpenInvestEligibilityInfo?: (trigger: HTMLButtonElement | null) => void;
}) {
  const [transferQueueMetricInfoKind, setTransferQueueMetricInfoKind] =
    useState<Stage2TransferQueueMetricInfoKind | null>(null);
  const [returnsPerDayQuestion, setReturnsPerDayQuestion] =
    useState<BullpenQuestionRow | null>(null);
  const metricDefinition = getInvestMetricDialogDefinition(state.kind);
  const rows = getInvestMetricRows(state.kind, state.decisions);
  const stage2TopTenHandoffRows = buildBullpenStage2TopTenHandoffRows({
    run: state.run,
    decisions: state.decisions,
  });
  const showStage2TopTenGapRows =
    state.kind === "planned" || state.kind === "buy-planned";
  const stage2TopTenGapRows = showStage2TopTenGapRows
    ? stage2TopTenHandoffRows.filter((row) => row.missingFromBuyPlan)
    : [];
  const showStage2TopTenEventsSummary =
    state.kind === "buy-planned" && stage2TopTenHandoffRows.length > 0;
  const tableRows = (
    showStage2TopTenGapRows
      ? [...rows, ...stage2TopTenGapRows.map((row) => row.displayDecision)]
      : rows
  ).sort((left, right) => {
    const leftRank = left.stage3_final_rank ?? Number.POSITIVE_INFINITY;
    const rightRank = right.stage3_final_rank ?? Number.POSITIVE_INFINITY;
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
    return left.market_title.localeCompare(right.market_title);
  });
  const historicalPlannedContractRows =
    state.kind === "planned" && tableRows.length === 0 && state.stage
      ? [
          ...readStageOutputStringList(
            state.stage.outputs.stage2_actionable_exit_market_ids,
          ).map((marketId) => ({ marketId, action: "Exit" as const })),
          ...readStageOutputStringList(
            state.stage.outputs.stage2_actionable_buy_market_ids,
          ).map((marketId) => ({ marketId, action: "Buy" as const })),
        ]
      : [];
  const selectedStepKey = state.kind.startsWith("sell-")
    ? "sell"
    : state.kind.startsWith("buy-")
      ? "buy"
      : null;
  const selectedStepSummary =
    selectedStepKey === null
      ? null
      : getLastInvestExecutionStep(state.run, selectedStepKey, state.decisions);
  const decisionsCount = getInvestStageMetric(
    state.stage,
    "decisions_count",
    state.run.decisions_count,
  );
  const plannedCount =
    selectedStepSummary?.plannedOrders ??
    getInvestStageMetric(state.stage, "orders_planned", state.run.orders_planned);
  const submittedCount =
    selectedStepSummary?.submittedOrders ??
    getInvestStageMetric(
      state.stage,
      "orders_submitted",
      state.run.orders_submitted,
    );
  const activePositionRows = state.stage
    ? readStageOutputNumber(state.stage.outputs.active_position_rows)
    : null;
  const candidateRows = state.stage
    ? readStageOutputNumber(state.stage.outputs.candidate_decision_rows)
    : null;
  const stageError = state.stage
    ? readStageOutputString(state.stage.outputs.error_message)
    : null;
  const runError =
    stageError ??
    (typeof state.run.error_message === "string" &&
    state.run.error_message.trim().length > 0
      ? state.run.error_message.trim()
      : null);
  const filteredPlannedCount = tableRows.filter(
    (decision) => decision.order_plan,
  ).length;
  const filteredProcessedCount = tableRows.filter((decision) =>
    isProcessedInvestOrderPlan(decision.order_plan),
  ).length;
  const filteredExecutionGroups =
    partitionInvestDecisionsByExecutionEvidence(tableRows);
  const filteredSubmittedCount =
    filteredExecutionGroups.submittedOrExecuted.length +
    filteredExecutionGroups.submittedButUnsuccessful.length;
  const filteredSubmittedUnsuccessfulRows =
    filteredExecutionGroups.submittedButUnsuccessful;
  const filteredUnsubmittedRows = filteredExecutionGroups.notSubmitted;
  const filteredNoActionRows =
    filteredExecutionGroups.completedWithoutSubmission;
  const filteredFailedRows = filteredUnsubmittedRows.filter(
    (decision) =>
      decision.order_plan?.status === "failed" ||
      decision.order_plan?.status === "cancelled",
  );
  const filteredSkippedRows = filteredUnsubmittedRows.filter(
    (decision) => decision.order_plan?.status === "skipped",
  );
  const filteredPendingRows = filteredUnsubmittedRows.filter(
    (decision) => decision.order_plan?.status === "planned",
  );
  const concreteBuyPlanCount = stage2TopTenHandoffRows.filter(
    (row) => !row.missingFromBuyPlan,
  ).length;
  const submittedBuyPlanCount = stage2TopTenHandoffRows.filter((row) =>
    isSubmittedOrExecutedInvestOrderPlan(row.displayDecision.order_plan),
  ).length;
  const blockedOrWaitingBuyPlanCount = stage2TopTenHandoffRows.filter(
    (row) => row.missingFromBuyPlan,
  ).length;
  const executionSteps = state.stage
    ? getInvestStageExecutionSteps(state.stage, state.decisions)
    : [];
  const progressLogEntries = getInvestProgressLogEntries({
    stage: state.stage,
    run: state.run,
    decisions: rows,
    steps: executionSteps,
  });

  return (
    <div className="fixed inset-0 z-[180] flex items-center justify-center bg-slate-950/55 p-4">
      <div className="flex max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.45)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
              Stage 3 Details
            </p>
            <h2 className="text-xl font-semibold text-slate-950">
              {metricDefinition.title}
            </h2>
            <p className="text-sm text-slate-600">
              {metricDefinition.description}
            </p>
            <p className="text-xs text-slate-500">
              Run {state.run.id} · started{" "}
              {formatIstDateTime(state.run.started_at)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close Stage 3 details"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-6 py-5">
          <div className="grid gap-3 md:grid-cols-4">
            <InvestMetricSummaryCard
              label="Decisions"
              value={decisionsCount}
              onClick={() => onSelectKind("decisions")}
            />
            <InvestMetricSummaryCard
              label="Planned"
              value={plannedCount}
              onClick={() => onSelectKind("planned")}
            />
            <InvestMetricSummaryCard
              label="Submitted"
              value={submittedCount}
              onClick={() => onSelectKind("submitted")}
            />
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                Review rows
              </p>
              <p className="mt-2 text-sm font-semibold text-slate-950">
                {(activePositionRows ?? 0).toLocaleString("en-IN")} active +{" "}
                {(candidateRows ?? 0).toLocaleString("en-IN")} candidate
              </p>
            </div>
          </div>

          {showStage2TopTenEventsSummary ? (
            <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                Saved Stage 2 transfer queue
              </p>
              <div className="mt-3 grid gap-3 md:grid-cols-4">
                <Stage2TransferQueueMetricSummaryCard
                  kind="transferred-rows"
                  label="Transferred rows"
                  value={stage2TopTenHandoffRows.length.toLocaleString("en-IN")}
                  cardClassName="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-slate-500"
                  labelClassName="text-[11px] font-semibold uppercase tracking-[0.14em]"
                  valueClassName="mt-1 text-lg font-semibold text-slate-950"
                  onOpenInfo={setTransferQueueMetricInfoKind}
                />
                <Stage2TransferQueueMetricSummaryCard
                  kind="concrete-buy-plans"
                  label="Concrete buy plans"
                  value={concreteBuyPlanCount.toLocaleString("en-IN")}
                  cardClassName="rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-blue-700"
                  labelClassName="text-[11px] font-semibold uppercase tracking-[0.14em]"
                  valueClassName="mt-1 text-lg font-semibold text-blue-950"
                  onOpenInfo={setTransferQueueMetricInfoKind}
                />
                <Stage2TransferQueueMetricSummaryCard
                  kind="submitted-buy-plans"
                  label="Submitted"
                  value={submittedBuyPlanCount.toLocaleString("en-IN")}
                  cardClassName="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-emerald-700"
                  labelClassName="text-[11px] font-semibold uppercase tracking-[0.14em]"
                  valueClassName="mt-1 text-lg font-semibold text-emerald-950"
                  onOpenInfo={setTransferQueueMetricInfoKind}
                />
                <Stage2TransferQueueMetricSummaryCard
                  kind="waiting-blocked"
                  label="Still waiting / blocked"
                  value={blockedOrWaitingBuyPlanCount.toLocaleString("en-IN")}
                  cardClassName="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-700"
                  labelClassName="text-[11px] font-semibold uppercase tracking-[0.14em]"
                  valueClassName="mt-1 text-lg font-semibold text-amber-950"
                  onOpenInfo={setTransferQueueMetricInfoKind}
                />
              </div>
            </div>
          ) : (
            <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                Selected filter
              </p>
              <p className="mt-2 text-sm font-semibold text-slate-950">
                {(tableRows.length || historicalPlannedContractRows.length).toLocaleString("en-IN")} rows ·{" "}
                {(filteredPlannedCount || historicalPlannedContractRows.length).toLocaleString("en-IN")} planned ·{" "}
                {filteredProcessedCount.toLocaleString("en-IN")} processed ·{" "}
                {filteredSubmittedCount.toLocaleString("en-IN")} submitted
              </p>
            </div>
          )}

          {runError ? (
            <div className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-950">
              <span className="font-semibold">Latest worker error:</span>{" "}
              <ErrorCodeWithDetails
                detail={runError}
                detailClassName="text-rose-800"
              />
            </div>
          ) : null}

          {stage2TopTenGapRows.length > 0 ? (
            <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
              <span className="font-semibold">
                Stage 2 Top 10 rows missing from the concrete Step 2 buy-plan count:
              </span>{" "}
              {stage2TopTenGapRows.length.toLocaleString("en-IN")} transferred
              row
              {stage2TopTenGapRows.length === 1 ? "" : "s"} are still shown
              below, but Stage 3 never created a buy order plan for them. Each
              row includes the recorded blocker or a missing-handoff reason.
            </div>
          ) : null}

          {executionSteps.length > 0 ? (
            <div className="mt-5">
              <InvestExecutionStepsSummary
                steps={executionSteps}
                onOpenMetricDetails={onSelectKind}
                onOpenEventExitInfo={onOpenEventExitInfo}
                onOpenInvestEligibilityInfo={onOpenInvestEligibilityInfo}
              />
            </div>
          ) : null}

          {filteredNoActionRows.length > 0 ? (
            <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm text-slate-800">
              <p className="font-semibold">Completed without a new order</p>
              <p className="mt-1">
                {filteredNoActionRows.length.toLocaleString("en-IN")} redeem or
                settlement outcome
                {filteredNoActionRows.length === 1 ? "" : "s"} required no new
                remote submission and are excluded from Submitted counts.
              </p>
            </div>
          ) : null}

          {filteredSubmittedUnsuccessfulRows.length > 0 ? (
            <div className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-4 text-sm text-rose-950">
              <p className="font-semibold">Submitted but unsuccessful</p>
              <p className="mt-1">
                {filteredSubmittedUnsuccessfulRows.length.toLocaleString(
                  "en-IN",
                )}{" "}
                evidence-backed submission
                {filteredSubmittedUnsuccessfulRows.length === 1 ? "" : "s"}{" "}
                ended cancelled, rejected, timed out, or permanently failed.
                They remain included in Submitted and are not mislabeled as
                never submitted.
              </p>
            </div>
          ) : null}

          {filteredUnsubmittedRows.length > 0 ? (
            <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-950">
              <p className="font-semibold">Orders still not submitted</p>
              <p className="mt-1">
                {filteredUnsubmittedRows.length.toLocaleString("en-IN")} of{" "}
                {filteredPlannedCount.toLocaleString("en-IN")} filtered orders
                are still not submitted. Failed{" "}
                {filteredFailedRows.length.toLocaleString("en-IN")} · Skipped{" "}
                {filteredSkippedRows.length.toLocaleString("en-IN")} · Planned{" "}
                {filteredPendingRows.length.toLocaleString("en-IN")}
              </p>
              <div className="mt-3 space-y-2">
                {filteredUnsubmittedRows.map((decision) => (
                  <div
                    key={decision.id}
                    className="rounded-xl border border-amber-300/70 bg-white/70 px-3 py-2.5"
                  >
                    <p className="font-semibold">
                      {decision.market_title} ·{" "}
                      <span className="capitalize">
                        {decision.order_plan?.status.replaceAll("_", " ")}
                      </span>
                    </p>
                    <div className="mt-1 leading-5 text-amber-950">
                      <Stage3SellExecutionTelemetry decision={decision} />
                      <ErrorCodeWithDetails
                        detail={
                          decision.order_plan?.detail ??
                          "No execution detail was recorded."
                        }
                        detailClassName="text-amber-900"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {progressLogEntries.length > 0 ? (
            <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Live progress / error log
                  </p>
                  <p className="mt-1 text-sm text-slate-600">
                    When a step takes a while, this shows the latest worker
                    checkpoint, gate, and order error details saved for this
                    run.
                  </p>
                </div>
                {state.stage?.state === "current" ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-800">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Updating
                  </span>
                ) : null}
              </div>
              <div className="mt-4 space-y-2">
                {progressLogEntries.map((entry, index) => {
                  const toneClass =
                    entry.tone === "error"
                      ? "border-rose-200 bg-rose-50 text-rose-950"
                      : entry.tone === "warning"
                        ? "border-amber-200 bg-amber-50 text-amber-950"
                        : entry.tone === "success"
                          ? "border-emerald-200 bg-emerald-50 text-emerald-950"
                          : "border-sky-200 bg-sky-50 text-sky-950";
                  return (
                    <div
                      key={`${entry.label}-${index}`}
                      className={`rounded-xl border px-3 py-2.5 text-sm ${toneClass}`}
                    >
                      <p className="font-semibold capitalize">{entry.label}</p>
                      <p className="mt-1 leading-5">{entry.detail}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {showStage2TopTenEventsSummary ? (
            <div className="mt-5">
              <Stage2TopTenEventsSummaryTable
                rows={stage2TopTenHandoffRows}
                run={state.run}
                testId="stage-three-step-two-events-summary"
                emptyMessage="No saved Stage 2 Top 10 rows were returned for this Stage 3 Step 2 view."
                headerContent={
                  <div className="rounded-2xl border border-blue-100 bg-blue-50/70 px-4 py-3 text-sm text-blue-950">
                    This Events Summary view shows the full saved Stage 2 Top 10
                    transfer queue. Rows that never became concrete Step 2 buy
                    plans stay visible here with their latest recorded blocker
                    or missing-handoff reason.
                  </div>
                }
              />
            </div>
          ) : (
            <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200">
              {tableRows.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="min-w-[78rem] divide-y divide-slate-200 text-sm">
                    <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                      <tr>
                        <th className="px-4 py-3">Event</th>
                        <th className="px-4 py-3">Decision</th>
                        <th className="px-4 py-3">Edge & score</th>
                        <th className="px-4 py-3">Exposure</th>
                        <th className="px-4 py-3">LLM Yes Odds</th>
                        <th className="px-4 py-3">LLM No Odds</th>
                        <th className="px-4 py-3">Returns/day</th>
                        <th className="px-4 py-3">Exit Type</th>
                        <th className="px-4 py-3">Order</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 bg-white">
                      {tableRows.map((decision) => (
                        <tr key={decision.id}>
                          <td className="w-[24rem] max-w-[24rem] px-3 py-2 align-middle">
                            <div className="font-semibold text-slate-950">
                              {decision.market_url ? (
                                <a
                                  className="hover:text-sky-700 hover:underline"
                                  href={decision.market_url}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {decision.market_title}
                                </a>
                              ) : (
                                decision.market_title
                              )}
                            </div>
                            <div className="mt-1 text-xs text-slate-500">
                              {decision.theme} · closes{" "}
                              {formatIstDateTime(decision.close_time)}
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 align-middle text-slate-700">
                            <span className="font-semibold capitalize text-slate-950">
                              {decision.decision.replaceAll("_", " ")}
                            </span>
                            <br />
                            Side {decision.side} · {decision.confidence}
                            <br />
                            {decision.risk_status.replaceAll("_", " ")}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 align-middle text-slate-700">
                            Edge{" "}
                            {decision.edge_pp.toLocaleString("en-IN", {
                              maximumFractionDigits: 2,
                            })}{" "}
                            pp
                            <br />
                            Score{" "}
                            {decision.score.toLocaleString("en-IN", {
                              maximumFractionDigits: 2,
                            })}
                            <br />
                            Fair{" "}
                            {formatOddsPercent(decision.fair_probability_pct)}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 align-middle text-slate-700">
                            Current {formatMoney(decision.current_exposure_usd)}
                            <br />
                            Target {formatMoney(decision.target_exposure_usd)}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 align-middle font-semibold tabular-nums text-violet-800">
                            {formatOddsPercent(
                              decision.fair_yes_probability_pct ?? null,
                            )}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 align-middle font-semibold tabular-nums text-violet-800">
                            {formatOddsPercent(
                              decision.fair_no_probability_pct ?? null,
                            )}
                          </td>
                          <td className="px-4 py-3 align-top tabular-nums text-slate-700">
                            <BullpenReturnsPerDayValueButton
                              disabled={getDecisionReturnsPerDay(decision) === null}
                              onOpen={() =>
                                setReturnsPerDayQuestion(
                                  buildDecisionReturnsPerDayQuestion(decision),
                                )
                              }
                              ariaLabel={`Show Returns/day calculation for ${decision.market_title}`}
                            >
                              {formatReturnsPerDay(
                                getDecisionReturnsPerDay(decision),
                              )}
                            </BullpenReturnsPerDayValueButton>
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 align-middle text-slate-700">
                            {(() => {
                              const exitType =
                                getDecisionExitTypeDetails(decision);
                              return exitType ? (
                                <>
                                  <span className="font-semibold text-slate-950">
                                    {exitType.label}
                                  </span>
                                  <br />
                                  <span className="whitespace-pre-line text-xs leading-5">
                                    {exitType.details}
                                  </span>
                                </>
                              ) : (
                                "—"
                              );
                            })()}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 align-middle text-slate-700">
                            <span className="font-semibold capitalize">
                              {formatInvestMetricOrderStatus(decision)}
                            </span>
                            {decision.order_plan ? (
                              <>
                                <br />
                                {formatMoney(
                                  decision.order_plan.order_size_usd,
                                )}{" "}
                                at{" "}
                                {formatPriceCents(
                                  decision.order_plan.limit_price_cents,
                                )}
                                <br />
                                <Stage3SellExecutionTelemetry
                                  decision={decision}
                                />
                                <ErrorCodeWithDetails
                                  detail={getPlannedOrderBrief(decision)}
                                  detailClassName="text-slate-700"
                                />
                              </>
                            ) : (
                              <>
                                <br />
                                {getPlannedOrderBrief(decision)}
                              </>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : historicalPlannedContractRows.length > 0 ? (
                <HistoricalPlannedContractRows
                  rows={historicalPlannedContractRows}
                />
              ) : (
                <div className="bg-slate-50 px-4 py-8 text-sm text-slate-600">
                  Stage 3 has not emitted any decision rows for this metric yet.
                  The worker may still be preparing the first review row.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {transferQueueMetricInfoKind ? (
        <Stage2TransferQueueMetricInfoDialog
          kind={transferQueueMetricInfoKind}
          onClose={() => setTransferQueueMetricInfoKind(null)}
        />
      ) : null}
      {returnsPerDayQuestion ? (
        <BullpenInvestmentMathDialog
          focus="returnsPerDay"
          question={returnsPerDayQuestion}
          onClose={() => setReturnsPerDayQuestion(null)}
        />
      ) : null}
    </div>
  );
}

export function HistoricalPlannedContractRows({
  rows,
}: {
  rows: Array<{ marketId: string; action: "Exit" | "Buy" }>;
}) {
  const [titles, setTitles] = useState<Record<string, string | null>>({});
  const rowsKey = rows.map((row) => `${row.action}:${row.marketId}`).join("|");

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/bullpen-ai/market-urls", {
          method: "POST",
          headers: { "content-type": "application/json" },
          cache: "no-store",
          signal: controller.signal,
          body: JSON.stringify({
            questions: rows.map((row) => ({
              id: row.marketId,
              slug: null,
              marketUrl: null,
              question: null,
              category: null,
            })),
          }),
        });
        if (!response.ok) return;
        const payload = (await response.json()) as {
          marketTitles?: Record<string, string | null>;
        };
        if (!controller.signal.aborted) {
          setTitles(payload.marketTitles ?? {});
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          console.warn("Unable to enrich historical Stage 3 plans", error);
        }
      }
    })();
    return () => controller.abort();
  }, [rowsKey]);

  return (
    <div className="divide-y divide-slate-200 bg-white">
      {rows.map((row, index) => (
        <div
          key={`${row.action}-${row.marketId}`}
          className="flex items-start justify-between gap-4 px-4 py-3 text-sm"
        >
          <div>
            <p className="font-semibold text-slate-950">
              {titles[row.marketId] ?? row.marketId}
            </p>
            <p className="mt-1 text-xs text-slate-600">
              Preserved from the completed Stage 2 actionable contract.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-xs font-semibold text-slate-500">
              #{index + 1}
            </span>
            <span
              className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${
                row.action === "Exit"
                  ? "border-rose-200 bg-rose-50 text-rose-800"
                  : "border-emerald-200 bg-emerald-50 text-emerald-800"
              }`}
            >
              {row.action}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function Stage3PreviewDialog({
  state,
  submitting = false,
  submitDisabled = false,
  onClose,
  onSubmit,
}: {
  state: Stage3PreviewDialogState;
  submitting?: boolean;
  submitDisabled?: boolean;
  onClose: () => void;
  onSubmit?: () => void;
}) {
  const sellDecisions = state.decisions.filter(
    (decision) => decision.order_plan?.action === "sell",
  );
  const buyDecisions = state.decisions.filter(
    (decision) => decision.order_plan?.action === "buy",
  );

  return (
    <div className="fixed inset-0 z-[155] flex items-center justify-center bg-slate-950/60 p-4">
      <div className="flex max-h-[88vh] w-full max-w-[92rem] flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.55)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
              Stage 3 Queue Preview
            </p>
            <h2 className="text-xl font-semibold text-slate-950">
              Current Stage 3 buy and sell queue
            </h2>
            <p className="max-w-4xl text-sm leading-6 text-slate-600">
              This preview combines the current Event Exits list with the saved
              Stage 2 top-10 transfer queue. It is not a persisted order plan.
              Stage 3 submits the exits first, waits for settlement, refreshes
              live cash plus occupied slots, and only then creates, sizes, and
              submits concrete buys.
            </p>
            <p className="text-xs text-slate-500">
              Source run{" "}
              <span className="font-semibold text-slate-700">
                {state.sourceRun?.id ?? "stage3-preview"}
              </span>
              {" · "}snapshot time{" "}
              <span className="font-semibold text-slate-700">
                {formatIstDateTime(
                  state.sourceRun?.completed_at ?? state.sourceRun?.started_at ?? null,
                )}
              </span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close Stage 3 queue preview"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-6 py-5">
          <div className="grid gap-3 md:grid-cols-3">
            <InvestMetricSummaryCard label="Queued" value={state.plannedOrders} />
            <InvestMetricSummaryCard
              label="Step 1 exit queue"
              value={state.sellPlannedOrders}
            />
            <InvestMetricSummaryCard
              label="Step 2 candidates"
              value={state.buyPlannedOrders}
            />
          </div>

          <div className="mt-5 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-4 text-sm text-sky-950">
            These are transfer-queue rows, not saved orders. Stage 3 evaluates
            exits first, then creates concrete buy plans only after it refreshes
            live wallet cash and open slots.
          </div>

          <div className="mt-5 space-y-4">
            <Stage3DecisionTable
              title="Step 1 Event Exits"
              rows={sellDecisions}
              emptyMessage="No executable Event Exit sell rows are waiting right now."
            />
            <Stage3DecisionTable
              title="Step 2 Candidate Queue"
              rows={buyDecisions}
              emptyMessage="No saved Stage 2 top-10 candidate rows are waiting right now."
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-6 py-4">
          <p className="text-xs leading-5 text-slate-500">
            Preview only until the run is queued. Once started, the worker
            persists concrete Stage 3 plans and submissions in the history.
          </p>
          {onSubmit ? (
            <button
              type="button"
              onClick={onSubmit}
              disabled={submitDisabled || submitting}
              className={`inline-flex items-center justify-center rounded-xl border px-4 py-2 text-sm font-semibold transition ${
                submitDisabled || submitting
                  ? "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400"
                  : "border-blue-950 bg-blue-950 text-white hover:bg-blue-900"
              }`}
            >
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Submitting...
                </>
              ) : (
                <>
                  <Zap className="mr-2 h-4 w-4" />
                  Queue Stage 3 Exit and Invest
                </>
              )}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

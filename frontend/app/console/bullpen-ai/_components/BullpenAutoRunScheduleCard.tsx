"use client";
import { deferBullpenDetail } from "./BullpenDeferredDetail";
const BullpenRunHistoryContent = deferBullpenDetail(() => import("./BullpenRunHistoryContent").then(module => module.BullpenRunHistoryContent));
const BullpenAutoRunBadgeRationaleDialog = deferBullpenDetail(() => import("./BullpenAutoRunBadgeRationaleDialog").then(module => module.BullpenAutoRunBadgeRationaleDialog));
const BullpenStageOneExcelHistoryDialog = deferBullpenDetail(() => import("./BullpenStageOneExcelHistoryDialog").then(module => module.BullpenStageOneExcelHistoryDialog));

import { useCallback, useEffect, useEffectEvent, useRef, useState, type ChangeEvent } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { CalendarClock, CheckCircle2, ChevronDown, Clock3, Copy, History, ExternalLink, Filter, Info, Bot, RefreshCw, Wallet, Loader2, LogIn, LogOut, PauseCircle, PlayCircle, ShieldAlert, Square, X, Zap } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { type BullpenQuestion, type BullpenQuestionRow, type BullpenScanSnapshot } from "@/lib/bullpen-ai";
import type { BullpenActivePositionLlmAnalysis } from "@/lib/bullpenActivePositions";
import { buildBullpenInvestmentDisplay } from "@/lib/bullpenInvestments";
import { useAuth } from "@/hooks/useAuth";
import { BullpenEventIdentityResolver, buildBullpenEventIdentityFromDecision, buildBullpenEventIdentityFromPosition } from "@/lib/bullpenEventIdentityResolver";
import { isActiveBullpenPosition, isClaimableBullpenPosition, resolveBullpenPreferredPortfolioValue, resolveBullpenTotalPortfolioValue, sumBullpenPortfolioPositionValue, sumCurrentPositionValue, type BullpenActivePositionView, type BullpenPositionsSnapshotLineage, type BullpenPositionsSource, type BullpenPositionsSummary } from "@/lib/bullpenPositions";
import { resolveLatestVerifiedStage1Portfolio, resolveVerifiedStage1PortfolioSnapshot, selectLatestVerifiedStage1Portfolio, shouldUseVerifiedStage1PortfolioFallback } from "@/lib/bullpenVerifiedPortfolio";
import { formatUnknownError, splitApiErrorSummary } from "@/lib/apiErrors";
import { BULLPEN_STAGE_ONE_SETTINGS_UPDATED_EVENT, type BullpenWorkspaceProfile } from "@/lib/bullpenStageOneSettings";
import { bullpenWorkspaceHistoryPath, bullpenWorkspacePath } from "@/lib/bullpenWorkspaceRoutes";
import { mergeBullpenConsoleDecisionProjection, mergeBullpenConsoleRunProjection, reconcileBullpenConsoleRunCopies } from "@/lib/bullpenRunConsoleDetail";
import { APIError, RequestTimeoutError, apiService } from "@/services/api";
import type { BullpenAutoLiveDecision, BullpenAutoLiveHistoryItem, BullpenAutoLiveHistoryPage, BullpenAutoLiveEventTrendsResponse, BullpenAutoLiveOutcomeSide, BullpenAutoLiveRun, BullpenAutoLiveRunOnceRequest, BullpenAutoLiveSummaryResponse, BullpenLlmExecutionMode, ProviderModelTarget, PolymarketBotState } from "@/types/api";
import { buildBullpenAutoRunWorkflowView, isBullpenAutoRunWorkflowSettled } from "./bullpenAutoRunProgress";
import { downloadIndependentStageOneExcel } from "./bullpenStageOneExcel";
import { createAbortableBullpenAutoRunRequestDeduper, getBullpenAutoRunActiveRunId, getBullpenAutoRunStatusCacheKey, getBullpenAutoRunStatusBadges, getBullpenAutoRunBadgeRationale, getBullpenAutoRunStatusRetryDelay, isBullpenAutoRunProgressActive, isBullpenAutoRunSchedulerEnabled, isBullpenAutoRunPageVisible, logBullpenAutoRunStatusFallback, normalizeBullpenAutoRunStatusData, normalizeBullpenAutoRunStatusFromSummary, readCachedBullpenAutoRunStatus, writeCachedBullpenAutoRunStatus, type BullpenAutoRunStatusData, type BullpenAutoRunStatusLoadState, type BullpenAutoRunBadgeKind } from "./bullpenAutoRunStatus";


import { useEventTrendsTimeout } from "./useEventTrendsTimeout";
import { BullpenHistoryPortfolio } from "./BullpenHistoryPortfolio";
import { buildBullpenStage3InvestPreviewSteps, buildBullpenStage3OnlyInvestExecutionPlan, NO_STAGE2_QUALIFIED_EVENTS_REASON, type BullpenStage3AlreadyInvestedRecord, selectBullpenStage3OnlyInvestSource } from "./bullpenAutoRunStage3Invest";
import { isSubmittedOrExecutedInvestOrderPlan, type InvestMetricDialogKind } from "./bullpenAutoRunInvestMetrics";
import { getInvestStageImmediateSuccess } from "./bullpenAutoRunStageStatus";
import { EventScanRunControls } from "@/components/shared/EventScanRunControls";
import { formatElapsedRunTime, formatStageElapsedTime } from "./bullpenAutoRunTimers";

import { DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MAX_POSITIONS, DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MIN_LLM_SIDE_ODDS, DEFAULT_BULLPEN_STAGE2_TO_STAGE3_RANKING_FIELD, DEFAULT_BULLPEN_STAGE2_TO_STAGE3_RANKING_TIE_BREAK, formatBullpenStage2To3RankingFieldLabel, formatBullpenStage2To3RankingTieBreakLabel, formatBullpenStage2To3SizingFormulaLabel, mergeBullpenStage2To3StrategyOutputs, readBullpenStage2To3StrategyMetadata, readBullpenStage2UniverseStatus, type BullpenStage2To3StrategyMetadata, type BullpenStage2UniverseStatus } from "./bullpenStage2To3Strategy";
import { StageOneOutputDialog, RunDetailDialog, SimpleInfoDialog, StageTwoLlmRunDetailsDialog, StageTwoBypassDialog, StageTwoInvestEventsDialog, InvestMetricDetailsDialog, Stage3PreviewDialog } from "./BullpenScheduleLazyDetails";
import { type ScanCandidateDialogState, type InvestMetricDialogState, type Stage3PreviewDialogState, type RunDetailDialogState, type StageTwoInvestEventsDialogState, type StageTwoLlmRunDialogState, type StageTwoBypassDialogState, isRequestAbort, readStageOutputNumber, mergeInvestStageDecisionRows, formatIstDateTime, formatMoney, type ScanCandidateDialogMode, buildRunDetailScanCandidateDialogState, getRunSummaryDetails, getInvestStageMetric, readStageOutputString, readStageOutputBoolean, RUN_TIMER_INTERVAL_MS, getInvestStageExecutionSteps, getInvestStageCounters, isRecord, getWorkflowToneClasses, stageOneNotEvaluated, getStageOneStats, StageOneRunStats, formatStageLastRunLabel, StageTwoRunStats, InvestExecutionStepsSummary, ErrorCodeWithDetails, type WorkflowStageView, formatOddsPercent, calculateDaysUntilClose, formatReturnsPerDay, getLastInvestExecutionStep, findRunStage } from "./bullpenScheduleShared";

export const BullpenStage2To3StrategyDialog = dynamic(
  () =>
    import("./BullpenStage2To3StrategyDialog").then(
      (module) => module.BullpenStage2To3StrategyDialog,
    ),
  { ssr: false },
);

export const BullpenEventExitStrategiesDialog = dynamic(
  () =>
    import("./BullpenEventExitStrategiesDialog").then(
      (module) => module.BullpenEventExitStrategiesDialog,
    ),
  { ssr: false },
);

export const BullpenEventHistoricalAssessmentTable = dynamic(
  () =>
    import("./BullpenEventHistoricalAssessmentTable").then(
      (module) => module.BullpenEventHistoricalAssessmentTable,
    ),
  { ssr: false },
);

export const BullpenAutoRunStageOutputDialog = dynamic(
  () =>
    import("./BullpenAutoRunStageOutputDialog").then(
      (module) => module.BullpenAutoRunStageOutputDialog,
    ),
  { ssr: false },
);

export const BULLPEN_LOGIN_COMMAND =
  "sudo -u investor -H /usr/local/bin/bullpen login --no-browser";

export const BULLPEN_LAST_LLM_TARGET_STORAGE_KEY =
  "investment-engine:bullpen-ai:last-llm-target:v1";

export type BullpenAutoRunScheduleCardProps = {
  workspaceProfile?: BullpenWorkspaceProfile;
  onRunCompleted?: () => void | Promise<void>;
  onRefreshPortfolioPositions?: () => void | Promise<void>;
  buildRunNowRequest?: () =>
    | Promise<BullpenAutoLiveRunOnceRequest | null>
    | BullpenAutoLiveRunOnceRequest
    | null;
  activePositions?: BullpenActivePositionView[];
  activePositionsSummary?: BullpenPositionsSummary | null;
  positionsSource?: BullpenPositionsSource | null;
  positionsUpdatedAt?: string | null;
  positionsLineage?: BullpenPositionsSnapshotLineage | null;
  activePositionQuestions?: BullpenQuestionRow[];
  hasActivePositionsSnapshot?: boolean;
  recentDecisions?: BullpenAutoLiveDecision[];
  onOpenScanFilters?: () => void;
  independentScanSnapshot?: BullpenScanSnapshot | null;
  onRunIndependentStageOne?: (
    signal?: AbortSignal,
    onProgress?: (progress: BullpenIndependentStageOneProgress) => void,
  ) => Promise<{
    snapshot: BullpenScanSnapshot | null;
    error: string | null;
  }>;
  onSummaryUpdated?: (payload: {
    summary: BullpenAutoLiveSummaryResponse;
    run: BullpenAutoLiveRun | null;
    pendingRunId: string | null;
  }) => void;
};

export type BullpenIndependentStageOneProgress = {
  scannedMarkets: number;
  completedPages: number;
  currentPage: number;
  retryCount: number;
  status: "scanning" | "retrying";
  lastUpdatedAt: string;
  message: string;
};

export type ActionState =
  | "enable"
  | "invest-now"
  | "start-now"
  | "stop"
  | "pause-run"
  | "resume-run"
  | "kill-run"
  | "retry-stage3"
  | null;

export type ErrorState = {
  message: string;
  details: string | null;
};

export type UniversalScanTriggerStatus = {
  next_run_at?: string | null;
  last_run_at?: string | null;
  last_completed_at?: string | null;
  last_completed_run_started_at?: string | null;
  last_failed_at?: string | null;
  last_error?: string | null;
  running?: boolean;
};

export function triggerOutcome(run: BullpenAutoLiveHistoryItem | undefined) {
  if (!run) return "Unknown · no recorded trigger";
  if (run.status === "running" || run.status === "confirming") {
    return "In progress";
  }
  if (run.status === "completed" || run.status === "partial_success") {
    return "Passed";
  }
  return "Failed";
}

export function triggerOutcomeClasses(run: BullpenAutoLiveHistoryItem | undefined) {
  const outcome = triggerOutcome(run);
  if (outcome === "Passed") return "text-emerald-700";
  if (outcome === "Failed") return "text-rose-700";
  if (outcome === "In progress") return "text-sky-700";
  return "text-slate-500";
}

export type PreviewCandidateRow =
  NonNullable<
    NonNullable<BullpenAutoLiveRunOnceRequest["console_profile"]>["candidate_rows"]
  >[number];

export type PreviewExitEntry =
  ReturnType<typeof buildBullpenInvestmentDisplay>["activePositionsNeedingAttention"][number];

export const STAGE_TWO_BYPASS_REASON =
  "Stage 3 has already started while Stage 2 is still marked In Queue because this run is reusing the latest saved Stage 2-qualified output instead of launching a new LLM review for the current pass.";

export const STAGE_TWO_BYPASS_RECTIFICATION_STEPS = [
  "Open Stage 2 Output or the latest completed run details and confirm the saved Stage 2 top-10 rows are fresh enough for the current investment decision.",
  "If fresh LLM review is required, stop the active Stage 3 pass, run Stage 2 · Run LLM again, and wait until the Stage 2 container shows Finished.",
  "After Stage 2 finishes, rerun Stage 3 · Exit and Invest so orders are planned from the newly completed Stage 2 snapshot.",
];

export function normalizePreviewConfidence(
  value: string | null | undefined,
): BullpenAutoLiveDecision["confidence"] {
  if (value === "Low" || value === "Medium" || value === "High") {
    return value;
  }
  return "High";
}

export function normalizePreviewEvidenceStatus(
  value: string | null | undefined,
): BullpenAutoLiveDecision["evidence_status"] {
  if (value === "Low" || value === "Moderate" || value === "Strong") {
    return value;
  }
  return "Strong";
}

export function normalizePreviewOutcomeSide(
  value: string | null | undefined,
): BullpenAutoLiveOutcomeSide {
  return value?.trim().toUpperCase() === "YES" ? "YES" : "NO";
}

export function computePreviewHoursRemaining(closeTime: string | null | undefined) {
  if (!closeTime) return null;
  const closeMs = Date.parse(closeTime);
  if (!Number.isFinite(closeMs)) return null;
  return Math.max(0, Number(((closeMs - Date.now()) / (60 * 60 * 1000)).toFixed(2)));
}

export function resolvePreviewBuySide(
  candidate: Pick<PreviewCandidateRow, "llm_yes_odds" | "llm_no_odds">,
): BullpenAutoLiveDecision["side"] {
  const yesOdds = candidate.llm_yes_odds ?? Number.NEGATIVE_INFINITY;
  const noOdds = candidate.llm_no_odds ?? Number.NEGATIVE_INFINITY;
  return yesOdds > noOdds ? "YES" : "NO";
}

export function buildStage3PreviewBuyDecision({
  sourceRun,
  candidate,
  index,
}: {
  sourceRun: BullpenAutoLiveRun | null;
  candidate: PreviewCandidateRow;
  index: number;
}): BullpenAutoLiveDecision {
  const side = resolvePreviewBuySide(candidate);
  const currentSideOdds =
    side === "YES" ? candidate.current_yes_odds : candidate.current_no_odds;
  const fairYesOdds = candidate.llm_yes_odds ?? null;
  const fairNoOdds = candidate.llm_no_odds ?? null;
  const fairSideOdds = side === "YES" ? fairYesOdds : fairNoOdds;
  const limitPriceCents = Math.max(
    0.01,
    Number((currentSideOdds ?? fairSideOdds ?? 1).toFixed(2)),
  );
  const orderSizeUsd =
    typeof candidate.amount_to_be_invested === "number" &&
    Number.isFinite(candidate.amount_to_be_invested)
      ? Math.max(0, Number(candidate.amount_to_be_invested.toFixed(2)))
      : 0;
  const hoursRemaining = computePreviewHoursRemaining(candidate.close_time);
  const fairProbability = fairSideOdds ?? 0;
  const currentProbability = currentSideOdds ?? fairProbability;
  const createdAt =
    sourceRun?.completed_at ?? sourceRun?.started_at ?? new Date().toISOString();

  return {
    id: `preview-buy-${candidate.market_id}-${side.toLowerCase()}`,
    run_id: sourceRun?.id ?? "stage3-preview",
    created_at: createdAt,
    updated_at: createdAt,
    market_id: candidate.market_id,
    market_title: candidate.market_title,
    market_url: candidate.market_url,
    slug: candidate.slug,
    close_time: candidate.close_time,
    theme: candidate.theme || "Uncategorized",
    side,
    decision: "BUY_NEW",
    risk_status: "Ready",
    price_cents: limitPriceCents,
    current_yes_odds: candidate.current_yes_odds ?? null,
    current_no_odds: candidate.current_no_odds ?? null,
    fair_probability_pct: fairProbability,
    fair_yes_probability_pct: fairYesOdds,
    fair_no_probability_pct: fairNoOdds,
    edge_pp: Number((fairProbability - currentProbability).toFixed(2)),
    score: orderSizeUsd,
    confidence: normalizePreviewConfidence(candidate.confidence),
    evidence_status: normalizePreviewEvidenceStatus(candidate.evidence_status),
    event_state: candidate.event_state ?? "Watching",
    adjudication_required: Boolean(candidate.adjudication_required),
    disagreement_level: candidate.llm_disagreement_level ?? null,
    current_exposure_usd: 0,
    target_exposure_usd: orderSizeUsd,
    realized_pnl_usd: null,
    hours_remaining: hoursRemaining,
    key_evidence: [],
    red_flags: [],
    rationale: candidate.rules ?? candidate.market_context ?? null,
    reason:
      "Queued from the saved Stage 2 top-10 list. Stage 3 refreshes live cash plus occupied slots and can resize this buy before submission.",
    summary:
      "Queued from the saved Stage 2 top-10 list for Stage 3 Step 2.",
    stage3_result: "SELECTED",
    stage3_result_reason:
      "Saved Stage 2 top-10 candidate is queued for Stage 3 Step 2.",
    stage3_final_rank: index + 1,
    stage3_max_positions: DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MAX_POSITIONS,
    order_plan: {
      id: `preview-order-buy-${candidate.market_id}-${side.toLowerCase()}`,
      action: "buy",
      side,
      order_type: "limit",
      status: "planned",
      market_id: candidate.market_id,
      market_title: candidate.market_title,
      order_size_usd: orderSizeUsd,
      shares:
        orderSizeUsd > 0
          ? Number(
              (orderSizeUsd / Math.max(limitPriceCents / 100, 0.01)).toFixed(6),
            )
          : 0,
      limit_price_cents: limitPriceCents,
      refreshed_market_price_cents: currentSideOdds ?? null,
      max_slippage_cents: 0,
      dry_run: false,
      detail:
        "Saved Stage 2 top-10 row is queued for Stage 3 Step 2. Live sizing is refreshed from post-exit cash plus open slots before submission.",
      execution_response: null,
      created_at: createdAt,
      executed_at: null,
    },
    exit_signals: [],
    exit_state: "ACTIVE",
    llm_outputs: candidate.llm_outputs ?? [],
    stage_results: [],
    guardrail_checks: [],
  };
}

export function buildStage3PreviewSellDecision({
  sourceRun,
  entry,
  question,
}: {
  sourceRun: BullpenAutoLiveRun | null;
  entry: PreviewExitEntry;
  question: BullpenQuestionRow | null;
}): BullpenAutoLiveDecision {
  const position = entry.position;
  const side = normalizePreviewOutcomeSide(
    position.heldSide ?? position.outcome,
  );
  const currentSideOdds = side === "YES" ? position.yesOdds : position.noOdds;
  const fairYesOdds = question?.llmYesOdds ?? null;
  const fairNoOdds = question?.llmNoOdds ?? null;
  const fairSideOdds = side === "YES" ? fairYesOdds : fairNoOdds;
  const limitPriceCents = Math.max(
    0.01,
    Number(
      (
        (typeof position.currentPrice === "number"
          ? position.currentPrice * 100
          : currentSideOdds ?? fairSideOdds ?? 1)
      ).toFixed(2),
    ),
  );
  const orderSizeUsd = Math.max(
    0,
    Number(
      (
        entry.estimatedFreeableValue ??
        position.currentValue ??
        position.costBasis ??
        0
      ).toFixed(2),
    ),
  );
  const createdAt =
    sourceRun?.completed_at ?? sourceRun?.started_at ?? new Date().toISOString();
  const reasonSummary =
    entry.reasonBadges.length > 0
      ? entry.reasonBadges.join(" + ")
      : "Event Exit";

  return {
    id: `preview-sell-${position.marketId}-${side.toLowerCase()}`,
    run_id: sourceRun?.id ?? "stage3-preview",
    created_at: createdAt,
    updated_at: createdAt,
    market_id: position.marketId,
    market_title: position.marketTitle,
    market_url: position.marketUrl,
    slug: position.slug,
    close_time: position.closeTime,
    theme: question?.category || "Uncategorized",
    side,
    decision: "EXIT",
    risk_status: "Ready",
    price_cents: limitPriceCents,
    current_yes_odds: position.yesOdds ?? null,
    current_no_odds: position.noOdds ?? null,
    fair_probability_pct: fairSideOdds ?? currentSideOdds ?? 0,
    fair_yes_probability_pct: fairYesOdds,
    fair_no_probability_pct: fairNoOdds,
    edge_pp: 0,
    score: orderSizeUsd,
    confidence: normalizePreviewConfidence(
      question?.llmBreakdown.find((item) => item.confidence)?.confidence ?? null,
    ),
    evidence_status: normalizePreviewEvidenceStatus(question?.evidenceStatus),
    event_state: question?.eventState ?? "Watching",
    adjudication_required: Boolean(question?.adjudicationRequired),
    disagreement_level: question?.llmDisagreementLevel ?? null,
    current_exposure_usd: position.currentValue ?? position.costBasis ?? 0,
    target_exposure_usd: 0,
    realized_pnl_usd: position.unrealizedPnl ?? null,
    hours_remaining: computePreviewHoursRemaining(position.closeTime),
    key_evidence: [],
    red_flags: [],
    rationale: question?.rules ?? position.rules ?? position.marketContext ?? null,
    reason: `Queued from the current Event Exits list (${reasonSummary}). Stage 3 submits this sell before any new buys.`,
    summary: `Queued Event Exit (${reasonSummary}) for Stage 3 Step 1.`,
    stage3_result: null,
    stage3_result_reason: null,
    stage3_final_rank: null,
    stage3_max_positions: DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MAX_POSITIONS,
    order_plan: {
      id: `preview-order-sell-${position.marketId}-${side.toLowerCase()}`,
      action: "sell",
      side,
      order_type: "limit",
      status: "planned",
      market_id: position.marketId,
      market_title: position.marketTitle,
      order_size_usd: orderSizeUsd,
      shares: position.shares,
      limit_price_cents: limitPriceCents,
      refreshed_market_price_cents: currentSideOdds ?? null,
      max_slippage_cents: 0,
      dry_run: false,
      detail:
        "Current Event Exit row is queued for Stage 3 Step 1 and will be submitted before any Stage 3 buy.",
      execution_response: null,
      created_at: createdAt,
      executed_at: null,
    },
    exit_signals: entry.exitSignals,
    exit_state: entry.exitState,
    llm_outputs: [],
    stage_results: [],
    guardrail_checks: [],
  };
}

export function buildStage3PreviewDialogState({
  sourceRun,
  plan,
  attentionEntries,
  activePositionQuestionByKey,
  allowExitOnlyFallback,
}: {
  sourceRun: BullpenAutoLiveRun | null;
  plan: ReturnType<typeof buildBullpenStage3OnlyInvestExecutionPlan>;
  attentionEntries: PreviewExitEntry[];
  activePositionQuestionByKey: ReturnType<
    typeof buildBullpenInvestmentDisplay
  >["activePositionQuestionByKey"];
  allowExitOnlyFallback: boolean;
}): Stage3PreviewDialogState | null {
  const previewSellEntries = attentionEntries.filter(
    (entry) => entry.exitState === "EVENT_EXIT_PLANNED",
  );
  const previewSellDecisions = previewSellEntries.map((entry) =>
    buildStage3PreviewSellDecision({
      sourceRun,
      entry,
      question: activePositionQuestionByKey.get(entry.position.key) ?? null,
    }),
  );
  const previewBuyRows = plan.request?.console_profile?.candidate_rows ?? [];
  const previewBuyDecisions = previewBuyRows.map((candidate, index) =>
    buildStage3PreviewBuyDecision({
      sourceRun,
      candidate,
      index,
    }),
  );
  const decisions = [...previewSellDecisions, ...previewBuyDecisions];

  if (decisions.length === 0) {
    return null;
  }

  const baseRequest =
    plan.request ??
    (allowExitOnlyFallback
      ? {
          console_profile: {
            source_label: "Saved Stage 2 output",
            source_url: null,
            scanned_at:
              sourceRun?.completed_at ?? sourceRun?.started_at ?? new Date().toISOString(),
            snapshot_id: sourceRun?.id ?? "stage3-preview",
            mode: "stage-3-invest-only",
            total_candidates: 0,
            candidate_rows_prefiltered: true,
            reuse_saved_llm_outputs: true,
            stage2_actionable_exit_market_ids: [],
            stage2_actionable_buy_market_ids: [],
            candidate_rows: [],
          },
        }
      : null);
  const baseConsoleProfile = baseRequest?.console_profile ?? null;
  const request: BullpenAutoLiveRunOnceRequest | null = baseConsoleProfile
    ? {
        ...baseRequest,
        console_profile: {
          ...baseConsoleProfile,
          stage2_actionable_exit_market_ids: [
            ...new Set(previewSellDecisions.map((decision) => decision.market_id)),
          ],
          stage2_actionable_buy_market_ids: [
            ...new Set(previewBuyDecisions.map((decision) => decision.market_id)),
          ],
        },
      }
    : null;

  return {
    sourceRun,
    request,
    decisions,
    plannedOrders: decisions.length,
    sellPlannedOrders: previewSellDecisions.length,
    buyPlannedOrders: previewBuyDecisions.length,
  };
}

export function resolveStageTwoLlmRunDialogState({
  currentState,
  fallbackRun,
  summary,
}: {
  currentState: StageTwoLlmRunDialogState | null;
  fallbackRun: BullpenAutoLiveRun | null;
  summary: BullpenAutoLiveSummaryResponse | null;
}): StageTwoLlmRunDialogState | null {
  if (!currentState) return null;

  const selectedRunId = currentState.run?.id ?? fallbackRun?.id ?? null;
  const selectedRun =
    (selectedRunId
      ? [
          ...(summary?.recent_runs ?? []),
          summary?.latest_run ?? null,
          fallbackRun,
          currentState.run,
        ].find((run) => run?.id === selectedRunId)
      : null) ??
    currentState.run ??
    fallbackRun;

  const stage = selectedRun
    ? (buildBullpenAutoRunWorkflowView(selectedRun).stages.find(
        (workflowStage) => workflowStage.key === "llm",
      ) ?? currentState.stage)
    : currentState.stage;

  return {
    run: selectedRun,
    stage,
    decisions: selectedRun?.id
      ? (summary?.recent_decisions.filter(
          (decision) => decision.run_id === selectedRun.id,
        ) ?? currentState.decisions)
      : currentState.decisions,
  };
}

export function preserveCompletedStageEvidence(
  previousSummary: BullpenAutoLiveSummaryResponse | null,
  nextSummary: BullpenAutoLiveSummaryResponse,
  trackedRun: BullpenAutoLiveRun | null,
) {
  if (!previousSummary || !trackedRun) return nextSummary;
  const previousRun = [
    previousSummary.latest_run,
    ...previousSummary.recent_runs,
  ].find((run) => run?.id === trackedRun.id);
  if (!previousRun) return nextSummary;

  const mergedRun = mergeBullpenConsoleRunProjection({
    existing: previousRun,
    projected: trackedRun,
    projectionAvailable: true,
  });
  return {
    ...nextSummary,
    latest_run:
      nextSummary.latest_run?.id === mergedRun.id
        ? mergedRun
        : nextSummary.latest_run,
    recent_runs: nextSummary.recent_runs.map((run) =>
      run.id === mergedRun.id ? mergedRun : run,
    ),
  };
}

export type Stage2To3StrategyDialogState = {
  sourceKey: string;
  strategyMetadata: BullpenStage2To3StrategyMetadata;
  universeStatus: BullpenStage2UniverseStatus;
};

export const CONSOLE_PROFILE_ID = "bullpen_console_top10";

export const DEFAULT_CONSOLE_ORDER_USD = 5;

export const CONSOLE_MAX_ACTIVE_POSITIONS =
  DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MAX_POSITIONS;

export const DEFAULT_LLM_EXECUTION_MODE: BullpenLlmExecutionMode = "chunked_parallel";

export const DEFAULT_LLM_EVENTS_PER_PROMPT = 20;

export const POLL_INTERVAL_MS = 2_000;

export const AUTO_RUN_STATUS_TIMEOUT_MS = 12_000;

export const AUTO_RUN_AUTH_BOOTSTRAP_TIMEOUT_MS = 5_000;

export const EVENT_TRENDS_CLIENT_GRACE_MS = 2_000;

export const AUTO_RUN_STATUS_IDLE_REVALIDATE_MS = 60_000;

export const AUTO_RUN_STATUS_MAX_AUTOMATIC_RETRIES = 3;

export function markBullpenAutoRunPerformance(name: string) {
  if (typeof performance === "undefined") return;
  if (performance.getEntriesByName(name, "mark").length > 0) return;
  performance.mark(name);
}

export const persistedAutoRunStatusRequestDedupers = new Map<
  string,
  ReturnType<
    typeof createAbortableBullpenAutoRunRequestDeduper<BullpenAutoRunStatusData>
  >
>();

export function getPersistedAutoRunStatus(scope: string, signal: AbortSignal) {
  let dedupeRequest = persistedAutoRunStatusRequestDedupers.get(scope);
  if (!dedupeRequest) {
    dedupeRequest = createAbortableBullpenAutoRunRequestDeduper<
      BullpenAutoRunStatusData
    >((requestSignal) =>
      apiService
        .getBullpenAutoLiveStatus({
          signal: requestSignal,
          timeoutMs: AUTO_RUN_STATUS_TIMEOUT_MS,
        })
        .then((payload) => {
          const normalized = normalizeBullpenAutoRunStatusData(payload);
          if (!normalized) {
            throw new Error("Auto-run status returned an invalid response.");
          }
          return normalized;
        }),
    );
    persistedAutoRunStatusRequestDedupers.set(scope, dedupeRequest);
  }

  return dedupeRequest(signal);
}

export function readBrowserCachedAutoRunStatus(cacheKey: string | null) {
  if (typeof window === "undefined" || !cacheKey) return null;
  return readCachedBullpenAutoRunStatus(window.sessionStorage, {}, cacheKey);
}

export function saveBrowserCachedAutoRunStatus(
  data: BullpenAutoRunStatusData,
  cacheKey: string | null,
) {
  if (typeof window === "undefined" || !cacheKey) return null;
  const savedAt = Date.now();
  writeCachedBullpenAutoRunStatus(
    window.sessionStorage,
    data,
    savedAt,
    cacheKey,
  );
  return savedAt;
}

export function formatScheduleInputFromDate(date: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour12: false,
  }).formatToParts(date);
  const byType = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${byType.hour}:${byType.minute}:${byType.second} ${byType.day} ${byType.month}, ${byType.year}`;
}

export function formatDateTimeLocalValue(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const byType = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${byType.year}-${byType.month}-${byType.day}T${byType.hour}:${byType.minute}`;
}

export function parseScheduleInputToDateTimeLocalValue(value: string) {
  const normalized = value.trim();
  if (!normalized || normalized.toLowerCase() === "now") {
    return formatDateTimeLocalValue(new Date());
  }

  const match = normalized.replace(",", "").match(
    /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/,
  );
  if (!match) {
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime())
      ? formatDateTimeLocalValue(new Date())
      : formatDateTimeLocalValue(parsed);
  }

  const monthIndex = new Date(`${match[5]} 1, 2000`).getMonth();
  if (Number.isNaN(monthIndex)) return formatDateTimeLocalValue(new Date());

  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[4], 10);
  const year = Number.parseInt(match[6], 10);
  if (![hour, minute, day, year].every(Number.isFinite)) {
    return formatDateTimeLocalValue(new Date());
  }

  const datePart = `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(
    day,
  ).padStart(2, "0")}`;
  const timePart = `${String(hour).padStart(2, "0")}:${String(minute).padStart(
    2,
    "0",
  )}`;
  return `${datePart}T${timePart}`;
}

export function formatScheduleInputFromDateTimeLocal(value: string) {
  if (!value) return "";
  const [datePart, timePart] = value.split("T");
  if (!datePart || !timePart) return value;
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = timePart.split(":").map(Number);
  const date = new Date(
    Date.UTC(year, month - 1, day, hour - 5, minute - 30, 0),
  );
  return formatScheduleInputFromDate(date);
}

export function normalizeError(error: unknown) {
  if (error instanceof APIError) {
    const { statusText, message, details } = splitApiErrorSummary(error);
    return {
      message,
      details: [statusText, details].filter(Boolean).join(" • ") || null,
    } satisfies ErrorState;
  }

  return {
    message:
      error === null || error === undefined
        ? "The dashboard refresh failed without returning error details."
        : formatUnknownError(error),
    details: null,
  } satisfies ErrorState;
}

export function formatOddsPair(yesOdds: number | null, noOdds: number | null) {
  return (
    <div className="space-y-1 text-xs font-semibold">
      <div>
        <span className="text-slate-500">Yes:</span>{" "}
        {formatOddsPercent(yesOdds)}
      </div>
      <div>
        <span className="text-slate-500">No:</span> {formatOddsPercent(noOdds)}
      </div>
    </div>
  );
}

export type ConsoleTradeAmountView = {
  tradeAmountUsd: number | null;
  cashInHandUsd: number | null;
  activePositions: number | null;
  availableSlots: number | null;
  maxPositions: number;
  source: "live" | "last-calculated" | "unavailable";
};

export function calculateConsoleTradeAmountUsd(
  cashInHandUsd: number,
  availableSlots: number,
) {
  if (cashInHandUsd <= 0 || availableSlots <= 0) return 0;
  return Number((cashInHandUsd / availableSlots).toFixed(2));
}

export function resolvePositiveConsoleOrderUsd(
  ...candidates: Array<number | null | undefined>
) {
  return (
    candidates.find(
      (candidate): candidate is number =>
        typeof candidate === "number" &&
        Number.isFinite(candidate) &&
        candidate > 0,
    ) ?? DEFAULT_CONSOLE_ORDER_USD
  );
}

export function buildConsoleTradeAmountView({
  cashInHandUsd,
  activePositions,
  lastCalculatedTradeAmountUsd,
  lastCalculatedCashInHandUsd,
  lastCalculatedActivePositions,
  lastCalculatedAvailableSlots,
  lastCalculatedMaxPositions,
}: {
  cashInHandUsd: number | null;
  activePositions: number | null;
  lastCalculatedTradeAmountUsd: number | null;
  lastCalculatedCashInHandUsd: number | null;
  lastCalculatedActivePositions: number | null;
  lastCalculatedAvailableSlots: number | null;
  lastCalculatedMaxPositions: number | null;
}): ConsoleTradeAmountView {
  if (cashInHandUsd !== null && activePositions !== null) {
    const availableSlots = Math.max(
      0,
      CONSOLE_MAX_ACTIVE_POSITIONS - activePositions,
    );
    return {
      tradeAmountUsd: calculateConsoleTradeAmountUsd(
        cashInHandUsd,
        availableSlots,
      ),
      cashInHandUsd,
      activePositions,
      availableSlots,
      maxPositions: CONSOLE_MAX_ACTIVE_POSITIONS,
      source: "live",
    };
  }

  if (lastCalculatedTradeAmountUsd !== null) {
    return {
      tradeAmountUsd: lastCalculatedTradeAmountUsd,
      cashInHandUsd: lastCalculatedCashInHandUsd,
      activePositions: lastCalculatedActivePositions,
      availableSlots: lastCalculatedAvailableSlots,
      maxPositions: lastCalculatedMaxPositions ?? CONSOLE_MAX_ACTIVE_POSITIONS,
      source: "last-calculated",
    };
  }

  return {
    tradeAmountUsd: null,
    cashInHandUsd: null,
    activePositions: activePositions,
    availableSlots:
      activePositions === null
        ? null
        : Math.max(0, CONSOLE_MAX_ACTIVE_POSITIONS - activePositions),
    maxPositions: CONSOLE_MAX_ACTIVE_POSITIONS,
    source: "unavailable",
  };
}

export function parseLlmEventsPerPrompt(value: string) {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
    return null;
  }
  return parsed;
}

export function buildLlmExecutionSummary(
  mode: BullpenLlmExecutionMode,
  eventsPerPrompt: number,
) {
  if (mode === "single_combined") {
    return "Stage 2 will use Single combined mode on the next run.";
  }
  return `Stage 2 will use Batched parallel with up to ${eventsPerPrompt} events per prompt on the next run.`;
}

export function areProviderTargetsEqual(
  left: ProviderModelTarget[],
  right: ProviderModelTarget[],
) {
  if (left.length !== right.length) return false;
  return left.every((target, index) => {
    const other = right[index];
    return other?.provider === target.provider && other?.model === target.model;
  });
}

export function serializeProviderTargets(targets: ProviderModelTarget[]) {
  return JSON.stringify(
    targets.map((target) => ({
      provider: target.provider,
      model: target.model,
    })),
  );
}

export function normalizeStoredProviderTarget(
  value: unknown,
): ProviderModelTarget | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const provider =
    typeof (value as { provider?: unknown }).provider === "string"
      ? (value as { provider: string }).provider.trim()
      : "";
  const model =
    typeof (value as { model?: unknown }).model === "string"
      ? (value as { model: string }).model.trim()
      : "";
  if (!provider || !model) {
    return null;
  }

  return { provider, model };
}

export function readLegacyBullpenLlmTargetsFromStorage() {
  if (typeof window === "undefined") return [];

  try {
    const raw = window.localStorage.getItem(BULLPEN_LAST_LLM_TARGET_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    const candidateTargets = Array.isArray(parsed)
      ? parsed
      : parsed
        ? [parsed]
        : [];
    const normalizedTargets: ProviderModelTarget[] = [];
    const seenKeys = new Set<string>();

    candidateTargets.forEach((target) => {
      const normalizedTarget = normalizeStoredProviderTarget(target);
      if (!normalizedTarget) return;

      const key = `${normalizedTarget.provider.toLowerCase()}::${normalizedTarget.model.toLowerCase()}`;
      if (seenKeys.has(key)) return;

      seenKeys.add(key);
      normalizedTargets.push(normalizedTarget);
    });

    return normalizedTargets;
  } catch {
    return [];
  }
}

export function resolveCanonicalStage2TargetSelection(
  selectedTargets: ProviderModelTarget[],
  serverTargets: ProviderModelTarget[],
  legacyTargets: ProviderModelTarget[] | null,
) {
  if (selectedTargets.length > 0) {
    return selectedTargets;
  }
  if (serverTargets.length > 0) {
    return serverTargets;
  }
  return legacyTargets ?? [];
}

export function missingStage2TargetsError(): ErrorState {
  return {
    message:
      "Select at least one LLM before starting Auto-Live Stage 2. The saved target list is empty.",
    details: null,
  };
}

export function buildWorkflowPortfolioPositionFallback(
  positions: BullpenActivePositionView[],
): WorkflowStageView["activePositionsFound"] {
  return positions.map((position) => ({
    positionKey: position.key,
    marketId: position.marketId,
    marketTitle: position.marketTitle,
    marketUrl: position.marketUrl,
    slug: position.slug,
    theme: null,
    side: position.heldSide ?? position.outcome ?? null,
    shares: position.shares,
    exposureUsd: position.currentValue ?? position.costBasis,
    averagePriceCents:
      position.averagePrice === null ? null : position.averagePrice * 100,
    currentYesOdds: position.yesOdds,
    currentNoOdds: position.noOdds,
    closeTime: position.closeTime,
    conditionId: position.conditionId,
    isClaimable: position.isClaimable,
    classification: position.economicClassification,
    returnsPerDay: position.returnsPerDay,
  }));
}

export function readIndependentScanNumber(value: string | null) {
  if (!value) return null;
  const parsed = Number(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildIndependentStageOneView(
  snapshot: BullpenScanSnapshot,
  positions: BullpenActivePositionView[],
): WorkflowStageView {
  const toCandidate = (
    question: BullpenQuestion,
    scanStatus: "passed" | "filtered",
    filterReasons: string[] = [],
  ): WorkflowStageView["scanCandidates"][number] => ({
    questionId: question.questionId ?? question.id,
    marketId: question.marketId ?? question.id,
    conditionId: question.conditionId ?? null,
    question: question.question,
    marketUrl: question.marketUrl ?? question.sourceUrl ?? null,
    slug: question.slug,
    closeTime: question.closeTime,
    theme: question.category || null,
    currentYesOdds: question.yesOdds,
    currentNoOdds: question.noOdds,
    volumeUsd: readIndependentScanNumber(question.volume),
    liquidityUsd: readIndependentScanNumber(question.liquidity),
    bestBidCents: null,
    bestAskCents: null,
    spreadCents: null,
    returnsPerDay: null,
    forceInclude: false,
    forceIncludedPosition: false,
    selected: null,
    rules: null,
    eventDescription: null,
    marketContext: null,
    resolutionSource: null,
    preflightEvidenceBlock: null,
    scanStatus,
    filterReasons,
  });
  const acceptedCandidates = snapshot.questions.map((question) =>
    toCandidate(question, "passed"),
  );
  const rejectedCandidates = (snapshot.rejectedQuestions ?? []).map(
    (question) =>
      toCandidate(question, "filtered", question.filterReasons),
  );
  const rejectedCandidateCount =
    snapshot.totalRejectedQuestions ?? rejectedCandidates.length;
  const acceptedCandidateCount =
    snapshot.totalAcceptedQuestions ?? acceptedCandidates.length;

  return {
    key: "scan",
    title: "Stage 1 · Bullpen Scan",
    subtitle: "Independent Stage 1 scan",
    tone: snapshot.isPartial ? "yellow" : "green",
    state: "finished",
    detail: snapshot.isPartial
      ? snapshot.warning ?? "Independent Stage 1 scan stopped before completion; partial results were saved."
      : "Independent Stage 1 scan completed without running Stage 2 or Stage 3.",
    progressCommentary: [
      `${snapshot.totalCandidates} Bullpen events scanned.`,
      `${acceptedCandidateCount} events passed the saved filters.`,
      `${rejectedCandidateCount} events were filtered out.`,
      ...(snapshot.isPartial && snapshot.pagesScanned
        ? [`Partial snapshot saved after ${snapshot.pagesScanned} completed pages.`]
        : []),
    ],
    progressLabel: snapshot.isPartial
      ? `${snapshot.totalCandidates} events scanned before interruption`
      : `${snapshot.totalCandidates}/${snapshot.totalCandidates} events`,
    progressPercent: 100,
    isCurrent: false,
    timerStartedAt: snapshot.scannedAt,
    timerCompletedAt: snapshot.scannedAt,
    scanCandidates: acceptedCandidates,
    scannedCandidates: [...acceptedCandidates, ...rejectedCandidates],
    activePositionsFound: buildWorkflowPortfolioPositionFallback(positions),
    inputs: { filters: snapshot.filters },
    outputs: {
      independent_stage1_scan: true,
      snapshot_id: snapshot.snapshotId,
      scan_export_id: snapshot.scanExportId ?? null,
      source_scan_export_id: snapshot.sourceScanExportId ?? null,
      source_scan_completed_at: snapshot.sourceScanCompletedAt ?? null,
      filters_completed_at: snapshot.filtersCompletedAt ?? snapshot.scannedAt,
      scanned_at: snapshot.scannedAt,
      scanned_candidates: snapshot.totalCandidates,
      total_items: snapshot.totalCandidates,
      accepted_candidates_count: acceptedCandidateCount,
      rejected_candidates_count: rejectedCandidateCount,
      retained_accepted_candidates_count: acceptedCandidates.length,
      retained_rejected_candidates_count: rejectedCandidates.length,
      total_rejected_candidates_count: rejectedCandidateCount,
      partial_scan: Boolean(snapshot.isPartial),
      interruption_reason: snapshot.interruptionReason ?? null,
      pages_scanned: snapshot.pagesScanned ?? null,
      accepted_candidates: acceptedCandidates,
      rejected_candidates: rejectedCandidates,
      scan_source_label: snapshot.sourceLabel,
      scan_source_url: snapshot.sourceUrl,
      active_positions_total: positions.length,
    },
  };
}

export function getStageOneEvidenceTimestamp(stage: WorkflowStageView) {
  const timestamps = [
    readStageOutputString(stage.outputs.filters_completed_at),
    stage.timerCompletedAt,
    readStageOutputString(stage.outputs.scanned_at),
    readStageOutputString(stage.outputs.source_scan_completed_at),
    stage.timerStartedAt,
  ];
  for (const timestamp of timestamps) {
    const parsed = timestamp ? Date.parse(timestamp) : Number.NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NaN;
}

export function selectStageOneDisplayStage({
  workflowStage,
  independentStage,
  preferIndependent,
}: {
  workflowStage: WorkflowStageView;
  independentStage: WorkflowStageView | null;
  preferIndependent: boolean;
}) {
  if (!preferIndependent || independentStage === null) return workflowStage;
  const workflowTimestamp = getStageOneEvidenceTimestamp(workflowStage);
  const independentTimestamp = getStageOneEvidenceTimestamp(independentStage);
  if (!Number.isFinite(workflowTimestamp)) return independentStage;
  if (!Number.isFinite(independentTimestamp)) return workflowStage;
  return independentTimestamp >= workflowTimestamp
    ? independentStage
    : workflowStage;
}

export function resolveStage2To3StrategyDialogOutputs(
  run: BullpenAutoLiveRun | null,
  primaryOutputs: Record<string, unknown> | null,
) {
  const llmStage = findRunStage(run, "llm", 2);
  const investStage = findRunStage(run, "invest", 3);
  const rankingStage =
    run?.stage_results.find((stage) => stage.stage_number === 6) ?? null;

  return mergeBullpenStage2To3StrategyOutputs(
    isRecord(llmStage?.outputs) ? llmStage.outputs : null,
    isRecord(investStage?.outputs) ? investStage.outputs : null,
    isRecord(rankingStage?.outputs) ? rankingStage.outputs : null,
    primaryOutputs,
  );
}

export function readDecisionExecutionTimestamp(decision: BullpenAutoLiveDecision) {
  return (
    decision.order_plan?.executed_at?.trim() ||
    decision.updated_at?.trim() ||
    decision.created_at?.trim() ||
    null
  );
}

export function buildLatestSubmittedBuyTimestampsByMarketId(
  decisions: BullpenAutoLiveDecision[],
) {
  const lookup = new Map<string, string>();

  for (const decision of decisions) {
    if (
      decision.order_plan?.action !== "buy" ||
      !isSubmittedOrExecutedInvestOrderPlan(decision.order_plan)
    ) {
      continue;
    }

    const marketId = decision.market_id?.trim();
    const timestamp = readDecisionExecutionTimestamp(decision);
    if (!marketId || !timestamp) {
      continue;
    }

    const current = lookup.get(marketId);
    const currentMs = current ? Date.parse(current) : Number.NaN;
    const nextMs = Date.parse(timestamp);
    if (
      !current ||
      (Number.isFinite(nextMs) &&
        (!Number.isFinite(currentMs) || nextMs >= currentMs))
    ) {
      lookup.set(marketId, timestamp);
    }
  }

  return lookup;
}

export function buildLiveAlreadyInvestedRecords({
  activePositions,
  decisions,
}: {
  activePositions: BullpenActivePositionView[];
  decisions: BullpenAutoLiveDecision[];
}): BullpenStage3AlreadyInvestedRecord[] {
  const latestSubmittedBuyTimestampsByMarketId =
    buildLatestSubmittedBuyTimestampsByMarketId(decisions);
  const records = new Map<string, BullpenStage3AlreadyInvestedRecord>();

  for (const position of activePositions) {
    if (!isActiveBullpenPosition(position)) {
      continue;
    }
    const marketId = position.marketId?.trim();
    if (!marketId) {
      continue;
    }

    records.set(marketId, {
      marketId,
      timestamp: latestSubmittedBuyTimestampsByMarketId.get(marketId) ?? null,
      reason: "Already present in the Bullpen wallet for this market.",
      source: "live-position",
    });
  }

  return [...records.values()];
}

export function findGuardrailCheck(
  summary: BullpenAutoLiveSummaryResponse | null,
  guardrailId: string,
) {
  return (
    summary?.latest_guardrail_checks.find(
      (check) => check.id === guardrailId,
    ) ??
    summary?.state.latest_guardrail_checks.find(
      (check) => check.id === guardrailId,
    ) ??
    null
  );
}

export function buildQueuedInvestPreviewSteps(
  plan: Parameters<typeof buildBullpenStage3InvestPreviewSteps>[0],
  lastRun: BullpenAutoLiveRun | null,
) {
  const steps = buildBullpenStage3InvestPreviewSteps(plan);
  const lastSellStep = getLastInvestExecutionStep(lastRun, "sell");
  if (!lastSellStep) return steps;

  return steps.map((step) =>
    step.key === "sell"
      ? {
          ...step,
          plannedOrders: lastSellStep.plannedOrders,
          processedOrders: lastSellStep.processedOrders,
          submittedOrders: lastSellStep.submittedOrders,
          eventExitRows: lastSellStep.eventExitRows,
          rankingLlmPlannedOrders: lastSellStep.rankingLlmPlannedOrders,
          forcedExitPlannedOrders: lastSellStep.forcedExitPlannedOrders,
          redeemPlannedOrders: lastSellStep.redeemPlannedOrders,
          redeemProcessedOrders: lastSellStep.redeemProcessedOrders,
          redeemSubmittedOrders: lastSellStep.redeemSubmittedOrders,
          rankingLlmSubmittedOrders: lastSellStep.rankingLlmSubmittedOrders,
          forcedExitSubmittedOrders: lastSellStep.forcedExitSubmittedOrders,
        }
      : step,
  );
}

export function buildConsoleSettingsUpdate(
  consoleOrderUsd: number,
  consoleScanScope: "trending" | "full_universe",
  startAt?: string | null,
  refreshMinutes?: number | null,
  consoleLlmTargets?: ProviderModelTarget[] | null,
) {
  return {
    strategy_profile: "bullpen_console_top10" as const,
    // The live portfolio formula legitimately returns zero when every slot is
    // occupied. Settings require a positive baseline, while the worker will
    // recalculate the actual buy amount after claims and exits.
    console_order_usd: resolvePositiveConsoleOrderUsd(consoleOrderUsd),
    console_scan_scope: consoleScanScope,
    console_auto_start_at: startAt ?? null,
    console_auto_refresh_minutes: refreshMinutes ?? null,
    ...(consoleLlmTargets ? { console_llm_targets: consoleLlmTargets } : {}),
    auto_live_enabled: true,
    dry_run: false,
    allow_live_execution: true,
    require_manual_confirmation: false,
  };
}

export function buildImmediateRunSettingsUpdate(
  consoleOrderUsd: number,
  consoleScanScope: "trending" | "full_universe",
  consoleLlmTargets: ProviderModelTarget[],
) {
  return {
    strategy_profile: "bullpen_console_top10" as const,
    console_order_usd: resolvePositiveConsoleOrderUsd(consoleOrderUsd),
    console_scan_scope: consoleScanScope,
    console_llm_targets: consoleLlmTargets,
    dry_run: false,
    allow_live_execution: true,
    require_manual_confirmation: false,
  };
}

export function isConsoleProfileSelected(
  summary: BullpenAutoLiveSummaryResponse | null,
) {
  return summary?.settings.strategy_profile === CONSOLE_PROFILE_ID;
}

export function isAutoRunActive(summary: BullpenAutoLiveSummaryResponse | null) {
  return Boolean(
    summary &&
    isConsoleProfileSelected(summary) &&
    summary.settings.auto_live_enabled &&
    summary.state.running &&
    !summary.state.paused,
  );
}

export function formatRunStatusLabel(status: BullpenAutoLiveRun["status"]) {
  if (status === "running") return "Running";
  if (status === "confirming") return "Confirming";
  if (status === "completed") return "Completed";
  if (status === "partial_success") return "Partial";
  if (status === "failed") return "Failed";
  return "Skipped";
}

export function isActivelyWorkingRunStatus(
  status: BullpenAutoLiveRun["status"] | null | undefined,
) {
  return status === "running" || status === "confirming";
}

export const ACTIVE_RUN_UI_MAX_AGE_MS = 2 * 60 * 60 * 1_000;

export function isCrediblyActiveWorkflowRun(
  run: BullpenAutoLiveRun | null | undefined,
  nowMs: number,
) {
  if (!run || !isActivelyWorkingRunStatus(run.status)) return false;
  const startedAtMs = Date.parse(run.started_at ?? "");
  if (!Number.isFinite(startedAtMs)) return true;
  return nowMs - startedAtMs <= ACTIVE_RUN_UI_MAX_AGE_MS;
}

export function isUserCancelledRun(run: BullpenAutoLiveRun | null | undefined) {
  if (run?.status !== "failed") return false;
  return /cancelled by user/i.test(
    `${run.error_message ?? ""}\n${run.summary ?? ""}`,
  );
}

export function formatLatestRunSummaryTileLabel(run: BullpenAutoLiveRun | null) {
  if (!run) return "Last run";
  if (run.status === "failed") return "Last failed run";
  if (run.status === "partial_success") return "Last partial run";
  if (run.status === "skipped") return "Last skipped run";
  return "Last completed run";
}

export function runNeedsBullpenLogin(run: BullpenAutoLiveRun | null) {
  if (!run) return false;
  const searchableText = [
    run.summary,
    run.error_message,
    ...run.stage_results.flatMap((stage) => [
      stage.reason,
      JSON.stringify(stage.outputs ?? {}),
      ...stage.guardrails_checked.map((check) => check.detail),
    ]),
  ]
    .filter(Boolean)
    .join("\n");

  return (
    /bullpen login/i.test(searchableText) ||
    /login required/i.test(searchableText) ||
    /requires_login/i.test(searchableText) ||
    /auth_required/i.test(searchableText) ||
    /session expired/i.test(searchableText) ||
    /invalid refresh token/i.test(searchableText) ||
    /could not resolve your polymarket address/i.test(searchableText)
  );
}

export function runBelongsToWorkspace(
  run: BullpenAutoLiveRun | null | undefined,
  workspaceProfile: BullpenWorkspaceProfile,
) {
  if (!run) return false;
  const runWorkspace =
    run.workspace_profile ??
    run.request_context?.console_profile?.workspace_profile;
  return (runWorkspace ?? "bullpen007") === workspaceProfile;
}

export function getVisibleRun(
  summary: BullpenAutoLiveSummaryResponse | null,
  pendingRunId: string | null,
  workspaceProfile: BullpenWorkspaceProfile,
) {
  if (!summary) return null;
  if (pendingRunId) {
    const recentRun = summary.recent_runs.find(
      (run) => run.id === pendingRunId && runBelongsToWorkspace(run, workspaceProfile),
    );
    return recentRun
      ? reconcileBullpenConsoleRunCopies(recentRun, summary.latest_run)
      : summary.latest_run?.id === pendingRunId &&
          runBelongsToWorkspace(summary.latest_run, workspaceProfile)
        ? summary.latest_run
        : null;
  }
  if (
    runBelongsToWorkspace(summary.latest_run, workspaceProfile) &&
    (summary.latest_run?.status === "running" ||
      summary.latest_run?.status === "confirming")
  ) {
    const recentCopy = summary.recent_runs.find(
      (run) => run.id === summary.latest_run?.id,
    );
    return recentCopy
      ? reconcileBullpenConsoleRunCopies(recentCopy, summary.latest_run)
      : summary.latest_run;
  }
  const runningRun = summary.recent_runs.find(
    (run) =>
      runBelongsToWorkspace(run, workspaceProfile) &&
      (run.status === "running" || run.status === "confirming"),
  );
  if (runningRun) return runningRun;

  // On page refresh there is usually no pending/running run to track, but the
  // console still needs the most recent completed run payload so the parent can
  // rebuild the Events Summary and Events to invest in tables with persisted LLM
  // odds/returns until a newer scan replaces them.
  if (
    runBelongsToWorkspace(summary.latest_run, workspaceProfile) &&
    summary.latest_run?.status === "completed"
  ) {
    const recentCopy = summary.recent_runs.find(
      (run) => run.id === summary.latest_run?.id,
    );
    return recentCopy
      ? reconcileBullpenConsoleRunCopies(recentCopy, summary.latest_run)
      : summary.latest_run;
  }
  return summary.recent_runs.find(
    (run) =>
      runBelongsToWorkspace(run, workspaceProfile) && run.status === "completed",
  ) ?? null;
}

export function isUsableBullpenBalance(
  balance: PolymarketBotState["live"]["balance"] | null | undefined,
): balance is PolymarketBotState["live"]["balance"] & { status: "ready" } {
  return balance?.status === "ready";
}

export function BullpenPortfolioSnapshot({
  useHistoryPortfolioSource,
  state,
  lastUsableBalance,
  activePositions,
  activePositionsSummary,
  activePositionQuestions,
  hasActivePositionsSnapshot,
  positionsVerifiedByStage1,
  positionsVerifiedAt,
  positionsSource,
  positionsUpdatedAt,
  positionsLineage,
  verifiedActivePositionsTotal,
  verifiedActivePositionsTruncated,
  verifiedCashInHandUsd,
  refreshing,
  refreshNotice,
  historicalRuns,
  recentDecisions,
  onRefresh,
}: {
  useHistoryPortfolioSource: boolean;
  state: PolymarketBotState | null;
  lastUsableBalance:
    | (PolymarketBotState["live"]["balance"] & { status: "ready" })
    | null;
  activePositions: BullpenActivePositionView[];
  activePositionsSummary: BullpenPositionsSummary | null;
  activePositionQuestions: BullpenQuestionRow[];
  hasActivePositionsSnapshot: boolean;
  positionsVerifiedByStage1: boolean;
  positionsVerifiedAt: string | null;
  positionsSource: BullpenPositionsSource | null;
  positionsUpdatedAt: string | null;
  positionsLineage: BullpenPositionsSnapshotLineage | null;
  verifiedActivePositionsTotal: number | null;
  verifiedActivePositionsTruncated: boolean;
  verifiedCashInHandUsd: number | null;
  refreshing: boolean;
  refreshNotice: string | null;
  historicalRuns: BullpenAutoLiveRun[];
  recentDecisions: BullpenAutoLiveDecision[];
  onRefresh: () => void;
}) {
  const [isActivePositionsPopupOpen, setIsActivePositionsPopupOpen] =
    useState(false);
  const [isClaimableEventsPopupOpen, setIsClaimableEventsPopupOpen] =
    useState(false);
  const [activePositionDetail, setActivePositionDetail] =
    useState<BullpenActivePositionView | null>(null);
  const liveBalance = state?.live.balance ?? null;
  const balance = isUsableBullpenBalance(liveBalance)
    ? liveBalance
    : lastUsableBalance;
  const usableBalance = isUsableBullpenBalance(balance);
  const accountValue = resolveBullpenPreferredPortfolioValue([
    positionsVerifiedByStage1 ? null : activePositionsSummary?.walletValue,
    positionsVerifiedByStage1 || !usableBalance
      ? null
      : balance.account_value_usd,
    positionsVerifiedByStage1 ? null : activePositionsSummary?.totalValue,
  ]);
  const positionsSnapshotCash =
    typeof activePositionsSummary?.cashBalance === "number" &&
    Number.isFinite(activePositionsSummary.cashBalance)
      ? activePositionsSummary.cashBalance
      : null;
  const cash = positionsVerifiedByStage1
    ? resolveBullpenPreferredPortfolioValue([verifiedCashInHandUsd])
    : resolveBullpenPreferredPortfolioValue([
        positionsSnapshotCash,
        usableBalance ? balance.available_balance_usd : null,
      ]);
  const cashUsesSeparateBalanceSnapshot =
    !positionsVerifiedByStage1 &&
    positionsSnapshotCash === null &&
    usableBalance;
  const pnl = positionsVerifiedByStage1
    ? null
    : usableBalance
      ? (balance.pnl_usd ?? null)
      : null;
  const verifiedActivePositions = activePositions.filter(
    isActiveBullpenPosition,
  );
  const verifiedClaimablePositions = activePositions.filter(
    isClaimableBullpenPosition,
  );
  const verifiedPositionsUpnl = verifiedActivePositions.reduce(
    (total, position) => total + (position.unrealizedPnl ?? 0),
    0,
  );
  const upnl = positionsVerifiedByStage1
    ? verifiedPositionsUpnl
    : activePositionsSummary?.unrealizedPnl ??
      (usableBalance ? (balance.upnl_usd ?? null) : null);
  const openPositions = state?.open_positions ?? [];
  // The rendered rows are the reconciled evidence. Do not let a stale scalar
  // summary reintroduce the same zero-position contradiction. Claimable rows
  // are rendered by the claim metric and must not inflate Active Positions.
  const activePositionCount = hasActivePositionsSnapshot
    ? positionsVerifiedByStage1 && verifiedActivePositionsTotal !== null
      ? verifiedActivePositionsTotal
      : verifiedActivePositions.length
    : openPositions.filter((position) => position.shares > 0).length;
  const activeInvested = hasActivePositionsSnapshot
    ? verifiedActivePositions.reduce((total, position) => {
        const amount =
          typeof position.costBasis === "number" ? position.costBasis : 0;
        return total + amount;
      }, 0)
    : openPositions.reduce(
        (total, position) => total + (position.cost_basis || 0),
        0,
      );
  const claimableRows = (state?.live.redeemed_trades ?? []).filter((trade) => {
    const text = `${trade.status ?? ""} ${trade.detail ?? ""}`.toLowerCase();
    return (
      text.includes("claim") ||
      text.includes("redeem") ||
      text.includes("pending")
    );
  });
  const claimableEventCount = hasActivePositionsSnapshot
    ? verifiedClaimablePositions.length
    : claimableRows.length;
  const claimableAmount = hasActivePositionsSnapshot
    ? verifiedClaimablePositions.reduce(
        (total, position) =>
          total +
          Math.max(
            0,
            position.claimableValue ??
              position.expectedPayoutUsd ??
              position.currentValue ??
              0,
          ),
        0,
      )
    : claimableRows.reduce(
        (total, trade) => total + Math.max(0, trade.amount || 0),
        0,
      );
  const positionsRefresh = positionsVerifiedByStage1
    ? positionsVerifiedAt
    : positionsUpdatedAt;
  const balanceRefresh = balance?.checked_at ?? null;
  const positionVerification = positionsVerifiedByStage1
    ? `Positions verified by Stage 1: ${formatIstDateTime(positionsVerifiedAt)}`
    : positionsSource === "redis-cache"
      ? "Positions verified by a fresh shared Bullpen refresh"
    : positionsSource === "tracked-positions"
      ? "Tracked-position fallback: stale, read-only wallet rows"
      : null;
  const lineageAccount = positionsLineage?.accountIdentity?.trim() || null;
  const displayedLineageAccount =
    lineageAccount && lineageAccount.length > 14
      ? `${lineageAccount.slice(0, 7)}…${lineageAccount.slice(-5)}`
      : lineageAccount;
  const displayedLineageSource =
    positionsLineage?.source?.trim() || positionsSource;
  const displayedClassifierVersion =
    typeof positionsLineage?.positionClassifierVersion === "number" &&
    Number.isFinite(positionsLineage.positionClassifierVersion)
      ? positionsLineage.positionClassifierVersion
      : null;
  const pendingConfirmationsCount =
    state?.live.pending_confirmations.length ?? 0;
  const balanceStatus = liveBalance?.status ?? balance?.status ?? "not loaded";
  const currentInvestmentsValue = hasActivePositionsSnapshot
    ? sumCurrentPositionValue(verifiedActivePositions)
    : accountValue;
  const currentPortfolioPositionsValue = hasActivePositionsSnapshot
    ? sumBullpenPortfolioPositionValue(activePositions)
    : currentInvestmentsValue;
  const displayedTotalPortfolioValue = resolveBullpenTotalPortfolioValue({
    walletValue: activePositionsSummary?.walletValue,
    accountValue,
    summaryTotalValue: activePositionsSummary?.totalValue,
    cashBalance: cash,
    positionsValue: currentPortfolioPositionsValue,
    hasPositionsSnapshot: hasActivePositionsSnapshot,
    preferVerifiedComponents: positionsVerifiedByStage1,
  });
  const {
    activePositionQuestionByKey,
    activePositionsNeedingAttention,
    topInvestmentRows,
  } = buildBullpenInvestmentDisplay({
    activePositions: verifiedActivePositions,
    activePositionQuestions,
    candidates: [],
    recentDecisions,
  });
  const popupRows = [
    ...topInvestmentRows
      .filter((row) => row.kind === "active")
      .map((row) => ({ tone: "active" as const, position: row.position })),
    ...activePositionsNeedingAttention.map(({ position }) => ({
      tone: "attention" as const,
      position,
    })),
  ];

  function getPositionDecision(position: BullpenActivePositionView) {
    const heldSide =
      position.heldSide ?? position.outcome?.trim().toUpperCase() ?? null;
    const sameSideDecisions = recentDecisions.filter((decision) => {
      const decisionSide =
        decision.side?.trim().toUpperCase() ??
        decision.order_plan?.side?.trim().toUpperCase() ??
        null;
      return heldSide ? decisionSide === heldSide : true;
    });

    const resolveDecision = (decisions: BullpenAutoLiveDecision[]) => {
      const match = BullpenEventIdentityResolver.resolveMatch({
        target: buildBullpenEventIdentityFromPosition(position),
        candidates: decisions,
        getIdentity: (decision) => buildBullpenEventIdentityFromDecision(decision),
        getSortTimestamp: (decision) => decision.updated_at,
      });
      return match.status === "matched" ? match.match?.item ?? null : null;
    };

    return resolveDecision(sameSideDecisions) ?? resolveDecision(recentDecisions);
  }

  function getPositionLlmOdds(
    position: BullpenActivePositionView,
    question?: BullpenQuestionRow,
  ) {
    const analysis = question as
      | (BullpenQuestionRow & Partial<BullpenActivePositionLlmAnalysis>)
      | undefined;
    const fromActivePositionAnalysis =
      question && (question.llmYesOdds !== null || question.llmNoOdds !== null)
        ? {
            yes: question.llmYesOdds,
            no: question.llmNoOdds,
            completedAt: question.llmCompletedAt,
            source:
              analysis?.llmRecoverySource === "current-run"
                ? "latest Stage 2 consensus"
                : analysis?.llmRecoverySource === "latest-snapshot"
                  ? "latest saved snapshot"
                  : analysis?.llmRecoverySource === "last-known-good"
                    ? "last known good active-position analysis"
                    : "active-position LLM snapshot",
            status: analysis?.llmRecoveryStatus ?? null,
            diagnostic: analysis?.llmRecoveryReason ?? null,
            error: null,
          }
        : null;
    if (fromActivePositionAnalysis) return fromActivePositionAnalysis;

    const decision = getPositionDecision(position);
    const yes = decision?.fair_yes_probability_pct ?? null;
    const no = decision?.fair_no_probability_pct ?? null;
    if (yes !== null || no !== null) {
      return {
        yes,
        no,
        completedAt: decision?.updated_at ?? null,
        source: "last completed auto-run decision",
        status: "last-known-good/stale",
        diagnostic: "Recovered from the latest matching Stage 3 decision.",
        error: null,
      };
    }

    const attempted = [
      analysis?.llmRecoveryReason ??
        (question
          ? "active-position LLM snapshot had no odds"
          : "no active-position LLM snapshot matched this position"),
      decision
        ? "last completed auto-run decision matched but did not include fair Yes/No odds"
        : "no last completed auto-run decision matched by shared event identity",
    ];
    return {
      yes: null,
      no: null,
      completedAt: null,
      source: "unavailable",
      status: analysis?.llmRecoveryStatus ?? "unrecoverable",
      diagnostic: analysis?.llmRecoveryReason ?? null,
      error: attempted.join("; "),
    };
  }

  function getPositionCategory(
    position: BullpenActivePositionView,
    question?: BullpenQuestionRow,
  ) {
    return (
      question?.category ||
      getPositionDecision(position)?.theme ||
      position.marketContext ||
      "—"
    );
  }

  const metricCards = [
    {
      label: "Investment Value",
      value: formatMoney(currentInvestmentsValue),
      detail: "Current Investments Value",
    },
    {
      label: "Cash in hand",
      value: formatMoney(cash),
      detail: positionsVerifiedByStage1
        ? "Available pUSD · Stage 1 snapshot"
        : cashUsesSeparateBalanceSnapshot
          ? `Available pUSD · balance snapshot ${formatIstDateTime(balanceRefresh)}`
          : "Available pUSD · wallet positions snapshot",
    },
    {
      label: "Events available for claim",
      value: claimableEventCount.toLocaleString("en-IN"),
      detail: formatMoney(claimableAmount),
    },
    {
      label: "Active positions",
      value: activePositionCount.toLocaleString("en-IN"),
      detail: `${formatMoney(activeInvested)} invested`,
    },
    {
      label: "PnL",
      value: formatMoney(pnl),
      detail: positionsVerifiedByStage1
        ? "Unavailable in Stage 1 snapshot"
        : `Realized PnL · balance snapshot ${formatIstDateTime(balanceRefresh)}`,
    },
    { label: "uPnL", value: formatMoney(upnl), detail: "Unrealized PnL" },
    {
      label: "Live trades today",
      value: (state?.live.live_trades_today ?? 0).toLocaleString("en-IN"),
      detail: `Mode: ${state?.mode ?? "—"}`,
    },
    {
      label: "Pending confirmations",
      value: pendingConfirmationsCount.toLocaleString("en-IN"),
      detail: balanceStatus,
    },
  ];

  // The History portfolio is the canonical current-portfolio view. Reuse that
  // exact loader and renderer on the main Bullpen page so the two routes cannot
  // preserve different browser-local snapshots or calculate different totals.
  if (useHistoryPortfolioSource) {
    return <BullpenHistoryPortfolio />;
  }

  return (
    <div className="rounded-3xl border border-slate-200 bg-gradient-to-br from-slate-950 via-slate-900 to-sky-950 p-5 text-white shadow-xl shadow-slate-950/10">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-sky-100">
            <Wallet className="size-3.5" /> Bullpen Portfolio
          </div>
          <h3 className="mt-3 text-2xl font-semibold tracking-tight">
            {formatMoney(displayedTotalPortfolioValue)} Total Portfolio Value
          </h3>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onRefresh}
            disabled={refreshing}
            className="rounded-full border-sky-300/50 bg-sky-300/10 text-sky-100 hover:border-sky-200 hover:bg-sky-300/20 hover:text-white disabled:border-slate-500 disabled:bg-slate-700 disabled:text-slate-400"
          >
            <RefreshCw
              className={`mr-2 size-3.5 ${refreshing ? "animate-spin" : ""}`}
            />{" "}
            Refresh
          </Button>
          <span className="text-right text-[11px] text-slate-400">
            Wallet positions refresh: {formatIstDateTime(positionsRefresh)}
          </span>
          {usableBalance && !positionsVerifiedByStage1 ? (
            <span className="text-right text-[11px] text-slate-400">
              Balance refresh: {formatIstDateTime(balanceRefresh)}
            </span>
          ) : null}
          {positionVerification ? (
            <span className="text-right text-[11px] font-semibold text-emerald-300">
              {positionVerification}
            </span>
          ) : null}
          {refreshNotice ? (
            <span
              className="max-w-sm text-right text-[11px] font-medium text-amber-200"
              role="status"
            >
              {refreshNotice}
            </span>
          ) : null}
          {displayedLineageAccount ||
            displayedLineageSource ||
            displayedClassifierVersion !== null ? (
            <span className="text-right text-[11px] text-sky-200">
              {[
                displayedLineageAccount
                  ? `Wallet ${displayedLineageAccount}`
                  : null,
                displayedLineageSource
                  ? `source ${displayedLineageSource}`
                  : null,
                displayedClassifierVersion !== null
                  ? `classifier v${displayedClassifierVersion}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          ) : null}
        </div>
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {metricCards.map((metric) => {
          const isActivePositionsMetric = metric.label === "Active positions";
          const isClaimableEventsMetric = metric.label === "Events available for claim";
          return (
            <button
              key={metric.label}
              type="button"
              onClick={
                isActivePositionsMetric
                  ? () => setIsActivePositionsPopupOpen(true)
                  : isClaimableEventsMetric
                    ? () => setIsClaimableEventsPopupOpen(true)
                    : undefined
              }
              className={`rounded-[20px] border border-white/10 bg-white/10 px-4 py-3 text-left ${isActivePositionsMetric || isClaimableEventsMetric ? "transition hover:border-sky-200/70 hover:bg-white/15 focus:outline-none focus:ring-2 focus:ring-sky-200/70" : "cursor-default"}`}
              disabled={!isActivePositionsMetric && !isClaimableEventsMetric}
            >
              <div className="text-[11px] uppercase tracking-[0.16em] text-slate-300">
                {metric.label}
              </div>
              <div className="mt-2 text-xl font-semibold">{metric.value}</div>
              <div className="mt-1 text-xs text-slate-400">{metric.detail}</div>
            </button>
          );
        })}
      </div>
      {isClaimableEventsPopupOpen ? (
        <div className="fixed inset-0 z-[170] flex items-center justify-center bg-slate-950/60 p-4 text-slate-950">
          <div className="flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.55)]">
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-fuchsia-700">Events available for claim</p>
                <h3 className="mt-1 text-xl font-semibold">
                  Claimable events: {claimableEventCount}
                </h3>
                <p className="mt-2 text-sm text-slate-600">
                  {hasActivePositionsSnapshot
                    ? "Shows claimable rows from the same verified Bullpen wallet snapshot as the portfolio card."
                    : "Shows Bullpen redeemed/claimable activity while the wallet snapshot is unavailable."}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsClaimableEventsPopupOpen(false)}
                className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
                aria-label="Close claimable events details"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-auto px-6 py-5">
              {hasActivePositionsSnapshot ? (
                verifiedClaimablePositions.length ? (
                  <table className="min-w-full divide-y divide-slate-200 text-sm">
                  <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                    <tr>
                      {[
                        "S. No",
                        "Market",
                        "Outcome",
                        "Shares",
                        "Claimable value",
                        "Status",
                      ].map((heading) => (
                        <th key={heading} className="px-4 py-3">
                          {heading}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {verifiedClaimablePositions.map((position, index) => (
                      <tr key={position.key} className="hover:bg-slate-50">
                        <td className="px-4 py-3 font-semibold tabular-nums">
                          {index + 1}
                        </td>
                        <td className="min-w-[18rem] px-4 py-3 font-semibold text-slate-950">
                          {position.marketTitle}
                        </td>
                        <td className="px-4 py-3">{position.outcome}</td>
                        <td className="px-4 py-3 tabular-nums">
                          {position.shares.toLocaleString("en-IN", {
                            maximumFractionDigits: 4,
                          })}
                        </td>
                        <td className="px-4 py-3 tabular-nums">
                          {formatMoney(
                            position.claimableValue ??
                              position.expectedPayoutUsd ??
                              position.currentValue,
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {position.classificationReason}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  </table>
                ) : (
                  <p className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                    No claimable Bullpen events are present in the current
                    verified snapshot.
                  </p>
                )
              ) : claimableRows.length ? (
                <table className="min-w-full divide-y divide-slate-200 text-sm">
                  <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                    <tr>{["S. No", "Market", "Outcome", "Side", "Amount", "Shares", "Price", "PnL", "Status", "Updated"].map((heading) => <th key={heading} className="px-4 py-3">{heading}</th>)}</tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {claimableRows.map((trade, index) => (
                      <tr key={trade.id || `${trade.market_id}-${index}`} className="hover:bg-slate-50">
                        <td className="px-4 py-3 font-semibold tabular-nums">{index + 1}</td>
                        <td className="min-w-[18rem] px-4 py-3 font-semibold text-slate-950">{trade.market_title || trade.market_id}</td>
                        <td className="px-4 py-3">{trade.outcome || "—"}</td>
                        <td className="px-4 py-3">{trade.side || "—"}</td>
                        <td className="px-4 py-3 tabular-nums">{formatMoney(trade.amount ?? null)}</td>
                        <td className="px-4 py-3 tabular-nums">{trade.shares?.toLocaleString("en-IN", { maximumFractionDigits: 4 }) ?? "—"}</td>
                        <td className="px-4 py-3 tabular-nums">{formatOddsPercent(trade.price ?? null)}</td>
                        <td className="px-4 py-3 tabular-nums">{formatMoney(trade.profit_loss ?? null)}</td>
                        <td className="px-4 py-3">{trade.status || trade.detail || "—"}</td>
                        <td className="px-4 py-3">{formatIstDateTime(trade.timestamp)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                  No claimable Bullpen activity is available while the wallet
                  snapshot is unavailable.
                </p>
              )}
            </div>
          </div>
        </div>
      ) : null}
      {isActivePositionsPopupOpen ? (
        <div className="fixed inset-0 z-[170] flex items-center justify-center bg-slate-950/60 p-4 text-slate-950">
          <div className="flex max-h-[88vh] w-full max-w-7xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.55)]">
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-fuchsia-700">
                  Active Bullpen Positions
                </p>
                <h3 className="mt-1 text-xl font-semibold">
                  Active positions: {activePositionCount}
                </h3>
                <p className="mt-2 text-sm text-slate-600">
                  {verifiedActivePositionsTruncated
                    ? `Showing ${popupRows.length} retained rows from the bounded verified snapshot.`
                    : "Shows green active positions and red Event Exit positions only."}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsActivePositionsPopupOpen(false)}
                className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
                aria-label="Close active positions details"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-auto px-6 py-5">
              {popupRows.length ? (
                <table className="min-w-full divide-y divide-slate-200 text-sm">
                  <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                    <tr>
                      {[
                        "S. No",
                        "Question",
                        "Amount Invested",
                        "Current Value",
                        "Days left",
                        "Closing time",
                        "Category",
                        "Outcomes",
                        "Current Odds",
                        "LLM Odds",
                        "Returns/day",
                        "Volume",
                        "Liquidity",
                      ].map((heading) => (
                        <th key={heading} className="px-4 py-3">
                          {heading}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {popupRows.map(({ tone, position }, index) => {
                      const question = activePositionQuestionByKey.get(
                        position.key,
                      );
                      const llmOdds = getPositionLlmOdds(position, question);
                      return (
                        <tr
                          key={`${tone}-${position.key}`}
                          onClick={() => setActivePositionDetail(position)}
                          className={`cursor-pointer transition hover:bg-slate-100 ${
                            tone === "active"
                              ? "bg-emerald-50/50"
                              : "bg-red-50/60"
                          }`}
                        >
                          <td className="px-4 py-3 font-semibold tabular-nums">
                            {index + 1}
                          </td>
                          <td className="min-w-[18rem] px-4 py-3 font-semibold text-slate-950">
                            {position.marketTitle}
                          </td>
                          <td className="px-4 py-3 tabular-nums">
                            {formatMoney(position.costBasis)}
                          </td>
                          <td className="px-4 py-3 tabular-nums">
                            {formatMoney(position.currentValue)}
                          </td>
                          <td className="px-4 py-3 tabular-nums">
                            {calculateDaysUntilClose(position.closeTime) ?? "—"}
                          </td>
                          <td className="px-4 py-3">
                            {formatIstDateTime(position.closeTime)}
                          </td>
                          <td className="min-w-56 px-4 py-3">
                            {getPositionCategory(position, question)}
                          </td>
                          <td className="px-4 py-3">
                            {position.outcome || "—"}
                          </td>
                          <td className="px-4 py-3 tabular-nums">
                            {formatOddsPair(position.yesOdds, position.noOdds)}
                          </td>
                          <td className="px-4 py-3 tabular-nums">
                            {formatOddsPair(llmOdds.yes, llmOdds.no)}
                            <div className="mt-1 max-w-56 text-[11px] leading-4 text-slate-500">
                              {llmOdds.completedAt
                                ? `${llmOdds.source}${llmOdds.status ? ` · ${llmOdds.status}` : ""} · ${formatIstDateTime(llmOdds.completedAt)}`
                                : (llmOdds.error ?? "LLM odds are unavailable.")}
                              {!llmOdds.completedAt && llmOdds.diagnostic
                                ? ` ${llmOdds.diagnostic}`
                                : null}
                            </div>
                          </td>
                          <td className="px-4 py-3 tabular-nums">
                            {formatReturnsPerDay(position.returnsPerDay)}
                          </td>
                          <td className="px-4 py-3 tabular-nums">—</td>
                          <td className="px-4 py-3 tabular-nums">—</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <p className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                  No active Bullpen positions are available.
                </p>
              )}
            </div>
          </div>
        </div>
      ) : null}
      {activePositionDetail ? (
        <div className="fixed inset-0 z-[180] flex items-center justify-center bg-slate-950/60 p-4 text-slate-950">
          <div className="flex max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-xl">
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-fuchsia-700">
                  Active position details
                </p>
                <h3 className="mt-2 text-xl font-semibold">
                  {activePositionDetail.marketTitle}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setActivePositionDetail(null)}
                className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
                aria-label="Close active position details"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-5">
              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  [
                    "Category",
                    getPositionCategory(
                      activePositionDetail,
                      activePositionQuestionByKey.get(activePositionDetail.key),
                    ),
                  ],
                  ["Outcome", activePositionDetail.outcome || "—"],
                  [
                    "Amount invested",
                    formatMoney(activePositionDetail.costBasis),
                  ],
                  [
                    "Current value",
                    formatMoney(activePositionDetail.currentValue),
                  ],
                  [
                    "Current odds",
                    `Yes: ${formatOddsPercent(activePositionDetail.yesOdds)} · No: ${formatOddsPercent(activePositionDetail.noOdds)}`,
                  ],
                  [
                    "LLM odds",
                    (() => {
                      const odds = getPositionLlmOdds(
                        activePositionDetail,
                        activePositionQuestionByKey.get(activePositionDetail.key),
                      );
                      return odds.completedAt
                        ? `Yes: ${formatOddsPercent(odds.yes)} · No: ${formatOddsPercent(odds.no)} · ${odds.source}${odds.status ? ` · ${odds.status}` : ""} at ${formatIstDateTime(odds.completedAt)}${odds.diagnostic ? ` · ${odds.diagnostic}` : ""}`
                        : `Yes: ${formatOddsPercent(odds.yes)} · No: ${formatOddsPercent(odds.no)} · ${odds.error ?? "LLM odds are unavailable."}${odds.diagnostic ? ` · ${odds.diagnostic}` : ""}`;
                    })(),
                  ],
                  [
                    "Closing time",
                    formatIstDateTime(activePositionDetail.closeTime),
                  ],
                  [
                    "Returns/day",
                    formatReturnsPerDay(activePositionDetail.returnsPerDay),
                  ],
                ].map(([label, value]) => (
                  <div
                    key={label}
                    className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                  >
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                      {label}
                    </p>
                    <p className="mt-2 text-sm font-semibold text-slate-900">
                      {value}
                    </p>
                  </div>
                ))}
              </div>
              {activePositionDetail.marketUrl ? (
                <a
                  href={activePositionDetail.marketUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-5 inline-flex text-sm font-semibold text-purple-700 hover:text-purple-900 hover:underline"
                >
                  Open market
                </a>
              ) : null}
              <div className="mt-6">
                <BullpenEventHistoricalAssessmentTable
                  question={
                    activePositionQuestionByKey.get(activePositionDetail.key) ?? null
                  }
                  position={activePositionDetail}
                  runs={historicalRuns}
                  decisions={recentDecisions}
                />
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function BullpenAutoRunScheduleCard({
  workspaceProfile = "bullpen007",
  onRunCompleted,
  onRefreshPortfolioPositions,
  activePositions = [],
  activePositionsSummary = null,
  positionsSource = null,
  positionsUpdatedAt = null,
  positionsLineage = null,
  activePositionQuestions = [],
  hasActivePositionsSnapshot = false,
  recentDecisions = [],
  onSummaryUpdated,
  onOpenScanFilters,
  independentScanSnapshot = null,
  onRunIndependentStageOne,
}: BullpenAutoRunScheduleCardProps) {
  const { timeoutSeconds: eventTrendsTimeoutSeconds, saveTimeoutSeconds } =
    useEventTrendsTimeout();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedRunDetailIdFromSearchParams =
    searchParams.get("runDetails")?.trim() || null;
  // Full-screen history lives outside this long-lived interactive island.
  // Read the browser URL as a fallback so a history tile always activates the
  // requested detail even when Next's search-param snapshot has not refreshed
  // by the time the dynamically imported workspace mounts.
  const requestedRunDetailId =
    requestedRunDetailIdFromSearchParams ||
    (typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
          .get("runDetails")
          ?.trim() || null
      : null);
  const returnRunDetailToHistory =
    searchParams.get("returnTo") === "history" ||
    (typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("returnTo") ===
        "history");
  const { user, loading: authLoading } = useAuth();
  const autoRunStatusCacheKey = getBullpenAutoRunStatusCacheKey(user?.id);
  const [summary, setSummary] = useState<BullpenAutoLiveSummaryResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [initialAutoRunStatusCache] = useState(() =>
    readBrowserCachedAutoRunStatus(autoRunStatusCacheKey),
  );
  const [persistedAutoRunStatus, setPersistedAutoRunStatus] = useState<
    BullpenAutoRunStatusData | null
  >(() => initialAutoRunStatusCache?.data ?? null);
  const [persistedAutoRunStatusCacheKey, setPersistedAutoRunStatusCacheKey] =
    useState<string | null>(autoRunStatusCacheKey);
  const visiblePersistedAutoRunStatus =
    persistedAutoRunStatusCacheKey === autoRunStatusCacheKey
      ? persistedAutoRunStatus
      : null;
  const [autoRunStatusLoadState, setAutoRunStatusLoadState] =
    useState<BullpenAutoRunStatusLoadState>(() =>
      initialAutoRunStatusCache ? "ready" : "loading",
    );
  const [autoRunStatusSavedAt, setAutoRunStatusSavedAt] = useState<
    number | null
  >(() => initialAutoRunStatusCache?.savedAt ?? null);
  const [autoRunStatusError, setAutoRunStatusError] = useState<string | null>(
    null,
  );
  const [openBadgeRationale, setOpenBadgeRationale] =
    useState<BullpenAutoRunBadgeKind | null>(null);
  const autoRunStatusRetryAttemptRef = useRef(0);
  const autoRunStatusRetryTimerRef = useRef<number | null>(null);
  const autoRunStatusPollTimerRef = useRef<number | null>(null);
  const autoRunStatusAbortControllerRef = useRef<AbortController | null>(null);
  const persistedStatusRunIdRef = useRef<string | null>(
    initialAutoRunStatusCache?.data.state.active_run_id ?? null,
  );
  const hasObservedPersistedStatusRef = useRef(
    Boolean(initialAutoRunStatusCache),
  );
  const [action, setAction] = useState<ActionState>(null);
  const actionInFlightRef = useRef<ActionState>(null);
  const [optimisticSchedulerState, setOptimisticSchedulerState] = useState<{
    running: boolean;
    paused: boolean;
    message: string;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);
  const [pendingRunId, setPendingRunId] = useState<string | null>(null);
  const [startNowProgress, setStartNowProgress] = useState<string | null>(null);
  const startNowProgressTimeoutRef = useRef<number | null>(null);
  const startNowCancelledRef = useRef(false);
  const summaryLoadInFlightRef = useRef(false);
  const summaryLastLoadedAtRef = useRef(0);
  const summaryAbortControllerRef = useRef<AbortController | null>(null);
  const terminalRunEvidenceRef = useRef(
    new Map<
      string,
      { run: BullpenAutoLiveRun; decisions: BullpenAutoLiveDecision[] }
    >(),
  );
  const terminalRunHydrationInFlightRef = useRef(
    new Map<string, Promise<void>>(),
  );
  const terminalRunHydrationRetryAtRef = useRef(new Map<string, number>());
  const portfolioLoadInFlightRef = useRef(false);
  const portfolioAbortControllerRef = useRef<AbortController | null>(null);
  const onRefreshPortfolioPositionsRef = useRef(onRefreshPortfolioPositions);
  const [killedRunIds, setKilledRunIds] = useState<Set<string>>(() => new Set());
  const [runNowStartedAt, setRunNowStartedAt] = useState<string | null>(null);
  const [timerNowMs, setTimerNowMs] = useState(() => Date.now());
  const [scanCandidateDialog, setScanCandidateDialog] =
    useState<ScanCandidateDialogState | null>(null);
  const [stageOneResultSource, setStageOneResultSource] = useState<
    "original" | "independent"
  >(() => independentScanSnapshot ? "independent" : "original");
  const [isIndependentStageOneScanning, setIsIndependentStageOneScanning] =
    useState(false);
  const [independentStageOneStartedAt, setIndependentStageOneStartedAt] =
    useState<string | null>(null);
  const [independentStageOneProgress, setIndependentStageOneProgress] =
    useState<BullpenIndependentStageOneProgress | null>(null);
  const independentStageOneAbortControllerRef =
    useRef<AbortController | null>(null);
  const [independentStageOneError, setIndependentStageOneError] = useState<
    string | null
  >(null);
  const [openStageKey, setOpenStageKey] = useState<
    "scan" | "llm" | "invest" | null
  >(null);
  const [openInputStageKey, setOpenInputStageKey] = useState<
    "llm" | "invest" | null
  >(null);
  const [investMetricDialog, setInvestMetricDialog] =
    useState<InvestMetricDialogState | null>(null);
  const [stage3PreviewDialog, setStage3PreviewDialog] =
    useState<Stage3PreviewDialogState | null>(null);
  const [isRunHistoryDialogOpen, setIsRunHistoryDialogOpen] = useState(false);
  const [isExcelHistoryDialogOpen, setIsExcelHistoryDialogOpen] =
    useState(false);
  const [runHistoryPage, setRunHistoryPage] =
    useState<BullpenAutoLiveHistoryPage | null>(null);
  const [triggerHistoryItems, setTriggerHistoryItems] = useState<
    BullpenAutoLiveHistoryItem[]
  >([]);
  const [workspaceRunFallback, setWorkspaceRunFallback] =
    useState<BullpenAutoLiveRun | null>(null);
  const [universalTriggerStatus, setUniversalTriggerStatus] =
    useState<UniversalScanTriggerStatus | null>(null);
  const [triggerMonitorLoading, setTriggerMonitorLoading] = useState(true);
  const [triggerMonitorError, setTriggerMonitorError] = useState<string | null>(
    null,
  );
  const [runHistoryEventTrends, setRunHistoryEventTrends] =
    useState<BullpenAutoLiveEventTrendsResponse | null>(null);
  const [runHistoryEventTrendsLoading, setRunHistoryEventTrendsLoading] =
    useState(false);
  const [runHistoryEventTrendsError, setRunHistoryEventTrendsError] = useState<
    string | null
  >(null);
  const [runHistoryLoading, setRunHistoryLoading] = useState(false);
  const [runHistoryDetailLoadingId, setRunHistoryDetailLoadingId] = useState<
    string | null
  >(null);
  const [runHistoryError, setRunHistoryError] = useState<string | null>(null);
  const [runHistoryOwnerKey, setRunHistoryOwnerKey] = useState<string | null>(
    null,
  );
  const runHistoryOwnerKeyRef = useRef<string | null>(null);
  const runHistoryAbortControllerRef = useRef<AbortController | null>(null);
  const runHistoryDetailAbortControllerRef =
    useRef<AbortController | null>(null);
  const runDetailRefreshAbortControllerRef =
    useRef<AbortController | null>(null);
  const handledRequestedRunDetailIdRef = useRef<string | null>(null);
  const [runDetailDialog, setRunDetailDialog] =
    useState<RunDetailDialogState | null>(null);
  const [stageTwoInvestEventsDialog, setStageTwoInvestEventsDialog] =
    useState<StageTwoInvestEventsDialogState | null>(null);
  const [stageTwoLlmRunDialog, setStageTwoLlmRunDialog] =
    useState<StageTwoLlmRunDialogState | null>(null);
  const [runtimeErrorDialog, setRuntimeErrorDialog] = useState<string | null>(null);
  const [runHistoryStageHelp, setRunHistoryStageHelp] = useState<{ label: string; status: string } | null>(null);
  const [stageTwoBypassDialog, setStageTwoBypassDialog] =
    useState<StageTwoBypassDialogState | null>(null);
  const [isSchedulePickerOpen, setIsSchedulePickerOpen] = useState(false);
  const [isEventExitStrategiesDialogOpen, setIsEventExitStrategiesDialogOpen] =
    useState(false);
  const [isLlmExecutionModePickerOpen, setIsLlmExecutionModePickerOpen] =
    useState(false);
  const stage2To3StrategyDialogTriggerRef =
    useRef<HTMLButtonElement | null>(null);
  const [stage2To3StrategyDialog, setStage2To3StrategyDialog] =
    useState<Stage2To3StrategyDialogState | null>(null);
  const [isTradeAmountInfoDialogOpen, setIsTradeAmountInfoDialogOpen] =
    useState(false);
  const [scheduleStartInput, setScheduleStartInput] = useState("");
  const [consoleScanScope, setConsoleScanScope] = useState<
    "trending" | "full_universe"
  >("trending");
  const [schedulePickerValue, setSchedulePickerValue] = useState("");
  const [scheduleRefreshInput, setScheduleRefreshInput] = useState("60");
  const [scheduleSettingsDirty, setScheduleSettingsDirty] = useState(false);
  const [scheduleSettingsSaveBusy, setScheduleSettingsSaveBusy] =
    useState(false);
  const [selectedLlmTargets, setSelectedLlmTargets] = useState<
    ProviderModelTarget[]
  >([]);
  const [llmTargetSelectionSaveBusy, setLlmTargetSelectionSaveBusy] =
    useState(false);
  const pendingSelectedLlmTargetsSaveRef = useRef<ProviderModelTarget[] | null>(
    null,
  );
  const selectedLlmTargetsSaveInFlightRef = useRef(false);
  const selectedLlmTargetsSavePromiseRef = useRef<Promise<void> | null>(null);
  const savedSelectedLlmTargetsRef = useRef("[]");
  const [initialLegacyBullpenLlmTargets] = useState(() =>
    readLegacyBullpenLlmTargetsFromStorage(),
  );
  const legacyBullpenLlmTargetsRef = useRef<ProviderModelTarget[]>(
    initialLegacyBullpenLlmTargets,
  );
  const legacyBullpenLlmTargetsBootstrapStartedRef = useRef(false);
  const legacyBullpenLlmTargetsBootstrapEligibleRef = useRef(
    initialLegacyBullpenLlmTargets.length > 0,
  );
  const [llmExecutionMode, setLlmExecutionMode] =
    useState<BullpenLlmExecutionMode>(DEFAULT_LLM_EXECUTION_MODE);
  const [llmEventsPerPromptInput, setLlmEventsPerPromptInput] = useState(
    String(DEFAULT_LLM_EVENTS_PER_PROMPT),
  );
  const [llmExecutionSettingsDirty, setLlmExecutionSettingsDirty] =
    useState(false);
  const [llmExecutionSettingsSaveBusy, setLlmExecutionSettingsSaveBusy] =
    useState(false);
  const [llmExecutionFieldError, setLlmExecutionFieldError] = useState<
    string | null
  >(null);
  const [selectedRunSummaryTile, setSelectedRunSummaryTile] = useState<
    "last" | "next"
  >("last");
  const [portfolioState, setPortfolioState] =
    useState<PolymarketBotState | null>(null);
  const [lastUsablePortfolioBalance, setLastUsablePortfolioBalance] = useState<
    (PolymarketBotState["live"]["balance"] & { status: "ready" }) | null
  >(null);
  const [, setPortfolioLoading] = useState(true);
  const [portfolioRefreshing, setPortfolioRefreshing] = useState(false);
  const [portfolioRefreshNotice, setPortfolioRefreshNotice] = useState<
    string | null
  >(null);
  const postCompletionPortfolioRefreshRunIdsRef = useRef<Set<string>>(
    new Set(),
  );

  useEffect(() => {
    markBullpenAutoRunPerformance("bullpen-controls-interactive");
  }, []);

  useEffect(() => {
    onRefreshPortfolioPositionsRef.current = onRefreshPortfolioPositions;
  }, [onRefreshPortfolioPositions]);

  function clearAutoRunStatusRetry() {
    if (autoRunStatusRetryTimerRef.current !== null) {
      window.clearTimeout(autoRunStatusRetryTimerRef.current);
      autoRunStatusRetryTimerRef.current = null;
    }
  }

  function clearAutoRunStatusPoll() {
    if (autoRunStatusPollTimerRef.current !== null) {
      window.clearTimeout(autoRunStatusPollTimerRef.current);
      autoRunStatusPollTimerRef.current = null;
    }
  }

  function claimAction(nextAction: Exclude<ActionState, null>) {
    if (actionInFlightRef.current !== null || action !== null) return false;
    actionInFlightRef.current = nextAction;
    setAction(nextAction);
    return true;
  }

  function releaseClaimedAction(nextAction: Exclude<ActionState, null>) {
    if (actionInFlightRef.current === nextAction) {
      actionInFlightRef.current = null;
    }
    setAction((currentAction) =>
      currentAction === nextAction ? null : currentAction,
    );
  }

  function clearClaimedAction() {
    actionInFlightRef.current = null;
    setAction(null);
  }

  function scheduleAutoRunStatusRetry() {
    const controller = autoRunStatusAbortControllerRef.current;
    if (
      !controller ||
      controller.signal.aborted ||
      !isBullpenAutoRunPageVisible(document.visibilityState)
    ) {
      return false;
    }
    if (
      autoRunStatusRetryAttemptRef.current >=
      AUTO_RUN_STATUS_MAX_AUTOMATIC_RETRIES
    ) {
      clearAutoRunStatusRetry();
      return false;
    }

    clearAutoRunStatusRetry();
    const delay = getBullpenAutoRunStatusRetryDelay(
      autoRunStatusRetryAttemptRef.current,
    );
    autoRunStatusRetryAttemptRef.current += 1;
    autoRunStatusRetryTimerRef.current = window.setTimeout(() => {
      autoRunStatusRetryTimerRef.current = null;
      if (
        controller.signal.aborted ||
        !isBullpenAutoRunPageVisible(document.visibilityState)
      ) {
        return;
      }
      void refreshPersistedAutoRunStatus({ retrying: true });
    }, delay);
    return true;
  }

  function scheduleAutoRunStatusRevalidation(
    nextStatus: BullpenAutoRunStatusData,
  ) {
    const controller = autoRunStatusAbortControllerRef.current;
    if (
      !controller ||
      controller.signal.aborted ||
      !isBullpenAutoRunPageVisible(document.visibilityState)
    ) {
      return;
    }

    // The configuration itself is static.  Only the tiny persisted scheduler
    // state is revisited, every minute when idle and at run-progress cadence
    // while a scheduled/manual run is active.
    clearAutoRunStatusPoll();
    const delay = isBullpenAutoRunProgressActive(nextStatus)
      ? POLL_INTERVAL_MS
      : AUTO_RUN_STATUS_IDLE_REVALIDATE_MS;
    autoRunStatusPollTimerRef.current = window.setTimeout(() => {
      autoRunStatusPollTimerRef.current = null;
      if (
        controller.signal.aborted ||
        !isBullpenAutoRunPageVisible(document.visibilityState)
      ) {
        return;
      }
      void refreshPersistedAutoRunStatus();
    }, delay);
  }

  async function refreshPersistedAutoRunStatus(options?: {
    retrying?: boolean;
}) {
    const controller = autoRunStatusAbortControllerRef.current;
    const cacheKey = autoRunStatusCacheKey;
    if (!controller || controller.signal.aborted || !cacheKey) return null;

    clearAutoRunStatusRetry();
    clearAutoRunStatusPoll();
    setAutoRunStatusLoadState(options?.retrying ? "retrying" : "loading");
    let settled = false;

    try {
      const nextStatus = await getPersistedAutoRunStatus(
        cacheKey,
        controller.signal,
      );
      if (controller.signal.aborted) return null;

      const savedAt = saveBrowserCachedAutoRunStatus(nextStatus, cacheKey);
      const previousRunId = persistedStatusRunIdRef.current;
      const hadObservedStatus = hasObservedPersistedStatusRef.current;
      const nextRunId = nextStatus.state.active_run_id ?? null;
      const runChanged = previousRunId !== nextRunId;
      persistedStatusRunIdRef.current = nextRunId;
      hasObservedPersistedStatusRef.current = true;
      autoRunStatusRetryAttemptRef.current = 0;
      setPersistedAutoRunStatus(nextStatus);
      setPersistedAutoRunStatusCacheKey(cacheKey);
      setAutoRunStatusSavedAt(savedAt);
      setAutoRunStatusLoadState("ready");
      setAutoRunStatusError(null);
      scheduleAutoRunStatusRevalidation(nextStatus);

      // A scheduled worker can start while this tab stays open.  The
      // persisted state is cheap to poll and carries the run id, so use it to
      // discover that transition before asking the expensive summary for
      // stage-level detail.  The first non-cached active response gets the
      // same treatment; the deferred initial summary is deduplicated.
      if (
        nextRunId &&
        ((!hadObservedStatus && isBullpenAutoRunProgressActive(nextStatus)) ||
          (hadObservedStatus && runChanged))
      ) {
        if (isBullpenAutoRunProgressActive(nextStatus)) {
          setPendingRunId(nextRunId);
        }
        void loadSummary({
          preserveLoading: true,
          nextPendingRunId: nextRunId,
        });
      }
      settled = true;
      return nextStatus;
    } catch (nextError) {
      if (controller.signal.aborted || isRequestAbort(nextError)) {
        settled = true;
        return null;
      }

      const timedOut =
        nextError instanceof RequestTimeoutError ||
        (nextError instanceof APIError && nextError.status === 504);
      const primaryFailureReason = timedOut
        ? "primary_status_timeout"
        : nextError instanceof APIError
          ? `primary_status_http_${nextError.status}`
          : "primary_status_unavailable_or_invalid";

      let fallbackSummary = summary;
      if (!fallbackSummary) {
        fallbackSummary = await loadSummary({ preserveLoading: true });
      }
      const summaryStatus =
        normalizeBullpenAutoRunStatusFromSummary(fallbackSummary);
      if (summaryStatus) {
        logBullpenAutoRunStatusFallback({
          fromStage: "primary",
          toStage: "secondary",
          approach: "validated-summary",
          reason: primaryFailureReason,
        });
        const savedAt = saveBrowserCachedAutoRunStatus(summaryStatus, cacheKey);
        persistedStatusRunIdRef.current =
          summaryStatus.state.active_run_id ?? null;
        hasObservedPersistedStatusRef.current = true;
        autoRunStatusRetryAttemptRef.current = 0;
        setPersistedAutoRunStatus(summaryStatus);
        setPersistedAutoRunStatusCacheKey(cacheKey);
        setAutoRunStatusSavedAt(savedAt);
        setAutoRunStatusLoadState("ready");
        setAutoRunStatusError(null);
        scheduleAutoRunStatusRevalidation(summaryStatus);
        settled = true;
        return summaryStatus;
      }

      const cachedStatus = readBrowserCachedAutoRunStatus(cacheKey);
      if (cachedStatus) {
        logBullpenAutoRunStatusFallback({
          fromStage: "secondary",
          toStage: "tertiary",
          approach: "last-known-good-cache",
          reason: "summary_unavailable_or_invalid",
        });
        setPersistedAutoRunStatus(cachedStatus.data);
        setPersistedAutoRunStatusCacheKey(cacheKey);
        setAutoRunStatusSavedAt(cachedStatus.savedAt);
      }

      setAutoRunStatusLoadState(timedOut ? "timeout" : "error");
      const retryScheduled = scheduleAutoRunStatusRetry();
      setAutoRunStatusError(
        retryScheduled
          ? timedOut
            ? "Auto-run status timed out. Retrying in the background."
            : "Auto-run status is unavailable. Retrying in the background."
          : "Automatic status retries are exhausted. Use Retry status to check again.",
      );
      settled = true;
      return null;
    } finally {
      // Every request takes a terminal state. This guards against future
      // changes that throw before the success/error branches above.
      if (!controller.signal.aborted && !settled) {
        setAutoRunStatusLoadState("error");
        setAutoRunStatusError(
          "Auto-run status could not be refreshed. Retry the check.",
        );
        if (!scheduleAutoRunStatusRetry()) {
          setAutoRunStatusError(
            "Automatic status retries are exhausted. Use Retry status to check again.",
          );
        }
      }
    }
  }

  useEffect(() => {
    const cachedStatus = readBrowserCachedAutoRunStatus(autoRunStatusCacheKey);
    let disposed = false;
    // Scheduling the reset avoids a synchronous effect cascade while still
    // replacing account-scoped cached data before a network response can paint.
    window.queueMicrotask(() => {
      if (disposed) return;
      setPersistedAutoRunStatusCacheKey(autoRunStatusCacheKey);
      setPersistedAutoRunStatus(cachedStatus?.data ?? null);
      setAutoRunStatusSavedAt(cachedStatus?.savedAt ?? null);
      setAutoRunStatusLoadState(cachedStatus ? "ready" : "loading");
      setAutoRunStatusError(null);
      if (!autoRunStatusCacheKey && !authLoading) {
        setAutoRunStatusLoadState("error");
        setAutoRunStatusError("Sign in to refresh the auto-run status.");
      }
    });
    autoRunStatusRetryAttemptRef.current = 0;
    persistedStatusRunIdRef.current = cachedStatus?.data.state.active_run_id ?? null;
    hasObservedPersistedStatusRef.current = Boolean(cachedStatus);

    if (!autoRunStatusCacheKey) {
      if (!authLoading) {
        return () => {
          disposed = true;
        };
      }

      // A stuck session bootstrap used to leave the header skeleton visible
      // forever before any status request could start. Authentication is a
      // separate dependency, so fail this compact section explicitly instead.
      const authTimeoutId = window.setTimeout(() => {
        if (disposed) return;
        setAutoRunStatusLoadState("timeout");
        setAutoRunStatusError(
          "Authentication is taking too long. Sign in again to refresh auto-run status.",
        );
      }, AUTO_RUN_AUTH_BOOTSTRAP_TIMEOUT_MS);
      return () => {
        disposed = true;
        window.clearTimeout(authTimeoutId);
      };
    }

    const controller = new AbortController();
    autoRunStatusAbortControllerRef.current = controller;

    window.queueMicrotask(() => {
      if (!controller.signal.aborted) {
        void refreshPersistedAutoRunStatus();
      }
    });

    const onVisibilityChange = () => {
      if (!isBullpenAutoRunPageVisible(document.visibilityState)) {
        clearAutoRunStatusRetry();
        clearAutoRunStatusPoll();
        return;
      }
      void refreshPersistedAutoRunStatus();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      disposed = true;
      controller.abort();
      clearAutoRunStatusRetry();
      clearAutoRunStatusPoll();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (autoRunStatusAbortControllerRef.current === controller) {
        autoRunStatusAbortControllerRef.current = null;
      }
    };
    // Status is isolated by authenticated user; changing accounts must cancel
    // the previous resource and never render its last-known data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRunStatusCacheKey, authLoading]);

  useEffect(() => {
    const controller = new AbortController();

    const loadTriggerMonitor = async () => {
      const [historyResult, universalResult] = await Promise.allSettled([
        apiService.getBullpenAutoLiveHistory(
          { page: 1, size: 50, workspaceProfile },
          { signal: controller.signal, timeoutMs: 12_000 },
        ),
        fetch("/api/universal-polymarket-scan/auto-run", {
          cache: "no-store",
          credentials: "include",
          signal: controller.signal,
        }).then(async (response) => {
          if (!response.ok) {
            throw new Error("Universal Scan trigger status is unavailable.");
          }
          return (await response.json()) as UniversalScanTriggerStatus;
        }),
      ]);
      if (controller.signal.aborted) return;
      if (historyResult.status === "fulfilled") {
        setTriggerHistoryItems(historyResult.value.items);
        const latestWorkspaceRunId = historyResult.value.items[0]?.id;
        if (latestWorkspaceRunId) {
          void apiService
            .getBullpenAutoLiveRunConsole(latestWorkspaceRunId, {
              signal: controller.signal,
              timeoutMs: 10_000,
            })
            .then((detail) => {
              if (
                !controller.signal.aborted &&
                runBelongsToWorkspace(detail.run, workspaceProfile)
              ) {
                setWorkspaceRunFallback(detail.run);
              }
            })
            .catch((nextError) => {
              if (
                !controller.signal.aborted &&
                !isRequestAbort(nextError)
              ) {
                console.warn(
                  JSON.stringify({
                    event: "bullpen_workspace_run_fallback_unavailable",
                    run_id: latestWorkspaceRunId,
                  }),
                );
              }
            });
        }
      }
      if (universalResult.status === "fulfilled") {
        setUniversalTriggerStatus(universalResult.value);
      }
      setTriggerMonitorError(
        historyResult.status === "rejected" && universalResult.status === "rejected"
          ? "Trigger status is temporarily unavailable. Retrying automatically."
          : null,
      );
      setTriggerMonitorLoading(false);
    };

    void loadTriggerMonitor();
    const intervalId = window.setInterval(
      () => void loadTriggerMonitor(),
      60_000,
    );
    return () => {
      controller.abort();
      window.clearInterval(intervalId);
    };
  }, [workspaceProfile]);

  const persistedConsoleOrderUsd = resolvePositiveConsoleOrderUsd(
    summary?.state.last_console_trade_amount_usd,
    summary?.settings.console_order_usd,
    visiblePersistedAutoRunStatus?.settings.console_order_usd,
  );

  useEffect(() => {
    if (scheduleSettingsDirty) return;
    const nextStart =
      summary?.settings.console_auto_start_at ??
      visiblePersistedAutoRunStatus?.settings.console_auto_start_at ??
      "";
    const nextRefresh =
      summary?.settings.console_auto_refresh_minutes ??
      visiblePersistedAutoRunStatus?.settings.console_auto_refresh_minutes ??
      60;
    window.queueMicrotask(() => {
      setScheduleStartInput(nextStart);
      setSchedulePickerValue(parseScheduleInputToDateTimeLocalValue(nextStart));
      setScheduleRefreshInput(String(nextRefresh));
    });
  }, [
    scheduleSettingsDirty,
    summary?.settings.console_auto_start_at,
    summary?.settings.console_auto_refresh_minutes,
    visiblePersistedAutoRunStatus?.settings.console_auto_start_at,
    visiblePersistedAutoRunStatus?.settings.console_auto_refresh_minutes,
  ]);

  useEffect(() => {
    const persistedScope =
      summary?.settings.console_scan_scope ??
      visiblePersistedAutoRunStatus?.settings.console_scan_scope;
    if (persistedScope !== "trending" && persistedScope !== "full_universe") {
      return;
    }
    window.queueMicrotask(() => setConsoleScanScope(persistedScope));
  }, [
    summary?.settings.console_scan_scope,
    visiblePersistedAutoRunStatus?.settings.console_scan_scope,
  ]);

  useEffect(() => {
    const handleStageOneSettingsUpdated = (event: Event) => {
      const nextScope = (
        event as CustomEvent<{
          console_scan_scope?: "trending" | "full_universe";
        }>
      ).detail?.console_scan_scope;
      if (nextScope === "trending" || nextScope === "full_universe") {
        setConsoleScanScope(nextScope);
      }
    };
    window.addEventListener(
      BULLPEN_STAGE_ONE_SETTINGS_UPDATED_EVENT,
      handleStageOneSettingsUpdated,
    );
    return () => {
      window.removeEventListener(
        BULLPEN_STAGE_ONE_SETTINGS_UPDATED_EVENT,
        handleStageOneSettingsUpdated,
      );
    };
  }, []);

  useEffect(() => {
    const nextTargets = summary?.settings.console_llm_targets ?? [];
    savedSelectedLlmTargetsRef.current = serializeProviderTargets(nextTargets);
    if (nextTargets.length > 0) {
      legacyBullpenLlmTargetsBootstrapEligibleRef.current = false;
    }
    if (
      llmTargetSelectionSaveBusy ||
      pendingSelectedLlmTargetsSaveRef.current !== null
    ) {
      return;
    }
    window.queueMicrotask(() => {
      setSelectedLlmTargets((currentTargets) =>
        areProviderTargetsEqual(currentTargets, nextTargets)
          ? currentTargets
          : nextTargets,
      );
    });
  }, [llmTargetSelectionSaveBusy, summary?.settings.console_llm_targets]);


  useEffect(() => {
    if (llmExecutionSettingsDirty) return;
    const nextExecutionMode =
      summary?.settings.llm_execution_mode ?? DEFAULT_LLM_EXECUTION_MODE;
    const nextEventsPerPrompt =
      summary?.settings.llm_events_per_prompt ?? DEFAULT_LLM_EVENTS_PER_PROMPT;
    window.queueMicrotask(() => {
      setLlmExecutionMode(nextExecutionMode);
      setLlmEventsPerPromptInput(String(nextEventsPerPrompt));
      setLlmExecutionFieldError(null);
    });
  }, [
    llmExecutionSettingsDirty,
    summary?.settings.llm_execution_mode,
    summary?.settings.llm_events_per_prompt,
  ]);

  function resolveLlmEventsPerPromptValue() {
    const parsedValue = parseLlmEventsPerPrompt(llmEventsPerPromptInput);
    if (parsedValue === null) {
      setLlmExecutionFieldError("Enter a whole number from 1 to 100.");
      return null;
    }
    return parsedValue;
  }

  async function flushSelectedLlmTargetSaves() {
    if (selectedLlmTargetsSavePromiseRef.current) {
      await selectedLlmTargetsSavePromiseRef.current;
      return;
    }
    if (pendingSelectedLlmTargetsSaveRef.current === null) return;

    const savePromise = (async () => {
      selectedLlmTargetsSaveInFlightRef.current = true;
      setLlmTargetSelectionSaveBusy(true);
      setError(null);

      try {
        while (pendingSelectedLlmTargetsSaveRef.current !== null) {
          const nextTargets = pendingSelectedLlmTargetsSaveRef.current;
          pendingSelectedLlmTargetsSaveRef.current = null;
          const nextSerialized = serializeProviderTargets(nextTargets);

          if (nextSerialized === savedSelectedLlmTargetsRef.current) {
            continue;
          }

          const updatedSettings = await apiService.updateBullpenAutoLiveSettings({
            console_llm_targets: nextTargets,
          });
          const savedTargets = updatedSettings.console_llm_targets ?? [];
          savedSelectedLlmTargetsRef.current = serializeProviderTargets(
            savedTargets,
          );
          legacyBullpenLlmTargetsBootstrapEligibleRef.current = false;
          if (savedTargets.length > 0) {
            legacyBullpenLlmTargetsRef.current = savedTargets;
          }
        }
        await loadSummary({ preserveLoading: true });
      } catch (nextError) {
        setError(normalizeError(nextError));
        const reloadedSummary = await loadSummary({ preserveLoading: true });
        const reloadedTargets = reloadedSummary?.settings.console_llm_targets ?? [];
        savedSelectedLlmTargetsRef.current =
          serializeProviderTargets(reloadedTargets);
        setSelectedLlmTargets(reloadedTargets);
      } finally {
        selectedLlmTargetsSaveInFlightRef.current = false;
        setLlmTargetSelectionSaveBusy(false);
      }
    })();

    selectedLlmTargetsSavePromiseRef.current = savePromise;
    try {
      await savePromise;
    } finally {
      if (selectedLlmTargetsSavePromiseRef.current === savePromise) {
        selectedLlmTargetsSavePromiseRef.current = null;
      }
      if (pendingSelectedLlmTargetsSaveRef.current !== null) {
        await flushSelectedLlmTargetSaves();
      }
    }
  }

  useEffect(() => {
    if (!summary) return;
    if (legacyBullpenLlmTargetsBootstrapStartedRef.current) return;
    if ((summary.settings.console_llm_targets ?? []).length > 0) return;
    if (!legacyBullpenLlmTargetsBootstrapEligibleRef.current) return;

    const legacyTargets = legacyBullpenLlmTargetsRef.current;
    if (legacyTargets.length === 0) return;

    legacyBullpenLlmTargetsBootstrapStartedRef.current = true;
    setSelectedLlmTargets((currentTargets) =>
      areProviderTargetsEqual(currentTargets, legacyTargets)
        ? currentTargets
        : legacyTargets,
    );
    pendingSelectedLlmTargetsSaveRef.current = legacyTargets;
    void flushSelectedLlmTargetSaves();
    // flushSelectedLlmTargetSaves intentionally reads the latest refs/state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary]);

  async function handleSelectedLlmTargetsChange(
    nextTargets: ProviderModelTarget[],
  ) {
    setSelectedLlmTargets(nextTargets);
    pendingSelectedLlmTargetsSaveRef.current = nextTargets;
    void flushSelectedLlmTargetSaves();
  }

  async function ensureCanonicalStage2LlmTargets(options?: {
    requireNonEmpty?: boolean;
  }) {
    await flushSelectedLlmTargetSaves();

    const currentSummary =
      summary ?? (await loadSummary({ preserveLoading: true }));
    const serverTargets = currentSummary?.settings.console_llm_targets ?? [];
    const nextTargets = resolveCanonicalStage2TargetSelection(
      selectedLlmTargets,
      serverTargets,
      legacyBullpenLlmTargetsBootstrapEligibleRef.current
        ? legacyBullpenLlmTargetsRef.current
        : null,
    );

    if (nextTargets.length === 0) {
      if (options?.requireNonEmpty) {
        setError(missingStage2TargetsError());
        setNotice(null);
        if (startNowProgressTimeoutRef.current !== null) {
          window.clearTimeout(startNowProgressTimeoutRef.current);
          startNowProgressTimeoutRef.current = null;
        }
        setStartNowProgress(null);
      }
      return options?.requireNonEmpty ? null : undefined;
    }

    if (areProviderTargetsEqual(serverTargets, nextTargets)) {
      legacyBullpenLlmTargetsRef.current = nextTargets;
      return nextTargets;
    }

    const updatedSettings = await apiService.updateBullpenAutoLiveSettings({
      console_llm_targets: nextTargets,
    });
    const savedTargets = updatedSettings.console_llm_targets ?? [];
    savedSelectedLlmTargetsRef.current = serializeProviderTargets(savedTargets);
    legacyBullpenLlmTargetsBootstrapEligibleRef.current = false;
    if (savedTargets.length > 0) {
      legacyBullpenLlmTargetsRef.current = savedTargets;
    }
    setSelectedLlmTargets((currentTargets) =>
      areProviderTargetsEqual(currentTargets, savedTargets)
        ? currentTargets
        : savedTargets,
    );
    await loadSummary({ preserveLoading: true });

    if (savedTargets.length === 0 && options?.requireNonEmpty) {
      setError(missingStage2TargetsError());
      setNotice(null);
      return null;
    }

    return savedTargets.length > 0 ? savedTargets : undefined;
  }

  async function handleSaveLlmExecutionSettings(options?: {
    silentSuccess?: boolean;
  }) {
    const nextEventsPerPrompt = resolveLlmEventsPerPromptValue();
    if (nextEventsPerPrompt === null) {
      return false;
    }

    setError(null);
    setLlmExecutionSettingsSaveBusy(true);
    try {
      await apiService.updateBullpenAutoLiveSettings({
        llm_execution_mode: llmExecutionMode,
        llm_events_per_prompt: nextEventsPerPrompt,
      });
      setLlmExecutionSettingsDirty(false);
      setLlmEventsPerPromptInput(String(nextEventsPerPrompt));
      setLlmExecutionFieldError(null);
      await loadSummary({ preserveLoading: true });
      if (!options?.silentSuccess) {
        setNotice(
          buildLlmExecutionSummary(llmExecutionMode, nextEventsPerPrompt),
        );
      }
      return true;
    } catch (nextError) {
      setError(normalizeError(nextError));
      return false;
    } finally {
      setLlmExecutionSettingsSaveBusy(false);
    }
  }

  function handleLlmEventsPerPromptInputChange(
    event: ChangeEvent<HTMLInputElement>,
  ) {
    setLlmEventsPerPromptInput(event.target.value);
    setLlmExecutionSettingsDirty(true);
    setLlmExecutionFieldError(null);
  }

  function handleLlmExecutionModeChange(nextMode: BullpenLlmExecutionMode) {
    setLlmExecutionMode(nextMode);
    setLlmExecutionSettingsDirty(true);
    setLlmExecutionFieldError(null);
  }

  function mergeTerminalRunEvidence(
    nextSummary: BullpenAutoLiveSummaryResponse,
    trackedRun: BullpenAutoLiveRun | null,
  ): {
    summary: BullpenAutoLiveSummaryResponse;
    run: BullpenAutoLiveRun | null;
  } {
    if (!trackedRun) return { summary: nextSummary, run: null };
    const cachedEvidence = terminalRunEvidenceRef.current.get(trackedRun.id);
    if (!cachedEvidence) return { summary: nextSummary, run: trackedRun };

    const mergedRun = mergeBullpenConsoleRunProjection({
      existing: cachedEvidence.run,
      projected: trackedRun,
      projectionAvailable: true,
    });
    const projectedDecisions = nextSummary.recent_decisions.filter(
      (decision) => decision.run_id === trackedRun.id,
    );
    const mergedDecisions = mergeBullpenConsoleDecisionProjection({
      existing: cachedEvidence.decisions,
      projected: projectedDecisions,
      truncated: true,
    });
    terminalRunEvidenceRef.current.set(trackedRun.id, {
      run: mergedRun,
      decisions: mergedDecisions,
    });

    const recentRuns = nextSummary.recent_runs.some(
      (recentRun) => recentRun.id === trackedRun.id,
    )
      ? nextSummary.recent_runs.map((recentRun) =>
          recentRun.id === trackedRun.id ? mergedRun : recentRun,
        )
      : [mergedRun, ...nextSummary.recent_runs];
    const otherDecisions = nextSummary.recent_decisions.filter(
      (decision) => decision.run_id !== trackedRun.id,
    );

    return {
      summary: {
        ...nextSummary,
        latest_run:
          nextSummary.latest_run?.id === trackedRun.id
            ? mergedRun
            : nextSummary.latest_run,
        recent_runs: recentRuns,
        recent_decisions: [...mergedDecisions, ...otherDecisions],
      },
      run: mergedRun,
    };
  }

  function hasTruncatedStageOneCandidates(run: BullpenAutoLiveRun) {
    const scanStage = buildBullpenAutoRunWorkflowView(run).stages.find(
      (stage) => stage.key === "scan",
    );
    if (!scanStage) return false;
    const acceptedCount =
      readStageOutputNumber(scanStage.outputs.accepted_candidates_count) ??
      readStageOutputNumber(scanStage.outputs.stage1_accepted_candidate_count);
    return (
      acceptedCount !== null && acceptedCount > scanStage.scanCandidates.length
    );
  }

  async function hydrateTerminalRunEvidence({
    summary: nextSummary,
    run,
    pendingRunId: resolvedPendingRunId,
    signal,
  }: {
    summary: BullpenAutoLiveSummaryResponse;
    run: BullpenAutoLiveRun | null;
    pendingRunId: string | null;
    signal?: AbortSignal;
  }) {
    if (!run) return;
    if (!isBullpenAutoRunWorkflowSettled(buildBullpenAutoRunWorkflowView(run))) {
      return;
    }
    if (terminalRunEvidenceRef.current.has(run.id)) return;
    const retryAt = terminalRunHydrationRetryAtRef.current.get(run.id) ?? 0;
    if (retryAt > Date.now()) return;

    const existingTask = terminalRunHydrationInFlightRef.current.get(run.id);
    if (existingTask) return existingTask;

    const task = (async () => {
      try {
        const [runDetail, fullDecisions] = await Promise.all([
          apiService.getBullpenAutoLiveRunConsole(run.id, {
            signal,
            timeoutMs: 15_000,
          }),
          apiService.getBullpenAutoLiveRunDecisions(run.id, {
            signal,
            timeoutMs: 15_000,
          }),
        ]);
        if (signal?.aborted) return;

        const fullRun =
          runDetail.projection_available &&
          !hasTruncatedStageOneCandidates(runDetail.run)
            ? runDetail.run
            : await apiService.getBullpenAutoLiveRun(run.id, {
                signal,
                timeoutMs: 15_000,
              });
        if (signal?.aborted) return;
        const mergedRun = mergeBullpenConsoleRunProjection({
          existing: fullRun,
          projected: run,
          projectionAvailable: runDetail.projection_available,
        });
        const projectedDecisions = nextSummary.recent_decisions.filter(
          (decision) => decision.run_id === run.id,
        );
        const mergedDecisions = mergeBullpenConsoleDecisionProjection({
          existing: fullDecisions,
          projected: projectedDecisions,
          truncated: true,
        });
        terminalRunEvidenceRef.current.set(run.id, {
          run: mergedRun,
          decisions: mergedDecisions,
        });
        terminalRunHydrationRetryAtRef.current.delete(run.id);
        while (terminalRunEvidenceRef.current.size > 5) {
          const oldestRunId = terminalRunEvidenceRef.current.keys().next().value;
          if (typeof oldestRunId !== "string") break;
          terminalRunEvidenceRef.current.delete(oldestRunId);
        }

        const hydrated = mergeTerminalRunEvidence(nextSummary, mergedRun);
        if (signal?.aborted) return;
        setSummary(hydrated.summary);
        onSummaryUpdated?.({
          summary: hydrated.summary,
          run: hydrated.run,
          pendingRunId: resolvedPendingRunId,
        });
      } catch (nextError) {
        if (signal?.aborted || isRequestAbort(nextError)) return;
        terminalRunHydrationRetryAtRef.current.set(
          run.id,
          Date.now() + 15_000,
        );
        console.warn(
          JSON.stringify({
            event: "bullpen_auto_run_terminal_evidence_hydration_failed",
            run_id: run.id,
            error: formatUnknownError(nextError),
          }),
        );
      } finally {
        terminalRunHydrationInFlightRef.current.delete(run.id);
      }
    })();

    terminalRunHydrationInFlightRef.current.set(run.id, task);
    return task;
  }

  async function loadSummary(options?: {
    preserveLoading?: boolean;
    nextPendingRunId?: string | null;
    skipIfFreshMs?: number;
  }) {
    // setInterval does not wait for an async callback. Do not pile up requests
    // if the API is slow (for example while Celery is reporting run status).
    if (summaryLoadInFlightRef.current) return null;
    if (
      options?.skipIfFreshMs &&
      Date.now() - summaryLastLoadedAtRef.current < options.skipIfFreshMs
    ) {
      return summary;
    }
    summaryLoadInFlightRef.current = true;
    const requestSignal = summaryAbortControllerRef.current?.signal;

    let loadingCleared = Boolean(options?.preserveLoading);
    const resolvedPendingRunId = options?.nextPendingRunId ?? pendingRunId;
    if (!options?.preserveLoading) {
      setLoading(true);
    }
    try {
      const nextSummary = await apiService.getBullpenAutoLiveDashboardSummary({
        signal: requestSignal,
        timeoutMs: 15_000,
      });
      if (requestSignal?.aborted) return null;
      const projectedTrackedRun = getVisibleRun(
        nextSummary,
        resolvedPendingRunId,
        workspaceProfile,
      );
      const evidencePreservingSummary = preserveCompletedStageEvidence(
        summary,
        nextSummary,
        projectedTrackedRun,
      );
      const evidencePreservingTrackedRun = getVisibleRun(
        evidencePreservingSummary,
        resolvedPendingRunId,
        workspaceProfile,
      );
      const visiblePayload = mergeTerminalRunEvidence(
        evidencePreservingSummary,
        evidencePreservingTrackedRun,
      );
      setSummary(visiblePayload.summary);
      summaryLastLoadedAtRef.current = Date.now();
      markBullpenAutoRunPerformance("bullpen-workflow-ready");
      setError(null);
      onSummaryUpdated?.({
        summary: visiblePayload.summary,
        run: visiblePayload.run,
        pendingRunId: resolvedPendingRunId,
      });
      void hydrateTerminalRunEvidence({
        summary: visiblePayload.summary,
        run: visiblePayload.run,
        pendingRunId: resolvedPendingRunId,
        signal: requestSignal,
      });
      if (!loadingCleared) {
        setLoading(false);
        loadingCleared = true;
      }
      return visiblePayload.summary;
    } catch (nextError) {
      if (requestSignal?.aborted || isRequestAbort(nextError)) {
        return null;
      }
      const isTransientDashboardRead =
        nextError === null ||
        nextError === undefined ||
        nextError instanceof RequestTimeoutError ||
        (nextError instanceof APIError && nextError.status >= 500);
      if (isTransientDashboardRead && visiblePersistedAutoRunStatus) {
        console.warn(
          JSON.stringify({
            event: "bullpen_auto_run_dashboard_poll_degraded",
            reason:
              nextError instanceof RequestTimeoutError
                ? "timeout"
                : nextError instanceof APIError
                  ? `http_${nextError.status}`
                  : "unavailable",
          }),
        );
        window.setTimeout(() => {
          if (!requestSignal?.aborted) {
            void loadSummary({
              preserveLoading: true,
              nextPendingRunId: resolvedPendingRunId,
            });
          }
        }, POLL_INTERVAL_MS);
        return summary;
      }
      setError(normalizeError(nextError));
      return null;
    } finally {
      if (!loadingCleared && !requestSignal?.aborted) {
        setLoading(false);
      }
      summaryLoadInFlightRef.current = false;
    }
  }

  const loadRunHistory = useCallback(async (page = 1) => {
    runHistoryAbortControllerRef.current?.abort();
    const controller = new AbortController();
    const requestOwnerKey = autoRunStatusCacheKey;
    runHistoryAbortControllerRef.current = controller;
    if (runHistoryOwnerKeyRef.current !== requestOwnerKey) {
      runHistoryOwnerKeyRef.current = requestOwnerKey;
      setRunHistoryOwnerKey(requestOwnerKey);
      setRunHistoryPage(null);
      setRunHistoryEventTrends(null);
    }
    setRunHistoryLoading(true);
    setRunHistoryEventTrendsLoading(true);
    setRunHistoryError(null);
    setRunHistoryEventTrendsError(null);

    try {
      const historyRequestOptions = {
          signal: controller.signal,
          timeoutMs: 5_000,
        };
      const [pageResult, trendsResult] = await Promise.allSettled([
        apiService.getBullpenAutoLiveHistory(
          { page, size: 20, workspaceProfile },
          historyRequestOptions,
        ),
        apiService.getBullpenAutoLiveHistoryEventTrends(
          {
            workspaceProfile,
            timeoutSeconds: eventTrendsTimeoutSeconds,
          },
          {
            signal: controller.signal,
            timeoutMs:
              eventTrendsTimeoutSeconds * 1_000 +
              EVENT_TRENDS_CLIENT_GRACE_MS,
          },
        ),
      ]);
      if (controller.signal.aborted) return;

      if (pageResult.status === "fulfilled") {
        setRunHistoryPage(pageResult.value);
      } else if (!isRequestAbort(pageResult.reason)) {
        setRunHistoryError(
          `Run history is temporarily unavailable. ${formatUnknownError(pageResult.reason)}`,
        );
      }

      if (trendsResult.status === "fulfilled") {
        setRunHistoryEventTrends(trendsResult.value);
      } else if (!isRequestAbort(trendsResult.reason)) {
        setRunHistoryEventTrendsError(
          `Event trends are temporarily unavailable. ${formatUnknownError(trendsResult.reason)}`,
        );
      }
    } catch (nextError) {
      if (controller.signal.aborted || isRequestAbort(nextError)) return;
      setRunHistoryError(
        `Run history is temporarily unavailable. ${formatUnknownError(nextError)}`,
      );
    } finally {
      if (!controller.signal.aborted) {
        setRunHistoryLoading(false);
        setRunHistoryEventTrendsLoading(false);
      }
    }
  }, [autoRunStatusCacheKey, eventTrendsTimeoutSeconds, workspaceProfile]);

  async function openHistoryRunDetail(
    item: Pick<BullpenAutoLiveHistoryItem, "id">,
  ) {
      runHistoryDetailAbortControllerRef.current?.abort();
      const controller = new AbortController();
      runHistoryDetailAbortControllerRef.current = controller;
      setRunHistoryDetailLoadingId(item.id);
      setRunHistoryError(null);
      try {
        const consoleDetail = await apiService.getBullpenAutoLiveRunConsole(
          item.id,
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
              // this request merely to open the console detail screen.
              apiService.getBullpenAutoLiveRun(item.id, {
                signal: controller.signal,
                timeoutMs: 10_000,
              }),
              apiService.getBullpenAutoLiveRunDecisions(item.id, {
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
        setRunDetailDialog({
          run: detailRun,
          decisions: detailDecisions,
          decisionListTruncated,
          decisionListLimit,
        });
        closeRunHistoryDialog();
      } catch (nextError) {
        if (controller.signal.aborted || isRequestAbort(nextError)) return;
        const message =
          `Run ${item.id} details could not be loaded. ` +
          formatUnknownError(nextError);
        setRunHistoryError(message);
        if (requestedRunDetailId === item.id) {
          setRuntimeErrorDialog(message);
        }
      } finally {
        if (!controller.signal.aborted) {
          setRunHistoryDetailLoadingId(null);
        }
      }
  }

  const openRequestedRunDetail = useEffectEvent((runId: string) => {
    void openHistoryRunDetail({ id: runId });
  });

  useEffect(() => {
    if (!requestedRunDetailId) {
      handledRequestedRunDetailIdRef.current = null;
      return;
    }
    if (handledRequestedRunDetailIdRef.current === requestedRunDetailId) {
      return;
    }
    // The console route is already server-protected. Do not make run-detail
    // activation depend on the client auth provider finishing a second session
    // bootstrap; that gate could leave the URL correct while showing the
    // ordinary latest-run workspace forever.
    handledRequestedRunDetailIdRef.current = requestedRunDetailId;
    openRequestedRunDetail(requestedRunDetailId);
  }, [requestedRunDetailId]);

  function closeRunDetailDialog() {
    setRunDetailDialog(null);
    if (!requestedRunDetailId) return;
    handledRequestedRunDetailIdRef.current = null;
    router.replace(
      returnRunDetailToHistory
        ? bullpenWorkspaceHistoryPath(workspaceProfile)
        : bullpenWorkspacePath(workspaceProfile),
    );
  }

  function closeRunHistoryDialog() {
    runHistoryAbortControllerRef.current?.abort();
    runHistoryDetailAbortControllerRef.current?.abort();
    setRunHistoryDetailLoadingId(null);
    setIsRunHistoryDialogOpen(false);
  }

  useEffect(() => {
    if (!isRunHistoryDialogOpen) {
      runHistoryAbortControllerRef.current?.abort();
      runHistoryAbortControllerRef.current = null;
      // A run selected on the full-screen history page uses this same detail
      // loader after navigating back to the console. Do not let the closed
      // in-page history-dialog cleanup abort that direct URL request.
      if (!requestedRunDetailId) {
        runHistoryDetailAbortControllerRef.current?.abort();
        runHistoryDetailAbortControllerRef.current = null;
      }
      return;
    }

    let cancelled = false;
    window.queueMicrotask(() => {
      if (!cancelled) {
        void loadRunHistory();
      }
    });
    return () => {
      cancelled = true;
      runHistoryAbortControllerRef.current?.abort();
      runHistoryDetailAbortControllerRef.current?.abort();
    };
  }, [
    autoRunStatusCacheKey,
    isRunHistoryDialogOpen,
    loadRunHistory,
    requestedRunDetailId,
  ]);

  const runDetailRefreshRunId = runDetailDialog?.run.id ?? null;
  const runDetailRefreshRunStatus = runDetailDialog?.run.status ?? null;
  useEffect(() => {
    if (
      !runDetailRefreshRunId ||
      (runDetailRefreshRunStatus !== "running" &&
        runDetailRefreshRunStatus !== "confirming")
    ) {
      runDetailRefreshAbortControllerRef.current?.abort();
      runDetailRefreshAbortControllerRef.current = null;
      return;
    }

    const controller = new AbortController();
    runDetailRefreshAbortControllerRef.current = controller;
    let timeoutId: number | null = null;
    let cancelled = false;

    const refreshExactRun = async () => {
      if (cancelled || controller.signal.aborted) return;
      if (document.visibilityState === "hidden") {
        timeoutId = window.setTimeout(refreshExactRun, POLL_INTERVAL_MS);
        return;
      }
      try {
        const {
          run,
          decisions,
          projection_available: projectionAvailable,
          decisions_truncated: decisionsTruncated,
          decisions_limit: decisionsLimit,
          visible_decision_ids: visibleDecisionIds,
          visible_decision_ids_truncated: visibleDecisionIdsTruncated,
        } =
          await apiService.getBullpenAutoLiveRunConsole(
            runDetailRefreshRunId,
            {
              signal: controller.signal,
              timeoutMs: 5_000,
            },
          );
        if (cancelled || controller.signal.aborted) return;
        const stage =
          buildBullpenAutoRunWorkflowView(run).stages.find(
            (workflowStage) => workflowStage.key === "invest",
          ) ?? null;
        const projectedDecisions = mergeInvestStageDecisionRows({
          stage,
          persistedDecisions: decisions,
        });
        setRunDetailDialog((current) => {
          if (!current || current.run.id !== run.id) return current;
          if (!projectionAvailable) return current;
          const nextDecisions = mergeBullpenConsoleDecisionProjection({
            existing: current.decisions,
            projected: projectedDecisions,
            truncated: decisionsTruncated,
            visibleDecisionIds,
            visibleDecisionIdsTruncated,
          });
          return {
            run: mergeBullpenConsoleRunProjection({
              existing: current.run,
              projected: run,
              projectionAvailable,
            }),
            decisions: nextDecisions,
            decisionListTruncated:
              visibleDecisionIdsTruncated ||
              (decisionsTruncated &&
                nextDecisions.length <
                  (visibleDecisionIds?.length ??
                    run.decisions_count)),
            decisionListLimit: decisionsLimit,
          };
        });
      } catch (nextError) {
        if (
          controller.signal.aborted ||
          cancelled ||
          isRequestAbort(nextError)
        ) {
          return;
        }
        // Preserve the last verified dialog snapshot. The main workflow poll
        // and the next bounded exact-run refresh can recover independently.
      } finally {
        if (!cancelled && !controller.signal.aborted) {
          timeoutId = window.setTimeout(refreshExactRun, POLL_INTERVAL_MS);
        }
      }
    };

    window.queueMicrotask(() => {
      void refreshExactRun();
    });
    return () => {
      cancelled = true;
      controller.abort();
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      if (runDetailRefreshAbortControllerRef.current === controller) {
        runDetailRefreshAbortControllerRef.current = null;
      }
    };
  }, [runDetailRefreshRunId, runDetailRefreshRunStatus]);

  useEffect(() => {
    const controller = new AbortController();
    summaryAbortControllerRef.current = controller;
    const idleCallbackId = window.requestIdleCallback?.(
      () => {
        if (!controller.signal.aborted) {
          void loadSummary({ skipIfFreshMs: POLL_INTERVAL_MS - 100 });
        }
      },
      { timeout: 1_000 },
    );
    if (idleCallbackId === undefined) {
      window.queueMicrotask(() => {
        if (!controller.signal.aborted) {
          void loadSummary({ skipIfFreshMs: POLL_INTERVAL_MS - 100 });
        }
      });
    }
    return () => {
      controller.abort();
      if (idleCallbackId !== undefined) {
        window.cancelIdleCallback?.(idleCallbackId);
      }
      if (summaryAbortControllerRef.current === controller) {
        summaryAbortControllerRef.current = null;
      }
    };
    // loadSummary intentionally reads the latest pending run id at execution time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshPortfolioSnapshot = useCallback(
    async (forceBalanceRefresh: boolean) => {
      if (portfolioLoadInFlightRef.current) return;
      const requestSignal = portfolioAbortControllerRef.current?.signal;
      if (requestSignal?.aborted) return;
      portfolioLoadInFlightRef.current = true;
      if (forceBalanceRefresh) {
        setPortfolioRefreshing(true);
        setPortfolioRefreshNotice(null);
      }
      setPortfolioLoading(true);

      const applyPortfolioState = (nextState: PolymarketBotState) => {
        setPortfolioState(nextState);
        if (isUsableBullpenBalance(nextState.live.balance)) {
          setLastUsablePortfolioBalance(nextState.live.balance);
        }
      };
      const positionsRefreshTask: Promise<string | null> | null =
        forceBalanceRefresh && onRefreshPortfolioPositionsRef.current
          ? Promise.resolve()
              .then(() => onRefreshPortfolioPositionsRef.current?.())
              .then(() => null)
              .catch((nextError) => {
                if (requestSignal?.aborted || isRequestAbort(nextError)) {
                  return null;
                }
                return `Wallet positions refresh is temporarily unavailable. ${normalizeError(nextError)}`;
              })
          : null;

      try {
        let nextState = forceBalanceRefresh
          ? await apiService.polymarketLiveBalanceRefresh({
              signal: requestSignal,
              timeoutMs: 5_000,
            })
          : await apiService.polymarketState({
              signal: requestSignal,
              timeoutMs: 15_000,
            });
        if (requestSignal?.aborted) return;
        applyPortfolioState(nextState);

        if (forceBalanceRefresh && nextState.live.balance.status === "loading") {
          for (let attempt = 0; attempt < 20; attempt += 1) {
            await new Promise<void>((resolve) => {
              window.setTimeout(resolve, 1_000);
            });
            if (requestSignal?.aborted) return;
            try {
              nextState = await apiService.polymarketState({
                signal: requestSignal,
                timeoutMs: 5_000,
              });
              if (requestSignal?.aborted) return;
              applyPortfolioState(nextState);
              if (nextState.live.balance.status !== "loading") break;
            } catch (nextError) {
              if (requestSignal?.aborted || isRequestAbort(nextError)) return;
              if (attempt === 19) {
                setPortfolioRefreshNotice(
                  `Balance refresh is still running in the background. The last usable snapshot remains displayed. ${normalizeError(nextError)}`,
                );
              }
            }
          }
          if (nextState.live.balance.status === "loading") {
            setPortfolioRefreshNotice(
              "Balance refresh is still running in the background. The last usable snapshot remains displayed and will update automatically.",
            );
          } else if (nextState.live.balance.status === "error") {
            setPortfolioRefreshNotice(
              nextState.live.balance.message ||
                "Bullpen balance refresh finished without a usable snapshot.",
            );
          }
        }
      } catch (nextError) {
        if (!requestSignal?.aborted && !isRequestAbort(nextError)) {
          setPortfolioRefreshNotice(
            `Portfolio refresh is temporarily unavailable. The last usable snapshot remains displayed. ${normalizeError(nextError)}`,
          );
        }
      } finally {
        const positionsWarning = positionsRefreshTask
          ? await positionsRefreshTask
          : null;
        if (positionsWarning && !requestSignal?.aborted) {
          setPortfolioRefreshNotice(positionsWarning);
        }
        portfolioLoadInFlightRef.current = false;
        if (!requestSignal?.aborted) {
          setPortfolioLoading(false);
          if (forceBalanceRefresh) {
            setPortfolioRefreshing(false);
          }
        }
      }
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    portfolioAbortControllerRef.current = controller;
    const refreshIfVisible = () => {
      if (isBullpenAutoRunPageVisible(document.visibilityState)) {
        void refreshPortfolioSnapshot(false);
      }
    };

    refreshIfVisible();
    const intervalId = window.setInterval(() => {
      refreshIfVisible();
    }, 30_000);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      controller.abort();
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", refreshIfVisible);
      if (portfolioAbortControllerRef.current === controller) {
        portfolioAbortControllerRef.current = null;
      }
    };
  }, [refreshPortfolioSnapshot]);

  const summaryActiveRunId =
    summary?.latest_run?.status === "running" ||
    summary?.latest_run?.status === "confirming"
      ? summary.latest_run.id
      : null;
  const trackedRunId =
    pendingRunId ??
    getBullpenAutoRunActiveRunId(visiblePersistedAutoRunStatus) ??
    // If the fast status is temporarily unavailable, preserve progress from
    // an already-loaded summary. Once the fast status is ready, its indexed
    // active-run identity is authoritative and terminal runs stop polling.
    (autoRunStatusLoadState === "ready" ? null : summaryActiveRunId);

  const pollTrackedRun = useEffectEvent(async (runId: string) => {
    if (!isBullpenAutoRunPageVisible(document.visibilityState)) {
      return;
    }
    const nextSummary = await loadSummary({
      preserveLoading: true,
      skipIfFreshMs: POLL_INTERVAL_MS - 100,
    });
    if (!nextSummary) {
      return;
    }

    const matchingRun =
      nextSummary.recent_runs.find((run) => run.id === runId) ??
      (nextSummary.latest_run?.id === runId ? nextSummary.latest_run : null);
    if (
      !matchingRun ||
      matchingRun.status === "running" ||
      matchingRun.status === "confirming"
    ) {
      return;
    }

    // The status endpoint owns the active-run identity. Promptly revalidate
    // it after a terminal summary so the 10-second progress poll is removed
    // instead of retaining a completed historical run.
    void refreshPersistedAutoRunStatus();

    if (!postCompletionPortfolioRefreshRunIdsRef.current.has(runId)) {
      postCompletionPortfolioRefreshRunIdsRef.current.add(runId);
      await refreshPortfolioSnapshot(true);
    }

    if (pendingRunId === runId) {
      setPendingRunId(null);
      setRunNowStartedAt(null);
      // Keep the rendered action state and the synchronous action lock in
      // sync. Clearing only the React state makes the button look enabled
      // while claimAction still rejects every click as already in flight.
      clearClaimedAction();
      setNotice(matchingRun.summary);
      if (onRunCompleted) {
        await onRunCompleted();
      }
    }
  });

  useEffect(() => {
    if (!trackedRunId) return;

    const pollIfVisible = () => {
      if (isBullpenAutoRunPageVisible(document.visibilityState)) {
        void pollTrackedRun(trackedRunId);
      }
    };
    pollIfVisible();
    const intervalId = window.setInterval(() => {
      pollIfVisible();
    }, POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", pollIfVisible);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", pollIfVisible);
    };
  }, [trackedRunId]);


  useEffect(() => {
    if (!llmExecutionSettingsDirty || action !== null) return;
    const timeoutId = window.setTimeout(() => {
      void handleSaveLlmExecutionSettings({ silentSuccess: true });
    }, 600);

    return () => {
      window.clearTimeout(timeoutId);
    };
    // handleSaveLlmExecutionSettings intentionally reads the latest execution setting values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    llmExecutionSettingsDirty,
    llmExecutionMode,
    llmEventsPerPromptInput,
    action,
  ]);

  async function handleSaveScheduleSettings(options?: {
    silentSuccess?: boolean;
  }) {
    const refreshMinutes = Number.parseInt(scheduleRefreshInput, 10);
    if (!Number.isFinite(refreshMinutes) || refreshMinutes < 1) {
      setError({
        message: "Enter a refresh duration of at least 1 minute.",
        details: null,
      });
      return false;
    }
    setError(null);
    setScheduleSettingsSaveBusy(true);
    const startWasNow = scheduleStartInput.trim().toLowerCase() === "now";
    const normalizedStart = startWasNow ? "" : scheduleStartInput.trim();
    try {
      const consoleLlmTargets = await ensureCanonicalStage2LlmTargets();
      await apiService.updateBullpenAutoLiveSettings(
        buildConsoleSettingsUpdate(
          persistedConsoleOrderUsd,
          consoleScanScope,
          normalizedStart || null,
          refreshMinutes,
          consoleLlmTargets,
        ),
      );
      void refreshPersistedAutoRunStatus();
      setScheduleSettingsDirty(false);
      setScheduleStartInput(startWasNow ? "Now" : normalizedStart);
      await loadSummary({ preserveLoading: true });
      if (!options?.silentSuccess) {
        setNotice("Auto-run schedule saved.");
      }
      return true;
    } catch (nextError) {
      setError(normalizeError(nextError));
      return false;
    } finally {
      setScheduleSettingsSaveBusy(false);
    }
  }

  useEffect(() => {
    if (!scheduleSettingsDirty || action !== null) return;
    const timeoutId = window.setTimeout(() => {
      void handleSaveScheduleSettings({ silentSuccess: true });
    }, 600);

    return () => {
      window.clearTimeout(timeoutId);
    };
    // handleSaveScheduleSettings intentionally reads the latest schedule input values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleSettingsDirty, scheduleStartInput, scheduleRefreshInput, action]);

  async function handleEnableAutoRuns() {
    if (!claimAction("enable")) return;
    setNotice(null);
    setError(null);
    startNowCancelledRef.current = false;

    try {
      const refreshMinutes = Number.parseInt(scheduleRefreshInput, 10);
      if (!Number.isFinite(refreshMinutes) || refreshMinutes < 1) {
        setError({
          message: "Enter a refresh duration of at least 1 minute.",
          details: null,
        });
        return;
      }
      const startWasNow = scheduleStartInput.trim().toLowerCase() === "now";
      const normalizedStart = startWasNow ? "" : scheduleStartInput.trim();
      // Every scheduled cycle includes Stage 2, not only an immediate first
      // cycle. Do not enable a scheduler that is guaranteed to scan rows and
      // then stop before LLM review because its frozen target list is empty.
      const consoleLlmTargets = await ensureCanonicalStage2LlmTargets({
        requireNonEmpty: true,
      });
      if (!consoleLlmTargets) {
        return;
      }
      await apiService.updateBullpenAutoLiveSettings(
        buildConsoleSettingsUpdate(
          persistedConsoleOrderUsd,
          consoleScanScope,
          normalizedStart || null,
          refreshMinutes,
          consoleLlmTargets,
        ),
      );
      setScheduleStartInput(startWasNow ? "Now" : normalizedStart);
      setOptimisticSchedulerState({
        running: true,
        paused: false,
        message: startWasNow
          ? "Auto runs are enabling and the first run is queueing…"
          : "Auto runs are enabling. Waiting for backend status confirmation…",
      });
      const startedState = await apiService.startBullpenAutoLive();
      setOptimisticSchedulerState({
        running: true,
        paused: Boolean(startedState.paused),
        message: "Auto runs enabled. Refreshing confirmed backend status…",
      });
      void refreshPersistedAutoRunStatus();
      setSummary((currentSummary) =>
        currentSummary
          ? {
              ...currentSummary,
              state: startedState,
              settings: {
                ...currentSummary.settings,
                auto_live_enabled: true,
                dry_run: false,
                allow_live_execution: true,
                require_manual_confirmation: false,
                strategy_profile: CONSOLE_PROFILE_ID,
                console_order_usd: persistedConsoleOrderUsd,
                console_auto_start_at: startWasNow
                  ? null
                  : normalizedStart || null,
                console_auto_refresh_minutes: refreshMinutes,
              },
            }
          : currentSummary,
      );
      if (startWasNow) {
        const run = await apiService.runBullpenAutoLiveOnce();
        setPendingRunId(run.id);
        setRunNowStartedAt(run.started_at ?? new Date().toISOString());
      }
      // Runtime diagnostics/history are intentionally background-only after
      // the mutation succeeds; they must not keep the action controls busy.
      void loadSummary({ preserveLoading: true });
      const nextRunAt = startedState.next_run_at;
      setNotice(
        nextRunAt
          ? `Auto runs enabled. Next scheduled run: ${formatIstDateTime(nextRunAt)}.`
          : "Auto runs enabled.",
      );
    } catch (nextError) {
      setOptimisticSchedulerState(null);
      setError(normalizeError(nextError));
    } finally {
      releaseClaimedAction("enable");
    }
  }

  async function handleStartAutoRunNow() {
    if (!claimAction("start-now")) return;
    setStageOneResultSource("original");
    const startedAt = new Date().toISOString();
    setRunNowStartedAt(startedAt);
    setTimerNowMs(Date.parse(startedAt));
    setNotice(null);
    setError(null);
    startNowCancelledRef.current = false;
    if (startNowProgressTimeoutRef.current !== null) {
      window.clearTimeout(startNowProgressTimeoutRef.current);
      startNowProgressTimeoutRef.current = null;
    }
    setStartNowProgress(
      "Validating this workflow and preparing its Auto Run request…",
    );
    const abortIfStartCancelled = () => {
      if (!startNowCancelledRef.current) return false;
      setStartNowProgress(null);
      setRunNowStartedAt(null);
      setPendingRunId(null);
      setNotice("Auto Run start was killed before the worker could continue.");
      return true;
    };

    try {
      const latestConsoleOrderUsd = resolvePositiveConsoleOrderUsd(
        tradeAmountView.tradeAmountUsd,
        persistedConsoleOrderUsd,
      );
      const consoleLlmTargets = await ensureCanonicalStage2LlmTargets({
        requireNonEmpty: true,
      });
      if (!consoleLlmTargets) {
        return;
      }

      setStartNowProgress(
        "Saving this run's trade amount and LLM settings…",
      );
      await apiService.updateBullpenAutoLiveSettings(
        buildImmediateRunSettingsUpdate(
          latestConsoleOrderUsd,
          consoleScanScope,
          consoleLlmTargets,
        ),
      );
      if (abortIfStartCancelled()) return;

      setStartNowProgress(
        `Queueing Stage 1 filters for ${
          workspaceProfile === "bullpen-sports"
            ? "Bullpen Sports"
            : "Bullpen 007"
        } on the latest completed Universal Scan…`,
      );
      const queued = await apiService.queueBullpenWorkflowRunNow({
        workspace_profile: workspaceProfile,
      });
      void refreshPersistedAutoRunStatus();
      if (abortIfStartCancelled()) return;
      setPendingRunId(queued.run_id);
      setRunNowStartedAt(queued.queued_at);
      setStartNowProgress(
        queued.status === "started"
          ? "Stage 1 started on the latest completed Universal Scan…"
          : "Stage 1 queued. It will start as soon as the guarded workflow lane is available…",
      );
      void loadSummary({
        preserveLoading: true,
        nextPendingRunId: queued.run_id,
      });
      setStartNowProgress(
        queued.status === "started"
          ? "Auto Run started. Live Stage 1 worker progress appears below."
          : "Auto Run queued. Live worker progress will appear below when Stage 1 starts.",
      );
      startNowProgressTimeoutRef.current = window.setTimeout(() => {
        setStartNowProgress(null);
        startNowProgressTimeoutRef.current = null;
      }, 5_000);
      setNotice(
        `${queued.status === "started" ? "Started" : "Queued"} only ${
          workspaceProfile === "bullpen-sports"
            ? "Bullpen Sports"
            : "Bullpen 007"
        } on the latest Universal Scan with ${formatMoney(
          latestConsoleOrderUsd,
        )} per new opportunity.`,
      );
    } catch (nextError) {
      setError(normalizeError(nextError));
      setRunNowStartedAt(null);
      setStartNowProgress(null);
    } finally {
      releaseClaimedAction("start-now");
    }
  }

  async function handleStopAutoRuns() {
    if (!claimAction("stop")) return;
    setNotice(null);
    setError(null);

    try {
      setOptimisticSchedulerState({
        running: false,
        paused: false,
        message: "Stopping auto runs and cancelling active backend work…",
      });
      await apiService.stopBullpenAutoLive();
      setOptimisticSchedulerState({
        running: false,
        paused: false,
        message: "Auto runs stopped. Refreshing confirmed backend status…",
      });
      void refreshPersistedAutoRunStatus();
      void loadSummary({ preserveLoading: true });
      setNotice(
        "Auto runs stopped. Any active Auto-Live run was cancelled immediately.",
      );
    } catch (nextError) {
      setOptimisticSchedulerState(null);
      setError(normalizeError(nextError));
    } finally {
      releaseClaimedAction("stop");
    }
  }

  async function handleInvestOnly(request: BullpenAutoLiveRunOnceRequest) {
    if (!claimAction("invest-now")) return;
    const startedAt = new Date().toISOString();
    setRunNowStartedAt(startedAt);
    setTimerNowMs(Date.parse(startedAt));
    setNotice(null);
    setError(null);

    try {
      const refreshMinutes = Number.parseInt(scheduleRefreshInput, 10);
      if (!Number.isFinite(refreshMinutes) || refreshMinutes < 1) {
        setError({
          message: "Enter a refresh duration of at least 1 minute.",
          details: null,
        });
        return;
      }
      const consoleLlmTargets = await ensureCanonicalStage2LlmTargets({
        requireNonEmpty: true,
      });
      if (!consoleLlmTargets) {
        setPendingRunId(null);
        setRunNowStartedAt(null);
        return;
      }
      await apiService.updateBullpenAutoLiveSettings(
        buildConsoleSettingsUpdate(
          persistedConsoleOrderUsd,
          consoleScanScope,
          scheduleStartInput.trim() || null,
          refreshMinutes,
          consoleLlmTargets,
        ),
      );
      const run = await apiService.runBullpenAutoLiveOnce(request);
      void refreshPersistedAutoRunStatus();
      const qualifiedCandidateCount =
        request.console_profile?.candidate_rows.length ?? 0;
      setPendingRunId(run.id);
      setRunNowStartedAt(run.started_at ?? new Date().toISOString());
      setNotice(
        `Queued invest-only run for ${qualifiedCandidateCount} Stage 2-qualified ${
          qualifiedCandidateCount === 1 ? "event" : "events"
        }.`,
      );
      // Summary includes diagnostics and history, so it must never keep this
      // submit action locked after the run has been safely queued.
      void loadSummary({ preserveLoading: true, nextPendingRunId: run.id });
    } catch (nextError) {
      setError(normalizeError(nextError));
      setPendingRunId(null);
      setRunNowStartedAt(null);
    } finally {
      releaseClaimedAction("invest-now");
    }
  }

  async function handleStage3Retry(
    request: BullpenAutoLiveRunOnceRequest,
    schedulerWasEnabled: boolean,
  ) {
    if (!claimAction("retry-stage3")) return;
    setNotice(null);
    setError(null);

    try {
      // Cancel first so the backend's single-active-run guard cannot turn the
      // replacement into a skipped run. Restore the scheduler before queueing.
      await apiService.stopBullpenAutoLive();
      if (schedulerWasEnabled) {
        await apiService.startBullpenAutoLive();
      }

      const run = await apiService.runBullpenAutoLiveOnce(request);
      setPendingRunId(run.id);
      setRunNowStartedAt(run.started_at ?? new Date().toISOString());
      setNotice(
        "Stage 3 retry queued from the saved Stage 2 output. Event Exits and Invest planned orders will both run again.",
      );
      void refreshPersistedAutoRunStatus();
      void loadSummary({ preserveLoading: true, nextPendingRunId: run.id });
    } catch (nextError) {
      setError(normalizeError(nextError));
      void refreshPersistedAutoRunStatus();
      void loadSummary({ preserveLoading: true });
    } finally {
      releaseClaimedAction("retry-stage3");
    }
  }

  function resetActiveAutoRunUi() {
    if (startNowProgressTimeoutRef.current !== null) {
      window.clearTimeout(startNowProgressTimeoutRef.current);
      startNowProgressTimeoutRef.current = null;
    }
    setPendingRunId(null);
    setRunNowStartedAt(null);
    setStartNowProgress(null);
    setSelectedRunSummaryTile("next");
    const activeRunIds = [summary?.latest_run, ...(summary?.recent_runs ?? [])]
      .filter((run): run is BullpenAutoLiveRun =>
        Boolean(run && isActivelyWorkingRunStatus(run.status)),
      )
      .map((run) => run.id);
    if (activeRunIds.length > 0) {
      setKilledRunIds((currentIds) => {
        const nextIds = new Set(currentIds);
        activeRunIds.forEach((runId) => nextIds.add(runId));
        return nextIds;
      });
    }
    setSummary((currentSummary) => {
      if (!currentSummary) return currentSummary;
      const stoppedAt = new Date().toISOString();
      const killRun = (
        run: BullpenAutoLiveRun | null | undefined,
      ): BullpenAutoLiveRun | null | undefined => {
        if (!run || !isActivelyWorkingRunStatus(run.status)) return run;
        return {
          ...run,
          status: "failed" as const,
          completed_at: run.completed_at ?? stoppedAt,
          error_message: run.error_message ?? "Cancelled by user",
          summary: "Auto-Live run cancelled by user.",
          stage_results: run.stage_results.map((stage) =>
            stage.completed_at
              ? stage
              : {
                  ...stage,
                  completed_at: stoppedAt,
                  reason: "Cancelled by user.",
                  outputs: {
                    ...stage.outputs,
                    phase_status: "cancelled",
                  },
                },
          ),
        };
      };
      return {
        ...currentSummary,
        state: {
          ...currentSummary.state,
          running: false,
          paused: false,
          stopped_at: stoppedAt,
          next_run_at: null,
          next_scan_at: null,
          next_llm_run_at: null,
          next_rebalance_at: null,
          last_action: "Auto-Live scheduler stopped and the active run was cancelled.",
        },
        latest_run: killRun(currentSummary.latest_run),
        recent_runs: currentSummary.recent_runs.map((run) => killRun(run) ?? run),
      };
    });
  }

  async function handlePauseRun() {
    const shouldResume = Boolean(
      visiblePersistedAutoRunStatus?.state.paused ?? summary?.state.paused,
    );
    const nextAction = shouldResume ? "resume-run" : "pause-run";
    if (!claimAction(nextAction)) return;
    setNotice(null);
    setError(null);

    try {
      setOptimisticSchedulerState({
        running: true,
        paused: !shouldResume,
        message: shouldResume
          ? "Resuming auto runs. Waiting for backend confirmation…"
          : "Pausing auto runs at the next safe backend checkpoint…",
      });
      if (shouldResume) {
        await apiService.resumeBullpenAutoLive();
      } else {
        await apiService.pauseBullpenAutoLive();
      }
      setOptimisticSchedulerState({
        running: true,
        paused: !shouldResume,
        message: shouldResume
          ? "Auto runs resumed. Refreshing confirmed backend status…"
          : "Auto runs paused. Refreshing confirmed backend status…",
      });
      void refreshPersistedAutoRunStatus();
      void loadSummary({ preserveLoading: true });
      setNotice(
        shouldResume
          ? "Auto-Live resumed. The active run can continue at the next safe backend checkpoint."
          : "Auto-Live paused. The active run will stop before any new backend work starts where runtime guards are checked.",
      );
    } catch (nextError) {
      setOptimisticSchedulerState(null);
      setError(normalizeError(nextError));
    } finally {
      releaseClaimedAction(nextAction);
    }
  }

  async function handleKillRun() {
    if (!claimAction("kill-run")) return;
    startNowCancelledRef.current = true;
    setNotice(null);
    setError(null);
    resetActiveAutoRunUi();

    try {
      setOptimisticSchedulerState({
        running: false,
        paused: false,
        message: "Killing the active run and stopping the scheduler…",
      });
      await apiService.stopBullpenAutoLive();
      setOptimisticSchedulerState({
        running: false,
        paused: false,
        message: "Active run killed. Refreshing confirmed backend status…",
      });
      void refreshPersistedAutoRunStatus();
      void (loadSummary({
        preserveLoading: true,
        nextPendingRunId: null,
      }).then((nextSummary) => {
        const stillActiveRun = nextSummary
          ? getVisibleRun(nextSummary, null, workspaceProfile)
          : null;
        if (!stillActiveRun || !isActivelyWorkingRunStatus(stillActiveRun.status)) {
          return;
        }
        setKilledRunIds((currentIds) => new Set(currentIds).add(stillActiveRun.id));
        resetActiveAutoRunUi();
      }));
      setNotice(
        "Auto-Live stopped. Active backend work was cancelled immediately.",
      );
    } catch (nextError) {
      setOptimisticSchedulerState(null);
      setError(normalizeError(nextError));
    } finally {
      releaseClaimedAction("kill-run");
    }
  }

  const persistedAutoRunIsActive = isBullpenAutoRunSchedulerEnabled(
    visiblePersistedAutoRunStatus,
  );
  // Once the lightweight persisted read has resolved, it is fresher and more
  // authoritative for scheduler controls than the deferred diagnostics
  // summary. Never let a stale summary keep Start/Stop or Pause labels wrong.
  const confirmedAutoRunActive = visiblePersistedAutoRunStatus
    ? persistedAutoRunIsActive
    : isAutoRunActive(summary);
  const autoRunActive =
    optimisticSchedulerState?.running ?? confirmedAutoRunActive;
  const consoleProfileSelected = visiblePersistedAutoRunStatus
    ? visiblePersistedAutoRunStatus.settings.strategy_profile ===
      CONSOLE_PROFILE_ID
    : isConsoleProfileSelected(summary);
  const autoRunStatusBadges = getBullpenAutoRunStatusBadges(
    visiblePersistedAutoRunStatus,
    autoRunStatusLoadState,
  );
  const mode = autoRunStatusBadges.modeLabel;
  const schedulerNextRunAt =
    visiblePersistedAutoRunStatus?.state.next_run_at ?? summary?.state.next_run_at;
  const schedulerLastRunAt =
    visiblePersistedAutoRunStatus?.state.last_run_at ?? summary?.state.last_run_at;
  const latestUniversalTriggerRun = triggerHistoryItems.find(
    (run) => run.triggered_by === "universal_scan",
  );
  const latestManualTriggerRun = triggerHistoryItems.find(
    (run) => run.triggered_by === "manual",
  );
  const latestScheduledTriggerRun = triggerHistoryItems.find(
    (run) => run.triggered_by === "scheduler",
  );
  const confirmedSchedulerPaused =
    visiblePersistedAutoRunStatus?.state.paused ?? summary?.state.paused ?? false;
  const schedulerPaused =
    optimisticSchedulerState?.paused ?? confirmedSchedulerPaused;
  const scheduleSettingsPending =
    scheduleSettingsDirty || scheduleSettingsSaveBusy;
  const visibleRunCandidate = getVisibleRun(
    summary,
    pendingRunId,
    workspaceProfile,
  ) ??
    (workspaceRunFallback &&
    (!pendingRunId || workspaceRunFallback.id === pendingRunId)
      ? workspaceRunFallback
      : null);
  const visibleRun =
    visibleRunCandidate && killedRunIds.has(visibleRunCandidate.id)
      ? null
      : visibleRunCandidate;
  // Terminal failed/partial runs fall back to `latestRun` below rather than
  // `getVisibleRun`. Reconcile that path too, otherwise Stage 3's compact
  // update can replace the richer Stage 1/2 counts shown in the monitor.
  const latestWorkspaceRun = summary
    ? runBelongsToWorkspace(summary.latest_run, workspaceProfile)
      ? summary.latest_run
      : summary.recent_runs.find((run) =>
          runBelongsToWorkspace(run, workspaceProfile),
        ) ?? null
    : workspaceRunFallback;
  const latestRun = latestWorkspaceRun
    ? reconcileBullpenConsoleRunCopies(
        summary?.recent_runs.find((run) => run.id === latestWorkspaceRun.id) ??
          latestWorkspaceRun,
        latestWorkspaceRun,
      )
    : null;
  const workflowRun =
    visibleRun ??
    (pendingRunId && latestRun?.id !== pendingRunId ? null : latestRun);
  const verifiedStage1Portfolio = selectLatestVerifiedStage1Portfolio([
    resolveVerifiedStage1PortfolioSnapshot(
      summary?.state.verified_portfolio_snapshot,
    ),
    resolveLatestVerifiedStage1Portfolio(
      summary
        ? [summary.latest_run, ...summary.recent_runs]
        : workflowRun
          ? [workflowRun]
          : [],
    ),
  ]);
  // Stage 1 is worker-verified, but it is historical run output and can
  // be older than the current wallet read. Use it only until a portfolio
  // snapshot has loaded; never let it hide fresher live Bullpen positions.
  const useVerifiedStage1Fallback =
    shouldUseVerifiedStage1PortfolioFallback({
      hasActivePositionsSnapshot,
      verifiedPortfolio: verifiedStage1Portfolio,
    });
  const portfolioActivePositions =
    useVerifiedStage1Fallback && verifiedStage1Portfolio
      ? [
          ...verifiedStage1Portfolio.activePositions,
          ...verifiedStage1Portfolio.claimablePositions,
        ]
      : activePositions;
  const portfolioHasActivePositionsSnapshot =
    hasActivePositionsSnapshot ||
    useVerifiedStage1Fallback ||
    (!verifiedStage1Portfolio && activePositions.length > 0);
  const workflowPortfolioPositionFallback =
    buildWorkflowPortfolioPositionFallback(portfolioActivePositions);
  const {
    activePositionQuestionByKey: stage3PreviewQuestionByKey,
    activePositionsNeedingAttention: stage3PreviewAttentionEntries,
  } = buildBullpenInvestmentDisplay({
    activePositions,
    activePositionQuestions,
    candidates: [],
    recentDecisions,
  });
  const investOnlySource = selectBullpenStage3OnlyInvestSource(
    summary
      ? [summary.latest_run, ...summary.recent_runs]
      : workflowRun
        ? [workflowRun]
        : [],
  );
  const investOnlySourceRun = investOnlySource.run;
  const investOnlyPlan = buildBullpenStage3OnlyInvestExecutionPlan(
    investOnlySourceRun,
    summary?.recent_decisions ?? [],
    {
      activePositions,
      hasActivePositionsSnapshot,
    },
  );
  const stage3PreviewDialogState = buildStage3PreviewDialogState({
    sourceRun: investOnlySourceRun,
    plan: investOnlyPlan,
    attentionEntries: stage3PreviewAttentionEntries,
    activePositionQuestionByKey: stage3PreviewQuestionByKey,
    allowExitOnlyFallback:
      investOnlyPlan.blockedReason === NO_STAGE2_QUALIFIED_EVENTS_REASON &&
      stage3PreviewAttentionEntries.some(
        (entry) => entry.exitState === "EVENT_EXIT_PLANNED",
      ),
  });
  const effectiveInvestOnlyRequest =
    stage3PreviewDialogState?.request ?? investOnlyPlan.request;
  // The normal Invest action deliberately removes candidates that are already
  // represented by live positions or submitted buys. A Stage 3 retry is a
  // different operation: it must remain available while Stage 3 is running and
  // replay the complete, persisted Stage 2 handoff after stop() has cancelled
  // the active worker and its unsubmitted intents.
  const stage3RetryRequest =
    effectiveInvestOnlyRequest ?? investOnlySource.plan.request;
  const liveAlreadyInvestedRecords =
    summary && hasActivePositionsSnapshot
      ? buildLiveAlreadyInvestedRecords({
          activePositions,
          decisions: summary.recent_decisions ?? [],
        })
      : [];
  const stageInputAlreadyInvestedRecords =
    liveAlreadyInvestedRecords.length > 0
      ? liveAlreadyInvestedRecords
      : investOnlyPlan.alreadyInvestedRecords;
  const runTimerStartedAt = visibleRun?.started_at ?? runNowStartedAt;
  const liveWorkflowView = buildBullpenAutoRunWorkflowView(
    workflowRun,
    pendingRunId ?? (action === "start-now" ? "start-now-pending" : null),
    runTimerStartedAt,
  );
  const independentStageOneView = independentScanSnapshot
    ? buildIndependentStageOneView(independentScanSnapshot, activePositions)
    : null;
  useEffect(() => {
    if (independentScanSnapshot) {
      setStageOneResultSource("independent");
    }
  }, [independentScanSnapshot?.snapshotId]);
  const handleIndependentStageOneScan = async (
    downloadScope: "filtered" | "all-scanned" | null = null,
  ) => {
    if (!onRunIndependentStageOne) return;
    if (isIndependentStageOneScanning) {
      independentStageOneAbortControllerRef.current?.abort();
      independentStageOneAbortControllerRef.current = null;
      setIsIndependentStageOneScanning(false);
      setIndependentStageOneStartedAt(null);
      setIndependentStageOneProgress(null);
      setIndependentStageOneError(null);
      return;
    }

    const controller = new AbortController();
    independentStageOneAbortControllerRef.current = controller;
    setIsIndependentStageOneScanning(true);
    setIndependentStageOneStartedAt(new Date().toISOString());
    setIndependentStageOneProgress({
      scannedMarkets: 0,
      completedPages: 0,
      currentPage: 1,
      retryCount: 0,
      status: "scanning",
      lastUpdatedAt: new Date().toISOString(),
      message: "Starting Full Universe scan...",
    });
    setTimerNowMs(Date.now());
    setIndependentStageOneError(null);
    try {
      const result = await onRunIndependentStageOne(
        controller.signal,
        (progress) => {
          if (!controller.signal.aborted) {
            setIndependentStageOneProgress(progress);
          }
        },
      );
      if (controller.signal.aborted) return;
      if (result.snapshot) {
        setStageOneResultSource("independent");
        if (downloadScope) {
          if (result.snapshot.scanExportId) {
            downloadIndependentStageOneExcel(
              result.snapshot.scanExportId,
              downloadScope,
              workspaceProfile,
            );
          } else {
            setIndependentStageOneError(
              "The exhaustive scan completed without an export file. Please run the scan again.",
            );
          }
        }
      }
      if (result.error) {
        setIndependentStageOneError(result.error);
      } else if (downloadScope && !result.snapshot) {
        setIndependentStageOneError(
          "The exhaustive scan did not produce an export file. Please run the scan again.",
        );
      }
    } catch (scanError) {
      if (!controller.signal.aborted) {
        setIndependentStageOneError(formatUnknownError(scanError));
      }
    } finally {
      if (independentStageOneAbortControllerRef.current === controller) {
        independentStageOneAbortControllerRef.current = null;
        setIsIndependentStageOneScanning(false);
        setIndependentStageOneStartedAt(null);
        setIndependentStageOneProgress(null);
      }
    }
  };
  const openScanCandidateDialog = (
    stage: ReturnType<typeof buildBullpenAutoRunWorkflowView>["stages"][number],
    mode: ScanCandidateDialogMode,
  ) => {
    const isIndependentStage = Boolean(
      stage.outputs.independent_stage1_scan,
    );
    const independentSnapshotId =
      typeof stage.outputs.snapshot_id === "string"
        ? stage.outputs.snapshot_id
        : null;
    const autoSnapshotRunId = independentSnapshotId?.startsWith(
      "bullpen-auto-live-",
    )
      ? independentSnapshotId.slice("bullpen-auto-live-".length)
      : null;
    const isAutoRunSnapshot = Boolean(
      autoSnapshotRunId && workflowRunForMonitor?.id === autoSnapshotRunId,
    );
    const sourceRun =
      isIndependentStage && !isAutoRunSnapshot ? null : workflowRunForMonitor;
    const sourceDecisions = isIndependentStage && !isAutoRunSnapshot
      ? []
      : summary?.recent_decisions ?? [];

    // Open the shared Stage 1 widget immediately from the best locally
    // available projection, then hydrate that same widget with this run's
    // complete frozen evidence. The summary endpoint intentionally compacts
    // accepted/rejected candidate arrays, so rendering only from the summary
    // can show the authoritative count while incorrectly leaving the table
    // empty.
    setScanCandidateDialog(
      buildRunDetailScanCandidateDialogState({
        run: sourceRun,
        decisions: sourceDecisions,
        stage,
        mode,
        activePositionsFallback: workflowPortfolioPositionFallback,
      }),
    );

    if (!sourceRun?.id || (isIndependentStage && !isAutoRunSnapshot)) return;

    void Promise.all([
      apiService.getBullpenAutoLiveRun(sourceRun.id, { timeoutMs: 20_000 }),
      apiService.getBullpenAutoLiveRunDecisions(sourceRun.id, {
        timeoutMs: 20_000,
      }),
    ])
      .then(([exactRun, exactDecisions]) => {
        const exactStage =
          buildBullpenAutoRunWorkflowView(exactRun).stages.find(
            (candidateStage) => candidateStage.key === stage.key,
          ) ?? null;
        if (!exactStage) return;

        setScanCandidateDialog(
          buildRunDetailScanCandidateDialogState({
            run: exactRun,
            decisions: exactDecisions,
            stage: exactStage,
            mode,
            activePositionsFallback: workflowPortfolioPositionFallback,
          }),
        );
      })
      .catch((nextError) => {
        // Keep the already-open projection usable if the evidence refresh
        // fails; the regular console refresh/error surface will report API
        // health independently.
        if (process.env.NODE_ENV !== "production") {
          console.warn(
            "Could not hydrate the Stage 1 scan popup with exact run evidence.",
            nextError,
          );
        }
      });
  };
  const liveWorkflowSettled = isBullpenAutoRunWorkflowSettled(liveWorkflowView);
  const hasActiveWorkflowStage = liveWorkflowView.stages.some(
    (stage) =>
      isCrediblyActiveWorkflowRun(workflowRun, timerNowMs) && stage.isCurrent,
  );
  const runActionRequested = action === "invest-now";
  const startNowActionRequested = action === "start-now";
  const runIsActive =
    !liveWorkflowSettled &&
    (runActionRequested ||
      startNowActionRequested ||
      pendingRunId !== null ||
      isCrediblyActiveWorkflowRun(visibleRun, timerNowMs) ||
      hasActiveWorkflowStage);
  const effectiveAutoRunActive = autoRunActive || runIsActive;
  // Keep using the reconciled terminal copy after Stage 3. The compact
  // `latest_run` payload can contain zero placeholders and omit frozen rows;
  // selecting it here used to reset Stage 1/2 figures and left their dialogs
  // without the evidence needed to open correctly.
  const latestTerminalRun =
    latestRun && !isActivelyWorkingRunStatus(latestRun.status)
      ? latestRun
      : summary?.recent_runs.find(
          (run) =>
            runBelongsToWorkspace(run, workspaceProfile) &&
            !isActivelyWorkingRunStatus(run.status),
        ) ?? null;
  const latestTerminalRunSummary = latestTerminalRun
    ? getRunSummaryDetails(latestTerminalRun.summary)
    : null;
  const latestTerminalRunOverview =
    latestTerminalRunSummary?.overview ??
    latestTerminalRun?.summary?.trim() ??
    latestTerminalRun?.error_message?.trim() ??
    null;
  const workflowRunForSummaryTile =
    selectedRunSummaryTile === "last" &&
    !runIsActive &&
    !isUserCancelledRun(latestTerminalRun)
      ? latestTerminalRun ?? workflowRun
      : !runIsActive && isUserCancelledRun(latestTerminalRun)
        ? null
        : workflowRun;
  const workflowRunForMonitor =
    selectedRunSummaryTile === "next" && !runIsActive
      ? null
      : workflowRunForSummaryTile;
  const workflowView = buildBullpenAutoRunWorkflowView(
    workflowRunForMonitor,
    runIsActive
      ? pendingRunId ?? (action === "start-now" ? "start-now-pending" : null)
      : null,
    runTimerStartedAt,
  );
  const workflowSettled = isBullpenAutoRunWorkflowSettled(workflowView);
  const showRunTimer =
    Boolean(runTimerStartedAt) && (runActionRequested || runIsActive);
  const shouldTickTimers =
    showRunTimer || hasActiveWorkflowStage || isIndependentStageOneScanning;
  const showActiveRunControls = runIsActive;
  const elapsedRunTime = formatElapsedRunTime(runTimerStartedAt, timerNowMs);
  const openStage =
    workflowView.stages.find((stage) => stage.key === openStageKey) ?? null;
  const openInputStage =
    workflowView.stages.find((stage) => stage.key === openInputStageKey) ??
    null;
  const activeWorkflowStage =
    workflowView.stages.find((stage) => stage.isCurrent) ?? null;
  const workflowCurrentStageLabel = workflowSettled
    ? workflowRunForMonitor?.status === "completed"
      ? "All 3 stages finished"
      : workflowView.currentStageLabel
    : workflowView.currentStageLabel;
  const workflowStatusCopy = workflowRunForMonitor
    ? `${workflowView.statusCopy} Saved run ${workflowRunForMonitor.id} · Run ${workflowRunForMonitor.completed_at ? "completed" : "started"} ${formatIstDateTime(workflowRunForMonitor.completed_at ?? workflowRunForMonitor.started_at)} · Current worker execution is unverified.`
    : workflowView.statusCopy;
  const monitorRunStatusLabel = workflowRunForMonitor
    ? formatRunStatusLabel(workflowRunForMonitor.status)
    : null;
  const workflowRunHasHistoricalAuthError =
    runNeedsBullpenLogin(workflowRunForMonitor);
  const latestActiveAuthRequiresLogin = Boolean(
    summary?.runtime_auth &&
      (summary.runtime_auth.credentials_valid === false ||
        summary.runtime_auth.requires_login === true ||
        summary.runtime_auth.trade_auth_blocked === true ||
        summary.runtime_auth.doctor_refresh_succeeded === false),
  );
  const workflowRunNeedsLogin = Boolean(
    workflowRunHasHistoricalAuthError &&
      latestActiveAuthRequiresLogin,
  );
  const workflowRunAuthRecovered = Boolean(
    workflowRunHasHistoricalAuthError && summary?.runtime_auth?.healthy === true,
  );
  const investWorkflowStage =
    workflowView.stages.find((stage) => stage.key === "invest") ?? null;
  const investStageImmediateSuccess =
    workflowRunForMonitor?.status === "running"
      ? getInvestStageImmediateSuccess(investWorkflowStage)
      : null;

  const workflowDecisionCount =
    workflowRunForMonitor !== null
      ? getInvestStageMetric(
          investWorkflowStage,
          "decisions_count",
          workflowRunForMonitor.decisions_count,
        )
      : null;
  const workflowPlannedOrderCount =
    workflowRunForMonitor !== null
      ? getInvestStageMetric(
          investWorkflowStage,
          "orders_planned",
          workflowRunForMonitor.orders_planned,
        )
      : null;
  const workflowSubmittedOrderCount =
    workflowRunForMonitor !== null
      ? getInvestStageMetric(
          investWorkflowStage,
          "orders_submitted",
          workflowRunForMonitor.orders_submitted,
        )
      : null;
  const investOnlyActionCompleted =
    action === "invest-now" && Boolean(investStageImmediateSuccess);
  const latestRunFailureMessage =
    !runIsActive && latestTerminalRun?.status === "failed"
      ? latestTerminalRunOverview ??
        "The last Auto Run failed. Open the run details for the backend error."
      : null;
  const latestRunFailureDetail =
    latestRunFailureMessage &&
    latestTerminalRun?.error_message &&
    latestTerminalRun.error_message.trim() !== latestRunFailureMessage.trim()
      ? latestTerminalRun.error_message
      : null;
  const latestTerminalRunTimestamp =
    latestTerminalRun?.completed_at ??
    latestTerminalRun?.started_at ??
    schedulerLastRunAt;
  const lastRunTileClasses = runIsActive
    ? "border-emerald-200 bg-emerald-50 text-emerald-950 shadow-sm"
    : selectedRunSummaryTile === "last"
      ? latestTerminalRun?.status === "failed"
        ? "border-rose-200 bg-rose-50 text-rose-950 shadow-sm"
        : latestTerminalRun?.status === "partial_success" ||
            latestTerminalRun?.status === "skipped"
          ? "border-amber-200 bg-amber-50 text-amber-950 shadow-sm"
          : "border-emerald-200 bg-emerald-50 text-emerald-950 shadow-sm"
      : "border-white/70 bg-white/80";
  const stage2TargetSelectionWarning =
    summary?.settings.auto_live_enabled &&
    isConsoleProfileSelected(summary) &&
    (summary.settings.console_llm_targets ?? []).length === 0
      ? summary.state.next_run_at
        ? `Stage 2 has no saved LLM targets. Open Stage 2 · Run LLM and select at least one provider/model before ${formatIstDateTime(summary.state.next_run_at)}.`
        : "Stage 2 has no saved LLM targets. Open Stage 2 · Run LLM and select at least one provider/model before the next Auto Run."
      : null;
  const displayNotice =
    investStageImmediateSuccess?.message ??
    (latestRunFailureMessage && notice?.trim() === latestRunFailureMessage.trim()
      ? null
      : notice) ??
    (runIsActive ? (activeWorkflowStage?.detail ?? workflowStatusCopy) : null);
  const backendExecutionGuardrail = findGuardrailCheck(
    summary,
    "live-execution-env",
  );
  const backendExecutionBlocked = Boolean(
    backendExecutionGuardrail &&
    ((backendExecutionGuardrail.value ?? "").toString().toLowerCase() ===
      "blocked" ||
      /blocks auto-live execution/i.test(backendExecutionGuardrail.detail)),
  );
  const investRunDecisions =
    summary && workflowRunForMonitor
      ? mergeInvestStageDecisionRows({
          stage: investWorkflowStage,
          persistedDecisions: summary.recent_decisions.filter(
            (decision) => decision.run_id === workflowRunForMonitor.id,
          ),
        })
      : [];
  const refreshedStageTwoLlmRunDialog = resolveStageTwoLlmRunDialogState({
    currentState: stageTwoLlmRunDialog,
    fallbackRun: workflowRunForMonitor,
    summary,
  });
  const openInvestMetricDialog = (kind: InvestMetricDialogKind) => {
    if (!workflowRunForMonitor) return;
    setInvestMetricDialog({
      kind,
      run: workflowRunForMonitor,
      stage: investWorkflowStage,
      decisions: investRunDecisions,
    });
  };
  const openStage3PreviewDialog = () => {
    if (!stage3PreviewDialogState) return;
    setStage3PreviewDialog(stage3PreviewDialogState);
  };
  const openRunInvestMetricDialog = (
    run: BullpenAutoLiveRun,
    kind: InvestMetricDialogKind = "planned",
    detailDecisions?: BullpenAutoLiveDecision[],
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
        persistedDecisions:
          detailDecisions ??
          summary?.recent_decisions.filter(
            (decision) => decision.run_id === run.id,
          ) ??
          [],
      }),
    });
  };
  const openStage2To3StrategyDialog = ({
    trigger,
    sourceKey,
    outputs,
  }: {
    trigger: HTMLButtonElement | null;
    sourceKey: string;
    outputs: Record<string, unknown> | null;
  }) => {
    stage2To3StrategyDialogTriggerRef.current = trigger;
    setStage2To3StrategyDialog({
      sourceKey,
      strategyMetadata: readBullpenStage2To3StrategyMetadata(outputs),
      universeStatus: readBullpenStage2UniverseStatus(outputs),
    });
  };
  const openRunDetailDialog = (run: BullpenAutoLiveRun) => {
    const stage =
      buildBullpenAutoRunWorkflowView(run).stages.find(
        (workflowStage) => workflowStage.key === "invest",
      ) ?? null;
    setRunDetailDialog({
      run,
      decisions: mergeInvestStageDecisionRows({
        stage,
        persistedDecisions:
          summary?.recent_decisions.filter(
            (decision) => decision.run_id === run.id,
          ) ?? [],
      }),
    });
  };
  const stage3InterruptedWithoutResume = Boolean(
    workflowRunForMonitor?.status === "failed" &&
      investWorkflowStage?.key === "invest" &&
      readStageOutputString(investWorkflowStage.outputs.phase_status) === "aborted" &&
      readStageOutputBoolean(investWorkflowStage.outputs.recovery_required),
  );
  const investOnlyDisabledReason = runIsActive
    ? "Wait for the active Auto-Live run to finish before starting another Invest pass."
    : effectiveInvestOnlyRequest
      ? null
      : investOnlyPlan.blockedReason;
  const liveTradeAmountSource = portfolioState?.live.balance ?? null;
  const liveTradeAmountBalance = isUsableBullpenBalance(liveTradeAmountSource)
    ? liveTradeAmountSource
    : lastUsablePortfolioBalance;
  const liveTradeAmountActivePositions =
    useVerifiedStage1Fallback && verifiedStage1Portfolio
      ? verifiedStage1Portfolio.occupiedPositions
      : hasActivePositionsSnapshot
        ? activePositions.filter(isActiveBullpenPosition).length
        : portfolioState
          ? portfolioState.open_positions.filter(
              (position) => position.shares > 0,
            ).length
          : (summary?.state.active_positions ?? null);
  const tradeAmountView = buildConsoleTradeAmountView({
    cashInHandUsd:
      liveTradeAmountBalance?.available_balance_usd ??
      (useVerifiedStage1Fallback
        ? (verifiedStage1Portfolio?.cashInHandUsd ?? null)
        : null),
    activePositions: liveTradeAmountActivePositions,
    lastCalculatedTradeAmountUsd:
      summary?.state.last_console_trade_amount_usd ?? null,
    lastCalculatedCashInHandUsd:
      summary?.state.last_console_trade_cash_in_hand_usd ?? null,
    lastCalculatedActivePositions:
      summary?.state.last_console_trade_active_positions ?? null,
    lastCalculatedAvailableSlots:
      summary?.state.last_console_trade_available_slots ?? null,
    lastCalculatedMaxPositions:
      summary?.state.last_console_trade_max_positions ?? null,
  });
  const tradeAmountDisplay = formatMoney(tradeAmountView.tradeAmountUsd);
  const tradeAmountSummaryLabel =
    tradeAmountView.source === "live"
      ? useVerifiedStage1Fallback
        ? "Using latest Stage 1 fallback"
        : "Preview from current portfolio"
      : tradeAmountView.source === "last-calculated"
        ? "Showing last diagnostic amount"
        : "Waiting for live portfolio data";
  const runHistoryBelongsToCurrentUser =
    runHistoryOwnerKey === autoRunStatusCacheKey;
  const visibleRunHistoryPage = runHistoryBelongsToCurrentUser
    ? runHistoryPage
    : null;
  const visibleRunHistoryEventTrends = runHistoryBelongsToCurrentUser
    ? runHistoryEventTrends
    : null;

  useEffect(() => {
    return () => {
      if (startNowProgressTimeoutRef.current !== null) {
        window.clearTimeout(startNowProgressTimeoutRef.current);
      }
      independentStageOneAbortControllerRef.current?.abort();
      independentStageOneAbortControllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!shouldTickTimers) return;

    const intervalId = window.setInterval(() => {
      setTimerNowMs(Date.now());
    }, RUN_TIMER_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [shouldTickTimers, runTimerStartedAt]);

  useEffect(() => {
    if (!optimisticSchedulerState || !visiblePersistedAutoRunStatus) return;
    if (
      visiblePersistedAutoRunStatus.state.running === optimisticSchedulerState.running &&
      visiblePersistedAutoRunStatus.state.paused === optimisticSchedulerState.paused
    ) {
      window.queueMicrotask(() => setOptimisticSchedulerState(null));
    }
  }, [optimisticSchedulerState, visiblePersistedAutoRunStatus]);

  useEffect(() => {
    if (!workflowSettled) return;
    window.queueMicrotask(() => {
      if (pendingRunId !== null) {
        setPendingRunId(null);
      }
      if (runNowStartedAt !== null) {
        setRunNowStartedAt(null);
      }
      if (action === "invest-now") {
        clearClaimedAction();
      }
    });
  }, [action, pendingRunId, runNowStartedAt, workflowSettled]);

  return (
    <Card className="border-fuchsia-200 bg-[linear-gradient(135deg,rgba(253,242,248,0.98),rgba(239,246,255,0.98))] shadow-sm dark:border-fuchsia-500/30 dark:bg-[linear-gradient(135deg,rgba(91,33,182,0.24),rgba(15,23,42,0.94),rgba(14,165,233,0.16))]">
      <CardContent className="space-y-4 p-5">
        <BullpenPortfolioSnapshot
          useHistoryPortfolioSource
          state={portfolioState}
          lastUsableBalance={lastUsablePortfolioBalance}
          activePositions={portfolioActivePositions}
          activePositionsSummary={activePositionsSummary}
          activePositionQuestions={activePositionQuestions}
          hasActivePositionsSnapshot={portfolioHasActivePositionsSnapshot}
          positionsVerifiedByStage1={useVerifiedStage1Fallback}
          positionsVerifiedAt={
            useVerifiedStage1Fallback
              ? (verifiedStage1Portfolio?.verifiedAt ?? null)
              : null
          }
          positionsSource={positionsSource}
          positionsUpdatedAt={positionsUpdatedAt}
          positionsLineage={
            useVerifiedStage1Fallback
              ? (verifiedStage1Portfolio?.lineage ?? null)
              : positionsLineage
          }
          verifiedActivePositionsTotal={
            useVerifiedStage1Fallback
              ? (verifiedStage1Portfolio?.activePositionsTotal ?? null)
              : null
          }
          verifiedActivePositionsTruncated={
            useVerifiedStage1Fallback
              ? (verifiedStage1Portfolio?.activePositionsTruncated ?? false)
              : false
          }
          verifiedCashInHandUsd={
            useVerifiedStage1Fallback
              ? (verifiedStage1Portfolio?.cashInHandUsd ?? null)
              : null
          }
          refreshing={portfolioRefreshing}
          refreshNotice={portfolioRefreshNotice}
          historicalRuns={summary?.recent_runs ?? []}
          recentDecisions={recentDecisions}
          onRefresh={() => void refreshPortfolioSnapshot(true)}
        />
        <section
          aria-label="Stage 1 trigger monitor"
          className="rounded-2xl border border-sky-200 bg-white/85 p-4 shadow-sm"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">
                Stage 1 Trigger Monitor
              </p>
              <p className="mt-1 text-sm text-slate-600">
                Each trigger starts this workflow&apos;s filters on the latest completed Universal Polymarket Scan.
              </p>
            </div>
            {triggerMonitorLoading ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Refreshing
              </span>
            ) : null}
          </div>
          <div className="mt-3 grid gap-3 lg:grid-cols-3">
            <div className="rounded-xl border border-emerald-100 bg-emerald-50/70 p-3">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-800">
                1 · Fresh Universal Scan
              </p>
              <p className={`mt-2 text-sm font-bold ${triggerOutcomeClasses(latestUniversalTriggerRun)}`}>
                {triggerOutcome(latestUniversalTriggerRun)}
              </p>
              <p className="mt-1 text-xs text-slate-600">
                Latest scan completed: {formatIstDateTime(universalTriggerStatus?.last_completed_at)}
              </p>
              <p className="mt-1 text-xs text-slate-600">
                Stage 1 attempt: {formatIstDateTime(latestUniversalTriggerRun?.started_at)}
              </p>
              <p className="mt-1 text-xs font-semibold text-slate-700">
                Next scan: {formatIstDateTime(universalTriggerStatus?.next_run_at)}
              </p>
              {universalTriggerStatus?.last_error ? (
                <p className="mt-1 line-clamp-2 text-xs text-rose-700">
                  {universalTriggerStatus.last_error}
                </p>
              ) : null}
            </div>
            <div className="rounded-xl border border-violet-100 bg-violet-50/70 p-3">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-violet-800">
                2 · Start Auto Run Now
              </p>
              <p className={`mt-2 text-sm font-bold ${triggerOutcomeClasses(latestManualTriggerRun)}`}>
                {triggerOutcome(latestManualTriggerRun)}
              </p>
              <p className="mt-1 text-xs text-slate-600">
                Last pressed: {formatIstDateTime(latestManualTriggerRun?.started_at)}
              </p>
              <p className="mt-1 text-xs text-slate-600">
                Completed/failed: {formatIstDateTime(latestManualTriggerRun?.completed_at)}
              </p>
              <p className="mt-1 text-xs font-semibold text-slate-700">
                Upcoming: operator initiated
              </p>
            </div>
            <div className="rounded-xl border border-amber-100 bg-amber-50/70 p-3">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-amber-800">
                3 · Scheduled Time
              </p>
              <p className={`mt-2 text-sm font-bold ${triggerOutcomeClasses(latestScheduledTriggerRun)}`}>
                {triggerOutcome(latestScheduledTriggerRun)}
              </p>
              <p className="mt-1 text-xs text-slate-600">
                Last scheduled attempt: {formatIstDateTime(latestScheduledTriggerRun?.started_at ?? schedulerLastRunAt)}
              </p>
              <p className="mt-1 text-xs text-slate-600">
                Completed/failed: {formatIstDateTime(latestScheduledTriggerRun?.completed_at)}
              </p>
              <p className="mt-1 text-xs font-semibold text-slate-700">
                Upcoming: {formatIstDateTime(schedulerNextRunAt)}
              </p>
            </div>
          </div>
          {triggerMonitorError ? (
            <p className="mt-3 text-xs font-semibold text-rose-700">
              {triggerMonitorError}
            </p>
          ) : null}
        </section>
        <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-white/80 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-fuchsia-700">
                Auto Run Schedule
              </span>
              <button
                className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700 transition hover:border-sky-300 hover:bg-sky-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 disabled:cursor-wait disabled:hover:border-slate-200 disabled:hover:bg-white"
                aria-live="polite"
                aria-haspopup="dialog"
                disabled={!autoRunStatusBadges.statusLabel}
                onClick={() => setOpenBadgeRationale("status")}
                type="button"
              >
                {autoRunStatusBadges.statusLabel ? (
                  <>Status: {autoRunStatusBadges.statusLabel}</>
                ) : (
                  <>
                    <span>Status:</span>
                    <span
                      className="h-3.5 w-14 animate-pulse rounded bg-slate-200"
                      aria-label="Retrieving auto-run status"
                    />
                  </>
                )}
                {autoRunStatusBadges.isUpdating ? (
                  <Loader2
                    aria-label="Refreshing auto-run status"
                    className="size-3.5 animate-spin text-slate-500"
                  />
                ) : null}
              </button>
              <button
                className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700 transition hover:border-sky-300 hover:bg-sky-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 disabled:cursor-wait disabled:hover:border-slate-200 disabled:hover:bg-white"
                aria-live="polite"
                aria-haspopup="dialog"
                disabled={!mode}
                onClick={() => setOpenBadgeRationale("mode")}
                type="button"
              >
                {mode ? (
                  <>Mode: {mode}</>
                ) : (
                  <>
                    <span>Mode:</span>
                    <span
                      className="h-3.5 w-16 animate-pulse rounded bg-slate-200"
                      aria-label="Retrieving auto-run mode"
                    />
                  </>
                )}
                {autoRunStatusBadges.isUpdating ? (
                  <Loader2
                    aria-label="Refreshing auto-run mode"
                    className="size-3.5 animate-spin text-slate-500"
                  />
                ) : null}
              </button>
              {autoRunStatusBadges.isStale ? (
                <span className="text-[11px] font-medium text-slate-500">
                  {autoRunStatusBadges.isUpdating
                    ? "Updating…"
                    : autoRunStatusSavedAt
                      ? `Last refresh ${formatIstDateTime(new Date(autoRunStatusSavedAt).toISOString())}`
                      : "Last known status"}
                </span>
              ) : autoRunStatusSavedAt ? (
                <span className="text-[11px] font-medium text-slate-500">
                  Refreshed {formatIstDateTime(new Date(autoRunStatusSavedAt).toISOString())}
                </span>
              ) : null}
              {autoRunStatusError && !autoRunStatusBadges.isUpdating ? (
                autoRunStatusCacheKey ? (
                  <button
                    type="button"
                    onClick={() => {
                      autoRunStatusRetryAttemptRef.current = 0;
                      void refreshPersistedAutoRunStatus({ retrying: true });
                    }}
                    className="text-[11px] font-semibold text-sky-700 underline-offset-2 transition hover:text-sky-900 hover:underline"
                  >
                    Retry status
                  </button>
                ) : (
                  <span className="text-[11px] font-medium text-slate-500">
                    Sign in again to retry
                  </span>
                )
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap gap-2 xl:shrink-0 xl:justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsRunHistoryDialogOpen(true)}
              aria-label="Show Bullpen run history"
              className="rounded-r-none border-[#f4d458] bg-[#f4d458] text-slate-950 hover:border-[#e7c845] hover:bg-[#e7c845]"
            >
              <History className="mr-2 h-4 w-4" />
              History
            </Button>
            <Button type="button" variant="outline" onClick={() => router.push(bullpenWorkspaceHistoryPath(workspaceProfile))} aria-label="Open workflow History screen" title="Open History screen" className="-ml-2 rounded-l-none border-l border-l-slate-900/20 border-[#f4d458] bg-[#f4d458] px-3 text-slate-950 hover:bg-[#e7c845]"><ExternalLink className="h-4 w-4" /></Button>

            <Button
              type="button"
              variant="outline"
              onClick={handleStartAutoRunNow}
              disabled={action !== null || runIsActive}
              className="border-emerald-200 bg-emerald-50 text-emerald-700 hover:border-emerald-300 hover:bg-emerald-100 hover:text-emerald-800 disabled:opacity-60"
            >
              {action === "start-now" ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Starting...
                </>
              ) : runIsActive ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Running
                </>
              ) : (
                <>
                  <Zap className="mr-2 h-4 w-4" />
                  Start Auto Run Now
                </>
              )}
            </Button>
            {effectiveAutoRunActive ? (
              <Button
                variant="outline"
                onClick={handleStopAutoRuns}
                disabled={action !== null}
                className="border-rose-200 bg-rose-50 text-rose-700 hover:border-rose-300 hover:bg-rose-100 hover:text-rose-800 disabled:opacity-60"
              >
                {action === "stop" ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Stopping...
                  </>
                ) : (
                  <>
                    <Square className="mr-2 h-4 w-4" />
                    Stop Auto Runs
                  </>
                )}
              </Button>
            ) : (
              <Button onClick={handleEnableAutoRuns} disabled={action !== null}>
                {action === "enable" ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Enabling...
                  </>
                ) : (
                  <>
                    <PlayCircle className="mr-2 h-4 w-4" />
                    {scheduleStartInput.trim().toLowerCase() === "now"
                      ? "Run and Enable Auto Runs"
                      : "Enable Auto Runs"}
                  </>
                )}
              </Button>
            )}
            {showRunTimer ? (
              <div
                className="inline-flex items-center justify-center gap-1 text-center text-xs font-semibold tabular-nums text-sky-800"
                aria-live="polite"
              >
                <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
                {elapsedRunTime}
              </div>
            ) : null}
          </div>
        </div>
        {optimisticSchedulerState ? (
          <div
            className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-semibold leading-5 text-sky-900 shadow-sm"
            aria-live="polite"
          >
            <span className="inline-flex items-center gap-2">
              <Loader2
                className="h-3.5 w-3.5 shrink-0 animate-spin"
                aria-hidden="true"
              />
              {optimisticSchedulerState.message}
            </span>
          </div>
        ) : null}
        {startNowProgress ? (
          <div
            className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold leading-5 text-emerald-900 shadow-sm"
            aria-live="polite"
          >
            <span className="inline-flex items-center gap-2">
              <Loader2
                className="h-3.5 w-3.5 shrink-0 animate-spin"
                aria-hidden="true"
              />
              {startNowProgress}
            </span>
          </div>
        ) : null}

        <div className="rounded-2xl border border-white/70 bg-white/80 p-4">
          <div className="grid gap-3 lg:grid-cols-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                <span>Trade amount per new opportunity</span>
                <button
                  type="button"
                  onClick={() => setIsTradeAmountInfoDialogOpen(true)}
                  className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-fuchsia-200 text-fuchsia-700 transition hover:bg-fuchsia-50 focus:outline-none focus:ring-2 focus:ring-fuchsia-300"
                  aria-label="Show trade amount formula"
                >
                  <Info className="h-3 w-3" />
                </button>
              </div>
              <div className="mt-2 flex h-11 items-center justify-between rounded-xl border border-slate-200 bg-white px-4 shadow-sm">
                <span className="text-sm text-slate-500">
                  {tradeAmountSummaryLabel}
                </span>
                <span className="text-base font-semibold tabular-nums text-slate-950">
                  {tradeAmountDisplay}
                </span>
              </div>
            </div>
            <div className="min-w-0">
              <label
                htmlFor="bullpen-auto-run-start-time"
                className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500"
              >
                Auto-run start time (IST)
              </label>
              <div className="relative mt-2 flex h-11 items-center rounded-xl border border-slate-200 bg-white px-3 shadow-sm">
                <input
                  id="bullpen-auto-run-start-time"
                  type="text"
                  value={scheduleStartInput}
                  onChange={(event) => {
                    const nextStart = event.target.value;
                    setScheduleStartInput(nextStart);
                    setSchedulePickerValue(
                      parseScheduleInputToDateTimeLocalValue(nextStart),
                    );
                    setScheduleSettingsDirty(true);
                  }}
                  disabled={action !== null}
                  className="h-full w-full border-0 bg-transparent p-0 text-sm font-semibold text-slate-950 outline-none placeholder:text-slate-400 disabled:cursor-not-allowed disabled:text-slate-400"
                  placeholder="13:00:00 06 July, 2026"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setScheduleStartInput("Now");
                    setSchedulePickerValue(formatDateTimeLocalValue(new Date()));
                    setScheduleSettingsDirty(true);
                  }}
                  disabled={action !== null}
                  className="ml-2 h-8 rounded-lg px-3 text-xs shadow-none"
                >
                  Now
                </Button>
                <button
                  type="button"
                  onClick={() => {
                    setSchedulePickerValue(
                      parseScheduleInputToDateTimeLocalValue(scheduleStartInput),
                    );
                    setIsSchedulePickerOpen((open) => !open);
                  }}
                  disabled={action !== null}
                  className="ml-2 inline-flex h-8 w-8 items-center justify-center rounded-full text-blue-600 transition hover:bg-blue-50 disabled:cursor-not-allowed disabled:text-slate-300"
                  aria-label="Open auto-run date and time picker"
                >
                  <Clock3 className="h-5 w-5" />
                </button>
                {isSchedulePickerOpen ? (
                  <div className="absolute left-0 top-12 z-30 w-[22rem] rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl">
                    <input
                      type="datetime-local"
                      value={schedulePickerValue}
                      onInput={(event) => {
                        const nextValue = event.currentTarget.value;
                        setSchedulePickerValue(nextValue);
                        setScheduleStartInput(
                          formatScheduleInputFromDateTimeLocal(nextValue),
                        );
                        setScheduleSettingsDirty(true);
                      }}
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        setSchedulePickerValue(nextValue);
                        setScheduleStartInput(
                          formatScheduleInputFromDateTimeLocal(nextValue),
                        );
                        setScheduleSettingsDirty(true);
                      }}
                      className="h-10 w-full rounded-lg border border-blue-500 px-3 text-sm outline-none"
                    />
                    <div className="mt-3 flex justify-between gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          setScheduleStartInput("Now");
                          setSchedulePickerValue(
                            formatDateTimeLocalValue(new Date()),
                          );
                          setScheduleSettingsDirty(true);
                          setIsSchedulePickerOpen(false);
                        }}
                      >
                        Now
                      </Button>
                      <Button
                        type="button"
                        onClick={() => setIsSchedulePickerOpen(false)}
                      >
                        Confirm
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
            <div className="min-w-0">
              <label
                htmlFor="bullpen-auto-run-refresh-minutes"
                className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500"
              >
                Refresh duration
              </label>
              <div className="mt-2 flex h-11 items-center rounded-xl border border-slate-200 bg-white px-3 shadow-sm">
                <span className="mr-2 text-sm font-semibold text-slate-500">
                  Every
                </span>
                <input
                  id="bullpen-auto-run-refresh-minutes"
                  type="number"
                  min="1"
                  step="1"
                  value={scheduleRefreshInput}
                  onChange={(event) => {
                    setScheduleRefreshInput(event.target.value);
                    setScheduleSettingsDirty(true);
                  }}
                  disabled={action !== null}
                  className="h-full w-full border-0 bg-transparent p-0 text-sm font-semibold text-slate-950 outline-none disabled:cursor-not-allowed disabled:text-slate-400"
                />
                <span className="ml-2 text-sm font-semibold text-slate-500">
                  min
                </span>
              </div>
            </div>
          </div>
          {scheduleSettingsPending ? (
            <p
              className="mt-3 inline-flex w-full items-center justify-end gap-2 text-right text-xs font-semibold text-slate-500"
              aria-live="polite"
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              {scheduleSettingsSaveBusy
                ? "Saving auto-run settings…"
                : "Auto-run setting change queued…"}
            </p>
          ) : null}
        </div>

        {showActiveRunControls && effectiveAutoRunActive ? (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={handlePauseRun}
              disabled={action !== null}
              className="rounded-full bg-orange-500 text-white hover:bg-orange-600"
            >
              {action === "pause-run" || action === "resume-run" ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : schedulerPaused ? (
                <PlayCircle className="mr-2 h-4 w-4" />
              ) : (
                <PauseCircle className="mr-2 h-4 w-4" />
              )}
              {action === "pause-run"
                ? "Pausing…"
                : action === "resume-run"
                  ? "Resuming…"
                  : schedulerPaused
                    ? "Resume"
                    : "Pause"}
            </Button>
            <Button
              type="button"
              onClick={handleKillRun}
              disabled={action !== null}
              className="rounded-full bg-rose-600 text-white hover:bg-rose-700"
            >
              {action === "kill-run" ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <X className="mr-2 h-4 w-4" />
              )}
              {action === "kill-run" ? "Killing…" : "Kill"}
            </Button>
          </div>
        ) : null}

        <div className="grid gap-3 lg:grid-cols-3">
          <button
            type="button"
            onClick={() => setSelectedRunSummaryTile("next")}
            className={`rounded-2xl border p-4 text-left transition hover:-translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-sky-300 ${
              selectedRunSummaryTile === "next" && !runIsActive
                ? "border-sky-200 bg-sky-50 text-sky-950 shadow-sm"
                : "border-white/70 bg-white/80"
            }`}
            aria-pressed={selectedRunSummaryTile === "next" && !runIsActive}
          >
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              <CalendarClock className="h-4 w-4" />
              Next scheduled run
            </div>
            <p className="mt-2 text-sm font-semibold text-slate-950">
              {formatIstDateTime(schedulerNextRunAt)}
            </p>
          </button>

          <div
            role="button"
            tabIndex={latestTerminalRun ? 0 : -1}
            onClick={() => {
              setSelectedRunSummaryTile("last");
              if (latestTerminalRun) {
                openRunDetailDialog(latestTerminalRun);
              }
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              setSelectedRunSummaryTile("last");
              if (latestTerminalRun) {
                openRunDetailDialog(latestTerminalRun);
              }
            }}
            className={`rounded-2xl border p-4 text-left transition hover:-translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-emerald-300 ${lastRunTileClasses} ${
              latestTerminalRun ? "cursor-pointer" : "cursor-not-allowed"
            }`}
            aria-pressed={selectedRunSummaryTile === "last" || runIsActive}
            aria-disabled={!latestTerminalRun}
          >
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              {runIsActive
                ? "Run in Progress"
                : formatLatestRunSummaryTileLabel(latestTerminalRun)}
            </div>
            <span className="mt-2 block text-left text-sm font-semibold text-slate-950 underline-offset-4 transition hover:text-blue-700 hover:underline">
              {runIsActive ? "Started " : ""}
              {formatIstDateTime(
                runIsActive
                  ? runTimerStartedAt
                  : latestTerminalRunTimestamp,
              )}
            </span>
            {runIsActive && workflowRunNeedsLogin ? (
              <div className="mt-2 space-y-2">
                <p className="text-sm font-bold text-rose-700">
                  Failed · Login Needed
                </p>
                <div className="flex items-start gap-2 rounded-xl border border-rose-100 bg-rose-50 px-3 py-2">
                  <code className="min-w-0 flex-1 break-words text-xs font-semibold leading-5 text-rose-950">
                    {BULLPEN_LOGIN_COMMAND}
                  </code>
                  <button
                    type="button"
                    aria-label="Copy Bullpen login command"
                    title="Copy command"
                    className="rounded-full border border-rose-200 bg-white p-1.5 text-rose-700 transition hover:bg-rose-100"
                    onClick={(event) => {
                      event.stopPropagation();
                      void navigator.clipboard?.writeText(
                        BULLPEN_LOGIN_COMMAND,
                      );
                    }}
                  >
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              </div>
            ) : runIsActive && workflowRunAuthRecovered ? (
              <p className="mt-2 text-xs font-semibold leading-5 text-emerald-800">
                Earlier Bullpen authentication error recovered; the latest
                active doctor auth refresh is healthy.
              </p>
            ) : (
              <p className="mt-1 text-xs text-slate-600">
                {latestTerminalRunOverview || (summary ? "No saved auto-run result returned by this snapshot." : "Run history unknown · source unavailable.")}
              </p>
            )}
          </div>

          <div className="rounded-2xl border border-white/70 bg-white/80 p-4">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Execution guardrails
            </div>
            <p className="mt-2 text-sm font-semibold text-slate-950">
              {consoleProfileSelected
                ? "Bullpen console top-10"
                : summary || visiblePersistedAutoRunStatus ? "Not active yet" : "Unknown · source unavailable"}
            </p>
            <p className="mt-1 text-xs text-slate-600">
              Live orders still require Bullpen doctor, balance, and runtime
              safety checks to pass.
            </p>
          </div>
        </div>

        {!consoleProfileSelected && summary ? (
          <Alert className="border-amber-200 bg-amber-50 text-amber-950 dark:text-amber-50">
            <ShieldAlert className="h-4 w-4" />
            <AlertTitle>Another profile is currently selected</AlertTitle>
            <AlertDescription>
              Enabling this schedule will switch Auto-Live to the Bullpen
              console top-10 flow for this page.
            </AlertDescription>
          </Alert>
        ) : null}

        {backendExecutionBlocked ? (
          <Alert className="border-rose-200 bg-rose-50 text-rose-950">
            <ShieldAlert className="h-4 w-4" />
            <AlertTitle>Backend live execution is disabled</AlertTitle>
            <AlertDescription>
              <span>
                <code className="rounded bg-rose-100 px-1 py-0.5 text-[11px] font-semibold">
                  BULLPEN_AUTO_LIVE_ALLOW_EXECUTION
                </code>{" "}
                is off in the backend environment, so Stage 3 can review rows
                and simulate order plans but it cannot submit live Bullpen
                orders.
              </span>
              <span className="mt-2 block text-xs leading-5 text-rose-800">
                Set it to{" "}
                <code className="rounded bg-rose-100 px-1 py-0.5 font-semibold">
                  true
                </code>{" "}
                and restart the backend and Celery worker to unlock live
                execution.
              </span>
              {backendExecutionGuardrail?.detail ? (
                <span className="mt-2 block text-xs leading-5 text-rose-800">
                  {backendExecutionGuardrail.detail}
                </span>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : summary && summary.state.mode !== "live-trading" ? (
          <Alert className="border-sky-200 bg-sky-50 text-sky-950 dark:text-sky-50">
            <ShieldAlert className="h-4 w-4" />
            <AlertTitle>Live execution is still gated</AlertTitle>
            <AlertDescription>
              Scheduled runs can still queue and analyze markets, but live
              orders only submit when the backend environment, Auto-Live arming,
              and runtime health checks all allow trading. Manual locks and
              emergency stops still block Stage 3. Review the full controls if
              you need to inspect the current gate.
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="rounded-3xl border border-slate-200/80 bg-white/70 p-4 shadow-sm dark:border-slate-700/80 dark:bg-slate-950/65">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Background execution monitor
                </p>
                {workflowRun ? (
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold text-slate-700">
                    {monitorRunStatusLabel}
                  </span>
                ) : null}
              </div>
              <p className="text-sm font-semibold text-slate-950">
                {workflowStatusCopy}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700">
                {workflowCurrentStageLabel}
              </span>
              {workflowRun ? (
                <>
                  <button
                    type="button"
                    onClick={() => openInvestMetricDialog("decisions")}
                    className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700 transition hover:border-sky-200 hover:bg-sky-50 hover:text-sky-900"
                  >
                    {workflowDecisionCount ?? workflowRun.decisions_count}{" "}
                    decisions
                  </button>
                  <button
                    type="button"
                    onClick={() => openInvestMetricDialog("planned")}
                    className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700 transition hover:border-sky-200 hover:bg-sky-50 hover:text-sky-900"
                  >
                    {workflowPlannedOrderCount ?? workflowRun.orders_planned}{" "}
                    planned
                  </button>
                  <button
                    type="button"
                    onClick={() => openInvestMetricDialog("submitted")}
                    className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700 transition hover:border-sky-200 hover:bg-sky-50 hover:text-sky-900"
                  >
                    {workflowSubmittedOrderCount ??
                      workflowRun.orders_submitted}{" "}
                    submitted
                  </button>
                </>
              ) : null}
            </div>
          </div>

          <div className="mt-4">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Worker stages
            </p>
          </div>

          <div className="mt-3 grid gap-3 lg:grid-cols-3">
            {workflowView.stages.map((workflowStage) => {
              const stage =
                workflowStage.key === "scan"
                  ? selectStageOneDisplayStage({
                      workflowStage,
                      independentStage: independentStageOneView,
                      preferIndependent:
                        stageOneResultSource === "independent" && !runIsActive,
                    })
                  : workflowStage;
              const immediateSuccess = getInvestStageImmediateSuccess(stage);
              const canOpenInputs =
                (stage.key === "llm" || stage.key === "invest") &&
                Object.keys(stage.inputs).length > 0;
              const stageDecisions = workflowRunForMonitor
                ? mergeInvestStageDecisionRows({
                    stage,
                    persistedDecisions:
                      summary?.recent_decisions.filter(
                        (decision) => decision.run_id === workflowRunForMonitor.id,
                      ) ?? [],
                  })
                : [];
              const investExecutionSteps = getInvestStageExecutionSteps(
                stage,
                stageDecisions,
              );
              const showQueuedInvestPreview =
                stage.key === "invest" &&
                investExecutionSteps.length === 0 &&
                stage.state === "queued" &&
                workflowView.runStatus !== "running" &&
                Array.isArray(stage.inputs.llm_review_rows);
              const investStageCounters =
                stage.key === "invest" &&
                showQueuedInvestPreview &&
                stage3PreviewDialogState
                  ? [
                      {
                        label: "Queued",
                        value: stage3PreviewDialogState.plannedOrders,
                      },
                      { label: "Submitted", value: 0 },
                    ]
                  : getInvestStageCounters(stage, stageDecisions);
              const investPreviewSteps = showQueuedInvestPreview
                ? buildQueuedInvestPreviewSteps(
                    investOnlyPlan,
                    investOnlySourceRun,
                  ).map((step) =>
                    step.key === "sell"
                      ? {
                          ...step,
                          plannedOrders:
                            stage3PreviewDialogState?.sellPlannedOrders ?? 0,
                          processedOrders: 0,
                          submittedOrders: 0,
                          detail:
                            stage3PreviewDialogState?.sellPlannedOrders &&
                            stage3PreviewDialogState.sellPlannedOrders > 0
                              ? `${stage3PreviewDialogState.sellPlannedOrders} current Event Exit ${
                                  stage3PreviewDialogState.sellPlannedOrders === 1
                                    ? "row is"
                                    : "rows are"
                                } queued to sell before any new buys.`
                              : "No executable Step 1 Event Exits are waiting right now.",
                        }
                      : step.key === "buy"
                        ? {
                            ...step,
                            plannedOrders:
                              stage3PreviewDialogState?.buyPlannedOrders ??
                              step.plannedOrders,
                            detail:
                              stage3PreviewDialogState?.buyPlannedOrders
                                ? [
                                    `${stage3PreviewDialogState.buyPlannedOrders} Stage 2-qualified row${stage3PreviewDialogState.buyPlannedOrders === 1 ? " is" : "s are"} now in the Stage 3 Planned list.`,
                                    "Executable sizes are finalized after Step 1 settles and the worker refreshes live cash plus occupied slots.",
                                  ].join(" ")
                                : step.detail,
                          }
                        : step,
                  )
                : [];
              const useStage3PreviewDialog =
                stage.key === "invest" &&
                showQueuedInvestPreview &&
                stage3PreviewDialogState !== null;
              const displayedInvestSteps =
                investExecutionSteps.length > 0
                  ? investExecutionSteps
                  : investPreviewSteps;
              const investPreviewFinished =
                stage.key === "invest" &&
                investExecutionSteps.length === 0 &&
                displayedInvestSteps.length > 0 &&
                displayedInvestSteps.every(
                  (step) => step.status === "completed",
                );
              const isIndependentStageOneActive =
                stage.key === "scan" && isIndependentStageOneScanning;
              const isAutoStageOneActive =
                stage.key === "scan" && runIsActive && stage.isCurrent;
              const isStageOneActive = isIndependentStageOneActive || isAutoStageOneActive;
              const autoScanProgress = isRecord(stage.outputs.scan_progress) ? stage.outputs.scan_progress : null;
              const displayedScanProgress = isIndependentStageOneActive
                ? independentStageOneProgress
                : {
                    scannedMarkets: readStageOutputNumber(autoScanProgress?.scannedMarkets) ?? 0,
                    currentPage: readStageOutputNumber(autoScanProgress?.currentPage) ?? 1,
                    lastUpdatedAt: readStageOutputString(autoScanProgress?.lastUpdatedAt) ?? stage.timerStartedAt ?? "",
                    message: readStageOutputString(autoScanProgress?.message) ?? stage.detail ?? "Starting scan…",
                    status: "scanning",
                    retryCount: 0,
                  };
              const scanProgressScanned = displayedScanProgress?.scannedMarkets ?? 0;
              const scanProgressTotal =
                readStageOutputNumber(autoScanProgress?.totalMarkets) ??
                readStageOutputNumber(stage.outputs.total_items) ??
                workflowRunForMonitor?.request_context?.console_profile?.total_candidates ??
                null;
              const scanProgressPercent = scanProgressTotal && scanProgressTotal > 0
                ? Math.min(100, Math.max(0, (scanProgressScanned / scanProgressTotal) * 100))
                : 0;
              const isIncompleteUniverse = stage.key === "scan" &&
                stage.outputs.scan_scope === "full_universe" &&
                stage.outputs.scan_completeness !== "complete" &&
                !isStageOneActive && stage.state === "finished";
              const toneClasses = getWorkflowToneClasses(
                isStageOneActive || isIncompleteUniverse
                  ? "yellow"
                  : selectedRunSummaryTile === "next" && !runIsActive
                  ? "slate"
                  : immediateSuccess || investPreviewFinished || stage.state === "finished" || Boolean(stage.timerCompletedAt)
                    ? "green"
                    : stage.tone,
              );
              const showStageRunDetails = true;
              // A completed independent scan is durable evidence in its own
              // right. Keep its counts visible even when the separate
              // auto-run dashboard projection is unavailable or still queued.
              const showStageNumbers =
                workflowRunForMonitor !== null ||
                (stage.key === "scan" &&
                  stageOneResultSource === "independent" &&
                  independentStageOneView !== null);
              const upstreamBlocked = stage.state === "queued" && workflowRunForMonitor?.status === "failed";
              const stageStatusLabel = !showStageNumbers
                ? "Unknown"
                : upstreamBlocked
                ? "Blocked"
                : stage.outputs.phase_status === "failed"
                ? "Failed"
                : isIncompleteUniverse
                ? "Incomplete"
                : isStageOneActive
                ? "Working"
                : immediateSuccess
                ? "Finished"
                : investPreviewFinished
                  ? "Finished"
                  : stage.state === "current"
                    ? "Working"
                    : stage.state === "finished"
                      ? "Finished"
                      : "In Queue";
              const stageProgressPercent =
                isIncompleteUniverse
                  ? 0
                  : isStageOneActive
                  ? scanProgressPercent
                  : immediateSuccess || investPreviewFinished
                  ? 100
                  : stage.progressPercent;
              const stageProgressLabel =
                !showStageNumbers ? "Workflow description · no run evidence" : upstreamBlocked ? "Blocked by upstream failure" : isIncompleteUniverse
                  ? "Partial results · full catalogue not verified"
                  : isStageOneActive
                  ? `${scanProgressScanned.toLocaleString("en-IN")}${scanProgressTotal ? ` / ${scanProgressTotal.toLocaleString("en-IN")}` : ""} markets scanned · ${scanProgressPercent.toFixed(1)}% · Page ${displayedScanProgress?.currentPage ?? 1}`
                  : investPreviewFinished && stage.key === "invest"
                  ? "Finished"
                  : stage.progressLabel;
              const showStageSpinner =
                isStageOneActive ||
                (stage.isCurrent && !immediateSuccess && !investPreviewFinished);
              const displayedStageTimerStartedAt = isIndependentStageOneActive
                ? independentStageOneStartedAt
                : stage.timerStartedAt;
              const displayedStageTimerCompletedAt = isIndependentStageOneActive
                ? null
                : stage.timerCompletedAt;
              const stageTwoBypassed =
                stage.key === "llm" &&
                stage.state === "queued" &&
                workflowView.stages.some(
                  (item) => item.key === "invest" && item.state === "current",
                );

              if (["scan"].includes(stage.key)) {
                const filterStage = stage;
                const notEvaluated = stageOneNotEvaluated(filterStage);
                const stats = getStageOneStats(filterStage);
                const workflowStartedAt =
                  workflowRunForMonitor?.started_at ?? null;
                const universalScanStartedAt =
                  universalTriggerStatus?.last_completed_run_started_at ?? null;
                const universalScanCandidate =
                  readStageOutputString(filterStage.outputs.scanned_at) ??
                  readStageOutputString(filterStage.outputs.source_scan_completed_at) ??
                  workflowRunForMonitor?.request_context?.console_profile?.scanned_at ??
                  workflowRunForMonitor?.request_context?.console_profile
                    ?.source_scan_completed_at ??
                  universalScanStartedAt ??
                  null;
                const universalScanAt = universalScanCandidate && Number.isFinite(Date.parse(universalScanCandidate))
                  ? universalScanCandidate : universalScanStartedAt;
                const filtersCompletedAt =
                  readStageOutputString(filterStage.outputs.filters_completed_at) ??
                  filterStage.timerCompletedAt ??
                  readStageOutputString(filterStage.outputs.scanned_at);
                return (
                  <div key="scan" data-testid="bullpen-stage-one-filters" data-stage-state={notEvaluated ? "failed" : isStageOneActive ? "working" : stage.state} className={`flex h-full min-h-[28rem] flex-col rounded-2xl border p-4 shadow-sm transition ${notEvaluated ? "border-red-300 bg-red-50" : toneClasses.container}`}>
                    <div className="mb-4 flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <span className={`flex h-9 w-9 items-center justify-center rounded-xl text-white shadow-sm ${isStageOneActive ? "bg-amber-500 shadow-amber-900/15" : "bg-emerald-700 shadow-emerald-900/15"}`}>
                          <Filter className="h-4 w-4" />
                        </span>
                        <div>
                        <p className={`text-sm font-bold ${toneClasses.text}`}>Stage 1 · Filters</p>
                        <p className={`text-xs ${toneClasses.muted}`}>Qualified event shortlist</p>
                        <div className={`mt-1.5 space-y-0.5 text-xs ${toneClasses.muted}`}>
                          <p>
                            <span className="font-semibold">Last stage run:</span>{" "}
                            <span className="tabular-nums">
                              {formatIstDateTime(workflowStartedAt)}
                            </span>
                          </p>
                          <p>
                            <span className="font-semibold">Universal Polymarket Scan:</span>{" "}
                            <span className="tabular-nums">
                              {formatIstDateTime(universalScanAt)}
                            </span>
                          </p>
                          <p>
                            <span className="font-semibold">Filters run:</span>{" "}
                            <span className="tabular-nums">
                              {notEvaluated ? "Not evaluated — source or worker failure" : formatIstDateTime(filtersCompletedAt)}
                            </span>
                          </p>
                        </div>
                      </div>
                      </div>
                      {isStageOneActive ? (
                        <div className="flex flex-col items-end gap-1.5">
                          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] ${toneClasses.badge}`}>
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Working
                          </span>
                          <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold tabular-nums ${toneClasses.badge}`}>
                            <Clock3 className="h-3 w-3" />
                            {formatStageElapsedTime(displayedStageTimerStartedAt, null, timerNowMs)}
                          </span>
                        </div>
                      ) : null}
                    </div>
                    {isStageOneActive ? (
                      <div className="mb-4 rounded-xl border border-amber-300 bg-white/65 px-3 py-3 text-amber-950 shadow-sm" aria-live="polite" data-testid="bullpen-stage-one-live-progress">
                        <p className="text-xs font-semibold">
                          {displayedScanProgress?.message ?? "Starting Stage 1 filters…"}
                        </p>
                        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs font-semibold tabular-nums">
                          <span>{stageProgressLabel}</span>
                          <span>Updated {(() => {
                            const updatedAt = Date.parse(displayedScanProgress?.lastUpdatedAt ?? "");
                            if (!Number.isFinite(updatedAt)) return "just now";
                            const seconds = Math.max(0, Math.floor((timerNowMs - updatedAt) / 1_000));
                            return seconds < 2 ? "just now" : `${seconds}s ago`;
                          })()}</span>
                        </div>
                        <div className={`mt-2 h-2 overflow-hidden rounded-full ${toneClasses.progressTrack}`}>
                          <div className={`h-full rounded-full transition-[width] duration-500 ${toneClasses.progress}`} style={{ width: `${stageProgressPercent}%` }} />
                        </div>
                      </div>
                    ) : null}
                    <div className="flex-1">
                      <StageOneRunStats stage={filterStage} run={workflowRunForMonitor} decisions={investRunDecisions} hideNumbers={!showStageNumbers}
                        llmStage={filterStage === workflowStage ? workflowView.stages.find(item => item.key === "llm") : undefined}
                        filtersOnly renderInteractiveRows onOpenScanCandidateDialog={openScanCandidateDialog}
                        onOpenScanFilters={onOpenScanFilters}
                        onOpenExcelHistory={() => setIsExcelHistoryDialogOpen(true)}
                        workspaceProfile={workspaceProfile} />
                    </div>
                    <div className={`mt-5 border-t pt-3 ${isStageOneActive ? "border-amber-200/80" : "border-emerald-200/80"}`}>
                      <div className={`flex items-center justify-between gap-3 text-xs font-semibold ${toneClasses.text}`}>
                        <span className="inline-flex items-center gap-1.5">
                          {isStageOneActive ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-600" />
                          ) : (
                            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                          )}
                          {notEvaluated ? "Filtering blocked" : isStageOneActive ? "Filter progress" : "Scan coverage"}
                        </span>
                        <span className="tabular-nums">
                          {!showStageNumbers ? "Unknown · no run evidence" : notEvaluated ? "Not evaluated" : isStageOneActive
                            ? `${scanProgressScanned.toLocaleString("en-IN")} / ${scanProgressTotal?.toLocaleString("en-IN") ?? "—"}`
                            : `${stats.totalScanned.toLocaleString("en-IN")} / ${stats.totalScanned.toLocaleString("en-IN")}`}
                        </span>
                      </div>
                      <div className={`mt-2 h-1.5 overflow-hidden rounded-full ${toneClasses.progressTrack}`}>
                        <div className={`h-full rounded-full transition-[width] duration-500 ${toneClasses.progress}`} style={{ width: `${!showStageNumbers || notEvaluated ? 0 : isStageOneActive ? stageProgressPercent : 100}%` }} />
                      </div>
                    </div>
                  </div>
                );
              }
              return (
                <div
                  key={stage.key}
                  className={`relative flex min-h-[34rem] flex-col rounded-2xl border p-4 shadow-sm transition ${toneClasses.container}`}
                >
                  {canOpenInputs ? (
                    <button
                      type="button"
                      onClick={() =>
                        setOpenInputStageKey(stage.key as "llm" | "invest")
                      }
                      className={`absolute left-4 top-4 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border bg-white/75 transition hover:-translate-y-0.5 hover:bg-white dark:bg-slate-950/80 dark:hover:bg-slate-900 ${toneClasses.badge}`}
                      aria-label={`Open ${stage.title} inputs`}
                      title="Input"
                    >
                      <LogIn className="h-5 w-5" />
                    </button>
                  ) : null}
                  <div
                    className={
                      stage.key === "scan"
                        ? "relative"
                        : "flex items-start justify-between gap-3"
                    }
                  >
                    <div
                      className={`${stage.key === "scan" ? "w-full" : "min-w-0 flex-1"} space-y-1 ${canOpenInputs ? "pl-12" : ""}`}
                    >
                      <div
                        className={`flex items-center gap-2 ${stage.key === "scan" ? "pr-24" : ""}`}
                      >
                        <p
                          className={`text-sm font-semibold ${toneClasses.text}`}
                        >
                          {stage.title}
                        </p>
                        {stage.key === "scan" && onOpenScanFilters ? (
                          <button
                            type="button"
                            onClick={onOpenScanFilters}
                            className={`inline-flex h-5 w-5 items-center justify-center rounded-full border bg-white/70 ${toneClasses.badge}`}
                            aria-label="Open scan filters"
                          >
                            <Info className="h-3 w-3" />
                          </button>
                        ) : null}
                      </div>
                      {stage.subtitle ? (
                        <p
                          className={`text-xs leading-5 ${stage.key === "scan" ? "pr-24" : ""} ${toneClasses.muted}`}
                        >
                          {stage.subtitle}
                        </p>
                      ) : null}

                    </div>
                    <div
                      className={`flex flex-col items-end gap-2 ${stage.key === "scan" ? "absolute right-0 top-0" : ""}`}
                    >
                      <div className="flex items-center gap-1.5">
                        {stageTwoBypassed ? (
                          <button
                            type="button"
                            onClick={() =>
                              setStageTwoBypassDialog({
                                reason: STAGE_TWO_BYPASS_REASON,
                                steps: STAGE_TWO_BYPASS_RECTIFICATION_STEPS,
                              })
                            }
                            className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] transition hover:-translate-y-0.5 hover:bg-white focus:outline-none focus:ring-2 focus:ring-sky-300 ${toneClasses.badge}`}
                            aria-label="Open Stage 2 bypass reason"
                            title="Stage 2 was bypassed for this Stage 3 run"
                          >
                            {stageStatusLabel}
                          </button>
                        ) : (
                          <span
                            className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] ${toneClasses.badge}`}
                          >
                            {stageStatusLabel}
                          </span>
                        )}
                        {stage.key === "invest" && stageStatusLabel === "Working" ? (
                          <button
                            type="button"
                            onClick={() => {
                              if (stage3RetryRequest) {
                                void handleStage3Retry(
                                  stage3RetryRequest,
                                  autoRunActive,
                                );
                              }
                            }}
                            disabled={
                              !stage3RetryRequest || action === "retry-stage3"
                            }
                            className={`inline-flex h-7 w-7 items-center justify-center rounded-full border bg-white/80 transition focus:outline-none focus:ring-2 focus:ring-amber-300 dark:bg-slate-950/80 ${
                              !stage3RetryRequest || action === "retry-stage3"
                                ? "cursor-not-allowed opacity-45"
                                : "hover:-translate-y-0.5 hover:bg-white dark:hover:bg-slate-900"
                            } ${toneClasses.badge}`}
                            aria-label="Retry Stage 3 from saved Stage 2 output"
                            title="Retry both Stage 3 steps from the saved Stage 2 output"
                          >
                            <RefreshCw
                              className={`h-3.5 w-3.5 ${
                                action === "retry-stage3" ? "animate-spin" : ""
                              }`}
                            />
                          </button>
                        ) : null}
                      </div>
                      <span
                        className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold tabular-nums ${toneClasses.badge}`}
                        aria-label={`${stage.title} time taken`}
                        title="Time taken to run this stage"
                      >
                        <Clock3 className="h-3 w-3" />
                        {!showStageNumbers ? "Unknown" : formatStageElapsedTime(
                          displayedStageTimerStartedAt,
                          displayedStageTimerCompletedAt,
                          timerNowMs,
                        )}
                      </span>
                    </div>
                  </div>

                  {showStageRunDetails ? (
                    <div
                      className={`mt-3 rounded-xl border border-white/60 bg-white/50 px-3 py-2 dark:border-slate-700/80 dark:bg-slate-950/70 text-[11px] leading-5 ${toneClasses.muted}`}
                    >
                      <div>
                        Last stage run:{" "}
                        <span className="font-semibold tabular-nums">
                          {!showStageNumbers ? "Unknown" : formatStageLastRunLabel(
                            displayedStageTimerCompletedAt ??
                              displayedStageTimerStartedAt,
                          )}
                        </span>
                      </div>
                      <div>
                        Time taken:{" "}
                        <span className="font-semibold tabular-nums">
                          {!showStageNumbers ? "Unknown" : formatStageElapsedTime(
                            displayedStageTimerStartedAt,
                            displayedStageTimerCompletedAt,
                            timerNowMs,
                          )}
                        </span>
                      </div>
                      {stage.key === "scan" && isStageOneActive ? (
                        <div
                          className={`mt-2 rounded-lg border px-3 py-2 ${
                            displayedScanProgress?.status === "retrying"
                              ? "border-red-300 bg-red-50 text-red-800 dark:border-red-400/40 dark:bg-red-950/40 dark:text-red-100"
                              : "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-400/40 dark:bg-amber-950/40 dark:text-amber-100"
                          }`}
                          aria-live="polite"
                        >
                          <div className="font-semibold">
                            {displayedScanProgress?.message ??
                              "Starting Full Universe scan..."}
                          </div>
                          <div className="mt-1 tabular-nums">
                            {(displayedScanProgress?.scannedMarkets ?? 0).toLocaleString("en-IN")} markets scanned
                            {" · "}Page {displayedScanProgress?.currentPage ?? 1}
                            {" · "}Last update {(() => {
                              const updatedAt = Date.parse(
                                displayedScanProgress?.lastUpdatedAt ?? "",
                              );
                              if (!Number.isFinite(updatedAt)) return "just now";
                              const seconds = Math.max(
                                0,
                                Math.floor((timerNowMs - updatedAt) / 1_000),
                              );
                              return seconds < 2 ? "just now" : `${seconds}s ago`;
                            })()}
                          </div>
                          {(displayedScanProgress?.retryCount ?? 0) > 0 ? (
                            <div className="mt-1 font-semibold">
                              Retry attempts: {displayedScanProgress?.retryCount}
                            </div>
                          ) : null}
                        </div>
                      ) : stage.key === "scan" ? (
                        <StageOneRunStats
                          stage={stage}
                          llmStage={
                            stage === workflowStage
                              ? workflowView.stages.find(
                                  (item) => item.key === "llm",
                                )
                              : undefined
                          }
                          decisions={investRunDecisions}
                          run={workflowRunForMonitor}
                          hideNumbers={!showStageNumbers}
                          renderInteractiveRows
                          onOpenScanCandidateDialog={openScanCandidateDialog}
                          onOpenScanFilters={onOpenScanFilters}
                          onRecoverLegacyExport={(exportScope) =>
                            void handleIndependentStageOneScan(exportScope)
                          }
                          workspaceProfile={workspaceProfile}
                        />
                      ) : null}
                      {stageTwoBypassed ? (
                        <div className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-amber-900">
                          <span className="font-semibold">Stage 2 bypassed:</span>{" "}
                          {STAGE_TWO_BYPASS_REASON}
                        </div>
                      ) : null}
                      {stage.key === "llm" ? (
                        <StageTwoRunStats
                          run={workflowRunForMonitor}
                          stage={stage}
                          hideNumbers={!showStageNumbers}
                          decisions={investRunDecisions}
                          onOpenInvestEvents={setStageTwoInvestEventsDialog}
                          onOpenLlmRunDetails={setStageTwoLlmRunDialog}
                          onOpenScanCandidateDialog={openScanCandidateDialog}
                          scanStageForPositionSnapshot={workflowView.stages.find(
                            (item) => item.key === "scan",
                          )}
                          activePositionRowsFallback={
                            workflowPortfolioPositionFallback
                          }
                          activePositionQuestions={activePositionQuestions}
                        />
                      ) : null}
                    </div>
                  ) : null}

                  {investStageCounters.length > 0 ? (
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      {investStageCounters.map((counter) => {
                        const counterKind =
                          (counter.label === "Queued"
                            ? "planned"
                            : counter.label.toLowerCase()) as InvestMetricDialogKind;
                        const plannedStrategySourceKey = `workflow-stage-${stage.key}-planned`;
                        const isPlannedCounter =
                          stage.key === "invest" &&
                          (counter.label === "Planned" || counter.label === "Queued");

                        if (!isPlannedCounter) {
                          return (
                            <button
                              key={counter.label}
                              type="button"
                              onClick={() => openInvestMetricDialog(counterKind)}
                              className="rounded-xl border border-white/70 bg-white/60 px-3 py-2 text-left transition hover:-translate-y-0.5 hover:border-sky-200 hover:bg-white focus:outline-none focus:ring-2 focus:ring-sky-300 dark:border-slate-700/80 dark:bg-slate-950/70"
                              aria-label={`Open Stage 3 ${counter.label.toLowerCase()} details`}
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
                          );
                        }

                        return (
                          <div
                            key={counter.label}
                            className="relative rounded-xl border border-white/70 bg-white/60 px-3 py-2 text-left transition hover:-translate-y-0.5 hover:border-sky-200 hover:bg-white dark:border-slate-700/80 dark:bg-slate-950/70"
                          >
                            <button
                              type="button"
                              onClick={() =>
                                useStage3PreviewDialog
                                  ? openStage3PreviewDialog()
                                  : openInvestMetricDialog(counterKind)
                              }
                              className="absolute inset-0 rounded-xl focus:outline-none focus:ring-2 focus:ring-sky-300"
                              aria-label={`Open Stage 3 ${counter.label.toLowerCase()} details`}
                            />
                            <div className="pointer-events-none relative z-10">
                              <div className="flex items-center gap-1.5">
                                <p
                                  className={`text-[10px] font-semibold uppercase tracking-[0.14em] ${toneClasses.muted}`}
                                >
                                  {counter.label}
                                </p>
                                <button
                                  type="button"
                                  data-testid="stage3-planned-strategy-button"
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    openStage2To3StrategyDialog({
                                      trigger: event.currentTarget,
                                      sourceKey: plannedStrategySourceKey,
                                      outputs: resolveStage2To3StrategyDialogOutputs(
                                        workflowRun,
                                        isRecord(stage.outputs)
                                          ? stage.outputs
                                          : null,
                                      ),
                                    });
                                  }}
                                  className={`pointer-events-auto inline-flex h-5 w-5 items-center justify-center rounded-full border border-current/30 bg-white/85 ${toneClasses.text} transition hover:bg-white`}
                                  aria-label="Explain Stage 2 to Stage 3 planned strategy"
                                  title="Explain Stage 2 to Stage 3 planned strategy"
                                  aria-haspopup="dialog"
                                  aria-expanded={
                                    stage2To3StrategyDialog?.sourceKey ===
                                    plannedStrategySourceKey
                                  }
                                >
                                  <Info className="h-3 w-3" />
                                </button>
                              </div>
                              <p
                                className={`mt-1 text-sm font-semibold tabular-nums ${toneClasses.text}`}
                              >
                                {counter.value}
                              </p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}

                  {displayedInvestSteps.length > 0 ? (
                    <div className="mt-3">
                      <InvestExecutionStepsSummary
                        steps={displayedInvestSteps}
                        compact
                        onOpenMetricDetails={
                          workflowRun ? openInvestMetricDialog : undefined
                        }
                        onOpenEventExitInfo={() =>
                          setIsEventExitStrategiesDialogOpen(true)
                        }
                        onOpenInvestEligibilityInfo={(trigger) =>
                          openStage2To3StrategyDialog({
                            trigger,
                            sourceKey: `workflow-stage-${stage.key}-buy-step`,
                            outputs: resolveStage2To3StrategyDialogOutputs(
                              workflowRun,
                              isRecord(stage.outputs) ? stage.outputs : null,
                            ),
                          })
                        }
                      />
                    </div>
                  ) : null}

                  {stage.key === "invest" ? (
                    <div className="mt-3 space-y-2 rounded-xl border border-white/60 bg-white/50 px-3 py-3 dark:border-slate-700/80 dark:bg-slate-950/70">
                      <button
                        type="button"
                        onClick={() => {
                          if (effectiveInvestOnlyRequest) {
                            void handleInvestOnly(effectiveInvestOnlyRequest);
                          }
                        }}
                        disabled={
                          Boolean(investOnlyDisabledReason) || action !== null
                        }
                        className={`inline-flex w-full items-center justify-center rounded-xl border px-3 py-2 text-sm font-semibold transition ${
                          investOnlyActionCompleted
                            ? "cursor-default border-emerald-200 bg-emerald-50 text-emerald-900"
                            : investOnlyDisabledReason || action !== null
                              ? "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400"
                              : "border-blue-950 bg-blue-950 text-white hover:bg-blue-900"
                        }`}
                      >
                        {investOnlyActionCompleted ? (
                          <>
                            <CheckCircle2 className="mr-2 h-4 w-4" />
                            Invested
                          </>
                        ) : action === "invest-now" ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Investing...
                          </>
                        ) : (
                          <>
                            <Zap className="mr-2 h-4 w-4" />
                            Exit and Invest
                          </>
                        )}
                      </button>
                      {!investOnlyDisabledReason &&
                      stage3PreviewDialogState &&
                      stage3PreviewDialogState.plannedOrders > 0 ? (
                        <p
                          className={`text-[11px] leading-5 ${toneClasses.muted}`}
                        >
                          {stage3InterruptedWithoutResume
                            ? "Stage 3 was interrupted before the worker finished all exit and invest checks. The counts above show the planned, processed, and submitted values persisted before interruption; use recovery/retry to reconcile before starting a fresh pass."
                            : (
                              <>
                                {stage3PreviewDialogState.plannedOrders} queued candidate{" "}
                                {stage3PreviewDialogState.plannedOrders === 1
                                  ? "row is"
                                  : "rows are"}{" "}
                                ready for this invest-only pass. No concrete order is
                                planned until the worker completes Stage 3 checks.
                                {" "}
                                {stage3PreviewDialogState.sellPlannedOrders > 0
                                  ? `${stage3PreviewDialogState.sellPlannedOrders} sell${stage3PreviewDialogState.sellPlannedOrders === 1 ? "" : "s"} first`
                                  : "No sell rows are queued"}
                                {" · "}
                                {stage3PreviewDialogState.buyPlannedOrders} buy
                                {stage3PreviewDialogState.buyPlannedOrders === 1
                                  ? ""
                                  : "s"}{" "}
                                after the post-exit refresh.
                              </>
                            )}
                        </p>
                      ) : null}
                    </div>
                  ) : null}

                  <div
                    className={`mt-4 h-2 overflow-hidden rounded-full ${toneClasses.progressTrack}`}
                  >
                    <div
                      className={`h-full rounded-full ${toneClasses.progress} ${
                        isIndependentStageOneActive ? "animate-pulse" : ""
                      }`}
                      style={{ width: `${stageProgressPercent}%` }}
                    />
                  </div>

                  <div className="mt-3 flex items-center justify-between gap-3">
                    {stage.key === "llm" ? (
                      <button
                        type="button"
                        onClick={() => {
                          const scanStage = workflowView.stages.find(
                            (item) => item.key === "scan",
                          );
                          if (scanStage)
                            openScanCandidateDialog(
                              scanStage,
                              "fresh-opportunities",
                            );
                        }}
                        className={`text-left text-xs font-semibold underline-offset-2 transition hover:underline focus:outline-none focus:ring-2 focus:ring-emerald-300 ${toneClasses.text}`}
                      >
                        {stageProgressLabel}
                      </button>
                    ) : (
                      <p
                        className={`text-xs font-semibold ${toneClasses.text}`}
                      >
                        {stageProgressLabel}
                      </p>
                    )}
                    {showStageSpinner ? (
                      <Loader2
                        className={`h-4 w-4 animate-spin ${toneClasses.text}`}
                      />
                    ) : null}
                  </div>

                  <div className="mt-auto flex items-end justify-between gap-3 pt-3">
                    {stage.key === "llm" ? (
                      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
                        <EventScanRunControls
                          buttonClassName="hidden"
                          buttonLabel="Run LLM"
                          containerClassName="gap-0"
                          selectionMode="multiple"
                          defaultTargets={selectedLlmTargets}
                          disableImplicitDefaultTarget
                          ignoreStoredSelection
                          onRunMultiple={() => undefined}
                          onSelectionChange={handleSelectedLlmTargetsChange}
                          pickerDialogLabel="Select LLMs"
                          pickerDescription={
                            stage.isCurrent
                              ? "Changes are saved for the next run. The running Stage 2 job uses the frozen target list shown in its progress details."
                              : undefined
                          }
                          pickerIcon={<Bot className="h-5 w-5" />}
                          pickerPlacement="center"
                          pickerButtonClassName={`h-10 w-10 rounded-full bg-white/75 dark:bg-slate-950/80 ${toneClasses.badge}`}
                        />
                        <div className="relative flex min-w-0 flex-1 flex-wrap items-center gap-2 text-xs text-slate-600">
                          <button
                            type="button"
                            onClick={() =>
                              setIsLlmExecutionModePickerOpen(
                                (isOpen) => !isOpen,
                              )
                            }
                            disabled={llmExecutionSettingsSaveBusy}
                            className="inline-flex max-w-full items-center gap-2 rounded-full border border-slate-200 bg-white/90 px-3 py-2 font-semibold text-slate-800 shadow-sm transition hover:border-slate-300 hover:bg-white focus:outline-none focus:ring-2 focus:ring-amber-300 disabled:cursor-not-allowed disabled:opacity-60"
                            aria-expanded={isLlmExecutionModePickerOpen}
                            aria-haspopup="listbox"
                          >
                            <span className="truncate">
                              {llmExecutionMode === "chunked_parallel"
                                ? `Batched parallel · ${llmEventsPerPromptInput || DEFAULT_LLM_EVENTS_PER_PROMPT} events/prompt`
                                : "Single combined"}
                            </span>
                            <ChevronDown
                              className={`h-3.5 w-3.5 transition ${
                                isLlmExecutionModePickerOpen ? "rotate-180" : ""
                              }`}
                            />
                          </button>
                          {isLlmExecutionModePickerOpen ? (
                            <div className="absolute bottom-full left-0 z-20 mb-2 w-[min(20rem,calc(100vw-2rem))] overflow-hidden rounded-3xl border border-slate-200 bg-white p-2 text-slate-700 shadow-xl ring-1 ring-slate-900/5">
                              <label className="flex cursor-pointer items-center gap-2 rounded-2xl px-3 py-2.5 font-semibold transition hover:bg-slate-50">
                                <input
                                  type="radio"
                                  name="stage-2-llm-execution-mode"
                                  value="single_combined"
                                  checked={
                                    llmExecutionMode === "single_combined"
                                  }
                                  onChange={() => {
                                    handleLlmExecutionModeChange(
                                      "single_combined",
                                    );
                                    setIsLlmExecutionModePickerOpen(false);
                                  }}
                                  disabled={llmExecutionSettingsSaveBusy}
                                  className="h-3.5 w-3.5 accent-slate-950"
                                />
                                <span>Single combined</span>
                              </label>
                              <label className="mt-1 flex cursor-pointer flex-wrap items-center gap-2 rounded-2xl px-3 py-2.5 font-semibold transition hover:bg-slate-50">
                                <input
                                  type="radio"
                                  name="stage-2-llm-execution-mode"
                                  value="chunked_parallel"
                                  checked={
                                    llmExecutionMode === "chunked_parallel"
                                  }
                                  onChange={() =>
                                    handleLlmExecutionModeChange(
                                      "chunked_parallel",
                                    )
                                  }
                                  disabled={llmExecutionSettingsSaveBusy}
                                  className="h-3.5 w-3.5 accent-slate-950"
                                />
                                <span>Batched parallel</span>
                                <input
                                  type="number"
                                  min={1}
                                  max={100}
                                  step={1}
                                  value={llmEventsPerPromptInput}
                                  onChange={handleLlmEventsPerPromptInputChange}
                                  disabled={llmExecutionSettingsSaveBusy}
                                  className="h-7 w-16 rounded-lg border border-slate-200 bg-white px-2 text-center text-sm font-bold text-slate-900 outline-none transition focus:border-slate-400"
                                  aria-label="Stage 2 events per prompt"
                                />
                                <span className="basis-full pl-5 text-[11px] text-slate-500">
                                  Events/prompt
                                </span>
                              </label>
                            </div>
                          ) : null}
                          {llmExecutionFieldError ? (
                            <p className="basis-full text-[11px] font-semibold text-rose-700">
                              {llmExecutionFieldError}
                            </p>
                          ) : llmExecutionSettingsSaveBusy ? (
                            <p className="basis-full text-[11px] font-semibold text-slate-500">
                              Saving Stage 2 settings...
                            </p>
                          ) : null}
                        </div>
                      </div>
                    ) : (
                      <span />
                    )}
                    {stage.key === "scan" ||
                    Object.keys(stage.outputs).length > 0 ? (
                      <button
                        type="button"
                        onClick={() => {
                          if (stage.key === "scan") {
                            openScanCandidateDialog(
                              stage,
                              "fresh-opportunities",
                            );
                            return;
                          }
                          setOpenStageKey(stage.key);
                        }}
                        className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border bg-white/75 transition hover:-translate-y-0.5 hover:bg-white dark:bg-slate-950/80 dark:hover:bg-slate-900 ${toneClasses.badge}`}
                        aria-label={
                          stage.key === "scan"
                            ? "Open Stage 1 output candidates"
                            : `Open ${stage.title} output`
                        }
                        title="Output"
                      >
                        <LogOut className="h-5 w-5" />
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {isRunHistoryDialogOpen ? (
          <div className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/55 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) closeRunHistoryDialog(); }}>
            <div className="max-h-[92vh] w-full max-w-7xl">
              <BullpenRunHistoryContent page={visibleRunHistoryPage} trends={visibleRunHistoryEventTrends} loading={runHistoryLoading} trendsLoading={runHistoryEventTrendsLoading} error={runHistoryError} trendsError={runHistoryEventTrendsError} detailLoadingId={runHistoryDetailLoadingId} onRefresh={() => void loadRunHistory()} onPage={(page) => void loadRunHistory(page)} onOpenRun={(run) => void openHistoryRunDetail(run)} onClose={closeRunHistoryDialog} fullScreenPath={bullpenWorkspaceHistoryPath(workspaceProfile)} eventTrendsTimeoutSeconds={eventTrendsTimeoutSeconds} onEventTrendsTimeoutChange={saveTimeoutSeconds} />
            </div>
          </div>
        ) : null}

        {isExcelHistoryDialogOpen ? <BullpenStageOneExcelHistoryDialog
          open
          onClose={() => setIsExcelHistoryDialogOpen(false)}
          workspaceProfile={workspaceProfile}
        /> : null}

        {isEventExitStrategiesDialogOpen ? (
          <BullpenEventExitStrategiesDialog
            onClose={() => setIsEventExitStrategiesDialogOpen(false)}
          />
        ) : null}

        {stage2To3StrategyDialog ? (
          <BullpenStage2To3StrategyDialog
            open
            onClose={() => setStage2To3StrategyDialog(null)}
            triggerRef={stage2To3StrategyDialogTriggerRef}
            minLlmSideOdds={
              stage2To3StrategyDialog.strategyMetadata.minLlmSideOdds ??
              DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MIN_LLM_SIDE_ODDS
            }
            maxPositions={
              stage2To3StrategyDialog.strategyMetadata.maxPositions ??
              DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MAX_POSITIONS
            }
            rankingFieldLabel={formatBullpenStage2To3RankingFieldLabel(
              stage2To3StrategyDialog.strategyMetadata.rankingField ??
                DEFAULT_BULLPEN_STAGE2_TO_STAGE3_RANKING_FIELD,
            )}
            rankingTieBreakLabel={formatBullpenStage2To3RankingTieBreakLabel(
              stage2To3StrategyDialog.strategyMetadata.rankingTieBreak ??
                DEFAULT_BULLPEN_STAGE2_TO_STAGE3_RANKING_TIE_BREAK,
            )}
            sizingFormulaLabel={formatBullpenStage2To3SizingFormulaLabel(
              stage2To3StrategyDialog.strategyMetadata.maxPositions ??
                DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MAX_POSITIONS,
            )}
            universeStatus={stage2To3StrategyDialog.universeStatus}
          />
        ) : null}

        {scanCandidateDialog ? (
          <StageOneOutputDialog
            state={scanCandidateDialog}
            onClose={() => setScanCandidateDialog(null)}
            workspaceProfile={workspaceProfile}
            onRecoverLegacyExport={(exportScope) =>
              void handleIndependentStageOneScan(exportScope)
            }
          />
        ) : null}

        {runDetailDialog ? (
          <RunDetailDialog
            state={runDetailDialog}
            onClose={closeRunDetailDialog}
            onOpenScanFilters={onOpenScanFilters}
            onOpenScanCandidateDialog={openScanCandidateDialog}
            onOpenStageTwoInvestEvents={setStageTwoInvestEventsDialog}
            onOpenStageTwoLlmRunDetails={setStageTwoLlmRunDialog}
            onOpenMetricDetails={openRunInvestMetricDialog}
          />
        ) : null}

        {runtimeErrorDialog ? (
          <SimpleInfoDialog
            eyebrow="Runtime error"
            title={runtimeErrorDialog}
            onClose={() => setRuntimeErrorDialog(null)}
            sections={[
              { title: "What happened", body: "The Bullpen console received an unexpected runtime/API error while refreshing independent run-history or live-progress data. The main worker may still be running." },
              { title: "Status", body: "This message is informational unless it persists after refresh. It should no longer block the current stage tiles from using the latest durable run state." },
              { title: "How to resolve", body: "Refresh the console, reopen Run History, and if the same error remains, check the backend investor-backend service logs plus Celery worker logs for the matching request time and run id." },
            ]}
          />
        ) : null}
        {runHistoryStageHelp ? (
          <SimpleInfoDialog
            eyebrow="Run history stage badge"
            title={`${runHistoryStageHelp.label}: ${runHistoryStageHelp.status}`}
            onClose={() => setRunHistoryStageHelp(null)}
            sections={[
              { title: "What it means", body: "This badge summarizes one deterministic audit checkpoint for the saved Bullpen run." },
              { title: "Candidate Scan", body: "Stage 1 scanned active wallet positions and fresh opportunities, applied filters, and records warning when candidates exist but some scan evidence needs attention." },
              { title: "Market Rules and Deadline", body: "This check verifies market rule/deadline eligibility before LLM and order planning. Pass means the saved run had enough rule evidence to continue." },
              { title: "Evidence and LLM Consensus", body: "This check validates Stage 2 evidence packets, LLM output parsing, probability estimates, and consensus. Fail means Stage 3 may have no durable actionable orders to submit." },
            ]}
          />
        ) : null}
        {refreshedStageTwoLlmRunDialog ? (
          <StageTwoLlmRunDetailsDialog
            state={refreshedStageTwoLlmRunDialog}
            activePositions={activePositions}
            onClose={() => setStageTwoLlmRunDialog(null)}
          />
        ) : null}

        {stageTwoBypassDialog ? (
          <StageTwoBypassDialog
            state={stageTwoBypassDialog}
            onClose={() => setStageTwoBypassDialog(null)}
          />
        ) : null}

        {stageTwoInvestEventsDialog ? (
          <StageTwoInvestEventsDialog
            state={stageTwoInvestEventsDialog}
            onClose={() => setStageTwoInvestEventsDialog(null)}
          />
        ) : null}

        {isTradeAmountInfoDialogOpen ? (
          <div className="fixed inset-0 z-[180] flex items-center justify-center bg-slate-950/60 p-4 text-slate-950">
            <div className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.55)]">
              <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-fuchsia-700">
                    Trade amount formula
                  </p>
                  <h3 className="mt-1 text-xl font-semibold">
                    {formatBullpenStage2To3SizingFormulaLabel(
                      CONSOLE_MAX_ACTIVE_POSITIONS,
                    )}
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => setIsTradeAmountInfoDialogOpen(false)}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
                  aria-label="Close trade amount formula"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="space-y-4 overflow-y-auto px-6 py-5">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Current amount
                  </p>
                  <p className="mt-2 text-2xl font-semibold text-slate-950">
                    {tradeAmountDisplay}
                  </p>
                  <p className="mt-2 text-sm text-slate-600">
                    {tradeAmountView.source === "live"
                      ? useVerifiedStage1Fallback
                        ? "Calculated from the latest completed Stage 1 fallback because a current portfolio snapshot is not available yet. The worker rechecks cash and occupied slots before any live buy."
                        : "Calculated from the latest Bullpen portfolio snapshot as a preview. The worker rechecks occupied slots and fresh balance before any live buy."
                      : tradeAmountView.source === "last-calculated"
                        ? "Showing the last successful diagnostic calculation until a fresh balance sync completes. That cached amount is never used as a live-buy fallback."
                        : "Waiting for Bullpen cash in hand and occupied-slot data."}
                  </p>
                </div>

                {tradeAmountView.cashInHandUsd !== null &&
                tradeAmountView.activePositions !== null &&
                tradeAmountView.availableSlots !== null ? (
                  <>
                    {tradeAmountView.availableSlots > 0 ? (
                      <div className="rounded-2xl border border-fuchsia-200 bg-fuchsia-50/60 p-4 text-sm font-medium text-slate-700">
                        {`${formatMoney(tradeAmountView.cashInHandUsd)} / ${tradeAmountView.availableSlots} = ${tradeAmountDisplay}`}
                      </div>
                    ) : (
                      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                        All {tradeAmountView.maxPositions} slots are already in
                        use, so new opportunities size to $0.00 until a
                        position resolves.
                      </div>
                    )}

                    <div className="grid gap-3 sm:grid-cols-2">
                      {[
                        ["Cash in hand", formatMoney(tradeAmountView.cashInHandUsd)],
                        [
                          "Occupied positions",
                          tradeAmountView.activePositions.toLocaleString("en-IN"),
                        ],
                        [
                          "Available new slots",
                          tradeAmountView.availableSlots.toLocaleString("en-IN"),
                        ],
                        [
                          "Target slots",
                          tradeAmountView.maxPositions.toLocaleString("en-IN"),
                        ],
                      ].map(([label, value]) => (
                        <div
                          key={label}
                          className="rounded-2xl border border-slate-200 bg-white p-4"
                        >
                          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                            {label}
                          </p>
                          <p className="mt-2 text-sm font-semibold text-slate-950">
                            {value}
                          </p>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                    The trade amount will appear here after Bullpen cash in hand
                    and active positions finish refreshing.
                  </div>
                )}

                <p className="text-sm leading-6 text-slate-600">
                  When an active position resolves, cash is added back and this
                  amount recalculates on the next fresh balance sync.
                </p>
              </div>
            </div>
          </div>
        ) : null}

        {investMetricDialog ? (
          <InvestMetricDetailsDialog
            state={investMetricDialog}
            onClose={() => setInvestMetricDialog(null)}
            onSelectKind={(kind) =>
              openRunInvestMetricDialog(investMetricDialog.run, kind)
            }
            onOpenEventExitInfo={() => setIsEventExitStrategiesDialogOpen(true)}
            onOpenInvestEligibilityInfo={(trigger) =>
              openStage2To3StrategyDialog({
                trigger,
                sourceKey: `invest-metric-${investMetricDialog.run.id}-${investMetricDialog.kind}`,
                outputs: resolveStage2To3StrategyDialogOutputs(
                  investMetricDialog.run,
                  investMetricDialog.stage &&
                    isRecord(investMetricDialog.stage.outputs)
                    ? investMetricDialog.stage.outputs
                    : null,
                ),
              })
            }
          />
        ) : null}

        {stage3PreviewDialog ? (
          <Stage3PreviewDialog
            state={stage3PreviewDialog}
            submitting={action === "invest-now"}
            submitDisabled={Boolean(investOnlyDisabledReason) || action !== null}
            onClose={() => setStage3PreviewDialog(null)}
            onSubmit={
              stage3PreviewDialog.request
                ? () => {
                    setStage3PreviewDialog(null);
                    void handleInvestOnly(stage3PreviewDialog.request!);
                  }
                : undefined
            }
          />
        ) : null}

        {latestRunFailureMessage ? (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
            <p className="font-medium">{latestRunFailureMessage}</p>
            {latestRunFailureDetail ? (
              <div className="mt-1 text-xs leading-5 text-rose-800">
                <ErrorCodeWithDetails
                  detail={latestRunFailureDetail}
                  detailClassName="text-rose-800"
                />
              </div>
            ) : null}
          </div>
        ) : null}

        {stage2TargetSelectionWarning ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {stage2TargetSelectionWarning}
          </div>
        ) : null}

        {displayNotice ? (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
            {displayNotice}
          </div>
        ) : null}

        {error ? (
          <button
            type="button"
            onClick={() => setRuntimeErrorDialog(error.details ? `${error.message}\n${error.details}` : error.message)}
            className="w-full rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-left text-sm text-rose-900 underline-offset-2 transition hover:bg-rose-100 hover:underline focus:outline-none focus:ring-2 focus:ring-rose-300"
            aria-label="Open runtime error details and resolution steps"
          >
            <span className="block font-medium">{error.message}</span>
            {error.details ? (
              <span className="mt-1 block text-xs leading-5 text-rose-800">
                {error.details}
              </span>
            ) : null}
          </button>
        ) : null}

        {loading && !summary ? (
          <p className="text-xs text-slate-500" role="status">
            Run history and runtime details are refreshing independently.
          </p>
        ) : null}

        {openInputStage ? (
          <BullpenAutoRunStageOutputDialog
            eyebrow="Stage Input"
            stageTitle={openInputStage.title}
            stageDetail={`Event inputs being fed into ${openInputStage.title}.`}
            outputs={openInputStage.inputs}
            alreadyInvestedRecords={
              openInputStage.key === "invest"
                ? stageInputAlreadyInvestedRecords
                : []
            }
            outputLabel="Inputs"
            onClose={() => setOpenInputStageKey(null)}
          />
        ) : null}

        {openStage ? (
          <BullpenAutoRunStageOutputDialog
            stageTitle={openStage.title}
            stageDetail={openStage.detail}
            outputs={openStage.outputs}
            onClose={() => setOpenStageKey(null)}
          />
        ) : null}
        {openBadgeRationale ? (
          <BullpenAutoRunBadgeRationaleDialog
            rationale={getBullpenAutoRunBadgeRationale(
              openBadgeRationale,
              visiblePersistedAutoRunStatus,
              autoRunStatusLoadState,
            )}
            onClose={() => setOpenBadgeRationale(null)}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

export { BullpenRunDetailScreen, StageTwoLlmRunDetailsDialog } from "./BullpenScheduleLazyDetails";

Warning: truncated output (original token count: 139552)
Total output lines: 14006

"use client";

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import {
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock3,
  Copy,
  History,
  ExternalLink,
  Info,
  Bot,
  RefreshCw,
  Wallet,
  Loader2,
  LogIn,
  LogOut,
  PauseCircle,
  PlayCircle,
  ShieldAlert,
  Square,
  X,
  Zap,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  type BullpenQuestionRow,
  getBullpenAmountToBeInvestedBreakdown,
  getBullpenReturnsPerDayBreakdown,
} from "@/lib/bullpen-ai";
import type { BullpenActivePositionLlmAnalysis } from "@/lib/bullpenActivePositions";
import { buildBullpenInvestmentDisplay } from "@/lib/bullpenInvestments";
import { formatApiTimestamp } from "@/lib/datetime";
import { useAuth } from "@/hooks/useAuth";
import {
  BullpenEventIdentityResolver,
  buildBullpenEventIdentityFromDecision,
  buildBullpenEventIdentityFromPosition,
} from "@/lib/bullpenEventIdentityResolver";
import {
  isActiveBullpenPosition,
  isClaimableBullpenPosition,
  resolveBullpenPreferredPortfolioValue,
  resolveBullpenTotalPortfolioValue,
  sumBullpenPortfolioPositionValue,
  sumCurrentPositionValue,
  type BullpenActivePositionView,
  type BullpenPositionsSnapshotLineage,
  type BullpenPositionsSource,
  type BullpenPositionsSummary,
} from "@/lib/bullpenPositions";
import {
  resolveLatestVerifiedStage1Portfolio,
  resolveVerifiedStage1PortfolioSnapshot,
  selectLatestVerifiedStage1Portfolio,
  shouldUseVerifiedStage1PortfolioFallback,
} from "@/lib/bullpenVerifiedPortfolio";
import { formatUnknownError, splitApiErrorSummary } from "@/lib/apiErrors";
import {
  mergeBullpenConsoleDecisionProjection,
  mergeBullpenConsoleRunProjection,
  reconcileBullpenConsoleRunCopies,
} from "@/lib/bullpenRunConsoleDetail";
import { APIError, RequestTimeoutError, apiService } from "@/services/api";
import type {
  BullpenAutoLiveDecision,
  BullpenAutoLiveHistoryItem,
  BullpenAutoLiveHistoryPage,
  BullpenAutoLiveEventTrendsResponse,
  BullpenAutoLiveOutcomeSide,
  BullpenAutoLiveRun,
  BullpenAutoLiveRunOnceRequest,
  BullpenAutoLiveSummaryResponse,
  BullpenLlmExecutionMode,
  ProviderModelTarget,
  PolymarketBotState,
} from "@/types/api";

import {
  buildBullpenAutoRunWorkflowView,
  isBullpenAutoRunWorkflowSettled,
} from "./bullpenAutoRunProgress";
import {
  createAbortableBullpenAutoRunRequestDeduper,
  getBullpenAutoRunActiveRunId,
  getBullpenAutoRunStatusCacheKey,
  getBullpenAutoRunStatusBadges,
  getBullpenAutoRunBadgeRationale,
  getBullpenAutoRunStatusRetryDelay,
  isBullpenAutoRunProgressActive,
  isBullpenAutoRunSchedulerEnabled,
  isBullpenAutoRunPageVisible,
  logBullpenAutoRunStatusFallback,
  normalizeBullpenAutoRunStatusData,
  normalizeBullpenAutoRunStatusFromSummary,
  readCachedBullpenAutoRunStatus,
  writeCachedBullpenAutoRunStatus,
  type BullpenAutoRunStatusData,
  type BullpenAutoRunStatusLoadState,
  type BullpenAutoRunBadgeKind,
} from "./bullpenAutoRunStatus";
import { BullpenAutoRunBadgeRationaleDialog } from "./BullpenAutoRunBadgeRationaleDialog";
import {
  BullpenReturnsPerDayFormulaDialog,
  BullpenReturnsPerDayHeader,
  BullpenReturnsPerDayValueButton,
} from "./BullpenReturnsPerDayInfo";
import { BullpenRunHistoryContent } from "./BullpenRunHistoryContent";
import {
  buildBullpenStage3InvestPreviewSteps,
  buildBullpenStage3OnlyInvestExecutionPlan,
  NO_STAGE2_QUALIFIED_EVENTS_REASON,
  type BullpenStage3AlreadyInvestedRecord,
  selectBullpenStage3OnlyInvestSource,
} from "./bullpenAutoRunStage3Invest";
import {
  deriveInvestExecutionStepStatus,
  getStage2TransferQueueMetricInfo,
  getInvestMetricDialogDefinition,
  getInvestMetricRows,
  getInvestStepMetricDialogKind,
  getSellInvestMetricDialogKind,
  isCompletedWithoutSubmissionInvestDecision,
  isProcessedInvestOrderPlan,
  isSubmittedOrExecutedInvestOrderPlan,
  partitionInvestDecisionsByExecutionEvidence,
  summarizeInvestStepCountsFromDecisions,
  type InvestExecutionStepStatus,
  type InvestMetricDialogKind,
  type Stage2TransferQueueMetricInfoKind,
} from "./bullpenAutoRunInvestMetrics";
import { getInvestStageImmediateSuccess } from "./bullpenAutoRunStageStatus";
import { getBullpenStage3SellExecutionTelemetry } from "./bullpenStage3SellExecution";
import { EventScanRunControls } from "@/components/shared/EventScanRunControls";
import {
  BullpenQuestionsTable,
  type BullpenQuestionsTableExtraColumn,
  type BullpenTableSortKey,
  type BullpenTableSortState,
} from "./BullpenQuestionsTable";
import {
  buildStageTwoEventsSummaryRows as buildHistoricalStageTwoEventsSummaryRows,
  getStageTwoLlmReviewedRows as getHistoricalStageTwoLlmReviewedRows,
  getStageTwoLlmTableRows as getHistoricalStageTwoLlmTableRows,
  resolveStageTwoEventsSummaryUpdatedAt,
  resolveStageTwoHistoricalAsOfTimestamp,
} from "./bullpenAutoRunStageTwoHistory";
import {
  buildBullpenStage2TopTenHandoffRows,
  type BullpenStage2TopTenHandoffRow,
} from "./bullpenStage2TopTenHandoff";
import {
  formatElapsedRunTime,
  formatStageElapsedTime,
} from "./bullpenAutoRunTimers";
import { BullpenStage2ActionablesDialog } from "./BullpenStage2ActionablesDialog";
import { buildBullpenStage2Actionables } from "./bullpenStage2Actionables";
import {
  DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MAX_POSITIONS,
  DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MIN_LLM_SIDE_ODDS,
  DEFAULT_BULLPEN_STAGE2_TO_STAGE3_RANKING_FIELD,
  DEFAULT_BULLPEN_STAGE2_TO_STAGE3_RANKING_TIE_BREAK,
  formatBullpenStage2To3RankingFieldLabel,
  formatBullpenStage2To3RankingTieBreakLabel,
  formatBullpenStage2To3SizingFormulaLabel,
  mergeBullpenStage2To3StrategyOutputs,
  readBullpenStage2To3StrategyMetadata,
  readBullpenStage2UniverseStatus,
  type BullpenStage2To3StrategyMetadata,
  type BullpenStage2UniverseStatus,
} from "./bullpenStage2To3Strategy";

const BullpenInvestmentMathDialog = dynamic(
  () =>
    import("./BullpenInvestmentMathDialog").then(
      (module) => module.BullpenInvestmentMathDialog,
    ),
  { ssr: false },
);
const BullpenStage2To3StrategyDialog = dynamic(
  () =>
    import("./BullpenStage2To3StrategyDialog").then(
      (module) => module.BullpenStage2To3StrategyDialog,
    ),
  { ssr: false },
);
const BullpenEventExitStrategiesDialog = dynamic(
  () =>
    import("./BullpenEventExitStrategiesDialog").then(
      (module) => module.BullpenEventExitStrategiesDialog,
    ),
  { ssr: false },
);
const BullpenEventHistoricalAssessmentTable = dynamic(
  () =>
    import("./BullpenEventHistoricalAssessmentTable").then(
      (module) => module.BullpenEventHistoricalAssessmentTable,
    ),
  { ssr: false },
);
const BullpenAutoRunStageOutputDialog = dynamic(
  () =>
    import("./BullpenAutoRunStageOutputDialog").then(
      (module) => module.BullpenAutoRunStageOutputDialog,
    ),
  { ssr: false },
);

type BullpenEventSummaryHighlight =
  | "active-retained"
  | "event-exit"
  | "new-opportunity";

const BULLPEN_LOGIN_COMMAND =
  "sudo -u investor -H /usr/local/bin/bullpen login --no-browser";
const BULLPEN_LAST_LLM_TARGET_STORAGE_KEY =
  "investment-engine:bullpen-ai:last-llm-target:v1";

type BullpenAutoRunScheduleCardProps = {
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
  onSummaryUpdated?: (payload: {
    summary: BullpenAutoLiveSummaryResponse;
    run: BullpenAutoLiveRun | null;
    pendingRunId: string | null;
  }) => void;
};

type ActionState =
  | "enable"
  | "invest-now"
  | "start-now"
  | "stop"
  | "pause-run"
  | "resume-run"
  | "kill-run"
  | "retry-stage3"
  | null;
type ErrorState = {
  message: string;
  details: string | null;
};

type InvestMetricDialogState = {
  kind: InvestMetricDialogKind;
  run: BullpenAutoLiveRun;
  stage:
    | ReturnType<typeof buildBullpenAutoRunWorkflowView>["stages"][number]
    | null;
  decisions: BullpenAutoLiveDecision[];
};

type PreviewCandidateRow =
  NonNullable<
    NonNullable<BullpenAutoLiveRunOnceRequest["console_profile"]>["candidate_rows"]
  >[number];

type PreviewExitEntry =
  ReturnType<typeof buildBullpenInvestmentDisplay>["activePositionsNeedingAttention"][number];

type Stage3PreviewDialogState = {
  sourceRun: BullpenAutoLiveRun | null;
  request: BullpenAutoLiveRunOnceRequest | null;
  decisions: BullpenAutoLiveDecision[];
  plannedOrders: number;
  sellPlannedOrders: number;
  buyPlannedOrders: number;
};

type ScanCandidateDialogMode =
  | "all-scanned"
  | "fresh-opportunities"
  | "active-positions";

type RunDetailDialogState = {
  run: BullpenAutoLiveRun;
  decisions: BullpenAutoLiveDecision[];
  decisionListTruncated?: boolean;
  decisionListLimit?: number | null;
};

type StageTwoInvestEventsDialogState = {
  rows: BullpenQuestionRow[];
  stage: WorkflowStageView | null;
  decisions: BullpenAutoLiveDecision[];
  updatedAt: string | null;
  updateUnavailableReason?: string;
};

type StageTwoLlmRunDialogState = {
  run: BullpenAutoLiveRun | null;
  stage: WorkflowStageView;
  decisions: BullpenAutoLiveDecision[];
};

type StageTwoBypassDialogState = {
  reason: string;
  steps: string[];
};

const STAGE_TWO_BYPASS_REASON =
  "Stage 3 has already started while Stage 2 is still marked In Queue because this run is reusing the latest saved Stage 2-qualified output instead of launching a new LLM review for the current pass.";

const STAGE_TWO_BYPASS_RECTIFICATION_STEPS = [
  "Open Stage 2 Output or the latest completed run details and confirm the saved Stage 2 top-10 rows are fresh enough for the current investment decision.",
  "If fresh LLM review is required, stop the active Stage 3 pass, run Stage 2 · Run LLM again, and wait until the Stage 2 container shows Finished.",
  "After Stage 2 finishes, rerun Stage 3 · Exit and Invest so orders are planned from the newly completed Stage 2 snapshot.",
];

function normalizePreviewConfidence(
  value: string | null | undefined,
): BullpenAutoLiveDecision["confidence"] {
  if (value === "Low" || value === "Medium" || value === "High") {
    return value;
  }
  return "High";
}

function normalizePreviewEvidenceStatus(
  value: string | null | undefined,
): BullpenAutoLiveDecision["evidence_status"] {
  if (value === "Low" || value === "Moderate" || value === "Strong") {
    return value;
  }
  return "Strong";
}

function normalizePreviewOutcomeSide(
  value: string | null | undefined,
): BullpenAutoLiveOutcomeSide {
  return value?.trim().toUpperCase() === "YES" ? "YES" : "NO";
}

function computePreviewHoursRemaining(closeTime: string | null | undefined) {
  if (!closeTime) return null;
  const closeMs = Date.parse(closeTime);
  if (!Number.isFinite(closeMs)) return null;
  return Math.max(0, Number(((closeMs - Date.now()) / (60 * 60 * 1000)).toFixed(2)));
}

function resolvePreviewBuySide(
  candidate: Pick<PreviewCandidateRow, "llm_yes_odds" | "llm_no_odds">,
): BullpenAutoLiveDecision["side"] {
  const yesOdds = candidate.llm_yes_odds ?? Number.NEGATIVE_INFINITY;
  const noOdds = candidate.llm_no_odds ?? Number.NEGATIVE_INFINITY;
  return yesOdds > noOdds ? "YES" : "NO";
}

function buildStage3PreviewBuyDecision({
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

function buildStage3PreviewSellDecision({
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

function buildStage3PreviewDialogState({
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

function resolveStageTwoLlmRunDialogState({
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

function preserveCompletedStageEvidence(
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

type StageTwoDecisionDialogState = {
  decision: BullpenAutoLiveDecision;
  llmContext: Record<string, unknown> | null;
};

type StageTwoDecisionDialogMode = "tag" | "llm-inputs";

type StageTwoLlmEventInputDialogState = {
  title: string;
  llmContext: Record<string, unknown> | null;
};

type Stage2To3StrategyDialogState = {
  sourceKey: string;
  strategyMetadata: BullpenStage2To3StrategyMetadata;
  universeStatus: BullpenStage2UniverseStatus;
};

type StageTwoLlmRunBreakupKind =
  | "active-positions"
  | "new-opportunities"
  | "overlap"
  | "unique-llm-rows";

type ScanCandidateDialogState = {
  mode: ScanCandidateDialogMode;
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

type ScanCandidateDialogCandidate = ReturnType<
  typeof buildBullpenAutoRunWorkflowView
>["stages"][number]["scanCandidates"][number] & {
  llmYesOdds: number | null;
  llmNoOdds: number | null;
  returnsPerDay: number | null;
  amountToBeInvested: number | null;
};

const CONSOLE_PROFILE_ID = "bullpen_console_top10";
const DEFAULT_CONSOLE_ORDER_USD = 5;
const CONSOLE_MAX_ACTIVE_POSITIONS =
  DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MAX_POSITIONS;
const DEFAULT_LLM_EXECUTION_MODE: BullpenLlmExecutionMode = "chunked_parallel";
const DEFAULT_LLM_EVENTS_PER_PROMPT = 20;
// The summary already includes the recent runs and decisions. Refreshing it at
// this cadence keeps run progress visible without saturating the backend while
// a long-running Auto-Live task is active.

function buildScanCandidateReturnsPerDayQuestion(
  candidate: ScanCandidateDialogCandidate,
): BullpenQuestionRow {
  return {
    question: candidate.question,
    yesOdds: candidate.currentYesOdds,
    noOdds: candidate.currentNoOdds,
    llmYesOdds: candidate.llmYesOdds,
    llmNoOdds: candidate.llmNoOdds,
    daysUntilClose: calculateDaysUntilClose(candidate.closeTime),
    returnsPerDay: candidate.returnsPerDay,
  } as BullpenQuestionRow;
}

const POLL_INTERVAL_MS = 2_000;
// The run summary refreshes quickly while a run is active. Updating this very large
// card every second only changes elapsed labels, so a five-second cadence
// avoids needless whole-card renders while retaining useful timing feedback.
const RUN_TIMER_INTERVAL_MS = 5_000;
const AUTO_RUN_STATUS_TIMEOUT_MS = 2_000;
const AUTO_RUN_AUTH_BOOTSTRAP_TIMEOUT_MS = 5_000;
const AUTO_RUN_STATUS_IDLE_REVALIDATE_MS = 60_000;
const AUTO_RUN_STATUS_MAX_AUTOMATIC_RETRIES = 3;

function markBullpenAutoRunPerformance(name: string) {
  if (typeof performance === "undefined") return;
  if (performance.getEntriesByName(name, "mark").length > 0) return;
  performance.mark(name);
}

// React Strict Mode may mount this card twice in development. Keep one
// resource-level request for the lightweight endpoint so that neither a
// remount nor a manual retry fans out duplicate status reads.
const persistedAutoRunStatusRequestDedupers = new Map<
  string,
  ReturnType<
    typeof createAbortableBullpenAutoRunRequestDeduper<BullpenAutoRunStatusData>
  >
>();

function getPersistedAutoRunStatus(scope: string, signal: AbortSignal) {
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

function isRequestAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function readBrowserCachedAutoRunStatus(cacheKey: string | null) {
  if (typeof window === "undefined" || !cacheKey) return null;
  return readCachedBullpenAutoRunStatus(window.sessionStorage, {}, cacheKey);
}

function saveBrowserCachedAutoRunStatus(
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

function formatIstScheduleSummaryDate(value: string) {
  const normalized = value.replace(",", "").trim();
  const match = normalized.match(
    /^(\d{2}:\d{2}:\d{2})\s+(\d{1,2})\s+([A-Za-z]+)(?:\s+\d{4})?$/,
  );
  if (match) {
    return `${match[1]}, ${match[2].padStart(2, "0")} ${match[3]}`;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    day: "2-digit",
    month: "long",
    hour12: false,
  })
    .format(parsed)
    .replace(",", "");
}

function formatScheduleInputFromDate(date: Date) {
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

function formatDateTimeLocalValue(date: Date) {
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

function parseScheduleInputToDateTimeLocalValue(value: string) {
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

function formatScheduleInputFromDateTimeLocal(value: string) {
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

function buildScheduleSummary(startInput: string, refreshInput: string) {
  const refreshMinutes = Number.parseInt(refreshInput, 10);
  if (!Number.isFinite(refreshMinutes) || refreshMinutes < 1) return null;
  const startLabel =
    startInput.trim().toLowerCase() === "now"
      ? "Now"
      : formatIstScheduleSummaryDate(startInput.trim());
  if (!startInput.trim()) return null;
  return `Auto Runs Started${startLabel === "Now" ? "" : " at"} ${startLabel} and refreshes every ${refreshMinutes} minutes`;
}

function normalizeError(error: unknown) {
  if (error instanceof APIError) {
    const { statusText, message, details } = splitApiErrorSummary(error);
    return {
      message,
      details: [statusText, details].filter(Boolean).join(" • ") || null,
    } satisfies ErrorState;
  }

  return {
    message: formatUnknownError(error),
    details: null,
  } satisfies ErrorState;
}

function formatIstDateTime(value: string | null | undefined) {
  return formatApiTimestamp(value, {
    emptyValue: "—",
    timeZone: "Asia/Kolkata",
    timeZoneName: "short",
    second: "2-digit",
  });
}

function formatOddsPercent(value: number | null) {
  if (value === null) return "—";
  return `${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`;
}

function formatOddsPair(yesOdds: number | null, noOdds: number | null) {
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

function getLlmOddsHighlightClass(value: number | null) {
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

function formatReturnsPerDay(value: number | null) {
  if (value === null) return "—";
  return `${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`;
}

function formatMoney(value: number | null) {
  if (value === null) return "—";
  return `$${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function formatUsdCost(value: number | null) {
  if (value === null) return "—";
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })}`;
}

function formatInvestAmount(value: number | null) {
  if (value === null) return "—";
  return value.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

type ConsoleTradeAmountView = {
  tradeAmountUsd: number | null;
  cashInHandUsd: number | null;
  activePositions: number | null;
  availableSlots: number | null;
  maxPositions: number;
  source: "live" | "last-calculated" | "unavailable";
};

function calculateConsoleTradeAmountUsd(
  cashInHandUsd: number,
  availableSlots: number,
) {
  if (cashInHandUsd <= 0 || availableSlots <= 0) return 0;
  return Number((cashInHandUsd / availableSlots).toFixed(2));
}

function buildConsoleTradeAmountView({
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

function parseLlmEventsPerPrompt(value: string) {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
    return null;
  }
  return parsed;
}

function buildLlmExecutionSummary(
  mode: BullpenLlmExecutionMode,
  eventsPerPrompt: number,
) {
  if (mode === "single_combined") {
    return "Stage 2 will use Single combined mode on the next run.";
  }
  return `Stage 2 will use Batched parallel with up to ${eventsPerPrompt} events per prompt on the next run.`;
}

function areProviderTargetsEqual(
  left: ProviderModelTarget[],
  right: ProviderModelTarget[],
) {
  if (left.length !== right.length) return false;
  return left.every((target, index) => {
    const other = right[index];
    return other?.provider === target.provider && other?.model === target.model;
  });
}

function serializeProviderTargets(targets: ProviderModelTarget[]) {
  return JSON.stringify(
    targets.map((target) => ({
      provider: target.provider,
      model: target.model,
    })),
  );
}

function normalizeStoredProviderTarget(
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

function readLegacyBullpenLlmTargetsFromStorage() {
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

function resolveCanonicalStage2TargetSelection(
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

function missingStage2TargetsError(): ErrorState {
  return {
    message:
      "Select at least one LLM before starting Auto-Live Stage 2. The saved target list is empty.",
    details: null,
  };
}

function formatPriceCents(value: number | null) {
  if (value === null) return "—";
  return `${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}c`;
}

function formatShares(value: number | null) {
  if (value === null) return "—";
  return value.toLocaleString("en-IN", { maximumFractionDigits: 6 });
}

function readStageOutputNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

type WorkflowStageView = ReturnType<
  typeof buildBullpenAutoRunWorkflowView
>["stages"][number];

function isWorkflowActivePosition(position: WorkflowStageView["activePositionsFound"][number]) {
  return !position.isClaimable && (position.classification === null || position.classification === "active");
}

function getStageActivePositionCounts(stage: WorkflowStageView) {
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

function getStageOneStats(stage: WorkflowStageView) {
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

function getStageTwoStats(
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

function buildStageTwoInvestEventsDialogState({
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
  const reviewedRows = getHistoricalStageTwoLlmReviewedRows(
    llmWorkflowStage,
    scanWorkflowStage?.scanCandidates ?? [],
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

function getStageTwoLlmOutcomeCounts(
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

function getStageTwoCompletedLlmCount(stage: WorkflowStageView) {
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

function formatStageTwoInvestExecutionStatus(decision: BullpenAutoLiveDecision) {
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

function getStageTwoInvestExecutionTone(
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

function formatStage2TopTenHandoffOutcome(row: BullpenStage2TopTenHandoffRow) {
  if (row.missingFromStage3) return "Missing from Stage 3";
  return row.displayDecision.stage3_result?.replaceAll("_", " ") ?? "Pending";
}

function buildStage2TopTenEventsSummaryRows(
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

function Stage2TopTenEventsSummaryTable({
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
function StageOneRunStats({
  stage,
  hideNumbers = false,
  renderInteractiveRows = false,
  onOpenScanCandidateDialog,
  onOpenScanFilters,
}: {
  stage: WorkflowStageView;
  hideNumbers?: boolean;
  renderInteractiveRows?: boolean;
  onOpenScanCandidateDialog?: (
    stage: WorkflowStageView,
    mode: ScanCandidateDialogMode,
  ) => void;
  onOpenScanFilters?: () => void;
}) {
  const stats = getStageOneStats(stage);
  const displayStat = (value: number) => (hideNumbers ? "—" : value);
  const rowClassName = renderInteractiveRows
    ? "block text-left underline-offset-2 transition hover:underline focus:outline-none focus:ring-2 focus:ring-emerald-300"
    : undefined;

  return (
    <div className="space-y-0.5">
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
      {renderInteractiveRows && onOpenScanCandidateDialog ? (
        <button
          type="button"
          onClick={() => onOpenScanCandidateDialog(stage, "all-scanned")}
          className={`${rowClassName} pt-2`}
        >
          Total Events Scanned:{" "}
          <span className="font-semibold tabular-nums">
            {displayStat(stats.totalScanned)}
          </span>
        </button>
      ) : (
        <div className="pt-2">
          Total Events Scanned:{" "}
          <span className="font-semibold tabular-nums">
            {displayStat(stats.totalScanned)}
          </span>
        </div>
      )}
      {renderInteractiveRows && onOpenScanCandidateDialog ? (
        <div className="flex items-center justify-between gap-2">
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
          <span>
            Events that passed Filters:{" "}
            <span className="font-semibold tabular-nums">
              {displayStat(stats.passedFilters)}
            </span>
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

function StageTwoRunStats({
  run,
  stage,
  hideNumbers = false,
  decisions = [],
  onOpenInvestEvents,
  onOpenLlmRunDetails,
  onOpenScanCandidateDialog,
  scanStageForPositionSnapshot,
}: {
  run: BullpenAutoLiveRun | null;
  stage: WorkflowStageView;
  hideNumbers?: boolean;
  decisions?: BullpenAutoLiveDecision[];
  scanStageForPositionSnapshot?: WorkflowStageView;
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
        activePositions: positionDialogStage.activePositionsFound,
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

function readStageOutputString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readStageOutputBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return false;
}

function readStageOutputStringList(value: unknown) {
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

type StageTwoActionableDisplayContract = {
  hasDisplayCounts: boolean;
  hasExactMarketIds: boolean;
  exitMarketIds: string[];
  buyMarketIds: string[];
  exitCount: number | null;
  buyCount: number | null;
};

function readStageTwoActionableDisplayContract(
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeMatchKey(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function getStageTwoSummaryRowMatchKeys(row: BullpenQuestionRow) {
  return [row.marketId, row.slug, row.marketUrl, row.question]
    .map((key) => normalizeMatchKey(key))
    .filter((key): key is string => Boolean(key));
}

function getStageTwoActivePositionMatchKeys(
  position: WorkflowStageView["activePositionsFound"][number],
) {
  return [position.marketId, position.slug, position.marketUrl, position.marketTitle]
    .map((key) => normalizeMatchKey(key))
    .filter((key): key is string => Boolean(key));
}

function buildStageTwoActivePositionKeySet(stage: WorkflowStageView) {
  return new Set(
    stage.activePositionsFound.flatMap((position) =>
      getStageTwoActivePositionMatchKeys(position),
    ),
  );
}

function getStageTwoDecisionForSummaryRow(
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

function buildStageTwoEventsSummaryHighlightById({
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
function findRunStage(
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

function resolveStage2To3StrategyDialogOutputs(
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

function calculateDaysUntilClose(closeTime: string | null) {
  if (!closeTime) return null;
  const closeDate = new Date(closeTime);
  if (Number.isNaN(closeDate.getTime())) return null;
  return Number(
    ((closeDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000)).toFixed(1),
  );
}

function buildScanCandidateDialogRows({
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

function isInvestMetricDecisionRow(
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

function readInvestStageDecisionRows(
  stage:
    | ReturnType<typeof buildBullpenAutoRunWorkflowView>["stages"][number]
    | null,
) {
  if (!stage || stage.key !== "invest") return [];
  const rawDecisionRows = stage.outputs.decision_rows;
  if (!Array.isArray(rawDecisionRows)) return [];
  return rawDecisionRows.filter(isInvestMetricDecisionRow);
}

function mergeInvestStageDecisionRows({
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

function readDecisionExecutionTimestamp(decision: BullpenAutoLiveDecision) {
  return (
    decision.order_plan?.executed_at?.trim() ||
    decision.updated_at?.trim() ||
    decision.created_at?.trim() ||
    null
  );
}

type RunSummaryWarning = { label: string; detail: string };
type RunSummaryDetails = {
  overview: string | null;
  warnings: RunSummaryWarning[];
};
type PlannedOrderDetailState = {
  title: string;
  summary: string;
  detail: string;
};
type DecisionLlmOddsState = { decision: BullpenAutoLiveDecision };

function getRunSummaryDetails(
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

function buildLatestSubmittedBuyTimestampsByMarketId(
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

function buildLiveAlreadyInvestedRecords({
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

function findGuardrailCheck(
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

function getInvestStageMetric(
  stage:
    | ReturnType<typeof buildBullpenAutoRunWorkflowView>["stages"][number]
    | null,
  key: string,
  fallback: number,
) {
  if (!stage || stage.key !== "invest") return fallback;
  return readStageOutputNumber(stage.outputs[key]) ?? fallback;
}

function usesPersistedStage3ExecutionCounters(
  outputs: Record<string, unknown> | null | undefined,
) {
  if (!outputs) return false;
  const counters = outputs.persisted_execution_counters;
  return (
    isRecord(counters) &&
    readStageOutputString(counters.source) === "persisted_order_intents"
  );
}

type InvestExecutionStepView = {
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

function normalizeInvestExecutionStepStatus(
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

function getSubmittedSellSubpartCounts(decisions: BullpenAutoLiveDecision[]) {
  const counts = summarizeInvestStepCountsFromDecisions("sell", decisions);

  return {
    redeem: counts.redeemSubmittedOrders ?? 0,
    rankingOrLlm: counts.rankingLlmSubmittedOrders ?? 0,
    forced: counts.forcedExitSubmittedOrders ?? 0,
  };
}

function getInvestStageExecutionSteps(
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
     …89552 tokens truncated…ExecutionPlan(
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
  const openScanCandidateDialog = (
    stage: ReturnType<typeof buildBullpenAutoRunWorkflowView>["stages"][number],
    mode: ScanCandidateDialogMode,
  ) => {
    const activePositionCounts = getStageActivePositionCounts(stage);
    const stageOneStats = getStageOneStats(stage);
    const rejectedFilterCount =
      readStageOutputNumber(stage.outputs.rejected_candidates_count) ??
      (Array.isArray(stage.outputs.rejected_candidates)
        ? stage.outputs.rejected_candidates.length
        : null);
    const detailedRows =
      mode === "all-scanned" ? stage.scannedCandidates : stage.scanCandidates;
    const emptyRowsReason = detailedRows.length > 0
      ? null
      : stage.state === "current"
        ? "Stage 1 has reported its scan total, but the detailed rows have not been published yet. This dialog updates after the run refreshes."
        : stageOneStats.totalScanned > 0
          ? "This saved run retained aggregate scan counts only. Individual event names and per-event filter reasons cannot be reconstructed from those counts."
          : "No events were returned by the Stage 1 scan, so there are no event rows or per-event filter reasons to display.";
    setScanCandidateDialog({
      mode,
      scanCompletedAt: stage.timerCompletedAt,
      totalScanned: stageOneStats.totalScanned,
      passedFilterCount: stageOneStats.passedFilters,
      rejectedFilterCount,
      emptyRowsReason,
      candidates: buildScanCandidateDialogRows({
        candidates: detailedRows,
        run: workflowRunForMonitor,
        decisions: summary?.recent_decisions ?? [],
      }),
      activePositions: stage.activePositionsFound,
      activePositionCount: activePositionCounts.open,
      claimablePositionCount: activePositionCounts.claimable,
    });
  };
  const liveWorkflowSettled = isBullpenAutoRunWorkflowSettled(liveWorkflowView);
  const hasActiveWorkflowStage = liveWorkflowView.stages.some(
    (stage) =>
      isActivelyWorkingRunStatus(workflowRun?.status) && stage.isCurrent,
  );
  const runActionRequested = action === "invest-now";
  const startNowActionRequested = action === "start-now";
  const runIsActive =
    !liveWorkflowSettled &&
    (runActionRequested ||
      startNowActionRequested ||
      pendingRunId !== null ||
      isActivelyWorkingRunStatus(visibleRun?.status) ||
      hasActiveWorkflowStage);
  const latestTerminalRun =
    summary?.latest_run && !isActivelyWorkingRunStatus(summary.latest_run.status)
      ? summary.latest_run
      : summary?.recent_runs.find(
          (run) => !isActivelyWorkingRunStatus(run.status),
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
  const shouldTickTimers = showRunTimer || hasActiveWorkflowStage;
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
  const workflowStatusCopy = workflowView.statusCopy;
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
        setAction(null);
      }
    });
  }, [action, pendingRunId, runNowStartedAt, workflowSettled]);

  return (
    <Card className="border-fuchsia-200 bg-[linear-gradient(135deg,rgba(253,242,248,0.98),rgba(239,246,255,0.98))] shadow-sm dark:border-fuchsia-500/30 dark:bg-[linear-gradient(135deg,rgba(91,33,182,0.24),rgba(15,23,42,0.94),rgba(14,165,233,0.16))]">
      <CardContent className="space-y-4 p-5">
        <BullpenPortfolioSnapshot
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
        <div className="flex items-start justify-between gap-4">
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

          <div className="flex shrink-0 flex-wrap justify-end gap-2">
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
            <Button type="button" variant="outline" onClick={() => window.open("/console/bullpen-ai/history", "_blank", "noopener,noreferrer")} aria-label="Open Bullpen History in new window" title="Open in new window" className="-ml-2 rounded-l-none border-l border-l-slate-900/20 border-[#f4d458] bg-[#f4d458] px-3 text-slate-950 hover:bg-[#e7c845]"><ExternalLink className="h-4 w-4" /></Button>

            <Button
              type="button"
              variant="outline"
              onClick={handleStartAutoRunNow}
              disabled={action !== null}
              className="border-emerald-200 bg-emerald-50 text-emerald-700 hover:border-emerald-300 hover:bg-emerald-100 hover:text-emerald-800 disabled:opacity-60"
            >
              {action === "start-now" ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Starting...
                </>
              ) : (
                <>
                  <Zap className="mr-2 h-4 w-4" />
                  Start Auto Run Now
                </>
              )}
            </Button>
            {autoRunActive ? (
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
            {optimisticSchedulerState ? (
              <div
                className="basis-full rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-semibold leading-5 text-sky-900 shadow-sm"
                aria-live="polite"
              >
                <span className="inline-flex items-center gap-2">
                  <Loader2
                    className="h-3.5 w-3.5 animate-spin"
                    aria-hidden="true"
                  />
                  {optimisticSchedulerState.message}
                </span>
              </div>
            ) : null}
            {startNowProgress ? (
              <div
                className="basis-full rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold leading-5 text-emerald-900 shadow-sm"
                aria-live="polite"
              >
                <span className="inline-flex items-center gap-2">
                  <Loader2
                    className="h-3.5 w-3.5 animate-spin"
                    aria-hidden="true"
                  />
                  {startNowProgress}
                </span>
              </div>
            ) : null}
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

        {showActiveRunControls ? (
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

        {scheduleSavedSummary ? (
          <div className="rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm font-semibold text-blue-950">
            {scheduleSavedSummary}
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
                {latestTerminalRunOverview || "No auto-run result yet."}
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
                : "Not active yet"}
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
            {workflowView.stages.map((stage) => {
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
              const toneClasses = getWorkflowToneClasses(
                selectedRunSummaryTile === "next" && !runIsActive
                  ? "slate"
                  : immediateSuccess || investPreviewFinished || stage.state === "finished" || Boolean(stage.timerCompletedAt)
                    ? "green"
                    : stage.tone,
              );
              const showStageRunDetails = true;
              const showStageNumbers = workflowRunForMonitor !== null;
              const stageStatusLabel = immediateSuccess
                ? "Finished"
                : investPreviewFinished
                  ? "Finished"
                  : stage.state === "current"
                    ? "Working"
                    : stage.state === "finished"
                      ? "Finished"
                      : "In Queue";
              const stageProgressPercent =
                immediateSuccess || investPreviewFinished
                  ? 100
                  : stage.progressPercent;
              const stageProgressLabel =
                investPreviewFinished && stage.key === "invest"
                  ? "Finished"
                  : stage.progressLabel;
              const showStageSpinner =
                stage.isCurrent && !immediateSuccess && !investPreviewFinished;
              const stageTwoBypassed =
                stage.key === "llm" &&
                stage.state === "queued" &&
                workflowView.stages.some(
                  (item) => item.key === "invest" && item.state === "current",
                );

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
                  <div className="flex items-start justify-between gap-3">
                    <div
                      className={`space-y-1 ${canOpenInputs ? "pl-12" : ""}`}
                    >
                      <div className="flex items-center gap-2">
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
                        <p className={`text-xs leading-5 ${toneClasses.muted}`}>
                          {stage.subtitle}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex flex-col items-end gap-2">
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
                        {formatStageElapsedTime(
                          stage.timerStartedAt,
                          stage.timerCompletedAt,
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
                            timerNowMs,
                          )}
                        </span>
                      </div>
                      {stage.key === "scan" ? (
                        <StageOneRunStats
                          stage={stage}
                          hideNumbers={!showStageNumbers}
                          renderInteractiveRows
                          onOpenScanCandidateDialog={openScanCandidateDialog}
                          onOpenScanFilters={onOpenScanFilters}
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
                      className={`h-full rounded-full ${toneClasses.progress}`}
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
              <BullpenRunHistoryContent page={visibleRunHistoryPage} trends={visibleRunHistoryEventTrends} loading={runHistoryLoading} trendsLoading={runHistoryEventTrendsLoading} error={runHistoryError} trendsError={runHistoryEventTrendsError} detailLoadingId={runHistoryDetailLoadingId} onRefresh={() => void loadRunHistory()} onPage={(page) => void loadRunHistory(page)} onOpenRun={(run) => void openHistoryRunDetail(run)} onClose={closeRunHistoryDialog} />
            </div>
          </div>
        ) : null}

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
          />
        ) : null}

        {runDetailDialog ? (
          <RunDetailDialog
            state={runDetailDialog}
            onClose={closeRunDetailDialog}
            onOpenScanFilters={onOpenScanFilters}
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

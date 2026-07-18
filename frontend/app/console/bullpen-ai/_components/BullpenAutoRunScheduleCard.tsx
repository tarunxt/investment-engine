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
import {
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock3,
  Copy,
  History,
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
import {
  BullpenEventIdentityResolver,
  buildBullpenEventIdentityFromDecision,
  buildBullpenEventIdentityFromPosition,
} from "@/lib/bullpenEventIdentityResolver";
import type { BullpenActivePositionView } from "@/lib/bullpenPositions";
import { formatUnknownError, splitApiErrorSummary } from "@/lib/apiErrors";
import { APIError, apiService } from "@/services/api";
import type {
  BullpenAutoLiveDecision,
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
import { BullpenStage2To3StrategyDialog } from "./BullpenStage2To3StrategyDialog";
import {
  buildBullpenStage3InvestPreviewSteps,
  buildBullpenStage3OnlyInvestExecutionPlan,
  NO_STAGE2_QUALIFIED_EVENTS_REASON,
  type BullpenStage3AlreadyInvestedRecord,
  selectBullpenStage3OnlyInvestSource,
} from "./bullpenAutoRunStage3Invest";
import {
  deriveInvestExecutionStepStatus,
  getInvestMetricDialogDefinition,
  getInvestMetricRows,
  getInvestStepMetricDialogKind,
  getSellInvestMetricDialogKind,
  isProcessedInvestOrderPlan,
  type InvestExecutionStepStatus,
  type InvestMetricDialogKind,
} from "./bullpenAutoRunInvestMetrics";
import { getInvestStageImmediateSuccess } from "./bullpenAutoRunStageStatus";
import { BullpenEventExitStrategiesDialog } from "./BullpenEventExitStrategiesDialog";
import { BullpenEventHistoricalAssessmentTable } from "./BullpenEventHistoricalAssessmentTable";
import { BullpenAutoRunStageOutputDialog } from "./BullpenAutoRunStageOutputDialog";
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

const BULLPEN_LOGIN_COMMAND =
  "sudo -u investor env HOME=/var/lib/credx/bullpen BULLPEN_BIN=/usr/local/bin/bullpen /usr/local/bin/bullpen login --no-browser";
const BULLPEN_LAST_LLM_TARGET_STORAGE_KEY =
  "investment-engine:bullpen-ai:last-llm-target:v1";

type BullpenAutoRunScheduleCardProps = {
  onRunCompleted?: () => void | Promise<void>;
  buildRunNowRequest?: () =>
    | Promise<BullpenAutoLiveRunOnceRequest | null>
    | BullpenAutoLiveRunOnceRequest
    | null;
  activePositions?: BullpenActivePositionView[];
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
  | "balance"
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

type ScanCandidateDialogMode = "fresh-opportunities" | "active-positions";

type RunDetailDialogState = {
  run: BullpenAutoLiveRun;
  decisions: BullpenAutoLiveDecision[];
};

type StageTwoInvestEventsDialogState = {
  rows: BullpenStage2TopTenHandoffRow[];
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

  const request =
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
            candidate_rows: [],
          },
        }
      : null);

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
const POLL_INTERVAL_MS = 10_000;
const RUN_TIMER_INTERVAL_MS = 1_000;

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

function getStageActivePositionCounts(stage: WorkflowStageView) {
  const claimableFromSnapshot = stage.activePositionsFound.filter(
    (position) => position.isClaimable,
  ).length;
  const openFromSnapshot = stage.activePositionsFound.filter(
    (position) => !position.isClaimable,
  ).length;

  return {
    open: openFromSnapshot,
    claimable: claimableFromSnapshot,
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
  const newOpportunities =
    readStageOutputNumber(stage.outputs.stage1_accepted_candidate_count) ??
    readStageOutputNumber(stage.outputs.candidate_rows_before_llm) ??
    readStageOutputNumber(stage.inputs.candidate_rows_before_llm) ??
    stage.scanCandidates.length;
  const llmRanOn =
    readStageOutputNumber(stage.outputs.llm_candidate_count) ??
    readStageOutputNumber(stage.outputs.total_items) ??
    activePositions + newOpportunities;

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
  const stage2TopTenHandoffCount = run
    ? buildBullpenStage2TopTenHandoffRows({ run, decisions }).length
    : 0;
  const newEventsToInvestIn =
    stage2TopTenHandoffCount > 0
      ? stage2TopTenHandoffCount
      : getStageTwoInvestableDecisions(decisions).length;

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

function getStageTwoInvestableDecisions(decisions: BullpenAutoLiveDecision[]) {
  return [...decisions]
    .filter((decision) => {
      const orderPlan = decision.order_plan;
      if (orderPlan) {
        return orderPlan.action === "buy" && orderPlan.status !== "cancelled";
      }
      if (decision.decision === "BUY_NEW") {
        return true;
      }
      return (
        decision.decision === "ADD_MORE" &&
        decision.risk_status !== "Blocked" &&
        decision.target_exposure_usd > decision.current_exposure_usd
      );
    })
    .sort((left, right) => {
      const leftRank = left.stage3_final_rank ?? Number.POSITIVE_INFINITY;
      const rightRank = right.stage3_final_rank ?? Number.POSITIVE_INFINITY;
      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }
      return left.market_title.localeCompare(right.market_title);
    });
}

function formatStageTwoInvestExecutionStatus(decision: BullpenAutoLiveDecision) {
  if (decision.order_plan?.action === "buy") {
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
  if (
    status === "submitted" ||
    status === "confirming" ||
    status === "partially_filled" ||
    status === "settlement_pending" ||
    status === "confirmed" ||
    status === "filled"
  ) {
    return "success";
  }
  if (
    status === "failed" ||
    status === "failed_permanent" ||
    status === "cancelled" ||
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
              <p className="font-semibold text-slate-950">No order planned</p>
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
                title={decision.order_plan.detail}
              >
                {decision.order_plan.detail}
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
      <div className="pt-2">
        Total Events Scanned:{" "}
        <span className="font-semibold tabular-nums">
          {displayStat(stats.totalScanned)}
        </span>
      </div>
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
  onOpenInvestEvents?: (rows: BullpenStage2TopTenHandoffRow[]) => void;
  onOpenLlmRunDetails?: (state: StageTwoLlmRunDialogState) => void;
  onOpenScanCandidateDialog?: (
    stage: WorkflowStageView,
    mode: ScanCandidateDialogMode,
  ) => void;
}) {
  const stage2TopTenHandoffRows = run
    ? buildBullpenStage2TopTenHandoffRows({ run, decisions })
    : [];
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
        {onOpenInvestEvents && stage2TopTenHandoffRows.length > 0 ? (
          <button
            type="button"
            onClick={() => onOpenInvestEvents(stage2TopTenHandoffRows)}
            className="text-left font-medium text-emerald-800 underline-offset-2 transition hover:underline focus:outline-none focus:ring-2 focus:ring-emerald-300"
            aria-label={`Open details for ${displayStat(stats.newEventsToInvestIn)} new events to invest in`}
          >
            New Events to Invest in:{" "}
            <span className="font-semibold tabular-nums">
              {displayStat(stats.newEventsToInvestIn)}
            </span>
          </button>
        ) : (
          <>
            New Events to Invest in:{" "}
            <span className="font-semibold tabular-nums">
              {displayStat(stats.newEventsToInvestIn)}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function readStageOutputString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeMatchKey(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
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

function isSubmittedOrSuccessfulOrderPlan(
  orderPlan: BullpenAutoLiveDecision["order_plan"],
) {
  if (!orderPlan) return false;
  const status = orderPlan.status?.trim().toLowerCase();
  if (status === "submitted" || status === "confirmed") return true;

  const detail = orderPlan.detail?.trim() ?? "";
  const response = orderPlan.execution_response?.trim() ?? "";
  const successText = `${detail}\n${response}`;
  return (
    /successfully|submitted|filled|redeemed|claimed|executed/i.test(
      successText,
    ) &&
    !/failed|refusing|cancelled|canceled|skipped|not submitted/i.test(
      successText,
    )
  );
}

function isSubmittedOrSuccessfulDecision(decision: BullpenAutoLiveDecision) {
  return isSubmittedOrSuccessfulOrderPlan(decision.order_plan);
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
      decision.order_plan?.status !== "submitted" ||
      decision.order_plan.action !== "buy"
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
    if (position.isClaimable) {
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
  const submittedSellDecisions = decisions.filter((decision) => {
    const action = decision.order_plan?.action;
    return (
      (action === "sell" || action === "redeem") &&
      isSubmittedOrSuccessfulDecision(decision)
    );
  });

  const hasStrategy = (
    decision: BullpenAutoLiveDecision,
    strategies: Set<string>,
  ) => decision.exit_signals.some((signal) => strategies.has(signal.strategy));

  const rankingOrLlmStrategies = new Set([
    "OUTSIDE_TOP_10_RETURNS_DAY",
    "LLM_OR_ODDS_FILTER_EXIT",
  ]);
  const forcedExitStrategies = new Set(["CAPITAL_AWARE_FORCED_EXIT"]);
  const redeemStrategies = new Set(["REDEEM_CLAIM"]);

  return {
    redeem: submittedSellDecisions.filter(
      (decision) =>
        decision.order_plan?.action === "redeem" ||
        hasStrategy(decision, redeemStrategies),
    ).length,
    rankingOrLlm: submittedSellDecisions.filter((decision) =>
      hasStrategy(decision, rankingOrLlmStrategies),
    ).length,
    forced: submittedSellDecisions.filter((decision) =>
      hasStrategy(decision, forcedExitStrategies),
    ).length,
  };
}

function getInvestStageExecutionSteps(
  stage: ReturnType<typeof buildBullpenAutoRunWorkflowView>["stages"][number],
  decisions: BullpenAutoLiveDecision[] = [],
) {
  if (stage.key !== "invest") return [];

  const submittedSellSubpartCounts = getSubmittedSellSubpartCounts(decisions);
  const hasDecisionRows = decisions.length > 0;

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

      const plannedOrders = readStageOutputNumber(step.planned_orders) ?? 0;
      const processedOrders = readStageOutputNumber(step.processed_orders) ?? 0;

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
        submittedOrders: readStageOutputNumber(step.submitted_orders) ?? 0,
        eventExitRows: readStageOutputNumber(step.event_exit_rows),
        rankingLlmPlannedOrders: readStageOutputNumber(
          step.ranking_llm_planned_orders,
        ),
        forcedExitPlannedOrders: readStageOutputNumber(
          step.forced_exit_planned_orders,
        ),
        redeemPlannedOrders: readStageOutputNumber(step.redeem_planned_orders),
        redeemProcessedOrders: readStageOutputNumber(
          step.redeem_processed_orders,
        ),
        redeemSubmittedOrders: hasDecisionRows
          ? submittedSellSubpartCounts.redeem
          : readStageOutputNumber(step.redeem_submitted_orders),
        rankingLlmSubmittedOrders: hasDecisionRows
          ? submittedSellSubpartCounts.rankingOrLlm
          : readStageOutputNumber(step.ranking_llm_submitted_orders),
        forcedExitSubmittedOrders: hasDecisionRows
          ? submittedSellSubpartCounts.forced
          : readStageOutputNumber(step.forced_exit_submitted_orders),
      };
    })
    .filter((step): step is InvestExecutionStepView => step !== null);
}

function getLastInvestExecutionStep(
  run: BullpenAutoLiveRun | null,
  key: "sell" | "buy",
) {
  const investStage = run?.stage_results.find(
    (stage) => stage.stage_number === 3 || stage.stage_name === "invest",
  );
  const rawSteps = investStage?.outputs.execution_steps;
  if (!Array.isArray(rawSteps)) return null;

  for (const rawStep of rawSteps) {
    if (!isRecord(rawStep) || readStageOutputString(rawStep.key) !== key) {
      continue;
    }

    return {
      plannedOrders: readStageOutputNumber(rawStep.planned_orders) ?? 0,
      processedOrders: readStageOutputNumber(rawStep.processed_orders) ?? 0,
      submittedOrders: readStageOutputNumber(rawStep.submitted_orders) ?? 0,
      eventExitRows: readStageOutputNumber(rawStep.event_exit_rows),
      rankingLlmPlannedOrders: readStageOutputNumber(
        rawStep.ranking_llm_planned_orders,
      ),
      forcedExitPlannedOrders: readStageOutputNumber(
        rawStep.forced_exit_planned_orders,
      ),
      redeemPlannedOrders: readStageOutputNumber(rawStep.redeem_planned_orders),
      redeemProcessedOrders: readStageOutputNumber(
        rawStep.redeem_processed_orders,
      ),
      redeemSubmittedOrders: readStageOutputNumber(
        rawStep.redeem_submitted_orders,
      ),
      rankingLlmSubmittedOrders: readStageOutputNumber(
        rawStep.ranking_llm_submitted_orders,
      ),
      forcedExitSubmittedOrders: readStageOutputNumber(
        rawStep.forced_exit_submitted_orders,
      ),
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

function buildQueuedInvestPreviewSteps(
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

function getInvestExecutionStepClasses(status: InvestExecutionStepStatus) {
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

function extractErrorCodeFromDetail(detail: string | null | undefined) {
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

function ErrorCodeWithDetails({
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

function getInvestExecutionStepStatusLabel(status: InvestExecutionStepStatus) {
  if (status === "completed") return "Finished";
  if (status === "blocked") return "Blocked";
  if (status === "running") return "Working";
  return "Pending";
}

function getInvestStageCounters(
  stage: ReturnType<typeof buildBullpenAutoRunWorkflowView>["stages"][number],
) {
  if (stage.key !== "invest") return [];

  const planned = readStageOutputNumber(stage.outputs.orders_planned);
  const submitted = readStageOutputNumber(stage.outputs.orders_submitted);
  if (planned === null && submitted === null) {
    return [];
  }

  return [
    { label: "Planned", value: planned ?? 0 },
    { label: "Submitted", value: submitted ?? 0 },
  ];
}

type InvestProgressLogEntry = {
  tone: "info" | "warning" | "error" | "success";
  label: string;
  detail: string;
};

function getInvestProgressLogEntries({
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

function InvestExecutionStepsSummary({
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

function StageOneOutputDialog({
  state,
  onClose,
}: {
  state: ScanCandidateDialogState;
  onClose: () => void;
}) {
  const showActivePositionsFirst = state.mode === "active-positions";
  const claimablePositions = state.activePositions.filter(
    (position) => position.isClaimable,
  );
  const activePositions = state.activePositions.filter(
    (position) => !position.isClaimable,
  );
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
                : `Fresh Bullpen Opportunities (${state.candidates.length})`}
            </h2>
            <p className="text-sm text-slate-600">
              Latest Bullpen Scan Stage 1 completed at{" "}
              {formatIstDateTime(state.scanCompletedAt)}.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close Stage 1 output"
          >
            <X className="h-4 w-4" />
          </button>
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
                {state.candidates.length}
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
                          <td className="px-4 py-3 align-top">
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
                            <div className="mt-1 flex flex-wrap gap-2 text-xs text-slate-500">
                              {position.theme ? (
                                <span>{position.theme}</span>
                              ) : null}
                              {position.conditionId ? (
                                <span>{position.conditionId}</span>
                              ) : null}
                            </div>
                          </td>
                          <td className="px-4 py-3 align-top text-slate-700">
                            {position.side ?? "—"}
                            <br />
                            Shares {formatShares(position.shares)}
                            <br />
                            Exposure {formatMoney(position.exposureUsd)}
                            <br />
                            Avg {formatPriceCents(position.averagePriceCents)}
                          </td>
                          <td className="px-4 py-3 align-top text-slate-700">
                            Yes {formatOddsPercent(position.currentYesOdds)}
                            <br />
                            No {formatOddsPercent(position.currentNoOdds)}
                          </td>
                          <td className="px-4 py-3 align-top text-slate-700">
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
                <div className="overflow-hidden rounded-2xl border border-slate-200">
                  <table className="min-w-full divide-y divide-slate-200 text-sm">
                    <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                      <tr>
                        <th className="px-4 py-3">Position</th>
                        <th className="px-4 py-3">Side & size</th>
                        <th className="px-4 py-3">Odds</th>
                        <th className="px-4 py-3">Close time</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 bg-white">
                      {activePositions.map((position) => (
                        <tr key={position.positionKey}>
                          <td className="px-4 py-3 align-top">
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
                            <div className="mt-1 flex flex-wrap gap-2 text-xs text-slate-500">
                              {position.theme ? (
                                <span>{position.theme}</span>
                              ) : null}
                              {position.conditionId ? (
                                <span>{position.conditionId}</span>
                              ) : null}
                            </div>
                          </td>
                          <td className="px-4 py-3 align-top text-slate-700">
                            {position.side ?? "—"}
                            <br />
                            Shares {formatShares(position.shares)}
                            <br />
                            Exposure {formatMoney(position.exposureUsd)}
                            <br />
                            Avg {formatPriceCents(position.averagePriceCents)}
                          </td>
                          <td className="px-4 py-3 align-top text-slate-700">
                            Yes {formatOddsPercent(position.currentYesOdds)}
                            <br />
                            No {formatOddsPercent(position.currentNoOdds)}
                          </td>
                          <td className="px-4 py-3 align-top text-slate-700">
                            {formatIstDateTime(position.closeTime)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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
                  {state.candidates.length}{" "}
                  {state.candidates.length === 1 ? "candidate" : "candidates"}
                </span>
              </div>

              {state.candidates.length > 0 ? (
                <div className="overflow-hidden rounded-2xl border border-slate-200">
                  <table className="min-w-full divide-y divide-slate-200 text-sm">
                    <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                      <tr>
                        <th className="px-4 py-3">Outcomes</th>
                        <th className="px-4 py-3">Current Yes odds %</th>
                        <th className="px-4 py-3">Current No odds %</th>
                        <th className="px-4 py-3">LLM Yes Odds</th>
                        <th className="px-4 py-3">LLM No Odds</th>
                        <th className="px-4 py-3">Returns/day</th>
                        <th className="px-4 py-3">Amount to be invested</th>
                        <th className="px-4 py-3">Volume</th>
                        <th className="px-4 py-3">Liquidity</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 bg-white">
                      {state.candidates.map((candidate, index) => (
                        <tr
                          key={`${candidate.slug || candidate.question}-${index}`}
                        >
                          <td className="px-4 py-3 align-top">
                            <div className="font-semibold text-slate-950">
                              {candidate.marketUrl ? (
                                <a
                                  className="hover:text-sky-700 hover:underline"
                                  href={candidate.marketUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {candidate.question}
                                </a>
                              ) : (
                                candidate.question
                              )}
                            </div>
                            <div className="mt-1 flex flex-wrap gap-2 text-xs text-slate-500">
                              {candidate.theme ? (
                                <span>{candidate.theme}</span>
                              ) : null}
                              {candidate.forceInclude ? (
                                <span>Force included</span>
                              ) : null}
                            </div>
                          </td>
                          <td className="px-4 py-3 align-top font-semibold text-emerald-700">
                            {formatOddsPercent(candidate.currentYesOdds)}
                          </td>
                          <td className="px-4 py-3 align-top font-semibold text-rose-700">
                            {formatOddsPercent(candidate.currentNoOdds)}
                          </td>
                          <td className="px-4 py-3 align-top font-semibold text-violet-700">
                            {formatOddsPercent(candidate.llmYesOdds)}
                          </td>
                          <td className="px-4 py-3 align-top font-semibold text-fuchsia-700">
                            {formatOddsPercent(candidate.llmNoOdds)}
                          </td>
                          <td className="px-4 py-3 align-top font-semibold text-slate-700">
                            {formatReturnsPerDay(candidate.returnsPerDay)}
                          </td>
                          <td className="px-4 py-3 align-top font-semibold text-slate-700">
                            {formatInvestAmount(candidate.amountToBeInvested)}
                          </td>
                          <td className="px-4 py-3 align-top text-slate-700">
                            {formatMoney(candidate.volumeUsd)}
                          </td>
                          <td className="px-4 py-3 align-top text-slate-700">
                            {formatMoney(candidate.liquidityUsd)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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
    </div>
  );
}

function getDecisionExitTypeDetails(decision: BullpenAutoLiveDecision) {
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

function formatInvestMetricOrderStatus(decision: BullpenAutoLiveDecision) {
  if (!decision.order_plan) return "No order planned";
  return decision.order_plan.status.replaceAll("_", " ");
}

function InvestMetricSummaryCard({
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

function RunDetailWorkerStages({
  run,
  decisions,
  onOpenScanFilters,
  onOpenStageTwoInvestEvents,
  onOpenStageTwoLlmRunDetails,
}: {
  run: BullpenAutoLiveRun;
  decisions: BullpenAutoLiveDecision[];
  onOpenScanFilters?: () => void;
  onOpenStageTwoInvestEvents?: (rows: BullpenStage2TopTenHandoffRow[]) => void;
  onOpenStageTwoLlmRunDetails?: (state: StageTwoLlmRunDialogState) => void;
}) {
  const workflowView = buildBullpenAutoRunWorkflowView(run);
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
          const investStageCounters = getInvestStageCounters(stage);
          const investExecutionSteps = getInvestStageExecutionSteps(stage, decisions);
          const toneClasses = getWorkflowToneClasses(
            immediateSuccess ? "green" : stage.tone,
          );
          const stageStatusLabel = immediateSuccess
            ? "Finished"
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
                  />
                ) : null}
              </div>

              {investStageCounters.length > 0 ? (
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {investStageCounters.map((counter) => (
                    <div
                      key={counter.label}
                      className="rounded-xl border border-white/70 bg-white/60 px-3 py-2 text-left"
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
                    </div>
                  ))}
                </div>
              ) : null}

              {investExecutionSteps.length > 0 ? (
                <div className="mt-3">
                  <InvestExecutionStepsSummary
                    steps={investExecutionSteps}
                    compact
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
                <p className={`mt-3 text-xs leading-5 ${toneClasses.muted}`}>
                  {stage.detail}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function RunDetailDialog({
  state,
  onClose,
  onOpenScanFilters,
  onOpenStageTwoInvestEvents,
  onOpenStageTwoLlmRunDetails,
  onOpenMetricDetails,
}: {
  state: RunDetailDialogState;
  onClose: () => void;
  onOpenScanFilters?: () => void;
  onOpenStageTwoInvestEvents?: (rows: BullpenStage2TopTenHandoffRow[]) => void;
  onOpenStageTwoLlmRunDetails?: (state: StageTwoLlmRunDialogState) => void;
  onOpenMetricDetails?: (
    run: BullpenAutoLiveRun,
    kind: InvestMetricDialogKind,
  ) => void;
}) {
  const { run, decisions } = state;
  const summaryDetails = getRunSummaryDetails(run.summary);
  const [warningsDialogOpen, setWarningsDialogOpen] = useState(false);
  const [plannedOrderDetail, setPlannedOrderDetail] =
    useState<PlannedOrderDetailState | null>(null);
  const [decisionLlmOdds, setDecisionLlmOdds] =
    useState<DecisionLlmOddsState | null>(null);
  return (
    <div className="fixed inset-0 z-[140] flex items-center justify-center bg-slate-950/60 p-4">
      <div className="flex max-h-[90vh] min-h-0 w-full max-w-[92rem] flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.55)]">
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
            aria-label="Close run details"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="grid gap-3 md:grid-cols-3">
            <InvestMetricSummaryCard
              label="Decisions"
              value={run.decisions_count}
              onClick={
                onOpenMetricDetails
                  ? () => onOpenMetricDetails(run, "decisions")
                  : undefined
              }
            />
            <InvestMetricSummaryCard
              label="Planned"
              value={run.orders_planned}
              onClick={
                onOpenMetricDetails
                  ? () => onOpenMetricDetails(run, "planned")
                  : undefined
              }
            />
            <InvestMetricSummaryCard
              label="Submitted"
              value={run.orders_submitted}
              onClick={
                onOpenMetricDetails
                  ? () => onOpenMetricDetails(run, "submitted")
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
          <RunDetailWorkerStages
            run={run}
            decisions={decisions}
            onOpenScanFilters={onOpenScanFilters}
            onOpenStageTwoInvestEvents={onOpenStageTwoInvestEvents}
            onOpenStageTwoLlmRunDetails={onOpenStageTwoLlmRunDetails}
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

function RunWarningsDialog({
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

function DecisionLlmOddsDialog({
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

function PlannedOrderDetailDialog({
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

function getDecisionDaysLeft(decision: BullpenAutoLiveDecision) {
  if (!decision.close_time) return "—";
  const closeMs = Date.parse(decision.close_time);
  if (!Number.isFinite(closeMs)) return "—";
  const days = (closeMs - Date.now()) / (24 * 60 * 60 * 1000);
  return days.toLocaleString("en-IN", { maximumFractionDigits: 1 });
}

function getDecisionReturnsPerDay(decision: BullpenAutoLiveDecision) {
  if (!decision.hours_remaining || decision.hours_remaining <= 0) return null;
  return (decision.edge_pp / decision.hours_remaining) * 24;
}

function getPlannedOrderBrief(decision: BullpenAutoLiveDecision) {
  return (
    decision.order_plan?.detail ??
    decision.reason ??
    decision.summary ??
    "Planned buy order was not submitted."
  );
}

function Stage3DecisionTable({
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
                <th className="px-4 py-3">Returns/day</th>
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
                      {formatReturnsPerDay(getDecisionReturnsPerDay(decision))}
                    </td>
                    <td className="min-w-64 px-4 py-3 text-slate-700">
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
    </div>
  );
}

type SubmittedExecutionStatus =
  | "not-submitted"
  | "submitted"
  | "in-progress"
  | "partial";

function getSubmittedExecutionStatus(
  totalOrders: number,
  submittedOrders: number,
): SubmittedExecutionStatus {
  if (totalOrders < 1) return "in-progress";
  if (submittedOrders >= totalOrders) return "submitted";
  if (submittedOrders < 1) return "not-submitted";
  return "partial";
}

function SubmittedExecutionStatusIcon({
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

function SubmittedExecutionCountPill({
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

function SubmittedExecutionEventsTable({
  decisions,
  onOpenPlannedOrderDetail,
  onOpenLlmOdds,
}: {
  decisions: BullpenAutoLiveDecision[];
  onOpenPlannedOrderDetail: (state: PlannedOrderDetailState) => void;
  onOpenLlmOdds: (decision: BullpenAutoLiveDecision) => void;
}) {
  const submittedDecisions = decisions.filter((decision) =>
    isSubmittedOrSuccessfulDecision(decision),
  );
  const exitDecisions = decisions.filter(
    (decision) =>
      decision.order_plan?.action === "sell" ||
      decision.order_plan?.action === "redeem",
  );
  const buyDecisions = decisions.filter(
    (decision) => decision.order_plan?.action === "buy",
  );
  const submittedExitDecisions = submittedDecisions.filter(
    (decision) =>
      decision.order_plan?.action === "sell" ||
      decision.order_plan?.action === "redeem",
  );
  const submittedBuyDecisions = submittedDecisions.filter(
    (decision) => decision.order_plan?.action === "buy",
  );
  const plannedButNotSubmittedBuys = buyDecisions.filter(
    (decision) => !isSubmittedOrSuccessfulDecision(decision),
  );
  const exitStatus = getSubmittedExecutionStatus(
    exitDecisions.length,
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
            Executed Stage 3 Events
          </p>
          <h3 className="mt-1 text-sm font-semibold text-slate-950">
            Step 1 Exit and Step 2 Buy execution results
          </h3>
        </div>
        <div className="flex flex-wrap gap-2 text-xs font-semibold">
          <SubmittedExecutionCountPill className="border-emerald-200 bg-white/80 text-emerald-800">
            {submittedDecisions.length.toLocaleString("en-IN")} total
          </SubmittedExecutionCountPill>
          <SubmittedExecutionCountPill
            className="border-rose-200 bg-rose-50 text-rose-800"
            status={exitStatus}
          >
            {submittedExitDecisions.length.toLocaleString("en-IN")} exits
          </SubmittedExecutionCountPill>
          <SubmittedExecutionCountPill
            className="border-blue-200 bg-blue-50 text-blue-800"
            status={buyStatus}
          >
            {submittedBuyDecisions.length.toLocaleString("en-IN")} buys
          </SubmittedExecutionCountPill>
        </div>
      </div>
      <div className="space-y-4 p-4">
        <Stage3DecisionTable
          title="Step 1 Exit"
          rows={submittedExitDecisions}
          emptyMessage="No submitted Step 1 Exit events were returned for this run."
          onOpenLlmOdds={onOpenLlmOdds}
        />
        <Stage3DecisionTable
          title="Step 2 Buy"
          rows={submittedBuyDecisions}
          emptyMessage="No submitted Step 2 Buy events were returned for this run."
          onOpenLlmOdds={onOpenLlmOdds}
        />
        <Stage3DecisionTable
          title="Events Planned but not Submitted"
          rows={plannedButNotSubmittedBuys}
          emptyMessage="No planned buy orders were left unsubmitted for this run."
          plannedButNotSubmitted
          onOpenPlannedOrderDetail={onOpenPlannedOrderDetail}
          onOpenLlmOdds={onOpenLlmOdds}
        />
      </div>
    </section>
  );
}

type RunHistoryMetricTilesProps = {
  run: BullpenAutoLiveRun;
  decisions: BullpenAutoLiveDecision[];
  onOpenMetricDetails: (kind: InvestMetricDialogKind) => void;
};

function getInvestFailureCode(decisions: BullpenAutoLiveDecision[]) {
  const failureText = decisions
    .map(
      (decision) =>
        `${decision.order_plan?.detail ?? ""}\n${decision.order_plan?.execution_response ?? ""}`,
    )
    .join("\n")
    .trim();
  if (!failureText) return null;
  const quotedReason = failureText.match(
    /reason\s*[:=]\s*["']([^"']+)["']/i,
  )?.[1];
  if (quotedReason) return quotedReason;
  const snakeCode = failureText.match(
    /\b([a-z][a-z0-9]+(?:_[a-z0-9]+)+)\b/i,
  )?.[1];
  return snakeCode ?? null;
}

function RunHistoryMetricButton({
  label,
  value,
  onClick,
  tone = "slate",
}: {
  label: string;
  value: number;
  onClick: () => void;
  tone?: "slate" | "rose" | "blue" | "emerald" | "amber";
}) {
  const toneClass = {
    slate:
      "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50",
    rose: "border-rose-200 bg-rose-50 text-rose-800 hover:border-rose-300 hover:bg-rose-100",
    blue: "border-blue-200 bg-blue-50 text-blue-800 hover:border-blue-300 hover:bg-blue-100",
    emerald:
      "border-emerald-200 bg-emerald-50 text-emerald-800 hover:border-emerald-300 hover:bg-emerald-100",
    amber:
      "border-amber-200 bg-amber-50 text-amber-800 hover:border-amber-300 hover:bg-amber-100",
  }[tone];

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={`rounded-xl border px-3 py-2 text-left text-xs font-semibold transition ${toneClass}`}
    >
      <span className="text-sm tabular-nums text-slate-950">
        {value.toLocaleString("en-IN")}
      </span>{" "}
      {label}
    </button>
  );
}

function RunHistoryMetricTiles({
  run,
  decisions,
  onOpenMetricDetails,
}: RunHistoryMetricTilesProps) {
  const stage2TopTenHandoffRows = buildBullpenStage2TopTenHandoffRows({
    run,
    decisions,
  });
  const availableForClaimCount = getInvestMetricRows(
    "sell-redeem",
    decisions,
  ).length;
  const eventOutOfTopTenCount = getInvestMetricRows(
    "sell-ranking-llm",
    decisions,
  ).length;
  const forcedExitCount = getInvestMetricRows(
    "sell-forced-exit",
    decisions,
  ).length;
  const newEventsToInvestCount =
    stage2TopTenHandoffRows.length > 0
      ? stage2TopTenHandoffRows.length
      : getInvestMetricRows("buy-planned", decisions).length;
  const newEventsInvestedCount = getInvestMetricRows(
    "buy-submitted",
    decisions,
  ).length;
  const investmentFailedRows = getInvestMetricRows(
    "buy-planned",
    decisions,
  ).filter(
    (decision) =>
      decision.order_plan &&
      !isSubmittedOrSuccessfulDecision(decision) &&
      ["failed", "cancelled", "skipped"].includes(decision.order_plan.status),
  );
  const failureCode = getInvestFailureCode(investmentFailedRows);

  return (
    <div
      className="mt-3 space-y-3 text-xs"
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        onClick={() => onOpenMetricDetails("decisions")}
        className="inline-flex rounded-full border border-slate-200 bg-white px-3 py-1.5 font-semibold text-slate-800 transition hover:border-sky-200 hover:bg-sky-50 hover:text-sky-900"
      >
        {run.decisions_count.toLocaleString("en-IN")} decisions |
      </button>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-2xl border border-amber-200 bg-amber-50/70 p-3">
          <RunHistoryMetricButton
            label="Planned"
            value={run.orders_planned}
            onClick={() => onOpenMetricDetails("planned")}
            tone="amber"
          />
          <div className="mt-3 grid gap-2">
            <div className="rounded-xl border border-rose-100 bg-white/85 p-3">
              <p className="font-semibold text-rose-900">
                Step 1 of 2 Event Exits
              </p>
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                <RunHistoryMetricButton
                  label="Available for Claim"
                  value={availableForClaimCount}
                  onClick={() => onOpenMetricDetails("sell-redeem")}
                  tone="emerald"
                />
                <RunHistoryMetricButton
                  label="Event out of Top 10"
                  value={eventOutOfTopTenCount}
                  onClick={() => onOpenMetricDetails("sell-ranking-llm")}
                  tone="rose"
                />
                <RunHistoryMetricButton
                  label="Forced Exit"
                  value={forcedExitCount}
                  onClick={() => onOpenMetricDetails("sell-forced-exit")}
                  tone="rose"
                />
              </div>
            </div>
            <div className="rounded-xl border border-blue-100 bg-white/85 p-3">
              <p className="font-semibold text-blue-900">Step 2</p>
              <div className="mt-2">
                <RunHistoryMetricButton
                  label="New Events to Invest in"
                  value={newEventsToInvestCount}
                  onClick={() => onOpenMetricDetails("buy-planned")}
                  tone="blue"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-emerald-200 bg-emerald-50/70 p-3">
          <RunHistoryMetricButton
            label="Submitted"
            value={run.orders_submitted}
            onClick={() => onOpenMetricDetails("submitted")}
            tone="emerald"
          />
          <div className="mt-3 grid gap-2">
            <div className="rounded-xl border border-rose-100 bg-white/85 p-3">
              <p className="font-semibold text-rose-900">
                Step 1 of 2 Event Exits
              </p>
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                <RunHistoryMetricButton
                  label="Available for Claim"
                  value={availableForClaimCount}
                  onClick={() => onOpenMetricDetails("sell-redeem")}
                  tone="emerald"
                />
                <RunHistoryMetricButton
                  label="Event out of Top 10"
                  value={eventOutOfTopTenCount}
                  onClick={() => onOpenMetricDetails("sell-ranking-llm")}
                  tone="rose"
                />
                <RunHistoryMetricButton
                  label="Forced Exit"
                  value={forcedExitCount}
                  onClick={() => onOpenMetricDetails("sell-forced-exit")}
                  tone="rose"
                />
              </div>
            </div>
            <div className="rounded-xl border border-blue-100 bg-white/85 p-3">
              <p className="font-semibold text-blue-900">Step 2</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <RunHistoryMetricButton
                  label="New Events Invested in"
                  value={newEventsInvestedCount}
                  onClick={() => onOpenMetricDetails("buy-submitted")}
                  tone="blue"
                />
                <RunHistoryMetricButton
                  label={`Investments failed${failureCode ? ` (${failureCode})` : ""}`}
                  value={investmentFailedRows.length}
                  onClick={() => onOpenMetricDetails("buy-planned")}
                  tone="rose"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function readLlmContextString(
  record: Record<string, unknown> | null,
  key: string,
) {
  if (!record) return null;
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readLlmContextNumber(
  record: Record<string, unknown> | null,
  key: string,
) {
  if (!record) return null;
  return readStageOutputNumber(record[key]);
}

function readLlmContextRecord(
  record: Record<string, unknown> | null,
  key: string,
) {
  if (!record) return null;
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readLlmContextArray(
  record: Record<string, unknown> | null,
  key: string,
) {
  if (!record) return [];
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function getStageTwoLlmReviewedRows(
  stage: WorkflowStageView,
  scanCandidates: WorkflowStageView["scanCandidates"] = [],
) {
  return getHistoricalStageTwoLlmReviewedRows(stage, scanCandidates);
}

function getStageTwoLlmTableRows(
  state: StageTwoLlmRunDialogState,
  asOfTimestamp?: string | number | Date | null,
) {
  const scanCandidates =
    state.run
      ? (buildBullpenAutoRunWorkflowView(state.run).stages.find(
          (workflowStage) => workflowStage.key === "scan",
        )?.scanCandidates ?? [])
      : [];
  const reviewedRows = getHistoricalStageTwoLlmReviewedRows(
    state.stage,
    scanCandidates,
  );
  return getHistoricalStageTwoLlmTableRows({
    reviewedRows,
    decisions: state.decisions,
    asOfTimestamp,
    runId: state.run?.id ?? null,
  });
}

function buildStageTwoEventsSummaryRows(
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

function getRunWorkflowStageResult(
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

function formatStageTwoSummaryMessage({
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

function groupStageTwoLlmRowsByModel(
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

function readStageTwoLlmOutputCost(output: Record<string, unknown> | null) {
  return (
    readLlmContextNumber(output, "estimated_cost") ??
    readLlmContextNumber(output, "cost") ??
    readLlmContextNumber(output, "cost_usd")
  );
}

type StageTwoRunSummaryStatus =
  | "completed"
  | "failed"
  | "partial"
  | "pending"
  | "running";

const STAGE_TWO_LLM_IDENTITY_ERROR =
  "Data integrity error: Stage 2 recorded an LLM target execution without a provider/model identity.";
const STAGE_TWO_LLM_MISSING_CHILD_ERROR =
  "Data integrity error: Stage 2 never recorded a child LLM execution for this selected provider/model target.";

type StageTwoLlmRunSummaryRow = {
  key: string;
  provider: string;
  model: string;
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

type StageTwoLlmFailureDialogRow = StageTwoLlmRunSummaryRow;

function formatStageTwoRuntimeSeconds(value: number | null) {
  if (value === null) return "—";
  const safeSeconds = Math.max(0, Math.round(value));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function normalizeStageTwoRunStatus(
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

function readStageTwoLlmIdentity(
  value: Record<string, unknown> | null,
) {
  const provider = readLlmContextString(value, "provider")?.trim() ?? "";
  const model = readLlmContextString(value, "model")?.trim() ?? "";
  if (!provider || !model) return null;
  return { provider, model };
}

function hasStageTwoLlmIdentity(
  value: Record<string, unknown> | null,
) {
  return readStageTwoLlmIdentity(value) !== null;
}

function isUsableStageTwoTargetRun(run: Record<string, unknown>) {
  const usableEventCount = readLlmContextNumber(run, "usable_event_count");
  if (usableEventCount !== null) return usableEventCount > 0;
  const status = normalizeStageTwoRunStatus(readLlmContextString(run, "status"));
  return status === "completed" || status === "partial";
}

function isFailedStageTwoTargetRun(run: Record<string, unknown>) {
  if (!hasStageTwoLlmIdentity(run)) return true;
  const usableEventCount = readLlmContextNumber(run, "usable_event_count");
  if (usableEventCount !== null) return usableEventCount <= 0;
  return normalizeStageTwoRunStatus(readLlmContextString(run, "status")) === "failed";
}

function isTerminalStageTwoStage(stage: WorkflowStageView) {
  const phaseStatus =
    readStageOutputString(stage.outputs.phase_status) ??
    readStageOutputString(stage.inputs.phase_status);
  return (
    Boolean(stage.timerCompletedAt) ||
    phaseStatus === "completed" ||
    phaseStatus === "partial" ||
    phaseStatus === "failed"
  );
}

function getStageTwoLlmTargets(stage: WorkflowStageView) {
  const targets = stage.outputs.llm_targets ?? stage.inputs.llm_targets;
  if (!Array.isArray(targets)) return [];
  return targets.filter(
    (target): target is Record<string, unknown> =>
      Boolean(target) && typeof target === "object",
  );
}

function getStageTwoLlmTargetRuns(stage: WorkflowStageView) {
  const runs = stage.outputs.llm_target_runs;
  if (!Array.isArray(runs)) return [];
  return runs.filter(
    (run): run is Record<string, unknown> =>
      Boolean(run) && typeof run === "object",
  );
}

function getStageTwoLlmRunSummaryRows(
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
    const stageIsTerminal = isTerminalStageTwoStage(stage);
    const runRows = targetRuns.map((run, index) => {
      const identity = readStageTwoLlmIdentity(run);
      const provider = identity?.provider ?? "—";
      const model = identity?.model ?? "—";
      const key = `${provider}::${model}`;
      const rawStatus = normalizeStageTwoRunStatus(readLlmContextString(run, "status"));
      const status = identity ? rawStatus : "failed";
      return {
        key: `${key}-${index}`,
        provider,
        model,
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
    const runKeys = new Set(
      runRows.map(
        (row) =>
          row.provider !== "—" && (row.requestedModel ?? row.model)
            ? `${row.provider}::${row.requestedModel ?? row.model}`
            : null,
      ),
    );
    const pendingRunRows = getStageTwoLlmTargets(stage)
      .filter((target) => {
        const identity = readStageTwoLlmIdentity(target);
        if (!identity) return true;
        return !runKeys.has(`${identity.provider}::${identity.model}`);
      })
      .map((target, index) => {
        const identity = readStageTwoLlmIdentity(target);
        const provider = identity?.provider ?? "—";
        const model = identity?.model ?? "—";
        const isIntegrityFailure = !identity || stageIsTerminal;
        return {
          key: `${provider}::${model}-pending-${index}`,
          provider,
          model,
          requestedModel: identity?.model ?? null,
          status: isIntegrityFailure
            ? ("failed" as StageTwoRunSummaryStatus)
            : ("pending" as StageTwoRunSummaryStatus),
          runtime: formatStageElapsedTime(stage.timerStartedAt, null, nowMs),
          cost: null,
          error: !identity
            ? STAGE_TWO_LLM_IDENTITY_ERROR
            : stageIsTerminal
              ? STAGE_TWO_LLM_MISSING_CHILD_ERROR
              : null,
          failureCategory: !identity || stageIsTerminal ? "data_integrity_error" : null,
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
  const stageIsTerminal = isTerminalStageTwoStage(stage);
  const pendingTargets = getStageTwoLlmTargets(stage).filter((target) => {
    const identity = readStageTwoLlmIdentity(target);
    if (!identity) return true;
    return !knownKeys.has(`${identity.provider}::${identity.model}`);
  });
  const pendingRows = pendingTargets.map((target, index) => {
    const identity = readStageTwoLlmIdentity(target);
    const provider = identity?.provider ?? "—";
    const model = identity?.model ?? "—";
    return {
      key: `${provider}::${model}-pending-${index}`,
      provider,
      model,
      requestedModel: identity?.model ?? null,
      status:
        !identity || stageIsTerminal
          ? ("failed" as StageTwoRunSummaryStatus)
          : ("pending" as StageTwoRunSummaryStatus),
      runtime: formatStageElapsedTime(stage.timerStartedAt, null, nowMs),
      cost: null,
      error: !identity
        ? STAGE_TWO_LLM_IDENTITY_ERROR
        : stageIsTerminal
          ? STAGE_TWO_LLM_MISSING_CHILD_ERROR
          : null,
      failureCategory:
        !identity || stageIsTerminal ? "data_integrity_error" : null,
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

function getStageTwoLlmFailureFixAdvice(row: StageTwoLlmFailureDialogRow) {
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

function StageTwoLlmFailureDialog({
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

function getStageTwoRunSummaryStatusClass(status: StageTwoRunSummaryStatus) {
  if (status === "completed")
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "partial") return "border-sky-200 bg-sky-50 text-sky-700";
  if (status === "running")
    return "border-amber-200 bg-amber-50 text-amber-700";
  if (status === "pending")
    return "border-slate-200 bg-slate-50 text-slate-600";
  return "border-red-200 bg-red-50 text-red-700";
}

function getStageTwoRunSummaryStatusLabel(status: StageTwoRunSummaryStatus) {
  if (status === "completed") return "Completed";
  if (status === "partial") return "Partial";
  if (status === "running") return "Running";
  if (status === "pending") return "Pending";
  return "Failed";
}

export function StageTwoLlmRunDetailsDialog({
  state,
  onClose,
}: {
  state: StageTwoLlmRunDialogState;
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
  const reviewedRows = getStageTwoLlmReviewedRows(state.stage, scanCandidates);
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
  const availableLlmDecisionRows = llmTableRows.filter(
    (row) => row.output && !readLlmContextString(row.output, "error"),
  );
  const llmModelGroups = groupStageTwoLlmRowsByModel(llmTableRows);
  const summaryRows = getStageTwoLlmRunSummaryRows(
    state.stage,
    llmModelGroups,
    dialogNowMs,
  );
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
                            {row.model}
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
                              <th className="px-3 py-3">Returns/day</th>
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
                                    {formatReturnsPerDay(row.returnsPerDay)}
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
    </div>
  );
}

function getStageTwoDecisionLlmContext(
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

function hasReturnedValue(value: unknown) {
  return value !== undefined && value !== null && value !== "";
}

function formatJsonForDisplay(value: unknown) {
  if (!hasReturnedValue(value)) return "Not returned for this run.";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function readNestedRecord(
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

function readFirstReturnedValue(...values: unknown[]) {
  return values.find(hasReturnedValue);
}

function getStageTwoRunPromptTemplate(
  stage: WorkflowStageView | null | undefined,
) {
  return readFirstReturnedValue(stage?.outputs?.llm_prompt_template);
}

function getStageTwoDisplayedPrompt(
  llmContext: Record<string, unknown> | null,
  promptTemplate: unknown,
) {
  return readFirstReturnedValue(llmContext?.llm_prompt, promptTemplate);
}

function getStageTwoLlmPromptInputs(
  llmContext: Record<string, unknown> | null,
) {
  return readFirstReturnedValue(
    llmContext?.llm_prompt_inputs,
    llmContext?.prompt_inputs,
  );
}

function getStageTwoLlmPromptInputMarket(
  llmContext: Record<string, unknown> | null,
) {
  return readNestedRecord(getStageTwoLlmPromptInputs(llmContext), ["market"]);
}

function getStageTwoLlmPromptInputEvidencePacket(
  llmContext: Record<string, unknown> | null,
) {
  return readFirstReturnedValue(
    llmContext?.evidence_packet,
    readNestedRecord(getStageTwoLlmPromptInputs(llmContext), [
      "evidence_packet",
    ]),
  );
}

function getStageTwoLlmMissingValueReason(
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

function getStageTwoPromptMissingValueReason(
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

function MissingValueNote({ children }: { children: ReactNode }) {
  return (
    <p className="mt-1 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] leading-4 text-amber-800">
      {children}
    </p>
  );
}

function StageTwoInputPromptDialog({
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

function StageTwoLlmEventInputDialog({
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

function StageTwoDecisionDetailDialog({
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

function getStageTwoBreakupMatchKey(value: string | null | undefined) {
  return normalizeMatchKey(value);
}

function getStageTwoBreakupRows(
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

function StageTwoLlmRunBreakupDialog({
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
        <div className="flex-1 overflow-auto px-6 py-5">
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

function StageTwoBypassDialog({
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

function StageTwoInvestEventsDialog({
  state,
  onClose,
}: {
  state: StageTwoInvestEventsDialogState;
  onClose: () => void;
}) {
  const [isCompactRows, setIsCompactRows] = useState(false);

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
              Persisted Stage 2 Top 10 candidates that Stage 3 is trying to
              execute. If a transferred event never became a concrete Step 2
              buy plan, its latest blocker is shown here.
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
          <Stage2TopTenEventsSummaryTable
            rows={state.rows}
            run={null}
            displayDensity={isCompactRows ? "compact" : "default"}
            testId="stage-two-invest-events-summary"
            emptyMessage="No persisted Stage 2 Top 10 handoff rows were returned for this run."
            headerContent={
              <div className="rounded-2xl border border-blue-100 bg-blue-50/70 px-4 py-3 text-sm text-blue-950">
                This Events Summary view mirrors the Stage 3 Step 2 planned
                queue layout so every transferred Stage 2 Top 10 row carries
                the same Stage 3 status, outcome, and blocker columns.
              </div>
            }
          />
        </div>
      </div>
    </div>
  );
}

function InvestMetricDetailsDialog({
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
  const decisionsCount = getInvestStageMetric(
    state.stage,
    "decisions_count",
    state.run.decisions_count,
  );
  const plannedCount = getInvestStageMetric(
    state.stage,
    "orders_planned",
    state.run.orders_planned,
  );
  const submittedCount = getInvestStageMetric(
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
  const filteredSubmittedCount = tableRows.filter((decision) =>
    isSubmittedOrSuccessfulDecision(decision),
  ).length;
  const filteredUnsubmittedRows = tableRows.filter(
    (decision) =>
      decision.order_plan && !isSubmittedOrSuccessfulDecision(decision),
  );
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
  const hasPendingOrders = filteredPlannedCount > filteredSubmittedCount;
  const concreteBuyPlanCount = stage2TopTenHandoffRows.filter(
    (row) => !row.missingFromBuyPlan,
  ).length;
  const submittedBuyPlanCount = stage2TopTenHandoffRows.filter((row) =>
    isSubmittedOrSuccessfulDecision(row.displayDecision),
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
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/55 p-4">
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
                <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                    Transferred rows
                  </p>
                  <p className="mt-1 text-lg font-semibold text-slate-950">
                    {stage2TopTenHandoffRows.length.toLocaleString("en-IN")}
                  </p>
                </div>
                <div className="rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-blue-700">
                    Concrete buy plans
                  </p>
                  <p className="mt-1 text-lg font-semibold text-blue-950">
                    {concreteBuyPlanCount.toLocaleString("en-IN")}
                  </p>
                </div>
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-700">
                    Submitted
                  </p>
                  <p className="mt-1 text-lg font-semibold text-emerald-950">
                    {submittedBuyPlanCount.toLocaleString("en-IN")}
                  </p>
                </div>
                <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-700">
                    Still waiting / blocked
                  </p>
                  <p className="mt-1 text-lg font-semibold text-amber-950">
                    {blockedOrWaitingBuyPlanCount.toLocaleString("en-IN")}
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                Selected filter
              </p>
              <p className="mt-2 text-sm font-semibold text-slate-950">
                {tableRows.length.toLocaleString("en-IN")} rows ·{" "}
                {filteredPlannedCount.toLocaleString("en-IN")} planned ·{" "}
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

          {hasPendingOrders ? (
            <div className="mt-5 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-950 dark:text-sky-50">
              Stage 3 submits Bullpen orders one at a time, so multiple planned
              orders can take a few minutes when Bullpen is slow or retrying.
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
                          <td className="px-4 py-3 align-top">
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
                          <td className="px-4 py-3 align-top text-slate-700">
                            <span className="font-semibold capitalize text-slate-950">
                              {decision.decision.replaceAll("_", " ")}
                            </span>
                            <br />
                            Side {decision.side} · {decision.confidence}
                            <br />
                            {decision.risk_status.replaceAll("_", " ")}
                          </td>
                          <td className="px-4 py-3 align-top text-slate-700">
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
                          <td className="px-4 py-3 align-top text-slate-700">
                            Current {formatMoney(decision.current_exposure_usd)}
                            <br />
                            Target {formatMoney(decision.target_exposure_usd)}
                          </td>
                          <td className="px-4 py-3 align-top font-semibold tabular-nums text-violet-800">
                            {formatOddsPercent(
                              decision.fair_yes_probability_pct ?? null,
                            )}
                          </td>
                          <td className="px-4 py-3 align-top font-semibold tabular-nums text-violet-800">
                            {formatOddsPercent(
                              decision.fair_no_probability_pct ?? null,
                            )}
                          </td>
                          <td className="px-4 py-3 align-top tabular-nums text-slate-700">
                            {formatReturnsPerDay(
                              getDecisionReturnsPerDay(decision),
                            )}
                          </td>
                          <td className="px-4 py-3 align-top text-slate-700">
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
                          <td className="px-4 py-3 align-top text-slate-700">
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
                                <ErrorCodeWithDetails
                                  detail={decision.order_plan.detail}
                                  detailClassName="text-slate-700"
                                />
                              </>
                            ) : (
                              <>
                                <br />
                                {decision.reason}
                              </>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
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
    </div>
  );
}

function Stage3PreviewDialog({
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
              Stage 3 Planned Preview
            </p>
            <h2 className="text-xl font-semibold text-slate-950">
              Current Stage 3 buy and sell queue
            </h2>
            <p className="max-w-4xl text-sm leading-6 text-slate-600">
              This preview combines the current Event Exits list with the saved
              Stage 2 top-10 buy rows. Stage 3 submits the exits first, waits
              for settlement, refreshes live cash plus occupied slots, and only
              then sizes and submits the buys.
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
            aria-label="Close Stage 3 planned preview"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-6 py-5">
          <div className="grid gap-3 md:grid-cols-3">
            <InvestMetricSummaryCard label="Planned" value={state.plannedOrders} />
            <InvestMetricSummaryCard
              label="Step 1 Exits"
              value={state.sellPlannedOrders}
            />
            <InvestMetricSummaryCard
              label="Step 2 Buys"
              value={state.buyPlannedOrders}
            />
          </div>

          <div className="mt-5 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-4 text-sm text-sky-950">
            Stage 3 will use these rows as the planned queue. Sell orders go
            first, and buy sizes can still change at submission time because
            Step 2 rechecks fresh wallet cash and open slots.
          </div>

          <div className="mt-5 space-y-4">
            <Stage3DecisionTable
              title="Step 1 Event Exits"
              rows={sellDecisions}
              emptyMessage="No executable Event Exit sell rows are waiting right now."
            />
            <Stage3DecisionTable
              title="Step 2 Planned Buys"
              rows={buyDecisions}
              emptyMessage="No saved Stage 2 top-10 buy rows are waiting right now."
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-6 py-4">
          <p className="text-xs leading-5 text-slate-500">
            Preview only until the run is queued. Once submitted, the worker
            persists the live planned and submitted results in the Stage 3
            history.
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
                  Submit Planned Buys and Sells
                </>
              )}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function buildConsoleSettingsUpdate(
  consoleOrderUsd: number,
  startAt?: string | null,
  refreshMinutes?: number | null,
  consoleLlmTargets?: ProviderModelTarget[] | null,
) {
  return {
    strategy_profile: "bullpen_console_top10" as const,
    console_order_usd: consoleOrderUsd,
    console_auto_start_at: startAt ?? null,
    console_auto_refresh_minutes: refreshMinutes ?? null,
    ...(consoleLlmTargets ? { console_llm_targets: consoleLlmTargets } : {}),
    auto_live_enabled: true,
    dry_run: false,
    allow_live_execution: true,
    require_manual_confirmation: false,
  };
}

function isConsoleProfileSelected(
  summary: BullpenAutoLiveSummaryResponse | null,
) {
  return summary?.settings.strategy_profile === CONSOLE_PROFILE_ID;
}

function isAutoRunActive(summary: BullpenAutoLiveSummaryResponse | null) {
  return Boolean(
    summary &&
    isConsoleProfileSelected(summary) &&
    summary.settings.auto_live_enabled &&
    summary.state.running &&
    !summary.state.paused,
  );
}

function statusLabel(
  summary: BullpenAutoLiveSummaryResponse | null,
  runActive: boolean,
) {
  if (!summary) return "Loading";
  if (!summary.settings.auto_live_enabled) return "Off";
  if (!isConsoleProfileSelected(summary)) return "Other profile active";
  if (summary.state.paused) return "Paused";
  if (runActive) return "On";
  return "Ready";
}

function modeLabel(summary: BullpenAutoLiveSummaryResponse | null) {
  if (!summary) return "Checking";
  if (summary.state.mode === "live-trading") return "Live trading";
  if (summary.state.mode === "analysis-only") return "Analysis only";
  return "Dry run";
}

function formatStageLastRunLabel(value: string | null) {
  return value ? formatIstDateTime(value) : "Not run yet";
}

function formatRunStatusLabel(status: BullpenAutoLiveRun["status"]) {
  if (status === "running") return "Running";
  if (status === "confirming") return "Confirming";
  if (status === "completed") return "Completed";
  if (status === "partial_success") return "Partial";
  if (status === "failed") return "Failed";
  return "Skipped";
}

function isActivelyWorkingRunStatus(
  status: BullpenAutoLiveRun["status"] | null | undefined,
) {
  return status === "running" || status === "confirming";
}

function formatLatestRunSummaryTileLabel(run: BullpenAutoLiveRun | null) {
  if (!run) return "Last run";
  if (run.status === "failed") return "Last failed run";
  if (run.status === "partial_success") return "Last partial run";
  if (run.status === "skipped") return "Last skipped run";
  return "Last completed run";
}

function runNeedsBullpenLogin(run: BullpenAutoLiveRun | null) {
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

function getVisibleRun(
  summary: BullpenAutoLiveSummaryResponse | null,
  pendingRunId: string | null,
) {
  if (!summary) return null;
  if (pendingRunId) {
    return (
      summary.recent_runs.find((run) => run.id === pendingRunId) ??
      (summary.latest_run?.id === pendingRunId ? summary.latest_run : null)
    );
  }
  if (
    summary.latest_run?.status === "running" ||
    summary.latest_run?.status === "confirming"
  ) {
    return summary.latest_run;
  }
  const runningRun = summary.recent_runs.find(
    (run) => run.status === "running" || run.status === "confirming",
  );
  if (runningRun) return runningRun;

  // On page refresh there is usually no pending/running run to track, but the
  // console still needs the most recent completed run payload so the parent can
  // rebuild the Events Summary and Events to invest in tables with persisted LLM
  // odds/returns until a newer scan replaces them.
  if (summary.latest_run?.status === "completed") return summary.latest_run;
  return summary.recent_runs.find((run) => run.status === "completed") ?? null;
}

function getWorkflowToneClasses(tone: "yellow" | "green" | "blue" | "slate") {
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

function isUsableBullpenBalance(
  balance: PolymarketBotState["live"]["balance"] | null | undefined,
): balance is PolymarketBotState["live"]["balance"] & { status: "ready" } {
  return balance?.status === "ready";
}

function BullpenPortfolioSnapshot({
  state,
  lastUsableBalance,
  activePositions,
  activePositionQuestions,
  hasActivePositionsSnapshot,
  refreshing,
  historicalRuns,
  recentDecisions,
  onRefresh,
}: {
  state: PolymarketBotState | null;
  lastUsableBalance:
    | (PolymarketBotState["live"]["balance"] & { status: "ready" })
    | null;
  activePositions: BullpenActivePositionView[];
  activePositionQuestions: BullpenQuestionRow[];
  hasActivePositionsSnapshot: boolean;
  refreshing: boolean;
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
  const accountValue = usableBalance
    ? (balance.account_value_usd ?? null)
    : null;
  const cash = usableBalance ? (balance.available_balance_usd ?? null) : null;
  const pnl = usableBalance ? (balance.pnl_usd ?? null) : null;
  const upnl = usableBalance ? (balance.upnl_usd ?? null) : null;
  const openPositions = state?.open_positions ?? [];
  const activePositionCount = hasActivePositionsSnapshot
    ? activePositions.length
    : openPositions.filter((position) => position.shares > 0).length;
  const activeInvested = hasActivePositionsSnapshot
    ? activePositions.reduce((total, position) => {
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
  const claimableAmount = claimableRows.reduce(
    (total, trade) => total + Math.max(0, trade.amount || 0),
    0,
  );
  const lastRefresh = balance?.checked_at
    ? formatIstDateTime(balance.checked_at)
    : "—";
  const pendingConfirmationsCount =
    state?.live.pending_confirmations.length ?? 0;
  const balanceStatus = liveBalance?.status ?? balance?.status ?? "not loaded";
  const currentInvestmentsValue = hasActivePositionsSnapshot
    ? activePositions.reduce((total, position) => {
        const value =
          typeof position.currentValue === "number" ? position.currentValue : 0;
        return total + value;
      }, 0)
    : accountValue;
  const displayedTotalPortfolioValue =
    cash !== null || currentInvestmentsValue !== null
      ? (cash ?? 0) + (currentInvestmentsValue ?? 0)
      : accountValue;
  const {
    activePositionQuestionByKey,
    activePositionsNeedingAttention,
    topInvestmentRows,
  } = buildBullpenInvestmentDisplay({
    activePositions,
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
      detail: "Available pUSD balance",
    },
    {
      label: "Events available for claim",
      value: claimableRows.length.toLocaleString("en-IN"),
      detail: formatMoney(claimableAmount),
    },
    {
      label: "Active positions",
      value: activePositionCount.toLocaleString("en-IN"),
      detail: `${formatMoney(activeInvested)} invested`,
    },
    { label: "PnL", value: formatMoney(pnl), detail: "Realized PnL" },
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
            Last successful refresh: {lastRefresh}
          </span>
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
                <h3 className="mt-1 text-xl font-semibold">Claimable events: {claimableRows.length}</h3>
                <p className="mt-2 text-sm text-slate-600">Shows Bullpen live redeemed/claimable rows whose status or detail mentions claim, redeem, or pending.</p>
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
              {claimableRows.length ? (
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
                <p className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">No claimable Bullpen events are available. The live feed did not return any rows containing claim, redeem, or pending status.</p>
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
                  Active positions: {popupRows.length}
                </h3>
                <p className="mt-2 text-sm text-slate-600">
                  Shows green active positions and red Event Exit positions
                  only.
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
  onRunCompleted,
  buildRunNowRequest,
  activePositions = [],
  activePositionQuestions = [],
  hasActivePositionsSnapshot = false,
  recentDecisions = [],
  onSummaryUpdated,
  onOpenScanFilters,
}: BullpenAutoRunScheduleCardProps) {
  const [summary, setSummary] = useState<BullpenAutoLiveSummaryResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<ActionState>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);
  const [pendingRunId, setPendingRunId] = useState<string | null>(null);
  const [startNowProgress, setStartNowProgress] = useState<string | null>(null);
  const startNowProgressTimeoutRef = useRef<number | null>(null);
  const startNowCancelledRef = useRef(false);
  const summaryLoadInFlightRef = useRef(false);
  const [runNowStartedAt, setRunNowStartedAt] = useState<string | null>(null);
  const [timerNowMs, setTimerNowMs] = useState(() => Date.now());
  const [scanCandidateDialog, setScanCandidateDialog] =
    useState<ScanCandidateDialogState | null>(null);
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
  const [runDetailDialog, setRunDetailDialog] =
    useState<RunDetailDialogState | null>(null);
  const [stageTwoInvestEventsDialog, setStageTwoInvestEventsDialog] =
    useState<StageTwoInvestEventsDialogState | null>(null);
  const [stageTwoLlmRunDialog, setStageTwoLlmRunDialog] =
    useState<StageTwoLlmRunDialogState | null>(null);
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
  const [scheduleRefreshInput, setScheduleRefreshInput] = useState("60");
  const [scheduleSettingsDirty, setScheduleSettingsDirty] = useState(false);
  const [scheduleSettingsSaveBusy, setScheduleSettingsSaveBusy] =
    useState(false);
  const [scheduleSavedSummary, setScheduleSavedSummary] = useState<
    string | null
  >(null);
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

  const persistedConsoleOrderUsd =
    summary?.state.last_console_trade_amount_usd ??
    summary?.settings.console_order_usd ??
    DEFAULT_CONSOLE_ORDER_USD;

  useEffect(() => {
    if (scheduleSettingsDirty) return;
    const nextStart = summary?.settings.console_auto_start_at ?? "";
    const nextRefresh = summary?.settings.console_auto_refresh_minutes ?? 60;
    window.queueMicrotask(() => {
      setScheduleStartInput(nextStart);
      setScheduleRefreshInput(String(nextRefresh));
      setScheduleSavedSummary(
        buildScheduleSummary(nextStart, String(nextRefresh)),
      );
    });
  }, [
    scheduleSettingsDirty,
    summary?.settings.console_auto_start_at,
    summary?.settings.console_auto_refresh_minutes,
  ]);

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

  async function loadSummary(options?: {
    preserveLoading?: boolean;
    nextPendingRunId?: string | null;
  }) {
    // setInterval does not wait for an async callback. Do not pile up requests
    // if the API is slow (for example while Celery is reporting run status).
    if (summaryLoadInFlightRef.current) return null;
    summaryLoadInFlightRef.current = true;

    let loadingCleared = Boolean(options?.preserveLoading);
    const resolvedPendingRunId = options?.nextPendingRunId ?? pendingRunId;
    if (!options?.preserveLoading) {
      setLoading(true);
    }
    try {
      const nextSummary = await apiService.getBullpenAutoLiveSummary();
      setSummary(nextSummary);
      setError(null);
      const nextTrackedRun = getVisibleRun(nextSummary, resolvedPendingRunId);
      onSummaryUpdated?.({
        summary: nextSummary,
        run: nextTrackedRun,
        pendingRunId: resolvedPendingRunId,
      });
      if (!loadingCleared) {
        setLoading(false);
        loadingCleared = true;
      }
      return nextSummary;
    } catch (nextError) {
      setError(normalizeError(nextError));
      return null;
    } finally {
      if (!loadingCleared) {
        setLoading(false);
      }
      summaryLoadInFlightRef.current = false;
    }
  }

  useEffect(() => {
    void loadSummary();
    // loadSummary intentionally reads the latest pending run id at execution time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshPortfolioSnapshot = useCallback(
    async (forceBalanceRefresh: boolean) => {
      if (forceBalanceRefresh) {
        setAction("balance");
      }
      setPortfolioLoading(true);
      try {
        const nextState = forceBalanceRefresh
          ? await apiService.polymarketLiveBalanceRefresh()
          : await apiService.polymarketState();
        setPortfolioState(nextState);
        if (isUsableBullpenBalance(nextState.live.balance)) {
          setLastUsablePortfolioBalance(nextState.live.balance);
        }
      } catch (nextError) {
        setError(normalizeError(nextError));
      } finally {
        setPortfolioLoading(false);
        if (forceBalanceRefresh) {
          setAction(null);
        }
      }
    },
    [],
  );

  useEffect(() => {
    const initialTimeoutId = window.setTimeout(() => {
      void refreshPortfolioSnapshot(false);
    }, 0);
    const intervalId = window.setInterval(() => {
      void refreshPortfolioSnapshot(false);
    }, 30_000);
    return () => {
      window.clearTimeout(initialTimeoutId);
      window.clearInterval(intervalId);
    };
  }, [refreshPortfolioSnapshot]);

  const trackedRunId =
    pendingRunId ??
    (
      summary?.latest_run?.status === "running" ||
      summary?.latest_run?.status === "confirming"
    ? summary.latest_run.id
    : null);

  const pollTrackedRun = useEffectEvent(async (runId: string) => {
    const nextSummary = await loadSummary({ preserveLoading: true });
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

    if (pendingRunId === runId) {
      setPendingRunId(null);
      setRunNowStartedAt(null);
      setAction(null);
      setNotice(matchingRun.summary);
      if (onRunCompleted) {
        await onRunCompleted();
      }
    }
  });

  useEffect(() => {
    if (!trackedRunId) return;

    const intervalId = window.setInterval(() => {
      void pollTrackedRun(trackedRunId);
    }, POLL_INTERVAL_MS);
    const timeoutId = window.setTimeout(() => {
      void pollTrackedRun(trackedRunId);
    }, 0);

    return () => {
      window.clearInterval(intervalId);
      window.clearTimeout(timeoutId);
    };
  }, [trackedRunId]);

  const pollScheduledSummary = useEffectEvent(async () => {
    await loadSummary({ preserveLoading: true });
  });

  useEffect(() => {
    if (!summary?.settings.auto_live_enabled || trackedRunId) return;

    const intervalId = window.setInterval(() => {
      void pollScheduledSummary();
    }, POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [summary?.settings.auto_live_enabled, trackedRunId]);


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
          normalizedStart || null,
          refreshMinutes,
          consoleLlmTargets,
        ),
      );
      setScheduleSettingsDirty(false);
      setScheduleStartInput(startWasNow ? "Now" : normalizedStart);
      const nextSummaryText = buildScheduleSummary(
        startWasNow ? "Now" : normalizedStart,
        String(refreshMinutes),
      );
      setScheduleSavedSummary(nextSummaryText);
      await loadSummary({ preserveLoading: true });
      if (!options?.silentSuccess) {
        setNotice(nextSummaryText);
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
    setAction("enable");
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
      const consoleLlmTargets = startWasNow
        ? await ensureCanonicalStage2LlmTargets({
            requireNonEmpty: true,
          })
        : await ensureCanonicalStage2LlmTargets();
      if (startWasNow && !consoleLlmTargets) {
        return;
      }
      await apiService.updateBullpenAutoLiveSettings(
        buildConsoleSettingsUpdate(
          persistedConsoleOrderUsd,
          normalizedStart || null,
          refreshMinutes,
          consoleLlmTargets,
        ),
      );
      setScheduleStartInput(startWasNow ? "Now" : normalizedStart);
      setScheduleSavedSummary(
        buildScheduleSummary(
          startWasNow ? "Now" : normalizedStart,
          String(refreshMinutes),
        ),
      );
      const startedState = await apiService.startBullpenAutoLive();
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
        const runNowRequest = (await buildRunNowRequest?.()) ?? undefined;
        const run = await apiService.runBullpenAutoLiveOnce(runNowRequest);
        setPendingRunId(run.id);
        setRunNowStartedAt(run.started_at ?? new Date().toISOString());
      }
      const nextSummary = await loadSummary({ preserveLoading: true });
      if (!startWasNow && (!consoleLlmTargets || consoleLlmTargets.length === 0)) {
        setNotice(
          nextSummary?.state.next_run_at
            ? `Auto runs enabled. Next scheduled run: ${formatIstDateTime(nextSummary.state.next_run_at)}. Select at least one LLM before that run so Stage 2 can execute.`
            : "Auto runs enabled. Select at least one LLM before the first run so Stage 2 can execute.",
        );
      } else {
        setNotice(
          nextSummary?.state.next_run_at
            ? `Auto runs enabled. Next scheduled run: ${formatIstDateTime(nextSummary.state.next_run_at)}.`
            : "Auto runs enabled.",
        );
      }
    } catch (nextError) {
      setError(normalizeError(nextError));
    } finally {
      setAction(null);
    }
  }

  async function handleStartAutoRunNow() {
    setAction("start-now");
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
      "Validating refresh duration and preparing the Auto Run request…",
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
      const latestConsoleOrderUsd =
        tradeAmountView.tradeAmountUsd ?? persistedConsoleOrderUsd;
      const consoleLlmTargets = await ensureCanonicalStage2LlmTargets({
        requireNonEmpty: true,
      });
      if (!consoleLlmTargets) {
        return;
      }

      if (autoRunActive) {
        setStartNowProgress(
          "Stopping the existing Auto Run before starting a fresh run…",
        );
        await apiService.stopBullpenAutoLive();
        if (abortIfStartCancelled()) return;
      }

      setStartNowProgress(
        "Saving trade amount, schedule, refresh duration, and LLM settings…",
      );
      await apiService.updateBullpenAutoLiveSettings(
        buildConsoleSettingsUpdate(
          latestConsoleOrderUsd,
          normalizedStart || null,
          refreshMinutes,
          consoleLlmTargets,
        ),
      );
      if (abortIfStartCancelled()) return;
      setScheduleStartInput(startWasNow ? "Now" : normalizedStart);
      setScheduleSavedSummary(
        buildScheduleSummary(
          startWasNow ? "Now" : normalizedStart,
          String(refreshMinutes),
        ),
      );

      setStartNowProgress("Starting the Auto-Live scheduler in the backend…");
      await apiService.startBullpenAutoLive();
      if (abortIfStartCancelled()) return;
      setStartNowProgress(
        "Building the latest Bullpen candidate snapshot for this run…",
      );
      const runNowRequest = (await buildRunNowRequest?.()) ?? undefined;
      if (abortIfStartCancelled()) return;
      setStartNowProgress(
        "Stage 1 Bullpen Scan snapshot is ready. Queueing the Auto Run worker now…",
      );
      const run = await apiService.runBullpenAutoLiveOnce(runNowRequest);
      if (abortIfStartCancelled()) return;
      setPendingRunId(run.id);
      setRunNowStartedAt(run.started_at ?? new Date().toISOString());
      setStartNowProgress(
        "Run queued. Fetching live backend status and worker stage updates…",
      );
      await loadSummary({
        preserveLoading: true,
        nextPendingRunId: run.id,
      });
      setStartNowProgress(
        "Auto Run started. Live worker progress is now shown below.",
      );
      startNowProgressTimeoutRef.current = window.setTimeout(() => {
        setStartNowProgress(null);
        startNowProgressTimeoutRef.current = null;
      }, 5_000);
      setNotice(
        `Started a fresh Auto Run now with ${formatMoney(
          latestConsoleOrderUsd,
        )} per new opportunity and a ${refreshMinutes}-minute refresh duration.`,
      );
    } catch (nextError) {
      setError(normalizeError(nextError));
      setRunNowStartedAt(null);
      setStartNowProgress(null);
    } finally {
      setAction(null);
    }
  }

  async function handleStopAutoRuns() {
    setAction("stop");
    setNotice(null);
    setError(null);

    try {
      await apiService.stopBullpenAutoLive();
      await loadSummary({ preserveLoading: true });
      setNotice(
        "Auto runs stopped. Any active Auto-Live run was cancelled immediately.",
      );
    } catch (nextError) {
      setError(normalizeError(nextError));
    } finally {
      setAction(null);
    }
  }

  async function handleInvestOnly(request: BullpenAutoLiveRunOnceRequest) {
    const startedAt = new Date().toISOString();
    setAction("invest-now");
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
        setAction(null);
        setPendingRunId(null);
        setRunNowStartedAt(null);
        return;
      }
      await apiService.updateBullpenAutoLiveSettings(
        buildConsoleSettingsUpdate(
          persistedConsoleOrderUsd,
          scheduleStartInput.trim() || null,
          refreshMinutes,
          consoleLlmTargets,
        ),
      );
      const run = await apiService.runBullpenAutoLiveOnce(request);
      const qualifiedCandidateCount =
        request.console_profile?.candidate_rows.length ?? 0;
      setPendingRunId(run.id);
      setRunNowStartedAt(run.started_at ?? new Date().toISOString());
      setNotice(
        `Queued invest-only run for ${qualifiedCandidateCount} Stage 2-qualified ${
          qualifiedCandidateCount === 1 ? "event" : "events"
        }.`,
      );
      await loadSummary({ preserveLoading: true, nextPendingRunId: run.id });
      setAction(null);
    } catch (nextError) {
      setError(normalizeError(nextError));
      setAction(null);
      setPendingRunId(null);
      setRunNowStartedAt(null);
    }
  }

  async function handlePauseRun() {
    const shouldResume = Boolean(summary?.state.paused);
    setAction(shouldResume ? "resume-run" : "pause-run");
    setNotice(null);
    setError(null);

    try {
      if (shouldResume) {
        await apiService.resumeBullpenAutoLive();
      } else {
        await apiService.pauseBullpenAutoLive();
      }
      await loadSummary({ preserveLoading: true });
      setNotice(
        shouldResume
          ? "Auto-Live resumed. The active run can continue at the next safe backend checkpoint."
          : "Auto-Live paused. The active run will stop before any new backend work starts where runtime guards are checked.",
      );
    } catch (nextError) {
      setError(normalizeError(nextError));
    } finally {
      setAction(null);
    }
  }

  async function handleKillRun() {
    startNowCancelledRef.current = true;
    setAction("kill-run");
    setNotice(null);
    setError(null);

    try {
      await apiService.stopBullpenAutoLive();
      await loadSummary({ preserveLoading: true });
      setNotice(
        "Auto-Live stopped. Active backend work was cancelled immediately.",
      );
    } catch (nextError) {
      setError(normalizeError(nextError));
    } finally {
      setAction(null);
    }
  }

  const autoRunActive = isAutoRunActive(summary);
  const consoleProfileSelected = isConsoleProfileSelected(summary);
  const mode = modeLabel(summary);
  const visibleRun = getVisibleRun(summary, pendingRunId);
  const latestRun = summary?.latest_run ?? null;
  const workflowRun =
    visibleRun ??
    (pendingRunId && latestRun?.id !== pendingRunId ? null : latestRun);
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
    setScanCandidateDialog({
      mode,
      scanCompletedAt: stage.timerCompletedAt,
      candidates: buildScanCandidateDialogRows({
        candidates: stage.scanCandidates,
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
    (stage) => stage.isCurrent,
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
    selectedRunSummaryTile === "last" && !runIsActive
      ? latestTerminalRun ?? workflowRun
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
  const workflowRunNeedsLogin = runNeedsBullpenLogin(workflowRunForMonitor);
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
    summary?.state.last_run_at;
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
          summary?.recent_decisions.filter(
            (decision) => decision.run_id === run.id,
          ) ?? [],
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
  const investOnlyDisabledReason = runIsActive
    ? "Wait for the active Auto-Live run to finish before starting another Invest pass."
    : effectiveInvestOnlyRequest
      ? null
      : investOnlyPlan.blockedReason;
  const liveTradeAmountSource = portfolioState?.live.balance ?? null;
  const liveTradeAmountBalance = isUsableBullpenBalance(liveTradeAmountSource)
    ? liveTradeAmountSource
    : lastUsablePortfolioBalance;
  const liveTradeAmountActivePositions = hasActivePositionsSnapshot
    ? activePositions.length
    : portfolioState
      ? portfolioState.open_positions.filter((position) => position.shares > 0)
          .length
      : (summary?.state.active_positions ?? null);
  const tradeAmountView = buildConsoleTradeAmountView({
    cashInHandUsd: liveTradeAmountBalance?.available_balance_usd ?? null,
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
      ? "Preview from current portfolio"
      : tradeAmountView.source === "last-calculated"
        ? "Showing last diagnostic amount"
        : "Waiting for live portfolio data";

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
          activePositions={activePositions}
          activePositionQuestions={activePositionQuestions}
          hasActivePositionsSnapshot={hasActivePositionsSnapshot}
          refreshing={action === "balance"}
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
              <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700">
                Status: {statusLabel(summary, runIsActive)}
                {loading && !summary ? (
                  <Loader2
                    aria-label="Checking auto-run status"
                    className="size-3.5 animate-spin text-slate-500"
                  />
                ) : null}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700">
                Mode: {mode}
                {loading && !summary ? (
                  <Loader2
                    aria-label="Checking auto-run mode"
                    className="size-3.5 animate-spin text-slate-500"
                  />
                ) : null}
              </span>
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsRunHistoryDialogOpen(true)}
              aria-label="Show Bullpen run history"
              className="border-[#f4d458] bg-[#f4d458] text-slate-950 hover:border-[#e7c845] hover:bg-[#e7c845]"
            >
              <History className="mr-2 h-4 w-4" />
              History
            </Button>

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
                    setScheduleStartInput(event.target.value);
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
                    setScheduleSettingsDirty(true);
                  }}
                  disabled={action !== null}
                  className="ml-2 h-8 rounded-lg px-3 text-xs shadow-none"
                >
                  Now
                </Button>
                <button
                  type="button"
                  onClick={() => setIsSchedulePickerOpen((open) => !open)}
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
                      defaultValue={formatDateTimeLocalValue(new Date())}
                      onChange={(event) => {
                        setScheduleStartInput(
                          formatScheduleInputFromDateTimeLocal(
                            event.target.value,
                          ),
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
          {scheduleSettingsSaveBusy ? (
            <p className="mt-3 text-right text-xs font-semibold text-slate-500">
              Saving auto-run settings…
            </p>
          ) : null}
        </div>

        {showActiveRunControls ? (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={handlePauseRun}
              disabled={
                action === "pause-run" ||
                action === "resume-run" ||
                action === "kill-run" ||
                action === "stop"
              }
              className="rounded-full bg-orange-500 text-white hover:bg-orange-600"
            >
              {action === "pause-run" || action === "resume-run" ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : summary?.state.paused ? (
                <PlayCircle className="mr-2 h-4 w-4" />
              ) : (
                <PauseCircle className="mr-2 h-4 w-4" />
              )}
              {summary?.state.paused ? "Resume" : "Pause"}
            </Button>
            <Button
              type="button"
              onClick={handleKillRun}
              disabled={
                action === "pause-run" ||
                action === "resume-run" ||
                action === "kill-run" ||
                action === "stop"
              }
              className="rounded-full bg-rose-600 text-white hover:bg-rose-700"
            >
              {action === "kill-run" ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <X className="mr-2 h-4 w-4" />
              )}
              Kill
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
              {formatIstDateTime(summary?.state.next_run_at)}
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
                  Failed : Login Needed
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
                        label: "Planned",
                        value: stage3PreviewDialogState.plannedOrders,
                      },
                      { label: "Submitted", value: 0 },
                    ]
                  : getInvestStageCounters(stage);
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
                  : immediateSuccess || investPreviewFinished
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
                          onOpenInvestEvents={(rows) =>
                            setStageTwoInvestEventsDialog({
                              rows,
                            })
                          }
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
                          counter.label.toLowerCase() as InvestMetricDialogKind;
                        const plannedStrategySourceKey = `workflow-stage-${stage.key}-planned`;
                        const isPlannedCounter =
                          stage.key === "invest" && counter.label === "Planned";

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
                              aria-label="Open Stage 3 planned details"
                            />
                            <div className="pointer-events-none relative z-10">
                              <div className="flex items-center gap-1.5">
                                <p
                                  className={`text-[10px] font-semibold uppercase tracking-[0.14em] ${toneClasses.muted}`}
                                >
                                  Planned
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
                          {stage3PreviewDialogState.plannedOrders} planned{" "}
                          {stage3PreviewDialogState.plannedOrders === 1
                            ? "row is"
                            : "rows are"}{" "}
                          ready for this invest-only pass.
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
          <div
            className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/55 p-4"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget)
                setIsRunHistoryDialogOpen(false);
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="bullpen-run-history-title"
              className="max-h-[85vh] w-full max-w-4xl overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.45)]"
            >
              <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                    Run History
                  </p>
                  <h2
                    id="bullpen-run-history-title"
                    className="mt-2 text-xl font-semibold text-slate-950"
                  >
                    Bullpen Auto and Manual Runs
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => setIsRunHistoryDialogOpen(false)}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
                  aria-label="Close Bullpen run history"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="max-h-[65vh] overflow-y-auto px-6 py-5">
                {summary?.recent_runs.length ? (
                  <div className="space-y-3">
                    {summary.recent_runs.map((run) => {
                      const runKind =
                        run.triggered_by === "scheduler"
                          ? "Auto Run"
                          : "Manual Run";
                      const stage =
                        buildBullpenAutoRunWorkflowView(run).stages.find(
                          (workflowStage) => workflowStage.key === "invest",
                        ) ?? null;
                      const runDecisions = mergeInvestStageDecisionRows({
                        stage,
                        persistedDecisions:
                          summary?.recent_decisions.filter(
                            (decision) => decision.run_id === run.id,
                          ) ?? [],
                      });
                      return (
                        <div
                          key={run.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => openRunDetailDialog(run)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ")
                              openRunDetailDialog(run);
                          }}
                          className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-left transition hover:border-blue-200 hover:bg-blue-50/40"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800">
                                  {runKind}
                                </span>
                                <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold capitalize text-slate-700">
                                  {run.status}
                                </span>
                                <span className="rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-bold text-blue-900 shadow-sm">
                                  {formatIstDateTime(run.started_at)}
                                </span>
                              </div>
                              <p className="mt-2 text-sm font-semibold leading-5 text-slate-950 line-clamp-2">
                                {run.summary || "Run summary unavailable."}
                              </p>
                              <p className="mt-1 text-xs text-slate-600">
                                Run {run.id}
                              </p>
                            </div>
                            <RunHistoryMetricTiles
                              run={run}
                              decisions={runDecisions}
                              onOpenMetricDetails={(kind) =>
                                openRunInvestMetricDialog(run, kind)
                              }
                            />
                          </div>
                          {run.error_message ? (
                            <div className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-800">
                              <ErrorCodeWithDetails
                                detail={run.error_message}
                                detailClassName="text-rose-800"
                              />
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="rounded-2xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-600">
                    No Bullpen run history is available yet.
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : null}

        {isEventExitStrategiesDialogOpen ? (
          <BullpenEventExitStrategiesDialog
            onClose={() => setIsEventExitStrategiesDialogOpen(false)}
          />
        ) : null}

        <BullpenStage2To3StrategyDialog
          open={Boolean(stage2To3StrategyDialog)}
          onClose={() => setStage2To3StrategyDialog(null)}
          triggerRef={stage2To3StrategyDialogTriggerRef}
          minLlmSideOdds={
            stage2To3StrategyDialog?.strategyMetadata.minLlmSideOdds ??
            DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MIN_LLM_SIDE_ODDS
          }
          maxPositions={
            stage2To3StrategyDialog?.strategyMetadata.maxPositions ??
            DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MAX_POSITIONS
          }
          rankingFieldLabel={formatBullpenStage2To3RankingFieldLabel(
            stage2To3StrategyDialog?.strategyMetadata.rankingField ??
              DEFAULT_BULLPEN_STAGE2_TO_STAGE3_RANKING_FIELD,
          )}
          rankingTieBreakLabel={formatBullpenStage2To3RankingTieBreakLabel(
            stage2To3StrategyDialog?.strategyMetadata.rankingTieBreak ??
              DEFAULT_BULLPEN_STAGE2_TO_STAGE3_RANKING_TIE_BREAK,
          )}
          sizingFormulaLabel={formatBullpenStage2To3SizingFormulaLabel(
            stage2To3StrategyDialog?.strategyMetadata.maxPositions ??
              DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MAX_POSITIONS,
          )}
          universeStatus={stage2To3StrategyDialog?.universeStatus ?? null}
        />

        {scanCandidateDialog ? (
          <StageOneOutputDialog
            state={scanCandidateDialog}
            onClose={() => setScanCandidateDialog(null)}
          />
        ) : null}

        {runDetailDialog ? (
          <RunDetailDialog
            state={runDetailDialog}
            onClose={() => setRunDetailDialog(null)}
            onOpenScanFilters={onOpenScanFilters}
            onOpenStageTwoInvestEvents={(rows) =>
              setStageTwoInvestEventsDialog({ rows })
            }
            onOpenStageTwoLlmRunDetails={setStageTwoLlmRunDialog}
            onOpenMetricDetails={openRunInvestMetricDialog}
          />
        ) : null}

        {refreshedStageTwoLlmRunDialog ? (
          <StageTwoLlmRunDetailsDialog
            state={refreshedStageTwoLlmRunDialog}
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
                      ? "Calculated from the latest Bullpen portfolio snapshot as a preview. The worker rechecks occupied slots and fresh balance before any live buy."
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
          <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
            <p className="font-medium">{error.message}</p>
            {error.details ? (
              <p className="mt-1 text-xs leading-5 text-rose-800">
                {error.details}
              </p>
            ) : null}
          </div>
        ) : null}

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading auto-run status...
          </div>
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
      </CardContent>
    </Card>
  );
}

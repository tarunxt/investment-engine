"use client";

import Link from "next/link";
import {
  useEffect,
  useEffectEvent,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  CalendarClock,
  CheckCircle2,
  Clock3,
  History,
  Info,
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
  getBullpenAmountToBeInvestedBreakdown,
  getBullpenReturnsPerDayBreakdown,
} from "@/lib/bullpen-ai";
import { formatApiTimestamp } from "@/lib/datetime";
import type { BullpenActivePositionView } from "@/lib/bullpenPositions";
import { formatUnknownError, splitApiErrorSummary } from "@/lib/apiErrors";
import { URLs } from "@/lib/urls";
import { APIError, apiService } from "@/services/api";
import type {
  BullpenAutoLiveDecision,
  BullpenAutoLiveRun,
  BullpenAutoLiveRunOnceRequest,
  BullpenAutoLiveSummaryResponse,
} from "@/types/api";

import {
  buildBullpenAutoRunWorkflowView,
  isBullpenAutoRunWorkflowSettled,
} from "./bullpenAutoRunProgress";
import {
  buildBullpenStage3InvestPreviewSteps,
  NO_STAGE2_QUALIFIED_EVENTS_REASON,
  buildBullpenStage3OnlyInvestExecutionPlan,
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
import { BullpenAutoRunStageOutputDialog } from "./BullpenAutoRunStageOutputDialog";
import {
  formatElapsedRunTime,
  formatStageElapsedTime,
} from "./bullpenAutoRunTimers";

type BullpenAutoRunScheduleCardProps = {
  onRunCompleted?: () => void | Promise<void>;
  buildRunNowRequest?: () =>
    | Promise<BullpenAutoLiveRunOnceRequest | null>
    | BullpenAutoLiveRunOnceRequest
    | null;
  activePositions?: BullpenActivePositionView[];
  hasActivePositionsSnapshot?: boolean;
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
  | "run-now"
  | "stop"
  | "pause-run"
  | "resume-run"
  | "kill-run"
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

type ScanCandidateDialogMode = "fresh-opportunities" | "active-positions";

type ScanCandidateDialogState = {
  mode: ScanCandidateDialogMode;
  scanCompletedAt: string | null;
  candidates: ScanCandidateDialogCandidate[];
  activePositions: ReturnType<
    typeof buildBullpenAutoRunWorkflowView
  >["stages"][number]["activePositionsFound"];
  activePositionCount: number;
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
const POLL_INTERVAL_MS = 4_000;
const RUN_TIMER_INTERVAL_MS = 1_000;

function formatIstScheduleSummaryDate(value: string) {
  const normalized = value.replace(",", "").trim();
  const match = normalized.match(
    /^(\d{2}:\d{2}:\d{2})\s+(\d{1,2})\s+([A-Za-z]+)(?:\s+\d{4})?$/,
  );
  if (match) {
    return `${match[1]} ${match[2].padStart(2, "0")} ${match[3]}`;
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
  return `Auto Runs Start${startLabel === "Now" ? "" : " at"} ${startLabel} and refreshes every ${refreshMinutes} minutes`;
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
    second: undefined,
  });
}

function formatOddsPercent(value: number | null) {
  if (value === null) return "—";
  return `${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`;
}

function formatReturnsPerDay(value: number | null) {
  if (value === null) return "—";
  return `${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`;
}

function formatMoney(value: number | null) {
  if (value === null) return "—";
  return `$${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function formatInvestAmount(value: number | null) {
  if (value === null) return "—";
  return value.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatEditableAmount(value: number) {
  return value.toFixed(2).replace(/\.?0+$/, "");
}

function parseConsoleOrderAmount(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const rounded = Number(parsed.toFixed(2));
  if (rounded <= 0) return null;
  return rounded;
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
}: {
  candidates: ReturnType<
    typeof buildBullpenAutoRunWorkflowView
  >["stages"][number]["scanCandidates"];
  run: BullpenAutoLiveRun | null;
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

    [
      normalizeMatchKey(readStageOutputString(reviewedCandidate.market_id)),
      normalizeMatchKey(readStageOutputString(reviewedCandidate.slug)),
      normalizeMatchKey(readStageOutputString(reviewedCandidate.market_url)),
      normalizeMatchKey(readStageOutputString(reviewedCandidate.question)),
    ]
      .filter((key): key is string => Boolean(key))
      .forEach((key) => {
        if (!reviewedCandidateByLookupKey.has(key)) {
          reviewedCandidateByLookupKey.set(key, lookupValue);
        }
      });
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

function getInvestStageExecutionSteps(
  stage: ReturnType<typeof buildBullpenAutoRunWorkflowView>["stages"][number],
) {
  if (stage.key !== "invest") return [];

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
          className={`mt-2 block whitespace-pre-wrap break-words rounded-lg border border-current/15 bg-white/60 px-2.5 py-2 text-[11px] leading-5 ${detailClassName}`}
        >
          {detail}
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

function getInvestStageExecutionStatus(
  stage: ReturnType<typeof buildBullpenAutoRunWorkflowView>["stages"][number],
) {
  if (stage.key !== "invest") return null;

  const immediateSuccess = getInvestStageImmediateSuccess(stage);
  if (immediateSuccess) {
    return {
      label: "Execution complete",
      message: immediateSuccess.message,
      className: "border-emerald-200 bg-emerald-50/80 text-emerald-900",
      detailClassName: "text-emerald-800",
    };
  }

  const stageError = readStageOutputString(stage.outputs.error_message);
  if (stageError) {
    return {
      label: "Worker error",
      message: stageError,
      className: "border-rose-200 bg-rose-50/80 text-rose-900",
      detailClassName: "text-rose-800",
    };
  }

  const executionGateReason = readStageOutputString(
    stage.outputs.execution_gate_reason,
  );
  if (executionGateReason) {
    return {
      label: "Execution gate",
      message: executionGateReason,
      className: "border-rose-200 bg-rose-50/80 text-rose-900",
      detailClassName: "text-rose-800",
    };
  }

  const executionModeReason = readStageOutputString(
    stage.outputs.execution_mode_reason,
  );
  if (executionModeReason) {
    return {
      label: "Execution mode",
      message: executionModeReason,
      className: "border-sky-200 bg-sky-50/80 text-sky-900",
      detailClassName: "text-sky-800",
    };
  }

  const latestOrderDecision = [...readInvestStageDecisionRows(stage)]
    .reverse()
    .find((decision) => decision.order_plan);
  const latestOrderStatus = latestOrderDecision?.order_plan?.status ?? null;
  const latestOrderDetail =
    latestOrderDecision?.order_plan?.detail?.trim() ?? null;
  if (
    latestOrderDecision &&
    latestOrderStatus &&
    latestOrderStatus !== "submitted" &&
    latestOrderDetail
  ) {
    const isFailure =
      latestOrderStatus === "failed" || latestOrderStatus === "cancelled";
    return {
      label: "Latest order",
      message: `${latestOrderDecision.market_title}: ${latestOrderDetail}`,
      className: isFailure
        ? "border-rose-200 bg-rose-50/80 text-rose-900"
        : "border-amber-200 bg-amber-50/80 text-amber-900",
      detailClassName: isFailure ? "text-rose-800" : "text-amber-800",
    };
  }

  return null;
}

function getInvestStageCounters(
  stage: ReturnType<typeof buildBullpenAutoRunWorkflowView>["stages"][number],
) {
  if (stage.key !== "invest") return [];

  const decisions = readStageOutputNumber(stage.outputs.decisions_count);
  const planned = readStageOutputNumber(stage.outputs.orders_planned);
  const submitted = readStageOutputNumber(stage.outputs.orders_submitted);
  if (decisions === null && planned === null && submitted === null) {
    return [];
  }

  return [
    { label: "Decisions", value: decisions ?? 0 },
    { label: "Planned", value: planned ?? 0 },
    { label: "Submitted", value: submitted ?? 0 },
  ];
}

function formatInvestStageRowMix(
  stage: ReturnType<typeof buildBullpenAutoRunWorkflowView>["stages"][number],
) {
  if (stage.key !== "invest") return null;

  const activePositionRows = readStageOutputNumber(
    stage.outputs.active_position_rows,
  );
  const candidateRows = readStageOutputNumber(
    stage.outputs.candidate_decision_rows,
  );
  if (activePositionRows === null && candidateRows === null) return null;

  return `${activePositionRows ?? 0} Bullpen position ${activePositionRows === 1 ? "row" : "rows"} + ${candidateRows ?? 0} candidate ${candidateRows === 1 ? "row" : "rows"}`;
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
  onOpenInvestEligibilityInfo?: () => void;
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
                      onClick={onOpenInvestEligibilityInfo}
                      className={`inline-flex h-6 w-6 items-center justify-center rounded-full border border-white/80 bg-white/70 ${toneClasses.text}`}
                      aria-label="Explain Stage 2 planned-order eligibility"
                      title="Explain Stage 2 planned-order eligibility"
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
            <p className={`mt-3 text-xs leading-5 ${toneClasses.muted}`}>
              {step.detail ?? "Waiting for the worker to update this step."}
            </p>
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
              {renderMetricCard({
                label: "Submitted",
                value: step.submittedOrders,
                kind: getInvestStepMetricDialogKind(step.key, "submitted"),
                toneClasses,
              })}
            </div>
            {step.key === "sell" ? (
              <div className={`mt-3 grid gap-2 text-xs ${toneClasses.muted}`}>
                <div
                  className={`rounded-lg border border-white/70 bg-white/60 px-2.5 py-2 ${toneClasses.text}`}
                >
                  <p className="text-[10px] font-semibold uppercase tracking-[0.12em]">
                    Active positions shortlisted for exits
                  </p>
                  <p className="mt-1 text-sm font-semibold">
                    {(step.eventExitRows ?? step.plannedOrders ?? 0) > 0
                      ? `Yes · ${step.eventExitRows ?? step.plannedOrders} shortlisted`
                      : "No · 0 shortlisted"}
                  </p>
                  <p
                    className={`mt-1 text-[11px] leading-4 ${toneClasses.muted}`}
                  >
                    Stage 3 Step 1 reviews active positions before any buy
                    orders.
                  </p>
                </div>
                {renderMetricCard({
                  label: "Exit rows",
                  value: step.eventExitRows,
                  kind: getSellInvestMetricDialogKind("event-exit-rows"),
                  toneClasses,
                })}
                <div className="flex flex-wrap gap-2">
                  {renderMetricCard({
                    label: "Event out of Top 10",
                    value: step.rankingLlmPlannedOrders,
                    kind: getSellInvestMetricDialogKind("ranking-llm"),
                    toneClasses,
                    onOpenInfo: onOpenEventExitInfo,
                  })}
                  {renderMetricCard({
                    label: "Forced Exit",
                    value: step.forcedExitPlannedOrders,
                    kind: getSellInvestMetricDialogKind("forced-exit"),
                    toneClasses,
                    onOpenInfo: onOpenEventExitInfo,
                  })}
                </div>
              </div>
            ) : null}
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
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                Fresh Bullpen Opportunities
              </p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {state.candidates.length}
              </p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                Active Bullpen positions found
              </p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {state.activePositionCount}
              </p>
            </div>
          </div>

          <div className="mt-5 space-y-5">
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

              {state.activePositions.length > 0 ? (
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
                      {state.activePositions.map((position) => (
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
  const matchingSignals = decision.exit_signals.filter((signal) =>
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
      ? "Force Exit + Event Out of Top 10"
      : "Force Exit"
    : "Event Out of Top 10";

  return {
    label,
    details: matchingSignals
      .map((signal) => `${signal.label}: ${signal.description}`)
      .join(" "),
  };
}

function StageTwoExecutionShortlist({
  steps,
  decisions,
  onOpenEventExitInfo,
  onOpenInvestEligibilityInfo,
}: {
  steps: InvestExecutionStepView[];
  decisions: BullpenAutoLiveDecision[];
  onOpenEventExitInfo: () => void;
  onOpenInvestEligibilityInfo: () => void;
}) {
  if (steps.length === 0) return null;

  const sellDecisions = decisions.filter(
    (decision) => decision.order_plan?.action === "sell",
  );
  const buyDecisions = decisions.filter(
    (decision) => decision.order_plan?.action === "buy",
  );

  return (
    <div className="mt-3 grid gap-2 text-xs">
      {steps.map((step) => {
        const stepDecisions = step.key === "sell" ? sellDecisions : buyDecisions;
        const infoHandler =
          step.key === "sell" ? onOpenEventExitInfo : onOpenInvestEligibilityInfo;
        return (
          <div
            key={`stage-2-shortlist-${step.key}`}
            className="rounded-xl border border-white/70 bg-white/60 px-3 py-3 text-emerald-950 dark:border-slate-700/80 dark:bg-slate-950/70 dark:text-emerald-50"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-900/80 dark:text-emerald-100/75">
                  Step {step.stepNumber} of {step.stepTotal}
                </p>
                <div className="mt-1 flex items-center gap-2">
                  <p className="font-semibold">{step.label}</p>
                  <button
                    type="button"
                    onClick={infoHandler}
                    className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-emerald-200 bg-white/70 text-emerald-900"
                    aria-label={`Explain ${step.label}`}
                    title={`Explain ${step.label}`}
                  >
                    <Info className="h-3 w-3" />
                  </button>
                </div>
              </div>
              <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-900">
                {step.plannedOrders ?? 0} planned
              </span>
            </div>
            <p className="mt-2 text-[11px] leading-4 text-emerald-900/80 dark:text-emerald-100/75">
              {step.detail ??
                (step.key === "sell"
                  ? "Stage 3 Step 1 will process shortlisted Event Exits first."
                  : "Stage 3 Step 2 will process shortlisted buy orders after exits.")}
            </p>
            {stepDecisions.length > 0 ? (
              <div className="mt-2 space-y-1.5">
                {stepDecisions.slice(0, 3).map((decision) => {
                  const exitType = getDecisionExitTypeDetails(decision);
                  return (
                    <div
                      key={`stage-2-shortlist-${step.key}-${decision.id}`}
                      className="rounded-lg border border-emerald-100 bg-white/70 px-2.5 py-2"
                    >
                      <p className="font-semibold text-slate-950">
                        {decision.market_title}
                      </p>
                      <p className="mt-0.5 text-[11px] leading-4 text-slate-600">
                        {exitType
                          ? `${exitType.label}: ${exitType.details}`
                          : decision.reason}
                      </p>
                    </div>
                  );
                })}
                {stepDecisions.length > 3 ? (
                  <p className="text-[11px] text-emerald-900/80">
                    +{stepDecisions.length - 3} more shortlisted events
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
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
  onOpenInvestEligibilityInfo?: () => void;
}) {
  const metricDefinition = getInvestMetricDialogDefinition(state.kind);
  const rows = getInvestMetricRows(state.kind, state.decisions);
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
  const filteredPlannedCount = rows.filter(
    (decision) => decision.order_plan,
  ).length;
  const filteredProcessedCount = rows.filter((decision) =>
    isProcessedInvestOrderPlan(decision.order_plan),
  ).length;
  const filteredSubmittedCount = rows.filter(
    (decision) => decision.order_plan?.status === "submitted",
  ).length;
  const filteredUnsubmittedRows = rows.filter(
    (decision) =>
      decision.order_plan && decision.order_plan.status !== "submitted",
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
  const executionSteps = state.stage
    ? getInvestStageExecutionSteps(state.stage)
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

          <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Selected filter
            </p>
            <p className="mt-2 text-sm font-semibold text-slate-950">
              {rows.length.toLocaleString("en-IN")} rows ·{" "}
              {filteredPlannedCount.toLocaleString("en-IN")} planned ·{" "}
              {filteredProcessedCount.toLocaleString("en-IN")} processed ·{" "}
              {filteredSubmittedCount.toLocaleString("en-IN")} submitted
            </p>
          </div>

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

          <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200">
            {rows.length > 0 ? (
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Event</th>
                    <th className="px-4 py-3">Decision</th>
                    <th className="px-4 py-3">Edge & score</th>
                    <th className="px-4 py-3">Exposure</th>
                    <th className="px-4 py-3">Exit Type</th>
                    <th className="px-4 py-3">Order</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {rows.map((decision) => (
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
                        Fair {formatOddsPercent(decision.fair_probability_pct)}
                      </td>
                      <td className="px-4 py-3 align-top text-slate-700">
                        Current {formatMoney(decision.current_exposure_usd)}
                        <br />
                        Target {formatMoney(decision.target_exposure_usd)}
                      </td>
                      <td className="px-4 py-3 align-top text-slate-700">
                        {(() => {
                          const exitType = getDecisionExitTypeDetails(decision);
                          return exitType ? (
                            <>
                              <span className="font-semibold text-slate-950">
                                {exitType.label}
                              </span>
                              <br />
                              <span className="text-xs leading-5">
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
                            )} at{" "}
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
            ) : (
              <div className="bg-slate-50 px-4 py-8 text-sm text-slate-600">
                Stage 3 has not emitted any decision rows for this metric yet.
                The worker may still be preparing the first review row.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function buildConsoleSettingsUpdate(
  consoleOrderUsd: number,
  startAt?: string | null,
  refreshMinutes?: number | null,
) {
  return {
    strategy_profile: "bullpen_console_top10" as const,
    console_order_usd: consoleOrderUsd,
    console_auto_start_at: startAt ?? null,
    console_auto_refresh_minutes: refreshMinutes ?? null,
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
  if (status === "completed") return "Completed";
  if (status === "failed") return "Failed";
  return "Skipped";
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
  if (summary.latest_run?.status === "running") return summary.latest_run;
  return summary.recent_runs.find((run) => run.status === "running") ?? null;
}

function getWorkflowToneClasses(tone: "yellow" | "green" | "blue") {
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

export function BullpenAutoRunScheduleCard({
  onRunCompleted,
  buildRunNowRequest,
  activePositions = [],
  hasActivePositionsSnapshot = false,
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
  const [isScheduleInfoDialogOpen, setIsScheduleInfoDialogOpen] =
    useState(false);
  const [isRunHistoryDialogOpen, setIsRunHistoryDialogOpen] = useState(false);
  const [isSchedulePickerOpen, setIsSchedulePickerOpen] = useState(false);
  const [isEventExitStrategiesDialogOpen, setIsEventExitStrategiesDialogOpen] =
    useState(false);
  const [
    isInvestEligibilityInfoDialogOpen,
    setIsInvestEligibilityInfoDialogOpen,
  ] = useState(false);
  const [consoleOrderInput, setConsoleOrderInput] = useState(() =>
    formatEditableAmount(DEFAULT_CONSOLE_ORDER_USD),
  );
  const [consoleOrderDirty, setConsoleOrderDirty] = useState(false);
  const [consoleOrderSaveBusy, setConsoleOrderSaveBusy] = useState(false);
  const [consoleOrderFieldError, setConsoleOrderFieldError] = useState<
    string | null
  >(null);
  const [scheduleStartInput, setScheduleStartInput] = useState("");
  const [scheduleRefreshInput, setScheduleRefreshInput] = useState("60");
  const [scheduleSavedSummary, setScheduleSavedSummary] = useState<
    string | null
  >(null);

  const savedConsoleOrderUsd =
    summary?.settings.console_order_usd ?? DEFAULT_CONSOLE_ORDER_USD;

  useEffect(() => {
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
    summary?.settings.console_auto_start_at,
    summary?.settings.console_auto_refresh_minutes,
  ]);

  useEffect(() => {
    if (consoleOrderDirty) return;
    window.queueMicrotask(() => {
      setConsoleOrderInput(formatEditableAmount(savedConsoleOrderUsd));
      setConsoleOrderFieldError(null);
    });
  }, [consoleOrderDirty, savedConsoleOrderUsd]);

  function resolveConsoleOrderAmount() {
    const parsedAmount = parseConsoleOrderAmount(consoleOrderInput);
    if (parsedAmount === null) {
      setConsoleOrderFieldError("Enter an amount greater than $0.");
      return null;
    }
    return parsedAmount;
  }

  async function saveConsoleOrderAmount(options?: { silentSuccess?: boolean }) {
    const nextConsoleOrderUsd = resolveConsoleOrderAmount();
    if (nextConsoleOrderUsd === null) {
      return null;
    }
    if (!consoleOrderDirty && nextConsoleOrderUsd === savedConsoleOrderUsd) {
      return nextConsoleOrderUsd;
    }

    setConsoleOrderSaveBusy(true);
    setError(null);
    try {
      await apiService.updateBullpenAutoLiveSettings({
        console_order_usd: nextConsoleOrderUsd,
      });
      setConsoleOrderDirty(false);
      setConsoleOrderFieldError(null);
      setConsoleOrderInput(formatEditableAmount(nextConsoleOrderUsd));
      await loadSummary({ preserveLoading: true });
      if (!options?.silentSuccess) {
        setNotice(
          `Future Bullpen x AI trades and automations will use ${formatMoney(nextConsoleOrderUsd)} per trade.`,
        );
      }
      return nextConsoleOrderUsd;
    } catch (nextError) {
      setError(normalizeError(nextError));
      return null;
    } finally {
      setConsoleOrderSaveBusy(false);
    }
  }

  function handleConsoleOrderInputChange(event: ChangeEvent<HTMLInputElement>) {
    setConsoleOrderInput(event.target.value);
    setConsoleOrderDirty(true);
    setConsoleOrderFieldError(null);
  }

  function handleConsoleOrderInputBlur() {
    if (!consoleOrderDirty || consoleOrderSaveBusy || action !== null) return;
    void saveConsoleOrderAmount({ silentSuccess: true });
  }

  function handleConsoleOrderInputKeyDown(
    event: KeyboardEvent<HTMLInputElement>,
  ) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void saveConsoleOrderAmount();
  }

  async function loadSummary(options?: {
    preserveLoading?: boolean;
    nextPendingRunId?: string | null;
  }) {
    if (!options?.preserveLoading) {
      setLoading(true);
    }
    try {
      const nextSummary = await apiService.getBullpenAutoLiveSummary();
      setSummary(nextSummary);
      setError(null);
      const nextTrackedRun = getVisibleRun(
        nextSummary,
        options?.nextPendingRunId ?? pendingRunId,
      );
      onSummaryUpdated?.({
        summary: nextSummary,
        run: nextTrackedRun,
        pendingRunId: options?.nextPendingRunId ?? pendingRunId,
      });
      return nextSummary;
    } catch (nextError) {
      setError(normalizeError(nextError));
      return null;
    } finally {
      if (!options?.preserveLoading) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadSummary();
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
    // loadSummary intentionally reads the latest pending run id at execution time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const trackedRunId =
    pendingRunId ??
    (summary?.latest_run?.status === "running" ? summary.latest_run.id : null);

  const pollTrackedRun = useEffectEvent(async (runId: string) => {
    const nextSummary = await loadSummary({ preserveLoading: true });
    if (!nextSummary) {
      return;
    }

    const matchingRun =
      nextSummary.recent_runs.find((run) => run.id === runId) ??
      (nextSummary.latest_run?.id === runId ? nextSummary.latest_run : null);
    if (!matchingRun || matchingRun.status === "running") {
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

  async function handleSaveScheduleSettings() {
    const refreshMinutes = Number.parseInt(scheduleRefreshInput, 10);
    if (!Number.isFinite(refreshMinutes) || refreshMinutes < 1) {
      setError({
        message: "Enter a refresh duration of at least 1 minute.",
        details: null,
      });
      return false;
    }
    setError(null);
    const startWasNow = scheduleStartInput.trim().toLowerCase() === "now";
    const normalizedStart = startWasNow
      ? formatScheduleInputFromDate(new Date())
      : scheduleStartInput.trim();
    try {
      await apiService.updateBullpenAutoLiveSettings(
        buildConsoleSettingsUpdate(
          savedConsoleOrderUsd,
          normalizedStart || null,
          refreshMinutes,
        ),
      );
      setScheduleStartInput(startWasNow ? "Now" : normalizedStart);
      const nextSummaryText = buildScheduleSummary(
        startWasNow ? "Now" : normalizedStart,
        String(refreshMinutes),
      );
      setScheduleSavedSummary(nextSummaryText);
      await loadSummary({ preserveLoading: true });
      setNotice(nextSummaryText);
      return true;
    } catch (nextError) {
      setError(normalizeError(nextError));
      return false;
    }
  }

  async function handleEnableAutoRuns() {
    const nextConsoleOrderUsd = resolveConsoleOrderAmount();
    if (nextConsoleOrderUsd === null) {
      return;
    }

    setAction("enable");
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
      const startWasNow = scheduleStartInput.trim().toLowerCase() === "now";
      const normalizedStart = startWasNow
        ? formatScheduleInputFromDate(new Date())
        : scheduleStartInput.trim();
      await apiService.updateBullpenAutoLiveSettings(
        buildConsoleSettingsUpdate(
          nextConsoleOrderUsd,
          normalizedStart || null,
          refreshMinutes,
        ),
      );
      setConsoleOrderDirty(false);
      setConsoleOrderFieldError(null);
      setConsoleOrderInput(formatEditableAmount(nextConsoleOrderUsd));
      setScheduleStartInput(startWasNow ? "Now" : normalizedStart);
      setScheduleSavedSummary(
        buildScheduleSummary(
          startWasNow ? "Now" : normalizedStart,
          String(refreshMinutes),
        ),
      );
      await apiService.startBullpenAutoLive();
      if (startWasNow) {
        const runNowRequest = (await buildRunNowRequest?.()) ?? undefined;
        const run = await apiService.runBullpenAutoLiveOnce(runNowRequest);
        setPendingRunId(run.id);
        setRunNowStartedAt(run.started_at ?? new Date().toISOString());
      }
      const nextSummary = await loadSummary({ preserveLoading: true });
      setNotice(
        nextSummary?.state.next_run_at
          ? `Auto runs enabled. Next scheduled run: ${formatIstDateTime(nextSummary.state.next_run_at)}.`
          : "Auto runs enabled.",
      );
    } catch (nextError) {
      setError(normalizeError(nextError));
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

  async function handleRunNow() {
    const nextConsoleOrderUsd = resolveConsoleOrderAmount();
    if (nextConsoleOrderUsd === null) {
      return;
    }

    const startedAt = new Date().toISOString();
    setAction("run-now");
    setRunNowStartedAt(startedAt);
    setTimerNowMs(Date.parse(startedAt));
    setNotice(null);
    setError(null);

    try {
      const runNowRequest = (await buildRunNowRequest?.()) ?? undefined;
      const refreshMinutes = Number.parseInt(scheduleRefreshInput, 10);
      if (!Number.isFinite(refreshMinutes) || refreshMinutes < 1) {
        setError({
          message: "Enter a refresh duration of at least 1 minute.",
          details: null,
        });
        return;
      }
      await apiService.updateBullpenAutoLiveSettings(
        buildConsoleSettingsUpdate(
          nextConsoleOrderUsd,
          scheduleStartInput.trim() || null,
          refreshMinutes,
        ),
      );
      setConsoleOrderDirty(false);
      setConsoleOrderFieldError(null);
      setConsoleOrderInput(formatEditableAmount(nextConsoleOrderUsd));
      const run = await apiService.runBullpenAutoLiveOnce(runNowRequest);
      setPendingRunId(run.id);
      setRunNowStartedAt(run.started_at ?? new Date().toISOString());
      await loadSummary({ preserveLoading: true, nextPendingRunId: run.id });
      setAction(null);
    } catch (nextError) {
      setError(normalizeError(nextError));
      setAction(null);
      setPendingRunId(null);
      setRunNowStartedAt(null);
    }
  }

  async function handleInvestOnly(request: BullpenAutoLiveRunOnceRequest) {
    const nextConsoleOrderUsd = resolveConsoleOrderAmount();
    if (nextConsoleOrderUsd === null) {
      return;
    }

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
      await apiService.updateBullpenAutoLiveSettings(
        buildConsoleSettingsUpdate(
          nextConsoleOrderUsd,
          scheduleStartInput.trim() || null,
          refreshMinutes,
        ),
      );
      setConsoleOrderDirty(false);
      setConsoleOrderFieldError(null);
      setConsoleOrderInput(formatEditableAmount(nextConsoleOrderUsd));
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
  const workflowView = buildBullpenAutoRunWorkflowView(
    workflowRun,
    pendingRunId,
    runTimerStartedAt,
  );
  const openScanCandidateDialog = (
    stage: ReturnType<typeof buildBullpenAutoRunWorkflowView>["stages"][number],
    mode: ScanCandidateDialogMode,
  ) => {
    setScanCandidateDialog({
      mode,
      scanCompletedAt: stage.timerCompletedAt,
      candidates: buildScanCandidateDialogRows({
        candidates: stage.scanCandidates,
        run: workflowRun,
      }),
      activePositions: stage.activePositionsFound,
      activePositionCount:
        readStageOutputNumber(stage.outputs.active_wallet_positions) ??
        readStageOutputNumber(stage.outputs.active_position_rows_before_llm) ??
        stage.activePositionsFound.length,
    });
  };
  const workflowSettled = isBullpenAutoRunWorkflowSettled(workflowView);
  const hasActiveWorkflowStage = workflowView.stages.some(
    (stage) => stage.isCurrent,
  );
  const runActionRequested = action === "run-now" || action === "invest-now";
  const runIsActive =
    !workflowSettled &&
    (runActionRequested ||
      pendingRunId !== null ||
      visibleRun?.status === "running" ||
      Boolean(summary?.state.running) ||
      Boolean(summary?.state.paused) ||
      hasActiveWorkflowStage);
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
    ? "All 3 stages finished"
    : workflowView.currentStageLabel;
  const workflowStatusCopy = workflowSettled
    ? "The latest Bullpen Scan + LLM + Rebalance and Invest run finished all 3 stages."
    : workflowView.statusCopy;
  const monitorRunStatusLabel =
    workflowRun && !workflowSettled
      ? formatRunStatusLabel(workflowRun.status)
      : workflowRun
        ? "Completed"
        : null;
  const investWorkflowStage =
    workflowView.stages.find((stage) => stage.key === "invest") ?? null;
  const investStageImmediateSuccess =
    workflowRun?.status === "running"
      ? getInvestStageImmediateSuccess(investWorkflowStage)
      : null;
  const workflowDecisionCount =
    workflowRun !== null
      ? getInvestStageMetric(
          investWorkflowStage,
          "decisions_count",
          workflowRun.decisions_count,
        )
      : null;
  const workflowPlannedOrderCount =
    workflowRun !== null
      ? getInvestStageMetric(
          investWorkflowStage,
          "orders_planned",
          workflowRun.orders_planned,
        )
      : null;
  const workflowSubmittedOrderCount =
    workflowRun !== null
      ? getInvestStageMetric(
          investWorkflowStage,
          "orders_submitted",
          workflowRun.orders_submitted,
        )
      : null;
  const investOnlyActionCompleted =
    action === "invest-now" && Boolean(investStageImmediateSuccess);
  const displayNotice =
    investStageImmediateSuccess?.message ??
    notice ??
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
    summary && workflowRun
      ? mergeInvestStageDecisionRows({
          stage: investWorkflowStage,
          persistedDecisions: summary.recent_decisions.filter(
            (decision) => decision.run_id === workflowRun.id,
          ),
        })
      : [];
  const openInvestMetricDialog = (kind: InvestMetricDialogKind) => {
    if (!workflowRun) return;
    setInvestMetricDialog({
      kind,
      run: workflowRun,
      stage: investWorkflowStage,
      decisions: investRunDecisions,
    });
  };
  const investOnlyDisabledReason = runIsActive
    ? "Wait for the active Auto-Live run to finish before starting another Invest pass."
    : investOnlyPlan.blockedReason;
  const consoleOrderSaveDisabled =
    action !== null ||
    consoleOrderSaveBusy ||
    !consoleOrderDirty ||
    parseConsoleOrderAmount(consoleOrderInput) === null;
  const consoleOrderHelperMessage = consoleOrderFieldError
    ? consoleOrderFieldError
    : consoleOrderSaveBusy
      ? "Saving trade amount..."
      : consoleOrderDirty
        ? "Press Enter, click Save, or start a run to apply this amount to future trades."
        : "";

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
      if (action === "run-now" || action === "invest-now") {
        setAction(null);
      }
    });
  }, [action, pendingRunId, runNowStartedAt, workflowSettled]);

  return (
    <Card className="border-fuchsia-200 bg-[linear-gradient(135deg,rgba(253,242,248,0.98),rgba(239,246,255,0.98))] shadow-sm dark:border-fuchsia-500/30 dark:bg-[linear-gradient(135deg,rgba(91,33,182,0.24),rgba(15,23,42,0.94),rgba(14,165,233,0.16))]">
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-white/80 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-fuchsia-700">
                Auto Run Schedule
              </span>
              <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700">
                Status: {statusLabel(summary, runIsActive)}
              </span>
              <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700">
                Mode: {mode}
              </span>
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xl font-semibold text-slate-950">
                  Bullpen Scan + LLM + Exit and Invest auto-run schedule
                </h2>
                <button
                  type="button"
                  onClick={() => setIsScheduleInfoDialogOpen(true)}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-fuchsia-200 bg-white text-fuchsia-700 shadow-sm transition hover:border-fuchsia-300 hover:bg-fuchsia-50 hover:text-fuchsia-900 focus:outline-none focus:ring-2 focus:ring-fuchsia-400 focus:ring-offset-2"
                  aria-label="Show auto-run schedule details"
                >
                  <Info className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsRunHistoryDialogOpen(true)}
              aria-label="Show Bullpen run history"
              className="border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            >
              <History className="mr-2 h-4 w-4" />
              History
            </Button>
            {autoRunActive ? (
              <Button
                variant="outline"
                onClick={handleStopAutoRuns}
                disabled={action !== null}
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
            <div className="flex flex-col items-stretch gap-1">
              <Button
                variant="outline"
                onClick={handleRunNow}
                disabled={action !== null || runIsActive}
                className="border-sky-200 bg-sky-50 text-sky-900 hover:bg-sky-100"
              >
                {runActionRequested || runIsActive ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Running...
                  </>
                ) : (
                  <>
                    <Zap className="mr-2 h-4 w-4" />
                    Run Scans and Invest Now
                  </>
                )}
              </Button>
              {showRunTimer ? (
                <div
                  className="text-center text-xs font-semibold tabular-nums text-sky-800"
                  aria-live="polite"
                >
                  {elapsedRunTime}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-white/70 bg-white/80 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[16rem] flex-1">
              <label
                htmlFor="bullpen-auto-run-trade-amount"
                className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500"
              >
                Trade amount per new opportunity
              </label>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <div className="flex h-11 min-w-[13rem] flex-1 items-center rounded-xl border border-slate-200 bg-white shadow-sm">
                  <span className="ml-3 mr-2 text-sm font-semibold text-slate-500">
                    $
                  </span>
                  <input
                    id="bullpen-auto-run-trade-amount"
                    type="number"
                    inputMode="decimal"
                    min="0.01"
                    step="0.01"
                    value={consoleOrderInput}
                    onChange={handleConsoleOrderInputChange}
                    onBlur={handleConsoleOrderInputBlur}
                    onKeyDown={handleConsoleOrderInputKeyDown}
                    disabled={action !== null || consoleOrderSaveBusy}
                    className="h-full w-full border-0 bg-transparent p-0 text-sm font-semibold text-slate-950 outline-none placeholder:text-slate-400 disabled:cursor-not-allowed disabled:text-slate-400"
                    placeholder={String(DEFAULT_CONSOLE_ORDER_USD)}
                    aria-describedby="bullpen-auto-run-trade-amount-help"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      void saveConsoleOrderAmount();
                    }}
                    disabled={consoleOrderSaveDisabled}
                    className="h-full min-w-[5.5rem] rounded-l-none rounded-r-xl border-y-0 border-r-0 shadow-none"
                  >
                    {consoleOrderSaveBusy ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Saving...
                      </>
                    ) : (
                      "Save"
                    )}
                  </Button>
                </div>
              </div>
              <p
                id="bullpen-auto-run-trade-amount-help"
                className={`mt-2 text-xs leading-5 ${
                  consoleOrderFieldError ? "text-rose-700" : "text-slate-600"
                }`}
              >
                {consoleOrderHelperMessage}
              </p>
            </div>
            <div className="min-w-[16rem] flex-1">
              <label
                htmlFor="bullpen-auto-run-start-time"
                className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500"
              >
                Auto-run start time IST
              </label>
              <div className="relative mt-2 flex h-11 items-center rounded-xl border border-slate-200 bg-white px-3 shadow-sm">
                <input
                  id="bullpen-auto-run-start-time"
                  type="text"
                  value={scheduleStartInput}
                  onChange={(event) =>
                    setScheduleStartInput(event.target.value)
                  }
                  disabled={action !== null}
                  className="h-full w-full border-0 bg-transparent p-0 text-sm font-semibold text-slate-950 outline-none placeholder:text-slate-400 disabled:cursor-not-allowed disabled:text-slate-400"
                  placeholder="13:00:00 06 July, 2026"
                />
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
                      onChange={(event) =>
                        setScheduleStartInput(
                          formatScheduleInputFromDateTimeLocal(
                            event.target.value,
                          ),
                        )
                      }
                      className="h-10 w-full rounded-lg border border-blue-500 px-3 text-sm outline-none"
                    />
                    <div className="mt-3 flex justify-between gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          setScheduleStartInput("Now");
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
              <Button
                type="button"
                variant="outline"
                className="mt-2"
                onClick={() => {
                  setScheduleStartInput("Now");
                }}
              >
                Now
              </Button>
            </div>
            <div className="min-w-[12rem] flex-1">
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
                  onChange={(event) =>
                    setScheduleRefreshInput(event.target.value)
                  }
                  disabled={action !== null}
                  className="h-full w-full border-0 bg-transparent p-0 text-sm font-semibold text-slate-950 outline-none disabled:cursor-not-allowed disabled:text-slate-400"
                />
                <span className="ml-2 text-sm font-semibold text-slate-500">
                  min
                </span>
              </div>
            </div>
          </div>
          <div className="mt-3 flex justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void handleSaveScheduleSettings();
              }}
              disabled={action !== null}
            >
              Save Auto-run Settings
            </Button>
          </div>
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
          <div className="rounded-2xl border border-white/70 bg-white/80 p-4">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              <CalendarClock className="h-4 w-4" />
              Next scheduled run
            </div>
            <p className="mt-2 text-sm font-semibold text-slate-950">
              {formatIstDateTime(summary?.state.next_run_at)}
            </p>
            <p className="mt-1 text-xs text-slate-600">
              Fixed times: 6 AM, 12 PM, 6 PM, and 12 AM IST.
            </p>
          </div>

          <div className="rounded-2xl border border-white/70 bg-white/80 p-4">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Last completed run
            </div>
            <p className="mt-2 text-sm font-semibold text-slate-950">
              {formatIstDateTime(summary?.state.last_run_at)}
            </p>
            <p className="mt-1 text-xs text-slate-600">
              {summary?.latest_run?.summary || "No auto-run result yet."}
            </p>
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
              <p className="text-xs text-slate-600">
                {workflowRun
                  ? `Run ${workflowRun.id} · started ${formatIstDateTime(workflowRun.started_at)}`
                  : "The 3-stage monitor turns yellow while working, green when finished, and blue while queued."}
              </p>
              <p className="text-xs text-slate-500">
                Worker stages. This panel refreshes every 4 seconds while the
                run is active.
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
              const investStageCounters = getInvestStageCounters(stage);
              const investStageForShortlist = workflowView.stages.find(
                (item) => item.key === "invest",
              );
              const stageTwoExecutionSteps =
                stage.key === "llm" && investStageForShortlist
                  ? getInvestStageExecutionSteps(investStageForShortlist)
                  : [];
              const investExecutionSteps = getInvestStageExecutionSteps(stage);
              const investPreviewSteps =
                stage.key === "invest" &&
                investExecutionSteps.length === 0 &&
                stage.state === "queued" &&
                Array.isArray(stage.inputs.llm_review_rows)
                  ? buildQueuedInvestPreviewSteps(
                      investOnlyPlan,
                      investOnlySourceRun,
                    )
                  : [];
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
              const investPreviewNoQualifiedCandidates =
                investPreviewFinished &&
                investOnlyPlan.readyCandidateCount === 0 &&
                investOnlyPlan.blockedReason ===
                  NO_STAGE2_QUALIFIED_EVENTS_REASON;
              const toneClasses = getWorkflowToneClasses(
                immediateSuccess || investPreviewFinished
                  ? "green"
                  : stage.tone,
              );
              const investExecutionStatus =
                getInvestStageExecutionStatus(stage);
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
              const stageDetail =
                investPreviewFinished && stage.key === "invest"
                  ? investPreviewNoQualifiedCandidates
                    ? "Stage 3 had nothing to process: no Event Exits were pending and no Stage 2-qualified events were available for the planned queue."
                    : "Stage 3 had nothing new to process: no Event Exits were pending and the Stage 2-qualified events were already invested."
                  : stage.detail;
              const showStageSpinner =
                stage.isCurrent && !immediateSuccess && !investPreviewFinished;

              return (
                <div
                  key={stage.key}
                  className={`relative rounded-2xl border p-4 shadow-sm transition ${toneClasses.container}`}
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
                      <span
                        className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] ${toneClasses.badge}`}
                      >
                        {stageStatusLabel}
                      </span>
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
                      <div className="space-y-0.5">
                        <button
                          type="button"
                          onClick={() =>
                            openScanCandidateDialog(
                              stage,
                              "fresh-opportunities",
                            )
                          }
                          className="block text-left underline-offset-2 transition hover:underline focus:outline-none focus:ring-2 focus:ring-emerald-300"
                        >
                          New events found:{" "}
                          <span className="font-semibold tabular-nums">
                            {stage.scanCandidates.length}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            openScanCandidateDialog(stage, "active-positions")
                          }
                          className="block text-left underline-offset-2 transition hover:underline focus:outline-none focus:ring-2 focus:ring-emerald-300"
                        >
                          Active Bullpen Positions Found:{" "}
                          <span className="font-semibold tabular-nums">
                            {readStageOutputNumber(
                              stage.outputs.active_wallet_positions,
                            ) ??
                              readStageOutputNumber(
                                stage.outputs.active_position_rows_before_llm,
                              ) ??
                              stage.activePositionsFound.length}
                          </span>
                        </button>
                      </div>
                    ) : null}
                    {stage.key === "invest" &&
                    formatInvestStageRowMix(stage) ? (
                      <div>
                        Rows counted:{" "}
                        <span className="font-semibold">
                          {formatInvestStageRowMix(stage)}
                        </span>
                      </div>
                    ) : null}
                  </div>

                  {stage.key === "llm" && stageTwoExecutionSteps.length > 0 ? (
                    <StageTwoExecutionShortlist
                      steps={stageTwoExecutionSteps}
                      decisions={summary?.recent_decisions ?? []}
                      onOpenEventExitInfo={() =>
                        setIsEventExitStrategiesDialogOpen(true)
                      }
                      onOpenInvestEligibilityInfo={() =>
                        setIsInvestEligibilityInfoDialogOpen(true)
                      }
                    />
                  ) : null}

                  {investStageCounters.length > 0 ? (
                    <div className="mt-3 grid grid-cols-3 gap-2">
                      {investStageCounters.map((counter) => (
                        <button
                          key={counter.label}
                          type="button"
                          onClick={() =>
                            openInvestMetricDialog(
                              counter.label.toLowerCase() as InvestMetricDialogKind,
                            )
                          }
                          className="rounded-xl border border-white/70 bg-white/60 px-3 py-2 dark:border-slate-700/80 dark:bg-slate-950/70 text-left transition hover:-translate-y-0.5 hover:border-sky-200 hover:bg-white focus:outline-none focus:ring-2 focus:ring-sky-300"
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
                      ))}
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
                        onOpenInvestEligibilityInfo={() =>
                          setIsInvestEligibilityInfoDialogOpen(true)
                        }
                      />
                    </div>
                  ) : null}

                  {investExecutionStatus ? (
                    <div
                      className={`mt-3 rounded-xl border px-3 py-2 ${investExecutionStatus.className}`}
                    >
                      <p className="text-[10px] font-semibold uppercase tracking-[0.14em]">
                        {investExecutionStatus.label}
                      </p>
                      <p
                        className={`mt-1 text-xs leading-5 ${investExecutionStatus.detailClassName}`}
                      >
                        <ErrorCodeWithDetails
                          detail={investExecutionStatus.message}
                          detailClassName={
                            investExecutionStatus.detailClassName
                          }
                        />
                      </p>
                    </div>
                  ) : null}

                  {stage.key === "invest" ? (
                    <div className="mt-3 space-y-2 rounded-xl border border-white/60 bg-white/50 px-3 py-3 dark:border-slate-700/80 dark:bg-slate-950/70">
                      <button
                        type="button"
                        onClick={() => {
                          if (investOnlyPlan.request) {
                            void handleInvestOnly(investOnlyPlan.request);
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
                      <p
                        className={`text-[11px] leading-5 ${toneClasses.muted}`}
                      >
                        Reuses the latest Stage 2-qualified rows and skips the
                        Bullpen rescan plus LLM rerun.
                      </p>
                      {investOnlyDisabledReason ? (
                        <p
                          className={`text-[11px] leading-5 ${toneClasses.muted}`}
                        >
                          {investOnlyDisabledReason}
                        </p>
                      ) : investOnlyPlan.readyCandidateCount > 0 ? (
                        <p
                          className={`text-[11px] leading-5 ${toneClasses.muted}`}
                        >
                          {investOnlyPlan.readyCandidateCount} qualified{" "}
                          {investOnlyPlan.readyCandidateCount === 1
                            ? "event is"
                            : "events are"}{" "}
                          ready for this invest-only pass.
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

                  <div className="mt-2 flex items-end justify-between gap-3">
                    <p className={`text-xs leading-5 ${toneClasses.muted}`}>
                      {stageDetail}
                    </p>
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
                      return (
                        <div
                          key={run.id}
                          className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-800">
                                  {runKind}
                                </span>
                                <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold capitalize text-slate-700">
                                  {run.status}
                                </span>
                              </div>
                              <p className="mt-2 text-sm font-semibold text-slate-950">
                                {run.summary || "Run summary unavailable."}
                              </p>
                              <p className="mt-1 text-xs text-slate-600">
                                Run {run.id} • started{" "}
                                {formatIstDateTime(run.started_at)}
                                {run.completed_at
                                  ? ` • completed ${formatIstDateTime(run.completed_at)}`
                                  : ""}
                              </p>
                            </div>
                            <div className="grid grid-cols-3 gap-2 text-center text-xs">
                              <div className="rounded-xl bg-white px-3 py-2">
                                <div className="font-semibold text-slate-950">
                                  {run.decisions_count}
                                </div>
                                <div className="text-slate-500">decisions</div>
                              </div>
                              <div className="rounded-xl bg-white px-3 py-2">
                                <div className="font-semibold text-slate-950">
                                  {run.orders_planned}
                                </div>
                                <div className="text-slate-500">planned</div>
                              </div>
                              <div className="rounded-xl bg-white px-3 py-2">
                                <div className="font-semibold text-slate-950">
                                  {run.orders_submitted}
                                </div>
                                <div className="text-slate-500">submitted</div>
                              </div>
                            </div>
                          </div>
                          {run.error_message ? (
                            <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-800">
                              {run.error_message}
                            </p>
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

        {isScheduleInfoDialogOpen ? (
          <div
            className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/55 p-4"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget)
                setIsScheduleInfoDialogOpen(false);
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="bullpen-auto-run-schedule-info-title"
              className="w-full max-w-xl overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.45)]"
            >
              <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-fuchsia-600">
                    Auto Run Architecture
                  </p>
                  <h2
                    id="bullpen-auto-run-schedule-info-title"
                    className="mt-2 text-xl font-semibold text-slate-950"
                  >
                    Scheduled Bullpen x AI execution
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => setIsScheduleInfoDialogOpen(false)}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
                  aria-label="Close auto-run schedule details"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="px-6 py-5 text-sm leading-6 text-slate-700">
                <p>
                  Scheduled runs use the Bullpen console top-10 profile: scan
                  upcoming markets, run LLM consensus on every Stage 1 event,
                  process Event Exits from both the ranking / LLM strategy and
                  the capital-aware forced-exit strategy so capital is freed
                  first, and then buy{" "}
                  <span className="font-semibold">
                    {formatMoney(savedConsoleOrderUsd)}
                  </span>{" "}
                  of each new opportunity on the stronger LLM side when it ranks
                  inside the investable top 10 list.
                </p>
              </div>
            </div>
          </div>
        ) : null}

        {isEventExitStrategiesDialogOpen ? (
          <BullpenEventExitStrategiesDialog
            onClose={() => setIsEventExitStrategiesDialogOpen(false)}
          />
        ) : null}

        {isInvestEligibilityInfoDialogOpen ? (
          <div
            className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/55 p-4"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) {
                setIsInvestEligibilityInfoDialogOpen(false);
              }
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="bullpen-stage3-eligibility-title"
              className="w-full max-w-2xl overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.45)]"
            >
              <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-sky-600">
                    Stage 3 Planned Queue
                  </p>
                  <h2
                    id="bullpen-stage3-eligibility-title"
                    className="mt-2 text-xl font-semibold text-slate-950"
                  >
                    How Stage 2 events become eligible to invest
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => setIsInvestEligibilityInfoDialogOpen(false)}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
                  aria-label="Close planned queue eligibility details"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="space-y-4 px-6 py-5 text-sm leading-6 text-slate-700">
                <p>
                  Stage 3 only plans buy orders for Stage 2 candidate events
                  that have already passed the qualification and ranking checks.
                </p>
                <ul className="list-disc space-y-2 pl-5">
                  <li>
                    Stage 2 must first keep the event{" "}
                    <span className="font-semibold">qualified</span>: rules
                    parsing cannot be blocked, a strong LLM side must exist,
                    returns/day must be computable, LLM disagreement cannot be
                    High, and adjudication cannot be required.
                  </li>
                  <li>
                    Those qualified candidates are then ranked together with
                    active Bullpen positions by{" "}
                    <span className="font-semibold">returns/day</span>.
                  </li>
                  <li>
                    Only candidates that land inside the fixed{" "}
                    <span className="font-semibold">
                      top-10 investable table
                    </span>{" "}
                    are added to Stage 3&apos;s planned buy queue.
                  </li>
                  <li>
                    Step 1 Event Exits run first to free capital, and any buy
                    still depends on live execution guardrails before
                    submission.
                  </li>
                  <li>
                    In invest-only reuse mode, markets that are already in the
                    Bullpen wallet or were already submitted from the saved run
                    are skipped instead of being re-planned.
                  </li>
                </ul>
              </div>
            </div>
          </div>
        ) : null}

        {scanCandidateDialog ? (
          <StageOneOutputDialog
            state={scanCandidateDialog}
            onClose={() => setScanCandidateDialog(null)}
          />
        ) : null}

        {investMetricDialog ? (
          <InvestMetricDetailsDialog
            state={investMetricDialog}
            onClose={() => setInvestMetricDialog(null)}
            onSelectKind={openInvestMetricDialog}
            onOpenEventExitInfo={() => setIsEventExitStrategiesDialogOpen(true)}
            onOpenInvestEligibilityInfo={() =>
              setIsInvestEligibilityInfoDialogOpen(true)
            }
          />
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

        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-600">
          <span>
            Need deeper guardrail control? Open the dedicated Auto-Live
            dashboard for the same execution pipeline.
          </span>
          <Link
            href={URLs.routes.console.bullpenAiAutoLive()}
            className="font-semibold text-fuchsia-700 hover:text-fuchsia-900"
          >
            Open Auto-Live Controls
          </Link>
        </div>

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

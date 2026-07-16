"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  XCircle,
  Info,
  Loader2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  getBullpenLlmReviewState,
  hasBullpenLlmAnalysis,
  type BullpenQuestionRow,
} from "@/lib/bullpen-ai";
import {
  buildBullpenInvestmentDisplay,
  type BullpenInvestmentRow,
} from "@/lib/bullpenInvestments";
import { formatApiTimestamp } from "@/lib/datetime";
import type {
  BullpenActivePositionView,
  BullpenLiveHealth,
  BullpenLiveSnapshot,
  BullpenPositionsFallback,
  BullpenPositionsSource,
} from "@/lib/bullpenPositions";
import { cn } from "@/lib/utils";
import type { BullpenAutoLiveDecision } from "@/types/api";
import { BullpenInvestmentMathDialog } from "./BullpenInvestmentMathDialog";
import { BullpenLlmBreakdownDialog } from "./BullpenLlmBreakdownDialog";
import { BullpenEventExitStrategiesDialog } from "./BullpenEventExitStrategiesDialog";
import { BullpenPositionsDialog } from "./BullpenPositionsDialog";

type BullpenInvestmentsSectionProps = {
  activePositionsCount: number | null;
  activePositions: BullpenActivePositionView[];
  activePositionQuestions: BullpenQuestionRow[];
  candidates: BullpenQuestionRow[];
  claimError: string | null;
  claimStatusMessage: string | null;
  emptyMessage: string;
  isReadOnly: boolean;
  readOnlyMessage: string | null;
  isClaimingPositions: boolean;
  isInvesting: boolean;
  isLoadingPositions: boolean;
  isRefreshingCurrentOdds: boolean;
  lastSuccessfulLiveSnapshot: BullpenLiveSnapshot | null;
  onClaimNow: () => void;
  onInvest: () => void;
  onRefreshPositions: () => void;
  onRefreshCurrentOdds: () => void;
  onToggleQuestion: (questionId: string) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
  positionsError: string | null;
  positionsFallback: BullpenPositionsFallback | null;
  positionsHealth: BullpenLiveHealth | null;
  positionsLastUpdatedAt: string | null;
  sectionsLastRefreshedAt?: string | null;
  positionsSource: BullpenPositionsSource | null;
  progressMessage: string | null;
  recentDecisions: BullpenAutoLiveDecision[];
  resultMessage: string | null;
  latestCompletedLlmRunId?: string | number | null;
  currentInProgressLlmRunId?: string | number | null;
  selectedQuestionIds: Set<string>;
};

function formatDate(value: string | null) {
  return formatApiTimestamp(value, {
    emptyValue: "—",
    second: undefined,
  });
}

function formatIstTimestamp(value: string | null) {
  return formatApiTimestamp(value, {
    emptyValue: "—",
    timeZone: "Asia/Kolkata",
    timeZoneName: "short",
    second: "2-digit",
  });
}

function formatOdds(value: number | null) {
  if (value === null) return "—";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

function formatReturnsPerDay(value: number | null) {
  if (value === null) return "—";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

function formatMoney(value: number | null) {
  if (value === null) return "—";
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function MetricCard({
  label,
  children,
  footer,
}: {
  label: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="rounded-xl bg-slate-50 px-3 py-2">
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">
        {label}
      </div>
      <div className="mt-1">{children}</div>
      {footer ? (
        <div className="mt-2 border-t border-slate-200 pt-2 text-[10px] font-medium leading-4 text-slate-500">
          {footer}
        </div>
      ) : null}
    </div>
  );
}

function EventsSectionHeader({
  title,
  tone,
  description,
  titleAccessory,
  lastRefreshedAt,
}: {
  title: string;
  tone: "active" | "candidate" | "attention";
  description?: string;
  titleAccessory?: ReactNode;
  lastRefreshedAt?: string | null;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border px-4 py-3",
        tone === "active"
          ? "border-emerald-200 bg-emerald-50"
          : tone === "candidate"
            ? "border-fuchsia-200 bg-fuchsia-50"
            : "border-red-200 bg-red-50",
      )}
    >
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-2 text-sm font-semibold",
          tone === "active"
            ? "text-emerald-900"
            : tone === "candidate"
              ? "text-fuchsia-900"
              : "text-red-900",
        )}
      >
        <span className="inline-flex items-center gap-2">
          <span>{title}</span>
          {titleAccessory ? <span>{titleAccessory}</span> : null}
        </span>
        {lastRefreshedAt ? (
          <span className="text-[11px] font-medium normal-case tracking-normal opacity-80">
            Last refreshed: {formatIstTimestamp(lastRefreshedAt)}
          </span>
        ) : null}
      </div>
      {description ? (
        <p
          className={cn(
            "mt-1 text-xs leading-5",
            tone === "active"
              ? "text-emerald-800"
              : tone === "candidate"
                ? "text-fuchsia-800"
                : "text-red-800",
          )}
        >
          {description}
        </p>
      ) : null}
    </div>
  );
}

function AttentionBadge({
  label,
  tone = "red",
}: {
  label: string;
  tone?: "red" | "amber";
}) {
  return (
    <span
      className={cn(
        "rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em]",
        tone === "amber"
          ? "bg-amber-100 text-amber-900"
          : "bg-red-100 text-red-900",
      )}
    >
      {label}
    </span>
  );
}

function OddsPairValue({
  yesOdds,
  noOdds,
  accentClassName = "text-slate-950",
  warningLabel = null,
  warningTone = "medium",
}: {
  yesOdds: number | null;
  noOdds: number | null;
  accentClassName?: string;
  warningLabel?: string | null;
  warningTone?: "high" | "medium" | "lowEvidence";
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium uppercase tracking-[0.12em] text-slate-500">
          Yes
        </span>
        <span className={cn("font-semibold", accentClassName)}>
          {formatOdds(yesOdds)}
        </span>
      </div>
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium uppercase tracking-[0.12em] text-slate-500">
          No
        </span>
        <span className={cn("font-semibold", accentClassName)}>
          {formatOdds(noOdds)}
        </span>
      </div>
      {warningLabel ? (
        <div
          className={cn(
            "flex items-center gap-1 text-[11px] font-medium",
            warningTone === "high" ? "text-amber-700" : "text-sky-700",
          )}
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {warningLabel}
        </div>
      ) : null}
    </div>
  );
}

type LlmFreshnessStatus = "current" | "in-progress" | "stale" | "unknown";

function getLlmFreshnessStatus({
  llmRunId,
  latestCompletedLlmRunId,
  currentInProgressLlmRunId,
}: {
  llmRunId: string | number | null | undefined;
  latestCompletedLlmRunId?: string | number | null;
  currentInProgressLlmRunId?: string | number | null;
}): LlmFreshnessStatus {
  if (llmRunId === null || llmRunId === undefined) return "unknown";
  const normalizedLlmRunId = String(llmRunId);
  if (
    latestCompletedLlmRunId !== null &&
    latestCompletedLlmRunId !== undefined &&
    normalizedLlmRunId === String(latestCompletedLlmRunId)
  ) {
    return "current";
  }
  if (
    currentInProgressLlmRunId !== null &&
    currentInProgressLlmRunId !== undefined &&
    normalizedLlmRunId === String(currentInProgressLlmRunId)
  ) {
    return "in-progress";
  }
  if (latestCompletedLlmRunId !== null && latestCompletedLlmRunId !== undefined) {
    return "stale";
  }
  return "unknown";
}

function LlmFreshnessIcon({ status }: { status: LlmFreshnessStatus }) {
  if (status === "current") {
    return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" aria-label="LLM odds are from the latest completed run" />;
  }
  if (status === "in-progress") {
    return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-500" aria-label="LLM odds are from the current run in progress" />;
  }
  if (status === "stale") {
    return <XCircle className="h-3.5 w-3.5 shrink-0 text-red-600" aria-label="LLM odds are from an older run" />;
  }
  return null;
}

function LlmTimestamp({
  completedAt,
  status,
}: {
  completedAt: string | null;
  status: LlmFreshnessStatus;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span>Last LLM: {formatIstTimestamp(completedAt)}</span>
      <LlmFreshnessIcon status={status} />
    </span>
  );
}

function CurrentOddsMetric({
  yesOdds,
  noOdds,
  updatedAt,
}: {
  yesOdds: number | null;
  noOdds: number | null;
  updatedAt: string | null;
}) {
  return (
    <MetricCard
      label="Current Yes / No"
      footer={<span>Updated: {formatIstTimestamp(updatedAt)}</span>}
    >
      <OddsPairValue
        yesOdds={yesOdds}
        noOdds={noOdds}
        accentClassName="text-rose-700"
      />
    </MetricCard>
  );
}

function LlmOddsMetric({
  question,
  onOpenBreakdown,
  latestCompletedLlmRunId,
  currentInProgressLlmRunId,
}: {
  question: BullpenQuestionRow | null | undefined;
  onOpenBreakdown: (question: BullpenQuestionRow) => void;
  latestCompletedLlmRunId?: string | number | null;
  currentInProgressLlmRunId?: string | number | null;
}) {
  const reviewState = question ? getBullpenLlmReviewState(question) : null;
  const hasAnalysis = hasBullpenLlmAnalysis(question);
  const freshnessStatus = getLlmFreshnessStatus({
    llmRunId: question?.llmRunId,
    latestCompletedLlmRunId,
    currentInProgressLlmRunId,
  });
  const odds = (
    <OddsPairValue
      yesOdds={question?.llmYesOdds ?? null}
      noOdds={question?.llmNoOdds ?? null}
      accentClassName="text-violet-700"
      warningLabel={reviewState?.label ?? null}
      warningTone={reviewState?.tone ?? "medium"}
    />
  );
  const content = (
    <div className="space-y-2">
      {odds}
      <div className="border-t border-slate-200 pt-2 text-[10px] font-medium leading-4 text-slate-500">
        <LlmTimestamp completedAt={question?.llmCompletedAt ?? null} status={freshnessStatus} />
      </div>
    </div>
  );

  return (
    <MetricCard label="LLM Yes / No">
      {question && hasAnalysis ? (
        <button
          type="button"
          onClick={() => onOpenBreakdown(question)}
          aria-label={`Open LLM odds breakdown for ${question.question}`}
          className="w-full rounded-md text-left underline decoration-violet-300 underline-offset-4 transition hover:text-violet-900"
        >
          {content}
        </button>
      ) : (
        content
      )}
    </MetricCard>
  );
}

function RowShell({
  children,
  selected = false,
  active = false,
  attention = false,
}: {
  children: ReactNode;
  selected?: boolean;
  active?: boolean;
  attention?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-4 rounded-2xl border px-4 py-4 transition md:flex-row md:items-start md:justify-between",
        attention
          ? "border-red-400 bg-red-50"
          : active
            ? "border-emerald-400 bg-emerald-50"
            : selected
              ? "border-fuchsia-400 bg-fuchsia-50"
              : "border-slate-200 bg-white hover:border-fuchsia-200",
      )}
    >
      {children}
    </div>
  );
}

function getStage3PlannedOrderReason(
  question: BullpenQuestionRow,
  isSelectedForInvest: boolean,
) {
  const strongestLlmOdds = Math.max(
    question.llmYesOdds ?? -Infinity,
    question.llmNoOdds ?? -Infinity,
  );
  const hasStrongLlmOdds = Number.isFinite(strongestLlmOdds) && strongestLlmOdds > 80;

  if (!isSelectedForInvest) {
    return "Not included in Stage 3 planned orders because this opportunity is not selected in the Events to invest in table. Select its checkbox before running Stage 2/Invest so it can be reviewed and carried into the Stage 3 buy plan.";
  }
  if (question.returnsPerDay === null) {
    return "Not included in Stage 3 planned orders because Returns/day is unavailable. Stage 3 only creates buy plans for rows with usable current odds, LLM odds, and time-to-close data.";
  }
  if (!hasStrongLlmOdds) {
    return "Not included in Stage 3 planned orders because neither LLM side is above the strict 80% confidence threshold required for a buy plan.";
  }
  if (question.llmDisagreementLevel === "High") {
    return "Not included in Stage 3 planned orders because the LLM review has High disagreement, which blocks automatic investment.";
  }
  if (question.adjudicationRequired) {
    return "Not included in Stage 3 planned orders because the LLM review says adjudication is required before automatic investment.";
  }
  if (question.amountToBeInvested === null) {
    return "Not included in Stage 3 planned orders because the fixed investment amount was not assigned for this row.";
  }

  return "Eligible for Stage 3 planned orders once this selected row is included in a completed Stage 2 run and has not already been invested.";
}

function QuestionDetailsDialog({
  question,
  isSelectedForInvest,
  onClose,
}: {
  question: BullpenQuestionRow;
  isSelectedForInvest: boolean;
  onClose: () => void;
}) {
  const details = [
    ["Close", formatDate(question.closeTime)],
    ["Category", question.category || "—"],
    ["Current Yes odds", question.yesOdds === null ? "—" : `${question.yesOdds.toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`],
    ["Current No odds", question.noOdds === null ? "—" : `${question.noOdds.toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`],
    ["LLM Yes odds", question.llmYesOdds === null ? "—" : `${question.llmYesOdds.toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`],
    ["LLM No odds", question.llmNoOdds === null ? "—" : `${question.llmNoOdds.toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`],
    ["Returns/day", formatReturnsPerDay(question.returnsPerDay)],
    ["Added", formatIstTimestamp(question.investmentTableAddedAt ?? null)],
    ["Stage 3 planned order", isSelectedForInvest ? "Selected for review" : "Not selected"],
  ];
  const stage3PlannedOrderReason = getStage3PlannedOrderReason(
    question,
    isSelectedForInvest,
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
      <div className="flex max-h-[84vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 p-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-fuchsia-700">Opportunity details</p>
            <h2 className="mt-2 text-lg font-semibold text-slate-950">{question.question}</h2>
          </div>
          <button type="button" onClick={onClose} className="text-sm font-semibold text-slate-500 hover:text-slate-900">Close</button>
        </div>
        <div className="overflow-y-auto p-6">
          <div className="grid gap-3 sm:grid-cols-2">
            {details.map(([label, value]) => (
              <div key={label} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">{label}</p>
                <p className="mt-2 break-words text-sm font-semibold text-slate-900">{value}</p>
              </div>
            ))}
          </div>
          <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-700">Why this may not be in Stage 3</p>
            <p className="mt-2 text-sm leading-6 text-amber-950">{stage3PlannedOrderReason}</p>
          </div>
          {question.rules || question.marketContext || question.resolutionSource ? (
            <div className="mt-4 space-y-3">
              {question.rules ? <DetailBlock label="Rules" value={question.rules} /> : null}
              {question.marketContext ? <DetailBlock label="Market context" value={question.marketContext} /> : null}
              {question.resolutionSource ? <DetailBlock label="Resolution source" value={question.resolutionSource} /> : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function DetailBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">{value}</p>
    </div>
  );
}

export function BullpenInvestmentsSection({
  activePositionsCount,
  activePositions,
  activePositionQuestions,
  candidates,
  claimError,
  claimStatusMessage,
  emptyMessage,
  isReadOnly,
  readOnlyMessage,
  isClaimingPositions,
  isInvesting,
  isLoadingPositions,
  isRefreshingCurrentOdds,
  lastSuccessfulLiveSnapshot,
  onClaimNow,
  onInvest,
  onRefreshPositions,
  onRefreshCurrentOdds,
  onToggleQuestion,
  onSelectAll,
  onClearAll,
  positionsError,
  positionsFallback,
  positionsHealth,
  positionsLastUpdatedAt,
  sectionsLastRefreshedAt,
  positionsSource,
  progressMessage,
  recentDecisions,
  resultMessage,
  latestCompletedLlmRunId,
  currentInProgressLlmRunId,
  selectedQuestionIds,
}: BullpenInvestmentsSectionProps) {
  const [breakdownQuestion, setBreakdownQuestion] =
    useState<BullpenQuestionRow | null>(null);
  const [calculationDialog, setCalculationDialog] = useState<{
    question?: BullpenQuestionRow;
    position?: BullpenActivePositionView;
  } | null>(null);
  const [isPositionsDialogOpen, setIsPositionsDialogOpen] = useState(false);
  const [detailsQuestion, setDetailsQuestion] =
    useState<BullpenQuestionRow | null>(null);
  const [isGroupingInfoOpen, setIsGroupingInfoOpen] = useState(false);
  const [isEventExitStrategiesDialogOpen, setIsEventExitStrategiesDialogOpen] =
    useState(false);
  const openActivePositions = activePositions.filter((position) => !position.isClaimable);
  const {
    activePositionQuestionByKey,
    activePositionsNeedingAttention,
    eventExitCounts,
    topInvestmentRows,
    watchFastPositionKeys,
  } = useMemo(
    () =>
      buildBullpenInvestmentDisplay({
        activePositions: openActivePositions,
        activePositionQuestions,
        candidates,
        recentDecisions,
      }),
    [activePositionQuestions, candidates, openActivePositions, recentDecisions],
  );
  const selectedCount = candidates.filter((question) =>
    selectedQuestionIds.has(question.id),
  ).length;
  const totalSelectedAmount = candidates.reduce((total, question) => {
    if (!selectedQuestionIds.has(question.id) || question.amountToBeInvested === null) {
      return total;
    }
    return total + question.amountToBeInvested;
  }, 0);
  const allSelected = candidates.length > 0 && selectedCount === candidates.length;
  const positionsLabel =
    activePositionsCount === null ? "Positions" : `Positions (${activePositionsCount})`;

  function handleOpenPositions() {
    setIsPositionsDialogOpen(true);
    onRefreshPositions();
  }

  const hasRows = candidates.length > 0 || openActivePositions.length > 0;
  const activeInvestmentRows = topInvestmentRows.filter(
    (
      row,
    ): row is Extract<BullpenInvestmentRow, { kind: "active" }> =>
      row.kind === "active",
  );
  const candidateInvestmentRows = topInvestmentRows.filter(
    (
      row,
    ): row is Extract<BullpenInvestmentRow, { kind: "candidate" }> =>
      row.kind === "candidate",
  );

  return (
    <>
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-fuchsia-700">
                Events to invest in
              </p>
              <div className="mt-1 flex items-center gap-2">
                <h3 className="text-lg font-semibold text-slate-950">
                  Grouped Bullpen events by action
                </h3>
                <button
                  type="button"
                  onClick={() => setIsGroupingInfoOpen(true)}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 transition hover:border-fuchsia-200 hover:bg-fuchsia-50 hover:text-fuchsia-800"
                  aria-label="Show grouped Bullpen event legend"
                >
                  <Info className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
          {!isReadOnly && hasRows ? (
            <div className="flex w-full flex-col items-start gap-2">
              <div className="flex w-full flex-wrap items-center gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => (allSelected ? onClearAll() : onSelectAll())}
                  >
                    {allSelected ? "Clear All" : "Select All"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onClearAll}
                    disabled={selectedCount === 0}
                  >
                    Unselect
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onRefreshCurrentOdds}
                    disabled={isInvesting || isRefreshingCurrentOdds}
                    className="border-sky-200 bg-sky-50 text-sky-800 hover:bg-sky-100 hover:text-sky-900"
                  >
                    {isRefreshingCurrentOdds ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Refreshing...
                      </>
                    ) : (
                      "Refresh Current %"
                    )}
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleOpenPositions}>
                    {isLoadingPositions ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        {positionsLabel}
                      </>
                    ) : (
                      positionsLabel
                    )}
                  </Button>
                </div>
                <Button
                  onClick={onInvest}
                  disabled={
                    selectedCount === 0 || isInvesting || isRefreshingCurrentOdds
                  }
                  className="sm:ml-auto"
                >
                  {isInvesting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Investing...
                    </>
                  ) : (
                    `Invest${selectedCount > 0 ? ` · ${formatMoney(totalSelectedAmount)}` : ""}`
                  )}
                </Button>
              </div>
              {progressMessage ? (
                <p className="max-w-xl text-xs leading-5 text-slate-600">
                  {progressMessage}
                </p>
              ) : null}
              {!isInvesting && resultMessage ? (
                <p className="max-w-3xl rounded-xl border border-fuchsia-200 bg-fuchsia-50 px-3 py-2 text-xs font-semibold leading-5 text-fuchsia-950">
                  {resultMessage}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        {isReadOnly && readOnlyMessage ? (
          <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {readOnlyMessage}
          </div>
        ) : null}

        {!hasRows ? (
          <div className="mt-4 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
            {emptyMessage}
          </div>
        ) : (
          <>
            <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 rounded-2xl border border-fuchsia-100 bg-fuchsia-50/60 px-4 py-3 text-sm text-slate-700">
              <span>
                <span className="font-semibold text-slate-950">
                  {openActivePositions.length}
                </span>{" "}
                active position{openActivePositions.length === 1 ? "" : "s"}
              </span>
              <span>
                <span className="font-semibold text-slate-950">{candidates.length}</span>{" "}
                new opportunit{candidates.length === 1 ? "y" : "ies"}
              </span>
              <span>
                <span className="font-semibold text-slate-950">{selectedCount}</span>{" "}
                selected
              </span>
              <span>
                Total selected amount:{" "}
                <span className="font-semibold text-slate-950">
                  {formatMoney(totalSelectedAmount)}
                </span>
              </span>
            </div>

            <div className="mt-4 space-y-6">
              {activeInvestmentRows.length > 0 ? (
                <div className="space-y-3">
                  <EventsSectionHeader
                    title="Active Bullpen Positions"
                    tone="active"
                    lastRefreshedAt={sectionsLastRefreshedAt ?? positionsLastUpdatedAt}
                  />
                  {activeInvestmentRows.map((row) => {
                    const position = row.position;
                    const question = activePositionQuestionByKey.get(position.key);
                    return (
                      <RowShell key={`active-position-${position.key}`} active>
                        <div className="flex items-start gap-3">
                          <span
                            className="mt-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-emerald-700"
                            aria-label="Active position"
                            title="Active position"
                          >
                            <CheckCircle2 className="h-4 w-4" />
                          </span>
                          <div className="space-y-2">
                            <div className="block font-medium text-slate-950">
                              {position.marketTitle}
                            </div>
                            {watchFastPositionKeys.has(position.key) ? (
                              <div className="flex flex-wrap gap-2">
                                <AttentionBadge label="Watch Fast" tone="amber" />
                              </div>
                            ) : null}
                            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                              <span>Close: {formatDate(position.closeTime)}</span>
                              <span>Held outcome: {position.outcome || "—"}</span>
                              <span>
                                Avg price:{" "}
                                {formatOdds(
                                  position.averagePrice === null
                                    ? null
                                    : position.averagePrice * 100,
                                )}
                              </span>
                              <span>{position.shares.toLocaleString()} shares</span>
                            </div>
                            {position.marketUrl ? (
                              <a
                                href={position.marketUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-xs font-medium text-purple-700 hover:text-purple-900"
                              >
                                Open market
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                            ) : null}
                          </div>
                        </div>

                        <div className="grid min-w-full gap-3 text-sm md:min-w-[28rem] md:grid-cols-3 xl:min-w-[36rem]">
                          <CurrentOddsMetric
                            yesOdds={position.yesOdds}
                            noOdds={position.noOdds}
                            updatedAt={positionsLastUpdatedAt}
                          />
                          <LlmOddsMetric
                            question={question}
                            onOpenBreakdown={setBreakdownQuestion}
                            latestCompletedLlmRunId={latestCompletedLlmRunId}
                            currentInProgressLlmRunId={currentInProgressLlmRunId}
                          />
                          <MetricCard label="Returns/day">
                            <div className="font-semibold text-slate-900">
                              <button
                                type="button"
                                onClick={() =>
                                  setCalculationDialog({
                                    position,
                                  })
                                }
                                className="rounded-md text-left underline decoration-slate-300 underline-offset-4 transition hover:text-slate-700"
                              >
                                {formatReturnsPerDay(position.returnsPerDay)}
                              </button>
                            </div>
                          </MetricCard>
                        </div>
                      </RowShell>
                    );
                  })}
                </div>
              ) : null}

              {candidateInvestmentRows.length > 0 ? (
                <div className="space-y-3">
                  <EventsSectionHeader
                    title="New Scanned Opportunities"
                    tone="candidate"
                    lastRefreshedAt={sectionsLastRefreshedAt ?? positionsLastUpdatedAt}
                  />
                  {candidateInvestmentRows.map((row) => {
                    const question = row.question;
                    const checkboxId = `bullpen-investment-${question.id}`;
                    const investOutcome =
                      question.llmYesOdds !== null &&
                      question.llmYesOdds > 80 &&
                      (question.llmNoOdds === null || question.llmYesOdds >= question.llmNoOdds)
                        ? "Yes"
                        : "No";
                    return (
                      <RowShell
                        key={question.id}
                        selected={selectedQuestionIds.has(question.id)}
                      >
                        <div className="flex items-start gap-3">
                          <input
                            id={checkboxId}
                            type="checkbox"
                            checked={selectedQuestionIds.has(question.id)}
                            onChange={() => onToggleQuestion(question.id)}
                            className="mt-1 h-4 w-4 rounded border-slate-300 text-slate-950 focus:ring-slate-400"
                          />
                          <div className="space-y-2">
                            <div className="flex items-start gap-2">
                              <label
                                htmlFor={checkboxId}
                                className="block cursor-pointer font-medium text-slate-950"
                              >
                                {question.question}
                              </label>
                              <button
                                type="button"
                                onClick={() => setDetailsQuestion(question)}
                                className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-fuchsia-200 bg-white text-fuchsia-700 transition hover:bg-fuchsia-50"
                                aria-label={`Open structured details for ${question.question}`}
                                title="Open structured event details"
                              >
                                <Info className="h-3 w-3" />
                              </button>
                            </div>
                            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                              <span>Close: {formatDate(question.closeTime)}</span>
                              <span>Outcome: Buy {investOutcome}</span>
                              <span>
                                Added: {formatIstTimestamp(question.investmentTableAddedAt ?? null)}
                              </span>
                            </div>
                            {question.marketUrl ? (
                              <a
                                href={question.marketUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-xs font-medium text-purple-700 hover:text-purple-900"
                              >
                                Open market
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                            ) : null}
                          </div>
                        </div>

                        <div className="grid min-w-full gap-3 text-sm md:min-w-[28rem] md:grid-cols-3 xl:min-w-[36rem]">
                          <CurrentOddsMetric
                            yesOdds={question.yesOdds}
                            noOdds={question.noOdds}
                            updatedAt={question.currentOddsUpdatedAt ?? null}
                          />
                          <LlmOddsMetric
                            question={question}
                            onOpenBreakdown={setBreakdownQuestion}
                            latestCompletedLlmRunId={latestCompletedLlmRunId}
                            currentInProgressLlmRunId={currentInProgressLlmRunId}
                          />
                          <MetricCard label="Returns/day">
                            <div className="font-semibold text-slate-900">
                              {question.returnsPerDay === null ? (
                                formatReturnsPerDay(question.returnsPerDay)
                              ) : (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setCalculationDialog({
                                      question,
                                    })
                                  }
                                  className="rounded-md underline decoration-slate-300 underline-offset-4 transition hover:text-slate-700"
                                >
                                  {formatReturnsPerDay(question.returnsPerDay)}
                                </button>
                              )}
                            </div>
                          </MetricCard>
                        </div>
                      </RowShell>
                    );
                  })}
                </div>
              ) : null}

              {activePositionsNeedingAttention.length > 0 ? (
                <div className="space-y-3 pt-2">
                  <EventsSectionHeader
                    title="Event Exits"
                    tone="attention"
                    lastRefreshedAt={positionsLastUpdatedAt}
                    description={`Includes the union of Event out of Top 10 exits and capital-aware forced exits. Planned: ${eventExitCounts.total} · Event out of Top 10: ${eventExitCounts.rankingOrLlm} · Forced Exit: ${eventExitCounts.forced}.`}
                    titleAccessory={
                      <button
                        type="button"
                        onClick={() => setIsEventExitStrategiesDialogOpen(true)}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-red-300 bg-white/80 text-red-700 transition hover:bg-white hover:text-red-900"
                        aria-label="Explain Event Exit strategies"
                        title="Explain Event Exit strategies"
                      >
                        <Info className="h-3.5 w-3.5" />
                      </button>
                    }
                  />
                  {activePositionsNeedingAttention.map(
                    ({
                      position,
                      question,
                      reasonBadges,
                      estimatedFreeableValue,
                      exitState,
                      successfulExitAt,
                    }) => {
                    return (
                      <RowShell key={`active-position-outside-top-${position.key}`} attention>
                        <div className="flex items-start gap-3">
                          <span
                            className="mt-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-red-100 text-red-700"
                            aria-label="Active position outside top 10"
                            title="Active position outside top 10"
                          >
                            <AlertTriangle className="h-4 w-4" />
                          </span>
                          <div className="space-y-2">
                            <div className="block font-medium text-slate-950">
                              {position.marketTitle}
                            </div>
                            <div className="flex flex-wrap gap-2">
                              {reasonBadges.map((reasonBadge) => (
                                <AttentionBadge key={`${position.key}-${reasonBadge}`} label={reasonBadge} />
                              ))}
                              {exitState === "DUST_LOST" ? (
                                <AttentionBadge label="Dust" />
                              ) : null}
                              {successfulExitAt ? (
                                <span className="inline-flex items-center gap-1.5 rounded-full border border-red-300 bg-white/90 px-2.5 py-1 text-[11px] font-semibold text-red-900">
                                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                                  Exited out of Event at {formatIstTimestamp(successfulExitAt)}
                                </span>
                              ) : null}
                            </div>
                            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                              <span>Close: {formatDate(position.closeTime)}</span>
                              <span>Held outcome: {position.outcome || "—"}</span>
                              <span>
                                Avg price:{" "}
                                {formatOdds(
                                  position.averagePrice === null
                                    ? null
                                    : position.averagePrice * 100,
                                )}
                              </span>
                              <span>{position.shares.toLocaleString()} shares</span>
                            </div>
                            <div className="rounded-xl border border-red-200 bg-white/70 px-3 py-2 text-xs font-semibold text-red-800">
                              {estimatedFreeableValue !== null
                                ? `Executable exit value: ${formatMoney(estimatedFreeableValue)}`
                                : "Executable exit value is not currently available."}
                            </div>
                          </div>
                        </div>

                        <div className="grid min-w-full gap-3 text-sm md:min-w-[28rem] md:grid-cols-3 xl:min-w-[36rem]">
                          <CurrentOddsMetric
                            yesOdds={position.yesOdds}
                            noOdds={position.noOdds}
                            updatedAt={positionsLastUpdatedAt}
                          />
                          <LlmOddsMetric
                            question={question}
                            onOpenBreakdown={setBreakdownQuestion}
                            latestCompletedLlmRunId={latestCompletedLlmRunId}
                            currentInProgressLlmRunId={currentInProgressLlmRunId}
                          />
                          <MetricCard label="Returns/day">
                            <div className="font-semibold text-slate-900">
                              {formatReturnsPerDay(position.returnsPerDay)}
                            </div>
                          </MetricCard>
                        </div>
                      </RowShell>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </>
        )}
      </div>

      {isGroupingInfoOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <div className="max-w-2xl rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <h2 className="text-lg font-semibold text-slate-950">Grouped Bullpen events by action</h2>
              <button type="button" onClick={() => setIsGroupingInfoOpen(false)} className="text-sm font-semibold text-slate-500 hover:text-slate-900">Close</button>
            </div>
            <p className="mt-4 text-sm leading-6 text-slate-600">
              Green rows show active Bullpen positions, pink rows show new scanned opportunities, and red rows show active positions that are now in the Event Exits pipeline. The green and pink sections reflect the current top 10 rows ranked by <span className="font-semibold">returns/day</span> after Event Exit evaluation. The Invest action buys the stronger LLM side in Bullpen with a fixed <span className="font-semibold">$5</span> order per new opportunity.
            </p>
          </div>
        </div>
      ) : null}

      {detailsQuestion ? (
        <QuestionDetailsDialog
          question={detailsQuestion}
          isSelectedForInvest={selectedQuestionIds.has(detailsQuestion.id)}
          onClose={() => setDetailsQuestion(null)}
        />
      ) : null}

      {breakdownQuestion ? (
        <BullpenLlmBreakdownDialog
          question={breakdownQuestion}
          onClose={() => setBreakdownQuestion(null)}
        />
      ) : null}

      {isEventExitStrategiesDialogOpen ? (
        <BullpenEventExitStrategiesDialog
          onClose={() => setIsEventExitStrategiesDialogOpen(false)}
        />
      ) : null}

      {calculationDialog ? (
        <BullpenInvestmentMathDialog
          focus="returnsPerDay"
          question={calculationDialog.question}
          position={calculationDialog.position}
          onClose={() => setCalculationDialog(null)}
        />
      ) : null}

      {isPositionsDialogOpen ? (
        <BullpenPositionsDialog
          claimError={claimError}
          claimStatusMessage={claimStatusMessage}
          isClaiming={isClaimingPositions}
          isLoading={isLoadingPositions}
          lastUpdatedAt={positionsLastUpdatedAt}
          lastSuccessfulLiveSnapshot={lastSuccessfulLiveSnapshot}
          onClaimNow={onClaimNow}
          onClose={() => setIsPositionsDialogOpen(false)}
          onRefresh={onRefreshPositions}
          positions={activePositions}
          positionsError={positionsError}
          positionsFallback={positionsFallback}
          positionsHealth={positionsHealth}
          positionsSource={positionsSource}
        />
      ) : null}
    </>
  );
}

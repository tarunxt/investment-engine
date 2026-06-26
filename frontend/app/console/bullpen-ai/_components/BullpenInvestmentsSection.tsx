"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Loader2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  getBullpenLlmReviewState,
  hasBullpenLlmAnalysis,
  type BullpenQuestionRow,
} from "@/lib/bullpen-ai";
import { formatApiTimestamp } from "@/lib/datetime";
import type {
  BullpenActivePositionView,
  BullpenLiveHealth,
  BullpenLiveSnapshot,
  BullpenPositionsFallback,
  BullpenPositionsSource,
} from "@/lib/bullpenPositions";
import { cn } from "@/lib/utils";
import { BullpenInvestmentMathDialog } from "./BullpenInvestmentMathDialog";
import { BullpenLlmBreakdownDialog } from "./BullpenLlmBreakdownDialog";
import { BullpenPositionsDialog } from "./BullpenPositionsDialog";

type BullpenInvestmentsSectionProps = {
  activePositionsCount: number | null;
  activePositions: BullpenActivePositionView[];
  activePositionQuestions: BullpenQuestionRow[];
  candidates: BullpenQuestionRow[];
  claimError: string | null;
  claimStatusMessage: string | null;
  emptyMessage: string;
  isHistoryView: boolean;
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
  positionsSource: BullpenPositionsSource | null;
  progressMessage: string | null;
  resultMessage: string | null;
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
  accent = false,
  children,
  footer,
}: {
  label: string;
  accent?: boolean;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-xl px-3 py-2",
        accent ? "bg-fuchsia-500 text-slate-950" : "bg-slate-50",
      )}
    >
      <div
        className={cn(
          "text-[11px] font-semibold uppercase tracking-[0.12em]",
          accent ? "text-slate-900/80" : "text-slate-500",
        )}
      >
        {label}
      </div>
      <div className="mt-1">{children}</div>
      {footer ? (
        <div
          className={cn(
            "mt-2 border-t pt-2 text-[10px] font-medium leading-4",
            accent
              ? "border-slate-900/20 text-slate-900/80"
              : "border-slate-200 text-slate-500",
          )}
        >
          {footer}
        </div>
      ) : null}
    </div>
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

function LlmTimestamp({ completedAt }: { completedAt: string | null }) {
  return <span>Last LLM: {formatIstTimestamp(completedAt)}</span>;
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
}: {
  question: BullpenQuestionRow | null | undefined;
  onOpenBreakdown: (question: BullpenQuestionRow) => void;
}) {
  const reviewState = question ? getBullpenLlmReviewState(question) : null;
  const hasAnalysis = hasBullpenLlmAnalysis(question);
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
        <LlmTimestamp completedAt={question?.llmCompletedAt ?? null} />
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

export function BullpenInvestmentsSection({
  activePositionsCount,
  activePositions,
  activePositionQuestions,
  candidates,
  claimError,
  claimStatusMessage,
  emptyMessage,
  isHistoryView,
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
  positionsSource,
  progressMessage,
  resultMessage,
  selectedQuestionIds,
}: BullpenInvestmentsSectionProps) {
  const [breakdownQuestion, setBreakdownQuestion] =
    useState<BullpenQuestionRow | null>(null);
  const [calculationDialog, setCalculationDialog] = useState<{
    focus: "returnsPerDay" | "amountToBeInvested";
    question?: BullpenQuestionRow;
    position?: BullpenActivePositionView;
  } | null>(null);
  const [isPositionsDialogOpen, setIsPositionsDialogOpen] = useState(false);
  const openActivePositions = activePositions.filter((position) => !position.isClaimable);
  const activePositionQuestionByKey = useMemo(
    () =>
      new Map(
        activePositionQuestions.map((question) => [question.id, question] as const),
      ),
    [activePositionQuestions],
  );
  const topInvestmentRows = [
    ...openActivePositions.map((position) => ({
      kind: "active" as const,
      key: position.key,
      returnsPerDay: position.returnsPerDay,
      position,
    })),
    ...candidates.map((question) => ({
      kind: "candidate" as const,
      key: question.id,
      returnsPerDay: question.returnsPerDay,
      question,
    })),
  ]
    .sort((left, right) => (right.returnsPerDay ?? -Infinity) - (left.returnsPerDay ?? -Infinity))
    .slice(0, 10);
  const topActivePositionKeys = new Set(
    topInvestmentRows
      .filter((row) => row.kind === "active")
      .map((row) => row.key),
  );
  const activePositionsNeedingAttention = openActivePositions
    .map((position) => {
      const question = activePositionQuestionByKey.get(position.key);
      const hasStrongLlmOdds =
        (question?.llmYesOdds !== null &&
          question?.llmYesOdds !== undefined &&
          question.llmYesOdds > 80) ||
        (question?.llmNoOdds !== null &&
          question?.llmNoOdds !== undefined &&
          question.llmNoOdds > 80);
      const reasons = [
        !topActivePositionKeys.has(position.key) ? "not in the top 10 by returns/day" : null,
        !hasStrongLlmOdds ? "LLM Yes/No odds are not above 80%" : null,
      ].filter((reason): reason is string => Boolean(reason));

      return { position, question, reasons };
    })
    .filter((entry) => entry.reasons.length > 0);
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

  return (
    <>
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-fuchsia-700">
                Events to invest in
              </p>
              <h3 className="mt-1 text-lg font-semibold text-slate-950">
                Green rows from active positions and pink rows from the current
                Bullpen snapshot
              </h3>
            </div>
            <p className="max-w-3xl text-sm text-slate-600">
              Rows appear here when either <span className="font-semibold">LLM Yes Odds &gt; 80%</span>{" "}
              or <span className="font-semibold">LLM No Odds &gt; 80%</span>. The Invest action
              buys the stronger LLM side in Bullpen with a fixed <span className="font-semibold">$5</span>{" "}
              order per new opportunity. The combined table shows at most 10 rows ranked by{" "}
              <span className="font-semibold">returns/day</span>.
            </p>
          </div>
          {!isHistoryView && hasRows ? (
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

        {isHistoryView ? (
          <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            Switch back to the current snapshot to select events and place Bullpen orders.
          </div>
        ) : !hasRows ? (
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

            <div className="mt-4 space-y-3">
              {topInvestmentRows.map((row) => {
                if (row.kind === "candidate") return null;
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

                    <div className="grid min-w-full gap-3 text-sm md:min-w-[36rem] md:grid-cols-4 xl:min-w-[44rem]">
                      <CurrentOddsMetric
                        yesOdds={position.yesOdds}
                        noOdds={position.noOdds}
                        updatedAt={positionsLastUpdatedAt}
                      />
                      <LlmOddsMetric
                        question={question}
                        onOpenBreakdown={setBreakdownQuestion}
                      />
                      <MetricCard label="Returns/day">
                        <div className="font-semibold text-slate-900">
                          <button
                            type="button"
                            onClick={() =>
                              setCalculationDialog({
                                focus: "returnsPerDay",
                                position,
                              })
                            }
                            className="rounded-md text-left underline decoration-slate-300 underline-offset-4 transition hover:text-slate-700"
                          >
                            {formatReturnsPerDay(position.returnsPerDay)}
                          </button>
                        </div>
                      </MetricCard>
                      <MetricCard label="Capital" accent>
                        <div className="font-semibold">
                          <button
                            type="button"
                            onClick={() =>
                              setCalculationDialog({
                                focus: "amountToBeInvested",
                                position,
                              })
                            }
                            className="rounded-md text-left underline decoration-slate-900/30 underline-offset-4 transition hover:text-slate-800"
                          >
                            {formatMoney(position.currentValue ?? position.costBasis)}
                          </button>
                        </div>
                        <div className="mt-1 text-[11px] font-medium text-slate-900/80">
                          Current value
                        </div>
                      </MetricCard>
                    </div>
                  </RowShell>
                );
              })}

              {topInvestmentRows.map((row) => {
                if (row.kind === "active") return null;
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
                        <label
                          htmlFor={checkboxId}
                          className="block cursor-pointer font-medium text-slate-950"
                        >
                          {question.question}
                        </label>
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                          <span>Close: {formatDate(question.closeTime)}</span>
                          <span>Category: {question.category || "—"}</span>
                          <span>Outcome: Buy {investOutcome}</span>
                          <span>Added: {formatIstTimestamp(question.investmentTableAddedAt ?? null)}</span>
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

                    <div className="grid min-w-full gap-3 text-sm md:min-w-[36rem] md:grid-cols-4 xl:min-w-[44rem]">
                      <CurrentOddsMetric
                        yesOdds={question.yesOdds}
                        noOdds={question.noOdds}
                        updatedAt={question.currentOddsUpdatedAt ?? null}
                      />
                      <LlmOddsMetric
                        question={question}
                        onOpenBreakdown={setBreakdownQuestion}
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
                                  focus: "returnsPerDay",
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
                      <MetricCard label="Capital" accent>
                        <div className="font-semibold">
                          {question.amountToBeInvested === null ? (
                            formatMoney(question.amountToBeInvested)
                          ) : (
                            <button
                              type="button"
                              onClick={() =>
                                setCalculationDialog({
                                  focus: "amountToBeInvested",
                                  question,
                                })
                              }
                              className="rounded-md underline decoration-slate-900/30 underline-offset-4 transition hover:text-slate-800"
                            >
                              {formatMoney(question.amountToBeInvested)}
                            </button>
                          )}
                        </div>
                        <div className="mt-1 text-[11px] font-medium text-slate-900/80">
                          Buy amount
                        </div>
                      </MetricCard>
                    </div>
                  </RowShell>
                );
              })}

              {activePositionsNeedingAttention.length > 0 ? (
                <div className="space-y-3 pt-2">
                  <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-900">
                    Active positions below need attention because they are outside the top 10 by returns/day or do not have LLM Yes/No odds above 80%.
                  </div>
                  {activePositionsNeedingAttention.map(({ position, question, reasons }) => {
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
                            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                              <span>Close: {formatDate(position.closeTime)}</span>
                              <span>Held outcome: {position.outcome || "—"}</span>
                              <span>
                                Avg price: {formatOdds(position.averagePrice === null ? null : position.averagePrice * 100)}
                              </span>
                              <span>{position.shares.toLocaleString()} shares</span>
                            </div>
                            <div className="rounded-xl border border-red-200 bg-white/70 px-3 py-2 text-xs font-semibold text-red-800">
                              Attention: {reasons.join("; ")}
                            </div>

                          </div>
                        </div>

                        <div className="grid min-w-full gap-3 text-sm md:min-w-[36rem] md:grid-cols-4 xl:min-w-[44rem]">
                          <CurrentOddsMetric
                            yesOdds={position.yesOdds}
                            noOdds={position.noOdds}
                            updatedAt={positionsLastUpdatedAt}
                          />
                          <LlmOddsMetric question={question} onOpenBreakdown={setBreakdownQuestion} />
                          <MetricCard label="Returns/day">
                            <div className="font-semibold text-slate-900">{formatReturnsPerDay(position.returnsPerDay)}</div>
                          </MetricCard>
                          <MetricCard label="Capital" accent>
                            <div className="font-semibold">{formatMoney(position.currentValue ?? position.costBasis)}</div>
                            <div className="mt-1 text-[11px] font-medium text-slate-900/80">Current value</div>
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

      {breakdownQuestion ? (
        <BullpenLlmBreakdownDialog
          question={breakdownQuestion}
          onClose={() => setBreakdownQuestion(null)}
        />
      ) : null}

      {calculationDialog ? (
        <BullpenInvestmentMathDialog
          focus={calculationDialog.focus}
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

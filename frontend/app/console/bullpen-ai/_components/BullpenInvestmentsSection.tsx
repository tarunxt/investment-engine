"use client";

import { useState } from "react";
import { AlertTriangle, ExternalLink, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { BullpenQuestionRow } from "@/lib/bullpen-ai";
import type { BullpenActivePositionView } from "@/lib/bullpenPositions";
import { cn } from "@/lib/utils";
import { BullpenInvestmentMathDialog } from "./BullpenInvestmentMathDialog";
import { BullpenLlmBreakdownDialog } from "./BullpenLlmBreakdownDialog";
import { BullpenPositionsDialog } from "./BullpenPositionsDialog";

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
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

function hasHighLlmDisagreement(question: BullpenQuestionRow) {
  return question.llmDisagreementLevel === "High" || question.adjudicationRequired;
}

function LlmNoOddsValue({ question }: { question: BullpenQuestionRow }) {
  const showWarning = question.llmNoOdds !== null && hasHighLlmDisagreement(question);

  return (
    <span className="inline-flex items-center gap-1">
      <span>{formatOdds(question.llmNoOdds)}</span>
      {showWarning ? (
        <AlertTriangle
          aria-label="High LLM disagreement"
          className="h-3.5 w-3.5 shrink-0 text-amber-600"
          role="img"
        >
          <title>High LLM disagreement — review breakdown before relying on this odds value.</title>
        </AlertTriangle>
      ) : null}
    </span>
  );
}

export function BullpenInvestmentsSection({
  activePositionsCount,
  activePositions,
  candidates,
  claimError,
  claimStatusMessage,
  emptyMessage,
  isHistoryView,
  isClaimingPositions,
  isInvesting,
  isLoadingPositions,
  isRefreshingCurrentOdds,
  onClaimNow,
  onInvest,
  onRefreshPositions,
  onRefreshCurrentOdds,
  onToggleQuestion,
  onSelectAll,
  onClearAll,
  positionsError,
  positionsLastUpdatedAt,
  progressMessage,
  selectedQuestionIds,
}: {
  activePositionsCount: number | null;
  activePositions: BullpenActivePositionView[];
  candidates: BullpenQuestionRow[];
  claimError: string | null;
  claimStatusMessage: string | null;
  emptyMessage: string;
  isHistoryView: boolean;
  isClaimingPositions: boolean;
  isInvesting: boolean;
  isLoadingPositions: boolean;
  isRefreshingCurrentOdds: boolean;
  onClaimNow: () => void;
  onInvest: () => void;
  onRefreshPositions: () => void;
  onRefreshCurrentOdds: () => void;
  onToggleQuestion: (questionId: string) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
  positionsError: string | null;
  positionsLastUpdatedAt: string | null;
  progressMessage: string | null;
  selectedQuestionIds: Set<string>;
}) {
  const [breakdownQuestion, setBreakdownQuestion] =
    useState<BullpenQuestionRow | null>(null);
  const [calculationDialog, setCalculationDialog] = useState<{
    focus: "returnsPerDay" | "amountToBeInvested";
    question: BullpenQuestionRow;
  } | null>(null);
  const [isPositionsDialogOpen, setIsPositionsDialogOpen] = useState(false);
  const openActivePositions = activePositions.filter((position) => !position.isClaimable);
  const sortedCandidates = [...candidates].sort((left, right) => {
    const leftHasWarning = hasHighLlmDisagreement(left);
    const rightHasWarning = hasHighLlmDisagreement(right);

    if (leftHasWarning !== rightHasWarning) return leftHasWarning ? 1 : -1;
    return 0;
  });
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
                Pink rows from the current Bullpen snapshot
              </h3>
            </div>
            <p className="max-w-3xl text-sm text-slate-600">
              Rows appear here when <span className="font-semibold">LLM No Odds &gt; 80%</span> and{" "}
              <span className="font-semibold">Returns/day &gt; 5%</span>. The Invest action
              buys the <span className="font-semibold">No</span> side in Bullpen using the
              calculated amount.
            </p>
          </div>
          {!isHistoryView && (candidates.length > 0 || openActivePositions.length > 0) ? (
            <div className="flex flex-col items-start gap-2">
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
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleOpenPositions}
                  >
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
            </div>
          ) : null}
        </div>

        {isHistoryView ? (
          <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            Switch back to the current snapshot to select events and place Bullpen orders.
          </div>
        ) : candidates.length === 0 && openActivePositions.length === 0 ? (
          <div className="mt-4 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
            {emptyMessage}
          </div>
        ) : (
          <>
            <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 rounded-2xl border border-fuchsia-100 bg-fuchsia-50/60 px-4 py-3 text-sm text-slate-700">
              <span>
                <span className="font-semibold text-slate-950">{openActivePositions.length}</span> active
                position{openActivePositions.length === 1 ? "" : "s"}
              </span>
              <span>
                <span className="font-semibold text-slate-950">{candidates.length}</span> new
                opportunit{candidates.length === 1 ? "y" : "ies"}
              </span>
              <span>
                <span className="font-semibold text-slate-950">{selectedCount}</span> selected
              </span>
              <span>
                Total selected amount:{" "}
                <span className="font-semibold text-slate-950">{formatMoney(totalSelectedAmount)}</span>
              </span>
            </div>

            <div className="mt-4 space-y-3">
              {openActivePositions.map((position) => (
                <div
                  key={`active-position-${position.key}`}
                  className="flex flex-col gap-4 rounded-2xl border border-fuchsia-400 bg-fuchsia-50 px-4 py-4 transition md:flex-row md:items-start md:justify-between"
                >
                  <div className="flex items-start gap-3">
                    <span className="mt-1 rounded-full border border-fuchsia-300 bg-white px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-fuchsia-800">
                      Active
                    </span>
                    <div className="space-y-2">
                      <div className="block font-medium text-slate-950">
                        {position.marketTitle}
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                        <span>Close: {formatDate(position.closeTime)}</span>
                        <span>Outcome: {position.outcome || "—"}</span>
                        <span>{formatMoney(position.shares)} shares</span>
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

                  <div className="grid min-w-full gap-3 text-sm md:min-w-[25rem] md:grid-cols-4">
                    <div className="rounded-xl bg-slate-50 px-3 py-2">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                        Current Price
                      </div>
                      <div className="mt-1 font-semibold text-rose-700">
                        {formatOdds(position.currentPrice === null ? null : position.currentPrice * 100)}
                      </div>
                    </div>
                    <div className="rounded-xl bg-slate-50 px-3 py-2">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                        Avg Price
                      </div>
                      <div className="mt-1 font-semibold text-violet-700">
                        {formatOdds(position.averagePrice === null ? null : position.averagePrice * 100)}
                      </div>
                    </div>
                    <div className="rounded-xl bg-slate-50 px-3 py-2">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                        Returns/day
                      </div>
                      <div className="mt-1 font-semibold text-slate-900">
                        {formatReturnsPerDay(position.returnsPerDay)}
                      </div>
                    </div>
                    <div className="rounded-xl bg-fuchsia-500 px-3 py-2 text-slate-950">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-900/80">
                        Value
                      </div>
                      <div className="mt-1 font-semibold">
                        {formatMoney(position.currentValue ?? position.costBasis)}
                      </div>
                    </div>
                  </div>
                </div>
              ))}

              {sortedCandidates.map((question) => {
                const checkboxId = `bullpen-investment-${question.id}`;
                return (
                  <div
                    key={question.id}
                    className={cn(
                      "flex flex-col gap-4 rounded-2xl border px-4 py-4 transition md:flex-row md:items-start md:justify-between",
                      selectedQuestionIds.has(question.id)
                        ? "border-fuchsia-400 bg-fuchsia-50"
                        : "border-slate-200 bg-white hover:border-fuchsia-200",
                    )}
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
                          <span>Outcome: Buy No</span>
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

                    <div className="grid min-w-full gap-3 text-sm md:min-w-[25rem] md:grid-cols-4">
                      <div className="rounded-xl bg-slate-50 px-3 py-2">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                          Current No
                        </div>
                        <div className="mt-1 font-semibold text-rose-700">
                          {formatOdds(question.noOdds)}
                        </div>
                      </div>
                      <div className="rounded-xl bg-slate-50 px-3 py-2">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                          LLM No
                        </div>
                        <div className="mt-1 font-semibold text-violet-700">
                          {question.llmBreakdown.length > 0 ? (
                            <button
                              type="button"
                              onClick={() => setBreakdownQuestion(question)}
                              className="rounded-md underline decoration-violet-300 underline-offset-4 transition hover:text-violet-900"
                            >
                              <LlmNoOddsValue question={question} />
                            </button>
                          ) : (
                            <LlmNoOddsValue question={question} />
                          )}
                        </div>
                      </div>
                      <div className="rounded-xl bg-slate-50 px-3 py-2">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                          Returns/day
                        </div>
                        <div className="mt-1 font-semibold text-slate-900">
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
                      </div>
                      <div className="rounded-xl bg-fuchsia-500 px-3 py-2 text-slate-950">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-900/80">
                          Amount
                        </div>
                        <div className="mt-1 font-semibold">
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
                      </div>
                    </div>
                  </div>
                );
              })}
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
          onClaimNow={onClaimNow}
          onClose={() => setIsPositionsDialogOpen(false)}
          onRefresh={onRefreshPositions}
          positions={activePositions}
          positionsError={positionsError}
        />
      ) : null}
    </>
  );
}

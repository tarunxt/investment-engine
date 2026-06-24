"use client";

import type { ReactNode } from "react";

import {
  getBullpenPositionDaysUntilClose,
  type BullpenActivePositionView,
} from "@/lib/bullpenPositions";
import { X } from "lucide-react";

import {
  getBullpenAmountToBeInvestedBreakdown,
  getBullpenReturnsPerDayBreakdown,
  type BullpenQuestionRow,
} from "@/lib/bullpen-ai";

type BullpenInvestmentMathDialogProps = {
  focus: "returnsPerDay" | "amountToBeInvested";
  question?: BullpenQuestionRow;
  position?: BullpenActivePositionView;
  onClose: () => void;
};

function formatOdds(value: number | null) {
  if (value === null) return "—";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

function formatPercent(value: number | null) {
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

function formatDays(value: number | null) {
  if (value === null) return "—";
  return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function MetricRow({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-slate-100 py-3 first:border-t-0 first:pt-0 last:pb-0">
      <span className="text-sm text-slate-500">{label}</span>
      <span className="text-sm font-semibold text-slate-950">{value}</span>
    </div>
  );
}

function CalculationCard({
  title,
  formula,
  summary,
  children,
  highlighted = false,
}: {
  title: string;
  formula: string;
  summary: string;
  children: ReactNode;
  highlighted?: boolean;
}) {
  return (
    <section
      className={`rounded-2xl border p-5 ${
        highlighted
          ? "border-fuchsia-200 bg-fuchsia-50/60"
          : "border-slate-200 bg-white"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-950">{title}</h3>
          <p className="mt-1 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
            {formula}
          </p>
        </div>
        <div className="rounded-xl bg-slate-950 px-3 py-2 text-sm font-semibold text-white">
          {summary}
        </div>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function BullpenInvestmentMathDialog({
  focus,
  question,
  position,
  onClose,
}: BullpenInvestmentMathDialogProps) {
  const returnsBreakdown = question
    ? getBullpenReturnsPerDayBreakdown(question)
    : null;
  const amountBreakdown = question
    ? getBullpenAmountToBeInvestedBreakdown(question)
    : null;
  const positionDaysUntilClose = position
    ? getBullpenPositionDaysUntilClose(position.closeTime)
    : null;
  const positionPricePercent =
    position?.currentPrice === null || position?.currentPrice === undefined
      ? null
      : position.currentPrice > 1 && position.currentPrice <= 100
        ? position.currentPrice
        : position.currentPrice * 100;
  const positionCapital = position
    ? (position.currentValue ?? position.costBasis)
    : null;

  const returnsCard = question ? (
    <CalculationCard
      title="Returns/day"
      formula="If LLM No > 50%, (100 - Current No) / days; otherwise (100 - Current Yes) / days"
      summary={formatPercent(returnsBreakdown!.result)}
      highlighted={focus === "returnsPerDay"}
    >
      {returnsBreakdown!.result === null ? (
        <p className="text-sm leading-6 text-slate-600">
          This value is only available when the row has current Yes and No odds,
          consensus LLM odds, and a positive number of days until close.
        </p>
      ) : (
        <>
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-700">
            {`(100 - ${returnsBreakdown!.currentOdds?.toFixed(2) || "—"}) / ${returnsBreakdown!.daysUntilClose?.toFixed(1) || "—"} = ${returnsBreakdown!.result.toFixed(2)}% per day`}
          </div>
          <div className="mt-4">
            <MetricRow
              label="Spreadsheet side"
              value={
                returnsBreakdown!.currentSide
                  ? `${returnsBreakdown!.currentSide} (LLM No ${formatOdds(
                      returnsBreakdown!.llmNoOdds,
                    )})`
                  : "—"
              }
            />
            <MetricRow
              label="Current odds used"
              value={
                returnsBreakdown!.currentSide
                  ? `${returnsBreakdown!.currentSide} ${formatOdds(
                      returnsBreakdown!.currentOdds,
                    )}`
                  : "—"
              }
            />
            <MetricRow
              label="Days until close"
              value={formatDays(returnsBreakdown!.daysUntilClose)}
            />
          </div>
        </>
      )}
    </CalculationCard>
  ) : (
    <CalculationCard
      title="Returns/day"
      formula="(100 - current position price) / days until close"
      summary={formatPercent(position?.returnsPerDay ?? null)}
      highlighted={focus === "returnsPerDay"}
    >
      {position?.returnsPerDay === null || position?.returnsPerDay === undefined ? (
        <p className="text-sm leading-6 text-slate-600">
          This value is only available when the active position has a current
          price and a positive number of days until close.
        </p>
      ) : (
        <>
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-700">
            {`(100 - ${positionPricePercent?.toFixed(2) || "—"}) / ${positionDaysUntilClose?.toFixed(1) || "—"} = ${position.returnsPerDay.toFixed(2)}% per day`}
          </div>
          <div className="mt-4">
            <MetricRow label="Held outcome" value={position.outcome || "—"} />
            <MetricRow
              label="Current position price"
              value={formatOdds(positionPricePercent)}
            />
            <MetricRow
              label="Days until close"
              value={formatDays(positionDaysUntilClose)}
            />
          </div>
        </>
      )}
    </CalculationCard>
  );

  const amountCard = question ? (
    <CalculationCard
      title="Capital"
      formula="Fixed $5 once the row qualifies"
      summary={formatMoney(amountBreakdown!.result ?? null)}
      highlighted={focus === "amountToBeInvested"}
    >
      {amountBreakdown!.result === null ? (
        <p className="text-sm leading-6 text-slate-600">
          This amount is only available after the row has both LLM No odds and a
          returns/day value and clears the minimum thresholds.
        </p>
      ) : (
        <>
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-700">
            {`Qualified rows receive a fixed $${amountBreakdown!.fixedAmountUsd.toFixed(2)} order size.`}
          </div>
          <div className="mt-4">
            <MetricRow
              label="LLM No odds"
              value={formatOdds(amountBreakdown!.llmNoOdds ?? null)}
            />
            <MetricRow
              label={`Minimum LLM No odds`}
              value={formatOdds(amountBreakdown!.minLlmNoOdds)}
            />
            <MetricRow
              label="Returns/day input"
              value={formatPercent(amountBreakdown!.returnsPerDay ?? null)}
            />
            <MetricRow
              label="Minimum Returns/day"
              value={formatPercent(amountBreakdown!.minReturnsPerDay)}
            />
            <MetricRow
              label="Qualification"
              value={amountBreakdown!.qualifies ? "Qualified" : "Not qualified"}
            />
          </div>
          <p className="mt-4 text-xs leading-5 text-slate-500">
            Pink invest rows require both <span className="font-semibold">LLM No &gt; 80%</span>{" "}
            and <span className="font-semibold">Returns/day &gt; 5%</span>. Once both pass,
            the table uses a fixed <span className="font-semibold">$5</span> buy amount.
          </p>
        </>
      )}
    </CalculationCard>
  ) : (
    <CalculationCard
      title="Capital"
      formula="shares x current price (falls back to cost basis when unavailable)"
      summary={formatMoney(positionCapital)}
      highlighted={focus === "amountToBeInvested"}
    >
      {position ? (
        <>
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-700">
            {position.currentValue === null
              ? `Current value unavailable, using cost basis = ${formatMoney(position.costBasis)}`
              : `${position.shares.toLocaleString()} shares x ${formatMoney(position.currentPrice)} current price = ${formatMoney(position.currentValue)}`}
          </div>
          <div className="mt-4">
            <MetricRow label="Shares" value={position.shares.toLocaleString()} />
            <MetricRow label="Current price" value={formatMoney(position.currentPrice)} />
            <MetricRow label="Current value" value={formatMoney(position.currentValue)} />
            <MetricRow label="Cost basis fallback" value={formatMoney(position.costBasis)} />
          </div>
        </>
      ) : (
        <p className="text-sm leading-6 text-slate-600">No capital data is available.</p>
      )}
    </CalculationCard>
  );

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/55 p-4">
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.45)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
              {focus === "returnsPerDay"
                ? "Returns/day Calculation"
                : "Capital Calculation"}
            </p>
            <h2 className="max-w-3xl text-xl font-semibold text-slate-950">
              {question?.question ?? position?.marketTitle ?? "Investment calculation"}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close investment calculation"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-6 py-5">
          <div className="space-y-4">
            {focus === "returnsPerDay" ? returnsCard : amountCard}
            {focus === "returnsPerDay" ? amountCard : returnsCard}
          </div>
        </div>
      </div>
    </div>
  );
}

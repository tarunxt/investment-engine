"use client";

import { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";

import {
  getBullpenAmountToBeInvestedBreakdown,
  type BullpenQuestionRow,
} from "@/lib/bullpen-ai";
import {
  DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MAX_POSITIONS,
  DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MIN_LLM_SIDE_ODDS,
} from "@/lib/bullpenStage2To3Strategy";
import type { BullpenAutoLiveDecision } from "@/types/api";

type BullpenStage3ShortlistReasonDialogProps = {
  question: BullpenQuestionRow;
  historicalDecisions?: BullpenAutoLiveDecision[] | null;
  onClose: () => void;
};

function formatOdds(value: number | null) {
  if (value === null) return "—";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

function formatReturnsPerDay(value: number | null) {
  if (value === null) return "—";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

function normalizeTitle(value: string | null | undefined) {
  return (value || "").trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function findLatestDecision(
  question: BullpenQuestionRow,
  decisions: BullpenAutoLiveDecision[] | null | undefined,
) {
  const questionTitle = normalizeTitle(question.question);
  return [...(decisions || [])]
    .filter(
      (decision) =>
        decision.market_id === question.id ||
        normalizeTitle(decision.market_title) === questionTitle ||
        (Boolean(question.marketUrl) && decision.market_url === question.marketUrl),
    )
    .sort(
      (left, right) =>
        new Date(right.updated_at || right.created_at).getTime() -
        new Date(left.updated_at || left.created_at).getTime(),
    )[0];
}

function getShortlistExplanation(
  question: BullpenQuestionRow,
  historicalDecisions?: BullpenAutoLiveDecision[] | null,
) {
  const amount = getBullpenAmountToBeInvestedBreakdown(question);
  const latestDecision = findLatestDecision(question, historicalDecisions);

  if (latestDecision) {
    const wasShortlisted = ["BUY_NEW", "ADD_MORE"].includes(
      latestDecision.decision,
    );
    return {
      status: wasShortlisted ? "Shortlisted" : "Not shortlisted",
      reason: latestDecision.reason || latestDecision.summary,
      source: "Recorded Stage 3 decision",
      latestDecision,
    };
  }

  if (amount.strongestLlmOdds === null) {
    return {
      status: "Not shortlisted",
      reason:
        "Stage 3 could not evaluate this event because no usable consensus LLM Yes or No odds are available.",
      source: "Current table values",
    };
  }

  if (amount.strongestLlmOdds < amount.minStrongestLlmOdds) {
    return {
      status: "Not shortlisted",
      reason: `The strongest consensus LLM side is ${formatOdds(amount.strongestLlmOdds)}, below the required ${formatOdds(amount.minStrongestLlmOdds)} minimum.`,
      source: "Current table values",
    };
  }

  if (question.returnsPerDay === null) {
    return {
      status: "Not shortlisted",
      reason:
        "This event clears the LLM odds threshold, but its returns/day value is unavailable, so Stage 3 cannot rank it in the combined top-10 table.",
      source: "Current table values",
    };
  }

  return {
    status: "Eligible — no recorded Stage 3 result",
    reason: `This event clears the ${formatOdds(DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MIN_LLM_SIDE_ODDS)} LLM threshold. Stage 3 selects at most ${DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MAX_POSITIONS} eligible events by returns/day after it finishes reviewing the full eligible universe. No saved Stage 3 decision was found for this event, so this table alone cannot confirm whether it ranked outside the top 10 or was not included in that run.`,
    source: "Current table values",
  };
}

export function BullpenStage3ShortlistReasonDialog({
  question,
  historicalDecisions,
  onClose,
}: BullpenStage3ShortlistReasonDialogProps) {
  const titleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const explanation = getShortlistExplanation(question, historicalDecisions);
  const amount = getBullpenAmountToBeInvestedBreakdown(question);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center bg-slate-950/55 p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
        className="w-full max-w-xl rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_32px_90px_-32px_rgba(15,23,42,0.45)]"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">
              Stage 3 shortlist explanation
            </p>
            <h2 id={titleId} className="mt-2 text-lg font-semibold text-slate-950">
              {question.question}
            </h2>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close Stage 3 shortlist explanation"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-5 rounded-2xl border border-indigo-100 bg-indigo-50 p-4">
          <p className="text-sm font-semibold text-indigo-950">{explanation.status}</p>
          <p className="mt-2 text-sm leading-6 text-slate-700">{explanation.reason}</p>
          <p className="mt-3 text-xs font-medium text-slate-500">
            Source: {explanation.source}
          </p>
        </div>

        <dl className="mt-5 grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <dt className="text-xs font-medium text-slate-500">Strongest LLM side</dt>
            <dd className="mt-1 text-sm font-semibold text-slate-950">{formatOdds(amount.strongestLlmOdds)}</dd>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <dt className="text-xs font-medium text-slate-500">Minimum required</dt>
            <dd className="mt-1 text-sm font-semibold text-slate-950">{formatOdds(amount.minStrongestLlmOdds)}</dd>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <dt className="text-xs font-medium text-slate-500">Returns/day rank value</dt>
            <dd className="mt-1 text-sm font-semibold text-slate-950">{formatReturnsPerDay(question.returnsPerDay)}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

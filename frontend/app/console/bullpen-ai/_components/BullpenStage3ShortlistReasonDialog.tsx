"use client";

import { useEffect, useId, useRef } from "react";
import { CheckCircle2, X, XCircle } from "lucide-react";

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

type Stage3ShortlistExplanation = {
  status: string;
  reason: string;
  source: string;
  latestDecision?: BullpenAutoLiveDecision;
};

function getShortlistExplanation(
  question: BullpenQuestionRow,
  historicalDecisions?: BullpenAutoLiveDecision[] | null,
): Stage3ShortlistExplanation {
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
    status: "Eligible for Stage 3",
    reason: `This event clears the ${formatOdds(DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MIN_LLM_SIDE_ODDS)} LLM threshold and has a returns/day ranking value. It is eligible to move to Stage 3, where the combined top-${DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MAX_POSITIONS} ranking determines the final order plan.`,
    source: "Current table values",
  };
}

type ShortlistCheck = {
  label: string;
  detail: string;
  satisfied: boolean;
};

type Stage3Outcome = {
  completed: boolean;
  label: string;
  detail: string;
};

function getDecisionReason(decision: BullpenAutoLiveDecision) {
  return (
    decision.order_plan?.detail?.trim() ||
    decision.reason?.trim() ||
    decision.summary?.trim() ||
    "Stage 3 did not record a more specific reason."
  );
}

function isSuccessfulStage3Order(decision: BullpenAutoLiveDecision) {
  const orderPlan = decision.order_plan;
  if (!orderPlan) return false;
  if (["submitted", "confirmed"].includes(orderPlan.status)) return true;

  const executionText = `${orderPlan.detail ?? ""}\n${orderPlan.execution_response ?? ""}`;
  return (
    /successfully|submitted|filled|executed/i.test(executionText) &&
    !/failed|refusing|cancelled|canceled|skipped|not submitted/i.test(
      executionText,
    )
  );
}

function getStage3Outcome(
  latestDecision: BullpenAutoLiveDecision | undefined,
): Stage3Outcome {
  if (!latestDecision) {
    return {
      completed: false,
      label: "Not moved to Stage 3 yet",
      detail:
        "This event only meets the entry checks. Stage 3 has not recorded a final ranking or order outcome for it yet.",
    };
  }

  const wasShortlisted = ["BUY_NEW", "ADD_MORE"].includes(
    latestDecision.decision,
  );
  if (!wasShortlisted) {
    return {
      completed: false,
      label: "Not moved to Stage 3",
      detail: getDecisionReason(latestDecision),
    };
  }

  if (isSuccessfulStage3Order(latestDecision)) {
    return {
      completed: true,
      label: "Moved to Stage 3",
      detail:
        latestDecision.order_plan?.detail?.trim() ||
        "Stage 3 shortlisted this event and submitted its order.",
    };
  }

  const orderStatus = latestDecision.order_plan?.status;
  return {
    completed: false,
    label: "Not finally moved to Stage 3",
    detail: orderStatus
      ? `Stage 3 shortlisted this event, but its ${orderStatus.replaceAll("_", " ")} order did not complete. ${getDecisionReason(latestDecision)}`
      : `Stage 3 shortlisted this event, but no order outcome was recorded. ${getDecisionReason(latestDecision)}`,
  };
}

function getShortlistChecks(
  question: BullpenQuestionRow,
  historicalDecisions?: BullpenAutoLiveDecision[] | null,
): ShortlistCheck[] {
  const amount = getBullpenAmountToBeInvestedBreakdown(question);
  const latestDecision = findLatestDecision(question, historicalDecisions);
  const hasStrongestLlmOdds =
    amount.strongestLlmOdds !== null &&
    amount.strongestLlmOdds >= amount.minStrongestLlmOdds;
  const hasRankingValue = question.returnsPerDay !== null;
  const isShortlisted = latestDecision
    ? ["BUY_NEW", "ADD_MORE"].includes(latestDecision.decision)
    : hasStrongestLlmOdds && hasRankingValue;

  return [
    {
      label: "i) Strongest LLM odds ≥ 80%",
      detail:
        amount.strongestLlmOdds === null
          ? "No usable consensus LLM odds are available."
          : `${formatOdds(amount.strongestLlmOdds)} strongest side (minimum ${formatOdds(amount.minStrongestLlmOdds)}).`,
      satisfied: hasStrongestLlmOdds,
    },
    {
      label: "ii) Inside Top 10",
      detail: latestDecision
        ? isShortlisted
          ? "Recorded Stage 3 decision kept this event in the top-10 shortlist."
          : "Recorded Stage 3 decision did not keep this event in the top-10 shortlist."
        : hasStrongestLlmOdds && hasRankingValue
          ? `Eligible for the Stage 3 combined top-${DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MAX_POSITIONS} ranking.`
          : "This event cannot enter the top-10 ranking until its LLM and returns/day checks pass.",
      satisfied: isShortlisted,
    },
    {
      label: "iii) No other Stage 3 errors",
      detail: hasRankingValue
        ? "Returns/day is available and no additional local blocker was found."
        : "Returns/day is unavailable, so Stage 3 cannot rank this event.",
      satisfied: hasRankingValue,
    },
  ];
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
  const checks = getShortlistChecks(question, historicalDecisions);
  const outcome = getStage3Outcome(explanation.latestDecision);

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

        <div
          className={`mt-4 flex items-start gap-3 rounded-2xl border p-4 ${
            outcome.completed
              ? "border-emerald-200 bg-emerald-50"
              : "border-rose-200 bg-rose-50"
          }`}
          aria-live="polite"
        >
          {outcome.completed ? (
            <CheckCircle2
              aria-hidden="true"
              className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600"
            />
          ) : (
            <XCircle
              aria-hidden="true"
              className="mt-0.5 h-5 w-5 shrink-0 text-rose-600"
            />
          )}
          <div>
            <p className="text-sm font-semibold text-slate-950">
              Final Stage 3 outcome: {outcome.label}
            </p>
            <p className="mt-1 text-sm leading-6 text-slate-700">
              {outcome.detail}
            </p>
          </div>
        </div>

        <ol className="mt-5 space-y-3" aria-label="Stage 3 shortlist checks">
          {checks.map((check) => {
            const StatusIcon = check.satisfied ? CheckCircle2 : XCircle;
            return (
              <li
                key={check.label}
                className="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3"
              >
                <StatusIcon
                  aria-hidden="true"
                  className={`mt-0.5 h-5 w-5 shrink-0 ${
                    check.satisfied ? "text-emerald-600" : "text-rose-600"
                  }`}
                />
                <div>
                  <p className="text-sm font-semibold text-slate-950">{check.label}</p>
                  <p className="mt-1 text-sm text-slate-600">{check.detail}</p>
                </div>
              </li>
            );
          })}
        </ol>

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

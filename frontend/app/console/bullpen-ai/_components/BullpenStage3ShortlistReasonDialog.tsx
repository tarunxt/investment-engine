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
  currentTopTenQuestionIds?: ReadonlySet<string>;
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

function normalizeMatchKey(value: string | null | undefined) {
  const normalized = (value || "").trim().toLocaleLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function normalizeRunId(value: string | number | null | undefined) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return null;
}

function findLatestDecision(
  question: BullpenQuestionRow,
  decisions: BullpenAutoLiveDecision[] | null | undefined,
) {
  const normalizedRunId = normalizeRunId(question.llmRunId);
  const normalizedMarketId = normalizeMatchKey(question.id);
  const normalizedSlug = normalizeMatchKey(question.slug);
  const orderedDecisions = [...(decisions || [])].sort(
    (left, right) =>
      new Date(right.updated_at || right.created_at).getTime() -
      new Date(left.updated_at || left.created_at).getTime(),
  );

  const exactRunMarketDecision = orderedDecisions.find(
    (decision) =>
      normalizeRunId(decision.run_id) === normalizedRunId &&
      normalizeMatchKey(decision.market_id) === normalizedMarketId,
  );
  if (exactRunMarketDecision) {
    return exactRunMarketDecision;
  }

  return orderedDecisions.find(
    (decision) =>
      normalizeMatchKey(decision.market_id) === normalizedMarketId ||
      (normalizedSlug !== null &&
        normalizeMatchKey(decision.slug) === normalizedSlug),
  );
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
    const finalRank = getDecisionFinalRank(latestDecision);
    const maxPositions = getDecisionMaxPositions(latestDecision);
    const wasShortlisted = finalRank !== null && finalRank <= maxPositions;
    return {
      status:
        latestDecision.stage3_result === "BLOCKED"
          ? "Blocked"
          : wasShortlisted
            ? "Shortlisted"
            : "Not shortlisted",
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
    decision.stage3_result_reason?.trim() ||
    decision.order_plan?.detail?.trim() ||
    decision.reason?.trim() ||
    decision.summary?.trim() ||
    "Stage 3 did not record a more specific reason."
  );
}

function getDecisionFinalRank(decision: BullpenAutoLiveDecision | undefined) {
  if (!decision || typeof decision.stage3_final_rank !== "number") {
    return null;
  }
  return decision.stage3_final_rank;
}

function getDecisionMaxPositions(decision: BullpenAutoLiveDecision | undefined) {
  if (!decision || typeof decision.stage3_max_positions !== "number") {
    return DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MAX_POSITIONS;
  }
  return decision.stage3_max_positions;
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
        "This is a pending workflow status, not a market-data or LLM error. This event passes the local entry checks, but no Stage 3 worker run has yet saved its combined final rank or an order result.",
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

function Stage3PendingNextSteps() {
  return (
    <section
      className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4"
      aria-label="What Stage 3 still needs to do"
    >
      <p className="text-sm font-semibold text-amber-950">
        What still needs to happen before this can be invested
      </p>
      <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm leading-6 text-amber-950/85">
        <li>
          Start the <span className="font-semibold">Stage 3 · Exit and Invest</span>{" "}
          pass from the Auto-Live card (or wait for its enabled schedule). A
          Stage 2 LLM run only supplies candidate inputs; it does not place an
          order by itself.
        </li>
        <li>
          Stage 3 must receive a complete Stage 2 review, then rank every
          qualifying new event together with active positions. Only rows that
          remain in the final top 10 can receive a new-buy plan.
        </li>
        <li>
          If an exit is needed, Stage 3 processes it first and refreshes live
          wallet cash, occupied slots, and pending positions. This prevents a
          new buy from relying on stale capital or a duplicate position.
        </li>
        <li>
          For a live purchase, the execution guardrails must pass: Auto-Live
          is armed for live trading, the emergency stop is off, the Bullpen
          doctor and balance checks are healthy, and the calculated order size
          meets the minimum order amount.
        </li>
      </ol>
      <p className="mt-3 text-xs leading-5 text-amber-900">
        After the pass finishes, reopen this explanation. It will show the
        persisted final rank and whether the order was planned, submitted,
        skipped, or failed with the recorded reason.
      </p>
    </section>
  );
}

function getShortlistChecks(
  question: BullpenQuestionRow,
  historicalDecisions?: BullpenAutoLiveDecision[] | null,
  currentTopTenQuestionIds?: ReadonlySet<string>,
): ShortlistCheck[] {
  const amount = getBullpenAmountToBeInvestedBreakdown(question);
  const latestDecision = findLatestDecision(question, historicalDecisions);
  const hasStrongestLlmOdds =
    amount.strongestLlmOdds !== null &&
    amount.strongestLlmOdds >= amount.minStrongestLlmOdds;
  const hasRankingValue = question.returnsPerDay !== null;
  const finalRank = getDecisionFinalRank(latestDecision);
  const maxPositions = getDecisionMaxPositions(latestDecision);
  // The Event Summary Top 10 filter is calculated from the current table data.
  // Prefer it over a saved decision, which may be from an earlier Stage 3 run and
  // therefore not contain a final rank for the currently displayed event.
  const isInCurrentTopTen = currentTopTenQuestionIds?.has(question.id) ?? false;
  const rankingConfirmed = isInCurrentTopTen || finalRank !== null;
  const isShortlisted =
    isInCurrentTopTen || (finalRank !== null && finalRank <= maxPositions);
  const stage3Blocked = latestDecision?.stage3_result === "BLOCKED";

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
      detail: isInCurrentTopTen
        ? "Current Event Summary ranking places this event inside the top-10 shortlist."
        : latestDecision
        ? rankingConfirmed
          ? isShortlisted
            ? `Recorded Stage 3 decision confirmed final rank #${finalRank} inside the top-${maxPositions} shortlist.`
            : `Recorded Stage 3 decision confirmed final rank #${finalRank}, which stayed outside the top-${maxPositions} shortlist.`
          : "Ranking pending/failed because no persisted final rank was recorded for this event."
        : hasStrongestLlmOdds && hasRankingValue
          ? "Ranking pending/failed until Stage 3 persists a final rank for this event."
          : "This event cannot enter the top-10 ranking until its LLM and returns/day checks pass.",
      satisfied: isShortlisted,
    },
    {
      label: "iii) No other Stage 3 errors",
      detail: latestDecision
        ? stage3Blocked
          ? getDecisionReason(latestDecision)
          : "No persisted Stage 3 blocker was recorded for this event."
        : hasRankingValue
          ? "Returns/day is available and no additional local blocker was found yet."
          : "Returns/day is unavailable, so Stage 3 cannot rank this event.",
      satisfied: latestDecision ? !stage3Blocked : hasRankingValue,
    },
  ];
}

export function BullpenStage3ShortlistReasonDialog({
  question,
  historicalDecisions,
  currentTopTenQuestionIds,
  onClose,
}: BullpenStage3ShortlistReasonDialogProps) {
  const titleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const explanation = getShortlistExplanation(question, historicalDecisions);
  const amount = getBullpenAmountToBeInvestedBreakdown(question);
  const checks = getShortlistChecks(
    question,
    historicalDecisions,
    currentTopTenQuestionIds,
  );
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

        {!explanation.latestDecision ? <Stage3PendingNextSteps /> : null}

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

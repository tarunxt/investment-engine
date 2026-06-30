"use client";

import Link from "next/link";
import { useEffect, useEffectEvent, useState } from "react";
import {
  CalendarClock,
  CheckCircle2,
  Clock3,
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
  buildBullpenStage3OnlyInvestExecutionPlan,
  type BullpenStage3AlreadyInvestedRecord,
  selectBullpenStage3OnlyInvestSource,
} from "./bullpenAutoRunStage3Invest";
import { getInvestStageImmediateSuccess } from "./bullpenAutoRunStageStatus";
import { BullpenAutoRunStageOutputDialog } from "./BullpenAutoRunStageOutputDialog";
import { formatElapsedRunTime, formatStageElapsedTime } from "./bullpenAutoRunTimers";

type BullpenAutoRunScheduleCardProps = {
  onRunCompleted?: () => void | Promise<void>;
  buildRunNowRequest?: () =>
    | Promise<BullpenAutoLiveRunOnceRequest | null>
    | BullpenAutoLiveRunOnceRequest
    | null;
  activePositions?: BullpenActivePositionView[];
  hasActivePositionsSnapshot?: boolean;
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

type InvestMetricDialogKind = "decisions" | "planned" | "submitted";

type InvestMetricDialogState = {
  kind: InvestMetricDialogKind;
  run: BullpenAutoLiveRun;
  stage: ReturnType<typeof buildBullpenAutoRunWorkflowView>["stages"][number] | null;
  decisions: BullpenAutoLiveDecision[];
};

type ScanCandidateDialogState = {
  scanCompletedAt: string | null;
  candidates: ReturnType<typeof buildBullpenAutoRunWorkflowView>["stages"][number]["scanCandidates"];
  activePositions: ReturnType<typeof buildBullpenAutoRunWorkflowView>["stages"][number]["activePositionsFound"];
  activePositionCount: number;
};

const CONSOLE_PROFILE_ID = "bullpen_console_top10";
const POLL_INTERVAL_MS = 4_000;
const RUN_TIMER_INTERVAL_MS = 1_000;
const AUTO_RUN_TIMINGS = [
  "6:00 AM IST",
  "12:00 PM IST",
  "6:00 PM IST",
  "12:00 AM IST",
];

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

function formatMoney(value: number | null) {
  if (value === null) return "—";
  return `$${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
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
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isInvestMetricDecisionRow(value: unknown): value is BullpenAutoLiveDecision {
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
  stage: ReturnType<typeof buildBullpenAutoRunWorkflowView>["stages"][number] | null,
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
  stage: ReturnType<typeof buildBullpenAutoRunWorkflowView>["stages"][number] | null;
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
    if (!current || (Number.isFinite(nextMs) && (!Number.isFinite(currentMs) || nextMs >= currentMs))) {
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
    summary?.latest_guardrail_checks.find((check) => check.id === guardrailId) ??
    summary?.state.latest_guardrail_checks.find((check) => check.id === guardrailId) ??
    null
  );
}

function getInvestStageMetric(
  stage: ReturnType<typeof buildBullpenAutoRunWorkflowView>["stages"][number] | null,
  key: string,
  fallback: number,
) {
  if (!stage || stage.key !== "invest") return fallback;
  return readStageOutputNumber(stage.outputs[key]) ?? fallback;
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

  const executionGateReason = readStageOutputString(stage.outputs.execution_gate_reason);
  if (executionGateReason) {
    return {
      label: "Execution gate",
      message: executionGateReason,
      className: "border-rose-200 bg-rose-50/80 text-rose-900",
      detailClassName: "text-rose-800",
    };
  }

  const executionModeReason = readStageOutputString(stage.outputs.execution_mode_reason);
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
  const latestOrderDetail = latestOrderDecision?.order_plan?.detail?.trim() ?? null;
  if (
    latestOrderDecision &&
    latestOrderStatus &&
    latestOrderStatus !== "submitted" &&
    latestOrderDetail
  ) {
    const isFailure = latestOrderStatus === "failed" || latestOrderStatus === "cancelled";
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

  const activePositionRows = readStageOutputNumber(stage.outputs.active_position_rows);
  const candidateRows = readStageOutputNumber(stage.outputs.candidate_decision_rows);
  if (activePositionRows === null && candidateRows === null) return null;

  return `${activePositionRows ?? 0} Bullpen position ${activePositionRows === 1 ? "row" : "rows"} + ${candidateRows ?? 0} candidate ${candidateRows === 1 ? "row" : "rows"}`;
}

function StageOneOutputDialog({
  state,
  onClose,
}: {
  state: ScanCandidateDialogState;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/55 p-4">
      <div className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.45)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
              Stage 1 Output
            </p>
            <h2 className="text-xl font-semibold text-slate-950">
              New event opportunity candidates
            </h2>
            <p className="text-sm text-slate-600">
              Latest Bullpen Scan Stage 1 completed at {formatIstDateTime(state.scanCompletedAt)}.
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
                New event candidates
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
                    These live wallet positions were synced into the run before Stage 2 review.
                  </p>
                </div>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700">
                  {state.activePositionCount} {state.activePositionCount === 1 ? "position" : "positions"}
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
                              {position.theme ? <span>{position.theme}</span> : null}
                              {position.conditionId ? <span>{position.conditionId}</span> : null}
                            </div>
                          </td>
                          <td className="px-4 py-3 align-top text-slate-700">
                            {position.side ?? "—"}<br />
                            Shares {formatShares(position.shares)}<br />
                            Exposure {formatMoney(position.exposureUsd)}<br />
                            Avg {formatPriceCents(position.averagePriceCents)}
                          </td>
                          <td className="px-4 py-3 align-top text-slate-700">
                            Yes {formatOddsPercent(position.currentYesOdds)}<br />
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
                  {state.activePositionCount} active Bullpen {state.activePositionCount === 1 ? "position was" : "positions were"} synced for this run, but the detailed rows were not stored in this run record.
                </div>
              ) : (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-600">
                  No active Bullpen positions were recorded for this Stage 1 scan.
                </div>
              )}
            </section>

            <section className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    New event opportunity candidates
                  </p>
                  <p className="mt-1 text-sm text-slate-600">
                    Fresh Bullpen events that passed the Stage 1 scan filters.
                  </p>
                </div>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700">
                  {state.candidates.length} {state.candidates.length === 1 ? "candidate" : "candidates"}
                </span>
              </div>

              {state.candidates.length > 0 ? (
                <div className="overflow-hidden rounded-2xl border border-slate-200">
                  <table className="min-w-full divide-y divide-slate-200 text-sm">
                    <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                      <tr>
                        <th className="px-4 py-3">Candidate</th>
                        <th className="px-4 py-3">Odds</th>
                        <th className="px-4 py-3">Liquidity</th>
                        <th className="px-4 py-3">Close time</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 bg-white">
                      {state.candidates.map((candidate, index) => (
                        <tr key={`${candidate.slug || candidate.question}-${index}`}>
                          <td className="px-4 py-3 align-top">
                            <div className="font-semibold text-slate-950">
                              {candidate.marketUrl ? (
                                <a className="hover:text-sky-700 hover:underline" href={candidate.marketUrl} target="_blank" rel="noreferrer">
                                  {candidate.question}
                                </a>
                              ) : (
                                candidate.question
                              )}
                            </div>
                            <div className="mt-1 flex flex-wrap gap-2 text-xs text-slate-500">
                              {candidate.theme ? <span>{candidate.theme}</span> : null}
                              {candidate.forceInclude ? <span>Force included</span> : null}
                            </div>
                          </td>
                          <td className="px-4 py-3 align-top text-slate-700">
                            Yes {formatOddsPercent(candidate.currentYesOdds)}<br />
                            No {formatOddsPercent(candidate.currentNoOdds)}
                          </td>
                          <td className="px-4 py-3 align-top text-slate-700">
                            Liquidity {formatMoney(candidate.liquidityUsd)}<br />
                            Volume {formatMoney(candidate.volumeUsd)}
                          </td>
                          <td className="px-4 py-3 align-top text-slate-700">
                            {formatIstDateTime(candidate.closeTime)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-600">
                  No new event opportunity candidates were recorded for this Stage 1 scan.
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

function getInvestMetricDialogTitle(kind: InvestMetricDialogKind) {
  if (kind === "planned") return "Stage 3 planned orders";
  if (kind === "submitted") return "Stage 3 submitted orders";
  return "Stage 3 decisions";
}

function getInvestMetricDialogDescription(kind: InvestMetricDialogKind) {
  if (kind === "planned") {
    return "Decision rows where Stage 3 created an order plan for the selected side.";
  }
  if (kind === "submitted") {
    return "Decision rows where the planned order reached submitted status.";
  }
  return "All investment decisions recorded for this Stage 3 run.";
}

function getInvestMetricRows(state: InvestMetricDialogState) {
  if (state.kind === "planned") {
    return state.decisions.filter((decision) => decision.order_plan);
  }
  if (state.kind === "submitted") {
    return state.decisions.filter((decision) => decision.order_plan?.status === "submitted");
  }
  return state.decisions;
}

function formatInvestMetricOrderStatus(decision: BullpenAutoLiveDecision) {
  if (!decision.order_plan) return "No order planned";
  return decision.order_plan.status.replaceAll("_", " ");
}

function InvestMetricDetailsDialog({
  state,
  onClose,
}: {
  state: InvestMetricDialogState;
  onClose: () => void;
}) {
  const rows = getInvestMetricRows(state);
  const decisionsCount = getInvestStageMetric(state.stage, "decisions_count", state.run.decisions_count);
  const plannedCount = getInvestStageMetric(state.stage, "orders_planned", state.run.orders_planned);
  const submittedCount = getInvestStageMetric(state.stage, "orders_submitted", state.run.orders_submitted);
  const activePositionRows = state.stage
    ? readStageOutputNumber(state.stage.outputs.active_position_rows)
    : null;
  const candidateRows = state.stage
    ? readStageOutputNumber(state.stage.outputs.candidate_decision_rows)
    : null;

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/55 p-4">
      <div className="flex max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.45)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
              Stage 3 Details
            </p>
            <h2 className="text-xl font-semibold text-slate-950">
              {getInvestMetricDialogTitle(state.kind)}
            </h2>
            <p className="text-sm text-slate-600">
              {getInvestMetricDialogDescription(state.kind)}
            </p>
            <p className="text-xs text-slate-500">
              Run {state.run.id} · started {formatIstDateTime(state.run.started_at)}
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
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                Decisions
              </p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {decisionsCount}
              </p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                Planned
              </p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {plannedCount}
              </p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                Submitted
              </p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {submittedCount}
              </p>
            </div>
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

          <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200">
            {rows.length > 0 ? (
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Event</th>
                    <th className="px-4 py-3">Decision</th>
                    <th className="px-4 py-3">Edge & score</th>
                    <th className="px-4 py-3">Exposure</th>
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
                          {decision.theme} · closes {formatIstDateTime(decision.close_time)}
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
                        Edge {decision.edge_pp.toLocaleString("en-IN", { maximumFractionDigits: 2 })} pp
                        <br />
                        Score {decision.score.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                        <br />
                        Fair {formatOddsPercent(decision.fair_probability_pct)}
                      </td>
                      <td className="px-4 py-3 align-top text-slate-700">
                        Current {formatMoney(decision.current_exposure_usd)}
                        <br />
                        Target {formatMoney(decision.target_exposure_usd)}
                      </td>
                      <td className="px-4 py-3 align-top text-slate-700">
                        <span className="font-semibold capitalize">
                          {formatInvestMetricOrderStatus(decision)}
                        </span>
                        {decision.order_plan ? (
                          <>
                            <br />
                            {formatMoney(decision.order_plan.order_size_usd)} at{" "}
                            {formatPriceCents(decision.order_plan.limit_price_cents)}
                            <br />
                            {decision.order_plan.detail}
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

function buildConsoleSettingsUpdate() {
  return {
    strategy_profile: "bullpen_console_top10" as const,
    auto_live_enabled: true,
    dry_run: false,
    allow_live_execution: true,
    require_manual_confirmation: false,
  };
}

function isConsoleProfileSelected(summary: BullpenAutoLiveSummaryResponse | null) {
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

function statusLabel(summary: BullpenAutoLiveSummaryResponse | null) {
  if (!summary) return "Loading";
  if (!summary.settings.auto_live_enabled) return "Off";
  if (!isConsoleProfileSelected(summary)) return "Other profile active";
  if (summary.state.paused) return "Paused";
  if (summary.state.running) return "On";
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

function getVisibleRun(summary: BullpenAutoLiveSummaryResponse | null, pendingRunId: string | null) {
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
      container: "border-amber-300 bg-amber-50/90",
      badge: "border-amber-300 bg-amber-100 text-amber-900",
      text: "text-amber-950",
      muted: "text-amber-900/80",
      progress: "bg-amber-500",
      progressTrack: "bg-amber-200/80",
    };
  }
  if (tone === "green") {
    return {
      container: "border-emerald-300 bg-emerald-50/90",
      badge: "border-emerald-300 bg-emerald-100 text-emerald-900",
      text: "text-emerald-950",
      muted: "text-emerald-900/80",
      progress: "bg-emerald-500",
      progressTrack: "bg-emerald-200/80",
    };
  }
  return {
    container: "border-sky-300 bg-sky-50/90",
    badge: "border-sky-300 bg-sky-100 text-sky-900",
    text: "text-sky-950",
    muted: "text-sky-900/80",
    progress: "bg-sky-500",
    progressTrack: "bg-sky-200/80",
  };
}

export function BullpenAutoRunScheduleCard({
  onRunCompleted,
  buildRunNowRequest,
  activePositions = [],
  hasActivePositionsSnapshot = false,
  onSummaryUpdated,
}: BullpenAutoRunScheduleCardProps) {
  const [summary, setSummary] = useState<BullpenAutoLiveSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<ActionState>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);
  const [pendingRunId, setPendingRunId] = useState<string | null>(null);
  const [runNowStartedAt, setRunNowStartedAt] = useState<string | null>(null);
  const [timerNowMs, setTimerNowMs] = useState(() => Date.now());
  const [scanCandidateDialog, setScanCandidateDialog] =
    useState<ScanCandidateDialogState | null>(null);
  const [openStageKey, setOpenStageKey] = useState<"scan" | "llm" | "invest" | null>(null);
  const [openInputStageKey, setOpenInputStageKey] = useState<"llm" | "invest" | null>(null);
  const [investMetricDialog, setInvestMetricDialog] =
    useState<InvestMetricDialogState | null>(null);

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

  async function handleEnableAutoRuns() {
    setAction("enable");
    setNotice(null);
    setError(null);

    try {
      await apiService.updateBullpenAutoLiveSettings(buildConsoleSettingsUpdate());
      await apiService.startBullpenAutoLive();
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
      setNotice("Auto runs stopped. Any active Auto-Live run was cancelled immediately.");
    } catch (nextError) {
      setError(normalizeError(nextError));
    } finally {
      setAction(null);
    }
  }

  async function handleRunNow() {
    const startedAt = new Date().toISOString();
    setAction("run-now");
    setRunNowStartedAt(startedAt);
    setTimerNowMs(Date.parse(startedAt));
    setNotice(null);
    setError(null);

    try {
      const runNowRequest = (await buildRunNowRequest?.()) ?? undefined;
      await apiService.updateBullpenAutoLiveSettings(buildConsoleSettingsUpdate());
      const run = await apiService.runBullpenAutoLiveOnce(runNowRequest);
      setPendingRunId(run.id);
      setRunNowStartedAt(run.started_at ?? new Date().toISOString());
      await loadSummary({ preserveLoading: true, nextPendingRunId: run.id });
    } catch (nextError) {
      setError(normalizeError(nextError));
      setAction(null);
      setPendingRunId(null);
      setRunNowStartedAt(null);
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
      await apiService.updateBullpenAutoLiveSettings(buildConsoleSettingsUpdate());
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
      setNotice("Auto-Live stopped. Active backend work was cancelled immediately.");
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
  const workflowSettled = isBullpenAutoRunWorkflowSettled(workflowView);
  const hasActiveWorkflowStage = workflowView.stages.some((stage) => stage.isCurrent);
  const showRunTimer =
    action === "run-now" ||
    action === "invest-now" ||
    pendingRunId !== null ||
    visibleRun?.status === "running";
  const shouldTickTimers = showRunTimer || hasActiveWorkflowStage;
  const showActiveRunControls =
    !workflowSettled &&
    (action === "run-now" ||
      action === "invest-now" ||
      pendingRunId !== null ||
      visibleRun?.status === "running");
  const elapsedRunTime = formatElapsedRunTime(runTimerStartedAt, timerNowMs);
  const openStage = workflowView.stages.find((stage) => stage.key === openStageKey) ?? null;
  const openInputStage = workflowView.stages.find((stage) => stage.key === openInputStageKey) ?? null;
  const activeWorkflowStage =
    workflowView.stages.find((stage) => stage.isCurrent) ?? null;
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
    (workflowRun?.status === "running"
      ? activeWorkflowStage?.detail ?? workflowView.statusCopy
      : null);
  const backendExecutionGuardrail = findGuardrailCheck(summary, "live-execution-env");
  const backendExecutionBlocked = Boolean(
    backendExecutionGuardrail &&
      (((backendExecutionGuardrail.value ?? "").toString().toLowerCase() === "blocked") ||
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
  const investOnlyDisabledReason =
    pendingRunId !== null || visibleRun?.status === "running"
      ? "Wait for the active Auto-Live run to finish before starting another Invest pass."
      : investOnlyPlan.blockedReason;

  useEffect(() => {
    if (!shouldTickTimers) return;

    const intervalId = window.setInterval(() => {
      setTimerNowMs(Date.now());
    }, RUN_TIMER_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [shouldTickTimers, runTimerStartedAt]);

  return (
    <Card className="border-fuchsia-200 bg-[linear-gradient(135deg,rgba(253,242,248,0.98),rgba(239,246,255,0.98))] shadow-sm">
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-white/80 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-fuchsia-700">
                Auto Run Schedule
              </span>
              <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700">
                Status: {statusLabel(summary)}
              </span>
              <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700">
                Mode: {mode}
              </span>
            </div>
            <div>
              <h2 className="text-xl font-semibold text-slate-950">
                Bullpen Scan + LLM + Invest runs every 6 hours in IST
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-700">
                Scheduled runs use the Bullpen console top-10 profile: scan upcoming
                markets, run LLM consensus on every Stage 1 event, buy{" "}
                <span className="font-semibold">$5</span> of each new opportunity on
                the stronger LLM side when it ranks inside the top 10 by returns/day,
                and exit active positions that fall out of that top 10 list.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
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
                    Enable Auto Runs
                  </>
                )}
              </Button>
            )}
            <div className="flex flex-col items-stretch gap-1">
              <Button
                variant="outline"
                onClick={handleRunNow}
                disabled={action !== null || pendingRunId !== null}
                className="border-sky-200 bg-sky-50 text-sky-900 hover:bg-sky-100"
              >
                {action === "run-now" || pendingRunId ? (
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
                <div className="text-center text-xs font-semibold tabular-nums text-sky-800" aria-live="polite">
                  {elapsedRunTime}
                </div>
              ) : null}
            </div>
          </div>
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
              disabled={action !== null}
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

        <div className="flex flex-wrap gap-2">
          {AUTO_RUN_TIMINGS.map((timing) => (
            <span
              key={timing}
              className="rounded-full border border-fuchsia-200 bg-white px-3 py-1 text-sm font-medium text-slate-700"
            >
              {timing}
            </span>
          ))}
        </div>

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
              {consoleProfileSelected ? "Bullpen console top-10" : "Not active yet"}
            </p>
            <p className="mt-1 text-xs text-slate-600">
              Live orders still require Bullpen doctor, balance, and runtime safety
              checks to pass.
            </p>
          </div>
        </div>

        {!consoleProfileSelected && summary ? (
          <Alert className="border-amber-200 bg-amber-50 text-amber-950">
            <ShieldAlert className="h-4 w-4" />
            <AlertTitle>Another profile is currently selected</AlertTitle>
            <AlertDescription>
              Enabling this schedule will switch Auto-Live to the Bullpen console
              top-10 flow for this page.
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
                is off in the backend environment, so Stage 3 can review rows and
                simulate order plans but it cannot submit live Bullpen orders.
              </span>
              <span className="mt-2 block text-xs leading-5 text-rose-800">
                Set it to{" "}
                <code className="rounded bg-rose-100 px-1 py-0.5 font-semibold">
                  true
                </code>{" "}
                and restart the backend and Celery worker to unlock live execution.
              </span>
              {backendExecutionGuardrail?.detail ? (
                <span className="mt-2 block text-xs leading-5 text-rose-800">
                  {backendExecutionGuardrail.detail}
                </span>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : summary && summary.state.mode !== "live-trading" ? (
          <Alert className="border-sky-200 bg-sky-50 text-sky-950">
            <ShieldAlert className="h-4 w-4" />
            <AlertTitle>Live execution is still gated</AlertTitle>
            <AlertDescription>
              Scheduled runs can still queue and analyze markets, but live orders only
              submit when the backend environment, Auto-Live arming, and runtime
              health checks all allow trading. Manual locks and emergency stops still
              block Stage 3. Review the full controls if you need to inspect the
              current gate.
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="rounded-3xl border border-slate-200/80 bg-white/70 p-4 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Background execution monitor
                </p>
                {workflowRun ? (
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold text-slate-700">
                    {formatRunStatusLabel(workflowRun.status)}
                  </span>
                ) : null}
              </div>
              <p className="text-sm font-semibold text-slate-950">
                {workflowView.statusCopy}
              </p>
              <p className="text-xs text-slate-600">
                {workflowRun
                  ? `Run ${workflowRun.id} · started ${formatIstDateTime(workflowRun.started_at)}`
                  : "The 3-stage monitor turns yellow while working, green when finished, and blue while queued."}
              </p>
              <p className="text-xs text-slate-500">
                Worker stages. This panel refreshes every 4 seconds while the run is active.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700">
                {workflowView.currentStageLabel}
              </span>
              {workflowRun ? (
                <>
                  <button
                    type="button"
                    onClick={() => openInvestMetricDialog("decisions")}
                    className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700 transition hover:border-sky-200 hover:bg-sky-50 hover:text-sky-900"
                  >
                    {workflowDecisionCount ?? workflowRun.decisions_count} decisions
                  </button>
                  <button
                    type="button"
                    onClick={() => openInvestMetricDialog("planned")}
                    className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700 transition hover:border-sky-200 hover:bg-sky-50 hover:text-sky-900"
                  >
                    {workflowPlannedOrderCount ?? workflowRun.orders_planned} planned
                  </button>
                  <button
                    type="button"
                    onClick={() => openInvestMetricDialog("submitted")}
                    className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700 transition hover:border-sky-200 hover:bg-sky-50 hover:text-sky-900"
                  >
                    {workflowSubmittedOrderCount ?? workflowRun.orders_submitted} submitted
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
              const toneClasses = getWorkflowToneClasses(
                immediateSuccess ? "green" : stage.tone,
              );
              const canOpenInputs =
                (stage.key === "llm" || stage.key === "invest") &&
                Object.keys(stage.inputs).length > 0;
              const investStageCounters = getInvestStageCounters(stage);
              const investExecutionStatus = getInvestStageExecutionStatus(stage);
              const stageStatusLabel = immediateSuccess
                ? "Finished"
                : stage.state === "current"
                  ? "Working"
                  : stage.state === "finished"
                    ? "Finished"
                    : "In Queue";
              const stageProgressPercent = immediateSuccess ? 100 : stage.progressPercent;
              const showStageSpinner = stage.isCurrent && !immediateSuccess;

              return (
                <div
                  key={stage.key}
                  className={`relative rounded-2xl border p-4 shadow-sm transition ${toneClasses.container}`}
                >
                  {canOpenInputs ? (
                    <button
                      type="button"
                      onClick={() => setOpenInputStageKey(stage.key as "llm" | "invest")}
                      className={`absolute left-4 top-4 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border bg-white/75 transition hover:-translate-y-0.5 hover:bg-white ${toneClasses.badge}`}
                      aria-label={`Open ${stage.title} inputs`}
                      title="Input"
                    >
                      <LogIn className="h-5 w-5" />
                    </button>
                  ) : null}
                  <div className="flex items-start justify-between gap-3">
                    <div className={`space-y-1 ${canOpenInputs ? "pl-12" : ""}`}>
                      <p className={`text-sm font-semibold ${toneClasses.text}`}>
                        {stage.title}
                      </p>
                      <p className={`text-xs leading-5 ${toneClasses.muted}`}>
                        {stage.subtitle}
                      </p>
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
                    className={`mt-3 rounded-xl border border-white/60 bg-white/50 px-3 py-2 text-[11px] leading-5 ${toneClasses.muted}`}
                  >
                    <div>
                      Last stage run:{" "}
                      <span className="font-semibold tabular-nums">
                        {formatStageLastRunLabel(stage.timerCompletedAt ?? stage.timerStartedAt)}
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
                      <div>
                        New events found:{" "}
                        <span className="font-semibold tabular-nums">
                          {stage.scanCandidates.length}
                        </span>
                      </div>
                    ) : null}
                    {stage.key === "invest" && formatInvestStageRowMix(stage) ? (
                      <div>
                        Rows counted:{" "}
                        <span className="font-semibold">
                          {formatInvestStageRowMix(stage)}
                        </span>
                      </div>
                    ) : null}
                  </div>

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
                          className="rounded-xl border border-white/70 bg-white/60 px-3 py-2 text-left transition hover:-translate-y-0.5 hover:border-sky-200 hover:bg-white focus:outline-none focus:ring-2 focus:ring-sky-300"
                          aria-label={`Open Stage 3 ${counter.label.toLowerCase()} details`}
                        >
                          <p className={`text-[10px] font-semibold uppercase tracking-[0.14em] ${toneClasses.muted}`}>
                            {counter.label}
                          </p>
                          <p className={`mt-1 text-sm font-semibold tabular-nums ${toneClasses.text}`}>
                            {counter.value}
                          </p>
                        </button>
                      ))}
                    </div>
                  ) : null}

                  {investExecutionStatus ? (
                    <div className={`mt-3 rounded-xl border px-3 py-2 ${investExecutionStatus.className}`}>
                      <p className="text-[10px] font-semibold uppercase tracking-[0.14em]">
                        {investExecutionStatus.label}
                      </p>
                      <p className={`mt-1 text-xs leading-5 ${investExecutionStatus.detailClassName}`}>
                        {investExecutionStatus.message}
                      </p>
                    </div>
                  ) : null}

                  {stage.key === "invest" ? (
                    <div className="mt-3 space-y-2 rounded-xl border border-white/60 bg-white/50 px-3 py-3">
                      <button
                        type="button"
                        onClick={() => {
                          if (investOnlyPlan.request) {
                            void handleInvestOnly(investOnlyPlan.request);
                          }
                        }}
                        disabled={Boolean(investOnlyDisabledReason) || action !== null}
                        className={`inline-flex w-full items-center justify-center rounded-xl border px-3 py-2 text-sm font-semibold transition ${
                          investOnlyActionCompleted
                            ? "cursor-default border-emerald-200 bg-emerald-50 text-emerald-900"
                            : investOnlyDisabledReason || action !== null
                            ? "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400"
                            : "border-sky-200 bg-sky-50 text-sky-900 hover:bg-sky-100"
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
                            Invest
                          </>
                        )}
                      </button>
                      <p className={`text-[11px] leading-5 ${toneClasses.muted}`}>
                        Reuses the latest Stage 2-qualified rows and skips the Bullpen rescan plus LLM rerun.
                      </p>
                      {investOnlyDisabledReason ? (
                        <p className={`text-[11px] leading-5 ${toneClasses.muted}`}>
                          {investOnlyDisabledReason}
                        </p>
                      ) : investOnlyPlan.readyCandidateCount > 0 ? (
                        <p className={`text-[11px] leading-5 ${toneClasses.muted}`}>
                          {investOnlyPlan.readyCandidateCount} qualified{" "}
                          {investOnlyPlan.readyCandidateCount === 1 ? "event is" : "events are"} ready
                          for this invest-only pass.
                        </p>
                      ) : null}
                      {investOnlyPlan.alreadyInvestedCandidateCount > 0 ? (
                        <div className="space-y-2">
                          <p className="text-[11px] font-semibold leading-5 text-emerald-800">
                            {investOnlyPlan.alreadyInvestedCandidateCount} qualified{" "}
                            {investOnlyPlan.alreadyInvestedCandidateCount === 1 ? "event is" : "events are"} already invested and will be skipped.
                          </p>
                          <div className="max-h-40 space-y-2 overflow-y-auto pr-1">
                            {investOnlyPlan.candidatePreviews
                              .filter((preview) => preview.status === "already-invested")
                              .map((preview) => (
                                <div
                                  key={preview.candidate.market_id}
                                  className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-900"
                                >
                                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                                  <div className="min-w-0">
                                    <p className="font-semibold">
                                      {preview.candidate.market_title}
                                    </p>
                                    {preview.reason ? (
                                      <p className="leading-5 text-emerald-800">
                                        {preview.reason}
                                      </p>
                                    ) : null}
                                  </div>
                                </div>
                              ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  <div className={`mt-4 h-2 overflow-hidden rounded-full ${toneClasses.progressTrack}`}>
                    <div
                      className={`h-full rounded-full ${toneClasses.progress}`}
                      style={{ width: `${stageProgressPercent}%` }}
                    />
                  </div>

                  <div className="mt-3 flex items-center justify-between gap-3">
                    <p className={`text-xs font-semibold ${toneClasses.text}`}>
                      {stage.progressLabel}
                    </p>
                    {showStageSpinner ? (
                      <Loader2 className={`h-4 w-4 animate-spin ${toneClasses.text}`} />
                    ) : null}
                  </div>

                  <div className="mt-2 flex items-end justify-between gap-3">
                    <p className={`text-xs leading-5 ${toneClasses.muted}`}>
                      {stage.detail}
                    </p>
                    {stage.key === "scan" || Object.keys(stage.outputs).length > 0 ? (
                      <button
                        type="button"
                        onClick={() => {
                          if (stage.key === "scan") {
                            setScanCandidateDialog({
                              scanCompletedAt: stage.timerCompletedAt,
                              candidates: stage.scanCandidates,
                              activePositions: stage.activePositionsFound,
                              activePositionCount:
                                readStageOutputNumber(stage.outputs.active_wallet_positions) ??
                                readStageOutputNumber(stage.outputs.active_position_rows_before_llm) ??
                                stage.activePositionsFound.length,
                            });
                            return;
                          }
                          setOpenStageKey(stage.key);
                        }}
                        className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border bg-white/75 transition hover:-translate-y-0.5 hover:bg-white ${toneClasses.badge}`}
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
              <p className="mt-1 text-xs leading-5 text-rose-800">{error.details}</p>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-600">
          <span>
            Need deeper guardrail control? Open the dedicated Auto-Live dashboard for
            the same execution pipeline.
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
              openInputStage.key === "invest" ? stageInputAlreadyInvestedRecords : []
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

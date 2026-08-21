import type { BullpenAutoLiveDecision } from "@/types/api";

import type { BullpenAutoRunWorkflowStageView } from "./bullpenAutoRunProgress";

export type InvestStageImmediateSuccess = {
  submittedOrders: number;
  plannedOrders: number;
  latestMarketTitle: string | null;
  message: string;
};

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

function isInvestStageDecisionRow(value: unknown): value is BullpenAutoLiveDecision {
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

function readInvestStageDecisionRows(stage: BullpenAutoRunWorkflowStageView) {
  const rawDecisionRows = stage.outputs.decision_rows;
  if (!Array.isArray(rawDecisionRows)) return [];
  return rawDecisionRows.filter(isInvestStageDecisionRow);
}

function isCompletedInvestOrderStatus(status: string | null | undefined) {
  return status === "submitted" || status === "confirmed";
}

export function getInvestStageImmediateSuccess(
  stage: BullpenAutoRunWorkflowStageView | null,
): InvestStageImmediateSuccess | null {
  if (!stage || stage.key !== "invest") return null;
  if (stage.progressPercent < 100) return null;
  if (readStageOutputString(stage.outputs.execution_gate_reason)) return null;

  const plannedOrders = readStageOutputNumber(stage.outputs.orders_planned) ?? 0;
  const submittedOrders = readStageOutputNumber(stage.outputs.orders_submitted) ?? 0;
  if (plannedOrders < 1 || submittedOrders < plannedOrders) {
    return null;
  }

  const plannedDecisionRows = readInvestStageDecisionRows(stage).filter(
    (decision) => decision.order_plan,
  );
  if (plannedDecisionRows.length < plannedOrders) {
    return null;
  }
  if (
    plannedDecisionRows.some(
      (decision) => !isCompletedInvestOrderStatus(decision.order_plan?.status),
    )
  ) {
    return null;
  }

  const latestSubmittedDecision =
    [...plannedDecisionRows].reverse().find(
      (decision) => isCompletedInvestOrderStatus(decision.order_plan?.status),
    ) ?? null;
  const orderLabel = plannedOrders === 1 ? "order" : "orders";
  const message = latestSubmittedDecision
    ? `Rebalance and investment complete. Bullpen submitted ${submittedOrders} of ${plannedOrders} planned ${orderLabel}. Latest: ${latestSubmittedDecision.market_title}.`
    : `Rebalance and investment complete. Bullpen submitted ${submittedOrders} of ${plannedOrders} planned ${orderLabel}.`;

  return {
    submittedOrders,
    plannedOrders,
    latestMarketTitle: latestSubmittedDecision?.market_title ?? null,
    message,
  };
}

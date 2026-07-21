import type {
  BullpenAutoLiveDecision,
  BullpenAutoLiveOrderPlan,
} from "@/types/api";

export type InvestStepKey = "sell" | "buy";
export type InvestStepMetricKind = "planned" | "processed" | "submitted";
export type InvestExecutionStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "blocked";
export type Stage2TransferQueueMetricInfoKind =
  | "transferred-rows"
  | "concrete-buy-plans"
  | "submitted-buy-plans"
  | "waiting-blocked";
export type InvestMetricDialogKind =
  | "decisions"
  | "planned"
  | "submitted"
  | `${InvestStepKey}-${InvestStepMetricKind}`
  | "sell-exit-rows"
  | "sell-ranking-llm"
  | "sell-forced-exit"
  | "sell-redeem"
  | "sell-ranking-llm-planned"
  | "sell-forced-exit-planned"
  | "sell-redeem-planned";

type InvestMetricDialogDefinition = {
  title: string;
  description: string;
  includes: (decision: BullpenAutoLiveDecision) => boolean;
};

type Stage2TransferQueueMetricInfo = {
  title: string;
  summary: string;
  conditions: string[];
  prerequisites: string[];
  workflow: string[];
};

export type InvestStepCountsSummary = {
  plannedOrders: number;
  processedOrders: number;
  submittedOrders: number;
  eventExitRows?: number;
  rankingLlmPlannedOrders?: number;
  forcedExitPlannedOrders?: number;
  redeemPlannedOrders?: number;
  redeemProcessedOrders?: number;
  redeemSubmittedOrders?: number;
  rankingLlmSubmittedOrders?: number;
  forcedExitSubmittedOrders?: number;
};

const EVENT_EXIT_STATES = new Set(["EVENT_EXIT_PLANNED", "DUST_LOST"]);
const RANKING_LLM_EXIT_STRATEGIES = new Set([
  "OUTSIDE_TOP_10_RETURNS_DAY",
  "LLM_OR_ODDS_FILTER_EXIT",
]);
const FORCED_EXIT_STRATEGIES = new Set(["CAPITAL_AWARE_FORCED_EXIT"]);
const REDEEM_EXIT_STRATEGIES = new Set(["REDEEM_CLAIM"]);

const STAGE2_TRANSFER_QUEUE_METRIC_INFO: Record<
  Stage2TransferQueueMetricInfoKind,
  Stage2TransferQueueMetricInfo
> = {
  "transferred-rows": {
    title: "Transferred rows",
    summary:
      "The full saved Stage 2 Top 10 by Returns/day that Step 2 carries forward into the Stage 3 details popup, even before Stage 3 narrows that list into concrete buys.",
    conditions: [
      "The row qualified in the saved Stage 2 Events Summary and ranked inside the Top 10 by Returns/day.",
      "The row remains part of the saved Stage 2 handoff queue even if Stage 3 later plans fewer buys.",
    ],
    prerequisites: [
      "Stage 2 must have a reusable LLM-reviewed Events Summary snapshot for the run.",
      "The event needs a valid market ID so the saved Stage 2 row can be matched inside Stage 3.",
    ],
    workflow: [
      "Stage 2 reviews candidate events and saves the canonical Top 10 by Returns/day.",
      "Stage 3 Step 2 loads that saved Top 10 queue first, independent of later planning or submission results.",
    ],
  },
  "concrete-buy-plans": {
    title: "Concrete buy plans",
    summary:
      "Transferred rows that passed Step 2 planning and received an actual Stage 3 buy order plan.",
    conditions: [
      "Stage 3 created an order plan whose action is buy for that transferred row.",
      "The row survived Step 2 guardrails, sizing, and duplicate-position checks.",
    ],
    prerequisites: [
      "Step 1 exit handling must finish first because cash and occupied slots can change after exits.",
      "Live capital sizing must still produce a valid buy amount for the row.",
    ],
    workflow: [
      "Stage 3 refreshes the saved Stage 2 queue after Step 1 and evaluates each transferred row.",
      "Rows that still qualify become concrete buy plans and move from the transfer queue into planned orders.",
    ],
  },
  "submitted-buy-plans": {
    title: "Submitted",
    summary:
      "Concrete buy plans whose Bullpen order submission actually went through.",
    conditions: [
      "The row already had a concrete buy plan.",
      "The buy order status advanced to a submitted or successful execution state.",
    ],
    prerequisites: [
      "Bullpen order handling must accept the order without a blocker such as RPC, balance, or execution failure.",
      "The planned order must still be valid at submission time after live checks refresh.",
    ],
    workflow: [
      "Stage 3 submits concrete buy plans one at a time.",
      "A submitted or confirmed response moves the row into the Submitted count.",
    ],
  },
  "waiting-blocked": {
    title: "Still waiting / blocked",
    summary:
      "Transferred rows that are still in the saved Stage 2 queue but do not yet have a concrete buy plan or a submitted order.",
    conditions: [
      "The row stayed in the transferred queue but Stage 3 never created a buy order plan for it.",
      "The row can also remain here when Stage 3 recorded a blocker, a missing handoff, or another waiting reason.",
    ],
    prerequisites: [
      "The event must already exist in the saved Stage 2 Top 10 transfer queue.",
      "Some later Step 2 planning or execution condition must still be unresolved or blocked.",
    ],
    workflow: [
      "The row stays visible in the popup so the saved Stage 2 Top 10 remains complete.",
      "Its latest blocker or missing-handoff reason explains why it has not progressed into a concrete or submitted buy.",
    ],
  },
};

function hasOrderAction(
  decision: BullpenAutoLiveDecision,
  action: BullpenAutoLiveOrderPlan["action"],
) {
  return decision.order_plan?.action === action;
}

function hasExitStrategy(
  decision: BullpenAutoLiveDecision,
  strategies: Set<string>,
) {
  return decision.exit_signals.some((signal) => strategies.has(signal.strategy));
}

export function isProcessedInvestOrderPlan(
  orderPlan: BullpenAutoLiveOrderPlan | null | undefined,
) {
  return Boolean(orderPlan && orderPlan.status !== "planned");
}


export function isSubmittedOrSuccessfulInvestOrderPlan(
  orderPlan: BullpenAutoLiveOrderPlan | null | undefined,
) {
  if (!orderPlan) return false;
  if (
    orderPlan.status === "submitted" ||
    orderPlan.status === "confirmed" ||
    orderPlan.status === "filled" ||
    orderPlan.status === "settlement_pending" ||
    orderPlan.status === "already_redeemed" ||
    orderPlan.status === "resolved_zero_payout"
  ) {
    return true;
  }

  const successText = `${orderPlan.detail ?? ""}
${orderPlan.execution_response ?? ""}`;
  return (
    /successfully|submitted|filled|redeemed|claimed|executed/i.test(successText) &&
    !/failed|refusing|cancelled|canceled|skipped|not submitted/i.test(successText)
  );
}

function isSubmittedOrSuccessfulDecision(decision: BullpenAutoLiveDecision) {
  return isSubmittedOrSuccessfulInvestOrderPlan(decision.order_plan);
}

function isPlannedDecision(decision: BullpenAutoLiveDecision) {
  return decision.order_plan?.status === "planned";
}

export function summarizeInvestStepCountsFromDecisions(
  stepKey: InvestStepKey,
  decisions: BullpenAutoLiveDecision[],
): InvestStepCountsSummary {
  if (stepKey === "buy") {
    const buyDecisions = decisions.filter((decision) => hasOrderAction(decision, "buy"));
    return {
      plannedOrders: buyDecisions.length,
      processedOrders: buyDecisions.filter((decision) =>
        isProcessedInvestOrderPlan(decision.order_plan),
      ).length,
      submittedOrders: buyDecisions.filter((decision) =>
        isSubmittedOrSuccessfulDecision(decision),
      ).length,
    };
  }

  const sellDecisions = decisions.filter((decision) => {
    const action = decision.order_plan?.action;
    return action === "sell" || action === "redeem";
  });
  const redeemDecisions = sellDecisions.filter(
    (decision) =>
      decision.order_plan?.action === "redeem" ||
      hasExitStrategy(decision, REDEEM_EXIT_STRATEGIES),
  );
  const rankingLlmDecisions = sellDecisions.filter((decision) =>
    hasExitStrategy(decision, RANKING_LLM_EXIT_STRATEGIES),
  );
  const forcedExitDecisions = sellDecisions.filter((decision) =>
    hasExitStrategy(decision, FORCED_EXIT_STRATEGIES),
  );

  return {
    plannedOrders: sellDecisions.length,
    processedOrders: sellDecisions.filter((decision) =>
      isProcessedInvestOrderPlan(decision.order_plan),
    ).length,
    submittedOrders: sellDecisions.filter((decision) =>
      isSubmittedOrSuccessfulDecision(decision),
    ).length,
    eventExitRows: decisions.filter((decision) =>
      EVENT_EXIT_STATES.has(decision.exit_state),
    ).length,
    rankingLlmPlannedOrders: rankingLlmDecisions.filter((decision) =>
      isPlannedDecision(decision),
    ).length,
    forcedExitPlannedOrders: forcedExitDecisions.filter((decision) =>
      isPlannedDecision(decision),
    ).length,
    redeemPlannedOrders: redeemDecisions.filter((decision) =>
      isPlannedDecision(decision),
    ).length,
    redeemProcessedOrders: redeemDecisions.filter((decision) =>
      isProcessedInvestOrderPlan(decision.order_plan),
    ).length,
    redeemSubmittedOrders: redeemDecisions.filter((decision) =>
      isSubmittedOrSuccessfulDecision(decision),
    ).length,
    rankingLlmSubmittedOrders: rankingLlmDecisions.filter((decision) =>
      isSubmittedOrSuccessfulDecision(decision),
    ).length,
    forcedExitSubmittedOrders: forcedExitDecisions.filter((decision) =>
      isSubmittedOrSuccessfulDecision(decision),
    ).length,
  };
}

export function deriveInvestExecutionStepStatus({
  status,
  plannedOrders,
  processedOrders,
}: {
  status: InvestExecutionStepStatus;
  plannedOrders: number | null;
  processedOrders: number | null;
}) {
  if (
    status !== "blocked" &&
    plannedOrders !== null &&
    processedOrders !== null &&
    processedOrders >= plannedOrders
  ) {
    return "completed" as const;
  }
  return status;
}

export function getInvestStepMetricDialogKind(
  stepKey: InvestStepKey,
  metric: InvestStepMetricKind,
): InvestMetricDialogKind {
  return `${stepKey}-${metric}`;
}

export function getSellInvestMetricDialogKind(
  metric:
    | "event-exit-rows"
    | "ranking-llm"
    | "forced-exit"
    | "redeem"
    | "ranking-llm-planned"
    | "forced-exit-planned"
    | "redeem-planned",
): InvestMetricDialogKind {
  if (metric === "event-exit-rows") return "sell-exit-rows";
  if (metric === "ranking-llm") return "sell-ranking-llm";
  if (metric === "ranking-llm-planned") return "sell-ranking-llm-planned";
  if (metric === "redeem") return "sell-redeem";
  if (metric === "redeem-planned") return "sell-redeem-planned";
  if (metric === "forced-exit-planned") return "sell-forced-exit-planned";
  return "sell-forced-exit";
}

export function getInvestMetricDialogDefinition(
  kind: InvestMetricDialogKind,
): InvestMetricDialogDefinition {
  switch (kind) {
    case "planned":
      return {
        title: "Stage 3 planned orders",
        description:
          "Decision rows where Stage 3 created an order plan for the selected side.",
        includes: (decision) => Boolean(decision.order_plan),
      };
    case "submitted":
      return {
        title: "Stage 3 submitted orders",
        description:
          "Decision rows where the planned order reached submitted status.",
        includes: (decision) => isSubmittedOrSuccessfulDecision(decision),
      };
    case "sell-planned":
      return {
        title: "Stage 3 Step 1 planned exits",
        description:
          "Event Exit rows where Stage 3 created a sell order plan. This includes every sell plan state, such as ready, submitting, submitted, filled, skipped, or failed.",
        includes: (decision) => hasOrderAction(decision, "sell"),
      };
    case "sell-processed":
      return {
        title: "Stage 3 Step 1 processed exits",
        description:
          "Event Exit sell rows whose order moved beyond planned, including submitted, skipped, and failed results.",
        includes: (decision) =>
          hasOrderAction(decision, "sell") &&
          isProcessedInvestOrderPlan(decision.order_plan),
      };
    case "sell-submitted":
      return {
        title: "Stage 3 Step 1 submitted exits",
        description:
          "Event Exit sell rows whose order reached submitted or successful execution status. In-flight submitting rows stay in planned/processed details until Bullpen confirms submission.",
        includes: (decision) =>
          hasOrderAction(decision, "sell") &&
          isSubmittedOrSuccessfulDecision(decision),
      };
    case "buy-planned":
      return {
        title: "Stage 3 Step 2 planned buys",
        description:
          "Stage 3 buy rows where a planned order was created after Step 1.",
        includes: (decision) => hasOrderAction(decision, "buy"),
      };
    case "buy-processed":
      return {
        title: "Stage 3 Step 2 processed buys",
        description:
          "Stage 3 buy rows whose order moved beyond planned, including submitted, skipped, and failed results.",
        includes: (decision) =>
          hasOrderAction(decision, "buy") &&
          isProcessedInvestOrderPlan(decision.order_plan),
      };
    case "buy-submitted":
      return {
        title: "Stage 3 Step 2 submitted buys",
        description:
          "Stage 3 buy rows whose order reached submitted status.",
        includes: (decision) =>
          hasOrderAction(decision, "buy") &&
          isSubmittedOrSuccessfulDecision(decision),
      };
    case "sell-exit-rows":
      return {
        title: "Stage 3 Step 1 Event Exit rows",
        description:
          "Rows that entered the Event Exit pipeline, including dust-lost exits that were reviewed before any new buys.",
        includes: (decision) => EVENT_EXIT_STATES.has(decision.exit_state),
      };
    case "sell-ranking-llm":
      return {
        title: "Stage 3 Step 1 submitted Event out of Top 10 exits",
        description:
          "Event Exit rows triggered by the Event out of Top 10 exit logic whose order was submitted and confirmed by Bullpen.",
        includes: (decision) =>
          isSubmittedOrSuccessfulDecision(decision) &&
          hasExitStrategy(decision, RANKING_LLM_EXIT_STRATEGIES),
      };
    case "sell-ranking-llm-planned":
      return {
        title: "Stage 3 Step 1 planned Event out of Top 10 exits",
        description:
          "Event Exit rows triggered by the Event out of Top 10 exit logic that still have a planned order status.",
        includes: (decision) =>
          isPlannedDecision(decision) &&
          hasExitStrategy(decision, RANKING_LLM_EXIT_STRATEGIES),
      };
    case "sell-forced-exit":
      return {
        title: "Stage 3 Step 1 submitted forced exits",
        description:
          "Event Exit rows triggered by the capital-aware forced-exit guardrail whose order was submitted and confirmed by Bullpen.",
        includes: (decision) =>
          isSubmittedOrSuccessfulDecision(decision) &&
          hasExitStrategy(decision, FORCED_EXIT_STRATEGIES),
      };
    case "sell-forced-exit-planned":
      return {
        title: "Stage 3 Step 1 planned forced exits",
        description:
          "Event Exit rows triggered by the capital-aware forced-exit guardrail that still have a planned order status.",
        includes: (decision) =>
          isPlannedDecision(decision) &&
          hasExitStrategy(decision, FORCED_EXIT_STRATEGIES),
      };
    case "sell-redeem":
      return {
        title: "Stage 3 Step 1 submitted redeem/claim",
        description:
          "Resolved winning Bullpen positions whose redeem/claim order was submitted and confirmed by Bullpen.",
        includes: (decision) =>
          isSubmittedOrSuccessfulDecision(decision) &&
          (decision.order_plan?.action === "redeem" ||
            hasExitStrategy(decision, REDEEM_EXIT_STRATEGIES)),
      };
    case "sell-redeem-planned":
      return {
        title: "Stage 3 Step 1 planned redeem/claim",
        description:
          "Resolved winning Bullpen positions with redeem/claim order plans that still have a planned order status.",
        includes: (decision) =>
          isPlannedDecision(decision) &&
          (decision.order_plan?.action === "redeem" ||
            hasExitStrategy(decision, REDEEM_EXIT_STRATEGIES)),
      };
    case "decisions":
    default:
      return {
        title: "Stage 3 decisions",
        description: "All investment decisions recorded for this Stage 3 run.",
        includes: () => true,
      };
  }
}

export function getInvestMetricRows(
  kind: InvestMetricDialogKind,
  decisions: BullpenAutoLiveDecision[],
) {
  const definition = getInvestMetricDialogDefinition(kind);
  return decisions.filter(definition.includes);
}

export function getStage2TransferQueueMetricInfo(
  kind: Stage2TransferQueueMetricInfoKind,
) {
  return STAGE2_TRANSFER_QUEUE_METRIC_INFO[kind];
}

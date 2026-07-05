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
export type InvestMetricDialogKind =
  | "decisions"
  | "planned"
  | "submitted"
  | `${InvestStepKey}-${InvestStepMetricKind}`
  | "sell-exit-rows"
  | "sell-ranking-llm"
  | "sell-forced-exit";

type InvestMetricDialogDefinition = {
  title: string;
  description: string;
  includes: (decision: BullpenAutoLiveDecision) => boolean;
};

const EVENT_EXIT_STATES = new Set(["EVENT_EXIT_PLANNED", "DUST_LOST"]);
const RANKING_LLM_EXIT_STRATEGIES = new Set([
  "OUTSIDE_TOP_10_RETURNS_DAY",
  "LLM_OR_ODDS_FILTER_EXIT",
]);
const FORCED_EXIT_STRATEGIES = new Set(["CAPITAL_AWARE_FORCED_EXIT"]);

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
  metric: "event-exit-rows" | "ranking-llm" | "forced-exit",
): InvestMetricDialogKind {
  if (metric === "event-exit-rows") return "sell-exit-rows";
  if (metric === "ranking-llm") return "sell-ranking-llm";
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
        includes: (decision) => decision.order_plan?.status === "submitted",
      };
    case "sell-planned":
      return {
        title: "Stage 3 Step 1 planned exits",
        description:
          "Event Exit rows where Stage 3 created a sell order plan.",
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
          "Event Exit sell rows whose order reached submitted status.",
        includes: (decision) =>
          hasOrderAction(decision, "sell") &&
          decision.order_plan?.status === "submitted",
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
          decision.order_plan?.status === "submitted",
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
        title: "Stage 3 Step 1 ranking / LLM exits",
        description:
          "Event Exit rows triggered by the ranking / LLM exit logic.",
        includes: (decision) => hasExitStrategy(decision, RANKING_LLM_EXIT_STRATEGIES),
      };
    case "sell-forced-exit":
      return {
        title: "Stage 3 Step 1 forced exits",
        description:
          "Event Exit rows triggered by the capital-aware forced-exit guardrail.",
        includes: (decision) => hasExitStrategy(decision, FORCED_EXIT_STRATEGIES),
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

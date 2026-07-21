import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

async function loadInvestMetricsModule() {
  const source = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/bullpenAutoRunInvestMetrics.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: "bullpenAutoRunInvestMetrics.ts",
  });

  return import(
    `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`,
  );
}

function createDecision({
  id,
  action = null,
  status = null,
  exitState = "ACTIVE",
  exitStrategies = [],
} = {}) {
  return {
    id: id ?? `decision-${Math.random()}`,
    run_id: "run-1",
    market_id: `market-${id ?? "x"}`,
    market_title: `Market ${id ?? "x"}`,
    decision: action === "sell" ? "EXIT" : "BUY_NEW",
    side: "NO",
    reason: "test",
    exit_state: exitState,
    exit_signals: exitStrategies.map((strategy, index) => ({
      strategy,
      severity: "PLANNED_EXIT",
      reasonCode: "OUTSIDE_TOP_10_BY_RETURNS_DAY",
      label: `signal-${index}`,
      description: "signal",
      createdAt: "2026-07-05T12:00:00Z",
    })),
    order_plan: action
      ? {
          id: `order-${id ?? "x"}`,
          action,
          status,
        }
      : null,
  };
}

test("stale running execution steps flip to completed when processed catches planned", async () => {
  const { deriveInvestExecutionStepStatus } = await loadInvestMetricsModule();

  assert.equal(
    deriveInvestExecutionStepStatus({
      status: "running",
      plannedOrders: 2,
      processedOrders: 2,
    }),
    "completed",
  );
  assert.equal(
    deriveInvestExecutionStepStatus({
      status: "blocked",
      plannedOrders: 2,
      processedOrders: 2,
    }),
    "blocked",
  );
});

test("filled Stage 3 orders count as submitted", async () => {
  const { isSubmittedOrSuccessfulInvestOrderPlan } =
    await loadInvestMetricsModule();

  assert.equal(
    isSubmittedOrSuccessfulInvestOrderPlan({ status: "filled" }),
    true,
  );
});

test("Stage 3 metric filters break out sell, processed, and forced-exit rows", async () => {
  const {
    getInvestMetricRows,
    getInvestStepMetricDialogKind,
    getSellInvestMetricDialogKind,
  } = await loadInvestMetricsModule();

  const decisions = [
    createDecision({
      id: "sell-submitted",
      action: "sell",
      status: "submitted",
      exitState: "EVENT_EXIT_PLANNED",
      exitStrategies: ["OUTSIDE_TOP_10_RETURNS_DAY"],
    }),
    createDecision({
      id: "sell-failed",
      action: "sell",
      status: "failed",
      exitState: "EVENT_EXIT_PLANNED",
      exitStrategies: ["CAPITAL_AWARE_FORCED_EXIT"],
    }),
    createDecision({
      id: "buy-submitted",
      action: "buy",
      status: "submitted",
    }),
    createDecision({
      id: "buy-planned",
      action: "buy",
      status: "planned",
    }),
  ];

  assert.deepEqual(
    getInvestMetricRows(getInvestStepMetricDialogKind("sell", "processed"), decisions).map(
      (decision) => decision.id,
    ),
    ["sell-submitted", "sell-failed"],
  );
  assert.deepEqual(
    getInvestMetricRows(getInvestStepMetricDialogKind("buy", "submitted"), decisions).map(
      (decision) => decision.id,
    ),
    ["buy-submitted"],
  );

  assert.deepEqual(
    getInvestMetricRows(getSellInvestMetricDialogKind("ranking-llm"), decisions).map(
      (decision) => decision.id,
    ),
    ["sell-submitted"],
  );
  assert.deepEqual(
    getInvestMetricRows(getSellInvestMetricDialogKind("forced-exit"), decisions).map(
      (decision) => decision.id,
    ),
    [],
  );
});

test("decision rows recover submitted Step 2 counts when stored step tiles are stale", async () => {
  const { summarizeInvestStepCountsFromDecisions } =
    await loadInvestMetricsModule();

  const decisions = [
    createDecision({
      id: "buy-submitted",
      action: "buy",
      status: "submitted",
    }),
    createDecision({
      id: "buy-failed",
      action: "buy",
      status: "failed",
    }),
  ];

  assert.deepEqual(summarizeInvestStepCountsFromDecisions("buy", decisions), {
    plannedOrders: 2,
    processedOrders: 2,
    submittedOrders: 1,
  });
});


test("planned Event Exit strategy filters exclude submitted rows", async () => {
  const { getInvestMetricRows, getSellInvestMetricDialogKind } =
    await loadInvestMetricsModule();

  const decisions = [
    createDecision({
      id: "top10-planned",
      action: "sell",
      status: "planned",
      exitStrategies: ["OUTSIDE_TOP_10_RETURNS_DAY"],
    }),
    createDecision({
      id: "top10-submitted",
      action: "sell",
      status: "submitted",
      exitStrategies: ["OUTSIDE_TOP_10_RETURNS_DAY"],
    }),
    createDecision({
      id: "forced-planned",
      action: "sell",
      status: "planned",
      exitStrategies: ["CAPITAL_AWARE_FORCED_EXIT"],
    }),
    createDecision({
      id: "redeem-planned",
      action: "redeem",
      status: "planned",
      exitStrategies: ["REDEEM_CLAIM"],
    }),
    createDecision({
      id: "redeem-submitted",
      action: "redeem",
      status: "submitted",
      exitStrategies: ["REDEEM_CLAIM"],
    }),
  ];

  assert.deepEqual(
    getInvestMetricRows(
      getSellInvestMetricDialogKind("ranking-llm-planned"),
      decisions,
    ).map((decision) => decision.id),
    ["top10-planned"],
  );
  assert.deepEqual(
    getInvestMetricRows(
      getSellInvestMetricDialogKind("forced-exit-planned"),
      decisions,
    ).map((decision) => decision.id),
    ["forced-planned"],
  );
  assert.deepEqual(
    getInvestMetricRows(
      getSellInvestMetricDialogKind("redeem-planned"),
      decisions,
    ).map((decision) => decision.id),
    ["redeem-planned"],
  );
});

test("Stage 3 exit metric descriptions distinguish in-flight submitting rows", async () => {
  const { getInvestMetricDialogDefinition } = await loadInvestMetricsModule();

  const plannedDefinition = getInvestMetricDialogDefinition("sell-planned");
  const submittedDefinition = getInvestMetricDialogDefinition("sell-submitted");

  assert.match(plannedDefinition.description, /submitting/);
  assert.match(submittedDefinition.description, /In-flight submitting rows stay in planned\/processed details/);
});

test("schedule card wires step metric tiles into the shared popup flow", () => {
  const source = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(source, /getInvestStepMetricDialogKind\(step\.key, "planned"\)/);
  assert.match(source, /getInvestStepMetricDialogKind\(step\.key, "processed"\)/);
  assert.match(source, /getInvestStepMetricDialogKind\(step\.key, "submitted"\)/);
  assert.match(
    source,
    /onOpenMetricDetails=\{\s*workflowRun \? openInvestMetricDialog : undefined\s*\}/,
  );
  assert.match(source, /decisions: mergeInvestStageDecisionRows\(\{/);
  assert.match(source, /persistedDecisions:\s*\n\s*summary\?\.recent_decisions\.filter/);
  assert.match(source, /Selected filter/);
  assert.match(source, /Orders still not submitted/);
  assert.match(source, /value: step\.rankingLlmSubmittedOrders/);
  assert.match(source, /value: step\.forcedExitSubmittedOrders/);
  assert.match(source, /value: step\.redeemSubmittedOrders/);
});

test("persisted Stage 3 counters override historical decision-row maxima", () => {
  const source = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(source, /usesPersistedStage3ExecutionCounters/);
  assert.match(source, /persisted_order_intents/);
  assert.match(
    source,
    /const plannedOrders = usePersistedCounters\s*\?\s*\(readStageOutputNumber\(step\.planned_orders\) \?\? 0\)/,
  );
  assert.match(
    source,
    /submittedOrders: usePersistedCounters\s*\?\s*\(readStageOutputNumber\(step\.submitted_orders\) \?\? 0\)/,
  );
});

test("schedule card hides removed Stage 3 Step 1 exit shortlist copy", () => {
  const source = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.doesNotMatch(source, /Active positions shortlisted for exits/);
  assert.doesNotMatch(source, /Stage 3 Step 1 reviews active positions before any buy\s+orders/);
  assert.doesNotMatch(source, /No · 0 shortlisted/);
  assert.doesNotMatch(source, /Exit rows/);
  assert.doesNotMatch(source, /Rows counted/);
  assert.doesNotMatch(source, /Reuses the latest Stage 2-qualified rows/);
  assert.doesNotMatch(source, /No Step 2 Stage 3 planned orders were created/);
});

test("Stage 2 transfer queue metric definitions explain conditions, prerequisites, and workflow", async () => {
  const { getStage2TransferQueueMetricInfo } = await loadInvestMetricsModule();

  const transferredRows = getStage2TransferQueueMetricInfo("transferred-rows");
  assert.match(transferredRows.summary, /saved Stage 2 Top 10 by Returns\/day/i);
  assert.ok(transferredRows.conditions.length >= 2);
  assert.ok(transferredRows.prerequisites.length >= 2);
  assert.ok(transferredRows.workflow.length >= 2);

  const waitingBlocked = getStage2TransferQueueMetricInfo("waiting-blocked");
  assert.match(waitingBlocked.summary, /do not yet have a concrete buy plan/i);
  assert.ok(
    waitingBlocked.workflow.some((item) => /latest blocker or missing-handoff reason/i.test(item)),
  );
});

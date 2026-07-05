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
    getInvestMetricRows(getSellInvestMetricDialogKind("forced-exit"), decisions).map(
      (decision) => decision.id,
    ),
    ["sell-failed"],
  );
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
  assert.match(source, /onOpenMetricDetails=\{workflowRun \? openInvestMetricDialog : undefined\}/);
  assert.match(source, /Selected filter/);
  assert.match(source, /Orders still not submitted/);
});

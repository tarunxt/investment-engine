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

async function loadStage3SellExecutionModule() {
  const source = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/bullpenStage3SellExecution.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "bullpenStage3SellExecution.ts",
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
  withExecutionEvidence = false,
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
          dry_run: false,
          executed_at: withExecutionEvidence
            ? "2026-07-05T12:00:01Z"
            : null,
          remote_order_id: null,
          remote_transaction_hash: null,
          execution_response: null,
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

test("Stage 3 submitted and filled statuses require explicit execution evidence", async () => {
  const {
    hasInvestOrderSubmissionEvidence,
    isSubmittedOrSuccessfulInvestOrderPlan,
  } =
    await loadInvestMetricsModule();

  assert.equal(
    isSubmittedOrSuccessfulInvestOrderPlan({
      action: "sell",
      status: "filled",
      detail:
        "Wallet reconciliation confirmed the sell reduced the position to zero.",
      dry_run: false,
      executed_at: null,
      remote_order_id: null,
      remote_transaction_hash: null,
      execution_response: null,
    }),
    false,
  );
  assert.equal(
    isSubmittedOrSuccessfulInvestOrderPlan({
      action: "sell",
      status: "filled",
      detail: "Sell filled successfully.",
      dry_run: false,
    }),
    false,
  );
  assert.equal(
    isSubmittedOrSuccessfulInvestOrderPlan({
      action: "sell",
      status: "filled",
      dry_run: false,
      executed_at: "2026-07-05T12:00:01Z",
    }),
    true,
  );
  assert.equal(
    hasInvestOrderSubmissionEvidence({
      action: "buy",
      status: "submitted",
      dry_run: false,
      remote_order_id: "remote-order-1",
    }),
    true,
  );
  assert.equal(
    hasInvestOrderSubmissionEvidence({
      action: "buy",
      status: "submitted",
      dry_run: false,
      execution_response: "Order filled successfully.",
    }),
    false,
  );
  assert.equal(
    hasInvestOrderSubmissionEvidence({
      action: "buy",
      status: "submitted",
      dry_run: false,
      submission_evidence_present: true,
      submission_evidence_kind: "uncertain_write_boundary",
    }),
    true,
  );
  assert.equal(
    hasInvestOrderSubmissionEvidence({
      action: "buy",
      status: "submitted",
      dry_run: false,
      submission_evidence_present: false,
      executed_at: "2026-07-05T12:00:01Z",
    }),
    false,
  );
  assert.equal(
    isSubmittedOrSuccessfulInvestOrderPlan({
      action: "buy",
      status: "submitted",
      dry_run: true,
      remote_order_id: "dry-run-order",
    }),
    false,
  );
});

test("legacy FILLED exits without submission evidence stay out of same-run submitted and executed groups", async () => {
  const {
    partitionInvestDecisionsByExecutionEvidence,
    summarizeInvestStepCountsFromDecisions,
  } = await loadInvestMetricsModule();
  const decisions = [
    ...Array.from({ length: 5 }, (_, index) =>
      createDecision({
        id: `legacy-filled-sell-${index + 1}`,
        action: "sell",
        status: "filled",
      }),
    ),
    createDecision({
      id: "timed-out-buy",
      action: "buy",
      status: "timed_out",
    }),
  ];

  const groups = partitionInvestDecisionsByExecutionEvidence(decisions);

  assert.equal(groups.submittedOrExecuted.length, 0);
  assert.equal(groups.completedWithoutSubmission.length, 0);
  assert.deepEqual(
    groups.notSubmitted.map((decision) => decision.id),
    [
      "legacy-filled-sell-1",
      "legacy-filled-sell-2",
      "legacy-filled-sell-3",
      "legacy-filled-sell-4",
      "legacy-filled-sell-5",
      "timed-out-buy",
    ],
  );
  assert.equal(
    summarizeInvestStepCountsFromDecisions("sell", decisions).submittedOrders,
    0,
  );
  assert.equal(
    summarizeInvestStepCountsFromDecisions("buy", decisions).submittedOrders,
    0,
  );
});

test("evidence-backed terminal failures count as submitted but render separately", async () => {
  const {
    partitionInvestDecisionsByExecutionEvidence,
    summarizeInvestStepCountsFromDecisions,
  } = await loadInvestMetricsModule();
  const rejectedBuy = createDecision({
    id: "rejected-after-submit",
    action: "buy",
    status: "rejected",
  });
  rejectedBuy.order_plan.submission_evidence_present = true;
  rejectedBuy.order_plan.submission_evidence_kind = "remote_order_id";
  rejectedBuy.order_plan.remote_order_id = "remote-rejected-1";

  const groups = partitionInvestDecisionsByExecutionEvidence([rejectedBuy]);

  assert.deepEqual(groups.submittedOrExecuted, []);
  assert.deepEqual(
    groups.submittedButUnsuccessful.map((decision) => decision.id),
    ["rejected-after-submit"],
  );
  assert.deepEqual(groups.notSubmitted, []);
  assert.equal(
    summarizeInvestStepCountsFromDecisions("buy", [rejectedBuy])
      .submittedOrders,
    1,
  );
});

test("redeem no-action outcomes are completed separately without inflating submitted counts", async () => {
  const {
    isCompletedWithoutSubmissionInvestOrderPlan,
    partitionInvestDecisionsByExecutionEvidence,
    summarizeInvestStepCountsFromDecisions,
  } = await loadInvestMetricsModule();
  const noActionRedeem = createDecision({
    id: "already-redeemed",
    action: "redeem",
    status: "already_redeemed",
  });

  assert.equal(
    isCompletedWithoutSubmissionInvestOrderPlan(noActionRedeem.order_plan),
    true,
  );
  assert.deepEqual(
    partitionInvestDecisionsByExecutionEvidence([noActionRedeem])
      .completedWithoutSubmission.map((decision) => decision.id),
    ["already-redeemed"],
  );
  assert.equal(
    summarizeInvestStepCountsFromDecisions("sell", [noActionRedeem])
      .submittedOrders,
    0,
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
      withExecutionEvidence: true,
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
      withExecutionEvidence: true,
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
      withExecutionEvidence: true,
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
      withExecutionEvidence: true,
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
      withExecutionEvidence: true,
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

test("same-run schedule and detail views use the shared execution-evidence partition", () => {
  const source = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(source, /partitionInvestDecisionsByExecutionEvidence\(decisions\)/);
  assert.match(source, /partitionInvestDecisionsByExecutionEvidence\(tableRows\)/);
  assert.match(source, /isSubmittedOrExecutedInvestOrderPlan/);
  assert.match(source, /Completed without a New Order/);
  assert.match(source, /Submitted but Unsuccessful/);
  assert.match(source, /Orders Planned but not Submitted/);
  assert.doesNotMatch(source, /function isSubmittedOrSuccessfulOrderPlan/);
  assert.doesNotMatch(
    source,
    /successfully\|submitted\|filled\|redeemed\|claimed\|executed/,
  );
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

test("Stage 3 sell execution telemetry labels each bounded path and its fallback reason", async () => {
  const { getBullpenStage3SellExecutionTelemetry } =
    await loadStage3SellExecutionModule();
  const primary = getBullpenStage3SellExecutionTelemetry({
    action: "sell",
    execution_path: "market_sell_explicit",
    fallback_history: [
      {
        sequence: 1,
        layer: "primary",
        path: "market_sell_explicit",
        result: "accepted",
      },
    ],
  });
  const secondary = getBullpenStage3SellExecutionTelemetry({
    action: "sell",
    execution_path: "market_sell_max",
    fallback_history: [
      {
        sequence: 1,
        layer: "primary",
        path: "market_sell_explicit",
        result: "fallback",
        reason:
          "The primary response did not contain a remote order reference.",
        safe_to_fallback: true,
      },
      {
        sequence: 2,
        layer: "secondary",
        path: "market_sell_max",
        result: "accepted",
      },
    ],
  });
  const tertiary = getBullpenStage3SellExecutionTelemetry({
    action: "sell",
    execution_path: "limit_sell_fak",
    fallback_history: [
      {
        layer: "primary",
        path: "market_sell_explicit",
        result: "fallback",
        reason: "Explicit-share market sell is unsupported.",
        safe_to_fallback: true,
      },
      {
        layer: "secondary",
        path: "market_sell_max",
        result: "fallback",
        validation: "The max-share market sell failed before any remote write.",
        safe_to_fallback: true,
      },
      {
        layer: "tertiary",
        path: "limit_sell_fak",
        result: "accepted",
      },
    ],
  });

  assert.deepEqual(primary, {
    label: "Primary market sell",
    reason: null,
    sequence: 1,
  });
  assert.deepEqual(secondary, {
    label: "Fallback 2/3",
    reason: "The primary response did not contain a remote order reference.",
    sequence: 2,
  });
  assert.deepEqual(tertiary, {
    label: "Fallback 3/3",
    reason: "The max-share market sell failed before any remote write.",
    sequence: 3,
  });
});

test("legacy and non-sell Stage 3 rows do not gain execution telemetry", async () => {
  const { getBullpenStage3SellExecutionTelemetry } =
    await loadStage3SellExecutionModule();

  assert.equal(
    getBullpenStage3SellExecutionTelemetry({
      action: "sell",
      execution_path: null,
      fallback_history: null,
    }),
    null,
  );
  assert.equal(
    getBullpenStage3SellExecutionTelemetry({
      action: "buy",
      execution_path: "market_sell_max",
      fallback_history: [],
    }),
    null,
  );
});

test("Stage 3 order and detail cells render immediate-sell telemetry", () => {
  const source = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(source, /getBullpenStage3SellExecutionTelemetry/);
  assert.match(source, /Fallback reason:/);
  assert.ok(
    source.match(/<Stage3SellExecutionTelemetry[\s\S]*?decision=\{decision\}/g)
      ?.length >= 3,
  );
});

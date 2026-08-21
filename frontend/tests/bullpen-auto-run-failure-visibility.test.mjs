import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

async function loadProgressModule() {
  const source = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/bullpenAutoRunProgress.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: "bullpenAutoRunProgress.ts",
  });

  return import(
    `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`,
  );
}

function createStage(stageNumber, reason, outputs = {}) {
  return {
    stage_number: stageNumber,
    stage_name: `Stage ${stageNumber}`,
    status: "pass",
    reason,
    inputs: {},
    outputs,
    guardrails_checked: [],
    hard_block: false,
    started_at: "2026-07-01T08:00:00Z",
    completed_at:
      outputs.phase_status === "completed" ? "2026-07-01T08:01:00Z" : null,
  };
}

test("failed auto-run keeps Stage 3 highlighted but surfaces the failure summary", async () => {
  const { buildBullpenAutoRunWorkflowView } = await loadProgressModule();

  const view = buildBullpenAutoRunWorkflowView({
    id: "run-stage3-failed",
    triggered_by: "manual",
    status: "failed",
    dry_run: false,
    started_at: "2026-07-01T08:00:00Z",
    completed_at: "2026-07-01T08:04:23Z",
    summary:
      "Auto-Live run failed during Stage 3 · Exit and Invest: Future attached to a different loop",
    live_execution_requested: true,
    live_execution_attempted: true,
    decisions_count: 7,
    orders_planned: 3,
    orders_submitted: 0,
    error_message: "Future attached to a different loop",
    guardrail_checks: [],
    decision_ids: [],
    stage_results: [
      createStage(1, "Bullpen Scan finished.", {
        workflow_stage_key: "scan",
        phase_status: "completed",
        completed_items: 7,
        total_items: 7,
        item_label: "events",
      }),
      createStage(2, "Stage 2 reviewed candidates.", {
        workflow_stage_key: "llm",
        phase_status: "completed",
        completed_items: 7,
        total_items: 7,
        item_label: "events",
      }),
      createStage(3, "Stage 3 submitted 0 of 3 planned orders.", {
        workflow_stage_key: "invest",
        phase_status: "running",
        completed_items: 7,
        total_items: 7,
        item_label: "rows",
      }),
    ],
  });

  assert.equal(view.currentStageLabel, "Stage 3 · Exit and Invest");
  assert.equal(
    view.statusCopy,
    "Auto-Live run failed during Stage 3 · Exit and Invest: Future attached to a different loop",
  );
  assert.equal(view.stages[2].isCurrent, true);
  assert.match(view.stages[2].detail, /Worker error: Future attached to a different loop/);
});

test("failed auto-run uses persisted stage error output when available", async () => {
  const { buildBullpenAutoRunWorkflowView } = await loadProgressModule();

  const view = buildBullpenAutoRunWorkflowView({
    id: "run-stage3-failed-output",
    triggered_by: "manual",
    status: "failed",
    dry_run: false,
    started_at: "2026-07-01T08:00:00Z",
    completed_at: "2026-07-01T08:04:23Z",
    summary: "Auto-Live run failed during Stage 3 · Exit and Invest: worker error",
    live_execution_requested: true,
    live_execution_attempted: true,
    decisions_count: 7,
    orders_planned: 3,
    orders_submitted: 0,
    error_message: "generic worker error",
    guardrail_checks: [],
    decision_ids: [],
    stage_results: [
      createStage(3, "Stage 3 submitted 0 of 3 planned orders.", {
        workflow_stage_key: "invest",
        phase_status: "failed",
        error_message: "Future attached to a different loop",
      }),
    ],
  });

  assert.match(view.stages[2].detail, /Worker error: Future attached to a different loop/);
});

test("a user-cancelled auto-run does not leave a worker stage in progress", async () => {
  const { buildBullpenAutoRunWorkflowView } = await loadProgressModule();

  const view = buildBullpenAutoRunWorkflowView({
    id: "run-cancelled-by-user",
    triggered_by: "manual",
    status: "failed",
    dry_run: false,
    started_at: "2026-07-01T08:00:00Z",
    completed_at: "2026-07-01T08:04:23Z",
    summary: "Auto-Live run cancelled by user.",
    live_execution_requested: true,
    live_execution_attempted: true,
    decisions_count: 7,
    orders_planned: 3,
    orders_submitted: 0,
    error_message: "Cancelled by user",
    guardrail_checks: [],
    decision_ids: [],
    stage_results: [
      {
        ...createStage(3, "Cancelled by user.", {
          workflow_stage_key: "invest",
          phase_status: "cancelled",
        }),
        status: "fail",
        completed_at: "2026-07-01T08:04:23Z",
      },
    ],
  });

  assert.equal(view.stages[2].isCurrent, false);
  assert.equal(view.stages[2].state, "finished");
  assert.equal(view.stages[2].progressLabel, "Cancelled");
});

test("interrupted Stage 3 remains visible with persisted counters and interrupted status", async () => {
  const { buildBullpenAutoRunWorkflowView } = await loadProgressModule();

  const view = buildBullpenAutoRunWorkflowView({
    id: "run-stage3-interrupted",
    triggered_by: "manual",
    status: "failed",
    dry_run: false,
    started_at: "2026-07-01T08:00:00Z",
    completed_at: "2026-07-01T08:04:23Z",
    summary:
      "Stage 3 was interrupted by a worker/service restart. Recovery is required; persisted submissions will be reconciled and no order was automatically resubmitted.",
    live_execution_requested: true,
    live_execution_attempted: true,
    decisions_count: 25,
    orders_planned: 6,
    orders_submitted: 5,
    error_message:
      "Stage 3 was interrupted by a worker/service restart. Recovery is required; persisted submissions will be reconciled and no order was automatically resubmitted.",
    guardrail_checks: [],
    decision_ids: [],
    stage_results: [
      createStage(1, "Bullpen Scan finished.", {
        workflow_stage_key: "scan",
        phase_status: "completed",
      }),
      createStage(2, "Stage 2 reviewed candidates.", {
        workflow_stage_key: "llm",
        phase_status: "completed",
      }),
      {
        ...createStage(3, "Stage 3 was interrupted by a worker/service restart.", {
          workflow_stage_key: "invest",
          phase_status: "aborted",
          recovery_required: true,
          orders_planned: 6,
          orders_submitted: 5,
          execution_steps: [
            {
              key: "sell",
              label: "Event Exits",
              status: "completed",
              step_number: 1,
              step_total: 2,
              planned_orders: 5,
              processed_orders: 5,
              submitted_orders: 4,
            },
            {
              key: "buy",
              label: "Prepare investment queue",
              status: "running",
              step_number: 2,
              step_total: 2,
              planned_orders: 1,
              processed_orders: 1,
              submitted_orders: 1,
            },
          ],
        }),
        status: "fail",
        completed_at: "2026-07-01T08:04:23Z",
      },
    ],
  });

  const stage3 = view.stages[2];
  assert.equal(stage3.state, "finished");
  assert.equal(stage3.tone, "red");
  assert.equal(stage3.progressLabel, "Interrupted");
  assert.equal(stage3.timerCompletedAt, "2026-07-01T08:04:23Z");
  assert.equal(stage3.outputs.orders_planned, 6);
  assert.equal(stage3.outputs.orders_submitted, 5);
  assert.equal(stage3.outputs.execution_steps.length, 2);
});

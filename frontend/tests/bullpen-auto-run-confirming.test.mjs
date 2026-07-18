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
    `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
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
    started_at: "2026-07-18T10:00:00Z",
    completed_at:
      outputs.phase_status === "completed" ? "2026-07-18T10:05:00Z" : null,
  };
}

test("confirming auto-run keeps Stage 3 active while earlier stages stay finished", async () => {
  const { buildBullpenAutoRunWorkflowView } = await loadProgressModule();

  const view = buildBullpenAutoRunWorkflowView({
    id: "run-confirming",
    triggered_by: "manual",
    status: "confirming",
    dry_run: false,
    started_at: "2026-07-18T10:00:00Z",
    summary: "Stage 3 queued durable order intents and is still confirming terminal order state.",
    live_execution_requested: true,
    live_execution_attempted: false,
    decisions_count: 3,
    orders_planned: 3,
    orders_submitted: 2,
    error_message: null,
    guardrail_checks: [],
    decision_ids: ["decision-1", "decision-2", "decision-3"],
    stage_results: [
      createStage(1, "Bullpen Scan finished.", {
        workflow_stage_key: "scan",
        phase_status: "completed",
        completed_items: 18,
        total_items: 18,
        item_label: "events",
      }),
      createStage(2, "Stage 2 reviewed candidates.", {
        workflow_stage_key: "llm",
        phase_status: "completed",
        completed_items: 18,
        total_items: 18,
        item_label: "events",
      }),
      createStage(3, "Durable Stage 3 order intents were queued for asynchronous execution and confirmation.", {
        workflow_stage_key: "invest",
        phase_status: "confirming",
        completed_items: 3,
        total_items: 3,
        item_label: "rows",
      }),
    ],
  });

  assert.equal(view.currentStageLabel, "Stage 3 · Exit and Invest");
  assert.equal(view.stages[0].tone, "green");
  assert.equal(view.stages[1].tone, "green");
  assert.equal(view.stages[2].tone, "yellow");
  assert.equal(view.stages[2].state, "current");
  assert.equal(view.stages[2].timerCompletedAt, null);
});

test("partial-success auto-run does not present Stage 3 as a green success", async () => {
  const { buildBullpenAutoRunWorkflowView } = await loadProgressModule();

  const view = buildBullpenAutoRunWorkflowView({
    id: "run-partial-success",
    triggered_by: "manual",
    status: "partial_success",
    dry_run: false,
    started_at: "2026-07-18T10:00:00Z",
    completed_at: "2026-07-18T10:09:00Z",
    summary: "Stage 3 confirmed 2 of 3 durable order intents, but one order exhausted its retry budget.",
    live_execution_requested: true,
    live_execution_attempted: true,
    decisions_count: 3,
    orders_planned: 3,
    orders_submitted: 3,
    error_message: null,
    guardrail_checks: [],
    decision_ids: ["decision-1", "decision-2", "decision-3"],
    stage_results: [
      createStage(1, "Bullpen Scan finished.", {
        workflow_stage_key: "scan",
        phase_status: "completed",
      }),
      createStage(2, "Stage 2 reviewed candidates.", {
        workflow_stage_key: "llm",
        phase_status: "completed",
      }),
      createStage(3, "Stage 3 finished with mixed durable order outcomes.", {
        workflow_stage_key: "invest",
        phase_status: "completed",
      }),
    ],
  });

  assert.equal(view.currentStageLabel, "Stage 3 finished with partial success");
  assert.equal(view.stages[2].state, "finished");
  assert.notEqual(view.stages[2].tone, "green");
});

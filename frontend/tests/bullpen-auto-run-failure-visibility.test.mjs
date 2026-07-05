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

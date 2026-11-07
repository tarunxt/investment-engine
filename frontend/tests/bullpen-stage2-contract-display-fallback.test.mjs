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

function stage(stageNumber, workflowStageKey, outputs = {}) {
  return {
    stage_number: stageNumber,
    stage_name: `Stage ${stageNumber}`,
    status: outputs.phase_status === "blocked" ? "warning" : "pass",
    reason: `${workflowStageKey} stage`,
    inputs: {},
    outputs: {
      workflow_stage_key: workflowStageKey,
      ...outputs,
    },
    guardrails_checked: [],
    hard_block: outputs.phase_status === "blocked",
    started_at: "2026-07-29T04:00:00Z",
    completed_at: "2026-07-29T04:01:00Z",
  };
}

function run(stageResults) {
  return {
    id: "run-stage2-display",
    triggered_by: "auto",
    status: "partial_success",
    dry_run: false,
    started_at: "2026-07-29T04:00:00Z",
    completed_at: "2026-07-29T04:02:00Z",
    summary:
      "Stage 3 preserved planned order intents and paused Auto Runs pending Bullpen support.",
    live_execution_requested: true,
    live_execution_attempted: false,
    decisions_count: 39,
    orders_planned: 12,
    orders_submitted: 0,
    error_message: null,
    guardrail_checks: [],
    decision_ids: [],
    stage_results: stageResults,
  };
}

test("Stage 2 display recovers exact authoritative IDs from a persisted handoff stage", async () => {
  const { buildBullpenAutoRunWorkflowView } = await loadProgressModule();
  const view = buildBullpenAutoRunWorkflowView(
    run([
      stage(1, "scan", { phase_status: "completed" }),
      stage(2, "llm", {
        phase_status: "completed",
        llm_candidate_count: 39,
      }),
      stage(3, "invest", {
        phase_status: "blocked",
        event_exit_planned: 4,
        orders_planned: 8,
      }),
      stage(6, "stage2-handoff", {
        phase_status: "completed",
        stage2_actionable_contract_version: 2,
        stage2_actionable_contract_authoritative: true,
        stage2_actionable_exit_market_ids: [
          "exit-1",
          "exit-2",
          "exit-3",
          "exit-4",
        ],
        stage2_actionable_buy_market_ids: [
          "buy-1",
          "buy-2",
          "buy-3",
          "buy-4",
          "buy-5",
          "buy-6",
          "buy-7",
          "buy-8",
        ],
        stage2_actionable_exit_count: 4,
        stage2_actionable_buy_count: 8,
      }),
    ]),
  );
  const stageTwo = view.stages.find((candidate) => candidate.key === "llm");

  assert.ok(stageTwo);
  assert.deepEqual(stageTwo.outputs.stage2_actionable_exit_market_ids, [
    "exit-1",
    "exit-2",
    "exit-3",
    "exit-4",
  ]);
  assert.equal(stageTwo.outputs.stage2_actionable_buy_market_ids.length, 8);
  assert.equal(stageTwo.outputs.stage2_actionable_contract_authoritative, true);
  assert.equal(stageTwo.outputs.stage2_actionable_contract_display_recovered, true);
  assert.equal(
    stageTwo.outputs.stage2_actionable_contract_display_source,
    "stage2-handoff",
  );
});

test("Stage 2 display falls back to durable Stage 3 plan counts without inventing market IDs", async () => {
  const { buildBullpenAutoRunWorkflowView } = await loadProgressModule();
  const view = buildBullpenAutoRunWorkflowView(
    run([
      stage(1, "scan", { phase_status: "completed" }),
      stage(2, "llm", {
        phase_status: "completed",
        llm_candidate_count: 39,
      }),
      stage(3, "invest", {
        phase_status: "blocked",
        event_exit_planned: 4,
        orders_planned: 8,
      }),
    ]),
  );
  const stageTwo = view.stages.find((candidate) => candidate.key === "llm");

  assert.ok(stageTwo);
  assert.equal(stageTwo.outputs.stage2_actionable_exit_count, 4);
  assert.equal(stageTwo.outputs.stage2_actionable_buy_count, 8);
  assert.equal(stageTwo.outputs.stage2_actionable_contract_authoritative, undefined);
  assert.equal(stageTwo.outputs.stage2_actionable_exit_market_ids, undefined);
  assert.equal(stageTwo.outputs.stage2_actionable_buy_market_ids, undefined);
  assert.equal(stageTwo.outputs.stage2_actionable_contract_display_recovered, true);
  assert.equal(
    stageTwo.outputs.stage2_actionable_contract_display_source,
    "invest-plan-counts",
  );
});

test("Stage 2 card renders recovered counts but keeps the row dialog gated on exact IDs", () => {
  const source = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(source, /readStageTwoActionableDisplayContract/);
  assert.match(source, /stage2_actionable_exit_count/);
  assert.match(source, /stage2_actionable_buy_count/);
  assert.match(source, /hasActionableDisplay/);
  assert.match(source, /canOpenActionablesDialog/);
  assert.match(
    source,
    /Persisted Stage 2 action counts are available/,
  );
  assert.match(source, /Actionables: awaiting authoritative Stage 2 contract/);
});

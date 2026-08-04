import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";

async function loadModule() {
  const directory = mkdtempSync(path.join(tmpdir(), "bullpen-console-detail-"));
  const outputPath = path.join(directory, "bullpenRunConsoleDetail.mjs");
  const source = readFileSync(
    new URL("../lib/bullpenRunConsoleDetail.ts", import.meta.url),
    "utf8",
  );
  writeFileSync(
    outputPath,
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
  );
  return import(`${pathToFileURL(outputPath).href}?t=${Date.now()}`);
}

function decision(index, status = "planned") {
  return {
    id: `decision-${index}`,
    order_plan: { status },
    key_evidence: [],
    red_flags: [],
    exit_signals: [],
    llm_outputs: [],
    stage_results: [],
    guardrail_checks: [],
  };
}

function stage(status, outputs) {
  return {
    stage_number: 3,
    stage_name: "Stage 3",
    status,
    inputs: {},
    outputs: { workflow_stage_key: "invest", ...outputs },
    guardrails_checked: [],
  };
}

function run(stageResult) {
  return {
    id: "run-39",
    decisions_count: 39,
    stage_results: [stageResult],
    guardrail_checks: [],
    decision_ids: [],
    order_intent_ids: [],
    audit_metadata: {},
  };
}

test("a 32-row bounded poll preserves all 39 already loaded decisions", async () => {
  const { mergeBullpenConsoleDecisionProjection } = await loadModule();
  const existing = Array.from({ length: 39 }, (_, index) => decision(index));
  const projected = Array.from({ length: 32 }, (_, index) =>
    decision(index, "submitted"),
  );

  const merged = mergeBullpenConsoleDecisionProjection({
    existing,
    projected,
    truncated: true,
    visibleDecisionIds: existing.map((row) => row.id),
  });

  assert.equal(merged.length, 39);
  assert.equal(merged[0].order_plan.status, "submitted");
  assert.equal(merged[38].order_plan.status, "planned");
});

test("a bounded poll removes a superseded decision using authoritative visible IDs", async () => {
  const { mergeBullpenConsoleDecisionProjection } = await loadModule();
  const existing = Array.from({ length: 40 }, (_, index) => decision(index));
  const replacement = {
    id: "decision-replacement",
    order_plan: { status: "planned" },
  };
  const visibleDecisionIds = [
    replacement.id,
    ...existing.slice(1).map((row) => row.id),
  ];
  const projected = [replacement, ...existing.slice(1, 32)];

  const merged = mergeBullpenConsoleDecisionProjection({
    existing,
    projected,
    truncated: true,
    visibleDecisionIds,
    visibleDecisionIdsTruncated: false,
  });

  assert.equal(merged.length, 40);
  assert.equal(merged[0].id, "decision-replacement");
  assert.equal(merged[1].id, "decision-1");
  assert.equal(merged.some((row) => row.id === "decision-0"), false);
  assert.equal(
    merged.some((row) => row.id === "decision-replacement"),
    true,
  );
});

test("a non-truncated exact projection removes frozen superseded decisions", async () => {
  const { mergeBullpenConsoleDecisionProjection } = await loadModule();
  const oldDecision = decision("old");
  const replacement = decision("replacement", "submitted");

  const merged = mergeBullpenConsoleDecisionProjection({
    existing: [oldDecision, replacement],
    // The stage payload can still carry the old row, but exact visible IDs
    // are authoritative even when the persisted projection is not truncated.
    projected: [oldDecision, replacement],
    truncated: false,
    visibleDecisionIds: [replacement.id],
    visibleDecisionIdsTruncated: false,
  });

  assert.deepEqual(
    merged.map((row) => row.id),
    [replacement.id],
  );
});

test("live decision fields update without erasing loaded frozen evidence", async () => {
  const { mergeBullpenConsoleDecisionProjection } = await loadModule();
  const existing = {
    ...decision("evidence"),
    key_evidence: ["full evidence"],
    red_flags: ["full warning"],
    exit_signals: [{ label: "full exit signal" }],
    llm_outputs: [{ model: "full model" }],
    stage_results: [{ stage_number: 2 }],
    guardrail_checks: [{ id: "full guardrail" }],
  };
  const projected = {
    ...existing,
    order_plan: { status: "filled" },
    key_evidence: [],
    red_flags: [],
    exit_signals: [],
    llm_outputs: [],
    stage_results: [],
    guardrail_checks: [],
  };

  const [merged] = mergeBullpenConsoleDecisionProjection({
    existing: [existing],
    projected: [projected],
    truncated: false,
    visibleDecisionIds: [existing.id],
  });

  assert.equal(merged.order_plan.status, "filled");
  assert.deepEqual(merged.key_evidence, ["full evidence"]);
  assert.deepEqual(merged.red_flags, ["full warning"]);
  assert.deepEqual(merged.exit_signals, [{ label: "full exit signal" }]);
  assert.deepEqual(merged.llm_outputs, [{ model: "full model" }]);
  assert.deepEqual(merged.stage_results, [{ stage_number: 2 }]);
  assert.deepEqual(merged.guardrail_checks, [{ id: "full guardrail" }]);
});

test("legacy unavailable projections cannot erase full run detail", async () => {
  const { mergeBullpenConsoleRunProjection } = await loadModule();
  const existing = run(stage("pass", { decision_rows: [{ id: "full" }] }));
  const projected = run(stage("pending", {}));

  assert.equal(
    mergeBullpenConsoleRunProjection({
      existing,
      projected,
      projectionAvailable: false,
    }),
    existing,
  );
});

test("available projections update status without deleting frozen detail", async () => {
  const { mergeBullpenConsoleRunProjection } = await loadModule();
  const existing = run(
    stage("pending", {
      decision_rows: [{ id: "full" }],
      progress_commentary: ["old"],
    }),
  );
  const projected = run(
    stage("pass", {
      progress_commentary: ["new"],
      orders_submitted: 2,
    }),
  );

  const merged = mergeBullpenConsoleRunProjection({
    existing,
    projected,
    projectionAvailable: true,
  });

  assert.equal(merged.stage_results[0].status, "pass");
  assert.deepEqual(merged.stage_results[0].outputs.decision_rows, [
    { id: "full" },
  ]);
  assert.deepEqual(merged.stage_results[0].outputs.progress_commentary, [
    "new",
  ]);
  assert.equal(merged.stage_results[0].outputs.orders_submitted, 2);
});

test("completed stage metrics survive later compact workflow projections", async () => {
  const { mergeBullpenConsoleRunProjection } = await loadModule();
  const completedAt = "2026-08-02T14:08:10Z";
  const existing = run({
    ...stage("pass", {
      active_position_rows: 2,
      accepted_candidates_count: 16,
      llm_candidate_count: 17,
    }),
  });
  const projected = run({
    ...stage("pass", {}),
    completed_at: completedAt,
  });

  const merged = mergeBullpenConsoleRunProjection({
    existing,
    projected,
    projectionAvailable: true,
  });

  assert.equal(merged.stage_results[0].outputs.active_position_rows, 2);
  assert.equal(merged.stage_results[0].outputs.accepted_candidates_count, 16);
  assert.equal(merged.stage_results[0].outputs.llm_candidate_count, 17);
});

test("duplicate summary copies retain completed metrics from the richer run", async () => {
  const { reconcileBullpenConsoleRunCopies } = await loadModule();
  const completedAt = "2026-08-03T10:25:10Z";
  const evidenceRun = run({
    ...stage("pass", {
      active_position_rows_before_llm: 2,
      stage1_accepted_candidate_count: 20,
      llm_candidate_count: 21,
      llm_completed_provider_target_count: 2,
      llm_provider_target_count: 2,
    }),
    completed_at: completedAt,
  });
  const compactLatestRun = run({
    ...stage("pass", {}),
    completed_at: completedAt,
  });

  const reconciled = reconcileBullpenConsoleRunCopies(
    evidenceRun,
    compactLatestRun,
  );

  assert.equal(
    reconciled.stage_results[0].outputs.active_position_rows_before_llm,
    2,
  );
  assert.equal(
    reconciled.stage_results[0].outputs.stage1_accepted_candidate_count,
    20,
  );
  assert.equal(reconciled.stage_results[0].outputs.llm_candidate_count, 21);
  assert.equal(
    reconciled.stage_results[0].outputs.llm_completed_provider_target_count,
    2,
  );
  assert.equal(
    reconciled.stage_results[0].outputs.llm_provider_target_count,
    2,
  );
});

test("an authoritative recovery projection clears stale blockers and IDs", async () => {
  const { mergeBullpenConsoleRunProjection } = await loadModule();
  const existing = {
    ...run({
      ...stage("fail", {
        decision_rows: [{ id: "full" }],
        event_exit_rows: [{ id: "full-exit" }],
        execution_steps: [{ step: "full-step-evidence" }],
        llm_reviewed_candidates: [{ id: "full-candidate" }],
        current_blockage: "wallet route locked",
        execution_gate_reason: "doctor failed",
        execution_mode_reason: "blocked",
        execution_step_label: "Waiting for retry",
        execution_step_detail: "A prior worker is blocked.",
        error_message: "retry required",
        next_retry_at: "2026-07-27T00:00:00Z",
        orders_processed: 4,
        event_exit_processed: 2,
        redeem_processed: 1,
        persisted_execution_counters: { submitted: 0, rejected: 4 },
        post_exit_snapshot_source: "stale-cache",
        post_exit_snapshot_fetched_at: "2026-07-27T00:00:00Z",
      }),
      guardrails_checked: [{ key: "doctor", status: "fail" }],
    }),
    guardrail_checks: [{ key: "doctor", status: "fail" }],
    decision_ids: ["decision-old"],
    order_intent_ids: ["intent-old"],
  };
  const projected = {
    ...run(
      stage("pass", {
        orders_submitted: 1,
        // Bounded evidence from the poll must not replace the frozen detail.
        decision_rows: [{ id: "bounded" }],
        event_exit_rows: [{ id: "bounded-exit" }],
        execution_steps: [{ step: "bounded-step" }],
        llm_reviewed_candidates: [{ id: "bounded-candidate" }],
      }),
    ),
    guardrail_checks: [],
    decision_ids: [],
    order_intent_ids: [],
  };

  const merged = mergeBullpenConsoleRunProjection({
    existing,
    projected,
    projectionAvailable: true,
  });

  assert.equal(merged.stage_results[0].status, "pass");
  assert.deepEqual(merged.stage_results[0].guardrails_checked, []);
  assert.equal("current_blockage" in merged.stage_results[0].outputs, false);
  assert.equal("execution_gate_reason" in merged.stage_results[0].outputs, false);
  assert.equal("error_message" in merged.stage_results[0].outputs, false);
  assert.equal("next_retry_at" in merged.stage_results[0].outputs, false);
  assert.equal("execution_mode_reason" in merged.stage_results[0].outputs, false);
  assert.equal("execution_step_label" in merged.stage_results[0].outputs, false);
  assert.equal("execution_step_detail" in merged.stage_results[0].outputs, false);
  assert.equal("orders_processed" in merged.stage_results[0].outputs, false);
  assert.equal("event_exit_processed" in merged.stage_results[0].outputs, false);
  assert.equal("redeem_processed" in merged.stage_results[0].outputs, false);
  assert.equal(
    "persisted_execution_counters" in merged.stage_results[0].outputs,
    false,
  );
  assert.equal(
    "post_exit_snapshot_source" in merged.stage_results[0].outputs,
    false,
  );
  assert.equal(
    "post_exit_snapshot_fetched_at" in merged.stage_results[0].outputs,
    false,
  );
  assert.deepEqual(merged.guardrail_checks, []);
  assert.deepEqual(merged.decision_ids, []);
  assert.deepEqual(merged.order_intent_ids, []);
  assert.deepEqual(merged.stage_results[0].outputs.decision_rows, [
    { id: "full" },
  ]);
  assert.deepEqual(merged.stage_results[0].outputs.event_exit_rows, [
    { id: "full-exit" },
  ]);
  assert.deepEqual(merged.stage_results[0].outputs.execution_steps, [
    { step: "full-step-evidence" },
  ]);
  assert.deepEqual(
    merged.stage_results[0].outputs.llm_reviewed_candidates,
    [{ id: "full-candidate" }],
  );
});

test("compact polls cannot erase the terminal authoritative Stage 2 contract", async () => {
  const { mergeBullpenConsoleRunProjection } = await loadModule();
  const existingStage = {
    stage_number: 2,
    stage_name: "Stage 2",
    status: "pass",
    inputs: {},
    outputs: {
      workflow_stage_key: "llm",
      phase_status: "completed",
      stage2_actionable_contract_authoritative: true,
      stage2_actionable_contract_version: 2,
      stage2_actionable_exit_market_ids: ["exit-1", "exit-2", "exit-3", "exit-4"],
      stage2_actionable_buy_market_ids: ["buy-1", "buy-2", "buy-3", "buy-4", "buy-5"],
      stage2_actionable_exit_count: 4,
      stage2_actionable_buy_count: 5,
    },
    guardrails_checked: [],
  };
  const projectedStage = {
    ...existingStage,
    outputs: {
      workflow_stage_key: "llm",
      phase_status: "completed",
      orders_processed: 9,
    },
  };
  const existing = {
    ...run(existingStage),
    stage_results: [existingStage],
  };
  const projected = {
    ...run(projectedStage),
    stage_results: [projectedStage],
  };

  const merged = mergeBullpenConsoleRunProjection({
    existing,
    projected,
    projectionAvailable: true,
  });
  const outputs = merged.stage_results[0].outputs;

  assert.deepEqual(outputs.stage2_actionable_exit_market_ids, [
    "exit-1",
    "exit-2",
    "exit-3",
    "exit-4",
  ]);
  assert.deepEqual(outputs.stage2_actionable_buy_market_ids, [
    "buy-1",
    "buy-2",
    "buy-3",
    "buy-4",
    "buy-5",
  ]);
  assert.equal(outputs.stage2_actionable_exit_count, 4);
  assert.equal(outputs.stage2_actionable_buy_count, 5);
  assert.equal(outputs.orders_processed, 9);
});

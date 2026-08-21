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

function createStage(stageNumber, reason, outputs = {}, inputs = {}) {
  return {
    stage_number: stageNumber,
    stage_name: `Stage ${stageNumber}`,
    status: "pass",
    reason,
    inputs,
    outputs,
    guardrails_checked: [],
    hard_block: false,
    started_at: "2026-06-25T05:00:00Z",
    completed_at:
      outputs.phase_status === "completed" ? "2026-06-25T05:01:00Z" : null,
  };
}

test("Bullpen auto-run workflow view maps running stages to green, yellow, and blue containers", async () => {
  const { buildBullpenAutoRunWorkflowView } = await loadProgressModule();

  const view = buildBullpenAutoRunWorkflowView({
    id: "run-1",
    triggered_by: "manual",
    status: "running",
    dry_run: true,
    started_at: "2026-06-25T05:00:00Z",
    summary: "Stage 2 is processing candidate events.",
    live_execution_requested: false,
    live_execution_attempted: false,
    decisions_count: 0,
    orders_planned: 0,
    orders_submitted: 0,
    error_message: null,
    guardrail_checks: [],
    decision_ids: [],
    stage_results: [
      createStage(1, "Bullpen Scan finished.", {
        workflow_stage_key: "scan",
        phase_status: "completed",
        completed_items: 18,
        total_items: 18,
        item_label: "events",
      }),
      createStage(2, "Stage 2 processed 4 of 9 new events.", {
        workflow_stage_key: "llm",
        phase_status: "running",
        completed_items: 4,
        total_items: 9,
        item_label: "events",
      }),
    ],
  });

  assert.equal(view.currentStageLabel, "Stage 2 · Run LLM");
  assert.equal(view.stages[0].tone, "green");
  assert.equal(view.stages[1].tone, "yellow");
  assert.equal(view.stages[2].tone, "blue");
  assert.equal(view.stages[1].progressLabel, "4/9 events");
  assert.equal(view.stages[0].timerStartedAt, "2026-06-25T05:00:00Z");
  assert.equal(view.stages[0].timerCompletedAt, "2026-06-25T05:01:00Z");
  assert.equal(view.stages[1].timerCompletedAt, null);
});

test("Bullpen auto-run workflow view freezes completed stage timers at the next stage start", async () => {
  const { buildBullpenAutoRunWorkflowView } = await loadProgressModule();

  const view = buildBullpenAutoRunWorkflowView({
    id: "run-stage-boundaries",
    triggered_by: "manual",
    status: "running",
    dry_run: false,
    started_at: "2026-07-22T01:31:02Z",
    completed_at: null,
    summary: "Stage 3 is executing durable order intents.",
    live_execution_requested: true,
    live_execution_attempted: true,
    decisions_count: 23,
    orders_planned: 3,
    orders_submitted: 0,
    error_message: null,
    guardrail_checks: [],
    decision_ids: [],
    stage_results: [
      {
        ...createStage(1, "Bullpen Scan finished.", {
          workflow_stage_key: "scan",
          phase_status: "completed",
        }),
        started_at: "2026-07-22T01:31:02Z",
        completed_at: null,
      },
      {
        ...createStage(2, "Stage 2 reviewed candidates.", {
          workflow_stage_key: "llm",
          phase_status: "completed",
        }),
        started_at: "2026-07-22T01:32:06Z",
        completed_at: null,
      },
      {
        ...createStage(3, "Stage 3 is executing durable order intents.", {
          workflow_stage_key: "invest",
          phase_status: "running",
        }),
        started_at: "2026-07-22T01:39:14Z",
        completed_at: null,
      },
    ],
  });

  assert.equal(view.stages[0].timerStartedAt, "2026-07-22T01:31:02Z");
  assert.equal(view.stages[0].timerCompletedAt, "2026-07-22T01:32:06Z");
  assert.equal(view.stages[1].timerStartedAt, "2026-07-22T01:32:06Z");
  assert.equal(view.stages[1].timerCompletedAt, "2026-07-22T01:39:14Z");
  assert.equal(view.stages[2].timerStartedAt, "2026-07-22T01:39:14Z");
  assert.equal(view.stages[2].timerCompletedAt, null);
});

test("Bullpen auto-run workflow view clamps stale overlapping stage timestamps to sequential boundaries", async () => {
  const { buildBullpenAutoRunWorkflowView } = await loadProgressModule();

  const view = buildBullpenAutoRunWorkflowView({
    id: "run-overlapping-stage-timers",
    triggered_by: "manual",
    status: "running",
    dry_run: false,
    started_at: "2026-07-22T10:32:32Z",
    completed_at: null,
    summary: "Stage 3 is executing durable order intents.",
    live_execution_requested: true,
    live_execution_attempted: true,
    decisions_count: 33,
    orders_planned: 7,
    orders_submitted: 0,
    error_message: null,
    guardrail_checks: [],
    decision_ids: [],
    stage_results: [
      {
        ...createStage(1, "Bullpen Scan finished.", {
          workflow_stage_key: "scan",
          phase_status: "completed",
        }),
        started_at: "2026-07-22T10:32:32Z",
        completed_at: "2026-07-22T10:40:00Z",
      },
      {
        ...createStage(2, "Stage 2 reviewed candidates.", {
          workflow_stage_key: "llm",
          phase_status: "completed",
        }),
        started_at: "2026-07-22T10:32:32Z",
        completed_at: "2026-07-22T10:50:00Z",
      },
      {
        ...createStage(3, "Stage 3 is executing durable order intents.", {
          workflow_stage_key: "invest",
          phase_status: "running",
        }),
        started_at: "2026-07-22T10:42:30Z",
        completed_at: null,
      },
    ],
  });

  assert.equal(view.stages[0].timerStartedAt, "2026-07-22T10:32:32Z");
  assert.equal(view.stages[0].timerCompletedAt, "2026-07-22T10:40:00Z");
  assert.equal(view.stages[1].timerStartedAt, "2026-07-22T10:40:00Z");
  assert.equal(view.stages[1].timerCompletedAt, "2026-07-22T10:42:30Z");
  assert.equal(view.stages[2].timerStartedAt, "2026-07-22T10:42:30Z");
  assert.equal(view.stages[2].timerCompletedAt, null);
});

test("Bullpen auto-run workflow view exposes Stage 2 and Stage 3 inputs", async () => {
  const { buildBullpenAutoRunWorkflowView } = await loadProgressModule();

  const view = buildBullpenAutoRunWorkflowView({
    id: "run-inputs",
    triggered_by: "manual",
    status: "running",
    dry_run: true,
    started_at: "2026-06-25T05:00:00Z",
    summary: "Stage 3 is reviewing investment inputs.",
    live_execution_requested: false,
    live_execution_attempted: false,
    decisions_count: 0,
    orders_planned: 0,
    orders_submitted: 0,
    error_message: null,
    guardrail_checks: [],
    decision_ids: [],
    stage_results: [
      createStage(1, "Bullpen Scan finished.", {
        workflow_stage_key: "scan",
        phase_status: "completed",
      }),
      createStage(
        2,
        "Stage 2 reviewed candidates.",
        { workflow_stage_key: "llm", phase_status: "completed" },
        { accepted_candidates: [{ question: "Will rates fall?" }] },
      ),
      createStage(
        3,
        "Stage 3 is reviewing investments.",
        { workflow_stage_key: "invest", phase_status: "running" },
        { llm_review_rows: [{ question: "Will rates fall?", llm_yes_odds: 64 }] },
      ),
    ],
  });

  assert.deepEqual(view.stages[1].inputs, {
    accepted_candidates: [{ question: "Will rates fall?" }],
  });
  assert.deepEqual(view.stages[2].inputs, {
    llm_review_rows: [{ question: "Will rates fall?", llm_yes_odds: 64 }],
  });
});

test("Bullpen auto-run workflow view derives Stage 2 and Stage 3 inputs from upstream outputs", async () => {
  const { buildBullpenAutoRunWorkflowView } = await loadProgressModule();

  const acceptedCandidates = [{ question: "Will rates fall?", slug: "rates-fall" }];
  const activePositionsFound = [
    { market_id: "market-1", market_title: "Will rates fall?", side: "YES" },
  ];
  const reviewedRows = [{ question: "Will rates fall?", llm_yes_odds: 64 }];
  const view = buildBullpenAutoRunWorkflowView({
    id: "run-derived-inputs",
    triggered_by: "manual",
    status: "completed",
    dry_run: true,
    started_at: "2026-06-25T05:00:00Z",
    completed_at: "2026-06-25T05:02:00Z",
    summary: "All stages finished.",
    live_execution_requested: false,
    live_execution_attempted: false,
    decisions_count: 1,
    orders_planned: 1,
    orders_submitted: 0,
    error_message: null,
    guardrail_checks: [],
    decision_ids: [],
    stage_results: [
      createStage(1, "Bullpen Scan finished.", {
        workflow_stage_key: "scan",
        phase_status: "completed",
        accepted_candidates: acceptedCandidates,
        active_positions_found: activePositionsFound,
      }),
      createStage(2, "Stage 2 reviewed candidates.", {
        workflow_stage_key: "llm",
        phase_status: "completed",
        llm_reviewed_candidates: reviewedRows,
      }),
      createStage(3, "Stage 3 reviewed investments.", {
        workflow_stage_key: "invest",
        phase_status: "completed",
      }),
    ],
  });

  assert.deepEqual(view.stages[1].inputs, {
    accepted_candidates: acceptedCandidates,
    active_positions_found: activePositionsFound,
  });
  assert.deepEqual(view.stages[2].inputs, {
    llm_review_rows: reviewedRows,
  });
});

test("Bullpen auto-run workflow view merges derived Stage 1 positions into explicit Stage 2 inputs", async () => {
  const { buildBullpenAutoRunWorkflowView } = await loadProgressModule();

  const acceptedCandidates = [{ question: "Will rates fall?", slug: "rates-fall" }];
  const activePositionsFound = [
    { market_id: "market-1", market_title: "Will rates fall?", side: "YES" },
  ];
  const view = buildBullpenAutoRunWorkflowView({
    id: "run-stage-2-input-merge",
    triggered_by: "manual",
    status: "completed",
    dry_run: true,
    started_at: "2026-06-25T05:00:00Z",
    completed_at: "2026-06-25T05:02:00Z",
    summary: "All stages finished.",
    live_execution_requested: false,
    live_execution_attempted: false,
    decisions_count: 1,
    orders_planned: 1,
    orders_submitted: 0,
    error_message: null,
    guardrail_checks: [],
    decision_ids: [],
    stage_results: [
      createStage(1, "Bullpen Scan finished.", {
        workflow_stage_key: "scan",
        phase_status: "completed",
        accepted_candidates: acceptedCandidates,
        active_positions_found: activePositionsFound,
      }),
      createStage(
        2,
        "Stage 2 reviewed candidates.",
        { workflow_stage_key: "llm", phase_status: "completed" },
        { accepted_candidates: acceptedCandidates },
      ),
    ],
  });

  assert.deepEqual(view.stages[1].inputs, {
    accepted_candidates: acceptedCandidates,
    active_positions_found: activePositionsFound,
  });
});

test("Bullpen auto-run workflow view ignores completed_at on an actively running stage", async () => {
  const { buildBullpenAutoRunWorkflowView } = await loadProgressModule();

  const runningStage = createStage(2, "Stage 2 is reviewing event 1 of 2.", {
    workflow_stage_key: "llm",
    phase_status: "running",
    completed_items: 0,
    total_items: 2,
    item_label: "events",
  });
  runningStage.completed_at = "2026-06-25T05:00:30Z";

  const view = buildBullpenAutoRunWorkflowView({
    id: "run-active-stage",
    triggered_by: "manual",
    status: "running",
    dry_run: true,
    started_at: "2026-06-25T05:00:00Z",
    summary: "Stage 2 is reviewing Stage 1 events.",
    live_execution_requested: false,
    live_execution_attempted: false,
    decisions_count: 0,
    orders_planned: 0,
    orders_submitted: 0,
    error_message: null,
    guardrail_checks: [],
    decision_ids: [],
    stage_results: [
      createStage(1, "Bullpen Scan finished.", {
        workflow_stage_key: "scan",
        phase_status: "completed",
        completed_items: 20,
        total_items: 20,
        item_label: "events",
      }),
      runningStage,
    ],
  });

  assert.equal(view.stages[1].timerCompletedAt, null);
  assert.equal(view.stages[1].progressLabel, "0/2 events");
});

test("Bullpen auto-run workflow view hides queued Stage 3 progress when Stage 2 is still the active worker stage", async () => {
  const { buildBullpenAutoRunWorkflowView } = await loadProgressModule();

  const view = buildBullpenAutoRunWorkflowView({
    id: "run-overlap",
    triggered_by: "manual",
    status: "running",
    dry_run: true,
    started_at: "2026-06-25T05:00:00Z",
    summary: "Stage 2 is still reviewing events.",
    live_execution_requested: false,
    live_execution_attempted: false,
    decisions_count: 0,
    orders_planned: 0,
    orders_submitted: 0,
    error_message: null,
    guardrail_checks: [],
    decision_ids: [],
    stage_results: [
      createStage(1, "Bullpen Scan finished.", {
        workflow_stage_key: "scan",
        phase_status: "completed",
        completed_items: 20,
        total_items: 20,
        item_label: "events",
      }),
      createStage(2, "Stage 2 is reviewing event 3 of 20.", {
        workflow_stage_key: "llm",
        phase_status: "running",
        completed_items: 2,
        total_items: 20,
        item_label: "events",
      }),
      createStage(3, "Stage 3 started unexpectedly early.", {
        workflow_stage_key: "invest",
        phase_status: "running",
        completed_items: 0,
        total_items: 29,
        item_label: "rows",
      }),
    ],
  });

  assert.equal(view.currentStageLabel, "Stage 2 · Run LLM");
  assert.equal(view.stages[2].state, "queued");
  assert.equal(view.stages[2].progressLabel, "Queued");
  assert.equal(view.stages[2].timerStartedAt, null);
  assert.equal(
    view.stages[2].detail,
    "Waiting for Stage 2 to finish before exit and investment planning starts.",
  );
  assert.deepEqual(view.stages[2].outputs, {});
});

test("Bullpen auto-run workflow view explains Stage 3 counts as combined review rows", async () => {
  const { buildBullpenAutoRunWorkflowView } = await loadProgressModule();

  const view = buildBullpenAutoRunWorkflowView({
    id: "run-stage-3-rows",
    triggered_by: "manual",
    status: "running",
    dry_run: true,
    started_at: "2026-06-25T05:00:00Z",
    summary: "Stage 3 is reviewing active positions and candidate rows.",
    live_execution_requested: false,
    live_execution_attempted: false,
    decisions_count: 0,
    orders_planned: 0,
    orders_submitted: 0,
    error_message: null,
    guardrail_checks: [],
    decision_ids: [],
    stage_results: [
      createStage(1, "Bullpen Scan finished.", {
        workflow_stage_key: "scan",
        phase_status: "completed",
        completed_items: 9,
        total_items: 9,
        item_label: "events",
      }),
      createStage(2, "Stage 2 reviewed all 9 events.", {
        workflow_stage_key: "llm",
        phase_status: "completed",
        completed_items: 9,
        total_items: 9,
        item_label: "events",
      }),
      createStage(3, "Stage 3 reviewed row 18 of 18.", {
        workflow_stage_key: "invest",
        phase_status: "running",
        completed_items: 18,
        total_items: 18,
        item_label: "rows",
        active_position_rows: 9,
        candidate_decision_rows: 9,
      }),
    ],
  });

  assert.equal(view.currentStageLabel, "Stage 3 · Exit and Invest");
  assert.equal(view.stages[2].progressLabel, "18/18 review rows");
  assert.equal(view.stages[2].outputs.active_position_rows, 9);
  assert.equal(view.stages[2].outputs.candidate_decision_rows, 9);
});

test("Bullpen auto-run workflow view treats a partial Stage 2 as finished so Stage 3 can proceed", async () => {
  const { buildBullpenAutoRunWorkflowView } = await loadProgressModule();

  const partialStageTwo = createStage(2, "Only one of four selected models returned usable odds.", {
    workflow_stage_key: "llm",
    phase_status: "partial",
    completed_items: 4,
    total_items: 4,
    item_label: "events",
  });
  partialStageTwo.completed_at = "2026-06-25T05:01:00Z";

  const view = buildBullpenAutoRunWorkflowView({
    id: "run-stage-2-partial",
    triggered_by: "manual",
    status: "running",
    dry_run: true,
    started_at: "2026-06-25T05:00:00Z",
    summary: "Stage 3 is evaluating the persisted usable Stage 2 outputs.",
    live_execution_requested: false,
    live_execution_attempted: false,
    decisions_count: 0,
    orders_planned: 0,
    orders_submitted: 0,
    error_message: null,
    guardrail_checks: [],
    decision_ids: [],
    stage_results: [
      createStage(1, "Bullpen Scan finished.", {
        workflow_stage_key: "scan",
        phase_status: "completed",
      }),
      partialStageTwo,
      createStage(3, "Stage 3 is reviewing the partial Stage 2 handoff.", {
        workflow_stage_key: "invest",
        phase_status: "running",
        completed_items: 1,
        total_items: 3,
        item_label: "rows",
      }),
    ],
  });

  assert.equal(view.currentStageLabel, "Stage 3 · Exit and Invest");
  assert.equal(view.stages[1].state, "finished");
  assert.equal(view.stages[1].timerCompletedAt, "2026-06-25T05:01:00Z");
  assert.equal(view.stages[2].state, "current");
});

test("Bullpen auto-run workflow view appends the exact Stage 3 gate reason to the detail copy", async () => {
  const { buildBullpenAutoRunWorkflowView } = await loadProgressModule();

  const view = buildBullpenAutoRunWorkflowView({
    id: "run-stage-3-gated",
    triggered_by: "manual",
    status: "running",
    dry_run: false,
    started_at: "2026-06-25T05:00:00Z",
    summary: "Stage 3 is waiting on live execution controls.",
    live_execution_requested: true,
    live_execution_attempted: true,
    decisions_count: 7,
    orders_planned: 3,
    orders_submitted: 0,
    error_message: null,
    guardrail_checks: [],
    decision_ids: [],
    stage_results: [
      createStage(1, "Bullpen Scan finished.", {
        workflow_stage_key: "scan",
        phase_status: "completed",
      }),
      createStage(2, "Stage 2 reviewed all events.", {
        workflow_stage_key: "llm",
        phase_status: "completed",
      }),
      createStage(3, "Stage 3 reviewed all rows, but live execution is currently gated.", {
        workflow_stage_key: "invest",
        phase_status: "running",
        completed_items: 7,
        total_items: 7,
        item_label: "rows",
        execution_gate_reason:
          "Dashboard live unlock is required; Bullpen doctor failed.",
      }),
    ],
  });

  assert.match(
    view.stages[2].detail,
    /Execution gate: Dashboard live unlock is required; Bullpen doctor failed\./,
  );
});

test("Bullpen auto-run workflow view explains when Stage 2 reuses saved LLM outputs", async () => {
  const { buildBullpenAutoRunWorkflowView } = await loadProgressModule();

  const view = buildBullpenAutoRunWorkflowView({
    id: "run-stage-2-reuse",
    triggered_by: "manual",
    status: "completed",
    dry_run: true,
    started_at: "2026-06-25T05:00:00Z",
    completed_at: "2026-06-25T05:00:01Z",
    summary: "Stage 2 reused existing LLM outputs.",
    live_execution_requested: false,
    live_execution_attempted: false,
    decisions_count: 0,
    orders_planned: 0,
    orders_submitted: 0,
    error_message: null,
    guardrail_checks: [],
    decision_ids: [],
    stage_results: [
      createStage(1, "Bullpen Scan finished.", {
        workflow_stage_key: "scan",
        phase_status: "completed",
        completed_items: 9,
        total_items: 9,
        item_label: "events",
      }),
      createStage(2, "LLM review completed for 9 events from 9 Stage 1 candidates.", {
        workflow_stage_key: "llm",
        phase_status: "completed",
        completed_items: 9,
        total_items: 9,
        item_label: "events",
        reused_existing_llm_outputs: true,
      }),
    ],
  });

  assert.match(view.stages[1].detail, /Reused the current Bullpen x AI table's saved LLM outputs/);
});

test("Bullpen auto-run workflow view treats legacy completed runs as fully finished", async () => {
  const { buildBullpenAutoRunWorkflowView } = await loadProgressModule();

  const view = buildBullpenAutoRunWorkflowView({
    id: "run-legacy",
    triggered_by: "scheduler",
    status: "completed",
    dry_run: true,
    started_at: "2026-06-25T05:00:00Z",
    completed_at: "2026-06-25T05:03:00Z",
    summary: "Console schedule simulated 8 decisions with 3 planned orders.",
    live_execution_requested: false,
    live_execution_attempted: false,
    decisions_count: 8,
    orders_planned: 3,
    orders_submitted: 0,
    error_message: null,
    guardrail_checks: [],
    decision_ids: [],
    stage_results: [],
  });

  assert.equal(view.currentStageLabel, "All 3 stages finished");
  assert.equal(
    view.stages.every((stage) => stage.tone === "green"),
    true,
  );
  assert.match(view.stages[2].detail, /Console schedule simulated/);
});

test("Bullpen auto-run workflow settled helper hides active controls once every stage is finished", async () => {
  const {
    buildBullpenAutoRunWorkflowView,
    isBullpenAutoRunWorkflowSettled,
  } = await loadProgressModule();

  const settledView = buildBullpenAutoRunWorkflowView({
    id: "run-running-but-finished",
    triggered_by: "manual",
    status: "running",
    dry_run: false,
    started_at: "2026-06-25T05:00:00Z",
    summary: "All stages finished.",
    live_execution_requested: true,
    live_execution_attempted: true,
    decisions_count: 2,
    orders_planned: 1,
    orders_submitted: 1,
    error_message: null,
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
      createStage(3, "Stage 3 submitted the final orders.", {
        workflow_stage_key: "invest",
        phase_status: "completed",
      }),
    ],
  });
  const queuedView = buildBullpenAutoRunWorkflowView({
    id: "run-still-queued",
    triggered_by: "manual",
    status: "running",
    dry_run: false,
    started_at: "2026-06-25T05:00:00Z",
    summary: "Stage 2 is still running.",
    live_execution_requested: true,
    live_execution_attempted: false,
    decisions_count: 0,
    orders_planned: 0,
    orders_submitted: 0,
    error_message: null,
    guardrail_checks: [],
    decision_ids: [],
    stage_results: [
      createStage(1, "Bullpen Scan finished.", {
        workflow_stage_key: "scan",
        phase_status: "completed",
      }),
      createStage(2, "Stage 2 is processing candidates.", {
        workflow_stage_key: "llm",
        phase_status: "running",
      }),
      createStage(3, "Stage 3 is waiting for Stage 2.", {
        workflow_stage_key: "invest",
        phase_status: "queued",
      }),
    ],
  });

  assert.equal(isBullpenAutoRunWorkflowSettled(settledView), true);
  assert.equal(isBullpenAutoRunWorkflowSettled(queuedView), false);
});

test("Bullpen auto-run workflow treats a fully submitted running Stage 3 as settled", async () => {
  const {
    buildBullpenAutoRunWorkflowView,
    isBullpenAutoRunWorkflowSettled,
  } = await loadProgressModule();

  const view = buildBullpenAutoRunWorkflowView({
    id: "run-stage-3-submitted",
    triggered_by: "manual",
    status: "running",
    dry_run: false,
    started_at: "2026-06-25T05:00:00Z",
    summary: "Stage 3 submitted the final orders.",
    live_execution_requested: true,
    live_execution_attempted: true,
    decisions_count: 3,
    orders_planned: 2,
    orders_submitted: 2,
    error_message: null,
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
      createStage(3, "Stage 3 submitted the final orders.", {
        workflow_stage_key: "invest",
        phase_status: "running",
        completed_items: 3,
        total_items: 3,
        orders_planned: 2,
        orders_submitted: 2,
        decision_rows: [
          {
            id: "sell-1",
            market_id: "market-1",
            market_title: "Will market one resolve?",
            order_plan: {
              status: "submitted",
            },
          },
          {
            id: "buy-1",
            market_id: "market-2",
            market_title: "Will market two resolve?",
            order_plan: {
              status: "submitted",
            },
          },
        ],
      }),
    ],
  });

  assert.equal(isBullpenAutoRunWorkflowSettled(view), true);
  assert.equal(view.currentStageLabel, "All 3 stages finished");
  assert.equal(view.stages[2].state, "finished");
  assert.equal(view.stages[2].tone, "green");
});

test("Bullpen auto-run workflow view does not show a failed run as actively working", async () => {
  const { buildBullpenAutoRunWorkflowView } = await loadProgressModule();

  const view = buildBullpenAutoRunWorkflowView({
    id: "run-failed",
    triggered_by: "manual",
    status: "failed",
    dry_run: false,
    started_at: "2026-06-25T05:00:00Z",
    completed_at: "2026-06-25T05:00:04Z",
    summary: "Auto-Live run failed before Stage 1 completed.",
    live_execution_requested: true,
    live_execution_attempted: false,
    decisions_count: 0,
    orders_planned: 0,
    orders_submitted: 0,
    error_message: "validation error",
    guardrail_checks: [],
    decision_ids: [],
    stage_results: [],
  });

  assert.equal(view.currentStageLabel, "Last run failed");
  assert.equal(view.statusCopy, "Auto-Live run failed before Stage 1 completed.");
  assert.equal(view.stages.some((stage) => stage.isCurrent), false);
  assert.equal(view.stages[0].tone, "blue");
});

test("Bullpen auto-run workflow does not fabricate Stage 1 for an active exact run with missing compact stages", async () => {
  const { buildBullpenAutoRunWorkflowView } = await loadProgressModule();

  const view = buildBullpenAutoRunWorkflowView({
    id: "run-active-stage3",
    triggered_by: "scheduler",
    status: "running",
    dry_run: false,
    started_at: "2026-07-26T18:17:04Z",
    summary: "Stage 3 attempted 7 durable order intents; 7 await retry.",
    live_execution_requested: true,
    live_execution_attempted: true,
    decisions_count: 24,
    orders_planned: 7,
    orders_submitted: 0,
    error_message: null,
    guardrail_checks: [],
    decision_ids: [],
    stage_results: [],
  });

  assert.equal(view.currentStageLabel, "Current stage evidence unavailable");
  assert.equal(view.stages.some((stage) => stage.isCurrent), false);
  assert.equal(view.stages[0].state, "queued");
  assert.match(view.statusCopy, /Stage 3 attempted 7 durable order intents/);
});

test("Bullpen auto-run workflow view starts Stage 1 immediately for a pending run", async () => {
  const { buildBullpenAutoRunWorkflowView } = await loadProgressModule();

  const view = buildBullpenAutoRunWorkflowView(
    null,
    "run-pending",
    "2026-06-25T05:00:00Z",
  );

  assert.equal(view.currentStageLabel, "Stage 1 · Bullpen Scan");
  assert.equal(view.stages[0].isCurrent, true);
  assert.equal(view.stages[0].timerStartedAt, "2026-06-25T05:00:00Z");
  assert.equal(
    view.stages[0].detail,
    "Bullpen scan started. Waiting for the worker handoff to complete.",
  );
});

test("Bullpen auto-run workflow view exposes Stage 1 output candidates", async () => {
  const { buildBullpenAutoRunWorkflowView } = await loadProgressModule();

  const view = buildBullpenAutoRunWorkflowView({
    id: "run-candidates",
    triggered_by: "manual",
    status: "completed",
    dry_run: false,
    started_at: "2026-06-25T05:00:00Z",
    completed_at: "2026-06-25T05:02:00Z",
    summary: "Candidate scan completed.",
    live_execution_requested: true,
    live_execution_attempted: false,
    decisions_count: 0,
    orders_planned: 0,
    orders_submitted: 0,
    error_message: null,
    guardrail_checks: [],
    decision_ids: [],
    stage_results: [
      createStage(1, "Bullpen Scan finished.", {
        workflow_stage_key: "scan",
        phase_status: "completed",
        accepted_candidates: [
          {
            question: "Will the event resolve No?",
            market_url: "https://polymarket.com/event/no",
            slug: "event-no",
            close_time: "2026-06-25T12:30:00Z",
            theme: "Politics",
            current_yes_odds: "32.5",
            current_no_odds: 67.5,
            volume_usd: "1200.50",
            liquidity_usd: 450,
            force_include: "true",
          },
          { question: "" },
        ],
        rejected_candidates: [
          {
            question: "Will the filtered event happen?",
            slug: "filtered-event",
            reasons: ["Below minimum liquidity"],
          },
        ],
      }),
    ],
  });

  assert.equal(view.stages[0].scanCandidates.length, 1);
  assert.deepEqual(view.stages[0].scanCandidates[0], {
    questionId: null,
    marketId: null,
    question: "Will the event resolve No?",
    marketUrl: "https://polymarket.com/event/no",
    slug: "event-no",
    closeTime: "2026-06-25T12:30:00Z",
    theme: "Politics",
    currentYesOdds: 32.5,
    currentNoOdds: 67.5,
    volumeUsd: 1200.5,
    liquidityUsd: 450,
    forceInclude: true,
    scanStatus: "passed",
    filterReasons: [],
  });
  assert.equal(view.stages[0].scannedCandidates.length, 2);
  assert.equal(view.stages[0].scannedCandidates[1].scanStatus, "filtered");
  assert.deepEqual(view.stages[0].scannedCandidates[1].filterReasons, [
    "Below minimum liquidity",
  ]);
  assert.deepEqual(view.stages[1].scanCandidates, []);
});

test("Bullpen auto-run workflow view exposes Stage 1 active Bullpen positions", async () => {
  const { buildBullpenAutoRunWorkflowView } = await loadProgressModule();

  const view = buildBullpenAutoRunWorkflowView({
    id: "run-active-positions",
    triggered_by: "manual",
    status: "completed",
    dry_run: false,
    started_at: "2026-06-25T05:00:00Z",
    completed_at: "2026-06-25T05:02:00Z",
    summary: "Candidate scan completed.",
    live_execution_requested: true,
    live_execution_attempted: false,
    decisions_count: 0,
    orders_planned: 0,
    orders_submitted: 0,
    error_message: null,
    guardrail_checks: [],
    decision_ids: [],
    stage_results: [
      createStage(1, "Bullpen Scan finished.", {
        workflow_stage_key: "scan",
        phase_status: "completed",
        active_positions_found: [
          {
            position_key: "market-1::YES",
            market_id: "market-1",
            market_title: "Will rates fall?",
            market_url: "https://polymarket.com/event/rates-fall",
            slug: "rates-fall",
            theme: "Macro",
            side: "YES",
            shares: "12.5",
            exposure_usd: 37.5,
            average_price_cents: "42.5",
            current_yes_odds: 55,
            current_no_odds: "45",
            close_time: "2026-06-25T12:30:00Z",
            condition_id:
              "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
          },
        ],
      }),
    ],
  });

  assert.equal(view.stages[0].activePositionsFound.length, 1);
  assert.deepEqual(view.stages[0].activePositionsFound[0], {
    positionKey: "market-1::YES",
    marketId: "market-1",
    marketTitle: "Will rates fall?",
    marketUrl: "https://polymarket.com/event/rates-fall",
    slug: "rates-fall",
    theme: "Macro",
    side: "YES",
    shares: 12.5,
    exposureUsd: 37.5,
    averagePriceCents: 42.5,
    currentYesOdds: 55,
    currentNoOdds: 45,
    closeTime: "2026-06-25T12:30:00Z",
    conditionId:
      "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    isClaimable: false,
    classification: null,
  });
});

test("Bullpen auto-run workflow view filters non-active Stage 1 rows from active_positions_found", async () => {
  const { buildBullpenAutoRunWorkflowView } = await loadProgressModule();

  const view = buildBullpenAutoRunWorkflowView({
    id: "run-active-filtered",
    triggered_by: "manual",
    status: "completed",
    dry_run: false,
    started_at: "2026-07-19T05:00:00Z",
    completed_at: "2026-07-19T05:02:00Z",
    summary: "Candidate scan completed.",
    live_execution_requested: true,
    live_execution_attempted: false,
    decisions_count: 0,
    orders_planned: 0,
    orders_submitted: 0,
    error_message: null,
    guardrail_checks: [],
    decision_ids: [],
    stage_results: [
      createStage(1, "Bullpen Scan finished.", {
        workflow_stage_key: "scan",
        phase_status: "completed",
        active_positions_found: [
          {
            position_key: "market-active::NO",
            market_id: "market-active",
            market_title: "Will Trump meet with Netanyahu by July 24, 2026?",
            side: "NO",
            classification: "active",
          },
          {
            position_key: "market-zero::NO",
            market_id: "market-zero",
            market_title: "Expired residue",
            side: "NO",
            classification: "resolved_zero_payout",
            is_claimable: false,
          },
          {
            position_key: "market-pending::NO",
            market_id: "market-pending",
            market_title: "Settlement pending residue",
            side: "NO",
            classification: "settlement_pending",
            is_claimable: false,
          },
        ],
      }),
    ],
  });

  assert.deepEqual(
    view.stages[0].activePositionsFound.map((position) => position.marketId),
    ["market-active"],
  );
});

test("Bullpen auto-run workflow view keeps derived Stage 3 inputs even when Invest never started", async () => {
  const { buildBullpenAutoRunWorkflowView } = await loadProgressModule();

  const reviewedRows = [
    {
      market_id: "market-1",
      question: "Will rates fall?",
      source_kind: "candidate",
      fair_yes_probability_pct: 64,
    },
  ];
  const view = buildBullpenAutoRunWorkflowView({
    id: "run-stage-3-inputs-queued",
    triggered_by: "manual",
    status: "failed",
    dry_run: true,
    started_at: "2026-06-25T05:00:00Z",
    completed_at: "2026-06-25T05:02:00Z",
    summary: "Auto-Live run failed before Stage 3 started.",
    live_execution_requested: false,
    live_execution_attempted: false,
    decisions_count: 0,
    orders_planned: 0,
    orders_submitted: 0,
    error_message: "stage-3-never-started",
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
        llm_reviewed_candidates: reviewedRows,
      }),
    ],
  });

  assert.equal(view.stages[2].state, "queued");
  assert.deepEqual(view.stages[2].inputs, {
    llm_review_rows: reviewedRows,
  });
  assert.deepEqual(view.stages[2].outputs, {});
});

test("Bullpen auto-run workflow view keeps the failed stage highlighted when backend progress was persisted", async () => {
  const { buildBullpenAutoRunWorkflowView } = await loadProgressModule();

  const view = buildBullpenAutoRunWorkflowView({
    id: "run-failed-stage-2",
    triggered_by: "manual",
    status: "failed",
    dry_run: true,
    started_at: "2026-06-25T05:00:00Z",
    completed_at: "2026-06-25T05:00:06Z",
    summary: "Auto-Live run failed during Stage 2.",
    live_execution_requested: false,
    live_execution_attempted: false,
    decisions_count: 0,
    orders_planned: 0,
    orders_submitted: 0,
    error_message: "stage-2-error",
    guardrail_checks: [],
    decision_ids: [],
    stage_results: [
      createStage(1, "Bullpen Scan finished.", {
        workflow_stage_key: "scan",
        phase_status: "completed",
        completed_items: 12,
        total_items: 12,
        item_label: "events",
      }),
      createStage(2, "Stage 2 started.", {
        workflow_stage_key: "llm",
        phase_status: "running",
        completed_items: 0,
        total_items: 4,
        item_label: "events",
        llm_candidate_count: 4,
      }),
    ],
  });

  assert.equal(view.currentStageLabel, "Stage 2 · Run LLM");
  assert.equal(view.stages[1].isCurrent, true);
  assert.equal(view.stages[1].outputs.llm_candidate_count, 4);
});

test("Bullpen auto-run workflow view explains the saved Stage 2 execution mode", async () => {
  const { buildBullpenAutoRunWorkflowView } = await loadProgressModule();

  const view = buildBullpenAutoRunWorkflowView({
    id: "run-stage-2-settings",
    triggered_by: "manual",
    status: "running",
    dry_run: true,
    started_at: "2026-06-25T05:00:00Z",
    summary: "Stage 2 is running.",
    live_execution_requested: false,
    live_execution_attempted: false,
    decisions_count: 0,
    orders_planned: 0,
    orders_submitted: 0,
    error_message: null,
    guardrail_checks: [],
    decision_ids: [],
    stage_results: [
      createStage(1, "Bullpen Scan finished.", {
        workflow_stage_key: "scan",
        phase_status: "completed",
      }),
      createStage(2, "Stage 2 is processing candidates.", {
        workflow_stage_key: "llm",
        phase_status: "running",
        llm_execution_mode: "chunked_parallel",
        llm_events_per_prompt: 20,
      }),
    ],
  });

  assert.match(
    view.stages[1].detail,
    /Execution mode: Batched parallel with up to 20 events per prompt\./,
  );
});


test("Bullpen auto-run workflow view exposes detailed Stage 1 progress commentary", async () => {
  const { buildBullpenAutoRunWorkflowView } = await loadProgressModule();

  const view = buildBullpenAutoRunWorkflowView({
    id: "run-stage1-commentary",
    triggered_by: "manual",
    status: "running",
    dry_run: true,
    started_at: "2026-06-25T05:00:00Z",
    summary: "Stage 1 is fetching live Bullpen candidate markets.",
    live_execution_requested: false,
    live_execution_attempted: false,
    decisions_count: 0,
    orders_planned: 0,
    orders_submitted: 0,
    error_message: null,
    guardrail_checks: [],
    decision_ids: [],
    stage_results: [
      createStage(1, "Stage 1 is fetching live Bullpen candidate markets.", {
        workflow_stage_key: "scan",
        phase_status: "running",
        completed_items: 0,
        item_label: "events",
        progress_commentary: [
          "Requesting the live console profile candidate feed.",
          "Applying Stage 1 filters.",
        ],
      }),
    ],
  });

  assert.deepEqual(view.stages[0].progressCommentary, [
    "Requesting the live console profile candidate feed.",
    "Applying Stage 1 filters.",
  ]);
});

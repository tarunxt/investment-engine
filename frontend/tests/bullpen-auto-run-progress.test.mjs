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
  assert.equal(view.stages[2].detail, "Waiting for Stage 2 to finish before investment planning starts.");
  assert.deepEqual(view.stages[2].outputs, {});
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
      }),
    ],
  });

  assert.equal(view.stages[0].scanCandidates.length, 1);
  assert.deepEqual(view.stages[0].scanCandidates[0], {
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
  });
  assert.deepEqual(view.stages[1].scanCandidates, []);
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

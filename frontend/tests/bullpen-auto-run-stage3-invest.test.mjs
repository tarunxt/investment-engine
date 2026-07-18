import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";

function transpileModuleSource(source, fileName) {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
    },
    fileName,
  }).outputText;
}

async function loadStage3InvestModule() {
  const tempDir = mkdtempSync(path.join(tmpdir(), "bullpen-auto-run-stage3-invest-"));
  const strategySource = readFileSync(
    new URL("../lib/bullpenStage2To3Strategy.ts", import.meta.url),
    "utf8",
  );
  const strategyPath = path.join(tempDir, "bullpenStage2To3Strategy.mjs");
  writeFileSync(
    strategyPath,
    transpileModuleSource(strategySource, "bullpenStage2To3Strategy.ts"),
    "utf8",
  );
  const source = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/bullpenAutoRunStage3Invest.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const modulePath = path.join(tempDir, "bullpenAutoRunStage3Invest.mjs");
  writeFileSync(
    modulePath,
    transpileModuleSource(source, "bullpenAutoRunStage3Invest.ts").replace(
      'from "@/lib/bullpenStage2To3Strategy";',
      `from ${JSON.stringify(pathToFileURL(strategyPath).href)};`,
    ),
    "utf8",
  );

  return import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`);
}

function createStage(stageNumber, workflowStageKey, outputs, phaseStatus = "completed") {
  return {
    stage_number: stageNumber,
    stage_name: `Stage ${stageNumber}`,
    status: "pass",
    reason: `Stage ${stageNumber} finished.`,
    inputs: {},
    outputs: {
      workflow_stage_key: workflowStageKey,
      phase_status: phaseStatus,
      ...outputs,
    },
    guardrails_checked: [],
    hard_block: false,
    started_at: "2026-06-30T12:00:00Z",
    completed_at: phaseStatus === "completed" ? "2026-06-30T12:05:00Z" : null,
  };
}

function createRun({ id = "run-stage3-source", stageResults, ordersSubmitted = 0 } = {}) {
  return {
    id,
    triggered_by: "manual",
    status: "failed",
    dry_run: false,
    started_at: "2026-06-30T12:00:00Z",
    completed_at: "2026-06-30T12:06:00Z",
    summary: "Stage 3 never started.",
    live_execution_requested: false,
    live_execution_attempted: false,
    decisions_count: 0,
    orders_planned: 0,
    orders_submitted: ordersSubmitted,
    error_message: null,
    stage_results: stageResults,
    guardrail_checks: [],
    decision_ids: [],
  };
}

function createSubmittedBuyDecision({
  runId = "run-stage3-source",
  marketId = "market-1",
  marketTitle = "Will event one happen?",
} = {}) {
  return {
    id: `decision-${runId}-${marketId}`,
    run_id: runId,
    created_at: "2026-06-30T12:05:30Z",
    updated_at: "2026-06-30T12:05:30Z",
    market_id: marketId,
    market_title: marketTitle,
    market_url: `https://example.com/${marketId}`,
    slug: marketId,
    close_time: "2026-07-07T12:00:00Z",
    theme: "Politics",
    side: "NO",
    decision: "BUY_NEW",
    risk_status: "Ready",
    price_cents: 82,
    current_yes_odds: 18,
    current_no_odds: 82,
    fair_probability_pct: 82,
    fair_yes_probability_pct: 18,
    fair_no_probability_pct: 82,
    edge_pp: 0,
    score: 5,
    confidence: "High",
    evidence_status: "Strong",
    event_state: "Watching",
    adjudication_required: false,
    disagreement_level: "Low",
    current_exposure_usd: 0,
    target_exposure_usd: 5,
    realized_pnl_usd: null,
    hours_remaining: null,
    key_evidence: [],
    red_flags: [],
    rationale: null,
    reason: "Submitted from a prior Stage 3 attempt.",
    summary: "Submitted from a prior Stage 3 attempt.",
    order_plan: {
      id: `order-${runId}-${marketId}`,
      action: "buy",
      side: "NO",
      order_type: "limit",
      status: "submitted",
      market_id: marketId,
      market_title: marketTitle,
      order_size_usd: 5,
      shares: 6.097561,
      limit_price_cents: 82,
      refreshed_market_price_cents: 82,
      max_slippage_cents: 2,
      dry_run: false,
      detail: "Limit order submitted successfully.",
      execution_response: null,
      created_at: "2026-06-30T12:05:30Z",
      executed_at: "2026-06-30T12:05:31Z",
    },
    llm_outputs: [],
    stage_results: [],
    guardrail_checks: [],
  };
}

function createSubmittedRedeemDecision({
  runId = "run-stage3-exit",
  marketId = "market-1",
  marketTitle = "Will event one happen?",
} = {}) {
  return {
    id: `decision-${runId}-${marketId}-redeem`,
    run_id: runId,
    created_at: "2026-07-02T12:05:30Z",
    updated_at: "2026-07-02T12:05:30Z",
    market_id: marketId,
    market_title: marketTitle,
    market_url: `https://example.com/${marketId}`,
    slug: marketId,
    close_time: "2026-07-07T12:00:00Z",
    theme: "Politics",
    side: "NO",
    decision: "EXIT",
    risk_status: "Ready",
    price_cents: 100,
    current_yes_odds: 0,
    current_no_odds: 100,
    fair_probability_pct: 100,
    fair_yes_probability_pct: 0,
    fair_no_probability_pct: 100,
    edge_pp: 0,
    score: 5,
    confidence: "High",
    evidence_status: "Strong",
    event_state: "Resolved",
    adjudication_required: false,
    disagreement_level: "Low",
    current_exposure_usd: 5,
    target_exposure_usd: 0,
    realized_pnl_usd: 1.1,
    hours_remaining: 0,
    key_evidence: [],
    red_flags: [],
    rationale: null,
    reason: "Redeemed after settlement.",
    summary: "Redeemed after settlement.",
    order_plan: {
      id: `order-${runId}-${marketId}-redeem`,
      action: "redeem",
      side: "NO",
      order_type: "market",
      status: "submitted",
      market_id: marketId,
      market_title: marketTitle,
      order_size_usd: 5,
      shares: 6.097561,
      limit_price_cents: 100,
      refreshed_market_price_cents: 100,
      max_slippage_cents: 0,
      dry_run: false,
      detail: "Bullpen redeem/claim submitted successfully.",
      execution_response: null,
      created_at: "2026-07-02T12:05:30Z",
      executed_at: "2026-07-02T12:05:31Z",
    },
    llm_outputs: [],
    stage_results: [],
    guardrail_checks: [],
  };
}

test("Stage 3 invest plan reuses only Stage 2-qualified candidate rows", async () => {
  const { buildBullpenStage3OnlyInvestPlan } = await loadStage3InvestModule();

  const run = createRun({
    stageResults: [
      createStage(1, "scan", {
        snapshot_id: "snapshot-9",
        mode: "30-days",
        scan_source_label: "Bullpen Auto-Run",
        scan_source_url: "https://example.com/bullpen",
        scanned_at: "2026-06-30T11:59:00Z",
        accepted_candidates: [
          {
            question_id: "question-1",
            market_id: "market-1",
            question: "Will event one happen?",
            market_title: "Will event one happen?",
            market_url: "https://example.com/market-1",
            slug: "event-one",
            close_time: "2026-07-07T12:00:00Z",
            theme: "Politics",
            current_yes_odds: 43,
            current_no_odds: 57,
          },
          {
            question_id: "question-2",
            market_id: "market-2",
            question: "Will event two happen?",
            market_title: "Will event two happen?",
            market_url: "https://example.com/market-2",
            slug: "event-two",
            close_time: "2026-07-08T12:00:00Z",
            theme: "Sports",
            current_yes_odds: 51,
            current_no_odds: 49,
          },
        ],
      }),
      createStage(2, "llm", {
        scan_source_label: "Bullpen Auto-Run",
        scan_source_url: "https://example.com/bullpen",
        llm_reviewed_candidates: [
          {
            market_id: "market-1",
            question: "Will event one happen?",
            market_url: "https://example.com/market-1",
            slug: "event-one",
            close_time: "2026-07-07T12:00:00Z",
            returns_per_day: 1.7,
            qualified: true,
            selected_side: "NO",
            fair_yes_probability_pct: 18,
            fair_no_probability_pct: 82,
            disagreement_level: "Low",
            disagreement_category: "CONSENSUS",
            adjudication_required: false,
            confidence: "High",
            evidence_status: "Strong",
            event_state: "Watching",
            yes_definition: "Official source resolves the event.",
            deadline_et: "July 7, 2026 8:00 PM ET",
            llm_outputs: [
              {
                provider: "openai",
                model: "gpt-4o-mini",
                llm_yes_odds: 18,
                llm_no_odds: 82,
                confidence: "High",
                evidence_status: "Strong",
                event_state: "Watching",
                key_evidence: ["Evidence one"],
                red_flags: [],
                rationale: "No side stayed stronger.",
                completed_at: "2026-06-30T12:03:00Z",
              },
            ],
          },
          {
            market_id: "market-2",
            question: "Will event two happen?",
            market_url: "https://example.com/market-2",
            slug: "event-two",
            close_time: "2026-07-08T12:00:00Z",
            returns_per_day: 0.4,
            qualified: false,
            fair_yes_probability_pct: 55,
            fair_no_probability_pct: 45,
            disagreement_level: "High",
            adjudication_required: true,
          },
          {
            market_id: "active-position-1",
            question: "Active position row",
            source_kind: "active_position",
            qualified: false,
          },
        ],
      }),
      createStage(3, "invest", {}, "queued"),
    ],
  });

  const plan = buildBullpenStage3OnlyInvestPlan(run);

  assert.equal(plan.blockedReason, null);
  assert.equal(plan.qualifiedCandidateCount, 1);
  assert.ok(plan.request?.console_profile);
  assert.equal(plan.request.console_profile.reuse_saved_llm_outputs, true);
  assert.equal(plan.request.console_profile.source_label, "Bullpen Auto-Run");
  assert.equal(plan.request.console_profile.snapshot_id, "snapshot-9");
  assert.equal(plan.request.console_profile.candidate_rows.length, 1);
  assert.deepEqual(plan.request.console_profile.candidate_rows[0], {
    question_id: "question-1",
    market_id: "market-1",
    market_title: "Will event one happen?",
    slug: "event-one",
    market_url: "https://example.com/market-1",
    close_time: "2026-07-07T12:00:00Z",
    theme: "Politics",
    current_yes_odds: 43,
    current_no_odds: 57,
    volume_usd: null,
    liquidity_usd: null,
    best_bid_cents: null,
    best_ask_cents: null,
    spread_cents: null,
    llm_yes_odds: 18,
    llm_no_odds: 82,
    returns_per_day: 1.7,
    amount_to_be_invested: null,
    llm_disagreement_level: "Low",
    llm_disagreement_category: "CONSENSUS",
    adjudication_required: false,
    confidence: "High",
    evidence_status: "Strong",
    event_state: "Watching",
    rules: "Official source resolves the event. | Deadline ET: July 7, 2026 8:00 PM ET",
    market_context: null,
    resolution_source: null,
    event_description: null,
    preflight_evidence_block: null,
    selected: true,
    llm_outputs: [
      {
        provider: "openai",
        model: "gpt-4o-mini",
        llm_yes_odds: 18,
        llm_no_odds: 82,
        confidence: "High",
        evidence_status: "Strong",
        event_state: "Watching",
        key_evidence: ["Evidence one"],
        red_flags: [],
        rationale: "No side stayed stronger.",
        error: null,
        completed_at: "2026-06-30T12:03:00Z",
      },
    ],
  });
});

test("Stage 3 invest plan only reuses ranked top-table candidate rows when saved ranking exists", async () => {
  const { buildBullpenStage3OnlyInvestPlan } = await loadStage3InvestModule();

  const run = createRun({
    stageResults: [
      createStage(1, "scan", {
        snapshot_id: "snapshot-top-10",
        accepted_candidates: [
          {
            question_id: "question-1",
            market_id: "market-1",
            question: "Will event one happen?",
            market_title: "Will event one happen?",
            market_url: "https://example.com/market-1",
            slug: "event-one",
            close_time: "2026-07-07T12:00:00Z",
            theme: "Politics",
            current_yes_odds: 43,
            current_no_odds: 57,
          },
          {
            question_id: "question-2",
            market_id: "market-2",
            question: "Will event two happen?",
            market_title: "Will event two happen?",
            market_url: "https://example.com/market-2",
            slug: "event-two",
            close_time: "2026-07-08T12:00:00Z",
            theme: "Sports",
            current_yes_odds: 21,
            current_no_odds: 79,
          },
        ],
      }),
      createStage(2, "llm", {
        llm_reviewed_candidates: [
          {
            market_id: "market-1",
            question: "Will event one happen?",
            market_url: "https://example.com/market-1",
            slug: "event-one",
            close_time: "2026-07-07T12:00:00Z",
            returns_per_day: 1.7,
            qualified: true,
            selected_side: "NO",
            fair_yes_probability_pct: 18,
            fair_no_probability_pct: 82,
            disagreement_level: "Low",
            disagreement_category: "CONSENSUS",
            adjudication_required: false,
            confidence: "High",
            evidence_status: "Strong",
            event_state: "Watching",
          },
          {
            market_id: "market-2",
            question: "Will event two happen?",
            market_url: "https://example.com/market-2",
            slug: "event-two",
            close_time: "2026-07-08T12:00:00Z",
            returns_per_day: 2.4,
            qualified: true,
            selected_side: "NO",
            fair_yes_probability_pct: 12,
            fair_no_probability_pct: 88,
            disagreement_level: "Low",
            disagreement_category: "CONSENSUS",
            adjudication_required: false,
            confidence: "High",
            evidence_status: "Strong",
            event_state: "Watching",
          },
        ],
      }),
      createStage(6, "ranking", {
        top_candidate_market_ids: ["market-2"],
        ranked_top_candidate_market_ids: ["market-2"],
      }),
      createStage(3, "invest", {}, "queued"),
    ],
  });

  const plan = buildBullpenStage3OnlyInvestPlan(run);

  assert.equal(plan.blockedReason, null);
  assert.equal(plan.qualifiedCandidateCount, 1);
  assert.equal(plan.request?.console_profile?.candidate_rows.length, 1);
  assert.equal(
    plan.request?.console_profile?.candidate_rows[0]?.market_id,
    "market-2",
  );
});

test("Stage 3 invest plan blocks reuse when historical Stage 2 metadata says the eligible universe was incomplete", async () => {
  const { buildBullpenStage3OnlyInvestPlan } = await loadStage3InvestModule();

  const run = createRun({
    stageResults: [
      createStage(1, "scan", {
        accepted_candidates: [
          {
            question_id: "question-1",
            market_id: "market-1",
            question: "Will event one happen?",
            market_title: "Will event one happen?",
            market_url: "https://example.com/market-1",
            slug: "event-one",
            close_time: "2026-07-07T12:00:00Z",
            theme: "Politics",
            current_yes_odds: 43,
            current_no_odds: 57,
          },
        ],
      }),
      createStage(2, "llm", {
        stage2_eligible_rows_total: 26,
        stage2_reviewed_rows: 20,
        stage2_universe_complete: false,
        llm_reviewed_candidates: [
          {
            market_id: "market-1",
            question: "Will event one happen?",
            market_url: "https://example.com/market-1",
            slug: "event-one",
            close_time: "2026-07-07T12:00:00Z",
            returns_per_day: 1.7,
            qualified: true,
            selected_side: "NO",
            fair_yes_probability_pct: 18,
            fair_no_probability_pct: 82,
            disagreement_level: "Low",
            disagreement_category: "CONSENSUS",
            adjudication_required: false,
            confidence: "High",
            evidence_status: "Strong",
            event_state: "Watching",
          },
        ],
      }),
      createStage(3, "invest", {}, "queued"),
    ],
  });

  const plan = buildBullpenStage3OnlyInvestPlan(run);

  assert.equal(plan.request, null);
  assert.equal(plan.qualifiedCandidateCount, 1);
  assert.equal(
    plan.blockedReason,
    "Stage 3 reuse is blocked because the saved run reviewed only 20 of 26, so the combined top-10 ranking is incomplete.",
  );
});

test("Stage 3 invest plan trusts the reviewed-row counts when legacy isComplete metadata contradicts a complete universe", async () => {
  const { buildBullpenStage3OnlyInvestPlan } = await loadStage3InvestModule();

  const run = createRun({
    stageResults: [
      createStage(1, "scan", {
        accepted_candidates: [
          {
            question_id: "question-1",
            market_id: "market-1",
            question: "Will event one happen?",
            market_title: "Will event one happen?",
            market_url: "https://example.com/market-1",
            slug: "event-one",
            close_time: "2026-07-07T12:00:00Z",
            theme: "Politics",
            current_yes_odds: 43,
            current_no_odds: 57,
          },
        ],
      }),
      createStage(2, "llm", {
        stage2_eligible_rows_total: 1,
        stage2_reviewed_rows: 1,
        stage2_universe_complete: false,
        llm_reviewed_candidates: [
          {
            market_id: "market-1",
            question: "Will event one happen?",
            market_url: "https://example.com/market-1",
            slug: "event-one",
            close_time: "2026-07-07T12:00:00Z",
            returns_per_day: 1.7,
            qualified: true,
            selected_side: "NO",
            fair_yes_probability_pct: 18,
            fair_no_probability_pct: 82,
            disagreement_level: "Low",
            disagreement_category: "CONSENSUS",
            adjudication_required: false,
            confidence: "High",
            evidence_status: "Strong",
            event_state: "Watching",
          },
        ],
      }),
      createStage(3, "invest", {}, "queued"),
    ],
  });

  const plan = buildBullpenStage3OnlyInvestPlan(run);

  assert.equal(plan.blockedReason, null);
  assert.equal(plan.qualifiedCandidateCount, 1);
  assert.equal(plan.request?.console_profile?.candidate_rows.length, 1);
});

test("Stage 3 invest plan stays blocked until Stage 2 completes", async () => {
  const { buildBullpenStage3OnlyInvestPlan } = await loadStage3InvestModule();

  const run = createRun({
    stageResults: [
      createStage(1, "scan", { accepted_candidates: [] }),
      createStage(2, "llm", { llm_reviewed_candidates: [] }, "running"),
    ],
  });

  const plan = buildBullpenStage3OnlyInvestPlan(run);

  assert.equal(plan.request, null);
  assert.equal(
    plan.blockedReason,
    "Stage 2 must complete before Invest can reuse its qualified rows.",
  );
});

test("Stage 3 invest plan stays blocked when Stage 2 produced no qualified candidates", async () => {
  const { buildBullpenStage3OnlyInvestPlan } = await loadStage3InvestModule();

  const run = createRun({
    stageResults: [
      createStage(1, "scan", { accepted_candidates: [] }),
      createStage(2, "llm", {
        llm_reviewed_candidates: [
          {
            market_id: "market-2",
            question: "Will event two happen?",
            qualified: false,
            fair_yes_probability_pct: 60,
            fair_no_probability_pct: 40,
          },
        ],
      }),
    ],
  });

  const plan = buildBullpenStage3OnlyInvestPlan(run);

  assert.equal(plan.request, null);
  assert.equal(
    plan.blockedReason,
    "No Stage 2-qualified events are available to invest yet.",
  );
});

test("Stage 3 invest source falls back to the latest persisted Stage 2-qualified run after a newer run is interrupted", async () => {
  const { selectBullpenStage3OnlyInvestSource } = await loadStage3InvestModule();

  const interruptedRun = createRun({
    id: "run-stage3-interrupted",
    stageResults: [
      createStage(1, "scan", { accepted_candidates: [] }),
      createStage(2, "llm", { llm_reviewed_candidates: [] }, "running"),
    ],
  });

  const reusableRun = createRun({
    id: "run-stage3-reusable",
    stageResults: [
      createStage(1, "scan", {
        snapshot_id: "snapshot-older",
        accepted_candidates: [
          {
            question_id: "question-older",
            market_id: "market-older",
            question: "Will the older event happen?",
            market_title: "Will the older event happen?",
            market_url: "https://example.com/market-older",
            slug: "older-event",
            close_time: "2026-07-09T12:00:00Z",
            theme: "Macro",
            current_yes_odds: 41,
            current_no_odds: 59,
          },
        ],
      }),
      createStage(2, "llm", {
        llm_reviewed_candidates: [
          {
            market_id: "market-older",
            question: "Will the older event happen?",
            market_url: "https://example.com/market-older",
            slug: "older-event",
            close_time: "2026-07-09T12:00:00Z",
            returns_per_day: 2.1,
            qualified: true,
            fair_yes_probability_pct: 14,
            fair_no_probability_pct: 86,
            disagreement_level: "Low",
            disagreement_category: "CONSENSUS",
            adjudication_required: false,
            confidence: "High",
            evidence_status: "Strong",
            event_state: "Watching",
          },
        ],
      }),
      createStage(3, "invest", {}, "queued"),
    ],
  });

  const selection = selectBullpenStage3OnlyInvestSource([
    interruptedRun,
    reusableRun,
  ]);

  assert.equal(selection.run?.id, reusableRun.id);
  assert.equal(selection.plan.blockedReason, null);
  assert.equal(selection.plan.qualifiedCandidateCount, 1);
  assert.equal(
    selection.plan.request?.console_profile?.candidate_rows[0]?.market_id,
    "market-older",
  );
});

test("Stage 3 invest execution plan keeps reuse enabled while skipping already invested candidates", async () => {
  const { buildBullpenStage3OnlyInvestExecutionPlan } = await loadStage3InvestModule();

  const run = createRun({
    id: "run-stage3-resume",
    stageResults: [
      createStage(1, "scan", {
        snapshot_id: "snapshot-9",
        active_positions_found: [
          {
            market_id: "market-1",
            market_title: "Will event one happen?",
            side: "NO",
          },
        ],
        accepted_candidates: [
          {
            question_id: "question-1",
            market_id: "market-1",
            question: "Will event one happen?",
            market_title: "Will event one happen?",
            market_url: "https://example.com/market-1",
            slug: "event-one",
            close_time: "2026-07-07T12:00:00Z",
            theme: "Politics",
            current_yes_odds: 43,
            current_no_odds: 57,
          },
          {
            question_id: "question-2",
            market_id: "market-2",
            question: "Will event two happen?",
            market_title: "Will event two happen?",
            market_url: "https://example.com/market-2",
            slug: "event-two",
            close_time: "2026-07-08T12:00:00Z",
            theme: "Sports",
            current_yes_odds: 51,
            current_no_odds: 49,
          },
        ],
      }),
      createStage(2, "llm", {
        llm_reviewed_candidates: [
          {
            market_id: "market-1",
            question: "Will event one happen?",
            market_url: "https://example.com/market-1",
            slug: "event-one",
            close_time: "2026-07-07T12:00:00Z",
            returns_per_day: 1.7,
            qualified: true,
            fair_yes_probability_pct: 18,
            fair_no_probability_pct: 82,
            disagreement_level: "Low",
            disagreement_category: "CONSENSUS",
            adjudication_required: false,
            confidence: "High",
            evidence_status: "Strong",
            event_state: "Watching",
          },
          {
            market_id: "market-2",
            question: "Will event two happen?",
            market_url: "https://example.com/market-2",
            slug: "event-two",
            close_time: "2026-07-08T12:00:00Z",
            returns_per_day: 1.4,
            qualified: true,
            fair_yes_probability_pct: 73,
            fair_no_probability_pct: 27,
            disagreement_level: "Low",
            disagreement_category: "CONSENSUS",
            adjudication_required: false,
            confidence: "High",
            evidence_status: "Strong",
            event_state: "Watching",
          },
        ],
      }),
    ],
  });

  const executionPlan = buildBullpenStage3OnlyInvestExecutionPlan(run, [
    createSubmittedBuyDecision({
      runId: "run-stage3-resume",
      marketId: "market-1",
    }),
  ], {
    activePositions: [
      {
        key: "market-1::NO",
        marketId: "market-1",
        conditionId: null,
        marketTitle: "Will event one happen?",
        outcome: "No",
        shares: 6.097561,
        averagePrice: 0.82,
        costBasis: 5,
        yesOdds: 18,
        noOdds: 82,
        currentPrice: 0.82,
        currentValue: 5,
        unrealizedPnl: 0,
        unrealizedPnlPercent: 0,
        marketUrl: "https://example.com/market-1",
        closeTime: "2026-07-07T12:00:00Z",
        isClaimable: false,
        claimableValue: null,
        returnsPerDay: 1.7,
        rules: null,
        marketContext: null,
        resolutionSource: null,
      },
    ],
    hasActivePositionsSnapshot: true,
  });

  assert.equal(executionPlan.blockedReason, null);
  assert.equal(executionPlan.qualifiedCandidateCount, 2);
  assert.equal(executionPlan.readyCandidateCount, 1);
  assert.equal(executionPlan.alreadyInvestedCandidateCount, 1);
  assert.deepEqual(executionPlan.alreadyInvestedMarketIds, ["market-1"]);
  assert.equal(executionPlan.request?.console_profile?.candidate_rows.length, 1);
  assert.equal(
    executionPlan.request?.console_profile?.candidate_rows[0]?.market_id,
    "market-2",
  );
  assert.equal(
    executionPlan.candidatePreviews.find(
      (preview) => preview.candidate.market_id === "market-1",
    )?.status,
    "already-invested",
  );
  assert.equal(
    executionPlan.candidatePreviews.find(
      (preview) => preview.candidate.market_id === "market-1",
    )?.investedAt,
    "2026-06-30T12:05:31Z",
  );
  assert.equal(
    executionPlan.candidatePreviews.find(
      (preview) => preview.candidate.market_id === "market-1",
    )?.investedSource,
    "live-position",
  );
});

test("Stage 3 invest execution plan ignores saved claimable positions when reconciling already-invested markets", async () => {
  const { buildBullpenStage3OnlyInvestExecutionPlan } = await loadStage3InvestModule();

  const run = createRun({
    id: "run-stage3-claimable-saved",
    stageResults: [
      createStage(1, "scan", {
        active_positions_found: [
          {
            market_id: "market-1",
            market_title: "Will event one happen?",
            side: "NO",
            is_claimable: true,
            classification: "positive_payout_claimable",
          },
        ],
        accepted_candidates: [
          {
            question_id: "question-1",
            market_id: "market-1",
            question: "Will event one happen?",
            market_title: "Will event one happen?",
            market_url: "https://example.com/market-1",
            slug: "event-one",
            close_time: "2026-07-07T12:00:00Z",
            theme: "Politics",
            current_yes_odds: 43,
            current_no_odds: 57,
          },
        ],
      }),
      createStage(2, "llm", {
        llm_reviewed_candidates: [
          {
            market_id: "market-1",
            question: "Will event one happen?",
            market_url: "https://example.com/market-1",
            slug: "event-one",
            close_time: "2026-07-07T12:00:00Z",
            returns_per_day: 1.7,
            qualified: true,
            fair_yes_probability_pct: 18,
            fair_no_probability_pct: 82,
            disagreement_level: "Low",
            disagreement_category: "CONSENSUS",
            adjudication_required: false,
            confidence: "High",
            evidence_status: "Strong",
            event_state: "Watching",
          },
        ],
      }),
    ],
  });

  const executionPlan = buildBullpenStage3OnlyInvestExecutionPlan(run);

  assert.equal(executionPlan.blockedReason, null);
  assert.equal(executionPlan.readyCandidateCount, 1);
  assert.equal(executionPlan.alreadyInvestedCandidateCount, 0);
  assert.deepEqual(executionPlan.alreadyInvestedMarketIds, []);
  assert.equal(
    executionPlan.candidatePreviews.find(
      (preview) => preview.candidate.market_id === "market-1",
    )?.status,
    "ready",
  );
});

test("Stage 3 invest execution plan reopens a saved-run buy after a later redeem reconciles it", async () => {
  const { buildBullpenStage3OnlyInvestExecutionPlan } = await loadStage3InvestModule();

  const run = createRun({
    id: "run-stage3-redeem-reconciled",
    stageResults: [
      createStage(1, "scan", {
        accepted_candidates: [
          {
            question_id: "question-1",
            market_id: "market-1",
            question: "Will event one happen?",
            market_title: "Will event one happen?",
            market_url: "https://example.com/market-1",
            slug: "event-one",
            close_time: "2026-07-07T12:00:00Z",
            theme: "Politics",
            current_yes_odds: 43,
            current_no_odds: 57,
          },
        ],
      }),
      createStage(2, "llm", {
        llm_reviewed_candidates: [
          {
            market_id: "market-1",
            question: "Will event one happen?",
            market_url: "https://example.com/market-1",
            slug: "event-one",
            close_time: "2026-07-07T12:00:00Z",
            returns_per_day: 1.7,
            qualified: true,
            fair_yes_probability_pct: 18,
            fair_no_probability_pct: 82,
            disagreement_level: "Low",
            disagreement_category: "CONSENSUS",
            adjudication_required: false,
            confidence: "High",
            evidence_status: "Strong",
            event_state: "Watching",
          },
        ],
      }),
    ],
  });

  const executionPlan = buildBullpenStage3OnlyInvestExecutionPlan(run, [
    createSubmittedBuyDecision({
      runId: "run-stage3-redeem-reconciled",
      marketId: "market-1",
    }),
    createSubmittedRedeemDecision({
      runId: "run-stage3-exit",
      marketId: "market-1",
    }),
  ]);

  assert.equal(executionPlan.blockedReason, null);
  assert.equal(executionPlan.readyCandidateCount, 1);
  assert.equal(executionPlan.alreadyInvestedCandidateCount, 0);
  assert.deepEqual(executionPlan.alreadyInvestedMarketIds, []);
  assert.equal(
    executionPlan.candidatePreviews.find(
      (preview) => preview.candidate.market_id === "market-1",
    )?.status,
    "ready",
  );
});

test("Stage 3 schedule card keeps Invest controls in Stage 3 and skipped investments in Stage 2", () => {
  const source = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const statusSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/bullpenAutoRunStageStatus.ts",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(source, />\s*Exit and Invest\s*</);
  assert.match(source, /getInvestStageImmediateSuccess/);
  assert.match(source, /buildBullpenStage3InvestPreviewSteps/);
  assert.match(source, />\s*Invested\s*</);
  assert.match(source, /border-blue-950 bg-blue-950 text-white hover:bg-blue-900/);
  assert.match(statusSource, /Rebalance and investment complete\./);
  assert.match(source, /ready for this invest-only pass\./);
  assert.doesNotMatch(source, /stage\.key === "llm" && investOnlyPlan\.alreadyInvestedCandidateCount > 0/);
  assert.doesNotMatch(source, /already invested and will be skipped/);
  assert.match(source, /CheckCircle2/);
  assert.match(source, /Open Stage 3 planned details/);
  assert.match(source, /Explain Stage 2 to Stage 3 planned strategy/);
  assert.match(source, /formatOddsPercent\(candidate\.llmYesOdds\)/);
  assert.match(source, /formatOddsPercent\(candidate\.llmNoOdds\)/);
  assert.match(source, /formatReturnsPerDay\(candidate\.returnsPerDay\)/);
  assert.match(source, /formatInvestAmount\(candidate\.amountToBeInvested\)/);
  assert.match(source, />LLM Yes Odds<\/th>/);
  assert.match(source, />LLM No Odds<\/th>/);
  assert.match(source, />Returns\/day<\/th>/);
  assert.match(source, /formatOddsPercent\(decision\.fair_yes_probability_pct \?\? null\)/);
  assert.match(source, /formatOddsPercent\(decision\.fair_no_probability_pct \?\? null\)/);
  assert.match(source, /formatReturnsPerDay\(getDecisionReturnsPerDay\(decision\)\)/);
  assert.match(source, /STAGE_TWO_BYPASS_REASON/);
  assert.match(source, /Open Stage 2 bypass reason/);
  assert.match(source, /Steps to rectify/);
});

test("Stage 3 schedule card exposes a planned preview queue for current buys and sells", () => {
  const source = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(source, /Stage 3 Planned Preview/);
  assert.match(source, /Current Stage 3 buy and sell queue/);
  assert.match(source, /current Event Exits list with the saved\s+Stage 2 top-10 buy rows/);
  assert.match(source, /Submit Planned Buys and Sells/);
  assert.match(source, /NO_STAGE2_QUALIFIED_EVENTS_REASON/);
});

test("Stage 3 preview steps summarize the sell-first then invest flow before execution starts", async () => {
  const {
    buildBullpenStage3InvestPreviewSteps,
  } = await loadStage3InvestModule();

  const previewSteps = buildBullpenStage3InvestPreviewSteps({
    request: {
      console_profile: {
        source_label: "Saved Stage 2 output",
        source_url: null,
        scanned_at: "2026-06-30T11:59:00Z",
        snapshot_id: "snapshot-9",
        mode: "stage-3-invest-only",
        total_candidates: 2,
        candidate_rows_prefiltered: true,
        reuse_saved_llm_outputs: true,
        candidate_rows: [],
      },
    },
    qualifiedCandidateCount: 2,
    readyCandidateCount: 2,
    alreadyInvestedCandidateCount: 0,
    alreadyInvestedMarketIds: [],
    alreadyInvestedRecords: [],
    candidatePreviews: [],
    blockedReason: null,
  });

  assert.equal(previewSteps.length, 2);
  assert.deepEqual(
    previewSteps.map((step) => ({
      key: step.key,
      status: step.status,
      label: step.label,
    })),
    [
      { key: "sell", status: "pending", label: "Event Exits" },
      { key: "buy", status: "pending", label: "Invest planned orders" },
    ],
  );
  assert.equal(previewSteps[0].plannedOrders, null);
  assert.equal(previewSteps[1].plannedOrders, 2);
  assert.match(previewSteps[0].detail, /Event Exits, waits for settlement/i);
  assert.match(previewSteps[0].detail, /refreshes live cash plus occupied slots/i);
  assert.match(previewSteps[1].detail, /Stage 2-qualified/);
  assert.match(previewSteps[1].detail, /post-exit sizing/i);
});

test("Stage 3 preview steps mark the no-work case as finished instead of pending", async () => {
  const {
    buildBullpenStage3InvestPreviewSteps,
    NO_STAGE2_QUALIFIED_EVENTS_REASON,
  } = await loadStage3InvestModule();

  const previewSteps = buildBullpenStage3InvestPreviewSteps({
    request: null,
    qualifiedCandidateCount: 0,
    readyCandidateCount: 0,
    alreadyInvestedCandidateCount: 0,
    alreadyInvestedMarketIds: [],
    alreadyInvestedRecords: [],
    candidatePreviews: [],
    blockedReason: NO_STAGE2_QUALIFIED_EVENTS_REASON,
  });

  assert.equal(previewSteps.length, 2);
  assert.deepEqual(
    previewSteps.map((step) => ({
      key: step.key,
      status: step.status,
      displayStatusLabel: step.displayStatusLabel ?? null,
    })),
    [
      { key: "sell", status: "completed", displayStatusLabel: "N/A" },
      { key: "buy", status: "completed", displayStatusLabel: null },
    ],
  );
  assert.match(previewSteps[0].detail, /No executable Step 1 Event Exits were needed/i);
  assert.match(previewSteps[1].detail, /planned queue/i);
});

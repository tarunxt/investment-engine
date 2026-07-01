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
    transpileModuleSource(source, "bullpenAutoRunStage3Invest.ts"),
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

test("Stage 3 schedule card keeps the Invest button and reuse copy inside the card", () => {
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

  assert.match(source, />\s*Invest\s*</);
  assert.match(source, /getInvestStageImmediateSuccess/);
  assert.match(source, />\s*Invested\s*</);
  assert.match(statusSource, /Rebalance and investment complete\./);
  assert.match(source, /latest Stage 2-qualified rows/);
  assert.match(source, /skips the Bullpen rescan plus LLM rerun/);
  assert.match(source, /already invested and will be skipped/);
  assert.match(source, /CheckCircle2/);
});

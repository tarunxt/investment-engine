import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

async function loadAutoLivePresentationModule() {
  const source = readFileSync(
    new URL(
      "../app/console/trading-bots/bullpen-ai-auto-live/_components/bullpenAiAutoLivePresentation.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: "bullpenAiAutoLivePresentation.ts",
  });

  return import(
    `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
  );
}

function createStage(stageNumber, status, reason, outputs = {}, inputs = {}) {
  return {
    stage_number: stageNumber,
    stage_name: `Stage ${stageNumber}`,
    status,
    reason,
    inputs,
    outputs,
    guardrails_checked: [],
    hard_block: status === "fail",
    started_at: "2026-06-21T10:00:00Z",
    completed_at: "2026-06-21T10:01:00Z",
  };
}

function createDecision({
  id,
  decision,
  theme,
  targetExposureUsd,
  currentExposureUsd,
  orderPlan,
  evidenceStatus = "Strong",
  disagreementLevel = "Low",
  hoursRemaining = 24,
  spreadYes = 6,
  updatedAt,
  guardrailChecks = [],
  stage7Status = "pass",
  stage7Reason = "Execution completed.",
}) {
  return {
    id,
    run_id: "run-1",
    created_at: updatedAt,
    updated_at: updatedAt,
    market_id: `${id}-market`,
    market_title: `${id} market`,
    market_url: "https://example.com/market",
    slug: `${id}-slug`,
    close_time: "2026-06-22T00:00:00Z",
    theme,
    side: "YES",
    decision,
    risk_status: decision === "SKIP" ? "Blocked" : "Ready",
    price_cents: 44,
    current_yes_odds: 44,
    current_no_odds: 56,
    fair_probability_pct: 58,
    fair_yes_probability_pct: 58,
    fair_no_probability_pct: 42,
    edge_pp: 14,
    score: 81,
    confidence: "High",
    evidence_status: evidenceStatus,
    event_state: "Watching",
    adjudication_required: false,
    disagreement_level: disagreementLevel,
    current_exposure_usd: currentExposureUsd,
    target_exposure_usd: targetExposureUsd,
    realized_pnl_usd: null,
    hours_remaining: hoursRemaining,
    key_evidence: ["Fresh source one", "Fresh source two"],
    red_flags: disagreementLevel === "High" ? ["Consensus spread widened"] : [],
    rationale: "Consensus favored the trade.",
    reason:
      decision === "SKIP"
        ? "Bid/ask spread exceeds the configured maximum."
        : "All entry guardrails passed.",
    summary: "Decision summary",
    order_plan: orderPlan,
    llm_outputs: [],
    stage_results: [
      createStage(2, "pass", "Rules are clear.", {
        yes_definition: "Candidate wins by deadline.",
        deadline_et: "2026-06-21 08:00:00 PM ET",
        hours_remaining: hoursRemaining,
        resolution_criteria: "Official source resolves the market.",
      }),
      createStage(3, disagreementLevel === "High" ? "warning" : "pass", "LLM consensus completed.", {
        average_yes: 56,
        median_yes: 58,
        trimmed_mean_yes: 57,
        min_yes: 49,
        max_yes: 65,
        spread_yes: spreadYes,
        disagreement_level: disagreementLevel,
        adjudication_required: false,
      }),
      createStage(4, "pass", "Market scored above thresholds.", {
        edge_pp: 14,
        evidence_weight: 1,
        confidence_weight: 1,
        liquidity_weight: 0.95,
        disagreement_weight: disagreementLevel === "High" ? 0.5 : 1,
        score: 81,
      }),
      createStage(5, "pass", "Position sizing completed.", {
        full_kelly: 0.31,
        safe_kelly: 0.08,
        target_usd: targetExposureUsd,
        order_usd: orderPlan?.order_size_usd ?? 200,
        current_exposure_usd: currentExposureUsd,
        remaining_single_market_capacity: 0.18,
        remaining_theme_capacity: 0.22,
        remaining_open_exposure_capacity: 0.4,
        remaining_cash_reserve_capacity: 0.5,
      }),
      createStage(6, decision === "SKIP" ? "warning" : "pass", "Rebalance decision completed.", {
        decision,
        current_exposure_usd: currentExposureUsd,
        target_exposure_usd: targetExposureUsd,
        order_usd: orderPlan?.order_size_usd ?? 200,
      }),
      createStage(7, stage7Status, stage7Reason, orderPlan ?? {}),
    ],
    guardrail_checks: guardrailChecks,
  };
}

test("Auto-Live presentation summarizes latest run counts and guardrail categories", async () => {
  const { buildAutoLiveRunSummary } = await loadAutoLivePresentationModule();

  const run = {
    id: "run-1",
    stage_results: [
      createStage(1, "pass", "Candidate scan completed.", {
        accepted_candidates: [{}, {}],
        rejected_candidates: [{}],
      }),
    ],
    guardrail_checks: [
      {
        id: "doctor",
        label: "Bullpen doctor",
        status: "fail",
        detail: "Bullpen doctor failed.",
        blocking: true,
        checked_at: "2026-06-21T10:01:00Z",
      },
    ],
  };

  const decisions = [
    createDecision({
      id: "buy-new",
      decision: "BUY_NEW",
      theme: "Politics",
      currentExposureUsd: 0,
      targetExposureUsd: 2500,
      updatedAt: "2026-06-21T10:10:00Z",
      orderPlan: {
        id: "order-1",
        action: "buy",
        side: "YES",
        status: "submitted",
        order_size_usd: 500,
        limit_price_cents: 44,
        max_slippage_cents: 2,
        dry_run: false,
        detail: "Limit order submitted successfully.",
      },
    }),
    createDecision({
      id: "skip",
      decision: "SKIP",
      theme: "Geopolitics",
      currentExposureUsd: 0,
      targetExposureUsd: 0,
      evidenceStatus: "Low",
      disagreementLevel: "High",
      hoursRemaining: 4,
      spreadYes: 16,
      updatedAt: "2026-06-21T10:12:00Z",
      orderPlan: null,
      stage7Status: "fail",
      stage7Reason: "Bid/ask spread exceeds the configured maximum.",
      guardrailChecks: [
        {
          id: "candidate-block",
          label: "Candidate block",
          status: "fail",
          detail: "Edge 2.00 is below the minimum 5.00.",
          blocking: true,
          checked_at: "2026-06-21T10:12:00Z",
        },
      ],
    }),
  ];

  const summary = buildAutoLiveRunSummary({
    decisions,
    run,
    settings: {
      bankroll_usd: 10000,
    },
  });

  assert.equal(summary.marketsScanned, 3);
  assert.equal(summary.marketsRejected, 1);
  assert.equal(summary.candidatesPassed, 2);
  assert.equal(summary.actionCounts.BUY_NEW, 1);
  assert.equal(summary.actionCounts.SKIP, 1);
  assert.equal(summary.executedCount, 1);
  assert.equal(summary.failedCount, 1);
  assert.equal(summary.totalProposedExposureUsd, 700);
  assert.equal(summary.totalExecutedExposureUsd, 500);
  assert.equal(summary.remainingCashReserveUsd, 7500);
  assert.equal(summary.maxThemeExposureUsed.theme, "Politics");
  assert.equal(summary.maxThemeExposureUsed.exposureUsd, 2500);
  assert.equal(summary.maxThemeExposureUsed.pctBankroll, 25);
  assert.deepEqual(
    summary.guardrailFailures.map((failure) => failure.category),
    ["Doctor", "Edge", "Spread"],
  );
});

test("Auto-Live presentation derives row status, filters, and sorting", async () => {
  const {
    buildAutoLiveDecisionRows,
    filterAutoLiveDecisionRows,
    sortAutoLiveDecisionRows,
  } = await loadAutoLivePresentationModule();

  const decisions = [
    createDecision({
      id: "buy-new",
      decision: "BUY_NEW",
      theme: "Politics",
      currentExposureUsd: 0,
      targetExposureUsd: 2500,
      updatedAt: "2026-06-21T10:10:00Z",
      orderPlan: {
        id: "order-1",
        action: "buy",
        side: "YES",
        status: "submitted",
        order_size_usd: 500,
        limit_price_cents: 44,
        max_slippage_cents: 2,
        dry_run: false,
        detail: "Limit order submitted successfully.",
      },
    }),
    createDecision({
      id: "skip",
      decision: "SKIP",
      theme: "Geopolitics",
      currentExposureUsd: 0,
      targetExposureUsd: 0,
      evidenceStatus: "Low",
      disagreementLevel: "High",
      hoursRemaining: 4,
      spreadYes: 16,
      updatedAt: "2026-06-21T10:12:00Z",
      orderPlan: null,
      stage7Status: "fail",
      stage7Reason: "Bid/ask spread exceeds the configured maximum.",
      guardrailChecks: [
        {
          id: "candidate-block",
          label: "Candidate block",
          status: "fail",
          detail: "Edge 2.00 is below the minimum 5.00.",
          blocking: true,
          checked_at: "2026-06-21T10:12:00Z",
        },
      ],
    }),
  ];

  const rows = buildAutoLiveDecisionRows({
    decisions,
    settings: {
      bankroll_usd: 10000,
      kelly_fraction: 0.25,
      no_new_trade_under_hours_to_deadline: 6,
      half_size_under_hours_to_deadline: 48,
      half_size_llm_spread_pp: 10,
      max_slippage_cents: 2,
    },
    state: {
      dry_run: false,
      doctor_status: "pass",
      balance_status: "pass",
    },
  });

  assert.equal(rows[0].statusLabel, "EXECUTED");
  assert.equal(rows[1].statusLabel, "BLOCKED");
  assert.equal(rows[1].highDisagreement, true);
  assert.equal(rows[1].lowEvidence, true);
  assert.equal(rows[1].deadlineRisk, true);
  assert.equal(rows[0].proposedOrderLabel, "Buy YES 500.00 @ 44.0c");

  assert.deepEqual(
    filterAutoLiveDecisionRows(rows, "executed").map((row) => row.id),
    ["buy-new"],
  );
  assert.deepEqual(
    filterAutoLiveDecisionRows(rows, "high-disagreement").map((row) => row.id),
    ["skip"],
  );
  assert.deepEqual(
    sortAutoLiveDecisionRows(rows, "nearest-deadline").map((row) => row.id),
    ["skip", "buy-new"],
  );
});

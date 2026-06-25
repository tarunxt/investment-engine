import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";

function createFutureCloseTime(days = 7) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

const DEFAULT_CLOSE_TIME = createFutureCloseTime();

function transpileModuleSource(source, fileName) {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
    },
    fileName,
  }).outputText;
}

async function loadBullpenAutoRunSyncModule() {
  const tempDir = mkdtempSync(path.join(tmpdir(), "bullpen-auto-run-sync-"));

  const bullpenAiSource = readFileSync(
    new URL("../lib/bullpen-ai.ts", import.meta.url),
    "utf8",
  );
  const bullpenAiPath = path.join(tempDir, "bullpen-ai.mjs");
  writeFileSync(
    bullpenAiPath,
    transpileModuleSource(bullpenAiSource, "bullpen-ai.ts"),
    "utf8",
  );

  const syncSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/bullpenAutoRunSync.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const rewrittenSyncSource = transpileModuleSource(
    syncSource,
    "bullpenAutoRunSync.ts",
  ).replace(
    'from "@/lib/bullpen-ai";',
    `from ${JSON.stringify(pathToFileURL(bullpenAiPath).href)};`,
  );
  const syncModulePath = path.join(tempDir, "bullpenAutoRunSync.mjs");
  writeFileSync(syncModulePath, rewrittenSyncSource, "utf8");

  return import(`${pathToFileURL(syncModulePath).href}?t=${Date.now()}`);
}

function createEmptySnapshots() {
  return {
    "30-days": {
      current: null,
      history: [],
    },
    "end-of-month": {
      current: null,
      history: [],
    },
  };
}

function createStage(stageNumber, workflowStageKey, outputs, completedAt) {
  return {
    stage_number: stageNumber,
    stage_name: `Stage ${stageNumber}`,
    status: "pass",
    reason: `Stage ${stageNumber} completed.`,
    inputs: {},
    outputs: {
      workflow_stage_key: workflowStageKey,
      ...outputs,
    },
    guardrails_checked: [],
    hard_block: false,
    started_at: "2026-06-25T12:00:00Z",
    completed_at: completedAt,
  };
}

function createRun({
  acceptedCandidates,
  reviewedCandidates,
  runId = "run-1",
} = {}) {
  return {
    id: runId,
    triggered_by: "manual",
    status: "running",
    dry_run: false,
    started_at: "2026-06-25T12:00:00Z",
    completed_at: null,
    summary: "Stage 3 running.",
    live_execution_requested: false,
    live_execution_attempted: false,
    decisions_count: 0,
    orders_planned: 0,
    orders_submitted: 0,
    error_message: null,
    guardrail_checks: [],
    decision_ids: [],
    stage_results: [
      createStage(
        1,
        "scan",
        {
          mode: "30-days",
          snapshot_id: "auto-snapshot-1",
          scan_source_label: "Bullpen Auto-Run",
          scan_source_url: "https://example.com/bullpen",
          scanned_at: "2026-06-25T12:00:00Z",
          scanned_candidates: acceptedCandidates.length,
          accepted_candidates: acceptedCandidates,
        },
        "2026-06-25T12:00:10Z",
      ),
      createStage(
        2,
        "llm",
        {
          llm_reviewed_candidates: reviewedCandidates,
        },
        "2026-06-25T12:02:00Z",
      ),
    ],
  };
}

function createAcceptedCandidate(overrides = {}) {
  return {
    question_id: "question-1",
    market_id: "market-1",
    question: "Will event one happen?",
    market_title: "Will event one happen?",
    market_url: "https://example.com/market-1",
    slug: "market-1",
    close_time: DEFAULT_CLOSE_TIME,
    theme: "Politics",
    current_yes_odds: 46,
    current_no_odds: 54,
    volume_usd: 462901.03,
    liquidity_usd: 14191.19,
    ...overrides,
  };
}

function createReviewedCandidate(overrides = {}) {
  return {
    market_id: "market-1",
    question: "Will event one happen?",
    market_url: "https://example.com/market-1",
    close_time: DEFAULT_CLOSE_TIME,
    returns_per_day: 1.25,
    qualified: true,
    reason: "Candidate qualifies for the Events to invest in table.",
    fair_yes_probability_pct: 12,
    fair_no_probability_pct: 88,
    disagreement_level: "Low",
    adjudication_required: false,
    confidence: "High",
    evidence_status: "Strong",
    event_state: "Watching",
    ...overrides,
  };
}

function createDecision(overrides = {}) {
  return {
    id: "decision-1",
    run_id: "run-1",
    created_at: "2026-06-25T12:03:00Z",
    updated_at: "2026-06-25T12:03:00Z",
    market_id: "market-1",
    market_title: "Will event one happen?",
    market_url: "https://example.com/market-1",
    slug: "market-1",
    close_time: DEFAULT_CLOSE_TIME,
    theme: "Politics",
    side: "NO",
    decision: "BUY_NEW",
    risk_status: "Ready",
    price_cents: 54,
    current_yes_odds: 46,
    current_no_odds: 54,
    fair_probability_pct: 78,
    fair_yes_probability_pct: 22,
    fair_no_probability_pct: 78,
    edge_pp: 24,
    score: 5,
    confidence: "High",
    evidence_status: "Strong",
    event_state: "Watching",
    adjudication_required: false,
    disagreement_level: "Low",
    current_exposure_usd: 0,
    target_exposure_usd: 5,
    realized_pnl_usd: null,
    hours_remaining: 24,
    key_evidence: ["Evidence one"],
    red_flags: [],
    rationale: "Consensus stayed strongly on the No side.",
    reason: "Qualified candidate ranked inside the top-10 returns/day table.",
    summary: "Decision summary",
    order_plan: null,
    llm_outputs: [
      {
        provider: "openai",
        model: "gpt-4o-mini",
        llm_yes_odds: 22,
        llm_no_odds: 78,
        confidence: "High",
        evidence_status: "Strong",
        event_state: "Watching",
        key_evidence: ["Evidence one"],
        red_flags: [],
        rationale: "Consensus stayed strongly on the No side.",
        completed_at: "2026-06-25T12:02:00Z",
      },
    ],
    stage_results: [
      {
        stage_number: 2,
        stage_name: "Rules",
        status: "pass",
        reason: "Resolution criteria and deadline were parsed successfully.",
        inputs: {},
        outputs: {
          yes_definition: "Official event source confirms the outcome.",
          deadline_et: "Future event deadline",
          hours_remaining: 24,
        },
        guardrails_checked: [],
        hard_block: false,
        started_at: "2026-06-25T12:01:00Z",
        completed_at: "2026-06-25T12:01:10Z",
      },
    ],
    guardrail_checks: [],
    ...overrides,
  };
}

test("Bullpen auto-run sync applies Stage 2 LLM odds before decisions are persisted", async () => {
  const { syncBullpenAutoRunSummarySnapshots } =
    await loadBullpenAutoRunSyncModule();

  const nextSnapshots = syncBullpenAutoRunSummarySnapshots({
    snapshotsByMode: createEmptySnapshots(),
    summary: { recent_decisions: [] },
    run: createRun({
      acceptedCandidates: [createAcceptedCandidate()],
      reviewedCandidates: [createReviewedCandidate()],
    }),
  });

  const syncedQuestion = nextSnapshots["30-days"].current?.questions[0] ?? null;
  assert.ok(syncedQuestion);
  assert.equal(syncedQuestion.llmYesOdds, 12);
  assert.equal(syncedQuestion.llmNoOdds, 88);
  assert.equal(syncedQuestion.amountToBeInvested, 5);
  assert.equal(typeof syncedQuestion.daysUntilClose, "number");
  assert.equal(typeof syncedQuestion.returnsPerDay, "number");
  assert.ok((syncedQuestion.daysUntilClose ?? 0) > 0);
  assert.ok((syncedQuestion.returnsPerDay ?? 0) > 0);
});

test("Bullpen auto-run sync lets persisted decisions override Stage 2 summary rows", async () => {
  const { syncBullpenAutoRunSummarySnapshots } =
    await loadBullpenAutoRunSyncModule();

  const nextSnapshots = syncBullpenAutoRunSummarySnapshots({
    snapshotsByMode: createEmptySnapshots(),
    summary: {
      recent_decisions: [createDecision()],
    },
    run: createRun({
      acceptedCandidates: [createAcceptedCandidate()],
      reviewedCandidates: [createReviewedCandidate()],
    }),
  });

  const syncedQuestion = nextSnapshots["30-days"].current?.questions[0] ?? null;
  assert.ok(syncedQuestion);
  assert.equal(syncedQuestion.llmYesOdds, 22);
  assert.equal(syncedQuestion.llmNoOdds, 78);
  assert.equal(syncedQuestion.llmBreakdown.length, 1);
  assert.equal(syncedQuestion.llmBreakdown[0]?.provider, "openai");
  assert.equal(syncedQuestion.llmCompletedAt, "2026-06-25T12:02:00Z");
});

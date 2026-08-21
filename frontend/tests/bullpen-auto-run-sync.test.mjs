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

  const bullpenAiSource = readFileSync(
    new URL("../lib/bullpen-ai.ts", import.meta.url),
    "utf8",
  );
  const bullpenAiPath = path.join(tempDir, "bullpen-ai.mjs");
  writeFileSync(
    bullpenAiPath,
    transpileModuleSource(bullpenAiSource, "bullpen-ai.ts").replace(
      'from "@/lib/bullpenStage2To3Strategy";',
      `from ${JSON.stringify(pathToFileURL(strategyPath).href)};`,
    ),
    "utf8",
  );

  const bullpenPositionsSource = readFileSync(
    new URL("../lib/bullpenPositions.ts", import.meta.url),
    "utf8",
  );
  const bullpenPositionsPath = path.join(tempDir, "bullpenPositions.mjs");
  writeFileSync(
    bullpenPositionsPath,
    transpileModuleSource(bullpenPositionsSource, "bullpenPositions.ts"),
    "utf8",
  );

  const resolverSource = readFileSync(
    new URL("../lib/bullpenEventIdentityResolver.ts", import.meta.url),
    "utf8",
  );
  const resolverPath = path.join(tempDir, "bullpenEventIdentityResolver.mjs");
  const rewrittenResolverSource = transpileModuleSource(
    resolverSource,
    "bullpenEventIdentityResolver.ts",
  )
    .replace(
      'from "./bullpen-ai";',
      `from ${JSON.stringify(pathToFileURL(bullpenAiPath).href)};`,
    )
    .replace(
      'from "./bullpenPositions";',
      `from ${JSON.stringify(pathToFileURL(bullpenPositionsPath).href)};`,
    );
  writeFileSync(resolverPath, rewrittenResolverSource, "utf8");

  const bullpenActivePositionsSource = readFileSync(
    new URL("../lib/bullpenActivePositions.ts", import.meta.url),
    "utf8",
  );
  const bullpenActivePositionsPath = path.join(
    tempDir,
    "bullpenActivePositions.mjs",
  );
  const rewrittenBullpenActivePositionsSource = transpileModuleSource(
    bullpenActivePositionsSource,
    "bullpenActivePositions.ts",
  )
    .replace(
      'from "./bullpen-ai";',
      `from ${JSON.stringify(pathToFileURL(bullpenAiPath).href)};`,
    )
    .replace(
      'from "./bullpenEventIdentityResolver";',
      `from ${JSON.stringify(pathToFileURL(resolverPath).href)};`,
    )
    .replace(
      'from "./bullpenPositions";',
      `from ${JSON.stringify(pathToFileURL(bullpenPositionsPath).href)};`,
    );
  writeFileSync(
    bullpenActivePositionsPath,
    rewrittenBullpenActivePositionsSource,
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
  )
    .replace(
      'from "@/lib/bullpen-ai";',
      `from ${JSON.stringify(pathToFileURL(bullpenAiPath).href)};`,
    )
    .replace(
      'from "@/lib/bullpenEventIdentityResolver";',
      `from ${JSON.stringify(pathToFileURL(resolverPath).href)};`,
    )
    .replace(
      'from "@/lib/bullpenActivePositions";',
      `from ${JSON.stringify(pathToFileURL(bullpenActivePositionsPath).href)};`,
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
  acceptedCandidates = [createAcceptedCandidate()],
  reviewedCandidates = [],
  runId = "run-1",
  snapshotId = "auto-snapshot-1",
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
          snapshot_id: snapshotId,
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

function createActivePosition(overrides = {}) {
  return {
    key: "market-1::NO",
    marketId: "market-1",
    slug: "market-1",
    conditionId: null,
    marketTitle: "Will event one happen?",
    outcome: "NO",
    heldSide: "NO",
    shares: 10,
    averagePrice: 0.54,
    costBasis: 5.4,
    yesOdds: 46,
    noOdds: 54,
    bestBidPrice: null,
    bestAskPrice: null,
    currentPrice: 0.54,
    currentValue: 5.4,
    expectedPayoutUsd: null,
    unrealizedPnl: 0,
    unrealizedPnlPercent: 0,
    marketUrl: "https://example.com/market-1",
    closeTime: DEFAULT_CLOSE_TIME,
    resolutionStatus: "open",
    economicClassification: "active",
    classificationReason: "Open active position.",
    isClaimable: false,
    claimableValue: null,
    returnsPerDay: 1.25,
    rules: null,
    marketContext: null,
    resolutionSource: null,
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

test("Bullpen auto-run sync archives the previous auto snapshot when a newer run completes", async () => {
  const { syncBullpenAutoRunSummarySnapshots } =
    await loadBullpenAutoRunSyncModule();

  const firstSnapshots = syncBullpenAutoRunSummarySnapshots({
    snapshotsByMode: createEmptySnapshots(),
    summary: { recent_decisions: [] },
    run: createRun({
      runId: "run-1",
      snapshotId: "auto-snapshot-1",
      acceptedCandidates: [createAcceptedCandidate()],
      reviewedCandidates: [createReviewedCandidate()],
    }),
  });
  const secondSnapshots = syncBullpenAutoRunSummarySnapshots({
    snapshotsByMode: firstSnapshots,
    summary: { recent_decisions: [] },
    run: createRun({
      runId: "run-2",
      snapshotId: "auto-snapshot-2",
      acceptedCandidates: [
        createAcceptedCandidate({
          question_id: "question-2",
          market_id: "market-2",
          question: "Will event two happen?",
          market_title: "Will event two happen?",
          market_url: "https://example.com/market-2",
          slug: "market-2",
        }),
      ],
      reviewedCandidates: [
        createReviewedCandidate({
          market_id: "market-2",
          question: "Will event two happen?",
          market_url: "https://example.com/market-2",
        }),
      ],
    }),
  });

  assert.equal(secondSnapshots["30-days"].current?.snapshotId, "auto-snapshot-2");
  assert.equal(secondSnapshots["30-days"].history.length, 1);
  assert.equal(
    secondSnapshots["30-days"].history[0]?.questions[0]?.id,
    "question-1",
  );
  assert.ok(secondSnapshots["30-days"].history[0]?.archivedAt);
});

test("Bullpen auto-run sync stores Stage 2 active-position LLM odds for green rows", async () => {
  const { syncBullpenAutoRunActivePositionAnalyses } =
    await loadBullpenAutoRunSyncModule();

  const nextAnalyses = syncBullpenAutoRunActivePositionAnalyses({
    currentAnalyses: {},
    run: createRun({
      acceptedCandidates: [createAcceptedCandidate()],
      reviewedCandidates: [
        createReviewedCandidate({
          source_kind: "active_position",
          position_key: "market-1::NO",
          position_side: "NO",
          fair_yes_probability_pct: 14,
          fair_no_probability_pct: 86,
          llm_outputs: [
            {
              provider: "openai",
              model: "gpt-4o-mini",
              llm_yes_odds: 14,
              llm_no_odds: 86,
              confidence: "High",
              evidence_status: "Strong",
              event_state: "Watching",
              key_evidence: ["No side remains favored."],
              red_flags: [],
              rationale: "Consensus stayed on the No side.",
              completed_at: "2026-06-25T12:01:30Z",
            },
          ],
        }),
      ],
      runId: "run-active-position-1",
    }),
    activePositions: [createActivePosition()],
  });

  assert.equal(nextAnalyses["market-1::NO"]?.llmYesOdds, 14);
  assert.equal(nextAnalyses["market-1::NO"]?.llmNoOdds, 86);
  assert.equal(nextAnalyses["market-1::NO"]?.llmBreakdown.length, 1);
  assert.equal(nextAnalyses["market-1::NO"]?.llmBreakdown[0]?.provider, "openai");
  assert.equal(
    nextAnalyses["market-1::NO"]?.llmCompletedAt,
    "2026-06-25T12:01:30Z",
  );
  assert.equal(nextAnalyses["market-1::NO"]?.llmRecoveryStatus, "recovered");
});

test("Bullpen auto-run sync recovers active-position odds without an explicit position key", async () => {
  const { syncBullpenAutoRunActivePositionAnalyses } =
    await loadBullpenAutoRunSyncModule();

  const nextAnalyses = syncBullpenAutoRunActivePositionAnalyses({
    currentAnalyses: {},
    activePositions: [
      createActivePosition({
        key: "internal-position::NO",
        marketId: "bullpen-market-1",
        slug: "event-one-slug",
        marketUrl: "https://polymarket.com/event/event-one-slug/",
      }),
    ],
    run: createRun({
      runId: "run-july-17-2026",
      acceptedCandidates: [createAcceptedCandidate()],
      reviewedCandidates: [
        createReviewedCandidate({
          source_kind: "active_position",
          position_key: null,
          market_id: "gamma-market-1",
          slug: "event-one-slug",
          market_url: "https://polymarket.com/event/event-one-slug?ref=popup#top",
          fair_yes_probability_pct: null,
          fair_no_probability_pct: null,
          llm_outputs: [
            {
              provider: "openai",
              model: "gpt-4.1",
              llm_yes_odds: 18,
              llm_no_odds: 82,
              completed_at: "2026-07-17T17:49:33+05:30",
            },
          ],
        }),
      ],
    }),
  });

  assert.equal(nextAnalyses["internal-position::NO"]?.llmYesOdds, 18);
  assert.equal(nextAnalyses["internal-position::NO"]?.llmNoOdds, 82);
  assert.equal(
    nextAnalyses["internal-position::NO"]?.llmCompletedAt,
    "2026-07-17T17:49:33+05:30",
  );
  assert.equal(nextAnalyses["internal-position::NO"]?.llmRecoveryStatus, "recovered");
  assert.equal(nextAnalyses["internal-position::NO"]?.llmRecoveryMatchMethod, "slug");
});

test("Bullpen auto-run sync distinguishes market IDs from actual slugs", async () => {
  const { syncBullpenAutoRunActivePositionAnalyses } =
    await loadBullpenAutoRunSyncModule();

  const nextAnalyses = syncBullpenAutoRunActivePositionAnalyses({
    currentAnalyses: {},
    activePositions: [
      createActivePosition({
        key: "slug-mismatch::NO",
        marketId: "bullpen-market-id-only",
        slug: "actual-event-slug",
        marketUrl: null,
      }),
    ],
    run: createRun({
      reviewedCandidates: [
        createReviewedCandidate({
          source_kind: "active_position",
          position_key: null,
          market_id: "gamma-market-id-only",
          slug: "actual-event-slug",
          market_url: null,
          fair_yes_probability_pct: null,
          fair_no_probability_pct: null,
          llm_outputs: [
            {
              provider: "openai",
              model: "gpt-4.1",
              llm_yes_odds: 33,
              llm_no_odds: 67,
              completed_at: "2026-07-17T17:49:33+05:30",
            },
          ],
        }),
      ],
    }),
  });

  assert.equal(nextAnalyses["slug-mismatch::NO"]?.llmYesOdds, 33);
  assert.equal(nextAnalyses["slug-mismatch::NO"]?.llmNoOdds, 67);
  assert.equal(nextAnalyses["slug-mismatch::NO"]?.llmRecoveryMatchMethod, "slug");
});

test("Bullpen auto-run sync canonicalizes market URLs before matching", async () => {
  const { syncBullpenAutoRunActivePositionAnalyses } =
    await loadBullpenAutoRunSyncModule();

  const nextAnalyses = syncBullpenAutoRunActivePositionAnalyses({
    currentAnalyses: {},
    activePositions: [
      createActivePosition({
        key: "url-variant::NO",
        marketId: "url-market",
        slug: null,
        marketUrl: "https://polymarket.com/event/url-variant/",
      }),
    ],
    run: createRun({
      reviewedCandidates: [
        createReviewedCandidate({
          source_kind: "active_position",
          position_key: null,
          market_id: null,
          slug: null,
          market_url: "https://www.polymarket.com/event/url-variant?utm_source=test#hash",
          question: "Different title should not matter",
          fair_yes_probability_pct: null,
          fair_no_probability_pct: null,
          llm_outputs: [
            {
              provider: "openai",
              model: "gpt-4.1",
              llm_yes_odds: 24,
              llm_no_odds: 76,
              completed_at: "2026-07-17T17:49:33+05:30",
            },
          ],
        }),
      ],
    }),
  });

  assert.equal(nextAnalyses["url-variant::NO"]?.llmYesOdds, 24);
  assert.equal(nextAnalyses["url-variant::NO"]?.llmNoOdds, 76);
  assert.equal(nextAnalyses["url-variant::NO"]?.llmRecoveryMatchMethod, "market_url");
});

test("Bullpen auto-run sync recovers by normalized title when the title match is unique", async () => {
  const { syncBullpenAutoRunActivePositionAnalyses } =
    await loadBullpenAutoRunSyncModule();

  const nextAnalyses = syncBullpenAutoRunActivePositionAnalyses({
    currentAnalyses: {},
    activePositions: [
      createActivePosition({
        key: "title-only::NO",
        marketId: "bullpen-market-2",
        slug: null,
        marketUrl: null,
        marketTitle: "Will event two happen?",
      }),
    ],
    run: createRun({
      reviewedCandidates: [
        createReviewedCandidate({
          source_kind: "active_position",
          position_key: null,
          market_id: null,
          slug: null,
          market_url: null,
          question: "Will event two happen?",
          fair_yes_probability_pct: null,
          fair_no_probability_pct: null,
          llm_outputs: [
            {
              provider: "openai",
              model: "gpt-4.1-mini",
              llm_yes_odds: 27,
              llm_no_odds: 73,
              completed_at: "2026-07-17T17:49:33+05:30",
            },
          ],
        }),
      ],
    }),
  });

  assert.equal(nextAnalyses["title-only::NO"]?.llmYesOdds, 27);
  assert.equal(nextAnalyses["title-only::NO"]?.llmNoOdds, 73);
  assert.equal(nextAnalyses["title-only::NO"]?.llmRecoveryMatchMethod, "title");
});

test("Bullpen auto-run sync marks duplicate title-only matches as ambiguous", async () => {
  const { syncBullpenAutoRunActivePositionAnalyses } =
    await loadBullpenAutoRunSyncModule();

  const nextAnalyses = syncBullpenAutoRunActivePositionAnalyses({
    currentAnalyses: {},
    activePositions: [
      createActivePosition({
        key: "dup-a::NO",
        marketId: "market-a",
        slug: null,
        marketUrl: null,
        marketTitle: "Shared duplicate title",
      }),
      createActivePosition({
        key: "dup-b::NO",
        marketId: "market-b",
        slug: null,
        marketUrl: null,
        marketTitle: "Shared duplicate title",
      }),
    ],
    run: createRun({
      reviewedCandidates: [
        createReviewedCandidate({
          source_kind: "active_position",
          position_key: null,
          market_id: null,
          slug: null,
          market_url: null,
          question: "Shared duplicate title",
          fair_yes_probability_pct: null,
          fair_no_probability_pct: null,
          llm_outputs: [
            {
              provider: "openai",
              model: "gpt-4.1-mini",
              llm_yes_odds: 41,
              llm_no_odds: 59,
              completed_at: "2026-07-17T17:49:33+05:30",
            },
          ],
        }),
      ],
    }),
  });

  assert.equal(nextAnalyses["dup-a::NO"]?.llmRecoveryStatus, "ambiguous");
  assert.equal(nextAnalyses["dup-b::NO"]?.llmRecoveryStatus, "ambiguous");
  assert.equal(nextAnalyses["dup-a::NO"]?.llmYesOdds, null);
  assert.equal(nextAnalyses["dup-b::NO"]?.llmNoOdds, null);
});

test("Bullpen auto-run sync keeps older valid odds when a newer matched analysis is blank", async () => {
  const { syncBullpenAutoRunActivePositionAnalyses } =
    await loadBullpenAutoRunSyncModule();

  const currentAnalyses = {
    "market-1::NO": {
      llmYesOdds: 21,
      llmNoOdds: 79,
      llmAverageYesOdds: 21,
      llmMedianYesOdds: 21,
      llmTrimmedMeanYesOdds: 21,
      llmIqrYesOdds: 0,
      llmTrimmedRangeYesOdds: 0,
      llmMinYesOdds: 21,
      llmMaxYesOdds: 21,
      llmSpreadYesOdds: 0,
      llmDisagreementCategory: "CONSENSUS",
      llmDisagreementLevel: "Low",
      llmRationaleMismatchCount: 0,
      adjudicationRequired: false,
      evidenceStatus: "Strong",
      eventState: "Watching",
      llmNotes: "Older valid odds.",
      llmProvider: "openai",
      llmModel: "gpt-4o-mini",
      llmRunId: "older-run",
      llmCompletedAt: "2026-07-16T12:00:00Z",
      preflightEvidenceBlock: null,
      llmBreakdown: [],
      llmRecoveryStatus: null,
      llmRecoverySource: null,
      llmRecoveryMatchMethod: null,
      llmRecoveryRunId: null,
      llmRecoveryReason: null,
    },
  };

  const nextAnalyses = syncBullpenAutoRunActivePositionAnalyses({
    currentAnalyses,
    activePositions: [createActivePosition()],
    run: createRun({
      reviewedCandidates: [
        createReviewedCandidate({
          source_kind: "active_position",
          position_key: "market-1::NO",
          fair_yes_probability_pct: null,
          fair_no_probability_pct: null,
          llm_outputs: [],
          llm_error: "Latest run returned no usable model outputs.",
        }),
      ],
    }),
  });

  assert.equal(nextAnalyses["market-1::NO"]?.llmYesOdds, 21);
  assert.equal(nextAnalyses["market-1::NO"]?.llmNoOdds, 79);
  assert.equal(
    nextAnalyses["market-1::NO"]?.llmRecoveryStatus,
    "last-known-good/stale",
  );
});

test("Bullpen auto-run sync reconciliation is idempotent", async () => {
  const { syncBullpenAutoRunActivePositionAnalyses } =
    await loadBullpenAutoRunSyncModule();

  const run = createRun({
    runId: "run-idempotent",
    reviewedCandidates: [
      createReviewedCandidate({
        source_kind: "active_position",
        position_key: "market-1::NO",
        fair_yes_probability_pct: null,
        fair_no_probability_pct: null,
        llm_outputs: [
          {
            provider: "openai",
            model: "gpt-4.1",
            llm_yes_odds: 19,
            llm_no_odds: 81,
            completed_at: "2026-07-17T17:49:33+05:30",
          },
        ],
      }),
    ],
  });

  const first = syncBullpenAutoRunActivePositionAnalyses({
    currentAnalyses: {},
    activePositions: [createActivePosition()],
    run,
  });
  const second = syncBullpenAutoRunActivePositionAnalyses({
    currentAnalyses: first,
    activePositions: [createActivePosition()],
    run,
  });

  assert.deepEqual(second, first);
});

test("Bullpen auto-run sync rebuilds Auto Scan from Stage 2 when compact Stage 1 rows are absent", async () => {
  const { syncBullpenAutoRunSummarySnapshots } =
    await loadBullpenAutoRunSyncModule();

  const run = createRun({
    acceptedCandidates: [],
    reviewedCandidates: [
      createReviewedCandidate({
        source_kind: "candidate",
        question_id: "question-1",
        slug: "market-1",
        current_yes_odds: 46,
        current_no_odds: 54,
      }),
    ],
  });
  run.stage_results[0].outputs.scanned_candidates = 44;

  const nextSnapshots = syncBullpenAutoRunSummarySnapshots({
    snapshotsByMode: createEmptySnapshots(),
    summary: { recent_decisions: [] },
    run,
  });

  assert.equal(nextSnapshots["30-days"].current?.totalCandidates, 44);
  assert.equal(nextSnapshots["30-days"].current?.questions.length, 1);
  assert.equal(
    nextSnapshots["30-days"].current?.questions[0]?.llmNoOdds,
    88,
  );
});


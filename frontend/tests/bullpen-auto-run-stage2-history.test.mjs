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

async function loadStageTwoHistoryModule() {
  const tempDir = mkdtempSync(path.join(tmpdir(), "bullpen-stage2-history-"));

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

  const historySource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/bullpenAutoRunStageTwoHistory.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const rewrittenHistorySource = transpileModuleSource(
    historySource,
    "bullpenAutoRunStageTwoHistory.ts",
  ).replace(
    'from "@/lib/bullpen-ai";',
    `from ${JSON.stringify(pathToFileURL(bullpenAiPath).href)};`,
  );
  const historyModulePath = path.join(tempDir, "bullpenAutoRunStageTwoHistory.mjs");
  writeFileSync(historyModulePath, rewrittenHistorySource, "utf8");

  return import(`${pathToFileURL(historyModulePath).href}?t=${Date.now()}`);
}

function createFutureCloseTime(days = 5) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

const HISTORICAL_AS_OF = "2026-07-16T18:45:07Z";
const HISTORICAL_CLOSE_TIME = "2026-07-20T18:45:07Z";

function createScanCandidate(overrides = {}) {
  return {
    questionId: "question-1",
    marketId: "market-1",
    question: "Will event one happen?",
    marketUrl: "https://example.com/market-1",
    slug: "market-1",
    closeTime: createFutureCloseTime(),
    theme: "Politics",
    currentYesOdds: 54,
    currentNoOdds: 46,
    volumeUsd: 123456,
    liquidityUsd: 7890,
    forceInclude: false,
    ...overrides,
  };
}

function createReviewedRow(overrides = {}) {
  return {
    market_id: "market-1",
    question_id: "question-1",
    question: "Will event one happen?",
    market_url: "https://example.com/market-1",
    slug: "market-1",
    close_time: createFutureCloseTime(),
    returns_per_day: 40,
    fair_yes_probability_pct: 88,
    fair_no_probability_pct: 12,
    disagreement_level: "Low",
    disagreement_category: "CONSENSUS",
    adjudication_required: false,
    confidence: "High",
    evidence_status: "Strong",
    event_state: "scheduled",
    reason: "LLM consensus completed for the candidate market.",
    llm_outputs: [
      {
        provider: "gemini",
        model: "gemini-2.5-flash",
        error: "Provider returned no usable probability.",
        completed_at: "2026-07-16T12:00:00Z",
      },
      {
        provider: "openai",
        model: "gpt-4o-mini",
        llm_yes_odds: 88,
        llm_no_odds: 12,
        confidence: "High",
        evidence_status: "Strong",
        event_state: "scheduled",
        rationale: "Evidence strongly favors YES.",
        completed_at: "2026-07-16T12:00:00Z",
      },
    ],
    ...overrides,
  };
}

function createStage(outputs) {
  return {
    outputs,
  };
}

test("Stage 2 historical summary rows rebuild consensus from persisted event data", async () => {
  const historyModule = await loadStageTwoHistoryModule();
  const reviewedRows = historyModule.getStageTwoLlmReviewedRows(
    createStage({
      llm_reviewed_candidates: [
        createReviewedRow({ close_time: HISTORICAL_CLOSE_TIME }),
      ],
    }),
    [createScanCandidate({ closeTime: HISTORICAL_CLOSE_TIME })],
  );

  const rows = historyModule.buildStageTwoEventsSummaryRows({
    reviewedRows,
    decisions: [],
    runId: "run-1",
    asOfTimestamp: HISTORICAL_AS_OF,
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].question, "Will event one happen?");
  assert.equal(rows[0].marketId, "market-1");
  assert.equal(rows[0].questionId, "question-1");
  assert.equal(rows[0].category, "Politics");
  assert.equal(rows[0].yesOdds, 54);
  assert.equal(rows[0].noOdds, 46);
  assert.equal(rows[0].llmYesOdds, 88);
  assert.equal(rows[0].llmNoOdds, 12);
  assert.equal(rows[0].returnsPerDay, 11.5);
  assert.equal(rows[0].amountToBeInvested, 5);
  assert.equal(rows[0].volume, "123,456");
  assert.equal(rows[0].liquidity, "7,890");
  assert.equal(rows[0].llmBreakdown.length, 2);
  assert.equal(rows[0].llmRunId, "run-1");
});

test("Stage 2 historical LLM rows dedupe duplicate target-run outputs and retain cost metadata", async () => {
  const historyModule = await loadStageTwoHistoryModule();
  const reviewedRows = historyModule.getStageTwoLlmReviewedRows(
    createStage({
      llm_reviewed_candidates: [createReviewedRow()],
      llm_target_runs: [
        {
          provider: "openai",
          model: "gpt-4o-mini",
          estimated_cost: 0.03,
          event_outputs: [
            {
              market_id: "market-1",
              question_id: "question-1",
              output: {
                provider: "openai",
                model: "gpt-4o-mini",
                llm_yes_odds: 88,
                llm_no_odds: 12,
                completed_at: "2026-07-16T12:00:00Z",
              },
            },
          ],
        },
        {
          provider: "gemini",
          model: "gemini-2.5-flash",
          estimated_cost: 0.01,
          event_outputs: [
            {
              market_id: "market-1",
              question_id: "question-1",
              output: {
                provider: "gemini",
                model: "gemini-2.5-flash",
                error: "Provider returned no usable probability.",
                completed_at: "2026-07-16T12:00:00Z",
              },
            },
          ],
        },
      ],
    }),
    [createScanCandidate()],
  );

  assert.equal(reviewedRows.length, 1);
  assert.equal(reviewedRows[0].llm_outputs.length, 2);

  const tableRows = historyModule.getStageTwoLlmTableRows({
    reviewedRows,
    decisions: [],
  });
  assert.equal(tableRows.length, 2);

  const openAiRow = tableRows.find(
    (row) => row.provider === "openai" && row.model === "gpt-4o-mini",
  );
  assert.ok(openAiRow);
  assert.equal(openAiRow.yesOdds, 88);
  assert.equal(openAiRow.noOdds, 12);
  assert.equal(openAiRow.output.estimated_cost, 0.03);

  const geminiRow = tableRows.find(
    (row) =>
      row.provider === "gemini" && row.model === "gemini-2.5-flash",
  );
  assert.ok(geminiRow);
  assert.equal(geminiRow.output.error, "Provider returned no usable probability.");
});

test("Stage 2 historical rows treat missing provider/model identity as a data-integrity error", async () => {
  const historyModule = await loadStageTwoHistoryModule();
  const reviewedRows = historyModule.getStageTwoLlmReviewedRows(
    createStage({
      llm_target_runs: [
        {
          status: "completed",
          event_outputs: [
            {
              market_id: "market-1",
              question_id: "question-1",
              output: {
                yes_odds: 88,
                no_odds: 12,
                completed_at: HISTORICAL_AS_OF,
              },
            },
          ],
        },
      ],
    }),
    [createScanCandidate()],
  );

  const rows = historyModule.buildStageTwoEventsSummaryRows({
    reviewedRows,
    decisions: [],
    runId: "run-integrity",
    asOfTimestamp: HISTORICAL_AS_OF,
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].llmYesOdds, null);
  assert.equal(rows[0].llmNoOdds, null);
  assert.equal(
    rows[0].llmBreakdown[0].invalidReason,
    "Data integrity error: Stage 2 recorded an LLM output without a provider/model identity.",
  );
});

test("Stage 2 historical summary rows normalize yes_odds/no_odds aliases into canonical odds and money fields", async () => {
  const historyModule = await loadStageTwoHistoryModule();
  const reviewedRows = historyModule.getStageTwoLlmReviewedRows(
    createStage({
      llm_target_runs: [
        {
          provider: "openai",
          model: "gpt-4o-mini",
          event_outputs: [
            {
              market_id: "market-1",
              question_id: "question-1",
              output: {
                provider: "openai",
                model: "gpt-4o-mini",
                yes_odds: 12.5,
                no_odds: 87.5,
                completed_at: HISTORICAL_AS_OF,
              },
            },
          ],
        },
      ],
    }),
    [
      createScanCandidate({
        closeTime: "2026-07-18T11:33:07Z",
        currentYesOdds: 19.5,
        currentNoOdds: 80.5,
      }),
    ],
  );

  const rows = historyModule.buildStageTwoEventsSummaryRows({
    reviewedRows,
    decisions: [],
    runId: "run-aliases",
    asOfTimestamp: HISTORICAL_AS_OF,
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].llmYesOdds, 12.5);
  assert.equal(rows[0].llmNoOdds, 87.5);
  assert.equal(rows[0].returnsPerDay, 11.47);
  assert.equal(rows[0].amountToBeInvested, 5);
  assert.equal(rows[0].isAmountToBeInvestedHighlighted, true);
  assert.equal(rows[0].llmBreakdown[0].invalidReason, null);
});

test("Stage 2 historical summary rows build consensus from completed and partial outputs without letting failures blank valid rows", async () => {
  const historyModule = await loadStageTwoHistoryModule();
  const reviewedRows = historyModule.getStageTwoLlmReviewedRows(
    createStage({
      llm_target_runs: [
        {
          provider: "openai",
          model: "gpt-4o-mini",
          status: "completed",
          event_outputs: [
            {
              market_id: "market-1",
              question_id: "question-1",
              output: {
                provider: "openai",
                model: "gpt-4o-mini",
                yes_odds: 88,
                no_odds: 12,
                completed_at: HISTORICAL_AS_OF,
              },
            },
          ],
        },
        {
          provider: "anthropic",
          model: "claude-3.5-sonnet",
          status: "completed",
          event_outputs: [
            {
              market_id: "market-1",
              question_id: "question-1",
              output: {
                provider: "anthropic",
                model: "claude-3.5-sonnet",
                yesProbability: 86,
                noProbability: 14,
                completed_at: HISTORICAL_AS_OF,
              },
            },
          ],
        },
        {
          provider: "gemini",
          model: "gemini-2.5-flash",
          status: "completed",
          event_outputs: [
            {
              market_id: "market-1",
              question_id: "question-1",
              output: {
                provider: "gemini",
                model: "gemini-2.5-flash",
                probability_yes: 84,
                probability_no: 16,
                completed_at: HISTORICAL_AS_OF,
              },
            },
          ],
        },
        {
          provider: "deepseek",
          model: "deepseek-chat",
          status: "completed",
          event_outputs: [
            {
              market_id: "market-1",
              question_id: "question-1",
              output: {
                provider: "deepseek",
                model: "deepseek-chat",
                probabilityYes: 82,
                probabilityNo: 18,
                completed_at: HISTORICAL_AS_OF,
              },
            },
          ],
        },
        {
          provider: "openai",
          model: "gpt-4.1-mini",
          status: "partial",
          event_outputs: [
            {
              market_id: "market-1",
              question_id: "question-1",
              output: {
                provider: "openai",
                model: "gpt-4.1-mini",
                yesOdds: 80,
                noOdds: 20,
                completed_at: HISTORICAL_AS_OF,
              },
            },
          ],
        },
        ...["fail-1", "fail-2", "fail-3", "fail-4"].map((model) => ({
          provider: "failed-provider",
          model,
          status: "failed",
          event_outputs: [
            {
              market_id: "market-1",
              question_id: "question-1",
              output: {
                provider: "failed-provider",
                model,
                error: "Provider returned no usable probability.",
                completed_at: HISTORICAL_AS_OF,
              },
            },
          ],
        })),
      ],
    }),
    [
      createScanCandidate({
        closeTime: HISTORICAL_CLOSE_TIME,
        currentYesOdds: 60,
        currentNoOdds: 40,
      }),
    ],
  );

  const rows = historyModule.buildStageTwoEventsSummaryRows({
    reviewedRows,
    decisions: [],
    runId: "run-partial",
    asOfTimestamp: HISTORICAL_AS_OF,
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].llmBreakdown.length, 9);
  assert.equal(
    rows[0].llmBreakdown.filter((entry) => entry.invalidReason).length,
    4,
  );
  assert.equal(rows[0].llmYesOdds, 84);
  assert.equal(rows[0].llmNoOdds, 16);
  assert.equal(rows[0].returnsPerDay, 10);
  assert.equal(rows[0].amountToBeInvested, 5);
  assert.equal(rows[0].isAmountToBeInvestedHighlighted, true);
});

test("Stage 2 historical target-run rows keep provider errors and invalid JSON attributed to the correct model", async () => {
  const historyModule = await loadStageTwoHistoryModule();
  const reviewedRows = historyModule.getStageTwoLlmReviewedRows(
    createStage({
      llm_target_runs: [
        {
          provider: "deepseek",
          model: "deepseek-reasoner",
          status: "failed",
          event_outputs: [
            {
              market_id: "market-1",
              question_id: "question-1",
              output: {
                provider: "deepseek",
                model: "deepseek-reasoner",
                error: "Provider timeout",
                completed_at: HISTORICAL_AS_OF,
              },
            },
          ],
        },
        {
          provider: "deepseek",
          model: "deepseek-chat",
          status: "failed",
          event_outputs: [
            {
              market_id: "market-1",
              question_id: "question-1",
              output: {
                provider: "deepseek",
                model: "deepseek-chat",
                invalid_reason: "LLM response was not valid JSON.",
                completed_at: HISTORICAL_AS_OF,
              },
            },
          ],
        },
      ],
    }),
    [createScanCandidate()],
  );

  const tableRows = historyModule.getStageTwoLlmTableRows({
    reviewedRows,
    decisions: [],
  });

  const providerFailureRow = tableRows.find(
    (row) =>
      row.provider === "deepseek" && row.model === "deepseek-reasoner",
  );
  const invalidJsonRow = tableRows.find(
    (row) => row.provider === "deepseek" && row.model === "deepseek-chat",
  );

  assert.ok(providerFailureRow);
  assert.equal(providerFailureRow.output.error, "Provider timeout");
  assert.ok(invalidJsonRow);
  assert.equal(
    invalidJsonRow.output.invalid_reason,
    "LLM response was not valid JSON.",
  );
});

test("Stage 2 historical rows match target outputs by stable IDs instead of array position", async () => {
  const historyModule = await loadStageTwoHistoryModule();
  const reviewedRows = historyModule.getStageTwoLlmReviewedRows(
    createStage({
      llm_target_runs: [
        {
          provider: "openai",
          model: "gpt-4o-mini",
          event_outputs: [
            {
              slug: "market-b",
              market_url: "https://example.com/market-b",
              output: {
                provider: "openai",
                model: "gpt-4o-mini",
                yes_odds: 22,
                no_odds: 78,
                slug: "market-b",
                market_url: "https://example.com/market-b",
                completed_at: HISTORICAL_AS_OF,
              },
            },
            {
              question_id: "question-1",
              output: {
                provider: "openai",
                model: "gpt-4o-mini",
                yes_odds: 78,
                no_odds: 22,
                question_id: "question-1",
                completed_at: HISTORICAL_AS_OF,
              },
            },
          ],
        },
      ],
    }),
    [
      createScanCandidate({
        questionId: "question-1",
        marketId: "market-1",
        question: "Will event one happen?",
        marketUrl: "https://example.com/market-1",
        slug: "market-1",
      }),
      createScanCandidate({
        questionId: "question-2",
        marketId: "market-2",
        question: "Will event two happen?",
        marketUrl: "https://example.com/market-b",
        slug: "market-b",
      }),
    ],
  );

  const rows = historyModule.buildStageTwoEventsSummaryRows({
    reviewedRows,
    decisions: [],
    runId: "run-stable-ids",
    asOfTimestamp: HISTORICAL_AS_OF,
  });

  const eventOne = rows.find((row) => row.question === "Will event one happen?");
  const eventTwo = rows.find((row) => row.question === "Will event two happen?");

  assert.ok(eventOne);
  assert.ok(eventTwo);
  assert.equal(eventOne.llmYesOdds, 78);
  assert.equal(eventTwo.llmYesOdds, 22);
  assert.equal(eventOne.id, "question-1");
  assert.equal(eventTwo.id, "question-2");
});

test("completed historical runs keep days left and money fields stable regardless of the current date", async () => {
  const historyModule = await loadStageTwoHistoryModule();
  const reviewedRows = historyModule.getStageTwoLlmReviewedRows(
    createStage({
      llm_target_runs: [
        {
          provider: "openai",
          model: "gpt-4o-mini",
          event_outputs: [
            {
              market_id: "market-1",
              question_id: "question-1",
              output: {
                provider: "openai",
                model: "gpt-4o-mini",
                yes_odds: 12.5,
                no_odds: 87.5,
                completed_at: "2026-07-16T12:05:00Z",
              },
            },
          ],
        },
      ],
    }),
    [
      createScanCandidate({
        closeTime: "2026-07-18T12:00:00Z",
        currentYesOdds: 19.5,
        currentNoOdds: 80.5,
      }),
    ],
  );

  const originalNow = Date.now;
  try {
    Date.now = () => Date.parse("2026-07-16T12:30:00Z");
    const asOfOne = historyModule.resolveStageTwoHistoricalAsOfTimestamp({
      reviewedRows,
      scanCompletedAt: "2026-07-16T12:00:00Z",
      stageCompletedAt: "2026-07-16T12:05:00Z",
      runStartedAt: "2026-07-16T11:45:00Z",
      runCompletedAt: "2026-07-16T12:06:00Z",
      nowMs: Date.now(),
    });
    const firstBuild = historyModule.buildStageTwoEventsSummaryRows({
      reviewedRows,
      decisions: [],
      runId: "run-historical-stable",
      asOfTimestamp: asOfOne,
    });

    Date.now = () => Date.parse("2026-08-20T12:30:00Z");
    const asOfTwo = historyModule.resolveStageTwoHistoricalAsOfTimestamp({
      reviewedRows,
      scanCompletedAt: "2026-07-16T12:00:00Z",
      stageCompletedAt: "2026-07-16T12:05:00Z",
      runStartedAt: "2026-07-16T11:45:00Z",
      runCompletedAt: "2026-07-16T12:06:00Z",
      nowMs: Date.now(),
    });
    const secondBuild = historyModule.buildStageTwoEventsSummaryRows({
      reviewedRows,
      decisions: [],
      runId: "run-historical-stable",
      asOfTimestamp: asOfTwo,
    });

    assert.equal(asOfOne, "2026-07-16T12:00:00.000Z");
    assert.equal(asOfTwo, "2026-07-16T12:00:00.000Z");
    assert.equal(firstBuild[0].daysUntilClose, secondBuild[0].daysUntilClose);
    assert.equal(firstBuild[0].returnsPerDay, secondBuild[0].returnsPerDay);
    assert.equal(
      firstBuild[0].amountToBeInvested,
      secondBuild[0].amountToBeInvested,
    );
  } finally {
    Date.now = originalNow;
  }
});

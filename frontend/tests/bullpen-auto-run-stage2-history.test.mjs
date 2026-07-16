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
      llm_reviewed_candidates: [createReviewedRow()],
    }),
    [createScanCandidate()],
  );

  const rows = historyModule.buildStageTwoEventsSummaryRows({
    reviewedRows,
    decisions: [],
    runId: "run-1",
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].question, "Will event one happen?");
  assert.equal(rows[0].category, "Politics");
  assert.equal(rows[0].yesOdds, 54);
  assert.equal(rows[0].noOdds, 46);
  assert.equal(rows[0].llmYesOdds, 88);
  assert.equal(rows[0].llmNoOdds, 12);
  assert.equal(rows[0].returnsPerDay, 40);
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

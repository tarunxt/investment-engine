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

async function loadHistoricalAssessmentModule() {
  const tempDir = mkdtempSync(path.join(tmpdir(), "bullpen-historical-"));

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
  writeFileSync(
    resolverPath,
    transpileModuleSource(
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
      ),
    "utf8",
  );

  const historicalSource = readFileSync(
    new URL("../lib/bullpenHistoricalAssessment.ts", import.meta.url),
    "utf8",
  );
  const historicalPath = path.join(tempDir, "bullpenHistoricalAssessment.mjs");
  writeFileSync(
    historicalPath,
    transpileModuleSource(
      historicalSource,
      "bullpenHistoricalAssessment.ts",
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
      ),
    "utf8",
  );

  return import(`${pathToFileURL(historicalPath).href}?t=${Date.now()}`);
}

function createRun(reviewedCandidates) {
  return {
    id: "run-history-1",
    started_at: "2026-07-17T12:00:00Z",
    completed_at: "2026-07-17T12:20:00Z",
    stage_results: [
      {
        stage_number: 2,
        outputs: {
          llm_reviewed_candidates: reviewedCandidates,
        },
      },
    ],
  };
}

test("historical assessment matches Stage 2 rows by canonicalized URL without a decision", async () => {
  const { buildBullpenHistoricalAssessmentRows } =
    await loadHistoricalAssessmentModule();

  const rows = buildBullpenHistoricalAssessmentRows({
    question: {
      id: "question-1",
      question: "Will event one happen?",
      questionId: "question-1",
      marketId: "market-1",
      slug: null,
      marketUrl: "https://polymarket.com/event/event-one/",
      sourceUrl: "https://polymarket.com/event/event-one/",
      llmBreakdown: [],
      llmRunId: null,
      llmCompletedAt: null,
    },
    runs: [
      createRun([
        {
          market_url: "https://www.polymarket.com/event/event-one?utm_source=test#view",
          question: "Different title",
          llm_outputs: [
            {
              provider: "openai",
              model: "gpt-4.1",
              llm_yes_odds: 23,
              llm_no_odds: 77,
              completed_at: "2026-07-17T17:49:33+05:30",
            },
          ],
        },
      ]),
    ],
    decisions: [],
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.llmYesOdds, 23);
  assert.equal(rows[0]?.llmNoOdds, 77);
  assert.equal(rows[0]?.source, "auto-live-run");
});

test("historical assessment rejects ambiguous title-only matches", async () => {
  const { buildBullpenHistoricalAssessmentRows } =
    await loadHistoricalAssessmentModule();

  const rows = buildBullpenHistoricalAssessmentRows({
    position: {
      key: "title-only::NO",
      marketId: "position-only-id",
      slug: null,
      conditionId: null,
      marketTitle: "Shared duplicate title",
      outcome: "NO",
      shares: 1,
      averagePrice: 0.5,
      costBasis: 0.5,
      yesOdds: 50,
      noOdds: 50,
      bestBidPrice: null,
      bestAskPrice: null,
      currentPrice: 0.5,
      currentValue: 0.5,
      expectedPayoutUsd: null,
      unrealizedPnl: 0,
      unrealizedPnlPercent: 0,
      marketUrl: null,
      closeTime: null,
      resolutionStatus: "open",
      economicClassification: "active",
      classificationReason: "Open active position.",
      isClaimable: false,
      claimableValue: null,
      returnsPerDay: null,
      rules: null,
      marketContext: null,
      resolutionSource: null,
    },
    runs: [
      createRun([
        {
          question: "Shared duplicate title",
          llm_outputs: [
            {
              provider: "openai",
              model: "gpt-4.1",
              llm_yes_odds: 40,
              llm_no_odds: 60,
              completed_at: "2026-07-17T17:49:33+05:30",
            },
          ],
        },
        {
          question: "Shared duplicate title",
          llm_outputs: [
            {
              provider: "anthropic",
              model: "claude-sonnet",
              llm_yes_odds: 55,
              llm_no_odds: 45,
              completed_at: "2026-07-17T17:49:33+05:30",
            },
          ],
        },
      ]),
    ],
    decisions: [],
  });

  assert.equal(rows.length, 0);
});

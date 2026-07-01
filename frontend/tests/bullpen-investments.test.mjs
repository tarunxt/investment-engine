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

async function loadBullpenInvestmentsModule() {
  const tempDir = mkdtempSync(path.join(tmpdir(), "bullpen-investments-"));

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

  const bullpenEventExitsSource = readFileSync(
    new URL("../lib/bullpenEventExits.ts", import.meta.url),
    "utf8",
  );
  const bullpenEventExitsPath = path.join(tempDir, "bullpenEventExits.mjs");
  writeFileSync(
    bullpenEventExitsPath,
    transpileModuleSource(bullpenEventExitsSource, "bullpenEventExits.ts")
      .replace(
        'from "@/lib/bullpen-ai";',
        `from ${JSON.stringify(pathToFileURL(bullpenAiPath).href)};`,
      )
      .replace(
        'from "@/lib/bullpenPositions";',
        `from ${JSON.stringify(pathToFileURL(bullpenPositionsPath).href)};`,
      ),
    "utf8",
  );

  const investmentsSource = readFileSync(
    new URL("../lib/bullpenInvestments.ts", import.meta.url),
    "utf8",
  );
  const rewrittenInvestmentsSource = transpileModuleSource(
    investmentsSource,
    "bullpenInvestments.ts",
  )
    .replace(
      'from "@/lib/bullpen-ai";',
      `from ${JSON.stringify(pathToFileURL(bullpenAiPath).href)};`,
    )
    .replace(
      'from "@/lib/bullpenPositions";',
      `from ${JSON.stringify(pathToFileURL(bullpenPositionsPath).href)};`,
    )
    .replace(
      'from "@/lib/bullpenEventExits";',
      `from ${JSON.stringify(pathToFileURL(bullpenEventExitsPath).href)};`,
    );
  const investmentsModulePath = path.join(tempDir, "bullpenInvestments.mjs");
  writeFileSync(investmentsModulePath, rewrittenInvestmentsSource, "utf8");

  return import(`${pathToFileURL(investmentsModulePath).href}?t=${Date.now()}`);
}

function createActivePosition({
  key,
  marketTitle,
  returnsPerDay,
}) {
  return {
    key,
    marketId: key,
    conditionId: null,
    marketTitle,
    outcome: "No",
    heldSide: "NO",
    shares: 5,
    averagePrice: 0.2,
    costBasis: 1,
    yesOdds: 80,
    noOdds: 20,
    bestBidPrice: 0.2,
    bestAskPrice: 0.8,
    currentPrice: 0.2,
    currentValue: 1,
    unrealizedPnl: 0,
    unrealizedPnlPercent: 0,
    marketUrl: `https://example.com/${key}`,
    closeTime: "2026-07-20T03:59:59.999Z",
    isClaimable: false,
    claimableValue: null,
    returnsPerDay,
    rules: null,
    marketContext: null,
    resolutionSource: null,
  };
}

function createQuestion({
  id,
  question,
  returnsPerDay,
  llmYesOdds,
  llmNoOdds,
  amountToBeInvested = 5,
}) {
  return {
    id,
    question,
    closeTime: "2026-07-20T03:59:59.999Z",
    category: "AI",
    yesOdds: 40,
    noOdds: 60,
    currentOddsUpdatedAt: null,
    investmentTableAddedAt: null,
    volume: "$10,000",
    liquidity: "$5,000",
    sourceUrl: "https://example.com/source",
    slug: id,
    marketUrl: `https://example.com/${id}`,
    outcomeLabels: ["Yes", "No"],
    outcomeCount: 2,
    isBinaryYesNo: true,
    daysUntilClose: 7,
    rules: null,
    marketContext: null,
    resolutionSource: null,
    llmYesOdds,
    llmNoOdds,
    llmAverageYesOdds: llmYesOdds,
    llmMedianYesOdds: llmYesOdds,
    llmTrimmedMeanYesOdds: llmYesOdds,
    llmIqrYesOdds: null,
    llmTrimmedRangeYesOdds: null,
    llmMinYesOdds: llmYesOdds,
    llmMaxYesOdds: llmYesOdds,
    llmSpreadYesOdds: 0,
    llmDisagreementLevel: "Low",
    llmDisagreementCategory: "CONSENSUS",
    llmRationaleMismatchCount: 0,
    adjudicationRequired: false,
    evidenceStatus: "scheduled_not_occurred",
    eventState: "scheduled_not_occurred",
    currentVsLlmOddsDifference: null,
    returnsPerDay,
    amountToBeInvested,
    isAmountToBeInvestedHighlighted: true,
    llmNotes: null,
    llmProvider: "openai",
    llmModel: "gpt-4o-mini",
    llmRunId: null,
    llmCompletedAt: null,
    llmBreakdown: [],
  };
}

test("Bullpen investment display excludes attention positions from green rows without leaving duplicates", async () => {
  const { buildBullpenInvestmentDisplay } =
    await loadBullpenInvestmentsModule();

  const weakLlmActive = createActivePosition({
    key: "active-weak-llm",
    marketTitle: "Will Claude Fable 5 be restored by July 2?",
    returnsPerDay: 196,
  });
  const strongIncludedActive = createActivePosition({
    key: "active-strong-included",
    marketTitle: "Strong active position inside top table",
    returnsPerDay: 95,
  });
  const strongOutsideTopTenActive = createActivePosition({
    key: "active-strong-outside-top-ten",
    marketTitle: "Strong active position outside top table",
    returnsPerDay: 7,
  });

  const activePositionQuestions = [
    createQuestion({
      id: weakLlmActive.key,
      question: weakLlmActive.marketTitle,
      returnsPerDay: weakLlmActive.returnsPerDay,
      llmYesOdds: 50,
      llmNoOdds: 50,
      amountToBeInvested: null,
    }),
    createQuestion({
      id: strongIncludedActive.key,
      question: strongIncludedActive.marketTitle,
      returnsPerDay: strongIncludedActive.returnsPerDay,
      llmYesOdds: 9.2,
      llmNoOdds: 90.8,
    }),
    createQuestion({
      id: strongOutsideTopTenActive.key,
      question: strongOutsideTopTenActive.marketTitle,
      returnsPerDay: strongOutsideTopTenActive.returnsPerDay,
      llmYesOdds: 12,
      llmNoOdds: 88,
    }),
  ];

  const candidates = Array.from({ length: 10 }, (_, index) =>
    createQuestion({
      id: `candidate-${index + 1}`,
      question: `Candidate ${index + 1}`,
      returnsPerDay: 100 - index,
      llmYesOdds: 85,
      llmNoOdds: 15,
    }),
  );

  const display = buildBullpenInvestmentDisplay({
    activePositions: [
      weakLlmActive,
      strongIncludedActive,
      strongOutsideTopTenActive,
    ],
    activePositionQuestions,
    candidates,
  });

  const topRowKeys = display.topInvestmentRows.map((row) => row.key);
  const attentionByKey = new Map(
    display.activePositionsNeedingAttention.map((entry) => [
      entry.position.key,
      entry.reasonBadges,
    ]),
  );

  assert.equal(display.topInvestmentRows.length, 10);
  assert.equal(topRowKeys.includes(weakLlmActive.key), false);
  assert.equal(topRowKeys.includes(strongIncludedActive.key), true);
  assert.equal(topRowKeys.includes(strongOutsideTopTenActive.key), false);
  assert.deepEqual(attentionByKey.get(weakLlmActive.key), [
    "LLM Filter",
  ]);
  assert.deepEqual(attentionByKey.get(strongOutsideTopTenActive.key), [
    "Outside Top 10",
  ]);
  assert.equal(attentionByKey.has(strongIncludedActive.key), false);
  assert.equal(display.eventExitCounts.total, 2);
  assert.equal(display.watchFastPositionKeys.size, 0);

  for (const [positionKey] of attentionByKey) {
    assert.equal(topRowKeys.includes(positionKey), false);
  }
});

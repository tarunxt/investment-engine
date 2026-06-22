import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

async function loadBullpenAiModule() {
  const source = readFileSync(
    new URL("../lib/bullpen-ai.ts", import.meta.url),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: "bullpen-ai.ts",
  });

  return import(
    `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
  );
}

function createQuestionRow() {
  return {
    id: "Q1",
    question: "Will candidate X win?",
    closeTime: "2026-06-30T23:59:00Z",
    category: "Politics",
    yesOdds: 44,
    noOdds: 56,
    volume: "$10,000",
    liquidity: "$5,000",
    sourceUrl: "https://example.com/source",
    slug: "candidate-x-win",
    marketUrl: "https://polymarket.com/event/candidate-x-win",
    outcomeLabels: ["Yes", "No"],
    outcomeCount: 2,
    isBinaryYesNo: true,
    daysUntilClose: 9,
    llmYesOdds: 55,
    llmNoOdds: 45,
    llmAverageYesOdds: 55,
    llmMedianYesOdds: 55,
    llmTrimmedMeanYesOdds: 55,
    llmMinYesOdds: 55,
    llmMaxYesOdds: 55,
    llmSpreadYesOdds: 0,
    llmDisagreementLevel: "Low",
    adjudicationRequired: false,
    evidenceStatus: "scheduled_not_occurred",
    eventState: "scheduled_not_occurred",
    currentVsLlmOddsDifference: -11,
    returnsPerDay: 6.22,
    amountToBeInvested: 15.5,
    isAmountToBeInvestedHighlighted: true,
    llmNotes: "Prompt compatibility test.",
    llmProvider: "openai",
    llmModel: "gpt-4o-mini",
    llmRunId: null,
    llmCompletedAt: null,
    llmBreakdown: [],
  };
}

test("Bullpen x AI prompt builder still supports default and legacy prompt templates", async () => {
  const {
    buildBullpenLlmPrompt,
    DEFAULT_BULLPEN_LLM_PROMPT_TEMPLATE,
    LEGACY_BULLPEN_LLM_PROMPT_TEMPLATES,
  } = await loadBullpenAiModule();

  const questionRow = createQuestionRow();
  const defaultPrompt = buildBullpenLlmPrompt([questionRow]);
  const legacyPrompt = buildBullpenLlmPrompt(
    [questionRow],
    LEGACY_BULLPEN_LLM_PROMPT_TEMPLATES[0],
  );

  assert.match(defaultPrompt, /Selected questions:/);
  assert.match(defaultPrompt, /"question_ref": "Q1"/);
  assert.match(defaultPrompt, /"current_yes_odds": 44/);
  assert.match(defaultPrompt, /"current_no_odds": 56/);
  assert.notEqual(defaultPrompt, DEFAULT_BULLPEN_LLM_PROMPT_TEMPLATE.trim());

  assert.match(legacyPrompt, /Selected questions:/);
  assert.match(legacyPrompt, /"question_ref": "Q1"/);
  assert.match(legacyPrompt, /"llm_no_odds"/);
});

test("Bullpen x AI manual invest flow stays wired to the Polymarket manual-invest endpoint", () => {
  const bullpenAiPageSource = readFileSync(
    new URL("../app/console/bullpen-ai/page.tsx", import.meta.url),
    "utf8",
  );
  const urlsSource = readFileSync(
    new URL("../lib/urls.ts", import.meta.url),
    "utf8",
  );

  assert.match(bullpenAiPageSource, /function buildBullpenManualInvestOrder/);
  assert.match(bullpenAiPageSource, /market_id: marketId/);
  assert.match(urlsSource, /manualInvest: \(\) => `\$\{resolveApiBaseUrl\(\)\}\/polymarket\/manual-invest`/);
});


test("Bullpen x AI scan defaults exclude tweet counts", async () => {
  const { DEFAULT_BULLPEN_SCAN_FILTERS } = await loadBullpenAiModule();

  assert.equal(
    DEFAULT_BULLPEN_SCAN_FILTERS["30-days"].excludeTweetCountQuestions,
    true,
  );
  assert.equal(
    DEFAULT_BULLPEN_SCAN_FILTERS["end-of-month"].excludeTweetCountQuestions,
    true,
  );
});

test("Bullpen x AI sports filter catches Games category markets", () => {
  const routeSource = readFileSync(
    new URL("../app/api/bullpen-ai/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(routeSource, /const SPORTS_KEYWORDS = \[[\s\S]*"games"/);
  assert.match(routeSource, /question\.category/);
});

test("Bullpen x AI active positions stay included in LLM runs and share the events-table layout", () => {
  const bullpenAiPageSource = readFileSync(
    new URL("../app/console/bullpen-ai/page.tsx", import.meta.url),
    "utf8",
  );
  const investmentsSectionSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenInvestmentsSection.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(bullpenAiPageSource, /buildBullpenLlmRunTargetSet\(\{/);
  assert.match(bullpenAiPageSource, /activePositions: openActivePositions/);
  assert.match(investmentsSectionSource, /activePositionQuestions:/);
  assert.match(investmentsSectionSource, /Current Yes \/ No/);
  assert.match(investmentsSectionSource, /LLM Yes \/ No/);
  assert.match(investmentsSectionSource, /CheckCircle2/);
});

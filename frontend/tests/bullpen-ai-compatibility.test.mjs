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
    rules: 'This market resolves to "Yes" if candidate X wins.',
    marketContext:
      "Experimental AI-generated summary referencing Polymarket data. Candidate X has gained support.",
    resolutionSource: "Official election results will decide this market.",
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
    buildBullpenQuestionPreflightEvidenceBlock,
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
  const preflightEvidenceBlock = buildBullpenQuestionPreflightEvidenceBlock(
    questionRow,
    new Date("2026-06-23T12:00:00.000Z"),
  );

  assert.match(defaultPrompt, /Selected questions:/);
  assert.match(defaultPrompt, /"question_ref": "Q1"/);
  assert.match(defaultPrompt, /"current_yes_odds": 44/);
  assert.match(defaultPrompt, /"current_no_odds": 56/);
  assert.match(defaultPrompt, /"preflight_evidence_block": "Preflight Evidence Block:/);
  assert.match(
    defaultPrompt,
    /"polymarket_rules": "This market resolves to \\"Yes\\" if candidate X wins\."/,
  );
  assert.match(
    defaultPrompt,
    /"polymarket_market_context": "Experimental AI-generated summary referencing Polymarket data\. Candidate X has gained support\."/,
  );
  assert.match(defaultPrompt, /polymarket_rules/);
  assert.match(defaultPrompt, /Do not contradict populated facts in preflight_evidence_block\./);
  assert.match(
    defaultPrompt,
    /Experimental AI-generated summary referencing Polymarket data\./,
  );
  assert.notEqual(defaultPrompt, DEFAULT_BULLPEN_LLM_PROMPT_TEMPLATE.trim());

  assert.match(legacyPrompt, /Selected questions:/);
  assert.match(legacyPrompt, /"question_ref": "Q1"/);
  assert.match(legacyPrompt, /"llm_no_odds"/);
  assert.match(preflightEvidenceBlock, /Preflight Evidence Block:/);
  assert.match(preflightEvidenceBlock, /Market:\nWill candidate X win\?/);
  assert.match(preflightEvidenceBlock, /Verified current facts:/);
  assert.match(
    preflightEvidenceBlock,
    /These facts are authoritative\. Do not contradict them\. Only estimate the unresolved condition\./,
  );
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


test("Bullpen x AI investment result is shown below the Invest button", () => {
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

  assert.match(bullpenAiPageSource, /Investing was successful/);
  assert.match(bullpenAiPageSource, /Investing was partially successful/);
  assert.match(bullpenAiPageSource, /Investing was not successful/);
  assert.match(bullpenAiPageSource, /resultMessage=\{investmentNotice\}/);
  assert.match(investmentsSectionSource, /resultMessage: string \| null/);
  assert.match(investmentsSectionSource, /!isInvesting && resultMessage/);
  assert.match(investmentsSectionSource, /\{resultMessage\}/);
});

test("Bullpen x AI shows the fixed IST auto-run schedule and the run-now button", () => {
  const bullpenAiPageSource = readFileSync(
    new URL("../app/console/bullpen-ai/page.tsx", import.meta.url),
    "utf8",
  );
  const autoRunCardSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const autoRunProgressSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/bullpenAutoRunProgress.ts",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(bullpenAiPageSource, /BullpenAutoRunScheduleCard/);
  assert.match(autoRunCardSource, /Run Scans and Invest Now/);
  assert.match(autoRunCardSource, /6:00 AM IST/);
  assert.match(autoRunCardSource, /12:00 PM IST/);
  assert.match(autoRunCardSource, /6:00 PM IST/);
  assert.match(autoRunCardSource, /12:00 AM IST/);
  assert.match(autoRunCardSource, /Background execution monitor/);
  assert.match(autoRunCardSource, /Worker stages/);
  assert.match(autoRunCardSource, /refreshes every 4 seconds/);
  assert.match(autoRunProgressSource, /Stage 1 · Bullpen Scan/);
  assert.match(autoRunProgressSource, /Stage 2 · Run LLM/);
  assert.match(autoRunProgressSource, /Stage 3 · Invest/);
});

test("Bullpen x AI auto-run errors render detail text alongside the main message", () => {
  const autoRunCardSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(autoRunCardSource, /splitApiErrorSummary/);
  assert.match(autoRunCardSource, /error\.details/);
  assert.match(autoRunCardSource, /text-xs leading-5 text-rose-800/);
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

test("Bullpen x AI investment candidates include strong LLM Yes or No odds", async () => {
  const { isBullpenQuestionInvestmentCandidate } = await loadBullpenAiModule();

  assert.equal(isBullpenQuestionInvestmentCandidate(createQuestionRow()), false);

  const eligibleQuestion = {
    ...createQuestionRow(),
    llmNoOdds: 85,
    llmYesOdds: 15,
    amountToBeInvested: 15.5,
  };
  assert.equal(isBullpenQuestionInvestmentCandidate(eligibleQuestion), true);

  assert.equal(
    isBullpenQuestionInvestmentCandidate({
      ...eligibleQuestion,
      llmYesOdds: 85,
      llmNoOdds: 15,
    }),
    true,
  );

  assert.equal(
    isBullpenQuestionInvestmentCandidate({
      ...eligibleQuestion,
      llmYesOdds: 79,
      llmNoOdds: 80,
    }),
    false,
  );

  assert.equal(
    isBullpenQuestionInvestmentCandidate({
      ...eligibleQuestion,
      llmDisagreementLevel: "High",
    }),
    false,
  );
  assert.equal(
    isBullpenQuestionInvestmentCandidate({
      ...eligibleQuestion,
      adjudicationRequired: true,
    }),
    false,
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
  assert.match(
    bullpenAiPageSource,
    /BULLPEN_ACTIVE_POSITION_LLM_STORAGE_KEY/,
  );
  assert.match(
    bullpenAiPageSource,
    /buildSnapshotBackfilledActivePositionAnalyses/,
  );
  assert.match(
    bullpenAiPageSource,
    /mergeQuestionWithLatestActivePositionAnalysis/,
  );
  assert.match(
    bullpenAiPageSource,
    /activePositionQuestionByTargetId/,
  );
  assert.match(investmentsSectionSource, /activePositionQuestions:/);
  assert.match(investmentsSectionSource, /Current Yes \/ No/);
  assert.match(investmentsSectionSource, /LLM Yes \/ No/);
  assert.match(investmentsSectionSource, /Last LLM:/);
  assert.match(investmentsSectionSource, /Asia\/Kolkata/);
  assert.match(investmentsSectionSource, /CheckCircle2/);
});

test("Bullpen x AI LLM breakdown dialog shows the preflight evidence block", () => {
  const dialogSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenLlmBreakdownDialog.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(dialogSource, /Preflight Evidence Block:/);
  assert.match(dialogSource, /buildBullpenQuestionPreflightEvidenceBlock/);
  assert.match(dialogSource, /Web used:/);
  assert.match(dialogSource, /Sources count:/);
});

test("Bullpen x AI stale fact validation excludes contradictory public-listing claims", async () => {
  const { validateBullpenStaleFacts } = await loadBullpenAiModule();

  const validation = validateBullpenStaleFacts(
    [
      "Preflight Evidence Block:",
      "Verified current facts:",
      "- detailed market context: SpaceX started trading on Nasdaq under ticker SPACEX on June 1, 2026.",
      "- resolution source: Official exchange listings confirm the ticker is active.",
      "",
      "Instruction:",
      "These facts are authoritative. Do not contradict them.",
    ].join("\n"),
    "SpaceX is still private and there is no IPO yet.",
  );

  assert.equal(validation.invalidStaleFact, true);
  assert.match(validation.staleFactReason, /already confirmed the company is public/i);
});

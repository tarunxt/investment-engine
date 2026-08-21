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

async function loadStage2TopTenHandoffModule() {
  const tempDir = mkdtempSync(path.join(tmpdir(), "bullpen-stage2-top10-handoff-"));

  const bullpenAiPath = path.join(tempDir, "bullpen-ai.mjs");
  writeFileSync(
    bullpenAiPath,
    `export function getBullpenTopTenStrongestLlmOddsRows(questions, limit = 10) {
      return [...questions]
        .sort((left, right) => {
          const returnsDelta =
            (right.returnsPerDay ?? Number.NEGATIVE_INFINITY) -
            (left.returnsPerDay ?? Number.NEGATIVE_INFINITY);
          if (returnsDelta !== 0) return returnsDelta;
          return left.question.localeCompare(right.question);
        })
        .slice(0, limit);
    }`,
    "utf8",
  );

  const progressPath = path.join(tempDir, "bullpenAutoRunProgress.mjs");
  writeFileSync(
    progressPath,
    `export function buildBullpenAutoRunWorkflowView(run) {
      return run.__workflow;
    }`,
    "utf8",
  );

  const historyPath = path.join(tempDir, "bullpenAutoRunStageTwoHistory.mjs");
  writeFileSync(
    historyPath,
    `export function getStageTwoLlmReviewedRows(llmStage) {
      return llmStage?.reviewedRows ?? [];
    }

    export function buildStageTwoEventsSummaryRows({ reviewedRows }) {
      return reviewedRows;
    }`,
    "utf8",
  );

  const strategyPath = path.join(tempDir, "bullpenStage2To3Strategy.mjs");
  writeFileSync(
    strategyPath,
    "export const DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MAX_POSITIONS = 10;",
    "utf8",
  );

  const source = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/bullpenStage2TopTenHandoff.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const modulePath = path.join(tempDir, "bullpenStage2TopTenHandoff.mjs");
  writeFileSync(
    modulePath,
    transpileModuleSource(source, "bullpenStage2TopTenHandoff.ts")
      .replace(
        'from "@/lib/bullpen-ai";',
        `from ${JSON.stringify(pathToFileURL(bullpenAiPath).href)};`,
      )
      .replace(
        'from "./bullpenAutoRunProgress";',
        `from ${JSON.stringify(pathToFileURL(progressPath).href)};`,
      )
      .replace(
        'from "./bullpenAutoRunStageTwoHistory";',
        `from ${JSON.stringify(pathToFileURL(historyPath).href)};`,
      )
      .replace(
        'from "./bullpenStage2To3Strategy";',
        `from ${JSON.stringify(pathToFileURL(strategyPath).href)};`,
      ),
    "utf8",
  );

  return import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`);
}

function createStage2TopTenQuestion(index) {
  return {
    id: `question-${index}`,
    question: `Stage 2 event ${index}`,
    positionKey: null,
    conditionId: null,
    marketId: `market-${index}`,
    questionId: `question-${index}`,
    closeTime: "2026-07-31T12:00:00Z",
    category: "Politics",
    yesOdds: 20,
    noOdds: 80,
    currentOddsUpdatedAt: null,
    investmentTableAddedAt: null,
    volume: null,
    liquidity: null,
    sourceUrl: `https://example.com/market-${index}`,
    slug: `market-${index}`,
    marketUrl: `https://example.com/market-${index}`,
    outcomeLabels: ["Yes", "No"],
    outcomeCount: 2,
    isBinaryYesNo: true,
    daysUntilClose: 10,
    rules: null,
    marketContext: null,
    resolutionSource: null,
    llmYesOdds: 85 + (10 - index),
    llmNoOdds: 15 - (10 - index),
    llmAverageYesOdds: null,
    llmMedianYesOdds: null,
    llmTrimmedMeanYesOdds: null,
    llmIqrYesOdds: null,
    llmTrimmedRangeYesOdds: null,
    llmMinYesOdds: null,
    llmMaxYesOdds: null,
    llmSpreadYesOdds: null,
    llmDisagreementLevel: "Low",
    llmDisagreementCategory: "CONSENSUS",
    llmRationaleMismatchCount: 0,
    adjudicationRequired: false,
    evidenceStatus: "Strong",
    eventState: "Watching",
    currentVsLlmOddsDifference: null,
    returnsPerDay: 25 - index,
    amountToBeInvested: 1.14,
    isAmountToBeInvestedHighlighted: false,
    llmNotes: null,
    llmProvider: "openai",
    llmModel: "gpt-4o-mini",
    llmRunId: "run-1",
    llmCompletedAt: "2026-07-19T15:00:00Z",
    preflightEvidenceBlock: null,
    llmBreakdown: [],
  };
}

test("Stage 2 invest list reuses the saved Stage 2 top-10 events summary and keeps Stage 3 handoff diagnostics separate", () => {
  const source = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(source, /if \(decision\.decision === "BUY_NEW"\) \{\s*return true;/);
  assert.match(source, /buildStageTwoInvestEventsDialogState/);
  assert.match(source, /getBullpenTopTenStrongestLlmOddsRows/);
  assert.match(source, /Stage 2 Top 10 events ranked by Returns\/day\./);
  assert.match(source, /rowsOverride=\{state\.rows\}/);
  assert.match(source, /updatedAt=\{state\.updatedAt\}/);
  assert.match(source, /updateUnavailableReason=\{state\.updateUnavailableReason\}/);
  assert.match(source, /data-testid="stage-two-invest-events-summary"/);
  assert.doesNotMatch(source, /Persisted Stage 2 Top 10 candidates that Stage 3 is trying to\s+execute\./);
  assert.doesNotMatch(source, /mirrors the Stage 3 Step 2 planned\s+queue layout/);
  assert.match(source, /buildBullpenStage2TopTenHandoffRows/);
  assert.match(source, /Execution blocker \/ detail:/);
  assert.match(source, /row\.missingFromStage3/);
  assert.match(source, /formatStage2TopTenHandoffOutcome/);
  assert.match(source, /showStage2TopTenEventsSummary/);
  assert.match(source, /<Stage2TopTenEventsSummaryTable/);
  assert.match(source, /testId="stage-three-step-two-events-summary"/);
  assert.match(source, /Saved Stage 2 transfer queue/);
});

test("Stage 2 invest list can collapse into a compact Events Summary view", () => {
  const source = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(source, /const \[isCompactRows, setIsCompactRows\] = useState\(false\);/);
  assert.match(source, /Collapse Stage 2 invest rows/);
  assert.match(source, /Expand Stage 2 invest rows/);
  assert.match(source, /displayDensity=\{isCompactRows \? "compact" : "default"\}/);
});

test("Stage 2 handoff fallback reuses the canonical strongest-odds Top 10 selector", () => {
  const source = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/bullpenStage2TopTenHandoff.ts",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(source, /questionByMarketId: Map<string, BullpenQuestionRow>/);
  assert.match(source, /getBullpenTopTenStrongestLlmOddsRows/);
  assert.match(source, /\[\.\.\.questionByMarketId\.values\(\)\]/);
  assert.match(source, /return reviewedTopTenMarketIds;/);
});

test("Stage 3 Step 2 handoff keeps the full saved Stage 2 Top 10 even when later Stage 3 outputs narrow the list", async () => {
  const { buildBullpenStage2TopTenHandoffRows } =
    await loadStage2TopTenHandoffModule();

  const reviewedRows = Array.from({ length: 10 }, (_, index) =>
    createStage2TopTenQuestion(index + 1),
  );
  const run = {
    id: "run-1",
    started_at: "2026-07-19T15:00:00Z",
    completed_at: "2026-07-19T15:10:00Z",
    stage_results: [
      {
        stage_number: 6,
        outputs: {
          ranking_top_candidate_market_id_order: [
            "market-4",
            "market-2",
            "market-1",
          ],
        },
      },
      {
        stage_number: 3,
        outputs: {
          workflow_stage_key: "invest",
          top_candidate_market_ids: ["market-4", "market-2", "market-1"],
        },
      },
    ],
    __workflow: {
      stages: [
        { key: "scan", scanCandidates: [] },
        { key: "llm", reviewedRows },
      ],
    },
  };

  const rows = buildBullpenStage2TopTenHandoffRows({
    run,
    decisions: [],
  });

  assert.equal(rows.length, 10);
  assert.deepEqual(
    rows.map((row) => row.marketId),
    reviewedRows.map((row) => row.marketId),
  );
});

test("Stage 3 Step 2 transfer queue summary cards open metric info popups for each queue count", () => {
  const source = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(source, /Stage2TransferQueueMetricSummaryCard/);
  assert.match(source, /Stage2TransferQueueMetricInfoDialog/);
  assert.match(source, /kind="transferred-rows"/);
  assert.match(source, /kind="concrete-buy-plans"/);
  assert.match(source, /kind="submitted-buy-plans"/);
  assert.match(source, /kind="waiting-blocked"/);
  assert.match(source, /aria-label=\{`Show \$\{label\} details`\}/);
});

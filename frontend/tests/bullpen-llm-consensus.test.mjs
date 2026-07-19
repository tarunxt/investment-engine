import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

async function loadBullpenAiModule() {
  const strategySource = readFileSync(
    new URL("../lib/bullpenStage2To3Strategy.ts", import.meta.url),
    "utf8",
  );
  const { outputText: strategyOutputText } = ts.transpileModule(strategySource, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: "bullpenStage2To3Strategy.ts",
  });
  const strategyModuleUrl = `data:text/javascript;base64,${Buffer.from(
    strategyOutputText,
  ).toString("base64")}`;
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
  const rewrittenOutputText = outputText.replace(
    'from "@/lib/bullpenStage2To3Strategy";',
    `from ${JSON.stringify(strategyModuleUrl)};`,
  );

  return import(
    `data:text/javascript;base64,${Buffer.from(rewrittenOutputText).toString("base64")}`
  );
}

test("computeBullpenLlmConsensus flags high disagreement and avoids simple-average display odds", async () => {
  const { computeBullpenLlmConsensus } = await loadBullpenAiModule();
  const yesValues = [70, 28, 70, 70, 90, 10, 25, 40, 25, 20, 65, 65, 55];
  const breakdown = yesValues.map((llmYesOdds, index) => ({
    provider: "test-provider",
    model: `test-model-${index + 1}`,
    jobId: null,
    runId: null,
    timestamp: null,
    llmYesOdds,
    llmNoOdds: 100 - llmYesOdds,
    yesDefinition: null,
    deadlineEt: null,
    hoursRemaining: null,
    evidenceStatus: null,
    eventState: null,
    confidence: null,
    keyEvidence: [],
    redFlags: [],
    rationale: null,
  }));

  const consensus = computeBullpenLlmConsensus(breakdown);

  assert.ok(Math.abs((consensus.llmAverageYesOdds ?? 0) - 48.69) < 0.01);
  assert.equal(consensus.llmMedianYesOdds, 55);
  assert.equal(consensus.llmMinYesOdds, 10);
  assert.equal(consensus.llmMaxYesOdds, 90);
  assert.equal(consensus.llmSpreadYesOdds, 80);
  assert.equal(consensus.llmDisagreementLevel, "High");
  assert.equal(consensus.adjudicationRequired, true);
  assert.notEqual(consensus.consensusYesOdds, consensus.llmAverageYesOdds);
  assert.equal(consensus.consensusYesOdds, 55);
  assert.equal(consensus.consensusNoOdds, 45);
});

test("computeBullpenLlmConsensus excludes entries flagged with invalid reasons", async () => {
  const { computeBullpenLlmConsensus } = await loadBullpenAiModule();
  const breakdown = [
    {
      provider: "test-provider",
      model: "model-a",
      jobId: null,
      runId: null,
      timestamp: null,
      llmYesOdds: 70,
      llmNoOdds: 30,
      yesDefinition: null,
      deadlineEt: null,
      hoursRemaining: null,
      evidenceStatus: null,
      eventState: null,
      confidence: null,
      keyEvidence: [],
      redFlags: [],
      rationale: null,
      invalidReason: "Required model-side search/tool usage did not run before the final answer.",
    },
    {
      provider: "test-provider",
      model: "model-b",
      jobId: null,
      runId: null,
      timestamp: null,
      llmYesOdds: 40,
      llmNoOdds: 60,
      yesDefinition: null,
      deadlineEt: null,
      hoursRemaining: null,
      evidenceStatus: null,
      eventState: null,
      confidence: null,
      keyEvidence: [],
      redFlags: [],
      rationale: null,
      invalidReason: null,
    },
  ];

  const consensus = computeBullpenLlmConsensus(breakdown);

  assert.equal(consensus.consensusYesOdds, 40);
  assert.equal(consensus.consensusNoOdds, 60);
  assert.equal(consensus.llmAverageYesOdds, 40);
  assert.equal(consensus.llmSpreadYesOdds, 0);
});

test("computeBullpenLlmConsensus treats one uncertain outlier as consensus with outlier", async () => {
  const { computeBullpenLlmConsensus } = await loadBullpenAiModule();
  const yesValues = [10, 12, 15, 8, 14, 9, 11, 13, 50];
  const breakdown = yesValues.map((llmYesOdds, index) => ({
    provider: `provider-${index + 1}`,
    model: `test-model-${index + 1}`,
    jobId: null,
    runId: null,
    timestamp: null,
    llmYesOdds,
    llmNoOdds: 100 - llmYesOdds,
    yesDefinition: null,
    deadlineEt: null,
    hoursRemaining: null,
    evidenceStatus: "Strong",
    eventState: "no_confirmed_event",
    confidence: "High",
    keyEvidence: [],
    redFlags: [],
    rationale:
      llmYesOdds >= 45
        ? "No credible evidence confirms the event yet."
        : "No confirmed event has happened yet.",
  }));

  const consensus = computeBullpenLlmConsensus(breakdown);

  assert.equal(consensus.llmDisagreementLevel, "Medium");
  assert.equal(consensus.llmDisagreementCategory, "CONSENSUS_WITH_OUTLIER");
  assert.equal(consensus.adjudicationRequired, false);
  assert.equal(consensus.llmMedianYesOdds, 12);
  assert.equal(consensus.llmTrimmedMeanYesOdds, 12);
  assert.equal(consensus.consensusMethod, "trimmedMean");
  assert.equal(consensus.consensusYesOdds, 12);
  assert.equal(consensus.llmRationaleMismatchCount, 1);
});

test("computeBullpenLlmConsensus flags true two-sided disagreement only when both camps have support", async () => {
  const { computeBullpenLlmConsensus } = await loadBullpenAiModule();
  const yesValues = [72, 68, 65, 18, 22, 30];
  const breakdown = yesValues.map((llmYesOdds, index) => ({
    provider: `provider-${index + 1}`,
    model: `test-model-${index + 1}`,
    jobId: null,
    runId: null,
    timestamp: null,
    llmYesOdds,
    llmNoOdds: 100 - llmYesOdds,
    yesDefinition: null,
    deadlineEt: null,
    hoursRemaining: null,
    evidenceStatus: "Strong",
    eventState: "conflicting",
    confidence: "Medium",
    keyEvidence: [],
    redFlags: [],
    rationale: null,
  }));

  const consensus = computeBullpenLlmConsensus(breakdown);

  assert.equal(consensus.llmDisagreementLevel, "High");
  assert.equal(consensus.llmDisagreementCategory, "HIGH_DISAGREEMENT");
  assert.equal(consensus.adjudicationRequired, true);
  assert.equal(consensus.consensusMethod, "median");
});


test("getBullpenReturnsPerDayBreakdown matches spreadsheet column O", async () => {
  const { getBullpenReturnsPerDayBreakdown } = await loadBullpenAiModule();

  assert.deepEqual(
    getBullpenReturnsPerDayBreakdown({
      yesOdds: 19.5,
      noOdds: 80.5,
      llmYesOdds: 12.5,
      llmNoOdds: 87.5,
      daysUntilClose: 1.7,
    }),
    {
      currentOdds: 80.5,
      currentSide: "No",
      daysUntilClose: 1.7,
      llmYesOdds: 12.5,
      llmNoOdds: 87.5,
      result: 47.35,
    },
  );

  assert.deepEqual(
    getBullpenReturnsPerDayBreakdown({
      yesOdds: 77.5,
      noOdds: 22.5,
      llmYesOdds: 60,
      llmNoOdds: 40,
      daysUntilClose: 1.7,
    }),
    {
      currentOdds: 77.5,
      currentSide: "Yes",
      daysUntilClose: 1.7,
      llmYesOdds: 60,
      llmNoOdds: 40,
      result: 45.59,
    },
  );
});

test("normalizeBullpenLlmBreakdownEntries accepts historical odds aliases while excluding errored rows from consensus", async () => {
  const {
    computeBullpenLlmConsensus,
    normalizeBullpenLlmBreakdownEntries,
  } = await loadBullpenAiModule();

  const breakdown = normalizeBullpenLlmBreakdownEntries([
    {
      provider: "openai",
      model: "gpt-4o-mini",
      yes_odds: 88,
      no_odds: 12,
      completed_at: "2026-07-16T18:45:07Z",
    },
    {
      provider: "anthropic",
      model: "claude-3.5-sonnet",
      yesOdds: 84,
      noOdds: 16,
      completed_at: "2026-07-16T18:45:07Z",
    },
    {
      provider: "gemini",
      model: "gemini-2.5-flash",
      probabilityYes: 82,
      probabilityNo: 18,
      completed_at: "2026-07-16T18:45:07Z",
    },
    {
      provider: "deepseek",
      model: "deepseek-chat",
      yes_probability: 80,
      no_probability: 20,
      completed_at: "2026-07-16T18:45:07Z",
    },
    {
      provider: "failed-provider",
      model: "model-error",
      error: "Provider returned no usable probability.",
      completed_at: "2026-07-16T18:45:07Z",
    },
  ]);

  assert.equal(breakdown.length, 5);
  assert.equal(breakdown[0].llmYesOdds, 88);
  assert.equal(breakdown[1].llmNoOdds, 16);
  assert.equal(breakdown[2].llmYesOdds, 82);
  assert.equal(
    breakdown[4].invalidReason,
    "Provider returned no usable probability.",
  );

  const consensus = computeBullpenLlmConsensus(breakdown);
  assert.equal(consensus.consensusYesOdds, 83);
  assert.equal(consensus.consensusNoOdds, 17);
});

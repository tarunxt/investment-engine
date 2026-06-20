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

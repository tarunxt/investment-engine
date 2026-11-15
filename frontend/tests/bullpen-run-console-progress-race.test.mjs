import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";

async function loadModule() {
  const directory = mkdtempSync(path.join(tmpdir(), "bullpen-progress-race-"));
  const outputPath = path.join(directory, "bullpenRunConsoleDetail.mjs");
  const source = readFileSync(
    new URL("../lib/bullpenRunConsoleDetail.ts", import.meta.url),
    "utf8",
  );
  writeFileSync(
    outputPath,
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
  );
  return import(`${pathToFileURL(outputPath).href}?t=${Date.now()}`);
}

function stage(startedAt, outputs) {
  return {
    stage_number: 2,
    stage_name: "Stage 2",
    status: "pass",
    inputs: {},
    outputs: { workflow_stage_key: "llm", ...outputs },
    guardrails_checked: [],
    started_at: startedAt,
    completed_at: null,
  };
}

function run(stageResult) {
  return {
    id: "run-llm-progress",
    stage_results: [stageResult],
    guardrail_checks: [],
    decision_ids: [],
    order_intent_ids: [],
    audit_metadata: {},
  };
}

test("same-generation compact polls cannot regress completed or passed LLM counters", async () => {
  const { mergeBullpenConsoleRunProjection } = await loadModule();
  const startedAt = "2026-08-14T04:08:02Z";
  const existing = run(
    stage(startedAt, {
      llm_provider_target_count: 3,
      llm_completed_provider_target_count: 3,
      llm_successful_provider_target_count: 3,
      llm_passed_provider_target_count: 3,
      llm_usable_provider_target_count: 3,
      llm_failed_provider_target_count: 0,
      llms_completed: 3,
    }),
  );
  const staleProjection = run(
    stage(startedAt, {
      llm_provider_target_count: 3,
      llm_completed_provider_target_count: 0,
      llm_successful_provider_target_count: 0,
      llm_passed_provider_target_count: 0,
      llm_usable_provider_target_count: 0,
      llm_failed_provider_target_count: 0,
      llms_completed: 0,
    }),
  );

  const merged = mergeBullpenConsoleRunProjection({
    existing,
    projected: staleProjection,
    projectionAvailable: true,
  });
  const outputs = merged.stage_results[0].outputs;

  assert.equal(outputs.llm_provider_target_count, 3);
  assert.equal(outputs.llm_completed_provider_target_count, 3);
  assert.equal(outputs.llm_successful_provider_target_count, 3);
  assert.equal(outputs.llm_passed_provider_target_count, 3);
  assert.equal(outputs.llm_usable_provider_target_count, 3);
  assert.equal(outputs.llm_failed_provider_target_count, 0);
  assert.equal(outputs.llms_completed, 3);
});

test("a new Stage 2 execution generation is allowed to reset LLM counters", async () => {
  const { mergeBullpenConsoleRunProjection } = await loadModule();
  const existing = run(
    stage("2026-08-14T04:08:02Z", {
      llm_completed_provider_target_count: 3,
      llm_passed_provider_target_count: 3,
      llms_completed: 3,
    }),
  );
  const retriedProjection = run(
    stage("2026-08-14T04:12:00Z", {
      llm_completed_provider_target_count: 0,
      llm_passed_provider_target_count: 0,
      llms_completed: 0,
    }),
  );

  const merged = mergeBullpenConsoleRunProjection({
    existing,
    projected: retriedProjection,
    projectionAvailable: true,
  });
  const outputs = merged.stage_results[0].outputs;

  assert.equal(outputs.llm_completed_provider_target_count, 0);
  assert.equal(outputs.llm_passed_provider_target_count, 0);
  assert.equal(outputs.llms_completed, 0);
});

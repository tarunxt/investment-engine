import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";

async function loadModule() {
  const directory = mkdtempSync(path.join(tmpdir(), "bullpen-rejected-evidence-"));
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

function run(rejectedCandidates) {
  return {
    id: "run-stage1-filtered",
    status: "completed",
    stage_results: [
      {
        stage_number: 1,
        stage_name: "Candidate Scan",
        status: "pass",
        inputs: {},
        outputs: {
          workflow_stage_key: "scan",
          phase_status: "completed",
          scanned_candidates: 1526,
          accepted_candidates_count: 0,
          rejected_candidates: rejectedCandidates,
        },
        guardrails_checked: [],
        started_at: "2026-08-20T12:30:18Z",
        completed_at: "2026-08-20T12:30:19Z",
      },
    ],
    guardrail_checks: [],
    decision_ids: [],
    order_intent_ids: [],
    audit_metadata: {},
  };
}

test("compact Stage 1 polls cannot erase loaded rejected-event rows", async () => {
  const { mergeBullpenConsoleRunProjection } = await loadModule();
  const fullRows = Array.from({ length: 125 }, (_, index) => ({
    market_id: `market-${index}`,
    question: `Filtered event ${index}`,
    reasons: ["Stage 1 filter rejected this event"],
  }));
  const compactRows = fullRows.slice(0, 100);

  const merged = mergeBullpenConsoleRunProjection({
    existing: run(fullRows),
    projected: run(compactRows),
    projectionAvailable: true,
  });

  assert.equal(
    merged.stage_results[0].outputs.rejected_candidates.length,
    fullRows.length,
  );
  assert.deepEqual(
    merged.stage_results[0].outputs.rejected_candidates,
    fullRows,
  );
});

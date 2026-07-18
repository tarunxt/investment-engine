import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

test("trade analysis page exposes the Runs Analysis action", async () => {
  const source = await read(
    "app/console/bullpen-ai/analyse-events/_components/TradeAnalysisListClient.tsx",
  );

  assert.match(source, /Runs Analysis/);
  assert.match(source, /URLs\.routes\.console\.bullpenAiAnalyseRuns\(\)/);
});

test("URL helpers include the run audit routes and API prefix", async () => {
  const source = await read("lib/urls.ts");

  assert.match(source, /const bullpenRunAuditApiUrls = \{/);
  assert.match(source, /\/bullpen-ai\/run-audits/);
  assert.match(source, /bullpenAiAnalyseRuns: \(\) => "\/console\/bullpen-ai\/analyse-runs"/);
  assert.match(source, /bullpenAiAnalyseRunDetail: \(runId: string\)/);
});

test("detail client keeps the shared single-select model picker and three sections", async () => {
  const source = await read(
    "app/console/bullpen-ai/analyse-runs/_components/RunAuditDetailClient.tsx",
  );

  assert.match(source, /selectionMode="single"/);
  assert.match(source, /Section I/);
  assert.match(source, /Section II/);
  assert.match(source, /Section III/);
  assert.match(source, /Run Audit Feedback/);
});

test("list client loads paginated summaries instead of raw detail bundles", async () => {
  const source = await read(
    "app/console/bullpen-ai/analyse-runs/_components/RunAuditListClient.tsx",
  );

  assert.match(source, /apiService\.getBullpenRunAudits\(/);
  assert.doesNotMatch(source, /getBullpenRunAuditSection\(/);
  assert.match(source, /Bullpen Runs Audit/);
  assert.match(source, /Runs Analysis/);
  assert.match(source, /URLs\.routes\.console\.bullpenAiAnalyseRuns\(\)/);
});

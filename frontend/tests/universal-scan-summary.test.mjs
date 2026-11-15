import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../app/api/bullpen-ai/_lib/universalScanSummary.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const summaryModule = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);

function question(overrides) {
  return {
    id: "market",
    question: "Will the event happen?",
    closeTime: "2026-09-15T12:00:00.000Z",
    category: "Other",
    yesOdds: 52,
    noOdds: 48,
    volume: "1200",
    liquidity: "250",
    sourceUrl: "https://polymarket.com",
    slug: "market",
    marketUrl: null,
    outcomeLabels: ["Yes", "No"],
    outcomeCount: 2,
    isBinaryYesNo: true,
    daysUntilClose: 1,
    rules: null,
    marketContext: null,
    resolutionSource: null,
    ...overrides,
  };
}

test("universal scan summary accounts for every event in all six breakdowns", () => {
  const summary = summaryModule.createUniversalScanSummary({
    startedAt: "2026-09-14T10:00:00.000Z",
    completedAt: "2026-09-14T10:02:03.000Z",
    questions: [
      question({ question: "Will India win the cricket match?", category: "Sports" }),
      question({ question: "Will a Ukraine ceasefire be signed?", yesOdds: 82, noOdds: 18, volume: null, liquidity: "150000" }),
    ],
  });

  assert.equal(summary.durationMs, 123_000);
  assert.equal(summary.totalEvents, 2);
  assert.equal(summary.tables.length, 6);
  for (const table of summary.tables) {
    assert.equal(table.rows.reduce((total, row) => total + row.count, 0), 2, table.title);
  }
  assert.equal(summary.tables[0].rows.find(row => row.label === "Sports").count, 1);
  assert.equal(summary.tables[0].rows.find(row => row.label === "Geopolitics & Conflict").count, 1);
  assert.equal(summary.tables[1].rows.find(row => row.label === "Tomorrow").count, 2);
});

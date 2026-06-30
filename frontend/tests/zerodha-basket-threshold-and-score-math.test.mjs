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

async function loadModule(relativePath, tempFileName) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "zerodha-threshold-score-"));
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const modulePath = path.join(tempDir, tempFileName);
  writeFileSync(modulePath, transpileModuleSource(source, path.basename(relativePath)), "utf8");
  return import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`);
}

test("buildDefaultZerodhaBasketSelection selects only buy rows above the threshold", async () => {
  const {
    DEFAULT_ZERODHA_BUY_THRESHOLD,
    buildDefaultZerodhaBasketSelection,
  } = await loadModule("../lib/zerodhaBasketSelection.ts", "zerodhaBasketSelection.mjs");

  const selected = buildDefaultZerodhaBasketSelection([
    { id: "sell-all", side: "SELL", score: -2.6 },
    { id: "trim", side: "SELL", score: -1.4 },
    { id: "buy-strong", side: "BUY", score: 2.51 },
    { id: "buy-borderline", side: "BUY", score: DEFAULT_ZERODHA_BUY_THRESHOLD },
    { id: "buy-weaker", side: "BUY", score: 2.12 },
    { id: "buy-missing", side: "BUY", score: null },
  ]);

  assert.deepEqual(
    Array.from(selected).sort(),
    ["buy-strong", "sell-all", "trim"],
  );
});

test("syncZerodhaBasketBuySelection preserves sell choices and refreshes buy eligibility", async () => {
  const { syncZerodhaBasketBuySelection } = await loadModule(
    "../lib/zerodhaBasketSelection.ts",
    "zerodhaBasketSelection-sync.mjs",
  );

  const selected = syncZerodhaBasketBuySelection(
    new Set(["sell-all", "manual-trim", "old-buy"]),
    [
      { id: "sell-all", side: "SELL", score: -2.6 },
      { id: "manual-trim", side: "SELL", score: -1.4 },
      { id: "buy-strong", side: "BUY", score: 2.9 },
      { id: "buy-weaker", side: "BUY", score: 2.4 },
    ],
    2.5,
  );

  assert.deepEqual(
    Array.from(selected).sort(),
    ["buy-strong", "manual-trim", "sell-all"],
  );
});

test("calculateWeightedRationaleScore ignores out-of-bounds rows and applies the requested denominator reduction", async () => {
  const { calculateWeightedRationaleScore } = await loadModule(
    "../lib/scoreMatrixMath.ts",
    "scoreMatrixMath.mjs",
  );

  const { finalScore, denominator } = calculateWeightedRationaleScore([
    {
      score: 2,
      multiplier: 3,
      validationRule: { min: -3, max: 3 },
    },
    {
      score: 1300,
      multiplier: 1,
      denominatorWeight: 2,
      outOfBoundsDenominatorWeight: 3,
      validationRule: { min: 0, max: 10 },
    },
    {
      score: 2,
      multiplier: 5,
      validationRule: { min: -3, max: 3, integerOnly: true },
    },
  ]);

  assert.equal(denominator, 7);
  assert.equal(finalScore?.toFixed(4), "2.2857");
});

test("calculateWeightedRationaleScore keeps the current denominator when all rows are valid", async () => {
  const { calculateWeightedRationaleScore } = await loadModule(
    "../lib/scoreMatrixMath.ts",
    "scoreMatrixMath-valid.mjs",
  );

  const { finalScore, denominator } = calculateWeightedRationaleScore([
    {
      score: 2,
      multiplier: 3,
      validationRule: { min: -3, max: 3 },
    },
    {
      score: 7,
      multiplier: 1,
      denominatorWeight: 2,
      outOfBoundsDenominatorWeight: 3,
      validationRule: { min: 0, max: 10 },
    },
    {
      score: 2,
      multiplier: 5,
      validationRule: { min: -3, max: 3, integerOnly: true },
    },
  ]);

  assert.equal(denominator, 10);
  assert.equal(finalScore?.toFixed(4), "2.3000");
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function loadModule() {
  const source = readFileSync(
    new URL("../lib/portfolioHistory.ts", import.meta.url),
    "utf8",
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const loaded = { exports: {} };
  new Function("exports", "module", output)(loaded.exports, loaded);
  return loaded.exports;
}

const {
  MIN_GENUINE_PORTFOLIO_POINTS,
  buildGenuineInrPortfolioTrend,
  filterGenuinePortfolioTrend,
} = loadModule();

function snapshot(hour, value) {
  return {
    captured_at: `2026-07-26T${String(hour).padStart(2, "0")}:00:00.000Z`,
    holdings_market_value: value,
    available_margin: 100,
  };
}

test("missing and sparse history never creates artificial chart points", () => {
  assert.deepEqual(buildGenuineInrPortfolioTrend([]), []);
  assert.deepEqual(
    buildGenuineInrPortfolioTrend([
      snapshot(1, 1000),
      snapshot(2, 1050),
      snapshot(3, 1030),
    ]),
    [],
  );
});

test("genuine history preserves only source timestamps and values", () => {
  const source = [
    snapshot(1, 1000),
    snapshot(2, 1050),
    snapshot(3, 1030),
    snapshot(4, 1100),
  ];
  const points = buildGenuineInrPortfolioTrend(source);

  assert.equal(points.length, MIN_GENUINE_PORTFOLIO_POINTS);
  assert.deepEqual(
    points.map((point) => point.timestamp),
    source.map((item) => Date.parse(item.captured_at)),
  );
  assert.deepEqual(
    points.map((point) => point.value),
    source.map((item) => item.holdings_market_value + item.available_margin),
  );
});

test("a sparse selected range stays empty instead of borrowing older points", () => {
  const points = buildGenuineInrPortfolioTrend([
    snapshot(1, 1000),
    snapshot(2, 1050),
    snapshot(3, 1030),
    snapshot(4, 1100),
  ]);

  assert.deepEqual(filterGenuinePortfolioTrend(points, "1D"), points);
  const monthlyPoints = [
    { timestamp: Date.parse("2026-01-01T00:00:00Z"), value: 1000 },
    { timestamp: Date.parse("2026-02-01T00:00:00Z"), value: 1050 },
    { timestamp: Date.parse("2026-03-01T00:00:00Z"), value: 1030 },
    { timestamp: Date.parse("2026-07-26T00:00:00Z"), value: 1100 },
  ];
  assert.deepEqual(filterGenuinePortfolioTrend(monthlyPoints, "1M"), []);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function loadModule() {
  const source = readFileSync(
    new URL("../lib/fxPresentation.ts", import.meta.url),
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

test("cached FX becomes unusable when its source timestamp crosses the stale window", () => {
  const { validDashboardFxRate } = loadModule();
  const asOf = Date.parse("2026-07-25T00:00:00.000Z");
  const fx = {
    value: 86.25,
    as_of: new Date(asOf).toISOString(),
    stale_after_seconds: 36 * 60 * 60,
    status: "valid",
  };

  assert.equal(
    validDashboardFxRate(fx, asOf + 36 * 60 * 60 * 1000),
    86.25,
  );
  assert.equal(
    validDashboardFxRate(fx, asOf + 36 * 60 * 60 * 1000 + 1),
    null,
  );
  assert.equal(validDashboardFxRate({ ...fx, status: "stale" }, asOf), null);
  assert.equal(validDashboardFxRate(null, asOf), null);
});

test("USD costs remain native when no verified conversion is available", () => {
  const { formatUsdAsVerifiedInr } = loadModule();

  assert.equal(formatUsdAsVerifiedInr(2, 86.125), "₹172.25");
  assert.equal(formatUsdAsVerifiedInr(2, 0), "$2.00 (FX unavailable)");
  assert.equal(formatUsdAsVerifiedInr(2, null), "$2.00 (FX unavailable)");
  assert.equal(formatUsdAsVerifiedInr(0.0012, undefined), "$0.001200 (FX unavailable)");
});

test("recent job currency labels follow verified FX and retain native USD on loading or failure", () => {
  const { displayedUsdCostCurrency, formatUsdCostWithCurrency } = loadModule();
  for (const rate of [0, null, undefined, NaN, Infinity, -1]) {
    assert.equal(displayedUsdCostCurrency(rate), "USD");
    assert.equal(formatUsdCostWithCurrency(2, rate), "USD $2.00 (FX unavailable)");
    assert.equal(formatUsdCostWithCurrency(0, rate), "USD $0.00 (FX unavailable)");
  }
  assert.equal(displayedUsdCostCurrency(86.125), "INR");
  assert.equal(formatUsdCostWithCurrency(2, 86.125), "INR ₹172.25");
  assert.equal(formatUsdCostWithCurrency(0, 86.125), "INR ₹0.00");
  assert.equal(formatUsdCostWithCurrency(0.0012, null), "USD $0.001200 (FX unavailable)");
});

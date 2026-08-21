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

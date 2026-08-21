import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const recoverySource = readFileSync(
  new URL(
    "../app/console/automated-rebalance/_components/automatedRebalanceStartRecovery.ts",
    import.meta.url,
  ),
  "utf8",
);

test("automated-rebalance threat history requests are bounded before they reach FastAPI", () => {
  assert.match(recoverySource, /const BACKEND_THREAT_HISTORY_MAX_LIMIT = 100;/);
  assert.match(recoverySource, /function clampThreatHistoryParams/);
  assert.match(
    recoverySource,
    /Math\.min\(\s*BACKEND_THREAT_HISTORY_MAX_LIMIT,[\s\S]*?Math\.max\(1, normalizedLimit\)/,
  );
  assert.match(
    recoverySource,
    /apiService\.zerodhaThreatsHistory = \(params\) =>[\s\S]*?originalZerodhaThreatsHistory\(clampThreatHistoryParams\(params\)\)/,
  );
  assert.match(
    recoverySource,
    /apiService\.indmoneyUsThreatsHistory = \(params\) =>[\s\S]*?originalIndmoneyUsThreatsHistory\(clampThreatHistoryParams\(params\)\)/,
  );
});

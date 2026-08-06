import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../app/console/_components/FinalActionablesConsole.tsx", import.meta.url),
  "utf8",
);
const apiSource = readFileSync(new URL("../services/api.ts", import.meta.url), "utf8");
const routerSource = readFileSync(
  new URL("../../backend/app/domains/runs/router.py", import.meta.url),
  "utf8",
);

test("stock details loads cursor-paginated durable history", () => {
  assert.match(source, /apiService\.getFinalActionableHistory\(/);
  assert.match(source, /Load older suggestions/);
  assert.match(apiSource, /finalActionableHistory\(\)/);
  assert.match(routerSource, /"\/final-actionables\/history"/);
});

test("historical cache merges rather than replacing older rows", () => {
  assert.match(source, /HISTORICAL_ACTION_ROWS_CACHE_VERSION = 2/);
  assert.match(source, /mergeHistoricalActionRows\(\s*rows,\s*readHistoricalActionRowsCache\(market\)/);
  assert.match(source, /mergeHistoricalActionRows\(historicalRows, readHistoricalActionRowsCache\(market\)\)/);
});

test("dashboard remains bounded while history persists separately", () => {
  assert.match(source, /DASHBOARD_RECENT_RUN_DETAIL_LIMIT = 24/);
  assert.match(source, /apiService\.saveFinalActionableHistory\(/);
  assert.match(source, /queueFinalActionableHistoryBackfill\(/);
});

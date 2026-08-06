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
const persistenceSource = readFileSync(
  new URL("../../backend/app/domains/runs/final_actionable_history.py", import.meta.url),
  "utf8",
);
const taskSource = readFileSync(
  new URL("../../backend/app/domains/runs/tasks.py", import.meta.url),
  "utf8",
);

test("stock details loads cursor-paginated durable history", () => {
  assert.match(source, /apiService\.getFinalActionableHistory\(/);
  assert.match(source, /Load older suggestions/);
  assert.match(apiSource, /finalActionableHistory\(\)/);
  assert.match(routerSource, /"\/final-actionables\/history"/);
  assert.match(routerSource, /"\/final-actionables\/history\/backfill"/);
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
  assert.match(source, /getCurrentPersistableHistoryRows\(/);
  assert.match(persistenceSource, /on_conflict_do_update\(/);
  assert.match(persistenceSource, /payload_defaults = \{/);
  assert.match(persistenceSource, /source_ids = \{/);
  assert.match(taskSource, /FINAL_ACTIONABLE_HISTORY_BACKFILL_TTL_SECONDS = 365/);
});

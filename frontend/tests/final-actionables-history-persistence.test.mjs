import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../app/console/_components/FinalActionablesConsole.tsx", import.meta.url),
  "utf8",
);
const apiSource = readFileSync(new URL("../services/api.ts", import.meta.url), "utf8");
const operationalErrorSource = readFileSync(
  new URL("../components/shared/OperationalErrorNotice.tsx", import.meta.url),
  "utf8",
);
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
const migrationSource = readFileSync(
  new URL("../../backend/alembic/versions/b5c6d7e8f9g0_add_final_actionable_history.py", import.meta.url),
  "utf8",
);

test("stock details loads cursor-paginated durable history", () => {
  assert.match(source, /apiService\.getFinalActionableHistory\(/);
  assert.match(source, /Load older suggestions/);
  assert.match(apiSource, /finalActionableHistory\(\)/);
  assert.match(routerSource, /"\/final-actionables\/history"/);
  assert.match(routerSource, /"\/final-actionables\/history\/backfill"/);
  assert.match(apiSource, /FINAL_ACTIONABLE_HISTORY_READ_TIMEOUT_MS = 20_000/);
  assert.match(
    apiSource,
    /finalActionableHistory\(\)\}\?\$\{query\.toString\(\)\}`,[\s\S]*?timeoutMs: FINAL_ACTIONABLE_HISTORY_READ_TIMEOUT_MS/,
  );
});

test("captured-detail failures are independently recoverable and explain how to fix them", () => {
  assert.match(source, /<OperationalErrorNotice/);
  assert.match(operationalErrorSource, /function OperationalErrorNotice\(/);
  assert.match(operationalErrorSource, /Why this happened/);
  assert.match(operationalErrorSource, /Technical detail/);
  assert.match(operationalErrorSource, /Steps to fix/);
  assert.match(operationalErrorSource, /Retry now/);
  assert.match(source, /Promise\.allSettled\(\[/);
  assert.match(apiSource, /CAPTURED_DETAILS_READ_TIMEOUT_MS = 20_000/);
});

test("historical cache merges rather than replacing older rows", () => {
  assert.match(source, /HISTORICAL_ACTION_ROWS_CACHE_VERSION = 4/);
  assert.match(source, /mergeHistoricalActionRows\(\s*rows,\s*readHistoricalActionRowsCache\(market\)/);
  assert.match(source, /mergeHistoricalActionRows\(historicalRows, readHistoricalActionRowsCache\(market\)\)/);
  assert.match(source, /new Set\(persistedHistory\.map\(\(item\) => item\.rebalance_run_id\)\)/);
  assert.doesNotMatch(source, /action: currentRow\.formulaAction/);
  assert.doesNotMatch(source, /score: currentRow\.formulaScore/);
  assert.doesNotMatch(source, /buildCanonicalCurrentHistoryRows/);
});

test("dashboard remains bounded while history persists separately", () => {
  assert.match(source, /DASHBOARD_RECENT_RUN_DETAIL_LIMIT = 24/);
  assert.doesNotMatch(source, /apiService\.saveFinalActionableHistory\(/);
  assert.doesNotMatch(source, /queueFinalActionableHistoryBackfill\(/);
  assert.doesNotMatch(source, /function buildCanonicalCurrentHistoryRows\(/);
  assert.match(taskSource, /if is_rebalance_run\(run\):\s*backfill_final_actionable_history_task\.delay\(run\.user_id\)/);
  assert.match(persistenceSource, /on_conflict_do_update\(/);
  assert.match(
    persistenceSource,
    /excluded\.formula_version == "score-matrix-v1"[\s\S]*?FinalActionableHistory\.formula_version\.in_\([\s\S]*?"legacy-backfill-v1", "score-matrix-v1"/,
  );
  assert.match(persistenceSource, /payload_defaults = \{/);
  assert.match(persistenceSource, /source_ids = \{/);
  assert.match(taskSource, /FINAL_ACTIONABLE_HISTORY_BACKFILL_TTL_SECONDS = 365/);
  assert.match(migrationSource, /uq_final_actionable_history_run_stock/);
  assert.doesNotMatch(
    migrationSource,
    /"stock_symbol",\s*"formula_version",\s*name="uq_final_actionable_history/,
  );
});

test("history coverage toggle filters display without changing saved evidence", () => {
  const filterBody = source.match(/const displayedPersistedHistory = useMemo\(\s*\(\) => ([\s\S]*?),\s*\[persistedHistory, showUncoveredHistory\]/)?.[1];
  assert.ok(filterBody, "history display filter must exist");
  const selectRows = new Function("persistedHistory", "showUncoveredHistory", "return (" + filterBody + ");");
  const rows = Object.freeze([
    Object.freeze({ id: 1, coverage_status: "suggested", score: 2.67 }),
    Object.freeze({ id: 2, coverage_status: "run_failed", score: null }),
    Object.freeze({ id: 3, coverage_status: "not_mentioned", score: null }),
  ]);
  assert.deepEqual(selectRows(rows, false), [rows[0]]);
  assert.equal(selectRows(rows, false)[0], rows[0]);
  assert.equal(selectRows(rows, true), rows);
  assert.deepEqual(selectRows(rows.slice(1), false), []);
  assert.deepEqual(selectRows([], false), []);
  assert.match(source, /\[showUncoveredHistory, setShowUncoveredHistory\] = useState\(false\)/);
  assert.match(source, /setPersistedHistory\(\[\]\);\s*setShowUncoveredHistory\(false\);/);
});

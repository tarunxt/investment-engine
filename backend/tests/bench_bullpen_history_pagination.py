"""Execute synthetic PostgreSQL pagination plans without production access.

Run with a separately installed @electric-sql/pglite module:
  PYTHONPATH=backend python backend/tests/bench_bullpen_history_pagination.py \
    /path/to/node_modules/@electric-sql/pglite/dist/index.js

The dependency is test-only; no repository or production packages are changed.
All tables and fixtures exist solely in an ephemeral in-memory PostgreSQL DB.
"""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile

import conftest  # noqa: F401 - use deterministic, non-production test configuration
from sqlalchemy import desc, select
from sqlalchemy.dialects import postgresql
from sqlalchemy.schema import CreateTable

from app.domains.polymarket_auto_live.console_projection import build_run_console_projection
from app.domains.polymarket_auto_live.models import PolymarketAutoLiveRunRecord
from test_polymarket_auto_live_console_projection import _large_run
from test_polymarket_auto_live_history_pagination import capture_history_query, compile_query


def main() -> None:
    module = Path(sys.argv[1]).resolve()
    if not module.is_file():
        raise SystemExit("Provide the installed PGlite dist/index.js module path.")
    record = PolymarketAutoLiveRunRecord
    cases = []
    for page in (1, 2, 5):
        session, _ = capture_history_query(page=page)
        bounded = session.statements[1]
        # Reconstruct the pre-fix query using the exact same response columns.
        baseline = (
            select(*bounded.selected_columns)
            .select_from(record)
            .where(record.user_id == 7)
            .order_by(desc(record.started_at), desc(record.created_at))
            .offset((page - 1) * 50)
            .limit(50)
        )
        cases.append({
            "page": page,
            "baseline": compile_query(baseline),
            "bounded": compile_query(bounded),
        })
    config = {
        "module": module.as_uri(),
        "create_table": str(CreateTable(record.__table__).compile(
            dialect=postgresql.dialect(),
        )),
        "projection": build_run_console_projection(_large_run()),
        "cases": cases,
    }
    with tempfile.TemporaryDirectory(prefix="bullpen-history-bench-") as directory:
        path = Path(directory) / "fixtures.json"
        path.write_text(json.dumps(config))
        subprocess.run(
            ["node", "--input-type=module", "-", str(path)],
            input=NODE_BENCHMARK,
            text=True,
            check=True,
        )


NODE_BENCHMARK = r"""
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { PGlite } = await import(config.module);
const db = new PGlite();
await db.exec('CREATE TABLE users (id integer PRIMARY KEY); INSERT INTO users VALUES (7);');
await db.exec(config.create_table);
await db.query(`INSERT INTO polymarket_auto_live_runs
  (id, user_id, status, triggered_by, dry_run, started_at, summary,
   live_execution_requested, live_execution_attempted, decisions_count,
   orders_planned, orders_submitted, console_projection, payload, created_at, updated_at)
  SELECT 'run-' || id, 7, 'completed', 'manual', true,
    now() - id * interval '1 minute', 'Synthetic history fixture',
    false, false, 0, 0, 0, $1::json, '{}'::json, now(), now()
  FROM generate_series(1, 300) id`, [JSON.stringify(config.projection)]);
function historyProjectionLoops(plan) {
  if (plan['Node Type'] === 'Function Scan' && plan.Alias === 'history_run') {
    return plan['Actual Loops'];
  }
  return (plan.Plans ?? []).reduce((total, child) => total + historyProjectionLoops(child), 0);
}
for (const entry of config.cases) {
  let expected;
  for (const name of ['baseline', 'bounded']) {
    const started = performance.now();
    const result = await db.query(entry[name]);
    const elapsed = performance.now() - started;
    assert.equal(result.rows.length, 50);
    if (name === 'baseline') expected = result.rows;
    else assert.deepEqual(result.rows, expected, 'all history response fields and ordering match');
    const explain = await db.query('EXPLAIN (ANALYZE, FORMAT JSON) ' + entry[name]);
    const loops = historyProjectionLoops(explain.rows[0]['QUERY PLAN'][0].Plan);
    assert.equal(loops, name === 'baseline' ? entry.page * 50 : 50);
    console.log(JSON.stringify({
      query: name, page: entry.page, rows: result.rows.length,
      projection_evaluations: loops, elapsed_ms: Math.round(elapsed),
    }));
  }
}
await db.close();
"""


if __name__ == "__main__":
    main()

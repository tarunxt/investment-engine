import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const card = readFileSync(
  new URL("../app/console/trading-bots/_components/UniversalScanAutoRunCard.tsx", import.meta.url),
  "utf8",
);
const shared = readFileSync(
  new URL("../app/console/trading-bots/_components/UniversalPolymarketScan.tsx", import.meta.url),
  "utf8",
);
const celery = readFileSync(
  new URL("../../backend/app/infrastructure/messaging/celery_app.py", import.meta.url),
  "utf8",
);

test("Universal Scan renders its isolated Bullpen-style auto-run controls", () => {
  assert.match(shared, /<UniversalScanAutoRunCard onStatusChange=/);
  assert.match(card, /History/);
  assert.match(card, /Start Auto Run Now/);
  assert.match(card, /autoRunEnabled \? "Run Now" : "Start Auto Run Now"/);
  assert.match(card, /Enable Auto Run/);
  assert.match(card, /"Pause"/);
  assert.match(card, /"Kill"/);
  assert.match(card, /events scanned/);
  assert.match(card, /progressPercent/);
  assert.match(card, /Auto-run start time \(IST\)/);
  assert.match(card, /Refresh duration/);
  assert.match(card, /Next scheduled run/);
  assert.match(card, /Last failed run/);
  assert.doesNotMatch(card, /Mode: Universal scan only/);
  assert.doesNotMatch(card, /Status: \{status/);
  assert.match(card, /Status last checked/);
  assert.match(card, /Refreshes status only; no scan is started/);
  assert.match(card, /Universal Scan auto-run error details/);
  assert.match(card, /How to fix:/);
  assert.doesNotMatch(card, /Auto Runs Started at/);
  assert.doesNotMatch(shared, /One Full Universe capture/);
  assert.match(shared, /Last Universal Scan/);
  assert.doesNotMatch(shared, /Last stage run/);
  assert.match(shared, /Started: \{dateLabel\(snapshot\.scannedAt\)\}/);
  assert.match(shared, /Completed\/Failed:/);
  assert.doesNotMatch(shared, />Original<\/button>/);
  assert.match(shared, /status\.last_completed_at/);
  assert.match(shared, /border-emerald-200 bg-emerald-50/);
  assert.match(card, /const autoRunEnabled = Boolean\(status\?\.enabled \|\| status\?\.running\)/);
});

test("Universal Scan uses a dedicated recurring worker task", () => {
  assert.match(celery, /enqueue_due_universal_polymarket_scans/);
  assert.match(celery, /execute_universal_polymarket_scan/);
});

test("Start Auto Run Now enables an immediate run without re-anchoring the recurring schedule", () => {
  const router = readFileSync(
    new URL("../../backend/app/domains/trading_bots/router.py", import.meta.url),
    "utf8",
  );
  assert.match(router, /enabled=True/);
  assert.match(router, /start_at=request\.start_at if request else None/);
  assert.doesNotMatch(router, /start_at=utc_now\(\)/);
  assert.match(router, /background_tasks\.add_task/);
  assert.match(router, /dispatch_universal_scan/);
  assert.match(card, /savesSchedule = action === "run-now" \|\| action === "enable"/);
  assert.match(card, /\{ startAt, refreshMinutes \}/);
  assert.match(card, /Save schedule/);
});

test("Universal Scan proxy preserves backend failures for clickable diagnostics", () => {
  const route = readFileSync(
    new URL("../app/api/universal-polymarket-scan/auto-run/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /BackendRuntimeHttpError/);
  assert.match(route, /Backend returned HTTP/);
  assert.match(route, /status: error\.status/);
  assert.match(route, /status: 502/);
  assert.match(route, /TRANSIENT_BACKEND_STATUSES/);
  assert.match(route, /attempt < 3/);
});

test("queueing stays fast and reuses the prior completed total for progress", () => {
  const scheduler = readFileSync(
    new URL("../../backend/app/domains/trading_bots/universal_scan.py", import.meta.url),
    "utf8",
  );
  assert.match(scheduler, /"estimated_total_events": state\["last_total_events"\]/);
  assert.doesNotMatch(scheduler, /def latest_export_total/);
  assert.match(scheduler, /UniversalScanStateRecord/);
  assert.doesNotMatch(scheduler, /PolymarketAutoLiveStateRecord/);
  const statusBody = scheduler.slice(
    scheduler.indexOf("def status_for_user"),
    scheduler.indexOf("def update_schedule"),
  );
  assert.doesNotMatch(statusBody, /latest_completed_universal_export/);
});

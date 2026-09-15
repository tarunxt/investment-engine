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
  assert.match(shared, /<UniversalScanAutoRunCard\s*\/>/);
  assert.match(card, /History/);
  assert.match(card, /Start Auto Run Now/);
  assert.match(card, /Enable Auto Run/);
  assert.match(card, /"Pause"/);
  assert.match(card, /"Kill"/);
  assert.match(card, /events scanned/);
  assert.match(card, /progressPercent/);
  assert.match(card, /Auto-run start time \(IST\)/);
  assert.match(card, /Refresh duration/);
  assert.match(card, /Next scheduled run/);
  assert.match(card, /Last failed run/);
  assert.match(card, /Mode: Universal scan only/);
});

test("Universal Scan uses a dedicated recurring worker task", () => {
  assert.match(celery, /enqueue_due_universal_polymarket_scans/);
  assert.match(celery, /execute_universal_polymarket_scan/);
});

test("Start Auto Run Now enables and re-anchors the recurring schedule", () => {
  const router = readFileSync(
    new URL("../../backend/app/domains/trading_bots/router.py", import.meta.url),
    "utf8",
  );
  assert.match(router, /enabled=True/);
  assert.match(router, /start_at=utc_now\(\)\.replace\(microsecond=0\)\.isoformat\(\)/);
  assert.match(router, /background_tasks\.add_task/);
  assert.match(router, /dispatch_universal_scan/);
});

test("queueing stays fast and reuses the prior completed total for progress", () => {
  const scheduler = readFileSync(
    new URL("../../backend/app/domains/trading_bots/universal_scan.py", import.meta.url),
    "utf8",
  );
  assert.match(scheduler, /"estimated_total_events": state\["last_total_events"\]/);
  assert.doesNotMatch(scheduler, /def latest_export_total/);
});

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.join(__dirname, "..");
const route = fs.readFileSync(
  path.join(root, "app/api/bullpen-ai/stage-one-snapshot/route.ts"),
  "utf8",
);
const component = fs.readFileSync(
  path.join(root, "app/console/trading-bots/_components/UniversalPolymarketScan.tsx"),
  "utf8",
);
const summary = fs.readFileSync(
  path.join(root, "app/api/bullpen-ai/_lib/universalScanSummary.ts"),
  "utf8",
);

test("saved Universal scan summary hydration is bounded and resumable", () => {
  assert.match(route, /UNIVERSAL_SUMMARY_CHUNK_ROWS = 10_000/);
  assert.match(route, /summary-progress\.json/);
  assert.match(route, /start: buildState\.byteOffset/);
  assert.match(route, /summary\.checkpoint\(\)/);
  assert.match(route, /universalSummaryProgress/);
  assert.match(summary, /UniversalScanSummaryCheckpoint/);
  assert.match(summary, /checkpoint\(\): UniversalScanSummaryCheckpoint/);
});

test("saved scan details render before all breakdown chunks finish", () => {
  assert.match(component, /setSnapshot\(payload\.snapshot \?\? null\)/);
  assert.match(component, /setSummaryProgress\(payload\.universalSummaryProgress \?\? null\)/);
  assert.match(component, /Saved scan details are available/);
  assert.match(
    component,
    /summary\?\.completedAt \?\? snapshot\.sourceScanCompletedAt \?\? snapshot\.scannedAt/,
  );
  assert.doesNotMatch(component, /Scan saved\. Finalizing breakdown tables/);
});

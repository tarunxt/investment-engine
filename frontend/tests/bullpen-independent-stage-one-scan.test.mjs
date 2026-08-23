import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const cardSource = fs.readFileSync(
  new URL(
    "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
    import.meta.url,
  ),
  "utf8",
);
const pageSource = fs.readFileSync(
  new URL(
    "../app/console/bullpen-ai/_components/BullpenAiPageClient.tsx",
    import.meta.url,
  ),
  "utf8",
);
const routeSource = fs.readFileSync(
  new URL("../app/api/bullpen-ai/route.ts", import.meta.url),
  "utf8",
);

test("Stage 1 exposes isolated Original, saved scan, and rescan controls", () => {
  assert.match(cardSource, />\s*Original\s*</);
  assert.match(cardSource, /Scan dated \{formatIstDateTime/);
  assert.match(cardSource, /isIndependentStageOneScanning \? "Scanning" : "Scan"/);
  assert.match(cardSource, /border-red-700 bg-red-600/);
  assert.match(cardSource, /border-blue-700 bg-blue-600/);
  assert.match(cardSource, /border-emerald-700 bg-emerald-600/);
});

test("independent Stage 1 scan overwrites only its persisted snapshot", () => {
  assert.match(pageSource, /archivePrevious: false/);
  assert.match(pageSource, /onRunIndependentStageOne/);
  assert.match(pageSource, /console_min_market_odds/);
  assert.match(pageSource, /filtersOverride: independentFilters/);
  assert.doesNotMatch(
    cardSource,
    /handleIndependentStageOneScan[\s\S]{0,500}handleInvestOnly/,
  );
});

test("independent scan retains filtered rows and reasons for Stage 1 output dialogs", () => {
  assert.match(routeSource, /rejectedQuestions/);
  assert.match(routeSource, /getFilterReasons/);
  assert.match(routeSource, /Gamma supplemented the scan/);
  assert.match(routeSource, /stage1-scan-preview/);
  assert.match(routeSource, /createBackendSessionContext\(request\)/);
  assert.match(routeSource, /fetchBackendJsonWithSession/);
  assert.match(cardSource, /scannedCandidates: \[\.\.\.acceptedCandidates, \.\.\.rejectedCandidates\]/);
  assert.match(cardSource, /independent_stage1_scan: true/);
});


test("Stage 1 scans the complete active Gamma universe before applying filters", () => {
  assert.match(routeSource, /GAMMA_EVENT_PAGE_SIZE = 100/);
  assert.match(routeSource, /GAMMA_EVENT_PAGE_CONCURRENCY = 32/);
  assert.match(routeSource, /POLYMARKET_GAMMA_EVENTS_URL/);
  assert.match(routeSource, /end_date_min: currentUniverseStart/);
  assert.match(routeSource, /const effectivePageSize = firstPage\.length/);
  assert.match(routeSource, /Promise\.all\(offsets\.map\(fetchEventPage\)\)/);
  assert.match(routeSource, /toArray\(event\.markets\)/);
  assert.doesNotMatch(routeSource, /DISCOVER_FALLBACK_LIMIT/);
  assert.doesNotMatch(routeSource, /earliestOutsideWindow/);
  assert.doesNotMatch(routeSource, /order: "endDate"/);
  assert.match(routeSource, /previewIsComplete/);
  assert.match(routeSource, /previewSourceLabel\.includes\(GAMMA_SOURCE_LABEL\)/);
  assert.match(routeSource, /scanned the complete active universe/);
});


test("independent Stage 1 allows the exhaustive catalog scan to finish", () => {
  assert.match(pageSource, /BULLPEN_SCAN_REQUEST_TIMEOUT_MS = 90_000/);
  assert.match(
    pageSource,
    /fetchBullpenUiJson<ScanResult>[\s\S]{0,500}BULLPEN_SCAN_REQUEST_TIMEOUT_MS/,
  );
});


test("independent Stage 1 starts the complete Gamma scan before backend recovery", () => {
  const primaryGammaIndex = routeSource.indexOf(
    "const primaryGammaCandidates = await fetchGammaMarkets()",
  );
  const backendPreviewIndex = routeSource.indexOf(
    "const backendSession = await createBackendSessionContext(request)",
  );
  assert.ok(primaryGammaIndex > 0);
  assert.ok(backendPreviewIndex > primaryGammaIndex);
  assert.match(routeSource, /complete current universe/);
});

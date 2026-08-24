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
  assert.match(cardSource, /scannedCandidates: \[\.\.\.acceptedCandidates, \.\.\.rejectedCandidates\]/);
  assert.match(cardSource, /independent_stage1_scan: true/);
});


test("Stage 1 scans the complete active Gamma universe before applying filters", () => {
  assert.match(routeSource, /POLYMARKET_GAMMA_EVENTS_URL/);
  assert.doesNotMatch(routeSource, /active: "true"/);
  assert.match(routeSource, /end_date_min: window\.start/);
  assert.match(routeSource, /end_date_max: window\.end/);
  assert.match(routeSource, /buildGammaScanWindows/);
  assert.match(routeSource, /let spanYears = 1/);
  assert.match(routeSource, /spanYears = Math\.min\(spanYears \* 2, 32\)/);
  assert.match(routeSource, /splitGammaScanWindow/);
  assert.match(routeSource, /response\.status === 422 && window\.offset > 0/);
  assert.match(routeSource, /toArray\(event\.markets\)/);
  assert.doesNotMatch(routeSource, /event\.active === false/);
  assert.doesNotMatch(routeSource, /market\.active === false/);
  assert.match(routeSource, /market\.closed === true/);
  assert.match(routeSource, /market\.archived === true/);
  assert.match(routeSource, /GAMMA_MARKET_NORMALIZATION_KEYS/);
  assert.doesNotMatch(routeSource, /DISCOVER_FALLBACK_LIMIT/);
  assert.match(routeSource, /scanned the complete current universe/);
});


test("independent Stage 1 allows the exhaustive catalog scan to finish", () => {
  assert.match(pageSource, /BULLPEN_SCAN_REQUEST_TIMEOUT_MS = 3_600_000/);
  assert.match(
    pageSource,
    /fetchBullpenUiJson<ScanResult>[\s\S]{0,500}BULLPEN_SCAN_REQUEST_TIMEOUT_MS/,
  );
});


test("independent Stage 1 advances a bounded parallel catalog batch per poll", () => {
  assert.match(routeSource, /__bullpenGammaScanJobs/);
  assert.match(routeSource, /status: "scanning", retryAfterMs: 250/);
  assert.match(routeSource, /GAMMA_EVENT_PAGE_SIZE = 10/);
  assert.match(routeSource, /GAMMA_PAGES_PER_POLL = 3/);
  assert.match(routeSource, /Promise\.all/);
  assert.match(routeSource, /GAMMA_PAGE_TIMEOUT_MS = 8_000/);
  assert.match(routeSource, /GAMMA_RESULT_CHUNK_SIZE = 250/);
  assert.match(routeSource, /resultChunk: true/);
  assert.match(routeSource, /result\.questions\.slice/);
  assert.match(routeSource, /phase: "evaluating"/);
  assert.match(routeSource, /evaluationCandidates = allCandidates\.slice/);
  assert.match(routeSource, /evaluatedRejectedQuestions\.push/);
  assert.match(pageSource, /receivedResultChunk/);
  assert.match(pageSource, /chunkedRejectedQuestions/);
  assert.match(routeSource, /AbortSignal\.timeout\(GAMMA_PAGE_TIMEOUT_MS\)/);
  assert.match(routeSource, /retryableFailure/);
  assert.match(routeSource, /page \* GAMMA_EVENT_PAGE_SIZE/);
  assert.match(routeSource, /fetchGammaMarketPage\(\{/);
  assert.match(routeSource, /gammaJob\.candidates\.set/);
  assert.match(routeSource, /gammaJob\.windows\.splice/);
  assert.match(routeSource, /firstRetryablePageIndex/);
  assert.match(routeSource, /completedPageCount/);
  assert.match(routeSource, /pages\.slice\(0, completedPageCount\)/);
  assert.match(
    routeSource,
    /currentWindow\.offset \+=[\s\S]{0,80}GAMMA_EVENT_PAGE_SIZE \* completedPageCount/,
  );
  assert.doesNotMatch(routeSource, /void \(async \(\) =>/);
  assert.match(pageSource, /BULLPEN_SCAN_POLL_MS = 250/);
  assert.match(pageSource, /BULLPEN_SCAN_TRANSIENT_RETRY_MS = 1_000/);
  assert.match(pageSource, /retryablePollFailure/);
  assert.match(pageSource, /unexpected token\|not valid json\|http/);
  assert.match(pageSource, /scanResponse\.response\.status !== 202/);
  assert.match(routeSource, /complete current universe/);
});

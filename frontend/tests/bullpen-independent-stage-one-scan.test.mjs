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
const downloadSource = fs.readFileSync(
  new URL(
    "../app/console/bullpen-ai/_components/bullpenStageOneExcel.ts",
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
const exportLedgerSource = fs.readFileSync(
  new URL(
    "../app/api/bullpen-ai/_lib/stageOneGammaExport.ts",
    import.meta.url,
  ),
  "utf8",
);
const latestSnapshotRouteSource = fs.readFileSync(
  new URL(
    "../app/api/bullpen-ai/stage-one-snapshot/route.ts",
    import.meta.url,
  ),
  "utf8",
);
const stageOneSettingsSource = fs.readFileSync(
  new URL("../lib/bullpenStageOneSettings.ts", import.meta.url),
  "utf8",
);

test("Stage 1 exposes isolated Original, saved scan, and rescan controls", () => {
  assert.match(cardSource, />\s*Original\s*</);
  assert.match(cardSource, /Partial scan dated/);
  assert.match(cardSource, /independentScanSnapshot\.totalCandidates\.toLocaleString/);
  assert.match(cardSource, /isIndependentStageOneScanning \? "Scanning" : "Scan"/);
  assert.match(cardSource, /border-red-700 bg-red-600/);
  assert.match(cardSource, /border-blue-700 bg-blue-600/);
  assert.match(cardSource, /border-emerald-700 bg-emerald-600/);
  assert.match(cardSource, /isIndependentStageOneActive[\s\S]{0,200}\? "yellow"/);
  assert.match(cardSource, /displayedStageTimerStartedAt/);
});

test("active independent Stage 1 scan is cancellable and resets its timer", () => {
  assert.match(cardSource, /independentStageOneAbortControllerRef/);
  assert.match(cardSource, /independentStageOneAbortControllerRef\.current\?\.abort\(\)/);
  assert.match(cardSource, /aria-label=[\s\S]{0,200}"Stop Stage 1 scan"/);
  assert.doesNotMatch(
    cardSource,
    /onClick=\{\(\) => void handleIndependentStageOneScan\(\)\}[\s\S]{0,120}disabled=\{isIndependentStageOneScanning\}/,
  );
  assert.match(cardSource, /setIndependentStageOneStartedAt\(new Date\(\)\.toISOString\(\)\)/);
  assert.match(cardSource, /setIndependentStageOneStartedAt\(null\)/);
  assert.match(pageSource, /signal\?: AbortSignal/);
  assert.match(pageSource, /const scanAbortController = new AbortController\(\)/);
  assert.match(pageSource, /signal: scanSignal/);
  assert.match(pageSource, /waitForBullpenPollDelay\([\s\S]{0,120}scanSignal/);
});

test("active independent Stage 1 shows live page progress instead of stale totals", () => {
  assert.match(cardSource, /BullpenIndependentStageOneProgress/);
  assert.match(cardSource, /markets scanned · Page/);
  assert.match(cardSource, /Last update/);
  assert.match(cardSource, /Retry attempts:/);
  assert.match(cardSource, /isIndependentStageOneActive \? \(/);
  assert.match(pageSource, /completedPages \+= 1/);
  assert.match(pageSource, /options\?\.onProgress\?\./);
  assert.match(pageSource, /status: isRetryingPage \? "retrying" : "scanning"/);
  assert.match(routeSource, /retryReason/);
  assert.match(routeSource, /rate-limited this page \(HTTP 429\)/);
});

test("independent Stage 1 scan overwrites only its persisted snapshot", () => {
  assert.match(pageSource, /archivePrevious: false/);
  assert.match(pageSource, /onRunIndependentStageOne/);
  assert.match(pageSource, /applyBullpenStageOneSettings\(scanFilters, settings\)/);
  assert.match(pageSource, /getBullpenAutoLiveSettings/);
  assert.match(stageOneSettingsSource, /console_min_market_odds/);
  assert.match(stageOneSettingsSource, /console_max_closing_days/);
  assert.match(stageOneSettingsSource, /console_exclude_sports/);
  assert.match(stageOneSettingsSource, /console_only_binary_yes_no/);
  assert.doesNotMatch(
    cardSource,
    /handleIndependentStageOneScan[\s\S]{0,500}handleInvestOnly/,
  );
});

test("latest completed Stage 1 snapshot synchronizes across browsers and devices", () => {
  assert.match(exportLedgerSource, /openLatestStageOneGammaExport/);
  assert.match(latestSnapshotRouteSource, /openLatestStageOneGammaExport/);
  assert.match(latestSnapshotRouteSource, /createReadStream\(latest\.rowsPath/);
  assert.match(latestSnapshotRouteSource, /hasCachedSummary/);
  assert.match(latestSnapshotRouteSource, /cacheStageOneGammaExportSummary/);
  assert.match(latestSnapshotRouteSource, /totalCandidates: latest\.metadata\.rowCount/);
  assert.match(latestSnapshotRouteSource, /totalAcceptedQuestions: acceptedCount/);
  assert.match(latestSnapshotRouteSource, /totalRejectedQuestions: rejectedCount/);
  assert.match(latestSnapshotRouteSource, /scanExportId: latest\.metadata\.exportId/);
  assert.match(pageSource, /\/api\/bullpen-ai\/stage-one-snapshot/);
  assert.match(pageSource, /mergeLatestServerManualSnapshot/);
  assert.match(pageSource, /latestServerSnapshot\.response\.ok/);
  assert.match(pageSource, /BULLPEN_SNAPSHOT_SYNC_INTERVAL_MS = 30_000/);
  assert.match(pageSource, /document\.addEventListener\("visibilitychange"/);
  assert.match(pageSource, /window\.addEventListener\("focus"/);
  assert.match(pageSource, /server synchronization fails/);
  assert.match(
    cardSource,
    /independentScanSnapshot\.snapshotId !== stageOneResultSelection\.snapshotId[\s\S]{0,100}\? "independent"/,
  );
  assert.match(
    cardSource,
    /const showStageNumbers =[\s\S]{0,220}stageOneResultSource === "independent"[\s\S]{0,100}independentStageOneView !== null/,
  );
});

test("independent Stage 1 survives an empty dashboard refresh failure", () => {
  assert.match(
    cardSource,
    /const isTransientDashboardRead =[\s\S]{0,120}nextError === null[\s\S]{0,80}nextError === undefined/,
  );
  assert.match(
    cardSource,
    /The dashboard refresh failed without returning error details\./,
  );
  assert.doesNotMatch(cardSource, /message: formatUnknownError\(error\),/);
});

test("independent scan retains filtered rows and reasons for Stage 1 output dialogs", () => {
  assert.match(routeSource, /rejectedQuestions/);
  assert.match(routeSource, /getFilterReasons/);
  assert.match(routeSource, /getFilterReasons\(question, mode, filters\)/);
  assert.match(cardSource, /scannedCandidates: \[\.\.\.acceptedCandidates, \.\.\.rejectedCandidates\]/);
  assert.match(cardSource, /independent_stage1_scan: true/);
});


test("Stage 1 scans complete Gamma events and expands every child market", () => {
  assert.match(routeSource, /POLYMARKET_GAMMA_EVENTS_KEYSET_URL/);
  assert.match(routeSource, /GAMMA_EVENT_PAGE_SIZE = 500/);
  assert.match(routeSource, /after_cursor/);
  assert.match(routeSource, /next_cursor/);
  assert.doesNotMatch(routeSource, /end_date_min:/);
  assert.doesNotMatch(routeSource, /end_date_max:/);
  assert.match(routeSource, /getFilterReasons\(question, mode, filters\)/);
  assert.match(routeSource, /for \(const eventValue of events\)/);
  assert.match(routeSource, /for \(const marketValue of toArray\(event\.markets\)\)/);
  assert.match(routeSource, /events: \[eventWithoutMarkets\]/);
  assert.doesNotMatch(routeSource, /active: "true"/);
  assert.doesNotMatch(routeSource, /event\.active === false/);
  assert.doesNotMatch(routeSource, /market\.active === false/);
  assert.match(routeSource, /market\.closed === true/);
  assert.match(routeSource, /market\.archived === true/);
  assert.match(routeSource, /exportCandidates\.push/);
  assert.doesNotMatch(routeSource, /DISCOVER_FALLBACK_LIMIT/);
  assert.match(routeSource, /applied the configured window to child markets/);
  assert.match(routeSource, /activePositions\.map\(activePositionCandidate\)/);
  assert.match(routeSource, /forcedIdentityKeys/);
});

test("interrupted independent Stage 1 preserves its latest partial snapshot", () => {
  assert.match(pageSource, /SCAN_SNAPSHOT_MAX_ACCEPTED_ROWS = 500/);
  assert.match(pageSource, /SCAN_SNAPSHOT_MAX_REJECTED_ROWS = 500/);
  assert.match(pageSource, /receivedResultChunk && scanResponse/);
  assert.match(pageSource, /isPartial: true/);
  assert.match(pageSource, /pagesScanned: completedPages/);
  assert.match(pageSource, /totalAcceptedQuestions: chunkedQuestions\.length/);
  assert.match(pageSource, /totalRejectedQuestions: chunkedRejectedQuestions\.length/);
  assert.match(pageSource, /syncBullpenScanSnapshot\(partialSnapshot/);
  assert.match(cardSource, /snapshot\.totalRejectedQuestions/);
  assert.match(cardSource, /partial_scan: Boolean\(snapshot\.isPartial\)/);
});

test("independent Stage 1 allows the exhaustive catalog scan to finish", () => {
  assert.match(pageSource, /BULLPEN_SCAN_REQUEST_TIMEOUT_MS = 3_600_000/);
  assert.match(
    pageSource,
    /fetchBullpenUiJson<ScanResult>[\s\S]{0,500}BULLPEN_SCAN_REQUEST_TIMEOUT_MS/,
  );
});

test("saved Full Universe rows can be re-filtered without refetching Gamma", () => {
  assert.match(pageSource, /reapplyExportId/);
  assert.match(pageSource, /BULLPEN_STAGE_ONE_REAPPLY_FILTERS_EVENT/);
  assert.match(pageSource, /Reapplied filters to/);
  assert.match(routeSource, /reapplyStageOneGammaExportFilters/);
  assert.match(routeSource, /existing Full Universe data without fetching Gamma again/);
});


test("independent Stage 1 carries keyset and exhaustive-export progress in each poll", () => {
  assert.doesNotMatch(routeSource, /__bullpenGammaScanJobs/);
  assert.doesNotMatch(routeSource, /GammaScanJob/);
  assert.match(routeSource, /searchParams\.get\("scanCursor"\)/);
  assert.match(routeSource, /searchParams\.get\("scanStartedAt"\)/);
  assert.match(routeSource, /status: "scanning",\s+retryAfterMs: 250/);
  assert.match(routeSource, /GAMMA_EVENT_PAGE_SIZE = 500/);
  assert.match(routeSource, /GAMMA_PAGE_TIMEOUT_MS = 20_000/);
  assert.match(routeSource, /GAMMA_TERMINAL_CURSOR = "LTE="/);
  assert.match(routeSource, /rawNextCursor === GAMMA_TERMINAL_CURSOR/);
  assert.match(routeSource, /rawNextCursor === cursor/);
  assert.match(routeSource, /resultChunk: true/);
  assert.match(routeSource, /nextCursor/);
  assert.match(routeSource, /scanStartedAt: scannedAt/);
  assert.match(routeSource, /AbortSignal\.timeout\(GAMMA_PAGE_TIMEOUT_MS\)/);
  assert.match(routeSource, /retryableFailure/);
  assert.doesNotMatch(routeSource, /GAMMA_PAGES_PER_POLL/);
  assert.doesNotMatch(routeSource, /void \(async \(\) =>/);
  assert.match(pageSource, /let chunkedTotalCandidates = 0/);
  assert.match(pageSource, /let scanCursor: string \| null = null/);
  assert.match(pageSource, /scanParams\.set\("scanCursor", scanCursor\)/);
  assert.match(pageSource, /scanParams\.set\("scanStartedAt", scanStartedAt\)/);
  assert.match(pageSource, /scanParams\.set\("scanExportId", scanExportId\)/);
  assert.match(pageSource, /acceptedQuestionsByKey/);
  assert.match(pageSource, /canonicalKeyByIdentity/);
  assert.match(pageSource, /identityKeys\.forEach\(\(key\) => canonicalKeyByIdentity\.set/);
  assert.match(pageSource, /rejectedQuestionsByKey/);
  assert.match(pageSource, /Array\.from\(acceptedQuestionsByKey\.values\(\)\)/);
  assert.match(pageSource, /Array\.from\([\s\S]{0,80}rejectedQuestionsByKey\.values\(\)/);
  assert.doesNotMatch(pageSource, /\.\.\.acceptedQuestionsByKey\.values\(\)/);
  assert.doesNotMatch(pageSource, /\.\.\.rejectedQuestionsByKey\.values\(\)/);
  assert.match(pageSource, /method: "POST"/);
  assert.match(pageSource, /activePositions: scanActivePositions/);
  assert.match(pageSource, /totalCandidates: chunkedTotalCandidates/);
  assert.match(pageSource, /BULLPEN_SCAN_POLL_MS = 250/);
  assert.match(pageSource, /BULLPEN_SCAN_TRANSIENT_RETRY_MS = 1_000/);
  assert.match(pageSource, /retryablePollFailure/);
  assert.match(pageSource, /unexpected token\|not valid json\|http/);
  assert.match(pageSource, /scanResponse\.response\.status !== 202/);
  assert.match(routeSource, /applied the configured window to child markets/);
  assert.match(routeSource, /appendStageOneGammaExportPage/);
  assert.match(exportLedgerSource, /cleanupSupersededOwnerExports\(ownerKey\)/);
  assert.match(exportLedgerSource, /ORPHAN_EXPORT_GRACE_MS/);
  assert.match(exportLedgerSource, /isAbandonedOrphan/);
  assert.match(exportLedgerSource, /metadata\?\.ownerHash === expectedOwnerHash/);
  assert.match(exportLedgerSource, /filteredRows: join\(EXPORT_DIRECTORY/);
  assert.match(exportLedgerSource, /row\.scanStatus === "passed"/);
});

test("independent Stage 1 Excel uses its own complete export instead of a stale auto-run", () => {
  const excelSource = fs.readFileSync(
    new URL(
      "../app/api/bullpen-ai/stage-one.xlsx/route.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(cardSource, /isIndependentStageOne/);
  assert.match(cardSource, /downloadIndependentStageOneExcel\(independentExportId\)/);
  assert.match(cardSource, /onRecoverLegacyExport\?\.\("all-scanned"\)/);
  assert.match(cardSource, /!independentExportId &&\s*!onRecoverLegacyExport/);
  assert.match(cardSource, /handleIndependentStageOneScan\(exportScope\)/);
  assert.match(
    cardSource,
    /downloadIndependentStageOneExcel\([\s\S]{0,120}result\.snapshot\.scanExportId,[\s\S]{0,80}downloadScope/,
  );
  assert.match(cardSource, /downloadIndependentStageOneExcel\(independentExportId, "filtered"\)/);
  assert.match(cardSource, /onRecoverLegacyExport\?\.\("filtered"\)/);
  assert.match(cardSource, /state\.scanExportId, "filtered"/);
  assert.match(downloadSource, /new URLSearchParams\(\{ exportId, scope: exportScope \}\)/);
  assert.match(excelSource, /\.\.\.LEGACY_HEADERS, \.\.\.gammaHeaders/);
  assert.match(excelSource, /event\.\$\{key\}/);
  assert.match(excelSource, /market\.\$\{key\}/);
  assert.match(excelSource, /x-bullpen-export-rows/);
  assert.match(excelSource, /new ReadableStream<Uint8Array>/);
  assert.match(excelSource, /new ZipDeflate/);
  assert.match(excelSource, /scope === "filtered"[\s\S]{0,120}new ZipPassThrough/);
  assert.doesNotMatch(excelSource, /writeXlsxFile/);
  assert.match(excelSource, /indexedGammaHeaders/);
  assert.match(excelSource, /if \(safe === ""\) return ""/);
  assert.match(excelSource, /metadata\.eventKeys/);
  assert.match(excelSource, /metadata\.marketKeys/);
  assert.match(excelSource, /row\.scanStatus === "passed"/);
  assert.match(excelSource, /scope === "filtered" \? "Filtered Events"/);
  assert.match(excelSource, /buildWorkbookStream\(exportRowsPath, exportRowCount, indexedGammaHeaders, scope\)/);
  assert.match(excelSource, /prepareFilteredRows/);
  assert.match(excelSource, /filteredRowsPath/);
  assert.match(excelSource, /proxy never sees a long idle gap/);
  assert.doesNotMatch(excelSource, /countExportRows/);
});

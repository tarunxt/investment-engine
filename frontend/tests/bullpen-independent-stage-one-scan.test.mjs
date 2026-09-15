import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
const read = path => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const card = read("../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx");
const page = read("../app/console/bullpen-ai/_components/BullpenAiPageClient.tsx");
const shared = read("../app/console/trading-bots/_components/UniversalPolymarketScan.tsx");
const route = read("../app/api/bullpen-ai/route.ts");
const snapshotRoute = read("../app/api/bullpen-ai/stage-one-snapshot/route.ts");

test("shared scan controls live in Trading Bots, while Bullpen Stage 1 is filters only", () => {
  assert.match(shared, /Universal Polymarket Scan/);
  assert.match(shared, /Scan Now/);
  assert.match(shared, /Open latest saved Universal Polymarket Scan/);
  assert.doesNotMatch(card, />\s*Original\s*</);
  assert.match(card, /data-testid="bullpen-stage-one-filters"/);
  assert.match(card, /filtersOnly renderInteractiveRows/);
});
test("a stopped capture stays separate from completed workflow inputs", () => {
  assert.match(shared, /controller\.current\.abort\(\)/);
  assert.match(shared, /Only completed scans are available to workflows/);
  assert.match(shared, /cumulativeTotalCandidates/);
  assert.match(shared, /45 \* 60 \* 1000/);
  assert.match(shared, /Temporary scan interruption\. Retrying the current page/);
  assert.match(shared, /consecutiveFailures > 8/);
  assert.match(shared, /Scan saved\. Finalizing breakdown tables/);
});
test("Bullpen manual actions filter a shared capture with an isolated continuation ID", () => {
  assert.match(page, /params\.set\("useUniversal", "true"\)/);
  assert.match(page, /params\.set\("reapplyExportId", result\.payload\.scanExportId\)/);
  assert.match(route, /forkUniversalScan\(sessionOwner\)/);
  assert.match(route, /Universal captures cannot be filtered in place/);
  assert.match(route, /unfiltered: universal/);
});
test("filtered evidence retains source lineage and server synchronization", () => {
  assert.match(card, /source_scan_export_id: snapshot\.sourceScanExportId/);
  assert.match(card, /source_scan_completed_at: snapshot\.sourceScanCompletedAt/);
  assert.match(card, /filters_completed_at: snapshot\.filtersCompletedAt/);
  assert.match(card, /Universal Polymarket Scan:/);
  assert.match(card, /Filters run:/);
  assert.match(page, /\/api\/bullpen-ai\/stage-one-snapshot/);
  assert.match(
    page,
    /sourceScanCompletedAt: serverSnapshot\.sourceScanCompletedAt/,
  );
  assert.match(route, /sourceScanExportId: metadata\.sourceScanExportId/);
  assert.match(route, /sourceScanCompletedAt: metadata\.sourceScanCompletedAt/);
  assert.match(route, /filtersCompletedAt: metadata\.filtersCompletedAt/);
  assert.match(snapshotRoute, /openStageOneGammaExport/);
  assert.match(snapshotRoute, /sourceScanCompletedAt = source\?\.metadata\.updatedAt/);
  assert.match(snapshotRoute, /openUniversalScan\(sessionOwner\)/);
});

test("an active workflow owns its yellow Stage 1 tile and reports live progress", () => {
  assert.match(card, /selectStageOneDisplayStage/);
  assert.match(card, /const filterStage = stage/);
  assert.match(card, /setStageOneResultSource\("original"\)/);
  assert.match(card, /data-stage-state=\{isStageOneActive \? "working" : stage\.state\}/);
  assert.match(card, /data-testid="bullpen-stage-one-live-progress"/);
  assert.match(card, /scanProgressPercent/);
  assert.match(card, /Filter progress/);
  assert.match(card, /totalMarkets/);
  assert.match(
    card,
    /workflowRunForMonitor\?\.request_context\?\.console_profile\?\.scanned_at/,
  );
  assert.match(card, /universalTriggerStatus\?\.last_completed_run_started_at/);
  assert.match(card, /latestUniversalScanPredatesWorkflow/);
});

test("live run selection is isolated to the current workflow", () => {
  assert.match(card, /function runBelongsToWorkspace/);
  assert.match(card, /run\.workspace_profile \?\?/);
  assert.match(card, /runWorkspace \?\? "bullpen007"/);
  assert.match(card, /getVisibleRun\(\s*summary,\s*pendingRunId,\s*workspaceProfile/);
  assert.match(card, /runBelongsToWorkspace\(run, workspaceProfile\)/);
});

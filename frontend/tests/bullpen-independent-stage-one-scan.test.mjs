import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
const read = path => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const card = read("../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx");
const page = read("../app/console/bullpen-ai/_components/BullpenAiPageClient.tsx");
const shared = read("../app/console/trading-bots/_components/UniversalPolymarketScan.tsx");
const route = read("../app/api/bullpen-ai/route.ts");

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
  assert.match(page, /\/api\/bullpen-ai\/stage-one-snapshot/);
  assert.match(route, /sourceScanExportId: metadata\.sourceScanExportId/);
});

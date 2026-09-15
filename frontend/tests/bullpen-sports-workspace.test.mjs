import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Bullpen Sports reuses the shared Bullpen workspace", () => {
  const page = read("../app/console/bullpen-sports/page.tsx");
  const shell = read("../app/console/bullpen-ai/_components/BullpenAiPageShell.tsx");

  assert.match(page, /BullpenAiPageShell/);
  assert.match(page, /workspaceProfile="bullpen-sports"/);
  assert.match(shell, /BullpenInteractiveIsland workspaceProfile/);
  assert.match(shell, /BullpenScanFiltersPopupBridge workspaceProfile/);
});

test("Bullpen Sports owns its History and run-detail routes", () => {
  const historyPage = read("../app/console/bullpen-sports/history/page.tsx");
  const runPage = read("../app/console/bullpen-sports/runs/[runId]/page.tsx");
  const routes = read("../lib/bullpenWorkspaceRoutes.ts");
  const card = read("../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx");
  const history = read("../app/console/bullpen-ai/_components/BullpenRunHistoryScreen.tsx");
  const api = read("../services/api.ts");

  assert.match(historyPage, /workspaceProfile="bullpen-sports"/);
  assert.match(runPage, /workspaceProfile="bullpen-sports"/);
  assert.match(routes, /"\/console\/bullpen-sports"/);
  assert.match(card, /router\.push\(bullpenWorkspaceHistoryPath\(workspaceProfile\)\)/);
  assert.doesNotMatch(card, /window\.open\(bullpenWorkspaceHistoryPath\(workspaceProfile\)/);
  assert.match(card, /workspaceProfile[\s\S]*?getBullpenAutoLiveHistoryEventTrends/);
  assert.match(history, /workspaceCacheKey\(HISTORY_PAGE_CACHE_KEY, profile\)/);
  assert.match(history, /workspaceCacheKey\(EVENT_TRENDS_CACHE_KEY, profile\)/);
  assert.match(history, /bullpenWorkspaceRunPath\(workspaceProfile, run\.id\)/);
  assert.match(api, /query\.set\("workspace_profile", params\.workspaceProfile\)/);
});

test("both shared workflow screens show the three Stage 1 triggers without the legacy banner", () => {
  const card = read("../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx");
  const types = read("../types/api.ts");

  assert.match(card, /Stage 1 Trigger Monitor/);
  assert.match(card, /1 · Fresh Universal Scan/);
  assert.match(card, /2 · Start Auto Run Now/);
  assert.match(card, /3 · Scheduled Time/);
  assert.match(card, /workspaceProfile/);
  assert.match(card, /getBullpenAutoLiveHistory\([\s\S]*?workspaceProfile/);
  assert.match(types, /"universal_scan"/);
  assert.doesNotMatch(card, /Auto Runs Started/);
  assert.doesNotMatch(card, /scheduleSavedSummary/);
});

test("Bullpen Sports is directly below Bullpen 007 in navigation", () => {
  const navigation = read("../app/console/_components/sidebarNavigationConfig.ts");
  assert.match(
    navigation,
    /id: 'bullpen-ai-review'[\s\S]*?name: 'Bullpen 007'[\s\S]*?id: 'bullpen-sports'[\s\S]*?name: 'Bullpen Sports'/,
  );
});

test("workspace filters and saved snapshots are independently namespaced", () => {
  const settings = read("../lib/bullpenStageOneSettings.ts");
  const client = read("../app/console/bullpen-ai/_components/BullpenAiPageClient.tsx");
  const apiRoute = read("../app/api/bullpen-ai/route.ts");

  assert.match(settings, /scopeBullpenWorkspaceStorageKey/);
  assert.match(client, /settingsProfile/);
  assert.match(client, /params\.set\("workspaceProfile", workspaceProfile\)/);
  assert.match(apiRoute, /workflowOwner/);
  assert.match(apiRoute, /forkUniversalScan\([\s\S]*?sessionOwner/);
});

test("Bullpen Sports Excel downloads preserve the workspace owner namespace", () => {
  const client = read("../app/console/bullpen-ai/_components/BullpenAiPageClient.tsx");
  const card = read("../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx");
  const download = read("../app/console/bullpen-ai/_components/bullpenStageOneExcel.ts");
  const route = read("../app/api/bullpen-ai/stage-one.xlsx/route.ts");
  const browserRoute = read("../app/console/bullpen-ai/export-stage-one/route.ts");

  assert.match(client, /BullpenAutoRunScheduleCard[\s\S]*?workspaceProfile=\{workspaceProfile\}/);
  assert.match(card, /downloadIndependentStageOneExcel\([\s\S]*?workspaceProfile/);
  assert.match(download, /params\.set\("workspaceProfile", workspaceProfile\)/);
  assert.match(download, /\/console\/bullpen-ai\/export-stage-one\?/);
  assert.doesNotMatch(download, /\/api\/|\/downloads\/|\.xlsx\?/);
  assert.match(download, /fetch\(exportUrl,[\s\S]*?response\.blob\(\)/);
  assert.match(download, /URL\.createObjectURL\(blob\)/);
  assert.match(download, /payload\?\.error \|\| `Excel export failed/);
  assert.match(route, /workspaceProfile[\s\S]*?bullpen-sports[\s\S]*?ownerKey/);
  assert.match(route, /`\$\{sessionOwner\}:\$\{workspaceProfile\}`/);
  assert.match(browserRoute, /downloadStageOneExcel\(request\)/);
});

test("the shared popup displays and enforces sports moneyline market rules", () => {
  const bridge = read("../app/console/bullpen-ai/_components/BullpenScanFiltersPopupBridge.tsx");
  const filters = read("../lib/bullpen-ai.ts");
  const apiRoute = read("../app/api/bullpen-ai/route.ts");

  assert.match(bridge, /Sports event filters/);
  assert.doesNotMatch(bridge, /workspaceProfile === "bullpen-sports"/);
  assert.match(
    bridge,
    /Sports event filters[\s\S]*?saveFilterToggle\("excludeSports", event\.target\.checked\)[\s\S]*?Event slug/,
  );
  assert.match(bridge, /Apply \$\{SPORTS_FILTER_DETAIL\.label\} filter/);
  assert.match(bridge, /Apply Yes\/No odds thresholds filter/);
  assert.doesNotMatch(bridge, /Stage 1 scan scope/);
  assert.match(bridge, /Must not end with \"draw\"/);
  assert.match(bridge, /sports_fees_v2 or sports_fees_v3/);
  assert.match(bridge, /market\.sportsMarketType/);
  assert.match(filters, /sportsMoneylineOnly/);
  assert.match(filters, /applyYesNoOddsThresholds/);
  assert.match(apiRoute, /_eventSlug[\s\S]*?endsWith\("draw"\)/);
  assert.match(apiRoute, /sports_fees_v2[\s\S]*?sports_fees_v3/);
  assert.match(apiRoute, /_sportsMarketType[\s\S]*?moneyline/);
});

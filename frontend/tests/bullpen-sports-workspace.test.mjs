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

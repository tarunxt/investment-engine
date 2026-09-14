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

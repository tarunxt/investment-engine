import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readSource = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("interactive Bullpen workspace is always mounted without an interaction prompt", async () => {
  const source = await readSource(
    "../app/console/bullpen-ai/_components/BullpenInteractiveIsland.tsx",
  );

  assert.match(source, /data-bullpen-workspace="mounted"/);
  assert.doesNotMatch(source, /usePersistentInteractiveIsland/);
  assert.doesNotMatch(source, /Open live workspace/);
  assert.doesNotMatch(source, /Interactive workspace/);
});

test("dashboard analytics is always mounted without an interaction prompt", async () => {
  const source = await readSource(
    "../app/console/dashboard/DashboardInteractiveIsland.tsx",
  );

  assert.match(source, /data-dashboard-analytics="mounted"/);
  assert.doesNotMatch(source, /usePersistentInteractiveIsland/);
  assert.doesNotMatch(source, /Open dashboard analytics/);
  assert.doesNotMatch(source, /Charts and portfolio tools/);
});

test("interactive-island preference is durable and storage failures are non-blocking", async () => {
  const source = await readSource(
    "../app/console/_components/usePersistentInteractiveIsland.ts",
  );

  assert.match(source, /localStorage\.getItem\(storageKey\)/);
  assert.match(source, /localStorage\.setItem\(storageKey, OPEN_VALUE\)/);
  assert.match(source, /memoryOpenKeys\.add\(storageKey\)[\s\S]*localStorage\.setItem/);
  assert.match(source, /window\.addEventListener\("storage", handleStorage\)/);
  assert.match(source, /useSyncExternalStore/);
});

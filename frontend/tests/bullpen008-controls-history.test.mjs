import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

function readSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("active Bullpen 008 runs expose top-level Pause and Kill recovery controls", () => {
  const page = readSource(
    "../app/console/bullpen008/_components/Bullpen008PageClient.tsx",
  );
  const urls = readSource("../lib/urls.ts");
  const service = readSource("../services/api.ts");
  const router = readSource("../../backend/app/domains/bullpen008/router.py");

  assert.match(page, /hasActiveRun/);
  assert.match(page, /CirclePause/);
  assert.match(page, /OctagonX/);
  assert.match(page, /killBullpen008Run/);
  assert.match(urls, /polymarket\/bullpen008\/kill/);
  assert.match(service, /killBullpen008Run[\s\S]*URLs\.bullpen008\.kill/);
  assert.match(router, /@router\.post\("\/kill"/);
  assert.match(router, /celery\.control\.revoke/);
  assert.match(router, /terminate=True/);
  assert.match(router, /REDIS_PREFIX.*run.*lock/);
});

test("Bullpen 008 History uses the requested URL and isolated 008 data", () => {
  const page = readSource(
    "../app/console/bullpen008/_components/Bullpen008PageClient.tsx",
  );
  const history = readSource(
    "../app/console/bullpen008/_components/Bullpen008RunHistoryScreen.tsx",
  );
  const route = readSource("../app/console/bullpen-ai/008history/page.tsx");
  const urls = readSource("../lib/urls.ts");

  assert.match(urls, /bullpen008History: \(\) => "\/console\/bullpen-ai\/008history"/);
  assert.match(page, /<History[\s\S]*History/);
  assert.match(route, /Bullpen008RunHistoryScreen/);
  assert.match(history, /BullpenHistoryPortfolio/);
  assert.match(history, /BullpenRunHistoryContent/);
  assert.match(history, /getBullpen008Runs/);
  assert.match(history, /getBullpen008HistoryEventTrends/);
  assert.doesNotMatch(history, /getBullpenAutoLiveHistory\(/);
  assert.match(history, /Bullpen 008 Run History/);
  assert.match(history, /Bullpen 008 Shadow Runs/);
});

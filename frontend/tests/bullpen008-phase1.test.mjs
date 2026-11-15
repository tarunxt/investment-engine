import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

function readSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("Bullpen 007 and 008 routes and mutation namespaces remain separate", () => {
  const urls = readSource("../lib/urls.ts");
  const service = readSource("../services/api.ts");
  const router = readSource("../../backend/app/domains/bullpen008/router.py");

  assert.match(urls, /bullpenAi: \(\) => "\/console\/bullpen-ai"/);
  assert.match(urls, /bullpen008: \(\) => "\/console\/bullpen008"/);
  assert.match(urls, /\/polymarket\/bullpen008\/bootstrap/);
  assert.match(urls, /\/polymarket\/bullpen008\/run-once/);
  assert.match(urls, /\/polymarket\/bullpen008\/runs\/\$\{encodeURIComponent\(runId\)\}\/stages\/\$\{stageNumber\}/);
  assert.match(service, /runBullpen008Once[\s\S]*?URLs\.bullpen008\.runOnce\(\)/);
  assert.doesNotMatch(service.match(/runBullpen008Once[\s\S]*?\n  }/)?.[0] ?? "", /bullpenAutoLive/);
  assert.match(router, /prefix="\/polymarket\/bullpen008"/);
  assert.match(router, /status_code=403/);
  assert.match(router, /bullpen008_stage_detail/);
  assert.match(service, /getBullpen008Stage[\s\S]*?URLs\.bullpen008\.stage/);
});

test("Bullpen 008 is immediately below Bullpen 007 in the sidebar", () => {
  const config = readSource("../app/console/_components/sidebarNavigationConfig.ts");
  assert.match(
    config,
    /id: 'bullpen-ai-review'[\s\S]*?name: 'Bullpen 007'[\s\S]*?id: 'bullpen008'[\s\S]*?name: 'Bullpen 008'[\s\S]*?href: URLs\.routes\.console\.bullpen008\(\)/,
  );
});

test("008 page preserves the 007 shell patterns and exposes a six-stage monitor", () => {
  const page = readSource("../app/console/bullpen008/_components/Bullpen008PageClient.tsx");
  const stageDialog = readSource("../app/console/bullpen-ai/_components/BullpenAutoRunStageOutputDialog.tsx");

  for (const label of [
    "Portfolio value",
    "Investments",
    "Cash",
    "Background worker monitor",
    "Wallet positions",
    "Scan & schedule settings",
    "Run history",
    "Event Summary",
    "Returns/day formula",
    "Others",
  ]) assert.match(page, new RegExp(label));

  assert.match(page, /import \{ BullpenAutoRunStageOutputDialog \} from "\.\.\/\.\.\/bullpen-ai/);
  assert.match(page, /const STAGES = \[/);
  for (const number of [1, 2, 3, 4, 5, 6]) assert.match(page, new RegExp(`number: ${number}`));
  assert.match(page, /Exit & Rebalance Plan/);
  assert.match(page, /Execute & Reconcile/);
  assert.doesNotMatch(page, /Pending Phase 2/);
  assert.match(stageDialog, /role="dialog"/);
  assert.match(stageDialog, /aria-modal="true"/);
  assert.match(stageDialog, /event\.key === "Escape"/);
  assert.match(stageDialog, /document\.body\.style\.overflow = "hidden"/);
  assert.match(page, /BullpenScanFilterDetailsDialog/);
  assert.match(page, /BullpenReturnsPerDayFormulaDialog/);
  assert.match(page, /getBullpen008Stage\(data\.latest_run\.id, 4\)/);
  assert.match(page, /portfolioAllocations\.map/);
});

test("all Bullpen 008 internal destinations stay in the 008 route namespace", () => {
  const urls = readSource("../lib/urls.ts");
  for (const path of [
    "/console/bullpen-ai/008history",
    "/console/bullpen008/analyse-events",
    "/console/bullpen008/analyse-runs",
    "/console/bullpen008/runs/",
  ]) assert.match(urls, new RegExp(path.replaceAll("/", "\\/")));
  for (const route of [
    "../app/console/bullpen-ai/008history/page.tsx",
    "../app/console/bullpen008/history/page.tsx",
    "../app/console/bullpen008/analyse-events/page.tsx",
    "../app/console/bullpen008/analyse-runs/page.tsx",
    "../app/console/bullpen008/runs/[runId]/page.tsx",
  ]) assert.doesNotThrow(() => readSource(route));
});

test("008 cards use a responsive three-column desktop grid with narrow fallbacks", () => {
  const page = readSource("../app/console/bullpen008/_components/Bullpen008PageClient.tsx");
  const dialog = readSource("../app/console/bullpen-ai/_components/BullpenAutoRunStageOutputDialog.tsx");
  assert.match(page, /grid gap-4 lg:grid-cols-3/);
  assert.match(page, /overflow-x-auto/);
  assert.match(dialog, /max-h-\[90vh\]/);
  assert.match(dialog, /z-\[130\]/);
});

test("shared Returns/day dialog keeps 007 defaults and accepts explicit 008 callbacks", () => {
  const dialog = readSource("../app/console/bullpen-ai/_components/BullpenReturnsPerDayInfo.tsx");
  const page = readSource("../app/console/bullpen008/_components/Bullpen008PageClient.tsx");

  assert.match(dialog, /loadFormula\?: \(\) => Promise<string>/);
  assert.match(dialog, /saveFormula\?: \(formula: string\) => Promise<string>/);
  assert.match(dialog, /apiService\s*\.getBullpenAutoLiveSettings\(\)/);
  assert.match(dialog, /apiService\.updateBullpenAutoLiveSettings/);
  assert.match(page, /apiService\.getBullpen008Settings/);
  assert.match(page, /apiService\.updateBullpen008Settings/);
  assert.match(page, /loadFormula=\{loadReturnsFormula\}/);
  assert.match(page, /saveFormula=\{saveReturnsFormula\}/);
});

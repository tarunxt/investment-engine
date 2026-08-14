import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const bridgeSource = readFileSync(
  new URL(
    "../app/console/bullpen-ai/_components/BullpenScanFiltersPopupBridge.tsx",
    import.meta.url,
  ),
  "utf8",
);
const shellSource = readFileSync(
  new URL(
    "../app/console/bullpen-ai/_components/BullpenAiPageShell.tsx",
    import.meta.url,
  ),
  "utf8",
);

test("Bullpen Stage 1 Filters trigger opens a popup even when legacy scan controls are not rendered", () => {
  assert.match(
    bridgeSource,
    /button\[aria-label=\"Open scan filters\"\]/,
  );
  assert.match(bridgeSource, /setIsOpen\(true\)/);
  assert.match(bridgeSource, /aria-labelledby="bullpen-stage-one-scan-filters-title"/);
  assert.match(bridgeSource, />\s*Scan Filters\s*</);
});

test("Bullpen page shell always mounts the scan filter popup bridge", () => {
  assert.match(shellSource, /import \{ BullpenScanFiltersPopupBridge \}/);
  assert.match(shellSource, /<BullpenScanFiltersPopupBridge \/>/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const enhancerSource = readFileSync(
  new URL(
    "../app/console/bullpen008/_components/Bullpen008StageDialogCollapseEnhancer.tsx",
    import.meta.url,
  ),
  "utf8",
);
const layoutSource = readFileSync(
  new URL("../app/console/bullpen008/layout.tsx", import.meta.url),
  "utf8",
);

test("Bullpen 008 mounts collapse controls only inside its route", () => {
  assert.match(layoutSource, /Bullpen008StageDialogCollapseEnhancer/);
  assert.match(enhancerSource, /STAGE_DIALOG_PATTERN = \/\^Stage\\s\+\[1-6\]:\/i/);
  assert.match(enhancerSource, /Bullpen\\s\*008/);
});

test("Bullpen 008 stage popups support section, subsection, and nested-row collapse", () => {
  assert.match(enhancerSource, /querySelectorAll<HTMLElement>\("section"\)/);
  assert.match(enhancerSource, /isStructuredRecordCard/);
  assert.match(enhancerSource, /isRecordDetailsCard/);
  assert.match(enhancerSource, /looksLikeComplexTableRow/);
  assert.match(enhancerSource, /data-bullpen008-collapse-trigger/);
  assert.match(enhancerSource, /▴/);
  assert.match(enhancerSource, /▾/);
});

test("Bullpen 008 stage popups expose global Expand All and Collapse All behavior", () => {
  assert.match(enhancerSource, /data-bullpen008-collapse-all/);
  assert.match(enhancerSource, /Collapse All/);
  assert.match(enhancerSource, /Expand All/);
  assert.match(enhancerSource, /details\.open = shouldExpand/);
  assert.match(enhancerSource, /Collapse every section and subsection/);
  assert.match(enhancerSource, /root\.style\.padding = expanded \? "" : "8px 12px"/);
});

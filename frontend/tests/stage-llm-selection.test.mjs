import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflowSource = readFileSync(
  new URL(
    "../app/console/dashboard/_components/RebalanceWorkflowSections.tsx",
    import.meta.url,
  ),
  "utf8",
);
const panelSource = readFileSync(
  new URL("../components/shared/LlmModelSelectionPanel.tsx", import.meta.url),
  "utf8",
);
const runControlsSource = readFileSync(
  new URL("../components/shared/EventScanRunControls.tsx", import.meta.url),
  "utf8",
);

test("workflow stage selector permits only configured, compatible models", () => {
  assert.match(
    workflowSource,
    /selectionMode=\{singleSelect \? "single" : "multiple"\}/,
  );
  assert.doesNotMatch(workflowSource, /allowUnavailableModels/);
  assert.match(
    workflowSource,
    /stage === "threats" \|\| stage === "technical"/,
  );
  assert.match(
    workflowSource,
    /provider\.model_compatibility\?\.\[model\]\?\.compatible !== false/,
  );
});

test("LLM panel disables unavailable models while retaining single selection", () => {
  assert.doesNotMatch(panelSource, /allowUnavailableModels/);
  assert.match(
    panelSource,
    /provider\.model_compatibility\?\.\[model\]\?\.compatible !== false/,
  );
  assert.match(
    panelSource,
    /selectionMode === "single" \? "radio" : "checkbox"/,
  );
});

test("shared LLM picker preserves repeated selected targets through multipliers", () => {
  assert.match(runControlsSource, /function countTargetMultipliers/);
  assert.match(
    runControlsSource,
    /for \(let index = 0; index < repeatCount; index \+= 1\)/,
  );
  assert.match(
    runControlsSource,
    /selectedMultipliers=\{effectiveMultipliers\}/,
  );
  assert.match(runControlsSource, /onMultiplierChange=/);
});

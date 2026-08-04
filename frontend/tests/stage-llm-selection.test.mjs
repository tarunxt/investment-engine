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

test("workflow stage selector allows configured models regardless of availability history", () => {
  assert.match(workflowSource, /selectionMode=\{singleSelect \? "single" : "multiple"\}/);
  assert.match(workflowSource, /allowUnavailableModels/);
  assert.match(workflowSource, /stage === "threats" \|\| stage === "technical"/);
  assert.match(workflowSource, /\.filter\(\(\) => provider\.configured\)/);
});

test("LLM panel keeps unavailable models selectable when explicitly enabled", () => {
  assert.match(panelSource, /allowUnavailableModels\?: boolean/);
  assert.match(panelSource, /allowUnavailableModels \|\|/);
  assert.match(panelSource, /selectionMode === "single" \? "radio" : "checkbox"/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const bridgeSource = readFileSync(
  new URL(
    "../app/console/automated-rebalance/_components/AutomatedRebalanceReliabilityBridge.tsx",
    import.meta.url,
  ),
  "utf8",
);
const clientSource = readFileSync(
  new URL(
    "../app/console/automated-rebalance/_components/AutomatedRebalanceClient.tsx",
    import.meta.url,
  ),
  "utf8",
);

test("automated rebalance hydrates selected run details instead of requesting an oversized full run list", () => {
  assert.match(bridgeSource, /apiService\.getFullRuns = async/);
  assert.match(bridgeSource, /apiService\.getRuns\(\{[\s\S]*?summary: true/);
  assert.match(bridgeSource, /getCachedRunDetail\(item\.id, options\)/);
  assert.match(bridgeSource, /apiService\.getRun\(runId, options\)/);
  assert.doesNotMatch(bridgeSource, /window\.alert|globalThis\.alert/);
});

test("the dedicated automated-rebalance route installs the reliability bridge", () => {
  assert.match(
    clientSource,
    /<AutomatedRebalanceReliabilityBridge>[\s\S]*?<RebalanceWorkflowSections/,
  );
});

test("LLMs completed opens a keyboard-accessible provider/model details dialog", () => {
  assert.match(bridgeSource, /\^LLMs completed\\s\*:/);
  assert.match(bridgeSource, /data-auto-rebalance-llm-metric/);
  assert.match(bridgeSource, /onClickCapture=\{handleClickCapture\}/);
  assert.match(bridgeSource, /onKeyDownCapture=\{handleKeyDownCapture\}/);
  assert.match(bridgeSource, /apiService\.getAutoRebalanceHistoryDetail\(/);
  for (const heading of ["Provider", "Model", "Status", "Runtime", "Cost"]) {
    assert.match(bridgeSource, new RegExp(`>${heading}<`));
  }
});

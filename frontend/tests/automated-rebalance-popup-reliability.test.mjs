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

test("automated rebalance clamps run history and hydrates only a bounded recent set", () => {
  assert.match(bridgeSource, /const BACKEND_RUN_PAGE_LIMIT = 100;/);
  assert.match(bridgeSource, /const MAX_FULL_RUN_HYDRATION = 48;/);
  assert.match(bridgeSource, /selectRecentRunSummaries\(summaryPage\.items\)/);
  assert.match(bridgeSource, /limit: BACKEND_RUN_PAGE_LIMIT/);
  assert.match(bridgeSource, /pages: 1/);
  assert.doesNotMatch(bridgeSource, /limit: params\?\.limit/);
});

test("one slow historic run cannot reject the current automated-rebalance workflow", () => {
  assert.match(bridgeSource, /Promise\.allSettled|mapWithConcurrency/);
  assert.match(bridgeSource, /return toFallbackRun\(item\)/);
  assert.match(bridgeSource, /RUN_DETAIL_TIMEOUT_MS = 15_000/);
  assert.match(bridgeSource, /getCachedRunDetail\(item\.id, options\)/);
});

test("the dedicated automated-rebalance route installs the reliability bridge", () => {
  assert.match(
    clientSource,
    /<AutomatedRebalanceReliabilityBridge>[\s\S]*?<RebalanceWorkflowSections/,
  );
});

test("LLMs completed opens an inline provider/model dialog with layered saved-data fallbacks", () => {
  assert.match(bridgeSource, /\^LLMs completed\\s\*:/);
  assert.match(bridgeSource, /autoRebalanceLlmMetric/);
  assert.match(bridgeSource, /onClickCapture=\{handleClickCapture\}/);
  assert.match(bridgeSource, /onKeyDownCapture=\{handleKeyDownCapture\}/);
  assert.match(bridgeSource, /loadThreatFallback\(context\)/);
  assert.match(bridgeSource, /loadRecentRunFallback\(context\)/);
  assert.doesNotMatch(bridgeSource, /window\.alert|globalThis\.alert/);
  for (const heading of ["Provider", "Model", "Status", "Runtime", "Cost"]) {
    assert.match(bridgeSource, new RegExp(`>${heading}<`));
  }
});

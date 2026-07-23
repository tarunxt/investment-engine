import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL(
    "../app/console/dashboard/_components/RebalanceWorkflowSections.tsx",
    import.meta.url,
  ),
  "utf8",
);

test("auto-rebalance keeps polling active jobs until they reach a terminal status", () => {
  assert.match(
    source,
    /async function waitForRunCompletion\([\s\S]*?\) \{\s*while \(true\)/,
  );
  assert.match(
    source,
    /async function waitForThreatCompletion\([\s\S]*?\{\s*while \(true\)/,
  );
  assert.doesNotMatch(source, /MAX_RUN_POLLS|MAX_JOB_POLLS|dashboard timeout/);
});

test("auto-rebalance shows the next stage before slow dashboard refresh work", () => {
  assert.match(
    source,
    /const nextStageAfterSync = STAGE_ORDER\.find\([\s\S]*?markRunning\(portfolio, nextStageAfterSync\);/,
  );
  assert.match(
    source,
    /void onDashboardRefresh\(\)\.catch\([\s\S]*?Failed to refresh dashboard after portfolio sync/,
  );
});

test("auto-rebalance does not clear local run controls during stage handoffs", () => {
  assert.match(source, /const isWorkflowExecutingRef = useRef\(false\);/);
  assert.match(
    source,
    /if \(isWorkflowExecutingRef\.current\) return;[\s\S]*?const runningEntries = STAGE_ORDER\.flatMap/,
  );
  assert.match(source, /isWorkflowExecutingRef\.current = true;/);
  assert.match(source, /isWorkflowExecutingRef\.current = false;/);
});

test("approved downstream continuation is handled at every LLM stage", () => {
  for (const stage of ["threats", "swing", "rebalance", "technical"]) {
    assert.match(
      source,
      new RegExp(`continueAfterStageFailure\\("${stage}", error\\);`),
    );
  }
});

test("auto-rebalance idle tiles include active run progress", () => {
  assert.match(source, /function summarizeRunForIdleTile/);
  assert.match(source, /const progressStatus = \(progress\.runStatus \|\| ""\)\.toLowerCase\(\);/);
  assert.match(
    source,
    /progressStatus === "pending" \|\| progressStatus === "processing"/,
  );
  assert.match(source, /completedAt: isActiveRun \? null : getLatestRunTimestamp\(run\)/);
  assert.match(source, /activeLlms > 0/);
});

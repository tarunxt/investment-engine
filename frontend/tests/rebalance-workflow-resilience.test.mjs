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
const bridgeSource = readFileSync(
  new URL(
    "../app/console/automated-rebalance/_components/AutomatedRebalanceReliabilityBridge.tsx",
    import.meta.url,
  ),
  "utf8",
);
const recoverySource = readFileSync(
  new URL(
    "../app/console/automated-rebalance/_components/automatedRebalanceStartRecovery.ts",
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
  assert.match(source, /async function retryWorkflowRead<T>/);
  assert.match(source, /Transient auto-rebalance read failed for/);
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

test("a real stage failure is persisted and never feeds stale output to later stages", () => {
  for (const stage of ["threats", "swing", "rebalance", "technical"]) {
    assert.match(
      source,
      new RegExp(`continueAfterStageFailure\\("${stage}", error\\);`),
    );
  }
  assert.match(source, /void recordAutoRebalanceStage\([\s\S]*?"failed"/);
  assert.match(source, /Never run a later trading stage from stale output after a genuine/);
  assert.doesNotMatch(source, /promptToContinueAfterProblem/);
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

test("last completed auto-rebalance audit repopulates every idle stage tile", () => {
  assert.match(source, /function summarizeAutoRebalanceHistoryStage/);
  assert.match(source, /apiService\.getAutoRebalanceHistory\("india", \{ limit: 25 \}\)/);
  assert.match(
    source,
    /apiService\.getAutoRebalanceHistory\("indmoney_us", \{ limit: 25 \}\)/,
  );
  for (const stage of [
    "sync",
    "threats",
    "swing",
    "rebalance",
    "technical",
    "actionables",
  ]) {
    assert.match(source, new RegExp(`historyInfo\\("${stage}"\\)`));
  }
  assert.match(source, /recommended_stocks/);
  assert.match(source, /rebalance_inputs/);
  assert.match(source, /completed_provider_count/);
  assert.match(source, /estimated_cost/);
});

test("each auto-rebalance stage writes a durable audit update", () => {
  assert.match(source, /const activeAutoRebalanceMetadataRef = useRef/);
  assert.match(source, /const recordAutoRebalanceStage = useCallback/);
  assert.match(source, /apiService\.updateAutoRebalanceStage\(/);
  assert.match(source, /activeAutoRebalanceMetadataRef\.current\[portfolio\] = runMetadata/);
  assert.match(source, /activeAutoRebalanceMetadata/);
  assert.match(source, /"interrupted"/);
  assert.match(source, /"cancelled"/);
});

test("automated-rebalance history loading respects the backend limit and never fans out forever", () => {
  assert.match(bridgeSource, /const BACKEND_RUN_PAGE_LIMIT = 100;/);
  assert.match(bridgeSource, /const MAX_FULL_RUN_HYDRATION = 48;/);
  assert.match(bridgeSource, /limit: BACKEND_RUN_PAGE_LIMIT/);
  assert.match(bridgeSource, /selectRecentRunSummaries\(summaryPage\.items\)/);
  assert.match(bridgeSource, /return toFallbackRun\(item\)/);
  assert.match(bridgeSource, /pages: 1/);
  assert.doesNotMatch(bridgeSource, /limit: params\?\.limit/);
});

test("automated-rebalance LLM detail loading has threat and recent-run fallbacks without alerts", () => {
  assert.match(bridgeSource, /loadThreatFallback\(context\)/);
  assert.match(bridgeSource, /loadRecentRunFallback\(context\)/);
  assert.match(bridgeSource, /setError\(normalizeError\(reason\)\)/);
  assert.doesNotMatch(bridgeSource, /window\.alert|globalThis\.alert/);
});

test("technical output opens the exact latest run even when that run failed", () => {
  assert.match(
    source,
    /if \(stage === "technical"\)\s+return isTechnicalScanRun\(run, market\);/,
  );
  assert.match(source, /DeepSeek credits were insufficient for this run/);
  assert.match(source, /no\\s\+credits\?\\s\+remaining/);
});

test("ambiguous threat starts reconcile against durable history instead of producing Error null", () => {
  assert.match(clientSource, /installAutomatedRebalanceStartRecovery\(\);/);
  assert.match(recoverySource, /RECONCILIATION_DELAYS_MS/);
  assert.match(recoverySource, /zerodhaThreatsHistory\(\{ limit: 50 \}\)/);
  assert.match(recoverySource, /indmoneyUsThreatsHistory\(\{ limit: 50 \}\)/);
  assert.match(recoverySource, /matchesAutoRebalanceAnalysis/);
  assert.match(recoverySource, /normalizeStartError/);
  assert.match(recoverySource, /\^\(null\|undefined\)\$/i);
});
test("Zerodha Run preserves the popup user gesture and surfaces start failures", () => {
  const start = source.indexOf("const runWorkflow = useCallback");
  const end = source.indexOf("const syncPortfolioNow = useCallback", start);
  assert.ok(start >= 0 && end > start, "runWorkflow source should be present");
  const runWorkflowSource = source.slice(start, end);
  const popupIndex = runWorkflowSource.indexOf('window.open("about:blank"');
  const reservationIndex = runWorkflowSource.indexOf(
    "await reserveAutoRebalanceRunMetadata(portfolio)",
  );
  assert.ok(popupIndex >= 0, "Zerodha popup should be pre-opened");
  assert.ok(reservationIndex >= 0, "run metadata should still be reserved");
  assert.ok(
    popupIndex < reservationIndex,
    "Zerodha popup must open before the first awaited reservation so the browser does not block it",
  );
  assert.match(runWorkflowSource, /Starting Zerodha auto-rebalance/);
  assert.match(runWorkflowSource, /zerodhaPopup\?\.close\(\)/);
  assert.match(runWorkflowSource, /Could not start \$\{/);
  assert.match(runWorkflowSource, /window\.alert\(message\)/);
  assert.match(
    source,
    /if \(info\.error\) rows\.push\(\{ label: "Error", value: info\.error \}\);/,
  );
});

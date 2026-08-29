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
const workflowSource = readFileSync(
  new URL(
    "../app/console/dashboard/_components/RebalanceWorkflowSections.tsx",
    import.meta.url,
  ),
  "utf8",
);
const stockFlowSource = readFileSync(
  new URL(
    "../app/console/dashboard/_components/StockFlowTabs.tsx",
    import.meta.url,
  ),
  "utf8",
);
const finalActionablesSource = readFileSync(
  new URL(
    "../app/console/_components/FinalActionablesConsole.tsx",
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
  assert.match(bridgeSource, /getOrdinalModelLabels\(loaded\.jobs\)/);
  assert.match(bridgeSource, /\$\{model\} \$\{ordinal\}/);
  assert.doesNotMatch(bridgeSource, /window\.alert|globalThis\.alert/);
  for (const heading of ["Provider", "Model", "Status", "Runtime", "Cost"]) {
    assert.match(bridgeSource, new RegExp(`>${heading}<`));
  }
});

test("Actionables View Output renders the shared widget natively instead of framing the dashboard", () => {
  assert.match(
    workflowSource,
    /\["swing", "rebalance", "technical", "actionables"\]\.includes\(stage\)/,
  );
  assert.match(
    workflowSource,
    /outputDialog\.stage === "actionables"[\s\S]*?<FinalActionablesConsole[\s\S]*?portfolio=\{outputDialog\.portfolio\}[\s\S]*?market=\{outputDialog\.portfolio === "zerodha" \? "india" : "us"\}/,
  );
});

test("Actionables Calculations explicitly opens in the dedicated output widget", () => {
  assert.match(
    workflowSource,
    /setActionablesCalculationsPortfolio\(section\.portfolio\);[\s\S]*?showStageOutput\(section\.portfolio, "actionables"\)/,
  );
  assert.match(
    workflowSource,
    /openCalculationsOnMount=\{[\s\S]*?actionablesCalculationsPortfolio === outputDialog\.portfolio/,
  );
});

test("shared order previews expose the correct broker in the close action", () => {
  assert.match(
    workflowSource,
    /aria-label=\{`Close \$\{basketBrokerLabel\} basket preview`\}/,
  );
  assert.doesNotMatch(workflowSource, /aria-label="Close Zerodha basket preview"/);
});

test("stage cards keep every shortcut as an independent native button", () => {
  const tileStart = workflowSource.indexOf("function WorkflowStageTile");
  const tileEnd = workflowSource.indexOf("function ZerodhaBasketPreviewDialog", tileStart);
  const tileSource = workflowSource.slice(tileStart, tileEnd);

  assert.match(tileSource, /<article[\s\S]*?aria-label=\{`\$\{selectable/);
  assert.doesNotMatch(tileSource, /<button[\s\S]*?role="button"/);
  for (const label of [
    "Select inputs for",
    "Show duration breakdown for",
    "Open prompt for",
    "View output for",
  ]) {
    assert.match(tileSource, new RegExp(label));
  }
  assert.match(
    tileSource,
    /row\.label === "LLMs completed" && "pointer-events-auto"/,
  );
});

test("stage error details escape card stacking contexts and stay inside the viewport", () => {
  assert.match(workflowSource, /createPortal\(/);
  assert.match(workflowSource, /document\.body/);
  assert.match(workflowSource, /className="fixed z-\[200\] overflow-y-auto overscroll-contain/);
  assert.match(workflowSource, /window\.innerWidth - viewportPadding - width/);
  assert.match(workflowSource, /window\.innerHeight - viewportPadding - measuredHeight/);
  assert.match(workflowSource, /window\.addEventListener\("scroll", updatePosition, true\)/);
});

test("duplicate LLM runs retain the full denominator and receive ordinal summary labels", () => {
  assert.match(workflowSource, /totalLlms: jobs\.length/);
  assert.match(workflowSource, /getRunJobDisplayModels\(jobs\)/);
  assert.match(workflowSource, /\$\{model\} \$\{ordinal\}/);
});


test("stock-flow reloads after completed requests and hides impossible Zerodha sells", () => {
  assert.match(stockFlowSource, /fetchDashboardRecentFullRuns\(\)/);
  assert.doesNotMatch(stockFlowSource, /fetchAllFullRuns\(\)/);
  assert.match(stockFlowSource, /STOCK_FLOW_TRANSIENT_FALLBACK_MAX_AGE_MS = 5 \* 60 \* 1000/);
  assert.match(stockFlowSource, /stockFlowLastSuccessfulSources\.get\(portfolio\)/);
  assert.match(
    stockFlowSource,
    /stockFlowSourcePromises\.delete\(portfolio\);[\s\S]*?portfolioSnapshot: overview\.latest/,
  );
  assert.match(
    stockFlowSource,
    /portfolioId !== "zerodha"[\s\S]*?holding\.quantity > 0/,
  );
});

test("Zerodha basket validates sells against live holdings and labels the score scan time", () => {
  assert.match(workflowSource, /buildZerodhaHoldingUnitsMap/);
  assert.match(
    workflowSource,
    /Promise\.allSettled\(\[[\s\S]*?fetchRebalanceStockFlowSource\("zerodha"\)[\s\S]*?apiService\.zerodhaStatus\(\)[\s\S]*?apiService\.zerodhaLoginUrl\(\)/,
  );
  assert.match(
    workflowSource,
    /scoreScanCompletedAt=\{zerodhaBasketScoreScanCompletedAt\}/,
  );
  assert.match(
    workflowSource,
    /holdingUnitsBySymbol\.get\(symbol\)[\s\S]*?> 0/,
  );
  assert.match(
    workflowSource,
    /Stock score scan completed: \{formatTimestamp\(scoreScanCompletedAt\)\}/,
  );
  assert.match(
    finalActionablesSource,
    /createdAt: job\.updated_at \?\? job\.created_at/,
  );
});

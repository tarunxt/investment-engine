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
const baseWorkflowSource = readFileSync(
  new URL(
    "../app/console/dashboard/_components/RebalanceWorkflowSections.tsx",
    import.meta.url,
  ),
  "utf8",
);
const workflowSource = baseWorkflowSource + "\n" + readFileSync(new URL("../components/shared/WorkflowStageTile.tsx", import.meta.url), "utf8");
const sharedTileSource = readFileSync(new URL("../components/shared/WorkflowStageTile.tsx", import.meta.url), "utf8");
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
    /const routeUrl = getStageOutputRoute\(portfolio, stage\)/,
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
  const tileStart = sharedTileSource.indexOf("function WorkflowStageTile");
  const tileEnd = sharedTileSource.length;
  const tileSource = sharedTileSource.slice(tileStart, tileEnd);

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

test("stage errors open a compact user-invoked dialog with intact source diagnostics", () => {
  const popup = readFileSync(new URL("../components/shared/StageErrorDetails.tsx", import.meta.url), "utf8");
  assert.match(sharedTileSource, /<StageErrorDetails stageLabel=/);
  assert.doesNotMatch(sharedTileSource, /lastAutoOpenedErrorRef|setOpenErrorDetail/);
  assert.match(popup, /createPortal\(/);
  assert.match(popup, /showModal\(\)/);
  assert.match(popup, /<dialog/);
  assert.match(popup, /max-w-md/);
  assert.match(popup, /aria-haspopup="dialog"/);
  assert.match(popup, /error details for/);
  assert.match(popup, /row\.detail/);
  assert.match(popup, /detail\.providerResponseBody/);
  assert.match(popup, /detail\.traceReference/);
  assert.match(popup, /info\.jobId/);
});

test("stage failures preserve provider diagnostics and are recorded only once", () => {
  assert.match(workflowSource, /const primaryError =[\s\S]*?errorDetails\[0\]\?\.message/);
  assert.match(
    workflowSource,
    /const failureSummary = summarizeRun\(run\);[\s\S]*?\.\.\.failureSummary,[\s\S]*?lastRunId: run\.id/,
  );
  assert.match(workflowSource, /class RecordedWorkflowStageFailure extends Error/);
  assert.match(
    workflowSource,
    /throw new RecordedWorkflowStageFailure\(message, error\)/,
  );
  assert.match(
    workflowSource,
    /if \(!\(error instanceof RecordedWorkflowStageFailure\)\)/,
  );
});

test("duplicate LLM runs retain the full denominator and receive ordinal summary labels", () => {
  assert.match(workflowSource, /totalLlms: jobs\.length/);
  assert.match(workflowSource, /getRunJobDisplayModels\(jobs\)/);
  assert.match(workflowSource, /\$\{model\} \$\{ordinal\}/);
});


test("stock-flow reloads after completed requests and hides impossible Zerodha sells", () => {
  assert.match(stockFlowSource, /fetchDashboardRecentFullRuns\(/);
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
    /Last score scan: \{formatCompactStageTime\(scoreScanCompletedAt\)\}/,
  );
  assert.match(
    finalActionablesSource,
    /createdAt: job\.updated_at \?\? job\.created_at/,
  );
});

test("saved outputs use authenticated native reads and retain safe stage links without framing", () => {
  const loader = baseWorkflowSource.slice(baseWorkflowSource.indexOf("  const showStageOutput = useCallback("), baseWorkflowSource.indexOf("  const persistLlmDialogSelection"));
  assert.doesNotMatch(baseWorkflowSource, /<iframe/);
  assert.doesNotMatch(loader, /if \(routeUrl\) return|\.run\(|\.execute\(|\.sync\(/);
  assert.match(loader, /await apiService\.zerodhaThreatsLatest\(\)/);
  assert.match(loader, /await apiService\.indmoneyUsThreatsLatest\(\)/);
  assert.match(loader, /No saved threat output is available yet/);
  assert.match(loader, /savedAt = latest\?\.updated_at/);
  assert.match(loader, /Job #\$\{latest\.job_id\}/);
  assert.match(loader, /if \(requestId !== outputRequestRef\.current\) return/);
  assert.match(loader, /requestedRunId !== undefined && run\.id !== requestedRunId/);
  assert.match(baseWorkflowSource, /showStageOutput\(outputDialog\.portfolio, outputDialog\.stage, outputDialog\.requestedRunId\)/);
  const dialog = readFileSync(new URL("../components/shared/SavedOutputDialog.tsx", import.meta.url), "utf8");
  assert.match(dialog, /role="dialog" aria-modal="true" aria-labelledby/);
  assert.match(dialog, /target="_blank" rel="noopener noreferrer"/);
  assert.match(dialog, /element\.inert = true/);
  assert.match(dialog, /opener\.focus\(\)/);
  assert.match(dialog, /event\.key === "Escape"/);
  const security = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
  assert.match(security, /frame-ancestors 'none'/);
});

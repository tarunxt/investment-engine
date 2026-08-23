import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflowSource = readFileSync(
  new URL("../app/console/dashboard/_components/RebalanceWorkflowSections.tsx", import.meta.url),
  "utf8",
);
const stockFlowSource = readFileSync(
  new URL("../app/console/dashboard/_components/StockFlowTabs.tsx", import.meta.url),
  "utf8",
);

test("legacy stock-flow tabs are composed as one reusable rebalance widget", () => {
  assert.doesNotMatch(workflowSource, /ZerodhaRebalanceFlowCard|Zerodha Rebalance Flow/);
  assert.match(workflowSource, /<RebalanceStockFlowWidget/);
  assert.match(workflowSource, /buyThresholds=\{\{/);
  assert.match(stockFlowSource, /Rebalance Stock Flow/);
  assert.match(stockFlowSource, /Zerodha Rebalance Stock Flow/);
  assert.match(stockFlowSource, /IndMoney Rebalance Stock Flow/);
  assert.match(stockFlowSource, /function ZerodhaRebalanceStockFlowWidget/);
  assert.match(stockFlowSource, /function IndMoneyRebalanceStockFlowWidget/);
});

test("stock flow and basket preview share score inputs and persisted thresholds", () => {
  assert.match(stockFlowSource, /fetchAllFullRuns/);
  assert.match(stockFlowSource, /apiService\.zerodhaPortfolioOverview\(\)/);
  assert.match(stockFlowSource, /apiService\.indmoneyUsPortfolioOverview\(\)/);
  assert.match(stockFlowSource, /latestMatchingRebalanceRuns/);
  assert.match(stockFlowSource, /stockFlowSourcePromises/);
  assert.match(stockFlowSource, /fetchStockFlowSource\(portfolioId\)/);
  assert.match(stockFlowSource, /buildConsensusRows\(matchingRebalanceRuns, portfolio\.market, portfolioSnapshot, runs\)/);
  assert.match(workflowSource, /apiService\.getProfile\(\)/);
  assert.match(workflowSource, /zerodha_buy_threshold/);
  assert.match(workflowSource, /indmoney_buy_threshold/);
  assert.match(workflowSource, /apiService\.updateProfile/);
});

test("final actionables prioritize and highlight buys above the shared threshold", () => {
  assert.match(stockFlowSource, /compareFinalActionablesForThreshold\(buyThreshold\)/);
  assert.match(stockFlowSource, /isAboveBuyThreshold/);
  assert.match(stockFlowSource, /data-buy-threshold-eligible/);
  assert.match(stockFlowSource, /Above threshold/);
  assert.match(stockFlowSource, /BuyThresholdEditor/);
});

test("stock-flow tabs expose all stages and summary-detail switching", () => {
  assert.match(stockFlowSource, /Swing Scan/);
  assert.match(stockFlowSource, /Rebalance Scan/);
  assert.match(stockFlowSource, /Final Actionables/);
  assert.match(stockFlowSource, /Detailed View/);
  assert.match(stockFlowSource, /Summary View/);
  assert.match(stockFlowSource, /Final Score:/);
  assert.match(stockFlowSource, /Consensus:/);
});

test("summary view uses scrollable stage tables and standard action colours", () => {
  assert.match(stockFlowSource, /<table/);
  assert.match(stockFlowSource, /Stock Symbol/);
  assert.match(stockFlowSource, /Final Score/);
  assert.match(stockFlowSource, /sticky top-0/);
  assert.match(stockFlowSource, /overflow-auto overscroll-contain/);
  assert.match(stockFlowSource, /getStandardActionBadgeClass/);
  assert.match(stockFlowSource, /action=\{stock\.consensusAction\}/);
  assert.match(stockFlowSource, /<ActionBadge action=\{row\.formulaAction\}/);
});

test("summary preserves each LLM job output instead of only showing consensus", () => {
  assert.match(stockFlowSource, /buildStageJobOutputs/);
  assert.match(stockFlowSource, /SwingJobOutputsStage/);
  assert.match(stockFlowSource, /RebalanceJobOutputsStage/);
  assert.match(stockFlowSource, /Job #\{output\.jobId\}/);
  assert.match(stockFlowSource, /output\.actions\.get\(stock\.key\)/);
  assert.match(stockFlowSource, /Not covered/);
});

test("each auto-rebalance card opens its stock-flow subwidget in the shared dialog", () => {
  assert.match(workflowSource, /<RebalanceStockFlowTrigger/);
  assert.match(workflowSource, /setStockFlowPortfolio\(section\.portfolio\)/);
  assert.match(workflowSource, /<RebalanceStockFlowDialog/);
  assert.match(stockFlowSource, /GitCompareArrows/);
  assert.match(stockFlowSource, />\s*Stock Flow\s*</);
  assert.match(stockFlowSource, /role="dialog"/);
  assert.match(stockFlowSource, /max-w-\[96rem\]/);
});

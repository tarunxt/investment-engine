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
  assert.match(workflowSource, /<RebalanceStockFlowWidget formulaConfig=\{scoreMatrixFormulaConfig\} \/>/);
  assert.match(stockFlowSource, /Rebalance Stock Flow/);
  assert.match(stockFlowSource, /Zerodha Rebalance Stock Flow/);
  assert.match(stockFlowSource, /IndMoney Rebalance Stock Flow/);
  assert.match(stockFlowSource, /function ZerodhaRebalanceStockFlowWidget/);
  assert.match(stockFlowSource, /function IndMoneyRebalanceStockFlowWidget/);
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

test("each auto-rebalance card opens its stock-flow subwidget in the shared dialog", () => {
  assert.match(workflowSource, /<RebalanceStockFlowTrigger/);
  assert.match(workflowSource, /setStockFlowPortfolio\(section\.portfolio\)/);
  assert.match(workflowSource, /<RebalanceStockFlowDialog/);
  assert.match(stockFlowSource, /GitCompareArrows/);
  assert.match(stockFlowSource, />\s*Stock Flow\s*</);
  assert.match(stockFlowSource, /role="dialog"/);
  assert.match(stockFlowSource, /max-w-\[96rem\]/);
});

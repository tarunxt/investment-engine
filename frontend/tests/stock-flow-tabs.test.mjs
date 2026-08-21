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

test("legacy Zerodha rebalance diagram is replaced by portfolio stock-flow tabs", () => {
  assert.doesNotMatch(workflowSource, /ZerodhaRebalanceFlowCard|Zerodha Rebalance Flow/);
  assert.match(workflowSource, /<StockFlowTabs formulaConfig=\{scoreMatrixFormulaConfig\} \/>/);
  assert.match(stockFlowSource, /Zerodha Stock Flow/);
  assert.match(stockFlowSource, /IndMoney Stock Flow/);
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

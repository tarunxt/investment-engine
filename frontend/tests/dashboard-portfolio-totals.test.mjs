import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function loadTotalsModule() {
  const source = readFileSync(
    new URL(
      "../app/console/dashboard/_components/dashboardPortfolioTotals.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const loaded = { exports: {} };
  new Function("exports", "module", output)(loaded.exports, loaded);
  return loaded.exports;
}

test("India and INDmoney totals include portfolio plus cash", () => {
  const { resolvePortfolioPlusCash, convertDashboardUsdTotalToInr } =
    loadTotalsModule();
  assert.deepEqual(
    resolvePortfolioPlusCash({ portfolioValue: 155337, cashValue: 276861 }),
    { portfolioValue: 155337, cashValue: 276861, totalValue: 432198 },
  );
  assert.deepEqual(
    convertDashboardUsdTotalToInr(
      resolvePortfolioPlusCash({ portfolioValue: 5070.97, cashValue: 10 }),
      95.7547,
    ),
    { portfolioValue: 485569.21, cashValue: 957.55, totalValue: 486526.76 },
  );
});

test("Bullpen includes cash once and never double-counts an inclusive wallet value", () => {
  const { resolveBullpenPortfolioPlusCash } = loadTotalsModule();
  assert.deepEqual(
    resolveBullpenPortfolioPlusCash({
      positionsValue: 42,
      cashValue: 8,
      walletValue: 50,
    }),
    { portfolioValue: 42, cashValue: 8, totalValue: 50 },
  );
  assert.deepEqual(
    resolveBullpenPortfolioPlusCash({
      positionsValue: null,
      cashValue: 8,
      walletValue: 50,
    }),
    { portfolioValue: 42, cashValue: 8, totalValue: 50 },
  );
});

test("dashboard keeps the portfolio board and its three views", () => {
  const source = readFileSync(new URL("../app/console/dashboard/DashboardPageClient.tsx", import.meta.url), "utf8");
  assert.equal((source.match(/<h1/g) ?? []).length, 1);
  assert.doesNotMatch(source, /PortfolioCommandChart|ThreatMarketCard|StockFlowSlot|RebalanceWorkflowSections/);
  for (const label of ["Portfolio + cash", "Sources and freshness", "Refresh behaviour"]) assert.ok(source.includes(label));
});

test("USD portfolio history is converted to portfolio-plus-cash INR totals", () => {
  const { buildDashboardPortfolioTrend } = loadTotalsModule();
  const trend = buildDashboardPortfolioTrend(
    [
      ["2026-08-20T10:00:00Z", 10, 2],
      ["2026-08-21T10:00:00Z", 11, 2],
      ["2026-08-22T10:00:00Z", 12, 2],
      ["2026-08-23T10:00:00Z", 13, 2],
    ].map(([capturedAt, portfolioValue, cashValue]) => ({
      capturedAt,
      portfolioValue,
      cashValue,
    })),
    100,
  );
  assert.deepEqual(
    trend.map((point) => point.value),
    [1200, 1300, 1400, 1500],
  );
});

test("persisted server history drives Bullpen and combined charts", () => {
  const { buildPersistedDashboardTrend } = loadTotalsModule();
  const trend = buildPersistedDashboardTrend(
    [
      ["2026-08-23T18:25:00Z", 100],
      ["2026-08-24T18:25:00Z", 101],
      ["2026-08-25T18:25:00Z", 102],
      ["2026-08-26T18:25:00Z", 103],
    ].map(([captured_at, value]) => ({ captured_at, value })),
  );
  assert.deepEqual(
    trend.map((point) => point.value),
    [100, 101, 102, 103],
  );

  assert.match(sourceForDailyHistoryType(), /portfolio_history:/);
});

function sourceForDailyHistoryType() {
  return readFileSync(new URL("../types/api.ts", import.meta.url), "utf8");
}

test("dashboard selects enabled sources and keeps each latest observed component", async () => {
  const { build } = await import("esbuild");
  const { outputFiles } = await build({
    entryPoints: [new URL("../app/console/dashboard/_components/dashboardBalances.ts", import.meta.url).pathname],
    bundle: true, platform: "node", format: "esm", write: false,
  });
  const { visibleSources, indiaBalance, usBalance, balanceTotal, mergeBalances, emptyBalance, bullpenBalance } =
    await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString("base64")}`);
  assert.deepEqual(visibleSources({visible_ids:["overview","india-portfolio","us-portfolio"]},"admin"), ["zerodha","indmoney"]);
  assert.deepEqual(visibleSources({visible_ids:["bullpen-ai-review"]},"admin"), ["bullpen"]);
  assert.deepEqual(visibleSources({visible_ids:null},"user"), ["zerodha","indmoney"]);
  assert.deepEqual(visibleSources(undefined,"admin"), []);
  const old = "2026-01-01T12:00:00Z", newer = "2026-01-03T12:00:00Z";
  const us = usBalance({latest:{captured_at:newer,current_value:200,wallet_balance:null}, history:[
    {captured_at:old,current_value:150,wallet_balance:0}
  ]});
  assert.equal(balanceTotal(us),200);
  assert.deepEqual(us.cash, {value:0,at:old});
  assert.equal(us.portfolio.at,newer);
  assert.deepEqual(mergeBalances(us, emptyBalance), us);
  const india = indiaBalance({latest:null,history:[{captured_at:old,holdings_market_value:100,available_margin:30}]});
  assert.equal(balanceTotal(india),130);
  assert.equal(balanceTotal({...india, cash:null}),null);
  assert.equal(balanceTotal(bullpenBalance({positionsSource:"redis-cache", fetchedAt:newer,summary:{walletValue:100,cashBalance:20}})),100);
});

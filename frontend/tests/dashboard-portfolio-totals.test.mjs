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

test("dashboard server overview presents all three portfolio-plus-cash totals in INR", () => {
  const source = readFileSync(
    new URL("../app/console/dashboard/DashboardPageClient.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /India total \(portfolio \+ cash\)/);
  assert.match(source, /INDmoney total \(portfolio \+ cash\)/);
  assert.match(source, /Bullpen total \(portfolio \+ cash\)/);
  assert.match(source, /usdInrRate == null[\s\S]*?"Unavailable"/);
});

test("command-center heading spans above the two expanded dashboard panels", () => {
  const source = readFileSync(
    new URL("../app/console/dashboard/DashboardPageClient.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /Portfolio Command Center[\s\S]*?mt-7 grid gap-6 xl:grid-cols-2 xl:items-stretch[\s\S]*?<PortfolioCommandSummary[\s\S]*?<PortfolioCommandChart/,
  );
  assert.match(source, /refreshBullpenTile\(false\)/);
  assert.match(source, /filter\(isBullpenHistoryActivePosition\)/);
  assert.match(source, /filter\(isBullpenHistoryClaimablePosition\)/);
  assert.match(
    source,
    /bullpenSummary\?\.walletValue \?\?[\s\S]*?bullpenSummary\?\.totalValue/,
  );
});


test("portfolio command chart supports and remembers every portfolio view", () => {
  const dashboardSource = readFileSync(
    new URL("../app/console/dashboard/DashboardPageClient.tsx", import.meta.url),
    "utf8",
  );
  const chartSource = readFileSync(
    new URL(
      "../app/console/dashboard/_components/PortfolioCommandChart.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  for (const label of [
    "India portfolio value",
    "IndMoney portfolio value",
    "Bullpen portfolio value",
    "Combined portfolio value",
  ]) {
    assert.match(dashboardSource, new RegExp(label));
  }
  assert.match(chartSource, /aria-label="Choose portfolio chart"/);
  assert.match(chartSource, /dashboard-command-chart:v1:user:/);
  assert.match(chartSource, /window\.localStorage\.setItem/);
  assert.match(chartSource, /dashboard-command-chart-history:v1:user:/);
});

test("Refresh Board preserves last-known-good Bullpen and requests a live refresh", () => {
  const source = readFileSync(
    new URL("../app/console/dashboard/DashboardPageClient.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /bullpenPositions:\s*current\.bullpenPositions \?\? update\.bullpenPositions \?\? null/,
  );
  assert.match(
    source,
    /Promise\.allSettled\(\[\s*loadDashboard\(false\),\s*refreshBullpenTile\(true\),/,
  );
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

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function loadFallbackModule() {
  const source = readFileSync(
    new URL("../lib/bullpenTradeAnalysisFallback.ts", import.meta.url),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "bullpenTradeAnalysisFallback.ts",
    reportDiagnostics: true,
  });
  const errors = (compiled.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  assert.deepEqual(
    errors.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    ),
    [],
  );

  const loadedModule = { exports: {} };
  new Function("exports", "module", "require", compiled.outputText)(
    loadedModule.exports,
    loadedModule,
    () => {
      throw new Error("The fallback module must have no runtime imports.");
    },
  );
  return loadedModule.exports;
}

function validResponse() {
  return {
    items: [
      {
        id: "trade-1",
        title: "Trade one",
        status: "SOLD",
        final_tag: "PROFIT",
        pnl_outcome_tag: "PROFIT",
        is_squared_off: true,
        buy_tags: [],
      },
    ],
    summary: {
      total_executed_trades: 1,
      open_positions: 0,
      closed_positions: 1,
      total_net_pnl: 2.5,
      win_rate: 1,
      average_pnl_percent: 5,
      average_holding_period_seconds: 60,
      total_fees: 0.1,
    },
    learning_insights: {
      win_rate_by_tag: [],
      average_pnl_by_tag: [],
      total_pnl_by_strategy_version: [],
      recommendations: [],
    },
  };
}

class MemoryStorage {
  values = new Map();

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, value);
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

test("trade-analysis payload validation rejects incomplete responses", () => {
  const { isBullpenTradeAnalysisListResponse } = loadFallbackModule();
  assert.equal(isBullpenTradeAnalysisListResponse(validResponse()), true);
  assert.equal(
    isBullpenTradeAnalysisListResponse({
      ...validResponse(),
      summary: { total_executed_trades: 1 },
    }),
    false,
  );
});

test("tertiary cache is user, filter, age, and schema bounded", () => {
  const originalWindow = globalThis.window;
  globalThis.window = { sessionStorage: new MemoryStorage() };

  try {
    const {
      buildTradeAnalysisFiltersKey,
      readTradeAnalysisCache,
      writeTradeAnalysisCache,
      TRADE_ANALYSIS_CACHE_MAX_AGE_MS,
    } = loadFallbackModule();
    const filtersKey = buildTradeAnalysisFiltersKey({
      status: "SOLD",
      topic: "",
    });
    assert.equal(
      writeTradeAnalysisCache({
        userId: 7,
        filtersKey,
        data: validResponse(),
        now: 1_000,
      }),
      true,
    );
    assert.equal(
      readTradeAnalysisCache({
        userId: 7,
        filtersKey,
        now: 1_001,
      }).data.items[0].id,
      "trade-1",
    );
    assert.equal(
      readTradeAnalysisCache({
        userId: 8,
        filtersKey,
        now: 1_001,
      }),
      null,
    );

    writeTradeAnalysisCache({
      userId: 7,
      filtersKey,
      data: validResponse(),
      now: 1_000,
    });
    assert.equal(
      readTradeAnalysisCache({
        userId: 7,
        filtersKey,
        now: 1_000 + TRADE_ANALYSIS_CACHE_MAX_AGE_MS + 1,
      }),
      null,
    );
  } finally {
    globalThis.window = originalWindow;
  }
});

test("trade-analysis read path declares bounded fallback logging and no loop", () => {
  const clientSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/analyse-events/_components/TradeAnalysisListClient.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const apiSource = readFileSync(
    new URL("../services/api.ts", import.meta.url),
    "utf8",
  );

  assert.match(clientSource, /bullpen_trade_analysis_fallback_triggered/);
  assert.match(clientSource, /to_stage: "tertiary"/);
  assert.match(apiSource, /validate: isBullpenTradeAnalysisListResponse/);
  assert.doesNotMatch(clientSource, /while \(true\)/);
});

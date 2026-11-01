import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const componentPath = "../app/console/bullpen-ai/analyse-events/_components/";
const primitive = ({ children }) => React.createElement("div", null, children);
const primitives = new Proxy({}, { get: () => primitive });

function compile(path, imports) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  });
  const loadedModule = { exports: {} };
  new Function("require", "module", "exports", outputText)(
    (name) => imports[name] ?? require(name),
    loadedModule,
    loadedModule.exports,
  );
  return loadedModule.exports;
}

function harness() {
  const state = [];
  let cursor = 0;
  let effect;
  let request;
  let cached = null;
  const shared = compile(`${componentPath}tradeAnalysisShared.tsx`, {
    "@/components/ui/card": primitives,
    "@/lib/utils": { cn: (...values) => values.join(" ") },
  });
  const { TradeAnalysisListClient } = compile(
    `${componentPath}TradeAnalysisListClient.tsx`,
    {
      react: {
        ...React,
        useState(initial) {
          const index = cursor++;
          if (!(index in state)) state[index] = initial;
          return [
            state[index],
            (value) => {
              state[index] =
                typeof value === "function" ? value(state[index]) : value;
            },
          ];
        },
        useEffect(fn) {
          effect = fn;
        },
      },
      "next/link": { __esModule: true, default: primitive },
      "@/components/ui/button": primitives,
      "@/components/ui/card": primitives,
      "@/components/ui/input": primitives,
      "@/components/ui/tabs": primitives,
      "@/lib/bullpenTradeAnalysisFallback": {
        buildTradeAnalysisFiltersKey: JSON.stringify,
        readTradeAnalysisCache: () => cached,
        writeTradeAnalysisCache: () => {},
      },
      "@/lib/urls": {
        URLs: {
          routes: { console: new Proxy({}, { get: () => () => "/synthetic" }) },
        },
      },
      "@/lib/tradeAnalysisExecution": {
        tradeExecutionFill: () => ({}),
        tradeOutcomeLabel: () => "OPEN",
      },
      "@/services/api": {
        apiService: { bullpenAiTradeAnalysis: () => request },
      },
      "@/hooks/useAuth": { useAuth: () => ({ user: { id: 123 } }) },
      "./tradeAnalysisShared": shared,
    },
  );
  return {
    render() {
      cursor = 0;
      return renderToStaticMarkup(React.createElement(TradeAnalysisListClient));
    },
    start(promise, cache = null) {
      request = promise;
      cached = cache;
      return effect();
    },
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
function response(closed = 0, winRate = 0) {
  return {
    items: [],
    summary: {
      total_executed_trades: closed,
      open_positions: 0,
      closed_positions: closed,
      total_net_pnl: 0,
      total_fees: 0,
      win_rate: winRate,
    },
    learning_insights: {
      recommendations: [],
      profitable_tags: [],
      unprofitable_tags: [],
      exit_reasons_ranked_by_pnl: [],
      buy_reasons_ranked_by_pnl: [],
      average_pnl_by_confidence_bucket: [],
      average_pnl_by_liquidity_bucket: [],
    },
  };
}

test("loading and both failed transports remain unknown in both tabs and raw JSON", async () => {
  const h = harness();
  assert.match(h.render(), /Loading learning insights/);
  h.start(Promise.reject(new Error("Both analytics endpoints unavailable")));
  await tick();
  const html = h.render();
  assert.match(html, /Both analytics endpoints unavailable/);
  assert.match(html, /Executed Trades<\/div><\/div><div><div[^>]*>Unavailable/);
  assert.doesNotMatch(
    html,
    /No signals yet|No executed Bullpen|Learning Insights JSON|0%/,
  );
  assert.match(html, /Learning insights unavailable/);
});

test("verified empty results show zero counts but no win rate without closed trades", async () => {
  const h = harness();
  h.render();
  h.start(Promise.resolve(response()));
  await tick();
  const html = h.render();
  assert.match(html, /No executed Bullpen/);
  assert.match(html, /No signals yet/);
  assert.match(html, /Learning Insights JSON/);
  assert.doesNotMatch(html, /0%/);
});

test("successful zero-win denominator and populated learning values are preserved", async () => {
  const h = harness();
  h.render();
  const data = response(3, 0);
  data.learning_insights.recommendations = ["Synthetic recommendation"];
  h.start(Promise.resolve(data));
  await tick();
  const html = h.render();
  assert.match(html, /0%/);
  assert.match(html, /Synthetic recommendation/);
});

test("partial learning never turns absent categories or JSON into verified empty", async () => {
  const h = harness();
  h.render();
  const data = response(2, 0.5);
  data.learning_insights = {};
  h.start(Promise.resolve(data));
  await tick();
  const html = h.render();
  assert.match(html, /50%/);
  assert.doesNotMatch(html, /No signals yet|Learning Insights JSON/);
  assert.match(html, /Learning insights unavailable/);
});

test("dated validated cache survives failure, while unrelated old results are cleared", async () => {
  const h = harness();
  h.render();
  const data = response(2, 0.5);
  h.start(Promise.reject(new Error("Live unavailable")), {
    data,
    cachedAt: Date.UTC(2026, 0, 1),
  });
  await tick();
  assert.match(h.render(), /showing saved trade analysis from/);
  assert.match(h.render(), /50%/);
  h.start(Promise.reject(new Error("Different filters unavailable")));
  assert.match(h.render(), /Loading learning insights/);
  await tick();
  assert.doesNotMatch(h.render(), /50%|No signals yet|Learning Insights JSON/);
});

test("interrupted requests cannot replace a later result", async () => {
  const h = harness();
  h.render();
  let resolveOld;
  const cancel = h.start(
    new Promise((resolve) => {
      resolveOld = resolve;
    }),
  );
  cancel();
  h.start(Promise.resolve(response(2, 0.5)));
  await tick();
  resolveOld(response(1, 1));
  await tick();
  assert.match(h.render(), /50%/);
  assert.doesNotMatch(h.render(), /100%/);
});

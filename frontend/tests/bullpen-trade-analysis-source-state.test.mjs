import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const componentPath = "../app/console/bullpen-ai/analyse-events/_components/";
const primitive = ({ children, role }) => React.createElement("div", { role }, children);
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
    /No observations in this category|No executed Bullpen|Learning Insights JSON|0%/,
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
  assert.match(html, /No observations in this category/);
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
  assert.doesNotMatch(html, /No observations in this category|Learning Insights JSON/);
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
  assert.doesNotMatch(h.render(), /50%|No observations in this category|Learning Insights JSON/);
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


test("legacy list observations show coverage limits and do not invent confidence", async () => {
  const h = harness();
  h.render();
  const data = response(1, 0);
  data.items = [{ id: "synthetic-loss", title: "Synthetic loss", status: "SOLD", final_tag: "LOSS", pnl_outcome_tag: "LOSS", buy_tags: [], confidence: null, net_pnl: null, fees_total: null }];
  h.start(Promise.resolve(data));
  await tick();
  const html = h.render();
  assert.match(html, /Confidence: Not evaluated/);
  assert.match(html, /Net P&amp;L: —/);
  assert.match(html, /Fees: —/);
  assert.match(html, /Outcome-label and fee coverage denominators: unavailable/);
  assert.match(html, /known net P&amp;L 0\/1; known fees 0\/1/);
  assert.match(html, /Applied filters: status: All/);
  assert.match(html, /Descriptive observations only/);
});

function detailHarness() {
  const state = [];
  let cursor = 0;
  let effect;
  let request;
  let tradeId = "synthetic-one";
  const shared = compile(`${componentPath}tradeAnalysisShared.tsx`, {
    "@/components/ui/card": primitives,
    "@/lib/utils": { cn: (...values) => values.join(" ") },
  });
  const { TradeAnalysisDetailClient } = compile(`${componentPath}TradeAnalysisDetailClient.tsx`, {
    react: {
      ...React,
      useState(initial) {
        const index = cursor++;
        if (!(index in state)) state[index] = initial;
        return [state[index], (value) => { state[index] = value; }];
      },
      useEffect(fn) { effect = fn; },
      useMemo(fn) { return fn(); },
    },
    "next/navigation": { useParams: () => ({ tradeId }) },
    "next/link": { __esModule: true, default: primitive },
    "@/components/ui/button": primitives,
    "@/components/ui/card": primitives,
    "@/lib/urls": { URLs: { routes: { console: { bullpenAiAnalyseEvents: () => "/synthetic" } } } },
    "@/services/api": { apiService: { bullpenAiTradeAnalysisDetail: () => request } },
    "./tradeAnalysisShared": shared,
  });
  return {
    render() { cursor = 0; return renderToStaticMarkup(React.createElement(TradeAnalysisDetailClient)); },
    start(promise, id = tradeId) { tradeId = id; request = promise; return effect(); },
  };
}

function detailFixture() {
  return {
    trade: { id: "synthetic-one", title: "Synthetic equal-price exit", buy_price: 0.5, exit_price: 0.5, buy_confidence: null, sell_confidence: null, net_pnl: null, fees_total: null },
    comparison: { buy_price: 0.5, exit_price: 0.5, buy_confidence: null, exit_confidence: null },
    actionable_learning: {
      exit_timing: "EARLY_EXIT", llm_confidence_aligned: true,
      what_worked: [], what_went_wrong: [], suggested_platform_rule_changes: [], suggested_prompt_changes: [], suggested_risk_management_changes: [],
    },
    snapshots: [], llm_entries: [], event_logs: [],
  };
}

test("detail equal-price legacy evidence cannot assert evaluated exit advice or alignment", async () => {
  const h = detailHarness();
  assert.match(h.render(), /role="status"/);
  h.start(Promise.resolve(detailFixture()));
  await tick();
  const html = h.render();
  assert.match(html, /Exit timing: Not evaluated/);
  assert.match(html, /LLM confidence aligned: Not evaluated/);
  assert.match(html, /In-hold excursions are descriptive only/);
  assert.match(html, /Entry too expensive \(stored hypothesis\): Not evaluated/);
  assert.match(html, /Stored Learning Raw Evidence/);
  assert.match(html, /EARLY_EXIT/); // Preserved raw history, never presented as evaluated advice.
  assert.doesNotMatch(html, /Exit timing: EARLY_EXIT|LLM confidence aligned: Yes|>0%<|>\$0.00</);
});

test("detail switching records clears success and presents a failed read accessibly", async () => {
  const h = detailHarness();
  h.render();
  h.start(Promise.resolve(detailFixture()));
  await tick();
  assert.match(h.render(), /Synthetic equal-price exit/);
  h.start(Promise.reject(new Error("Synthetic unavailable")), "synthetic-two");
  assert.match(h.render(), /Loading trade lifecycle/);
  await tick();
  const html = h.render();
  assert.match(html, /role="alert"/);
  assert.match(html, /Synthetic unavailable/);
  assert.doesNotMatch(html, /Synthetic equal-price exit|Actionable Learning/);
});

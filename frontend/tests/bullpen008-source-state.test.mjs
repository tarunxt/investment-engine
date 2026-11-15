import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

// Execute the real client render and loader with inert UI dependencies and a
// controlled hook store. No network, effects, timers or mutation APIs execute.
const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../app/console/bullpen008/_components/Bullpen008PageClient.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
} }).outputText;
const element = tag => function InertComponent({ children, ...props }) { return React.createElement(tag,
  Object.fromEntries(Object.entries(props).filter(([key]) => !["variant", "inputMode", "asChild"].includes(key))), children); };

function workspace() {
  const values = [];
  let cursor = 0;
  let callbacks = [];
  const calls = [];
  let result;
  let stageResult;
  const apiService = new Proxy({}, { get: (_, name) => async (...args) => {
    calls.push(name);
    assert.ok(["getBullpen008Bootstrap", "getBullpen008Stage"].includes(name), `Unexpected action ${name}`);
    const response = name === "getBullpen008Stage" ? stageResult : result;
    if (typeof response === "function") return response(...args);
    if (response instanceof Error) throw response;
    return response;
  } });
  const hooks = { ...React,
    useState(initial) {
      const index = cursor++;
      if (!(index in values)) values[index] = initial;
      return [values[index], next => { values[index] = typeof next === "function" ? next(values[index]) : next; }];
    },
    useCallback(fn) { callbacks.push(fn); return fn; },
    useEffect() {},
    useMemo(fn) { return fn(); },
  };
  const clientModule = { exports: {} };
  function dependency(name) {
    if (name === "react") return hooks;
    if (name === "react/jsx-runtime") return require(name);
    if (name === "next/link") return { default: element("a") };
    if (name === "@/services/api") return { apiService };
    if (name === "@/lib/apiErrors") return { formatUnknownError: error => error.message };
    if (name === "@/lib/datetime") return { formatApiTimestamp: (value, options) => value || options?.emptyValue || "—" };
    if (name === "@/lib/utils") return { cn: (...values) => values.filter(Boolean).join(" ") };
    if (name === "@/lib/urls") return { URLs: { routes: { console: new Proxy({}, { get: () => () => "/synthetic" }) } } };
    if (name === "lucide-react") return new Proxy({}, { get: () => () => null });
    if (name.startsWith("@/components/ui/")) return new Proxy({}, { get: (_, key) => element(key === "Button" ? "button" : key === "Input" ? "input" : "div") });
    return new Proxy({}, { get: () => () => null });
  }
  new Function("require", "module", "exports", compiled)(dependency, clientModule, clientModule.exports);
  return {
    calls,
    response(data) { result = data; },
    stageResponse(data) { stageResult = data; },
    render() { cursor = 0; callbacks = []; return renderToStaticMarkup(clientModule.exports.Bullpen008PageClient()); },
    async load(signal) { cursor = 0; callbacks = []; clientModule.exports.Bullpen008PageClient(); await callbacks[0](signal); },
  };
}

const fixture = (overrides = {}) => ({
  settings: { custom_exclude_phrases: [], execution_mode: "shadow", closing_window_days: 30, auto_refresh_minutes: 360 },
  state: { running: false, paused: false, emergency_stop: false, execution_mode: "shadow" },
  latest_run: null, inherited_runs: [], alerts: [], risk_state: {}, ...overrides,
});
const run = (overrides = {}) => ({ id: "synthetic-run", status: "failed", stages: [], wallet_snapshot: {}, ...overrides });

test("loading and failed initial source never claim idle, zero positions, pending stages or empty history", async () => {
  const page = workspace();
  assert.match(page.render(), /Loading Bullpen 008 workspace/);
  page.response(new Error("synthetic source failure"));
  await page.load();
  const html = page.render();
  assert.match(html, /role="alert"/);
  assert.match(html, /stage progress, wallet positions, schedule, limits, warnings and run history are unavailable/);
  assert.match(html, /Retry/);
  assert.doesNotMatch(html, /Idle|0 active|pending|progress 0%|No Bullpen|Start schedule|Run six stages|Save 008 settings/);
  assert.deepEqual(page.calls, ["getBullpen008Bootstrap"]);
});

test("a true never-run response verifies history without inventing a wallet snapshot", async () => {
  const page = workspace(); page.response(fixture()); await page.load();
  const html = page.render();
  assert.match(html, /No recorded run/);
  assert.match(html, /No Bullpen runs are available yet/);
  assert.match(html, /No Bullpen 008 warning episodes/);
  assert.match(html, /Position count unavailable/);
  assert.match(html, /Wallet positions unavailable/);
  assert.match(html, /Stage 1 progress unavailable/);
  assert.doesNotMatch(html, /progress 0%|Current stage: Idle|0 active\/monitored positions/);
});

test("retained successful data survives refresh failure with explicit source provenance and recovers", async () => {
  const page = workspace();
  page.response(fixture({ latest_run: run({ wallet_snapshot: { fetched_at: "2026-01-01T00:00:00Z", positions: [{ market_id: "synthetic-market", question: "Synthetic market", exposure_usd: 12 }], balance: { status: "ready", available_balance_usd: 8 } } }), alerts: [{ id: 1, payload: { question: "Synthetic warning" }, side: "YES", breach_type: "synthetic", source: "fixture" }] }));
  await page.load();
  assert.match(page.render(), /\$20\.00/);
  page.response(new Error("refresh unavailable")); await page.load();
  const html = page.render();
  assert.match(html, /Showing the last successful response/);
  assert.match(html, /may have changed/);
  assert.match(html, /Synthetic market/);
  assert.match(html, /Synthetic warning/);
  assert.match(html, /Current stage: Failed/);
  assert.match(html, /1 positions in saved run snapshot/);
  page.response(fixture()); await page.load();
  assert.doesNotMatch(page.render(), /Showing the last successful response/);
  assert.ok(page.calls.every(name => name === "getBullpen008Bootstrap"));
});

test("loaded configuration and history remain visible when separate Stage 4 detail fails", async () => {
  const page = workspace();
  page.response(fixture({ latest_run: run({ stages: [{ stage_number: 4, status: "finished", duration_seconds: 2, stage_version: "test", outputs: { metrics: { invested: 25 } } }] }) }));
  page.stageResponse(new Error("synthetic detail failure")); await page.load();
  const html = page.render();
  assert.match(html, /Scan &amp; schedule settings/);
  assert.match(html, /Run history/);
  assert.match(html, /Stage 4 detail is unavailable/);
  assert.match(html, /Target portfolio unavailable/);
  assert.match(html, /Certified exits unavailable/);
  assert.match(html, /Stage 4 progress 100%/);
  assert.deepEqual(page.calls, ["getBullpen008Bootstrap", "getBullpen008Stage"]);
});

test("verified empty saved snapshot keeps zero values distinct from unavailable balances", async () => {
  const page = workspace();
  page.response(fixture({ latest_run: run({ wallet_snapshot: { positions: [], balance: { status: "ready", available_balance_usd: 0 } } }) })); await page.load();
  let html = page.render();
  assert.match(html, /0 positions in saved run snapshot/);
  assert.match(html, /No positions in the saved run snapshot/);
  assert.match(html, /\$0\.00/);
  page.response(fixture({ latest_run: run({ wallet_snapshot: { positions: [], balance: { status: "error", available_balance_usd: 0 } } }) })); await page.load();
  html = page.render(); assert.match(html, /Balance unavailable/); assert.match(html, /Wallet valuation unavailable/);
});

test("active runs do not turn intentionally omitted monitoring queries into no-warning claims", async () => {
  const page = workspace(); page.response(fixture({ latest_run: run({ status: "running" }) })); await page.load();
  const html = page.render();
  assert.match(html, /Risk monitoring unavailable/);
  assert.match(html, /Warning episodes are not included while a run is active/);
  assert.doesNotMatch(html, /No verified regime-change episode|No active trigger episode|No Bullpen 008 warning episodes|NOT.YET.BASELINED/);
});

test("aborted bootstrap does not publish a response or a false failure", async () => {
  const page = workspace(); const controller = new AbortController();
  page.response(() => { controller.abort(); return fixture(); }); await page.load(controller.signal);
  assert.match(page.render(), /Loading Bullpen 008 workspace/);
  assert.deepEqual(page.calls, ["getBullpen008Bootstrap"]);
});

test("successful Stage 4 detail renders retained target values without invoking any action", async () => {
  const page = workspace();
  page.response(fixture({ latest_run: run({ status: "completed", stages: [{ stage_number: 4, status: "finished", duration_seconds: 2, stage_version: "test", outputs: { metrics: { invested: 25 } } }] }) }));
  page.stageResponse({ outputs: { allocations: [{ market_id: "synthetic-target", question: "Synthetic target", target_exposure_usd: 25, proposed_buy_usd: 5, current_exposure_usd: 20 }], contingent_exit_policies: [{ affected_market_id: "synthetic-target", policy_hash: "synthetic-policy", maximum_sell_quantity: 2 }] } });
  await page.load(); const html = page.render();
  assert.match(html, /Synthetic target/);
  assert.match(html, /synthetic-policy/);
  assert.match(html, /\$25\.00/);
  assert.match(html, /Reconciled outcome/);
  assert.doesNotMatch(html, /Stage 4 detail is unavailable|Target portfolio unavailable/);
  assert.deepEqual(page.calls, ["getBullpen008Bootstrap", "getBullpen008Stage"]);
});

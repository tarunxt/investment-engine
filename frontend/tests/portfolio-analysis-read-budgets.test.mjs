import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function loadModule(path, imports = {}, suffix = "") {
  const source = readFileSync(new URL(path, import.meta.url), "utf8") + suffix;
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  new Function("exports", "module", "require", output)(
    loaded.exports, loaded, (name) => imports[name] ?? {},
  );
  return loaded.exports;
}

function loadProxyBudgets() {
  return loadModule("../app/backend-api/[...path]/route.ts", {
    "@/lib/boundedApiTransport": { ApiOriginCircuitBreaker: class {} },
  }, "\nexport { getProxyAttemptTimeoutMs, getProxyTotalTimeoutMs, getCapturedPortfolioAnalysisReadScope, getResearchHistoryReadScope };\n");
}

function loadApiService() {
  const providerUrls = (provider) => ({
    eventsLatest: () => `/backend-api/${provider}/events/latest`,
    eventsHistory: () => `/backend-api/${provider}/events/history`,
    eventJob: (id) => `/backend-api/${provider}/events/${id}`,
    threatsLatest: () => `/backend-api/${provider}/threats/latest`,
    threatsHistory: () => `/backend-api/${provider}/threats/history`,
    threatJob: (id) => `/backend-api/${provider}/threats/${id}`,
  });
  return loadModule("../services/api.ts", {
    "@/lib/urls": {
      URLs: { zerodha: providerUrls("zerodha"), indmoneyUs: providerUrls("indmoney-us"), runs: { get: (id) => `/backend-api/runs/${id}` }, providers: { list: () => "/backend-api/providers" } },
    },
    "@/lib/apiReadCircuitBreaker": loadModule("../lib/apiReadCircuitBreaker.ts"),
    "@/lib/privateRequestDeduplicator": loadModule("../lib/privateRequestDeduplicator.ts"),
  }).apiService;
}

test("captured event and threat reads use coherent browser and proxy budgets", async () => {
  const api = loadApiService();
  const { getProxyAttemptTimeoutMs, getProxyTotalTimeoutMs } = loadProxyBudgets();
  const calls = [];
  api.get = async (url, options) => { calls.push({ url, options }); return {}; };
  for (const provider of ["zerodha", "indmoneyUs"]) {
    for (const kind of ["Events", "Threats"]) {
      await api[`${provider}${kind}Latest`]();
      await api[`${provider}${kind}History`]({ limit: 50 });
      await api[`${provider}${kind === "Events" ? "Event" : "Threat"}Job`](42);
    }
  }
  assert.equal(calls.length, 12);
  for (const { url, options } of calls) {
    const path = url.replace("/backend-api/", "").split("?")[0];
    const attempt = getProxyAttemptTimeoutMs("GET", path);
    const total = getProxyTotalTimeoutMs("GET", path);
    assert.equal(options?.timeoutMs, 20_000, `${path} browser deadline`);
    assert.equal(attempt, 16_000, `${path} proxy attempt deadline`);
    assert.equal(total, 18_000, `${path} proxy total deadline`);
    assert.ok(attempt < total && total < options.timeoutMs);
    assert.equal(getProxyTotalTimeoutMs("HEAD", path), total);
  }
});

test("Zerodha sync routes have their own bounded connection and snapshot budgets", () => {
  const { getProxyAttemptTimeoutMs, getProxyTotalTimeoutMs } = loadProxyBudgets();
  for (const [method, path] of [
    ["GET", "zerodha/status"], ["HEAD", "zerodha/status"],
    ["GET", "zerodha/login-url"], ["GET", "zerodha/portfolio"],
    ["POST", "zerodha/callback"], ["POST", "zerodha/portfolio/sync"],
  ]) {
    assert.equal(getProxyAttemptTimeoutMs(method, path), 16_000, path);
    assert.equal(getProxyTotalTimeoutMs(method, path), 18_000, path);
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(getProxyAttemptTimeoutMs(method, "zerodha/orders"), 8_000);
    assert.equal(getProxyTotalTimeoutMs(method, "zerodha/orders"), 8_000);
  }
});

test("captured-read budgets do not expand unrelated reads or mutations", () => {
  const { getProxyAttemptTimeoutMs, getProxyTotalTimeoutMs } = loadProxyBudgets();
  for (const path of [
    "zerodha/orders", "zerodha/portfolio/2026-10-07", "indmoney-us/portfolio", "runs", "jobs/42",
    "zerodha/events/run", "zerodha/events/42/extra", "other/events/latest",
    "indmoney-us/threats/not-an-id",
  ]) {
    assert.equal(getProxyAttemptTimeoutMs("GET", path), 1_200, path);
    assert.equal(getProxyTotalTimeoutMs("GET", path), 4_000, path);
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(getProxyAttemptTimeoutMs(method, "zerodha/events/latest"), 8_000);
    assert.equal(getProxyTotalTimeoutMs(method, "indmoney-us/threats/history"), 8_000);
  }
});

test("captured reads use bounded circuit scopes separate from generic broker reads", () => {
  const { getCapturedPortfolioAnalysisReadScope } = loadProxyBudgets();
  const scopes = new Set();
  for (const provider of ["zerodha", "indmoney-us"]) {
    for (const kind of ["events", "threats"]) {
      for (const item of ["latest", "history", "1", "9999"]) {
        const path = `${provider}/${kind}/${item}`;
        const scope = getCapturedPortfolioAnalysisReadScope("GET", path);
        assert.equal(scope, `${provider}/${kind}`);
        assert.equal(getCapturedPortfolioAnalysisReadScope("HEAD", path), scope);
        assert.equal(getCapturedPortfolioAnalysisReadScope("POST", path), undefined);
        scopes.add(scope);
      }
    }
  }
  assert.equal(scopes.size, 4);
  assert.equal(getCapturedPortfolioAnalysisReadScope("GET", "zerodha/portfolio"), undefined);
});


test("stored run details and provider estimates have coherent isolated read deadlines", async () => {
  const api = loadApiService();
  const { getProxyAttemptTimeoutMs, getProxyTotalTimeoutMs, getResearchHistoryReadScope } = loadProxyBudgets();
  const calls = [];
  const controller = new AbortController();
  api.get = async (url, options) => { calls.push({ url, options }); return {}; };
  await api.getRun(12, { signal: controller.signal });
  await api.getProviders({ signal: controller.signal, prompt: "example" });
  for (const { url, options } of calls) {
    const path = url.replace("/backend-api/", "").split("?")[0];
    assert.equal(options.signal, controller.signal);
    assert.equal(options.timeoutMs, 20_000);
    assert.equal(getProxyAttemptTimeoutMs("GET", path), 16_000);
    assert.equal(getProxyTotalTimeoutMs("GET", path), 18_000);
    assert.equal(getProxyTotalTimeoutMs("HEAD", path), 18_000);
  }
  assert.equal(getResearchHistoryReadScope("GET", "runs/12"), "runs/detail");
  assert.equal(getResearchHistoryReadScope("GET", "runs/999999"), "runs/detail");
  assert.equal(getResearchHistoryReadScope("GET", "providers"), "providers");
  for (const path of ["runs", "runs/12/cancel", "runs/auto-rebalance-history", "providers/extra"]) {
    assert.equal(getResearchHistoryReadScope("GET", path), undefined);
    assert.equal(getProxyTotalTimeoutMs("GET", path), 4_000);
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    for (const path of ["runs/12", "providers"]) {
      assert.equal(getResearchHistoryReadScope(method, path), undefined);
      assert.equal(getProxyTotalTimeoutMs(method, path), 8_000);
    }
  }
});

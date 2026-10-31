import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function read(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function loadModule(relativePath, imports = {}, suffix = "") {
  if (relativePath.endsWith('runs/page.tsx')) {
    imports['@/lib/portfolioStageHistory'] = loadModule('../lib/portfolioStageHistory.ts');
    if (imports['@/services/api']?.apiService) imports['@/services/api'].apiService.getAutoRebalanceHistory ??= async () => ({ items: [], total: 0 });
  }
  const output = ts.transpileModule(read(relativePath) + suffix, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const loaded = { exports: {} };
  new Function("exports", "module", "require", output)(
    loaded.exports,
    loaded,
    (specifier) => imports[specifier] ?? {},
  );
  return loaded.exports;
}

function loadRunsPage(apiService) {
  return loadModule("../app/console/runs/page.tsx", {
    "@/services/api": { apiService },
  }, "\nexport { loadAllBullpenRuns, loadAllPortfolioRuns, loadWorkflowHistory };\n");
}

function loadApiService() {
  return loadModule("../services/api.ts", {
    "@/lib/urls": {
      URLs: {
        bullpenAutoLive: { history: () => "/backend-api/polymarket/auto-live/history" },
        runs: { list: () => '/backend-api/runs', autoRebalanceHistory: portfolio => `/backend-api/runs/auto-rebalance-history?portfolio=${portfolio}` },
      },
      resolveApiReadTransportCandidates: (url) => [{
        url, stage: "primary", transport: "same-origin-proxy",
      }],
    },
    "@/lib/apiReadCircuitBreaker": loadModule("../lib/apiReadCircuitBreaker.ts"),
    "@/lib/privateRequestDeduplicator": loadModule("../lib/privateRequestDeduplicator.ts"),
  }).apiService;
}

function historyPage(page, pages = 8) {
  return {
    items: [{ id: `run-${page}` }],
    page,
    pages,
    has_next: page < pages,
  };
}

test("Bullpen history browser deadline outlives its 14-second BFF budget", async () => {
  const api = loadApiService();
  const calls = [];
  api.fetch = async (url, options) => {
    calls.push({ url, options });
    return historyPage(2);
  };
  await api.getBullpenAutoLiveHistory({ page: 2, size: 50 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/backend-api/polymarket/auto-live/history?page=2&size=50");
  assert.ok(calls[0].options.timeoutMs > 14_000);
  assert.ok(calls[0].options.timeoutMs <= 20_000);
  assert.equal(calls[0].options.cache, "no-store");

  await api.get("/backend-api/runs");
  assert.ok(calls[1].options.timeoutMs <= 5_000, "ordinary reads keep their existing deadline");
});

test("Bullpen history preserves caller cancellation and timeout overrides", async () => {
  const api = loadApiService();
  const controller = new AbortController();
  const calls = [];
  api.fetch = async (url, options) => {
    calls.push({ url, options });
    return historyPage(1);
  };
  await api.getBullpenAutoLiveHistory(
    { workspaceProfile: "bullpen-sports" },
    { signal: controller.signal, timeoutMs: 750 },
  );
  assert.equal(calls[0].options.signal, controller.signal);
  assert.ok(calls[0].options.timeoutMs <= 750);
  assert.match(calls[0].url, /workspace_profile=bullpen-sports/);
});

test("a six-second history response reaches the browser instead of timing out at five", async (t) => {
  const api = loadApiService();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(globalThis, "fetch", (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    setTimeout(() => resolve(Response.json(historyPage(2))), 6_000);
  }));
  const outcome = api.getBullpenAutoLiveHistory({ page: 2, size: 50 }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  t.mock.timers.tick(5_001);
  await Promise.resolve();
  t.mock.timers.tick(999);
  assert.deepEqual(await outcome, { value: historyPage(2) });
});

test("Runs loads all Bullpen pages in order with at most two concurrent reads", async () => {
  let active = 0;
  let peak = 0;
  const calls = [];
  const { loadAllBullpenRuns } = loadRunsPage({
    async getBullpenAutoLiveHistory({ page, size }) {
      calls.push(page);
      assert.equal(size, 50);
      active += 1;
      peak = Math.max(peak, active);
      // Resolve neighboring pages out of order to verify stable API ordering.
      await new Promise((resolve) => setTimeout(resolve, page % 2 ? 2 : 8));
      active -= 1;
      return historyPage(page);
    },
  });
  const result = await loadAllBullpenRuns();
  assert.ok(peak <= 2, `started ${peak} simultaneous history reads`);
  assert.deepEqual(calls, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(result.map((item) => item.id), calls.map((page) => `run-${page}`));
});

test("Runs stops after the first page when history has no next page", async () => {
  const calls = [];
  const { loadAllBullpenRuns } = loadRunsPage({
    async getBullpenAutoLiveHistory({ page }) {
      calls.push(page);
      return historyPage(page, 1);
    },
  });
  assert.deepEqual(await loadAllBullpenRuns(), [{ id: "run-1" }]);
  assert.deepEqual(calls, [1]);
});

test("a failed history page rejects the complete list and stops queued reads", async () => {
  const calls = [];
  const failure = new Error("history page unavailable");
  const { loadAllBullpenRuns } = loadRunsPage({
    async getBullpenAutoLiveHistory({ page }) {
      calls.push(page);
      if (page === 2) throw failure;
      return historyPage(page);
    },
  });
  await assert.rejects(loadAllBullpenRuns(), failure);
  assert.ok(calls.length <= 3, "a failed batch must not trigger the remaining history");
});

test("navigation cancellation stops queued history pages", async () => {
  const controller = new AbortController();
  const calls = [];
  const { loadAllBullpenRuns } = loadRunsPage({
    async getBullpenAutoLiveHistory({ page }, options) {
      assert.equal(options?.signal, controller.signal);
      calls.push(page);
      controller.abort();
      return historyPage(page);
    },
  });
  await assert.rejects(loadAllBullpenRuns(controller.signal), { name: "AbortError" });
  assert.deepEqual(calls, [1]);
});

test("a superseded Runs refresh cannot publish its older result", async () => {
  const callbacks = [];
  const state = [];
  const writes = [];
  const requests = [];
  const refs = [];
  let stateIndex = 0;
  const { default: RunsPage } = loadModule("../app/console/runs/page.tsx", {
    react: {
      useCallback(callback) { callbacks.push(callback); return callback; },
      useEffect() {},
      useMemo(callback) { return callback(); },
      useRef(value) { const ref = { current: value }; refs.push(ref); return ref; },
      useState(initialValue) {
        const index = stateIndex++;
        state[index] = typeof initialValue === "function" ? initialValue() : initialValue;
        return [state[index], (value) => { state[index] = value; writes.push(index); }];
      },
    },
    "react/jsx-runtime": {
      jsx: (type, props) => ({ type, props }),
      jsxs: (type, props) => ({ type, props }),
    },
    "next/navigation": {
      useRouter: () => ({}),
      useSearchParams: () => new URLSearchParams(),
    },
    "@/lib/utils": { cn: () => "" },
    "@/services/api": {
      apiService: {
        getRuns: () => Promise.resolve({ items: [], pages: 1 }),
        getBullpenAutoLiveHistory: (_params, { signal }) => new Promise((resolve) => {
          requests.push({ resolve, signal });
        }),
      },
    },
  });
  RunsPage();
  const [refresh] = callbacks;
  const older = refresh();
  const newer = refresh();
  assert.equal(requests[0].signal.aborted, true);
  requests[1].resolve({ ...historyPage(1, 1), items: [{ id: "new-run" }] });
  await newer;
  assert.deepEqual(state[2], [{ id: "new-run" }]);
  const completedWrites = writes.length;
  // Even a transport that resolves after cancellation cannot overwrite state.
  requests[0].resolve({ ...historyPage(1, 1), items: [{ id: "old-run" }] });
  await older;
  assert.equal(writes.length, completedWrites);
  assert.deepEqual(state[2], [{ id: "new-run" }]);
});

function runsErrorHarness(apiService, initialTab = 'indmoney') {
  const slots = []; let cursor = 0; let refresh;
  const { default: RunsPage } = loadModule('../app/console/runs/page.tsx', {
    react: {
      useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }]; },
      useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
      useCallback(fn) { refresh = fn; return fn; }, useEffect() {}, useMemo(fn) { return fn(); },
    },
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    'next/navigation': { useRouter: () => ({ replace() {} }), useSearchParams: () => new URLSearchParams({ tab: initialTab }) },
    '@/lib/utils': { cn: () => '' }, '@/services/api': { apiService, APIError: class extends Error {} },
  });
  function render() { cursor = 0; return RunsPage(); }
  function nodes(tree) { if (!tree || typeof tree !== 'object') return []; if (Array.isArray(tree)) return tree.flatMap(nodes); return [tree, ...nodes(tree.props?.children)]; }
  function select(tab) { const button = nodes(render()).find(n => n.props?.role === 'tab' && n.props.children[0].props.children === tab); assert.ok(button); button.props.onClick(); return render(); }
  return { render, select, refresh: () => { render(); return refresh(); }, text: () => JSON.stringify(render()) };
}

test('Bullpen errors arriving after tab changes stay scoped; switching back retains the real failure', async () => {
  let rejectHistory; let historyReads = 0;
  const h = runsErrorHarness({ getRuns: async () => ({ items: [], pages: 1 }), getBullpenAutoLiveHistory: () => { historyReads++; return new Promise((_, reject) => { rejectHistory = reject; }); } }, 'bullpen');
  const pending = h.refresh();
  h.select('Zerodha');
  rejectHistory(new Error('Endpoint unavailable during analysis-only recovery.'));
  await pending;
  assert.doesNotMatch(h.text(), /Bullpen: Endpoint unavailable/);
  h.select('IndMoney Runs'); assert.doesNotMatch(h.text(), /Bullpen: Endpoint unavailable/);
  h.select('Bullpen'); assert.match(h.text(), /Bullpen: Endpoint unavailable during analysis-only recovery\./);
  h.select('Zerodha'); assert.doesNotMatch(h.text(), /Bullpen: Endpoint unavailable/);
  h.select('Bullpen'); assert.match(h.text(), /Bullpen: Endpoint unavailable/);
  assert.equal(historyReads, 1, 'tab changes only update visibility; no retry or recovery bypass');
});

test('active Bullpen failures stay visible and unrelated portfolio errors are preserved', async () => {
  let failBullpen = true;
  const h = runsErrorHarness({ getRuns: async () => { throw new Error('Saved portfolio history unavailable.'); }, getBullpenAutoLiveHistory: async () => { if (failBullpen) throw new Error('Endpoint unavailable during analysis-only recovery.'); return historyPage(1, 1); } }, 'bullpen');
  await h.refresh();
  assert.match(h.text(), /Bullpen: Endpoint unavailable/);
  assert.match(h.text(), /IndMoney\/Zerodha: Saved portfolio history unavailable/);
  h.select('Zerodha'); assert.doesNotMatch(h.text(), /Bullpen: Endpoint unavailable/); assert.match(h.text(), /IndMoney\/Zerodha: Saved portfolio history unavailable/);
  h.select('IndMoney Runs'); assert.doesNotMatch(h.text(), /Bullpen: Endpoint unavailable/); assert.match(h.text(), /IndMoney\/Zerodha: Saved portfolio history unavailable/);
  failBullpen = false; await h.refresh(); h.select('Bullpen');
  assert.doesNotMatch(h.text(), /Bullpen: Endpoint unavailable/);
  assert.match(h.text(), /IndMoney\/Zerodha: Saved portfolio history unavailable/);
});

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const savedGroup = (portfolio, sequence = 1) => ({ portfolio, sequence, label: `${portfolio} saved group ${sequence}`, created_at: '2026-10-31T12:00:00Z', updated_at: '2026-10-31T12:00:00Z', status: 'completed', stages: [] });
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test('history browser deadlines exceed the bounded BFF and preserve abort signals without browser fanout', async () => {
  const api = loadApiService();
  const calls = [];
  api.fetch = async (url, options) => { calls.push({ url, options }); return { items: [], total: 0 }; };
  const controller = new AbortController();
  await api.getAutoRebalanceHistory('india', { limit: 50, offset: 100 }, { signal: controller.signal });
  await api.getRuns({ summary: true, page: 2, limit: 100 }, { signal: controller.signal });
  assert.equal(calls.length, 2);
  for (const { options } of calls) {
    assert.equal(options.timeoutMs, 20_000);
    assert.equal(options.method, 'GET');
    assert.equal(options.signal, controller.signal);
    assert.equal(options.cache, 'no-store');
  }
  assert.match(calls[0].url, /portfolio=india&limit=50&offset=100/);
});

test('saved groups render before summary links or another market/Bullpen finishes', async () => {
  const summaries = deferred(), india = deferred(), us = deferred(), bullpen = deferred();
  const h = runsErrorHarness({ getRuns: () => summaries.promise,
    getAutoRebalanceHistory: portfolio => portfolio === 'india' ? india.promise : us.promise,
    getBullpenAutoLiveHistory: () => bullpen.promise,
  }, 'zerodha');
  const pending = h.refresh();
  india.resolve({ items: [savedGroup('india', 7)], total: 1 }); await settle();
  assert.match(h.text(), /india saved group 7/);
  assert.doesNotMatch(h.text(), /No runs found/);
  us.reject(new Error('The backend did not respond in time (18 seconds). Please retry.'));
  summaries.resolve({ items: [], pages: 1 }); bullpen.resolve(historyPage(1, 1)); await pending;
  assert.match(h.text(), /india saved group 7/);
  assert.doesNotMatch(h.text(), /IndMoney grouped history/);
  h.select('IndMoney Runs');
  assert.match(h.text(), /IndMoney grouped history: The backend did not respond in time/);
  assert.match(h.text(), /History could not be fully loaded/);
});

test('summary failures preserve both markets and successful refresh never erases a failed market last-good groups', async () => {
  let phase = 0;
  const h = runsErrorHarness({
    getRuns: async () => { if (phase) throw new Error('Run links timed out'); return { items: [], pages: 1 }; },
    getAutoRebalanceHistory: async portfolio => { if (phase === 1 && portfolio === 'india') throw new Error('Group history timed out'); return { items: [savedGroup(portfolio, phase + 1)], total: 1 }; },
    getBullpenAutoLiveHistory: async () => historyPage(1, 1),
  }, 'zerodha');
  await h.refresh(); assert.match(h.text(), /india saved group 1/);
  phase = 1; await h.refresh();
  assert.match(h.text(), /india saved group 1/);
  assert.match(h.text(), /Zerodha grouped history: Group history timed out/);
  assert.match(h.text(), /IndMoney\/Zerodha: Run links timed out/);
  h.select('IndMoney Runs'); assert.match(h.text(), /indmoney_us saved group 2/);
  assert.doesNotMatch(h.text(), /Zerodha grouped history/);
  phase = 0; await h.refresh(); h.select('Zerodha');
  assert.doesNotMatch(h.text(), /timed out/); assert.match(h.text(), /india saved group 1/);
});

test('portfolio summary pagination limits concurrency, keeps page ordering and stops after cancellation/failure', async () => {
  let active = 0, peak = 0; const calls = [];
  const { loadAllPortfolioRuns } = loadRunsPage({ getRuns: async ({ page }, { signal }) => {
    assert.ok(signal); active++; peak = Math.max(peak, active); calls.push(page);
    await new Promise(resolve => setTimeout(resolve, page % 2 ? 1 : 5)); active--;
    return { pages: 7, items: [{ id: page }] };
  } });
  const controller = new AbortController();
  assert.deepEqual((await loadAllPortfolioRuns(controller.signal)).map(run => run.id), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(peak <= 2); assert.deepEqual(calls, [1, 2, 3, 4, 5, 6, 7]);
  controller.abort(); await assert.rejects(loadAllPortfolioRuns(controller.signal), { name: 'AbortError' });
  const failedCalls = [];
  const failing = loadRunsPage({ getRuns: async ({ page }) => { failedCalls.push(page); if (page === 2) throw new Error('page timeout'); return { pages: 8, items: [{ id: page }] }; } });
  await assert.rejects(failing.loadAllPortfolioRuns(), /page timeout/); assert.ok(failedCalls.length <= 3);
});

test('group pagination reads every 50-group page, rejects gaps and supports retry without truncation', async () => {
  let fail = true; const calls = [];
  const api = { getAutoRebalanceHistory: async (portfolio, { limit, offset }, { signal }) => {
    calls.push(offset); assert.equal(limit, 50); signal?.throwIfAborted();
    if (fail && offset === 50) throw new Error('second page timeout');
    return { items: Array.from({ length: Math.min(limit, 123 - offset) }, (_, i) => savedGroup(portfolio, offset + i + 1)), total: 123 };
  } };
  const { loadWorkflowHistory } = loadRunsPage(api);
  await assert.rejects(loadWorkflowHistory('india'), /second page timeout/);
  fail = false; const items = await loadWorkflowHistory('india');
  assert.equal(items.length, 123); assert.equal(new Set(items.map(item => item.sequence)).size, 123);
  assert.deepEqual(calls, [0, 50, 0, 50, 100]);
  api.getAutoRebalanceHistory = async () => ({ items: [savedGroup('india')], total: 100 });
  await assert.rejects(loadWorkflowHistory('india'), /complete history/);
  api.getAutoRebalanceHistory = async () => ({ items: Array(50).fill(savedGroup('india')), total: 50 });
  await assert.rejects(loadWorkflowHistory('india'), /complete history/);
  api.getAutoRebalanceHistory = async () => ({ items: [], total: undefined });
  await assert.rejects(loadWorkflowHistory('india'), /invalid total/);
});

test('unsignalled history reads share only in-flight work and retry reads fresh after timeout or success', async () => {
  const api = loadApiService(); let calls = 0; let next = deferred();
  api.fetch = () => { calls++; return next.promise; };
  const first = api.getAutoRebalanceHistory('india', { limit: 50 });
  const second = api.getAutoRebalanceHistory('india', { limit: 50 });
  assert.equal(calls, 1);
  const rejected = Promise.allSettled([first, second]); next.reject(new Error('timeout')); await rejected;
  next = deferred(); const retry = api.getAutoRebalanceHistory('india', { limit: 50 }); assert.equal(calls, 2);
  next.resolve({ items: [], total: 0 }); await retry;
  next = deferred(); const refreshed = api.getAutoRebalanceHistory('india', { limit: 50 }); assert.equal(calls, 3);
  next.resolve({ items: [savedGroup('india')], total: 1 }); assert.equal((await refreshed).items.length, 1);
});

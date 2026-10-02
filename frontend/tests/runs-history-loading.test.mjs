import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function read(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function loadModule(relativePath, imports = {}, suffix = "") {
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
  }, "\nexport { loadAllBullpenRuns };\n");
}

function loadApiService() {
  return loadModule("../services/api.ts", {
    "@/lib/urls": {
      URLs: {
        bullpenAutoLive: { history: () => "/backend-api/polymarket/auto-live/history" },
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

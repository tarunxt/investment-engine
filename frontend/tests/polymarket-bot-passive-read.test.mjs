import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/console/polymarket-bot/page.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const effects = [];
const functions = new Map();
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect") effects.push(node.arguments[0]);
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
  ts.forEachChild(node, visit);
}
visit(ast);

function loadExpression(text, bindings) {
  const code = ts.transpileModule(`const value = ${text};`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(bindings), `${code}\nreturn value;`)(...Object.values(bindings));
}

test("all page effects use only the passive state API", () => {
  assert.equal(ast.parseDiagnostics.length, 0);
  const calls = [];
  function inspect(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(ast) === "apiService") {
      calls.push(node.expression.name.text);
    }
    ts.forEachChild(node, inspect);
  }
  effects.forEach(inspect);
  assert.deepEqual(calls, ["polymarketState"]);
  assert.doesNotMatch(source, /doctorAutoRefresh|balanceAutoRefresh|autoDoctorRefreshing|automatically retries/);
});

test("mount and visible polling read state without doctor, balance or lifecycle writes", async () => {
  const effect = effects.find((node) => node.getText(ast).includes("apiService.polymarketState"));
  assert.ok(effect);
  const snapshot = {
    read_source: "unavailable", read_message: "No saved CopyTrader snapshot is available.",
    tracked_accounts: [], config: { max_live_trades_per_day: 10, trader_invested_threshold_usd: 100, max_live_exposure_per_market: 1 },
    live: { doctor: { ok: false }, balance: { status: "unavailable", available_balance_usd: null } },
  };
  let reads = 0;
  let interval;
  let cleared = false;
  let received;
  const document = { visibilityState: "visible" };
  const bindings = {
    apiService: new Proxy({}, { get(_target, name) {
      assert.equal(name, "polymarketState", `Unexpected operation ${String(name)}`);
      return async () => { reads += 1; return snapshot; };
    } }),
    window: { setInterval: (callback) => { interval = callback; return 42; }, clearInterval: (id) => { assert.equal(id, 42); cleared = true; } },
    document, actionInFlight: { current: false }, lastMutationAt: { current: 0 },
    STATE_REFRESH_INTERVAL_MS: 30_000, isUsableBullpenBalance: () => false,
    setState: (value) => { received = value; }, normalizeError: (error) => error.message,
  };
  for (const name of ["setLastStateRefreshAt", "setLastDoctorPassAt", "setLastSettledBalance", "setAccountDrafts", "setManualNetWorthDrafts", "setLiveTradeLimitDraft", "setTraderInvestedThresholdDraft", "setMaxLiveExposureDraft", "setError", "setLoading"]) bindings[name] = () => {};
  const cleanup = loadExpression(effect.getText(ast), bindings)();
  await new Promise(setImmediate);
  assert.equal(reads, 1);
  assert.equal(received, snapshot);
  interval();
  await new Promise(setImmediate);
  assert.equal(reads, 2);
  document.visibilityState = "hidden";
  interval();
  await new Promise(setImmediate);
  assert.equal(reads, 2);
  cleanup();
  assert.equal(cleared, true);
});

test("explicit refresh and start controls remain while missing runtime status is honest", () => {
  assert.match(source, /onClick=\{\(\) =>\s*runAction\("doctor", \(\) =>\s*apiService\.polymarketLiveDoctor\(\)/);
  assert.match(source, /function handleBalanceRefresh\(\) \{\s*void runAction\("balance", \(\) => apiService\.polymarketLiveBalanceRefresh\(\)\)/);
  assert.match(source, /onClick=\{\(\) =>\s*runAction\("start", \(\) => apiService\.polymarketStart\(\)/);
  assert.match(source, /const startDisabled = state.running \|\| isActionPending/);
  assert.match(source, /Runtime, execution mode and lock status unavailable/);
  assert.match(source, /role="status"[^\n]*>\{state.read_message\}/);
  for (const name of ["getActionStatusMessage", "getLiveParsingStatusMessage"]) {
    const fn = loadExpression(functions.get(name).getText(ast), {});
    const snapshot = { read_source: "unavailable", running: false };
    const message = name === "getActionStatusMessage" ? fn(null, snapshot) : fn(snapshot);
    assert.match(message, /unavailable/);
    assert.doesNotMatch(message, /stopped|idle/);
  }
});

function renderColdPage(readSource, screen) {
  const numericDefaults = (values) => new Proxy(values, { get: (target, key) => key in target ? target[key] : 0 });
  const state = {
    read_source: readSource, read_message: "Current runtime evidence is unavailable.",
    running: false, paused: false, mode: "live-read", server_now: "2026-10-03T00:00:00Z",
    tracked_accounts: [], tracked_traders: [], open_positions: [], trade_history: [], recent_activity: [],
    metrics: numericDefaults({}), config: numericDefaults({ paper_trading: false, poll_interval_ms: 30_000 }),
    live: numericDefaults({
      unlocked: false, unlock_mode: "locked", locked_reason: "Bullpen doctor must pass.",
      doctor: { ok: false, message: "No cached doctor result is available." },
      balance: { status: "unavailable", message: "No cached balance is available." },
      source_status: numericDefaults({ manual_wallets_invalid: [], manual_tracked_wallets: [], source_mode: "live-read" }),
      recent_decisions: [], redeemed_trades: [], pending_confirmations: [],
    }),
  };
  let hook = 0;
  const element = (type, props) => ({ type, props: props || {} });
  const grids = [];
  const passthrough = ({ children }) => children;
  const modules = {
    react: {
      useState(initial) {
        const index = hook++;
        const value = index === 0 ? state : index === 1 ? false : index === 6 ? screen : typeof initial === "function" ? initial() : initial;
        return [value, () => {}];
      },
      useEffect() {}, useMemo: (fn) => fn(), useRef: (value) => ({ current: value }), useDeferredValue: (value) => value,
    },
    "react/jsx-runtime": { jsx: element, jsxs: element, Fragment: "fragment" },
    "next/dynamic": (loader) => loader.toString().includes("MetricGrid")
      ? (props) => { grids.push(props.items); return props.items.map((item) => `${item.label}: ${item.value}. ${item.helper || ""}`); }
      : () => null,
    "lucide-react": new Proxy({}, { get: () => () => null }),
    "@/components/ui/card": new Proxy({}, { get: () => passthrough }),
    "@/components/ui/button": { Button: passthrough },
    "@/services/api": { APIError: class extends Error {}, apiService: new Proxy({}, { get: (_target, name) => () => { throw new Error(`Unexpected API action ${String(name)}`); } }) },
    "@/lib/datetime": { parseApiTimestamp: (value) => value ? new Date(value) : null },
    "./_components/PolymarketBotPageSkeleton": new Proxy({}, { get: () => () => null }),
  };
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  new Function("exports", "require", "module", compiled)(loaded.exports, (name) => {
    assert.ok(name in modules, `Unexpected dependency ${name}`);
    return modules[name];
  }, loaded);
  function render(node) {
    if (node == null || typeof node === "boolean") return "";
    if (Array.isArray(node)) return node.map(render).join(" ");
    if (typeof node !== "object") return String(node);
    return render(typeof node.type === "function" ? node.type(node.props) : node.props.children);
  }
  return { text: render(loaded.exports.default()), grids };
}

for (const readSource of ["persisted", "unavailable"]) {
  test(`${readSource} page renders honest cold runtime sections and explicit controls`, () => {
    const settings = renderColdPage(readSource, "settings");
    assert.equal(settings.grids.length, 4);
    for (const grid of settings.grids) {
      assert.ok(grid.length > 0);
      for (const item of grid) assert.equal(item.value, "Unavailable", item.label);
    }
    assert.match(settings.text, /Runtime, execution mode and lock status unavailable/);
    assert.doesNotMatch(settings.text, /Doctor failed:|Live mode locked:|Sandbox mode active|Sandbox execution is disabled/);
    assert.match(settings.text, /Refresh doctor/);
    assert.match(settings.text, /Refresh balance/);
    const main = renderColdPage(readSource, "main");
    assert.match(main.text, /Current claim eligibility and redeemed-wallet history are unavailable/);
    assert.doesNotMatch(main.text, /No resolved winning positions are currently/);
    assert.doesNotMatch(main.text, /Doctor failed:|Live mode locked:/);
    assert.match(main.text, /Start/);
    assert.match(main.text, /Stop Bot/);
  });
}

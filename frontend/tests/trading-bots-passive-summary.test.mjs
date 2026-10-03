import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const compile = (source) => ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
const source = read('../app/console/trading-bots/_components/TradingBotsOverviewPage.tsx');
const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function extract(name) {
  let found;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(found, `Missing ${name}`);
  return found;
}
function loadFunction(name, bindings) {
  return new Function(...Object.keys(bindings), `${compile(extract(name))}\nreturn ${name};`)(...Object.values(bindings));
}
function loadModule(source, modules) {
  const exports = {};
  new Function('exports', 'require', compile(source))(exports, (name) => {
    assert.ok(modules[name], `Unexpected dependency: ${name}`);
    return modules[name];
  });
  return exports;
}
const helpers = loadModule(read('../lib/tradingBots.ts'), {
  '@/lib/urls': { URLs: { routes: { console: new Proxy({}, { get: (_, key) => () => `/console/${String(key)}` }) } } },
});
const presentation = loadModule(read('../app/console/trading-bots/_components/tradingBotsOverviewData.ts'), {
  'lucide-react': new Proxy({}, { get: () => () => null }),
});

for (const fail of [false, true]) {
  test(`overview refresh invokes only passive APIs, including failed reads (${fail})`, async () => {
    const calls = [];
    const permitted = ['getTradingBotsSummary', 'polymarketState', 'getBullpenAutoLiveDashboardSummary'];
    const apiService = new Proxy({}, { get: (_, name) => {
      assert.ok(permitted.includes(name), `Operational API access: ${String(name)}`);
      return async () => { calls.push(name); if (fail) throw new Error('Temporarily unavailable'); return {}; };
    } });
    const bindings = { apiService, withTimeout: (promise) => promise,
      PREFERRED_OVERVIEW_TIMEOUT_MS: 2000, FAST_BOT_TIMEOUT_MS: 2500, AUTO_LIVE_TIMEOUT_MS: 2500,
      startTransition: (fn) => fn(), getDisplayableOverviewError: (error) => error.message,
      isTimeoutError: () => false, normalizeError: (error) => error.message,
      normalizeTradingBotsSummaryResponse: () => ({}), mergeTradingBotsOverview: () => ({}),
      buildPolymarketTradingBotSummary: () => ({}), buildBullpenAiAutoLiveTradingBotSummary: () => ({}),
      upsertBotSummary: () => ({}),
    };
    for (const name of ['setIsRefreshing', 'setIsLoadingLatest', 'setLoadError', 'setOverview', 'setDetails']) {
      bindings[name] = (value) => { if (typeof value === 'function') value({}); };
    }
    await loadFunction('refreshOverview', bindings)();
    assert.deepEqual(calls, permitted);
    assert.doesNotMatch(source, /polymarketDirectState\(|fetchBullpenAiPositions\(|\/api\/bullpen-ai\/positions/);
  });
}

test('cold and unavailable states keep unknown metrics, mode and risk without stopped claims', () => {
  const state = { read_source: 'persisted', read_message: 'Only saved history is available.' };
  const card = helpers.buildPolymarketTradingBotSummary('bullpen-x-polymarket', state);
  assert.equal(card.status, 'unavailable');
  assert.equal(card.mode, 'unknown');
  for (const field of ['moneyInvested', 'currentValue', 'profitLoss', 'returnPct', 'activePositionsCount', 'tradesToday']) {
    assert.equal(card[field], null);
  }
  assert.deepEqual(card.guardrails, []);
  const details = { 'bullpen-x-polymarket': null, 'polymarket-direct': null, 'bullpen-x-ai': null, 'bullpen-ai-auto-live': null };
  assert.equal(presentation.getTradingBotRiskStatus(card, details).label, 'Unknown');
  assert.match(presentation.getTradingBotExecutionModeDetail(card), /unavailable/);
  const total = presentation.buildTradingBotsPortfolioSummary([card], details, null);
  assert.equal(total.botsPausedStopped, 0);
  assert.equal(total.totalMoneyInvested, null);
  assert.match(source, /unavailable: "Unavailable"/);
  assert.match(source, /unknown: "Unknown"/);
  assert.match(source, /trading-bots-overview:v3/);
});


test('saved CopyTrader evidence never emits live doctor/lock/armed warnings', () => {
  const state = { read_source: 'persisted', read_message: 'Only saved history is available.' };
  const card = helpers.buildPolymarketTradingBotSummary('bullpen-x-polymarket', state);
  const details = { 'bullpen-x-polymarket': state, 'polymarket-direct': null, 'bullpen-x-ai': null, 'bullpen-ai-auto-live': null };
  assert.deepEqual(presentation.getTradingBotWarnings(card, details), [state.read_message]);
  const warnings = presentation.buildTradingBotsLiveWarnings([card], details);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].label, 'Runtime unavailable');
  assert.equal(warnings[0].tone, 'warning');
});

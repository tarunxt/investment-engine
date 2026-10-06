import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
function load(source, bindings = {}) {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  new Function('exports', 'module', ...Object.keys(bindings), compiled)(loaded.exports, loaded, ...Object.values(bindings));
  return loaded.exports;
}
const source = read('../app/console/_components/FinalActionablesConsole.tsx');
const ast = ts.createSourceFile('console.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = [
  'FINAL_ACTIONABLES_RUN_CACHE_VERSION', 'DASHBOARD_FINAL_ACTIONABLES_CACHE_VERSION',
  'HISTORICAL_ACTION_ROWS_CACHE_VERSION', 'HISTORICAL_ACTION_ROWS_CACHE_LIMIT',
  'DASHBOARD_FINAL_ACTIONABLES_CACHE_KEY', 'normalizeWhitespace', 'parseTimestampMs',
  'normalizeStockSymbol', 'extractRebalanceInputFingerprint', 'isUsableModelOutputStatus',
  'hasUsableRebalanceLlmOutput', 'isCompletedRebalanceRun', 'buildFinalActionablesCacheKey',
  'writeFinalActionablesRunCache', 'readFinalActionablesRunCache', 'selectCacheableFinalActionablesRuns',
  'cacheFinalActionablesRuns', 'getHistoricalActionRowsCacheKey', 'getHistoricalActionRowCacheId',
  'readHistoricalActionRowsCache', 'mergeHistoricalActionRows', 'writeHistoricalActionRowsCache',
  'writeDashboardFinalActionablesCache', 'fetchAllFullRuns',
];
const extracted = ast.statements.filter((node) => names.includes(node.name?.getText(ast)) || (
  ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) => names.includes(declaration.name.getText(ast)))
)).map((node) => node.getText(ast)).join('\n');
const exports = ['buildFinalActionablesCacheKey', 'cacheFinalActionablesRuns', 'readFinalActionablesRunCache', 'getHistoricalActionRowsCacheKey', 'readHistoricalActionRowsCache', 'writeHistoricalActionRowsCache', 'writeDashboardFinalActionablesCache'];

function fixture({ errorForKey = () => null, initial = [] } = {}) {
  const values = new Map(initial);
  const attempts = [];
  const notices = [];
  const warnings = [];
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      attempts.push(key);
      const error = errorForKey(key);
      if (error) throw error;
      values.set(key, value);
    },
    removeItem() { assert.fail('optional cache must not delete any browser data'); },
    clear() { assert.fail('optional cache must not clear browser storage'); },
  };
  const bindings = {
    window: { localStorage: storage },
    console: { info: (...args) => notices.push(args), warn: (...args) => warnings.push(args) },
  };
  const cache = load(read('../lib/optionalBrowserCache.ts'), bindings);
  const writer = load(`${extracted}\nexport { ${exports.join(', ')} };`, {
    ...bindings, ...cache, ...load(read('../lib/rebalanceRunIdentity.ts')),
    apiService: { getAllFullRuns: async () => { throw new Error('502 Bad Gateway'); } },
  });
  return { ...cache, ...writer, values, attempts, notices, warnings };
}

const quota = (name = 'QuotaExceededError') => Object.assign(new Error('storage full'), { name });
const run = (id, market, bundle = 'same inputs') => ({
  id, created_at: `2026-10-01T12:00:${String(id).padStart(2, '0')}Z`, status: 'completed',
  auto_rebalance_portfolio: market === 'india' ? 'india' : 'indmoney_us',
  auto_rebalance_label: `${market === 'india' ? 'India' : 'IndMoney US'} Run #12 (Rebalance Scan)`,
  prompt: `[REBALANCE_FLOW:${market}]\n\n## Rebalance Input Bundle\n${bundle}`,
  run_jobs: Array.from({ length: 7 }, (_, index) => ({
    job_id: id * 100 + index,
    job: { status: 'completed', response: JSON.stringify({ stocks: Array.from({ length: 15 }, (_, stock) => ({ symbol: `STOCK${stock}`, source: index })) }) },
  })),
});
const historyRow = (market, runId, symbol, coveredAt = '2026-10-01T12:00:00Z') => ({
  market, runId, coveredAt, stock: { symbol, key: symbol, rows: [{ source: 'one' }, { source: 'two' }], totalSuggestions: 2 },
});

test('successful caches preserve every matching run, job, response and separate market keys', () => {
  const f = fixture();
  const india = [run(1, 'india'), run(2, 'india')];
  const us = [run(3, 'us'), run(4, 'us')];
  const all = [...india, ...us];
  const original = structuredClone(all);
  for (const [portfolio, market, expected] of [['zerodha', 'india', india], ['indmoneyUs', 'us', us]]) {
    const key = f.buildFinalActionablesCacheKey(portfolio, market);
    f.cacheFinalActionablesRuns(key, all, market);
    assert.deepEqual(f.readFinalActionablesRunCache(key), [...expected].reverse());
  }
  assert.deepEqual(all, original);
  const portfolioSnapshots = { india: { id: 10, holdings: ['INDIA'] }, us: { id: 20, holdings: ['US'] } };
  f.writeDashboardFinalActionablesCache(all, portfolioSnapshots);
  const dashboard = JSON.parse(f.values.get('investment-engine:dashboard:final-actionables:v2'));
  assert.deepEqual(dashboard.runs, [...all].reverse());
  assert.deepEqual(dashboard.portfolioSnapshots, portfolioSnapshots);
  assert.equal(f.warnings.length, 0);
});

test('a full browser retains its prior complete cache and all current source data without partial retries', () => {
  const key = 'investment-engine:final-actionables:runs:indmoneyUs:us:v2';
  const prior = JSON.stringify({ version: 2, runs: [run(1, 'us')], cachedAt: 1 });
  const initial = [[key, prior], ['investment-engine:rebalance-workflow-state:v1', 'workflow'], ['unrelated', 'keep']];
  const f = fixture({ initial, errorForKey: () => quota() });
  const current = [run(2, 'us'), run(3, 'us')];
  const original = structuredClone(current);
  f.cacheFinalActionablesRuns(key, current, 'us');
  f.cacheFinalActionablesRuns(key, current, 'us');
  let serializedAgain = false;
  assert.equal(f.writeOptionalBrowserCache(key, () => { serializedAgain = true; return current; }), false);
  assert.equal(serializedAgain, false);
  assert.deepEqual([...f.values], initial);
  assert.deepEqual(current, original);
  assert.deepEqual(f.attempts, [key]);
  assert.equal(f.notices.length, 1);
  assert.equal(f.warnings.length, 0);
});

test('quota on one market cache does not stop another market from caching a complete snapshot', () => {
  const indiaKey = 'investment-engine:final-actionables:runs:zerodha:india:v2';
  const f = fixture({ errorForKey: (key) => key === indiaKey ? quota('NS_ERROR_DOM_QUOTA_REACHED') : null });
  const usKey = f.buildFinalActionablesCacheKey('indmoneyUs', 'us');
  const india = run(1, 'india');
  const us = run(2, 'us');
  f.cacheFinalActionablesRuns(indiaKey, [india, us], 'india');
  f.cacheFinalActionablesRuns(usKey, [india, us], 'us');
  assert.equal(f.readFinalActionablesRunCache(indiaKey), null);
  assert.deepEqual(f.readFinalActionablesRunCache(usKey), [us]);
});

test('history writes merge complete stock source rows without changing the displayed inputs', () => {
  const f = fixture();
  const older = historyRow('india', 1, 'ONE');
  const newer = historyRow('india', 2, 'TWO', '2026-10-02T12:00:00Z');
  const us = historyRow('us', 3, 'ONE');
  f.writeHistoricalActionRowsCache('india', [older]);
  f.writeHistoricalActionRowsCache('india', [newer]);
  f.writeHistoricalActionRowsCache('us', [us]);
  assert.deepEqual(f.readHistoricalActionRowsCache('india'), [newer, older]);
  assert.deepEqual(f.readHistoricalActionRowsCache('us'), [us]);
  assert.equal(newer.stock.rows.length, 2);
});

test('full history and dashboard caches skip snapshots without eviction, input truncation or warnings', () => {
  const priorHistory = JSON.stringify({ version: 4, rows: [historyRow('india', 99, 'PRIOR')] });
  const initial = [
    ['investment-engine:final-actionables:historical-rows:india:v4', priorHistory],
    ['investment-engine:dashboard:final-actionables:v2', 'prior complete dashboard'],
    ['investment-engine:rebalance-workflow-state:v1', 'workflow'],
  ];
  const f = fixture({ initial, errorForKey: () => quota() });
  const rows = Array.from({ length: 450 }, (_, index) => historyRow('india', index, `STOCK${index}`));
  const original = structuredClone(rows);
  const runs = [run(1, 'india'), run(2, 'us')];
  for (let repeat = 0; repeat < 2; repeat += 1) {
    f.writeHistoricalActionRowsCache('india', rows);
    f.writeHistoricalActionRowsCache('us', [historyRow('us', 3, 'US')]);
    f.writeDashboardFinalActionablesCache(runs, { india: null, us: null });
  }
  assert.deepEqual(rows, original);
  assert.deepEqual([...f.values], initial);
  assert.equal(f.attempts.length, 3);
  assert.equal(f.notices.length, 3);
  assert.equal(f.warnings.length, 0);
});

test('unexpected storage and serialization failures remain diagnosed and API 502 errors still reject', async () => {
  const securityError = Object.assign(new Error('access denied'), { name: 'SecurityError' });
  const f = fixture({ errorForKey: () => securityError });
  f.cacheFinalActionablesRuns(f.buildFinalActionablesCacheKey('zerodha', 'india'), [run(1, 'india')], 'india');
  assert.equal(f.warnings.length, 1);
  assert.equal(f.warnings[0][1], securityError);
  const circular = {}; circular.self = circular;
  assert.throws(() => f.writeOptionalBrowserCache('serialization', () => circular), TypeError);
  assert.equal(f.notices.length, 0);
  await assert.rejects(f.fetchAllFullRuns(), /502 Bad Gateway/);
});

test('server rendering never accesses browser storage or serializes a cache payload', () => {
  const { writeOptionalBrowserCache } = load(read('../lib/optionalBrowserCache.ts'));
  assert.equal(writeOptionalBrowserCache('key', () => { assert.fail('server must not build browser snapshots'); }), false);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const sourcePath = '../app/console/_components/FinalActionablesConsole.tsx';
function load(path, bindings = {}, extraExports = [], transform = (value) => value) {
  const source = transform(readFileSync(new URL(path, import.meta.url), 'utf8'));
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const text = ast.statements.filter((node) => !ts.isImportDeclaration(node)).map((node) => node.getText(ast)).join('\n');
  const output = ts.transpileModule(`${text}\nexport { ${extraExports.join(', ')} };`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const loaded = { exports: {} };
  const entries = Object.entries(bindings).filter(([key]) => key !== 'default' && /^[A-Za-z_$][\w$]*$/.test(key));
  new Function('exports', 'module', 'require', ...entries.map(([key]) => key), output)(
    loaded.exports, loaded, require, ...entries.map(([, value]) => value),
  );
  return loaded.exports;
}
const colors = load('../lib/actionColorScheme.ts');
const parser = load('../components/InvestmentRecommendationTable.tsx', colors);
const imported = {
  ...React, ...parser, ...colors,
  ...load('../lib/technicalSetups.ts'), ...load('../lib/scoreMatrixMath.ts'),
  ...load('../lib/rebalanceRunIdentity.ts'), ...load('../lib/runPresentation.ts'),
  ...load('../lib/actionableQuantityDisplay.ts'),
};
const ui = Object.fromEntries([
  'Link', 'AlertTriangle', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'ChevronDown', 'ChevronRight', 'ChevronUp',
  'FileSpreadsheet', 'FunctionSquare', 'Info', 'RefreshCw', 'Triangle', 'X', 'TradingViewSymbolLink',
  'TradingViewUrlListButton', 'OperationalErrorNotice', 'Button', 'RecommendationAuditPanel',
].map((name) => [name, ({ children }) => React.createElement('span', null, children)]));
function helpers(overrides = {}, transform) {
  const calls = [];
  const technicalCalls = { count: 0 };
  const exports = load(sourcePath, {
    ...imported, ...ui, cn: (...values) => values.filter(Boolean).join(' '),
    useUsdInrRate: () => null,
    URLs: { routes: { console: { runDetail: (id) => `/console/runs/${id}`, technicalSetups: () => '/technical-setups' } } },
    parseInvestmentRecommendationContent: (...args) => {
      calls.push(args[1]);
      return parser.parseInvestmentRecommendationContent(...args);
    },
    technicalCalls,
    ...overrides,
  }, ['formatTechnicalScanSourceLabel', 'parseTechnicalScanResponse', 'fetchParameterScoreObservations', 'ParameterScoreEvidencePopup', 'DetailedRationaleScoreSection', 'buildScoreMatrixDetail', 'ScopedStockDetailsButton', 'fetchFrozenHistoricalMatrix', 'HistoricalScoreMatrixPopup', 'ActionablesCalculationsModal', 'DEFAULT_SCORE_MATRIX_FORMULA_CONFIG', 'RebalanceCell', 'buildActionablesCalculationRows'], (source) => {
    const instrumented = source.replace('const lines = response.split(/\\r?\\n/);', 'technicalCalls.count += 1;\n  const lines = response.split(/\\r?\\n/);');
    return transform ? transform(instrumented) : instrumented;
  });
  return { ...exports, calls, technicalCalls };
}
const timestamp = '2026-09-01T10:00:00Z';
const actionHeader = 'Action (Buy/Add/Sell All/Trim/Hold/Buy New)';
function run(id, stage = 'Rebalance', stocks = 13) {
  const headers = parser.REBALANCE_HEADER_ORDER;
  const rows = Array.from({ length: stocks }, (_, index) => ({
    'Exchange Symbol': 'NSE', 'Stock Symbol': `TEST${index}`, 'Stock Name': `Test Stock ${index}`,
    [actionHeader]: 'Buy New', 'Current Units': '0', 'Units Change': '5', 'Final Units': '5',
    'Units to Buy': '5', 'Price Per Unit': '100', 'Total Buy Amount': '500',
  }));
  const response = `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n${rows.map((row) => `| ${headers.map((header) => row[header] ?? (header.startsWith('Score Rationale') ? '3' : '—')).join(' | ')} |`).join('\n')}`;
  return {
    id, status: 'completed', created_at: timestamp, updated_at: timestamp,
    auto_rebalance_portfolio: 'india', auto_rebalance_label: `India Run #${id} (${stage} Scan)`,
    prompt: stage === 'Rebalance' ? '[REBALANCE_FLOW:india]\nRebalance India holdings.' : 'Act as an India swing-trading strategist.',
    run_jobs: [0, 1].map((index) => ({
      job_id: id * 10 + index,
      job: { provider: 'synthetic', model: 'same-model', status: 'completed', response, created_at: timestamp },
    })),
  };
}

test('each independent Swing job is parsed once per consensus calculation, with identical complete output', () => {
  const cached = helpers();
  // Reference the same calculation with parse reuse disabled, so all output fields are compared.
  const uncached = helpers({}, (source) => source.replace(
    'getSwingScanBreakupEntriesForStock(sourceHistoryRuns, market, first, parsedSwingSources)',
    'getSwingScanBreakupEntriesForStock(sourceHistoryRuns, market, first, new Map())',
  ));
  const selected = run(90);
  const history = [selected, ...Array.from({ length: 6 }, (_, index) => run(index + 1, 'Swing'))];
  const before = structuredClone(history);
  const expected = uncached.buildConsensusRows([selected], 'india', null, history);
  const actual = cached.buildConsensusRows([selected], 'india', null, history);
  assert.deepEqual(actual, expected);
  assert.deepEqual(history, before, 'raw evidence is never changed');
  assert.equal(actual.length, 13);
  assert.equal(cached.calls.length, 2 + 12);
  assert.equal(uncached.calls.length, 2 + 13 * 12);
  for (const stock of actual) {
    assert.equal(stock.swingScanEntries.length, 12);
    assert.equal(new Set(stock.swingScanEntries.map(({ meta }) => `${meta.runId}:${meta.jobId}`)).size, 12);
  }
  assert.deepEqual(cached.buildDashboardActionRows(actual, 'india', {}), uncached.buildDashboardActionRows(expected, 'india', {}));
  history[1].run_jobs[0].job.response = history[1].run_jobs[0].job.response.replaceAll('TEST0', 'REPLACED');
  const refreshed = cached.buildConsensusRows([selected], 'india', null, history);
  assert.equal(refreshed[0].swingScanEntries.length, 11, 'a later calculation must re-read changed source content');
  assert.equal(cached.calls.length, 28, 'cache never survives a calculation');
});

test('unparseable Swing outputs are inspected once and excluded without removing independent valid jobs', () => {
  const h = helpers();
  const selected = run(90);
  const swing = run(1, 'Swing');
  swing.run_jobs[0].job.response = 'No recommendations were captured.';
  const stocks = h.buildConsensusRows([selected], 'india', null, [selected, swing, swing]);
  assert.equal(h.calls.length, 4);
  assert.equal(stocks.length, 13);
  assert.ok(stocks.every((stock) => stock.swingScanEntries.length === 1));
});

function technicalRun(id, minute) {
  const source = run(id, 'Technical');
  source.prompt = '## Technical Scan Input Bundle\nMarket: India equities\n\nSynthetic scan';
  source.created_at = `2026-09-01T10:${String(minute).padStart(2, '0')}:00Z`;
  for (const { job } of source.run_jobs) {
    job.created_at = source.created_at;
    job.updated_at = source.created_at;
    job.response = '| Exchange | Symbol | Primary Setup | Bias | Confidence Score |\n| --- | --- | --- | --- | --- |\n| NSE | TEST0 | Support bounce | bullish | 90 |';
  }
  return source;
}

test('historical reconstruction reuses exact technical sources while preserving every cutoff and output', () => {
  const h = helpers();
  const reference = helpers({}, (source) => source.replace('buildTechnicalScanMap(historicalTechnicalRuns, parsedTechnicalSources)', 'buildTechnicalScanMap(historicalTechnicalRuns)'));
  const runs = [];
  for (let index = 0; index < 6; index += 1) {
    runs.push(technicalRun(10 + index, index * 2));
    const rebalance = run(30 + index, 'Rebalance', 1);
    rebalance.created_at = `2026-09-01T10:${String(index * 2 + 1).padStart(2, '0')}:00Z`;
    runs.push(rebalance);
  }
  // A completed output created before a cutoff but updated later is not yet available.
  runs[0].run_jobs[1].job.updated_at = '2026-09-01T11:00:00Z';
  const before = structuredClone(runs);
  const expected = reference.buildHistoricalDashboardActionRows(runs, 'india', null, {}, reference.DEFAULT_SCORE_MATRIX_FORMULA_CONFIG);
  const actual = h.buildHistoricalDashboardActionRows(runs, 'india', null, {}, h.DEFAULT_SCORE_MATRIX_FORMULA_CONFIG);
  assert.deepEqual(actual, expected);
  assert.deepEqual(runs, before);
  assert.equal(actual.length, 6);
  assert.equal(h.technicalCalls.count, 11);
  assert.equal(reference.technicalCalls.count, 36);
  assert.deepEqual(actual.map(({ detail }) => detail.technicalScanSourceRunId), [15, 14, 13, 12, 11, 10]);
  h.buildHistoricalDashboardActionRows(runs, 'india', null, {}, h.DEFAULT_SCORE_MATRIX_FORMULA_CONFIG);
  assert.equal(h.technicalCalls.count, 22, 'technical cache is private to one reconstruction');
});

test('technical reuse never conflates same IDs with different objects, output content, or parsing metadata', () => {
  const h = helpers();
  const cache = new Map();
  const first = technicalRun(10, 0);
  first.run_jobs = first.run_jobs.slice(0, 1);
  const different = structuredClone(first);
  different.run_jobs[0].job.response = different.run_jobs[0].job.response.replace('TEST0', 'OTHER');
  assert.ok(h.buildTechnicalScanMap([first], cache)['SYMBOL:TEST0']);
  assert.ok(h.buildTechnicalScanMap([different], cache)['SYMBOL:OTHER']);
  first.run_jobs[0].job.response = first.run_jobs[0].job.response.replace('TEST0', 'CHANGED');
  assert.ok(h.buildTechnicalScanMap([first], cache)['SYMBOL:CHANGED']);
  first.run_jobs[0].job.updated_at = '2026-09-01T10:01:00Z';
  assert.equal(h.buildTechnicalScanMap([first], cache)['SYMBOL:CHANGED'].createdAt, '2026-09-01T10:01:00Z');
  assert.equal(h.technicalCalls.count, 4);
});

test('quantity cleanup is confined to consolidated rendering and keeps raw values and sort values', () => {
  const h = helpers();
  const row = Object.freeze({ 'Current Units': '0.7000000000000001' });
  const cell = (isConsolidated) => renderToStaticMarkup(React.createElement(h.RebalanceCell, { row, header: 'Current Units', market: 'us', isConsolidated }));
  assert.equal(cell(false), '0.7000000000000001');
  assert.equal(cell(true), '<span title="0.7000000000000001">0.7</span>');
  const [stock] = h.buildConsensusRows([run(90, 'Rebalance', 1)], 'india');
  stock.positionContext.currentUnits = 0.7000000000000001;
  stock.rows.forEach(({ cells }) => { cells['Current Units'] = '0.7000000000000001'; });
  const before = structuredClone(stock);
  const rows = h.buildActionablesCalculationRows([stock], 'india', {}, h.DEFAULT_SCORE_MATRIX_FORMULA_CONFIG);
  for (const raw of rows.slice(0, 2)) assert.equal(raw.values['Current Units'], '0.7000000000000001');
  for (const summary of rows.slice(2)) {
    assert.equal(renderToStaticMarkup(summary.values['Current Units']), '<span title="0.7000000000000001">0.7</span>');
    assert.equal(summary.sortValues['Current Units'], 0.7000000000000001);
  }
  assert.deepEqual(stock, before);
});

function hookHarness() {
  const values = [];
  let cursor = 0;
  const useState = (initial) => {
    const index = cursor++;
    if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial;
    return [values[index], (next) => { values[index] = typeof next === 'function' ? next(values[index]) : next; }];
  };
  return {
    start: () => { cursor = 0; },
    hooks: { useState, useMemo: (compute) => compute(), useCallback: (fn) => fn, useRef: (value) => ({ current: value }), useEffect: () => {} },
  };
}
function findElement(node, label) {
  if (!node || typeof node !== 'object') return null;
  if (node.props?.['aria-label'] === label) return node;
  return React.Children.toArray(node.props?.children).map((child) => findElement(child, label)).find(Boolean) ?? null;
}

test('closed detail buttons skip cache work; opening, closing during a request, and reopening preserve history access', async () => {
  const harness = hookHarness();
  let reads = 0;
  let requests = 0;
  const pending = [];
  const h = helpers({
    ...harness.hooks,
    window: { localStorage: { getItem: () => { reads += 1; return null; } } },
    apiService: { getFinalActionableHistory: () => { requests += 1; return new Promise((resolve) => pending.push(resolve)); } },
  });
  const [stock] = h.buildConsensusRows([run(90, 'Rebalance', 1)], 'india');
  const props = { stock, market: 'india', technicalScan: null, detailsData: { portfolioSnapshot: null, eventsAnalysis: null, threatsAnalysis: null } };
  const render = () => { harness.start(); return h.ScopedStockDetailsButton(props); };
  const click = (node) => node.props.onClick({ stopPropagation() {} });
  let tree = render();
  assert.equal(reads, 0);
  click(findElement(tree, 'Open TEST0 captured details'));
  tree = render();
  assert.equal(reads, 1);
  assert.equal(requests, 1);
  click(findElement(tree, 'Close stock details'));
  tree = render();
  assert.equal(reads, 1);
  pending.shift()({ items: [], has_more: false, next_cursor: null });
  await Promise.resolve();
  tree = render();
  assert.equal(findElement(tree, 'Close stock details'), null, 'a late history response cannot reopen the popup');
  assert.equal(reads, 1);
  click(findElement(tree, 'Open TEST0 captured details'));
  tree = render();
  assert.equal(reads, 2, 'reopening reads current history instead of retaining a stale closed cache');
  assert.equal(requests, 2);
  assert.ok(findElement(tree, 'Close stock details'));
  pending.shift()({ items: [], has_more: false, next_cursor: null });
  await Promise.resolve();
});

test('opening Calculations does not parse the historical cache for each closed stock-detail button', () => {
  let cacheReads = 0;
  const h = helpers({ window: { localStorage: { getItem: (key) => { if (key.includes('historical-rows')) cacheReads += 1; return null; } } } });
  const selected = run(90);
  const stocks = h.buildConsensusRows([selected], 'india');
  const html = renderToStaticMarkup(React.createElement(h.ActionablesCalculationsModal, {
    open: true, title: 'Synthetic fixture', market: 'india', stocks, runs: [selected], technicalScans: {},
    detailsData: { portfolioSnapshot: null, eventsAnalysis: null, threatsAnalysis: null },
    formulaConfig: h.DEFAULT_SCORE_MATRIX_FORMULA_CONFIG, onClose() {}, onFormulaConfigChange() {},
  }));
  assert.equal(cacheReads, 0);
  assert.equal((html.match(/Model consensus \(Mean and Mode\)/g) ?? []).length, 13);
  assert.equal((html.match(/Current formula/g) ?? []).length, 13);
  assert.equal((html.match(/captured details/g) ?? []).length, 26);
});

function calculationStateFixture(overrides = {}) {
  const h = helpers({ RefreshCw: (props) => React.createElement("svg", props) });
  return renderToStaticMarkup(React.createElement(h.ActionablesCalculationsModal, {
    open: true, title: 'Delayed fixture', market: 'india', stocks: [], runs: [], technicalScans: {},
    formulaConfig: h.DEFAULT_SCORE_MATRIX_FORMULA_CONFIG, onClose() {}, onFormulaConfigChange() {},
    onRetry() {}, ...overrides,
  }));
}

test('calculations distinguish initial pending, loaded empty and failed reads accessibly', () => {
  const pending = calculationStateFixture({ loading: true });
  assert.match(pending, /role="status"/);
  assert.match(pending, /aria-busy="true"/);
  assert.match(pending, /animate-spin/);
  assert.match(pending, /Loading actionable calculations/);
  assert.doesNotMatch(pending, /No actionable calculation rows available/);
  const empty = calculationStateFixture({ loading: false });
  assert.match(empty, /No actionable calculation rows available/);
  assert.doesNotMatch(empty, /Loading actionable calculations|role="alert"/);
  const failed = calculationStateFixture({ loadError: 'History request failed' });
  assert.match(failed, /role="alert"/);
  assert.match(failed, /Unable to load actionable calculations/);
  assert.match(failed, /Try again/);
  assert.doesNotMatch(failed, /No actionable calculation rows available/);
  const retry = calculationStateFixture({ loading: true, loadError: 'Previous error' });
  assert.match(retry, /Loading actionable calculations/);
  assert.doesNotMatch(retry, /Previous error|No actionable calculation rows available/);
});

test('delayed calculation success replaces loading with real calculation rows', () => {
  const h = helpers();
  const selected = run(91, 'Rebalance', 1);
  const resolved = calculationStateFixture({
    loading: false, runs: [selected], stocks: h.buildConsensusRows([selected], 'india'),
  });
  assert.match(resolved, /Model consensus \(Mean and Mode\)/);
  assert.doesNotMatch(resolved, /Loading actionable calculations|No actionable calculation rows available/);
});

test('actual run loader ignores stale success, stale errors and completion after navigation', async () => {
  const source = readFileSync(new URL(sourcePath, import.meta.url), 'utf8');
  const scoped = source.slice(source.indexOf('function ScopedFinalActionablesConsole'));
  const callback = scoped.slice(scoped.indexOf('  const loadRuns = useCallback('), scoped.indexOf('  const loadTechnicalScanHistory'));
  const pending = [];
  const state = { runs: [], loading: false, error: null, cache: [] };
  const requests = { current: 0 };
  const loader = load(sourcePath, {
    useCallback: (fn) => fn, runsRequestRef: requests, market: 'india', runCacheKey: 'india',
    setLoading: (value) => { state.loading = value; }, setError: (value) => { state.error = value; },
    setRuns: (value) => { state.runs = value; },
    cacheFinalActionablesRuns: (...args) => state.cache.push(args),
    fetchAllFullRuns: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
  }, ["loadRuns"], () => callback).loadRuns;
  const first = loader();
  assert.equal(state.loading, true);
  assert.deepEqual(state.runs, []);
  const second = loader();
  pending[0].resolve(['stale']); await first;
  assert.equal(state.loading, true);
  assert.deepEqual(state.runs, []);
  pending[1].resolve(['current']); await second;
  assert.equal(state.loading, false);
  assert.deepEqual(state.runs, ['current']);
  assert.equal(state.cache.length, 1);
  const staleError = loader();
  const latest = loader();
  pending[2].reject(new Error('stale error')); await staleError;
  assert.equal(state.error, null);
  assert.equal(state.loading, true);
  pending[3].reject(new Error('current failure')); await latest;
  assert.equal(state.error, 'current failure');
  assert.equal(state.loading, false);
  const retry = loader();
  assert.equal(state.error, null);
  pending[4].resolve([]); await retry;
  assert.deepEqual(state.runs, []);
  assert.equal(state.loading, false);
  const navigating = loader();
  requests.current += 1; // The actual effect cleanup invalidates requests on unmount.
  pending[5].resolve(['old portfolio']); await navigating;
  assert.deepEqual(state.runs, []);
  assert.match(source, /key=\{`\$\{props.portfolio\}:\$\{props.market\}`\}/);
  assert.match(scoped, /window.clearTimeout\(timeout\);\s*runsRequestRef.current \+= 1;/);
  assert.equal((source.match(/loading=\{loading\}\n        loadError=\{error\}/g) ?? []).length, 2);
});

function savedMatrixFixture(h, overrides = {}) {
  const [stock] = h.buildConsensusRows([run(90, 'Rebalance', 1)], 'india');
  const detail = h.buildScoreMatrixDetail(stock);
  return { id: 17, workflow_id: 8, rebalance_run_id: 90, market: 'india', stock_symbol: 'TEST0',
    coverage_status: 'suggested', action: 'Buy New', consensus_numerator: 1, consensus_denominator: 1, historical_current_value: null, historical_current_units: 0, action_units: 5, amount: 500, covered_at: timestamp, score: detail.calculatedScore, formula_version: 'score-matrix-v1', formula_inputs_json: detail, ...overrides };
}

test('historical fetch maps exact saved stock/date/workflow/run and never falls back to latest', async () => {
  let items = [];
  const calls = [];
  const h = helpers({ apiService: { getFinalActionableHistory: async (params) => { calls.push(params); return { items, has_more: false }; } } });
  const item = savedMatrixFixture(h);
  items = [{ ...item, id: 18, covered_at: '2026-10-28T10:00:00Z' }, item];
  assert.deepEqual(await h.fetchFrozenHistoricalMatrix(item, 'india', 'TEST0', 'NSE'), item.formula_inputs_json);
  assert.deepEqual(calls[0], { market: 'india', symbol: 'TEST0', limit: 50, cursor: null });
  for (const patch of [{ covered_at: 'another day' }, { workflow_id: 9 }, { rebalance_run_id: 99 },
    { market: 'us' }, { stock_symbol: 'OTHER' }, { formula_version: 'legacy-backfill-v1' }, { formula_inputs_json: null },
    { formula_inputs_json: { ...item.formula_inputs_json, stockExchange: 'NYSE' } }]) {
    items = [{ ...item, ...patch }];
    assert.equal(await h.fetchFrozenHistoricalMatrix(item, 'india', 'TEST0', 'NSE'), null);
  }
  items = [{ ...item, id: 18 }];
  assert.equal(await h.fetchFrozenHistoricalMatrix(item, 'india', 'TEST0', 'NSE'), null);
});

test('historical lookup handles pagination and propagates transport errors separately', async () => {
  let count = 0;
  let item;
  const h = helpers({ apiService: { getFinalActionableHistory: async ({ cursor }) => {
    count += 1;
    if (!cursor) return { items: [], has_more: true, next_cursor: 'older' };
    return { items: [item], has_more: false };
  } } });
  item = savedMatrixFixture(h);
  assert.deepEqual(await h.fetchFrozenHistoricalMatrix(item, 'india', 'TEST0', 'NSE'), item.formula_inputs_json);
  assert.equal(count, 2);
  const failed = helpers({ apiService: { getFinalActionableHistory: async () => { throw new Error('network failed'); } } });
  await assert.rejects(failed.fetchFrozenHistoricalMatrix(item, 'india', 'TEST0', 'NSE'), /network failed/);
});

function popupHarness() {
  const slots = []; let cursor = 0; let effects = []; let cleanup = [];
  return {
    start() { cursor = 0; }, flush() { const pending = effects; effects = []; pending.forEach(fn => { const f = fn(); if (f) cleanup.push(f); }); },
    dispose() { cleanup.forEach(fn => fn()); cleanup = []; },
    hooks: {
      useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
      useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
      useEffect(fn) { if (!cleanup.length && !effects.length) effects.push(fn); }, useMemo: fn => fn(), useCallback: fn => fn,
    },
  };
}

test('nested matrix delays, closes only top overlay, traps keys, restores focus and ignores dismissed fetch', async () => {
  const harness = popupHarness(); const pending = []; let restored = 0; let closed = 0; let stopped = 0; let firstFocus = 0; let lastFocus = 0;
  const opener = { focus() { restored += 1; } };
  const doc = { activeElement: opener };
  const h = helpers({ ...harness.hooks, document: doc, apiService: { getFinalActionableHistory: () => new Promise(resolve => pending.push(resolve)) } });
  const item = savedMatrixFixture(h);
  const props = { item, coveredAt: item.covered_at, runId: item.rebalance_run_id, market: 'india', symbol: 'TEST0', exchange: 'NSE', onClose() { closed += 1; } };
  const render = () => { harness.start(); return h.HistoricalScoreMatrixPopup(props); };
  let tree = render();
  assert.match(JSON.stringify(tree), /Loading historical score matrix/);
  const first = { focus() { firstFocus += 1; } }; const last = { focus() { lastFocus += 1; } };
  tree.props.ref.current = { focus() {}, querySelectorAll: () => [first, last] };
  harness.flush();
  // Dialog content must consume inside clicks; backdrop consumes outside clicks.
  const dialog = findMatching(tree, node => node.props?.role === "dialog");
  dialog.props.children.props.onClick({ stopPropagation() { stopped += 1; } });
  assert.equal(closed, 0);
  doc.activeElement = last;
  tree.props.onKeyDown({ key: 'Tab', preventDefault() {}, stopPropagation() {} });
  assert.equal(firstFocus, 1);
  doc.activeElement = first;
  tree.props.onKeyDown({ key: 'Tab', shiftKey: true, preventDefault() {}, stopPropagation() {} });
  assert.equal(lastFocus, 1);
  tree.props.onClick({ stopPropagation() { stopped += 1; } });
  assert.equal(closed, 1); assert.equal(stopped, 2);
  harness.dispose();
  assert.equal(restored, 1);
  pending.shift()({ items: [item], has_more: false });
  await Promise.resolve(); await Promise.resolve();
  tree = render();
  assert.match(JSON.stringify(tree), /Loading historical score matrix/, 'dismissed requests cannot install a matrix');
  tree.props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() { stopped += 1; } });
  assert.equal(closed, 2);
});

test('historical modal renders saved detail through the existing frozen matrix contract', async () => {
  const harness = popupHarness(); let item;
  const h = helpers({ ...harness.hooks, document: { activeElement: { focus() {} } }, apiService: { getFinalActionableHistory: async () => ({ items: [item], has_more: false }) } });
  item = savedMatrixFixture(h);
  const props = { item, coveredAt: item.covered_at, runId: 90, market: 'india', symbol: 'TEST0', exchange: 'NSE', onClose() {} };
  const render = () => { harness.start(); return h.HistoricalScoreMatrixPopup(props); };
  render(); harness.flush(); await new Promise(resolve => setImmediate(resolve));
  const matrix = findMatching(render(), node => node.type === h.ScoreMatrixModal);
  assert.ok(matrix);
  assert.equal(matrix.props.frozen, true);
  assert.deepEqual(matrix.props.detail, item.formula_inputs_json);
  assert.match(matrix.props.historicalLabel, /Run #90/);
  harness.dispose();
});

test('historical popup distinguishes missing snapshots and errors and supports clean reopen', async () => {
  for (const outcome of ['missing', 'error', 'success']) {
    const harness = popupHarness(); let item;
    const h = helpers({ ...harness.hooks, document: { activeElement: { focus() {} } }, apiService: { getFinalActionableHistory: async () => {
      if (outcome === 'error') throw new Error('Historical service unavailable');
      return { items: outcome === 'missing' ? [] : [item], has_more: false };
    } } });
    item = savedMatrixFixture(h, { id: outcome === 'success' ? 19 : 17 });
    const props = { item, coveredAt: item.covered_at, runId: 90, market: 'india', symbol: 'TEST0', exchange: 'NSE', onClose() {} };
    const render = () => { harness.start(); return h.HistoricalScoreMatrixPopup(props); };
    render(); harness.flush(); await new Promise(resolve => setImmediate(resolve));
    const tree = render();
    if (outcome === 'success') assert.equal(findMatching(tree, node => node.type === h.ScoreMatrixModal).props.detail, item.formula_inputs_json);
    else {
      const text = JSON.stringify(tree);
      assert.match(text, outcome === 'error' ? /Unable to load historical score matrix/ : /No original weighted score matrix/);
      assert.doesNotMatch(text, /Loading historical score matrix/);
    }
    harness.dispose();
  }
  const source = readFileSync(new URL(sourcePath, import.meta.url), 'utf8');
  assert.match(source, /key=\{`\$\{props.market\}:\$\{props.stock.key\}`\}/);
  assert.match(source, /key=\{`\$\{historicalMatrix.runId\}:\$\{historicalMatrix.coveredAt\}`\}/);
  assert.match(source, /inert=\{historicalMatrix \? true : undefined\}/);
  assert.match(source, /readOnly=\{frozen\}/);
  assert.match(source, /return frozen \? detail : applyScoreMatrixFormulaConfig/);
});

test('reconstructed dates require one exact historical run/date match without guessing workflows', async () => {
  let items = [];
  const h = helpers({ apiService: { getFinalActionableHistory: async () => ({ items, has_more: false }) } });
  const item = savedMatrixFixture(h);
  const target = { runId: 90, coveredAt: timestamp };
  items = [item];
  assert.equal(await h.fetchFrozenHistoricalMatrix(null, 'india', 'TEST0', 'NSE', target), item.formula_inputs_json);
  items = [item, { ...item, id: 18, workflow_id: 9 }];
  assert.equal(await h.fetchFrozenHistoricalMatrix(null, 'india', 'TEST0', 'NSE', target), null);
  items = [{ ...item, covered_at: '2026-10-28T00:00:00Z' }];
  assert.equal(await h.fetchFrozenHistoricalMatrix(null, 'india', 'TEST0', 'NSE', target), null);
});

function findMatching(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  return React.Children.toArray(node.props?.children).map(child => findMatching(child, predicate)).find(Boolean) ?? null;
}

test('historical score clicks stack locally; outside top close preserves captured details and reopen', async () => {
  const harness = hookHarness(); let item;
  const h = helpers({ ...harness.hooks, apiService: { getFinalActionableHistory: async () => ({ items: [item], has_more: false }) } });
  item = savedMatrixFixture(h);
  const [stock] = h.buildConsensusRows([run(90, 'Rebalance', 1)], 'india');
  const props = { stock, market: 'india', technicalScan: null, detailsData: { portfolioSnapshot: null, eventsAnalysis: null, threatsAnalysis: null } };
  const render = () => { harness.start(); return h.ScopedStockDetailsButton(props); };
  findElement(render(), 'Open TEST0 captured details').props.onClick({ stopPropagation() {} });
  await Promise.resolve(); await Promise.resolve();
  let tree = render();
  const score = findMatching(tree, node => node.props?.['aria-label']?.startsWith('Open TEST0 score matrix for'));
  assert.ok(score);
  score.props.onClick(); tree = render();
  const top = findMatching(tree, node => node.type === h.HistoricalScoreMatrixPopup);
  assert.ok(top);
  assert.equal(top.props.item.id, item.id);
  const underneath = findMatching(tree, node => node.props?.['aria-labelledby'] === `stock-details-${stock.key}`);
  assert.equal(underneath.props.inert, true);
  underneath.props.onClick({ stopPropagation() {} }); // No click-through even if invoked programmatically.
  assert.ok(findElement(render(), 'Close stock details'));
  top.props.onClose(); tree = render();
  assert.ok(findElement(tree, 'Close stock details'));
  assert.equal(findMatching(tree, node => node.type === h.HistoricalScoreMatrixPopup), null);
  score.props.onClick(); tree = render();
  assert.ok(findMatching(tree, node => node.type === h.HistoricalScoreMatrixPopup));
});

function parameterFixture(h, id = 90) {
  const selected = run(id, 'Rebalance', 1);
  const headers = parser.REBALANCE_HEADER_ORDER;
  selected.run_jobs.forEach((link, index) => {
    const cells = Object.fromEntries(headers.map(header => [header, '—']));
    Object.assign(cells, { 'Exchange Symbol': 'NSE', 'Stock Symbol': 'TEST0', [actionHeader]: 'Buy New',
      'Current Units': '0', 'Units Change': '5', 'Final Units': '5', 'Units to Buy': '5', 'Price Per Unit': '100', 'Total Buy Amount': '500',
      'Score Rationale Technical Setup Short Term 1–3 Months': String(index + 2),
      'Rationale Technical Setup Short Term 1–3 Months': `Original short rationale ${id}/${link.job_id}`,
      'Score Rationale - Technical Setup (Medium Term)': '-2',
      'Rationale - Technical Setup (Medium Term)': 'Different medium-term rationale',
    });
    link.job.response = `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n| ${headers.map(header => cells[header]).join(' | ')} |`;
  });
  const [stock] = h.buildConsensusRows([selected], 'india');
  const detail = h.buildScoreMatrixDetail(stock);
  return { selected, detail, parameter: detail.detailedRationaleRows.find(row => row.id === 'technical-short') };
}

test('parameter evidence shows each original job score and its own rationale, not the aggregate or another field', async () => {
  let selected; const calls = [];
  const h = helpers({ apiService: { getRun: async id => { calls.push(id); return selected; } } });
  const fixture = parameterFixture(h); selected = fixture.selected;
  assert.equal(fixture.parameter.score, 2.5);
  const before = structuredClone(fixture.detail);
  const rows = await h.fetchParameterScoreObservations(fixture.detail, fixture.parameter);
  assert.deepEqual(rows.map(row => row.score), [2, 3]);
  assert.deepEqual(rows.map(row => row.jobId), [900, 901]);
  assert.deepEqual(rows.map(row => row.rationale), ['Original short rationale 90/900', 'Original short rationale 90/901']);
  assert.ok(rows.every(row => row.label.includes('synthetic same-model') && row.label.includes('Rebalance Scan') && row.label.includes('2026')));
  assert.deepEqual(calls, [90]);
  assert.deepEqual(fixture.detail, before);
  const medium = fixture.detail.detailedRationaleRows.find(row => row.id === 'technical-medium');
  const mediumRows = await h.fetchParameterScoreObservations(fixture.detail, medium);
  assert.deepEqual(mediumRows.map(row => row.score), [-2, -2]);
  assert.ok(mediumRows.every(row => row.rationale === 'Different medium-term rationale'));
});

test('parameter provenance fails honestly for missing jobs, wrong stocks, markets, runs or saved contributor metadata', async () => {
  let selected;
  const h = helpers({ apiService: { getRun: async () => selected } });
  const fixture = parameterFixture(h); selected = fixture.selected;
  selected.run_jobs[0].job.response = selected.run_jobs[0].job.response.replaceAll('TEST0', 'OTHER');
  let rows = await h.fetchParameterScoreObservations(fixture.detail, fixture.parameter);
  assert.equal(rows[0].score, null); assert.match(rows[0].rationale, /exact original stock row/);
  assert.equal(rows[1].score, 3);
  selected.run_jobs[1].job.model = 'different-model';
  rows = await h.fetchParameterScoreObservations(fixture.detail, fixture.parameter);
  assert.equal(rows[1].score, null); assert.match(rows[1].rationale, /identity/);
  selected.id = 91;
  await assert.rejects(h.fetchParameterScoreObservations(fixture.detail, fixture.parameter), /identity/);
  selected.id = 90; selected.auto_rebalance_portfolio = 'indmoney_us'; selected.auto_rebalance_label = 'IndMoney US Run #90 (Rebalance Scan)'; selected.prompt = '[REBALANCE_FLOW:us]';
  await assert.rejects(h.fetchParameterScoreObservations(fixture.detail, fixture.parameter), /identity/);
  assert.deepEqual(await h.fetchParameterScoreObservations(fixture.detail, { id: 'mean-mode-action' }), []);
  assert.deepEqual(await h.fetchParameterScoreObservations(fixture.detail, { id: 'technical-scan-confidence' }), []);
});

test('third popup loading, exact columns, inside/outside clicks, Escape, focus and stale dismissal stay local', async () => {
  const harness = popupHarness(); const pending = []; let selected; let restored = 0; let closed = 0; let stopped = 0;
  const doc = { activeElement: { focus() { restored += 1; } } };
  const h = helpers({ ...harness.hooks, document: doc, apiService: { getRun: () => new Promise(resolve => pending.push(resolve)) } });
  const fixture = parameterFixture(h); selected = fixture.selected;
  const props = { detail: fixture.detail, parameter: fixture.parameter, onClose() { closed += 1; } };
  const render = () => { harness.start(); return h.ParameterScoreEvidencePopup(props); };
  let tree = render(); assert.match(JSON.stringify(tree), /Loading original scores/);
  let firstFocus = 0;
  const first = { focus() { firstFocus += 1; } }; const last = { focus() {} };
  tree.props.ref.current = { focus() {}, querySelectorAll: () => [first, last] };
  harness.flush();
  doc.activeElement = last;
  tree.props.onKeyDown({ key: 'Tab', stopPropagation() { stopped += 1; }, preventDefault() {} });
  assert.equal(firstFocus, 1);
  tree.props.children.props.onClick({ stopPropagation() { stopped += 1; } }); assert.equal(closed, 0);
  tree.props.onClick({ stopPropagation() { stopped += 1; } }); assert.equal(closed, 1);
  tree.props.onKeyDown({ key: 'Escape', stopPropagation() { stopped += 1; }, preventDefault() {} }); assert.equal(closed, 2);
  harness.dispose(); assert.equal(restored, 1);
  pending.shift()(selected); await new Promise(resolve => setImmediate(resolve));
  assert.match(JSON.stringify(render()), /Loading original scores/, 'dismissed completion cannot replace or reopen any layer');
  assert.equal(stopped, 4);
  const readyHarness = popupHarness();
  const ready = helpers({ ...readyHarness.hooks, document: { activeElement: { focus() {} } }, apiService: { getRun: async () => selected } });
  const readyRender = () => { readyHarness.start(); return ready.ParameterScoreEvidencePopup(props); };
  readyRender(); readyHarness.flush(); await new Promise(resolve => setImmediate(resolve)); await Promise.resolve();
  const text = JSON.stringify(readyRender());
  assert.match(text, /Run \/ LLM/); assert.match(text, /Rationale/); assert.match(text, /Score/);
  assert.match(text, /Original short rationale 90\/900/);
  readyHarness.dispose();
});

test('technical parameter evidence uses the captured technical job only and labels missing rationale', async () => {
  let selected;
  const h = helpers({ apiService: { getRun: async () => selected } });
  selected = technicalRun(92, 5);
  const fixture = parameterFixture(h);
  const link = selected.run_jobs[0];
  const parsed = h.parseTechnicalScanResponse(link.job.response, { runId: 92, jobId: link.job_id, provider: link.job.provider, model: link.job.model, runLabel: selected.auto_rebalance_label, createdAt: link.job.updated_at });
  const detail = { ...fixture.detail, technicalScanSourceRunId: 92, technicalScanSourceJobId: link.job_id, technicalScanSourceLabel: h.formatTechnicalScanSourceLabel(parsed[0]) };
  const rows = await h.fetchParameterScoreObservations(detail, { id: 'technical-scan-confidence' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].jobId, 920);
  assert.equal(rows[0].score, 90);
  assert.match(rows[0].rationale, /parameter-specific rationale was not captured/);
  const legacy = { ...detail, technicalScanSourceJobId: undefined };
  assert.deepEqual(await h.fetchParameterScoreObservations(legacy, { id: 'technical-scan-confidence' }), []);
});

test('third layer distinguishes failed/absent evidence, traps focus and exposes accessible parameter score links', async () => {
  for (const failure of [false, true]) {
    const harness = popupHarness();
    const h = helpers({ ...harness.hooks, document: { activeElement: { focus() {} } }, apiService: { getRun: async () => { throw new Error('Source API failed'); } } });
    const fixture = parameterFixture(h);
    const parameter = failure ? fixture.parameter : { id: 'mean-mode-action', parameter: 'Consolidated action' };
    const render = () => { harness.start(); return h.ParameterScoreEvidencePopup({ detail: fixture.detail, parameter, onClose() {} }); };
    render(); harness.flush(); await new Promise(resolve => setImmediate(resolve));
    const text = JSON.stringify(render());
    assert.match(text, failure ? /Unable to load parameter evidence/ : /Original per-run score\/rationale provenance was not captured/);
    assert.doesNotMatch(text, /Loading original scores/);
    harness.dispose();
  }
  let selectedParameter;
  const h = helpers(); const fixture = parameterFixture(h);
  const section = h.DetailedRationaleScoreSection;
  const html = renderToStaticMarkup(React.createElement(section, { detail: fixture.detail, readOnly: true, onParameterScoreOpen: row => { selectedParameter = row; } }));
  assert.match(html, /Show original scores and rationale for Average of Score Rationale - Technical Setup/);
  const source = readFileSync(new URL(sourcePath, import.meta.url), 'utf8');
  assert.match(source, /inert=\{selectedParameter \? true : undefined\}/);
  assert.match(source, /onParameterScoreOpen=\{setSelectedParameter\}/);
  assert.match(source, /onKeyDown=\{event => \{\s*event.stopPropagation\(\);/);
  assert.equal(selectedParameter, undefined, 'rendering a score must never initiate a provider/job action');
});

function retainedEvidenceFixture(h, matrix = true) {
  const item = savedMatrixFixture(h);
  const observations = [{ id: 'frozen:900:short', runId: 90, jobId: 900, label: 'Run #90 (Rebalance Scan) · Job #900 · synthetic model · 2026-09-01', score: 2, rationale: 'Original captured short rationale' }];
  return { item, view: { scope: { run_id: 90, market: 'india', symbol: 'TEST0', exchange: 'NSE', covered_at: timestamp, history_id: 17 }, status: matrix ? 'available' : 'partial', matrix: matrix ? item.formula_inputs_json : null, parameters: { 'technical-short': observations }, parameter_labels: { 'technical-short': 'Technical Setup Short Term' }, notes: matrix ? ['Saved immutable capture; current formulas were not applied.'] : ['The original weighted formula was not captured.'], candidates: [], coverage: { matching_captures: 1 } } };
}

test('historical reader uses retained exact-scope evidence without raw jobs or current recalculation', async () => {
  let view; const requests = [];
  const h = helpers({ apiService: { getHistoricalScoreEvidence: async params => { requests.push(params); return view; }, getRun: () => { throw new Error('raw job/run reads forbidden'); }, getFinalActionableHistory: () => { throw new Error('legacy scan forbidden'); } } });
  const fixture = retainedEvidenceFixture(h); view = fixture.view;
  const detail = await h.fetchFrozenHistoricalMatrix(fixture.item, 'india', 'TEST0', 'NSE');
  assert.equal(detail.calculatedScore, fixture.item.formula_inputs_json.calculatedScore);
  assert.equal(detail.calculatedAction, fixture.item.formula_inputs_json.calculatedAction);
  assert.deepEqual(requests[0], { run_id: 90, market: 'india', symbol: 'TEST0', exchange: 'NSE', covered_at: timestamp, history_id: 17 });
  assert.deepEqual(await h.fetchParameterScoreObservations(detail, { id: 'technical-short' }), view.parameters['technical-short']);
  assert.deepEqual(await h.fetchParameterScoreObservations(detail, { id: 'technical-long' }), []);
  for (const scope of [{ ...view.scope, symbol: 'OTHER' }, { ...view.scope, market: 'us' }, { ...view.scope, covered_at: '2026-09-01T10:00:01Z' }, { ...view.scope, history_id: 18 }]) {
    view = { ...fixture.view, scope };
    await assert.rejects(h.fetchFrozenHistoricalMatrix(fixture.item, 'india', 'TEST0', 'NSE'), /scope does not match/);
  }
});

test('immutable ambiguity is not replaced with latest data; reader failures differ from disabled-reader fallback', async () => {
  let fail = null, view; let nativeReads = 0; let item;
  const h = helpers({ apiService: { getHistoricalScoreEvidence: async () => { if (fail) throw fail; return view; }, getFinalActionableHistory: async () => { nativeReads += 1; return { items: [item], has_more: false }; } } });
  const fixture = retainedEvidenceFixture(h); item = fixture.item;
  view = { ...fixture.view, status: 'ambiguous', matrix: null, parameters: {}, notes: ['Multiple exact revisions'] };
  assert.equal(await h.fetchFrozenHistoricalMatrix(item, 'india', 'TEST0', 'NSE'), null);
  assert.equal(nativeReads, 0);
  fail = Object.assign(new Error('Reader disabled'), { status: 404 });
  assert.deepEqual(await h.fetchFrozenHistoricalMatrix(item, 'india', 'TEST0', 'NSE'), item.formula_inputs_json);
  assert.equal(nativeReads, 1);
  fail = Object.assign(new Error('Storage unavailable'), { status: 503 });
  await assert.rejects(h.fetchFrozenHistoricalMatrix(item, 'india', 'TEST0', 'NSE'), /Storage unavailable/);
  assert.equal(nativeReads, 1);
});

test('missing matrix can open retained parameter observations without inventing a score/action', async () => {
  const harness = popupHarness(); let view; let calls = 0;
  const h = helpers({ ...harness.hooks, document: { activeElement: { focus() {} } }, apiService: { getHistoricalScoreEvidence: async () => { calls += 1; return view; } } });
  const fixture = retainedEvidenceFixture(h, false); view = fixture.view;
  const props = { item: fixture.item, coveredAt: timestamp, runId: 90, market: 'india', symbol: 'TEST0', exchange: 'NSE', onClose() {} };
  const render = () => { harness.start(); return h.HistoricalScoreMatrixPopup(props); };
  render(); harness.flush(); await new Promise(resolve => setImmediate(resolve));
  let tree = render();
  assert.match(JSON.stringify(tree), /original weighted formula was not captured/);
  const button = findMatching(tree, node => node.type === 'button' && JSON.stringify(node.props.children).includes('View original'));
  assert.ok(button); button.props.onClick(); tree = render();
  const top = findMatching(tree, node => node.type === h.ParameterScoreEvidencePopup);
  assert.ok(top);
  assert.deepEqual(top.props.observations, view.parameters['technical-short']);
  assert.equal(top.props.detail.calculatedScore, undefined);
  assert.equal(top.props.detail.calculatedAction, undefined);
  top.props.onClose(); tree = render();
  assert.equal(findMatching(tree, node => node.type === h.ParameterScoreEvidencePopup), null);
  assert.match(JSON.stringify(tree), /original weighted formula was not captured/);
  assert.equal(calls, 1);
  harness.dispose();
});


test('saved history score-based display reuses actual matrix rules and preserves original model actions', () => {
  const exports = helpers();
  const derive = (score, units = 10, action = 'Hold') => { const item = { score, historical_current_units: units, coverage_status: 'suggested', action }; const before = structuredClone(item); const result = exports.historyScoreDerivedAction(item); assert.deepEqual(item, before); return result; };
  assert.equal(derive(2.83).action, 'Add more');
  assert.equal(derive(2.83, 0).action, 'Buy New');
  assert.equal(derive(0.11, 10, 'Sell All').action, 'Hold');
  for (const [score, action] of [[-3, 'Sell All'], [-2.000001, 'Sell All'], [-2, 'Trim'], [-1.000001, 'Trim'], [-1, 'Hold'], [-0.25, 'Hold'], [0, 'Hold'], [0.999999, 'Hold'], [1, 'Add more'], [1.999999, 'Add more'], [2, 'Add more'], [3, 'Add more']]) assert.equal(derive(score).action, action, String(score));
  assert.equal(derive(0.999999).action, 'Hold', 'rounding to 1.00 must not cross an exact boundary');
  assert.equal(derive(-2.000001).action, 'Sell All', 'rounding to -2.00 must not cross an exact boundary');
  for (const score of [null, NaN, Infinity, -3.01, 3.01]) assert.equal(derive(score).action, null);
  for (const units of [null, NaN, -1]) { const result = derive(2.83, units); assert.equal(result.action, null); assert.match(result.note, /historical holdings are unavailable/); }
  assert.equal(exports.historyScoreDerivedAction({ score: 2.83, historical_current_units: 10, coverage_status: 'run_failed' }).action, null);
  const source = readFileSync(new URL(sourcePath, import.meta.url), 'utf8');
  assert.match(source, /Score-based action · current rules/); assert.match(source, /Original recorded action/); assert.match(source, /FinalActionValue value=\{item.action\}/); assert.match(source, /Exact saved score:/);
});

test('retained-source scan follows empty pages, keeps distinct LLM/revision rows, deduplicates immutable copies and ignores dismissed requests', async () => {
  const first = { id: '438:1:hash:0', run_id: 438, job_id: 1, created_at: '2026-10-28T10:00:00Z' }, second = { ...first, id: '438:2:hash2:0', job_id: 2 };
  const responses = [ { items: [first], next_cursor: 'jobs:9', has_more: true }, { items: [], next_cursor: 'audit:', has_more: true }, { items: [first, second], next_cursor: null, has_more: false } ];
  const calls = [], updates = [];
  const { scanStockSourceObservations } = helpers({ apiService: { getStockSourceObservations: async params => { calls.push(params.cursor); return { market: 'india', symbol: 'HAL', examined_sources: 1, coverage_note: 'retained only', ...responses.shift() }; } } });
  await scanStockSourceObservations('india', 'HAL', rows => updates.push(rows), () => true);
  assert.deepEqual(calls, [null, 'jobs:9', 'audit:']); assert.equal(updates.at(-1).length, 2); assert.equal(updates.at(-1)[0].run_id, 438);
  let active = true, resolve; const pending = new Promise(r => { resolve = r; });
  const stale = helpers({ apiService: { getStockSourceObservations: () => pending } });
  let published = 0; const loading = stale.scanStockSourceObservations('india', 'HAL', () => published++, () => active);
  active = false; resolve({ market: 'india', symbol: 'HAL', items: [first], has_more: false }); await loading; assert.equal(published, 0);
  const wrong = helpers({ apiService: { getStockSourceObservations: async () => ({ market: 'us', symbol: 'HAL' }) } });
  await assert.rejects(wrong.scanStockSourceObservations('india', 'HAL', () => {}, () => true), /does not match/);
  const loop = helpers({ apiService: { getStockSourceObservations: async () => ({ market: 'india', symbol: 'HAL', items: [], examined_sources: 0, has_more: true, next_cursor: 'same' }) } });
  await assert.rejects(loop.scanStockSourceObservations('india', 'HAL', () => {}, () => true), /did not advance/);
});


test('unified history puts newer reconstructions above old saved summaries while preserving original context and missing historical holdings', () => {
  const { RetainedStockObservations } = helpers();
  const saved = [{ id: 1, rebalance_run_id: 200, covered_at: '2026-10-05T03:58:00Z', stock_symbol: 'HAL', score: 2.83, action: 'Hold', historical_current_units: null, coverage_status: 'suggested', formula_version: 'legacy-backfill-v1' }, { id: 2, rebalance_run_id: 199, covered_at: '2026-10-03T11:04:00Z', stock_symbol: 'HAL', score: 0.11, action: 'Sell All', historical_current_units: 2, coverage_status: 'suggested', formula_version: 'legacy-backfill-v1' }];
  const reconstructed = [{ id: 'HAL', runId: 438, coveredAt: '2026-10-28T03:50:00Z', formulaAction: 'Add more', formulaScore: 2.60, detail: { currentUnits: 2 } }];
  const before = structuredClone(saved);
  const html = renderToStaticMarkup(React.createElement(RetainedStockObservations, { market: 'india', symbol: 'HAL', saved, reconstructed }));
  assert.ok(html.indexOf('Run #438') < html.indexOf('Run #200'));
  assert.match(html, /Reconstructed · current formula, not original saved decision/);
  assert.match(html, /historical holdings are unavailable/);
  assert.match(html, /Sell All/); assert.match(html, /Hold/); assert.match(html, /2.83/); assert.match(html, /0.11/);
  assert.deepEqual(saved, before);
});


test('reconstructed score opens its exact displayed source detail without guessing among immutable revisions', async () => {
  let auditCalls = 0;
  const api = helpers({ apiService: { getHistoricalScoreEvidence: async () => { auditCalls++; throw new Error('ambiguous'); } } });
  const detail = api.buildScoreMatrixDetail(api.buildConsensusRows([run(438, 'Rebalance', 1)], 'india')[0]);
  const actual = await api.fetchFrozenHistoricalMatrix(null, 'india', detail.stockSymbol, detail.stockExchange, { runId: 438, coveredAt: timestamp, reconstructedDetail: detail });
  assert.equal(actual.calculatedScore, detail.calculatedScore); assert.deepEqual(actual.rows, detail.rows); assert.equal(auditCalls, 0);
  assert.match(actual.historicalReadNotes[0], /not the original historical/);
  await assert.rejects(api.fetchFrozenHistoricalMatrix(null, 'india', 'WRONG', detail.stockExchange, { runId: 438, coveredAt: timestamp, reconstructedDetail: detail }), /does not match/);
});

test('saved legacy parameter cells remain available without advisory-audit access, without inventing a historical matrix', async () => {
  const api = helpers({ apiService: { getHistoricalScoreEvidence: async () => { throw { status: 404 }; }, getFinalActionableHistory: async () => ({ items: [], has_more: false }) } });
  const item = { id: 5, rebalance_run_id: 200, market: 'india', stock_symbol: 'HAL', covered_at: timestamp, formula_version: 'legacy-backfill-v1', snapshot_json: { rows: [{ job_id: 1, provider: 'deepseek', model: 'original', raw: { 'exchange symbol': 'NSE', 'stock symbol': 'HAL', 'score rationale technical setup short term 1 3 months': '2.50', 'rationale technical setup short term 1 3 months': 'Original breakout rationale' } }] } };
  const before = structuredClone(item);
  const view = api.savedLegacyParameterEvidence(item, 'india', 'HAL', 'NSE');
  assert.equal(view.matrix, null); assert.equal(view.parameters['technical-short'][0].score, 2.5); assert.equal(view.parameters['technical-short'][0].rationale, 'Original breakout rationale');
  assert.equal(api.savedLegacyParameterEvidence(item, 'us', 'HAL', 'NSE'), null); assert.equal(api.savedLegacyParameterEvidence(item, 'india', 'HAL', 'BSE'), null);
  const duplicate = structuredClone(item); duplicate.snapshot_json.rows.push(structuredClone(duplicate.snapshot_json.rows[0])); assert.equal(api.savedLegacyParameterEvidence(duplicate, 'india', 'HAL', 'NSE'), null);
  assert.deepEqual(item, before);
});

test('large retained history mounts only 25 rows and defers original field rendering until expanded', () => {
  let fieldReads = 0;
  const originals = Array.from({ length: 400 }, (_, index) => ({ id: `synthetic:${index}`, run_id: index + 1, job_id: index + 1, stage: 'technical', run_status: 'completed', job_status: 'completed', provider: 'fixture', model: 'fixture', created_at: timestamp, source: 'retained_job', cells: { get rationale() { fieldReads++; return 'Synthetic original rationale '.repeat(1000); } } }));
  let selectedPage = 0;
  const renderPage = () => {
    let hook = 0;
    const { RetainedStockObservations } = helpers({ useState: initial => {
      const index = hook++;
      const value = index === 0 ? { rows: originals, examined: 2099, note: 'fixture', loading: false, error: null } : index === 2 ? selectedPage : typeof initial === 'function' ? initial() : initial;
      return [value, () => {}];
    } });
    return renderToStaticMarkup(React.createElement(RetainedStockObservations, { market: 'india', symbol: 'HAL', saved: [], reconstructed: [] }));
  };
  const first = renderPage();
  assert.match(first, /Showing 1–25 of 400 observations/);
  assert.equal((first.match(/<tr /g) ?? []).length, 25);
  assert.equal(fieldReads, 0);
  assert.ok(first.length < 100000);
  selectedPage = 15;
  const last = renderPage();
  assert.match(last, /Showing 376–400 of 400 observations/);
  assert.match(last, /Run #1/);
  assert.equal(fieldReads, 0);
  assert.equal(originals.length, 400);
  const { RetainedSourceFields } = helpers({ useState: () => [true, () => {}] });
  const opened = renderToStaticMarkup(React.createElement(RetainedSourceFields, { cells: originals[0].cells }));
  assert.match(opened, /Synthetic original rationale/);
  assert.equal(fieldReads, 1);
});

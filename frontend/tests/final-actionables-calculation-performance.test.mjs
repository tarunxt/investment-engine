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
const { withFinalActionablesReadDeadline } = load('../lib/finalActionablesReadDeadline.ts');
const parser = load('../components/InvestmentRecommendationTable.tsx', colors);
const imported = {
  ...React, ...parser, ...colors,
  ...load("../components/CollapsedSection.tsx", React),
  ...load("../components/StockScanHistory.tsx"),
  ...load('../lib/technicalSetups.ts'), ...load('../lib/scoreMatrixMath.ts'),
  ...load('../lib/rebalanceRunIdentity.ts'), ...load('../lib/runPresentation.ts'),
  ...load('../lib/actionableQuantityDisplay.ts'),
  ...load('../components/AllocationScoreContext.tsx', load('../lib/basketDisplayCalculations.ts')),
  ...load('../lib/summarySourceRows.ts'),
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
function componentChildren(node) {
  return [...React.Children.toArray(node.props?.children), ...(typeof node.props?.renderRow === 'function' && Array.isArray(node.props.rows) ? node.props.rows.map(node.props.renderRow) : []), ...React.Children.toArray(node.props?.controls)];
}
function findElement(node, label) {
  if (!node || typeof node !== 'object') return null;
  if (node.props?.['aria-label'] === label) return node;
  return componentChildren(node).map((child) => findElement(child, label)).find(Boolean) ?? null;
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
    withFinalActionablesReadDeadline,
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
  return componentChildren(node).map(child => findMatching(child, predicate)).find(Boolean) ?? null;
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
  assert.doesNotMatch(JSON.stringify(tree), /Score-based action applies today’s score-range rules|Historical formula context may differ from today’s rules/);
  assert.ok(findMatching(tree, node => node.type === imported.StockScanHistory), 'history widget remains available');
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
  assert.match(html, /Show original scores and rationale for Average of: Score Rationale - Technical Setup/);
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
      const value = index === 0 ? { rows: originals, examined: 2099, note: 'fixture', loading: false, error: null } : index === 3 ? selectedPage : typeof initial === 'function' ? initial() : initial;
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

test('retained scans stop after four pages, publish once, and explicitly resume without duplicate observations',async()=>{
 let calls=0;const observation={id:'recent-run',run_id:447,job_id:2234,created_at:timestamp};
 const {scanStockSourceObservations}=helpers({apiService:{getStockSourceObservations:async ({cursor})=>{calls++;const index=cursor?Number(cursor):0;return{market:'india',symbol:'HAL',items:[{...observation,id:index===0?'recent-run':`row-${index}`}],examined_sources:100,coverage_note:'saved only',has_more:index<7,next_cursor:index<7?String(index+1):null};}}});
 const updates=[];const first=await scanStockSourceObservations('india','HAL',(rows,examined)=>updates.push({rows,examined}),()=>true);assert.equal(calls,4);assert.equal(updates.length,1);assert.equal(updates[0].examined,400);assert.equal(updates[0].rows[0].run_id,447);assert.equal(first.cursor,'4');assert.equal(first.hasMore,true);
 const second=[];const last=await scanStockSourceObservations('india','HAL',rows=>second.push(...rows),()=>true,first.cursor);assert.equal(calls,8);assert.equal(last.hasMore,false);assert.equal(new Set([...updates[0].rows,...second].map(row=>row.id)).size,8);
 const source=readFileSync(new URL(sourcePath,import.meta.url),'utf8');assert.match(source,/limit: 50, cursor/);assert.match(source,/summarySourceRows.slice\(visibleSummaryPage \* 25/);assert.match(source,/Load more retained sources/);assert.match(source,/\[saved, reconstructed, state.rows\]/);
});

test('detail lifecycle skips closed matrix work, keeps empty-history memo stable, and rejects responses immediately on close',async()=>{
 const slots=[],effectSetups=[];let cursor=0;const hooks={useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value;}];},useRef(initial){const i=cursor++;if(!(i in slots))slots[i]={current:initial};return slots[i];},useMemo(fn,deps){const i=cursor++;if(!slots[i]||deps.some((value,index)=>value!==slots[i].deps[index]))slots[i]={deps,value:fn()};return slots[i].value;},useCallback(fn,deps){return hooks.useMemo(()=>fn,deps);},useEffect(fn){cursor++;if(fn.toString().includes("const session = detailSessionGeneration.current"))effectSetups.push(fn);}};
 let reads=0;const pending=[],matrixCounter={calls:0};
 const h=helpers({...hooks,matrixCounter,window:{localStorage:{getItem(){reads++;return null;}}},apiService:{getFinalActionableHistory:()=>new Promise(resolve=>pending.push(resolve))}},source=>source.replace('): ScoreMatrixDetail {\n  const entries','): ScoreMatrixDetail {\n  matrixCounter.calls++;\n  const entries'));
 const [stock]=h.buildConsensusRows([run(447,'Rebalance',1)],'india');const props={stock,market:'india',technicalScan:null,detailsData:{portfolioSnapshot:null,eventsAnalysis:null,threatsAnalysis:null}};
 const render=()=>{cursor=0;return h.ScopedStockDetailsButton(props);};const click=node=>node.props.onClick({stopPropagation(){}});
 let tree=render();assert.equal(matrixCounter.calls,0,'closed buttons must not calculate a matrix');click(findElement(tree,'Open TEST0 captured details'));tree=render();assert.equal(reads,1);assert.equal(matrixCounter.calls,1);const oldCleanup=effectSetups.at(-1)();
 render();assert.equal(reads,1,'unchanged omitted history input must not invalidate the cache memo');
 click(findElement(tree,'Close stock details'));tree=render();assert.equal(matrixCounter.calls,1,'closing must not calculate a matrix');
 pending.shift()({items:[{id:99,market:'india',stock_symbol:'TEST0',coverage_status:'suggested',rebalance_run_id:10,covered_at:timestamp}],has_more:false,next_cursor:null});await Promise.resolve();await Promise.resolve();render();assert.equal(slots.some(value=>Array.isArray(value)&&value.some(item=>item?.id===99)),false,"dismissed response must not be installed before passive cleanup");
 click(findElement(tree,'Open TEST0 captured details'));tree=render();assert.equal(reads,2);assert.equal(matrixCounter.calls,2);oldCleanup();pending.shift()({items:[{id:100,market:'india',stock_symbol:'TEST0',coverage_status:'suggested',rebalance_run_id:11,covered_at:timestamp,score:0,action:'Hold',amount:0,consensus:0,historical_current_units:0,action_units:0,formula_version:'fixture',snapshot_json:{},formula_inputs_json:null}],has_more:false,next_cursor:null});await Promise.resolve();await Promise.resolve();tree=render();assert.equal(slots.some(value=>Array.isArray(value)&&value.some(item=>item?.id===100)),true,'new session remains usable');
 click(findElement(tree,'Close stock details'));render();assert.equal(matrixCounter.calls,2);
 // Passive effects are deliberately not flushed: dismissal must invalidate synchronously.
 const source=readFileSync(new URL(sourcePath,import.meta.url),'utf8');assert.match(source,/historyLoadGeneration.current \+= 1;[\s\S]{0,180}setOpen\(false\)/);
});


test('Stock-Rebalance Scan History is reusable with all eleven columns, immutable data and preserved row/control actions',()=>{
 const {StockScanHistory,STOCK_SCAN_HISTORY_COLUMNS}=imported;
 assert.equal(STOCK_SCAN_HISTORY_COLUMNS.length,11);
 const rows=[{id:'saved',cells:['NSE:HAL','saved timestamp','suggested','Buy New','Hold','2','—','1/2','100','1/0','200']},{id:'retained',cells:['NSE:HAL','retained timestamp','Retained output · original summary not saved','Trim','—','—','-1.5','1/2','100','-1/5','200']}];
 const before=structuredClone(rows),clicked=[];
 const renderRow=row=>React.createElement('tr',{key:row.id},...row.cells.map((cell,index)=>React.createElement('td',{key:index},index===5?React.createElement('button',{'aria-label':'Open '+row.id+' score',onClick:()=>clicked.push(row.id)},cell):cell)));
 const props={rows,renderRow,controls:React.createElement('button',{onClick:()=>clicked.push('page')},'Next page')};
 const html=renderToStaticMarkup(React.createElement(StockScanHistory,props));
 assert.match(html,/aria-label="Stock-Rebalance Scan History"/);assert.equal((html.match(/<th /g)??[]).length,11);assert.equal((html.match(/<td/g)??[]).length,22);
 for(const label of STOCK_SCAN_HISTORY_COLUMNS)assert.ok(html.includes(label.replaceAll('&','&amp;')));
 const tree=StockScanHistory(props);findElement(tree,'Open saved score').props.onClick();findElement(tree,'Open retained score').props.onClick();findMatching(tree,n=>n.props?.children==='Next page').props.onClick();
 assert.deepEqual(clicked,['saved','retained','page']);assert.deepEqual(rows,before);
 const second=renderToStaticMarkup(React.createElement(StockScanHistory,{rows:[],renderRow,emptyState:React.createElement('p',null,'No history')}));assert.match(second,/No history/);assert.doesNotMatch(second,/<table/);
});

test('only the requested retained-coverage paragraph is omitted; other notices and data remain',()=>{
 const {retainedSourceCoverageDisplayNote}=helpers();
 const removed='All retained owned sources are scanned across pages. Deleted uncaptured outputs and sources with unknown market identity cannot be reconstructed. No provider call or history write is performed.';
 assert.equal(retainedSourceCoverageDisplayNote(removed),'');
 assert.equal(retainedSourceCoverageDisplayNote(removed+' Incomplete coverage: one source failed.'),'Incomplete coverage: one source failed.');
 assert.equal(retainedSourceCoverageDisplayNote('Other retained-source limitation'),'Other retained-source limitation');
 assert.match(retainedSourceCoverageDisplayNote(null),/cannot be reconstructed/);
});

test('older original Rebalance sources reach the renamed widget without inventing aggregate history',()=>{
 const original=(runId,extra={})=>({id:`${runId}:job:revision:0`,run_id:runId,job_id:runId+1000,stage:'rebalance',run_status:'completed',job_status:'completed',provider:'fixture',model:'fixture-model',created_at:timestamp,source:'retained_job',cells:{'stock symbol':'TEST0','exchange symbol':'NSE',action:'Hold','current units':0,'score rationale cruxx':2.03},...extra});
 const old=[original(452),original(450),original(449,{stage:'technical'}),original(448,{cells:{'stock symbol':'OTHER','exchange symbol':'NSE'}}),original(446,{cells:{'stock symbol':'TEST0','exchange symbol':'BSE'}})];
 assert.equal(imported.originalRebalanceSources([original(453,{cells:{'stock symbol':'NSE:TEST0','exchange symbol':'nse'}})],'TEST0','NSE').length,1);
 assert.equal(imported.originalRebalanceSources([original(454,{cells:{'stock symbol':'BSE:TEST0','exchange symbol':'NSE'}})],'TEST0','NSE').length,0);
 const before=structuredClone(old);
 const scoped=imported.originalRebalanceSources(old,'TEST0','NSE');assert.deepEqual(scoped.map(r=>r.run_id),[452,450]);
 const merged=imported.mergeSummarySourceRows([],[],[...scoped,scoped[0]]);assert.deepEqual(merged.map(r=>r.runId),[452,450]);assert.ok(merged.every(r=>r.kind==='observation'));
 assert.equal(imported.originalSourceCell(scoped[0].cells,['recorded score','overall weighted score']),null,'parameter score 2.03 must not become an original overall score');
 assert.equal(imported.originalSourceCell(scoped[0].cells,['current units']),'0','verified zero survives');
 assert.equal(imported.originalSourceCell({'current units':1,Current_Units:2},['current units']),null,'ambiguous aliases must not be guessed');
 assert.equal(imported.originalSourceCell({'source contract status':'Malformed','current units':10},['current units']),null);
 const saved={id:1,rebalance_run_id:452,coverage_status:'suggested',covered_at:timestamp};
 assert.deepEqual(imported.mergeSummarySourceRows([saved],[],scoped).map(r=>r.kind),['saved','observation']);assert.deepEqual(old,before);
 const {ScopedStockDetailsButton,buildConsensusRows}=helpers();assert.ok(ScopedStockDetailsButton&&buildConsensusRows);
});

test('retained reader shares existing bounded pages with the widget and continues to Run 450 without a second scan',async()=>{
 const state=[],effectSlots=[];let si=0,ei=0,effects=[],read;const calls=[];
 const onReadChange=value=>{read=value};
 const h=helpers({useState(initial){const i=si++;if(!(i in state))state[i]=initial;return[state[i],v=>{state[i]=typeof v==='function'?v(state[i]):v}]},useMemo:fn=>fn(),useEffect(fn,deps){const i=ei++,old=effectSlots[i];if(!old||deps.some((v,j)=>!Object.is(v,old.deps[j]))){old?.cleanup?.();effectSlots[i]={deps};effects.push(()=>effectSlots[i].cleanup=fn())}},apiService:{getStockSourceObservations:async({cursor})=>{calls.push(cursor);const i=cursor?Number(cursor):0;return{market:'india',symbol:'TEST0',items:i>=3?[{id:String(i),run_id:i===3?452:450,job_id:1,stage:'rebalance',run_status:'completed',job_status:'completed',provider:'fixture',model:'fixture',created_at:timestamp,source:'retained_job',cells:{'stock symbol':'TEST0','exchange symbol':'NSE'}}]:[],examined_sources:1,coverage_note:'fixture',has_more:i<4,next_cursor:i<4?String(i+1):null}}}});
 async function render(){si=0;ei=0;h.RetainedStockObservations({market:'india',symbol:'TEST0',saved:[],reconstructed:[],onReadChange});effects.splice(0).forEach(fn=>fn());await new Promise(r=>setImmediate(r));}
 await render();await render();await render();assert.deepEqual(calls,[null,'1','2','3']);assert.equal(read.hasMore,true);assert.deepEqual(read.rows.map(r=>r.run_id),[452]);
 read.loadMore();await render();await render();await render();assert.deepEqual(calls,[null,'1','2','3','4']);assert.deepEqual(read.rows.map(r=>r.run_id),[452,450]);assert.equal(read.hasMore,false);
 await render();assert.equal(calls.length,5,'ordinary renders cannot repeat the source scan');effectSlots.forEach(e=>e.cleanup?.());
});

test('score presentation adds one colon/prefix and hides only the requested reconstruction paragraph',()=>{
 const h=helpers();for(const s of ['Average of Score Rationale Cruxx','Average of: Score Rationale Cruxx','Average of:: Score Rationale Cruxx'])assert.equal(h.formatScoreParameterHeading(s),'Average of: Score Rationale Cruxx');
 assert.equal(h.formatScoreParameterHeading('Technical scan'),'Technical scan');
 assert.equal(h.formatScoreMissingReason('Not updated: Not updated: No matching Technical Scan row'),'Not updated: No matching Technical Scan row');
 const notes=[h.RECONSTRUCTED_HISTORY_EXPLANATION,'Original evidence is incomplete.'];assert.deepEqual(h.visibleHistoricalReadNotes(notes),['Original evidence is incomplete.']);assert.equal(notes.length,2,'saved provenance remains unchanged');
});


test('Technical Scan Ticker Symbol alias joins the exact venue and preserves selected run/job provenance',()=>{
 const h=helpers(),meta={runId:452,jobId:1452,provider:'fixture',model:'fixture-model',createdAt:timestamp,runLabel:'Selected Technical Scan'};
 const parsed=h.parseTechnicalScanResponse('| Exchange Symbol | Ticker Symbol | Primary Setup | Bias |\n| --- | --- | --- | --- |\n| NSE | NSE:CGPOWER | Breakout | bullish |',meta);
 assert.equal(parsed.length,1);assert.equal(parsed[0].runId,452);assert.equal(parsed[0].jobId,1452);
 const stock={symbol:'CGPOWER',exchange:'NSE',representative:{'Stock Symbol':'CGPOWER'}};
 assert.equal(h.getTechnicalScanForStock({'SYMBOL:CGPOWER':parsed[0]},stock),parsed[0]);
 assert.equal(h.getTechnicalScanForStock({'SYMBOL:CGPOWER':{...parsed[0],stockSymbol:'CGPOWER.NS'}},stock)?.jobId,1452);
 assert.equal(h.getTechnicalScanForStock({'SYMBOL:CGPOWER':{...parsed[0],exchangeSymbol:'BSE'}},stock),null,'symbol fallback cannot cross venues');
 assert.equal(h.getTechnicalScanForStock({'SYMBOL:CGPOWER':{...parsed[0],market:'us'}},stock),null,'symbol fallback cannot cross known markets');
 assert.equal(h.getTechnicalScanForStock({},stock),null,'genuine absence remains unavailable');
});


test('verified partial source runs retain completed and partial jobs without manufacturing original scores',()=>{
 const observations=[[450,2240,'partial'],[450,2241,'completed'],[452,2245,'completed'],[452,2246,'partial']].map(([run_id,job_id,job_status])=>({id:`${run_id}:${job_id}:fixture:0`,run_id,job_id,stage:'rebalance',run_status:'partial',job_status,provider:'fixture',model:'fixture',created_at:timestamp,source:'retained_job',cells:{'stock symbol':'CGPOWER','exchange symbol':'NSE'}}));
 const before=structuredClone(observations);const scoped=imported.originalRebalanceSources(observations,'CGPOWER','NSE');const merged=imported.mergeSummarySourceRows([],[],scoped);
 assert.deepEqual(merged.map(row=>row.item.job_id),[2245,2246,2240,2241]);assert.ok(merged.every(row=>row.kind==='observation'&&row.item.run_status==='partial'));assert.deepEqual(observations,before);
 const h=helpers();const [scan]=h.parseTechnicalScanResponse('| EXCHANGE SYMBOL | STOCK SYMBOL | Primary Setup | Secondary Setups | Bias | Premarket trend | Last 5 candles trend | Confidence Score |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| NSE | CGPOWER | Lower-high pullback | 200DMA/rejection | bearish | 0 | -2 | 8.8 |',{runId:455,jobId:2252,provider:'fixture',model:'fixture',createdAt:timestamp,runLabel:'India 211'});
 assert.equal(scan.stockSymbol,'CGPOWER');assert.equal(scan.premarketTrend,'0');assert.equal(scan.last5CandlesTrend,'-2');assert.equal(scan.confidenceScore,'8.8');assert.equal(scan.runId,455);assert.equal(scan.jobId,2252);
 assert.equal(h.getTechnicalScanForStock({'NSE:CGPOWER':scan},{symbol:'CGPOWER',exchange:'NSE',representative:{}}),scan,'canonical observed header/venue is already valid; absence must not be fabricated');
});


test('new matrix detail labels raw and effective allocation score without reinterpreting frozen detail', () => {
  const h = helpers();
  const fixture = parameterFixture(h);
  const detail = {...fixture.detail, calculatedScore: 72.8/24, detailedRationaleFinalScore: 72.8/24};
  const current = renderToStaticMarkup(React.createElement(h.DetailedRationaleScoreSection, {detail}));
  assert.match(current, /Raw formula score: 3.033333333333/);
  assert.match(current, /Effective allocation score: 3/);
  assert.match(current, /score-matrix-raw-effective-v2/);
  const frozen = renderToStaticMarkup(React.createElement(h.DetailedRationaleScoreSection, {detail, readOnly:true}));
  assert.doesNotMatch(frozen, /Effective allocation score:/);
  assert.equal(detail.calculatedScore, 72.8/24);
});

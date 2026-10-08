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
  }, ['ActionablesCalculationsModal', 'DEFAULT_SCORE_MATRIX_FORMULA_CONFIG', 'RebalanceCell', 'buildActionablesCalculationRows'], (source) => {
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
  const render = () => { harness.start(); return h.StockDetailsButton(props); };
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

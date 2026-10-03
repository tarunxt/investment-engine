import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
function load(path, bindings = {}, exports = '') {
  bindings = Object.fromEntries(Object.entries(bindings).filter(([key]) => key !== 'default'));
  const text = read(path);
  const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const source = ast.statements.filter((node) => !ts.isImportDeclaration(node)).map((node) => node.getText(ast)).join('\n');
  const output = ts.transpileModule(`${source}\n${exports}`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const loaded = { exports: {} };
  new Function('exports', 'module', 'require', ...Object.keys(bindings), output)(loaded.exports, loaded, require, ...Object.values(bindings));
  return loaded.exports;
}
const actionColors = load('../lib/actionColorScheme.ts');
const parser = load('../components/InvestmentRecommendationTable.tsx', actionColors);
const bindings = {
  ...parser,
  ...actionColors,
  ...load('../lib/technicalSetups.ts'),
  ...load('../lib/scoreMatrixMath.ts'),
  ...load('../lib/rebalanceRunIdentity.ts'),
  ...load('../lib/runPresentation.ts'),
};
const helpers = load('../app/console/_components/FinalActionablesConsole.tsx', bindings,
  'export { buildScoreMatrixDetail, buildSummaryRowCells, resolveMatrixUnitsForAction, DEFAULT_SCORE_MATRIX_FORMULA_CONFIG };');
const actionHeader = 'Action (Buy/Add/Sell All/Trim/Hold/Buy New)';
const timestamp = '2026-09-01T10:00:00Z';

function runWithRows(rows, market = 'india', id = 10) {
  const headers = parser.REBALANCE_HEADER_ORDER;
  return {
    id, status: 'completed', created_at: timestamp, updated_at: timestamp,
    prompt: `[REBALANCE_FLOW:${market}]\nRebalance the ${market === 'india' ? 'India' : 'US'} portfolio.`,
    run_jobs: rows.map((row, index) => ({
      job_id: 100 + index,
      job: {
        provider: 'synthetic', model: 'same-model', status: 'completed', created_at: timestamp,
        response: `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n| ${headers.map((header) => row[header] ?? (header.startsWith('Score Rationale') ? '3' : '—')).join(' | ')} |`,
      },
    })),
  };
}
function modelRow(units, overrides = {}) {
  return {
    'Exchange Symbol': 'NSE', 'Stock Symbol': 'TESTINDIA', 'Current Units': '0',
    [actionHeader]: 'Buy New', 'Units Change': String(units), 'Final Units': String(units),
    'Units to Buy': String(units), 'Price Per Unit': '100', 'Total Buy Amount': String(units * 100),
    ...overrides,
  };
}
function snapshot(units = 6) {
  return { holdings: [{ tradingsymbol: 'TESTINDIA', exchange: 'NSE', quantity: units, market_value: units * 100 }] };
}

test('current holdings, consolidated arithmetic, formula, and action estimate share one position context', () => {
  const run = runWithRows([modelRow(6), modelRow(5)]);
  const [stock] = helpers.buildConsensusRows([run, run], 'india', snapshot());
  const rawBefore = structuredClone(stock.rows);
  const [dashboard] = helpers.buildDashboardActionRows([stock], 'india', {});
  const detail = dashboard.detail;
  assert.equal(stock.rows.length, 2, 'distinct jobs from the same model remain distinct');
  assert.equal(stock.totalSuggestions, 2);
  assert.equal(stock.actionCounts['Buy New'], 2);
  assert.equal(stock.actionAverages['Buy New'].units, 5.5);
  assert.equal(stock.representative['Current Units'], '6');
  assert.equal(stock.representative['Units Change'], '5.5');
  assert.equal(stock.representative['Final Units'], '11.5');
  assert.equal(stock.representative['Units to Buy'], '5.5');
  assert.equal(stock.representative['Total Buy Amount'], '550');
  assert.equal(detail.currentUnits, 6);
  assert.equal(detail.meanModeAction, 'Buy New', 'model consensus is not relabeled');
  assert.equal(detail.calculatedAction, 'Add more');
  assert.equal(detail.calculatedUnitsChange, 5.5);
  assert.equal(dashboard.formulaEstimate.currentUnits, 6);
  assert.equal(dashboard.formulaEstimate.currentInvestmentAmount, 600);
  assert.equal(dashboard.formulaEstimate.units, 5, 'India rounding is unchanged');
  assert.equal(dashboard.formulaEstimate.amount, 500);
  for (const [action, change] of [[detail.meanModeAction, detail.meanModeUnitsChange], [detail.calculatedAction, detail.calculatedUnitsChange]]) {
    const cells = helpers.buildSummaryRowCells(stock, detail, action, change);
    assert.equal(cells['Current Units'], '6');
    assert.equal(cells['Final Units'], '11.5');
    assert.equal(cells['Total Buy Amount'], '550');
  }
  assert.deepEqual(stock.rows, rawBefore);
  assert.deepEqual(stock.rows.map((row) => row.cells['Current Units']), ['0', '0']);
  assert.deepEqual(stock.rows.map((row) => row.cells['Final Units']), ['6', '5']);
});

test('fallback captured context, authoritative zero holdings, and US fractional sizing are consistent', () => {
  const run = runWithRows([modelRow(6), modelRow(5)]);
  const [fallback] = helpers.buildConsensusRows([run], 'india');
  assert.equal(helpers.buildScoreMatrixDetail(fallback).calculatedAction, 'Buy New');
  assert.equal(fallback.positionContext.source, 'captured-model-rows');
  const heldRun = runWithRows([modelRow(2, { 'Current Units': '8', [actionHeader]: 'Add more' })]);
  const [flat] = helpers.buildConsensusRows([heldRun], 'india', { holdings: [] });
  assert.equal(helpers.buildScoreMatrixDetail(flat).currentUnits, 0);
  assert.equal(helpers.buildScoreMatrixDetail(flat).calculatedAction, 'Buy New');
  const usRun = runWithRows([modelRow(6), modelRow(5)], 'us');
  const usSnapshot = { holdings: [{ symbol: 'TESTINDIA', company_name: 'Synthetic', quantity: 6, current_value: 600 }] };
  const [usStock] = helpers.buildConsensusRows([usRun], 'us', usSnapshot);
  assert.equal(helpers.buildDashboardActionRows([usStock], 'us', {})[0].formulaEstimate.units, 5.5);
});

test('sell, trim and hold summaries clear stale buy quantities and use current holdings for formula sizing', () => {
  for (const [action, score, change] of [['Sell All', -3, -6], ['Trim', -1.5, -3], ['Hold', 0, 0]]) {
    const values = Object.fromEntries(parser.REBALANCE_HEADER_ORDER.filter((header) => header.startsWith('Score Rationale')).map((header) => [header, String(score)]));
    const run = runWithRows([modelRow(5, { ...values, 'Current Units': '10', [actionHeader]: action })]);
    const [stock] = helpers.buildConsensusRows([run], 'india', snapshot());
    const detail = helpers.buildScoreMatrixDetail(stock);
    assert.equal(detail.calculatedAction, action);
    assert.equal(detail.calculatedUnitsChange, change);
    const cells = helpers.buildSummaryRowCells(stock, detail, detail.calculatedAction, change);
    assert.equal(cells['Current Units'], '6');
    assert.equal(cells['Final Units'], String(6 + change));
    assert.equal(cells['Units to Buy'], '0');
    assert.equal(cells['Total Buy Amount'], '0');
  }
});

test('dissent and distinct same-model jobs remain visible in the consensus and formula inputs', () => {
  const run = runWithRows([modelRow(6), modelRow(5), modelRow(0, { [actionHeader]: 'Hold' })]);
  const [stock] = helpers.buildConsensusRows([run], 'india', snapshot());
  assert.equal(stock.totalSuggestions, 3);
  assert.equal(stock.breakupEntries.length, 3);
  assert.equal(stock.actionCounts['Buy New'], 2);
  assert.equal(stock.actionCounts.Hold, 1);
  const detail = helpers.buildScoreMatrixDetail(stock);
  assert.equal(detail.meanModeUnitsChange, 11 / 3);
  assert.equal(detail.calculatedUnitsChange, 5.5);
  assert.equal(detail.rows.filter((row) => !row.isSummary).length, 3);
});

test('known-zero holdings never fall back to model sell sizes, while unknown holdings retain the fallback', () => {
  for (const [action, score] of [['Sell All', -3], ['Trim', -1.5]]) {
    const scores = Object.fromEntries(parser.REBALANCE_HEADER_ORDER.filter((header) => header.startsWith('Score Rationale')).map((header) => [header, String(score)]));
    const run = runWithRows([modelRow(0, { ...scores, 'Current Units': '10', 'Units Change': '-10', [actionHeader]: action })]);
    const [stock] = helpers.buildConsensusRows([run], 'india', { holdings: [] });
    const [dashboard] = helpers.buildDashboardActionRows([stock], 'india', {});
    const detail = dashboard.detail;
    assert.equal(detail.calculatedAction, action, 'score mapping is unchanged');
    assert.equal(detail.currentUnits, 0);
    assert.equal(detail.calculatedUnitsChange, 0);
    assert.equal(dashboard.formulaEstimate.units, 0);
    assert.equal(dashboard.formulaEstimate.amount, 0);
    assert.equal(helpers.buildSummaryRowCells(stock, detail, action, detail.calculatedUnitsChange)['Final Units'], '0');
    assert.equal(stock.rows[0].cells['Current Units'], '10', 'raw evidence remains intact');
    assert.equal(helpers.resolveMatrixUnitsForAction(action, { currentUnits: null, bearishMeanUnits: 10, meanUnitsChange: -10 }), -10);
  }
});

test('historical reconstruction ignores today holdings and scans, retaining captured source context', () => {
  const run = runWithRows([modelRow(6), modelRow(5)]);
  const futureDate = '2026-10-01T10:00:00Z';
  const futureScan = {
    id: 20, status: 'completed', created_at: futureDate, updated_at: futureDate,
    prompt: '## Technical Scan Input Bundle\nMarket: India equities\n\nStock list',
    run_jobs: [{ job_id: 200, job: {
      provider: 'synthetic', model: 'same-model', status: 'completed', created_at: futureDate, updated_at: futureDate,
      response: '| Exchange Symbol | Stock Symbol | Primary Setup | Secondary Setups | Bias | Premarket trend | Last 5 candles trend | Confidence Score | Trigger Level | Invalidation Level |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n| NSE | TESTINDIA | Synthetic breakdown | — | Bearish | -3 | -3 | 10 | 90 | 110 |',
    } }],
  };
  assert.ok(Object.values(helpers.buildTechnicalScanMap([futureScan])).some((scan) => scan.runId === 20), 'fixture is a usable future scan');
  const reconstruct = (units, scans) => helpers.buildHistoricalDashboardActionRows([run, futureScan], 'india', snapshot(units), scans, helpers.DEFAULT_SCORE_MATRIX_FORMULA_CONFIG);
  const original = reconstruct(6, {});
  const afterPortfolioChange = reconstruct(60, { 'NSE:TESTINDIA': { runId: 20, stockSymbol: 'TESTINDIA', exchangeSymbol: 'NSE', createdAt: futureScan.created_at, confidenceScore: '10', bias: 'bearish' } });
  assert.deepEqual(afterPortfolioChange, original);
  assert.equal(original[0].formulaEstimate.currentUnits, 0);
  assert.equal(original[0].formulaAction, 'Buy New');
  assert.equal(original[0].detail.technicalScanSourceRunId, null);
  assert.equal(original[0].stock.positionContext.source, 'captured-model-rows');
  const priorDate = '2026-08-31T10:00:00Z';
  const priorScan = {
    ...futureScan, id: 19, created_at: priorDate, updated_at: priorDate,
    run_jobs: futureScan.run_jobs.map((link) => ({ ...link, job_id: 190, job: { ...link.job, created_at: priorDate, updated_at: priorDate } })),
  };
  const withCapturedScan = helpers.buildHistoricalDashboardActionRows([run, priorScan, futureScan], 'india', snapshot(60), {}, helpers.DEFAULT_SCORE_MATRIX_FORMULA_CONFIG);
  assert.equal(withCapturedScan[0].detail.technicalScanSourceRunId, 19, 'available historical scan is retained');
  const reexportedRun = { ...run, updated_at: '2026-10-02T10:00:00Z' };
  const afterReexport = helpers.buildHistoricalDashboardActionRows([reexportedRun, futureScan], 'india', snapshot(60), {}, helpers.DEFAULT_SCORE_MATRIX_FORMULA_CONFIG);
  assert.deepEqual(afterReexport, original, 're-export metadata cannot advance historical coverage');
  for (const outputUpdatedAt of [futureDate, undefined]) {
    const lateOrUnknownOutput = { ...priorScan, run_jobs: priorScan.run_jobs.map((link) => ({ ...link, job: { ...link.job, updated_at: outputUpdatedAt } })) };
    const reconstructed = helpers.buildHistoricalDashboardActionRows([run, lateOrUnknownOutput], 'india', snapshot(60), {}, helpers.DEFAULT_SCORE_MATRIX_FORMULA_CONFIG);
    assert.equal(reconstructed[0].detail.technicalScanSourceRunId, null, 'old run metadata cannot admit a future or undated job output');
  }
});

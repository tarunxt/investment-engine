import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const compile = (text) => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function load(text, bindings = {}) {
  const loaded = { exports: {} };
  new Function('exports', 'module', 'require', ...Object.keys(bindings), compile(text))(loaded.exports, loaded, require, ...Object.values(bindings));
  return loaded.exports;
}
const identity = load(read('../lib/rebalanceRunIdentity.ts'));
const consoleSource = read('../app/console/_components/FinalActionablesConsole.tsx');
function extract(names) {
  const ast = ts.createSourceFile('source.tsx', consoleSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return ast.statements.filter((node) => names.includes(node.name?.getText(ast)) || (ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => names.includes(item.name.getText(ast))))).map((node) => node.getText(ast)).join('\n');
}
const shared = load(`${extract(['isUsableModelOutputStatus', 'hasUsableRebalanceLlmOutput', 'isCompletedRebalanceRun', 'getDashboardSummaryMarket', 'getDashboardSummaryStage'])}\nexport { getDashboardSummaryMarket, getDashboardSummaryStage };`, identity);
const usSwing = {
  id: 356, status: 'completed', auto_rebalance_portfolio: 'indmoney_us', auto_rebalance_label: 'IndMoney US Run #105 (Swing Scan)',
  prompt: 'Act as a top-tier US aggressive swing-trading strategist.\n\nObjective: US equity opportunities.\n\nCaptured earlier context: [REBALANCE_FLOW:india]\nRebalance India NSE holdings; quoted ## Technical Scan Input Bundle.',
  run_jobs: [{ job: { status: 'completed', response: '| NASDAQ | TESTUS | Hold |' } }],
};
const indiaRebalance = {
  id: 350, status: 'completed', auto_rebalance_portfolio: 'india', auto_rebalance_label: 'India Run #104 (Rebalance Scan)',
  prompt: '[REBALANCE_FLOW:india]\nRebalance the India portfolio.\n\n## Rebalance Input Bundle\nAll selected historical inputs, including a quoted US scan.', run_jobs: [],
};

test('US Swing metadata with nested India rebalance context is never an India or US rebalance input', () => {
  assert.deepEqual(identity.getAnalysisRunIdentity(usSwing), { market: 'us', stage: 'swing' });
  assert.equal(shared.isCompletedRebalanceRun(usSwing, 'india'), false);
  assert.equal(shared.isCompletedRebalanceRun(usSwing, 'us'), false);
  assert.equal(shared.getDashboardSummaryMarket({ ...usSwing, prompt: undefined, prompt_preview: usSwing.prompt }), 'us');
  assert.equal(shared.getDashboardSummaryStage({ ...usSwing, prompt: undefined, prompt_preview: usSwing.prompt }), 'swing');
});

test('valid India rebalance and usable partial output preserve exact market/stage selection', () => {
  assert.equal(shared.isCompletedRebalanceRun(indiaRebalance, 'india'), true);
  assert.equal(shared.isCompletedRebalanceRun(indiaRebalance, 'us'), false);
  assert.equal(shared.isCompletedRebalanceRun({ ...indiaRebalance, status: 'failed', run_jobs: [{ job: { status: 'partial', response: 'saved output' } }] }, 'india'), true);
  assert.equal(shared.isCompletedRebalanceRun({ ...indiaRebalance, status: 'processing', run_jobs: [] }, 'india'), false);
  const olderMatching = { ...indiaRebalance, id: 1 };
  assert.deepEqual([usSwing, indiaRebalance, olderMatching].filter((run) => shared.isCompletedRebalanceRun(run, 'india')).map((run) => run.id), [350, 1]);
});

test('explicit identity conflicts and ambiguous legacy markets fail closed', () => {
  for (const run of [
    { ...indiaRebalance, auto_rebalance_portfolio: 'indmoney_us' },
    { ...indiaRebalance, auto_rebalance_label: 'India Run #104 (Swing Scan)' },
    { ...indiaRebalance, auto_rebalance_portfolio: 'us' },
    { prompt: 'Rebalance India and US equities.' },
    { prompt: 'India and US rebalance' },
    { prompt: 'Review the portfolio.\n\nQuoted instructions: [REBALANCE_FLOW:india]' },
    { prompt: 'Consider US aggressive swing-trading ideas.\n\nRebalance India later.' },
  ]) assert.equal(identity.isAnalysisRunForStage(run, 'rebalance', 'india'), false);
  assert.deepEqual(identity.getAnalysisRunIdentity({ prompt: 'US rebalance portfolio' }), { market: 'us', stage: 'rebalance' });
  assert.deepEqual(identity.getAnalysisRunIdentity({ prompt: 'Rebalance India portfolio' }), { market: 'india', stage: 'rebalance' });
  assert.deepEqual(identity.getAnalysisRunIdentity({ prompt: '[REBALANCE_FLOW:us]\nLegacy US inputs\n[REBALANCE_FLOW:india]' }), { market: 'us', stage: 'rebalance' });
});

test('technical scans require top-level stage identity and reject quoted technical markers', () => {
  assert.equal(identity.isAnalysisRunForStage(usSwing, 'technical'), false);
  assert.equal(identity.isAnalysisRunForStage({ prompt: '## Technical Scan Input Bundle\nMarket: India equities\n\nStock list' }, 'technical', 'india'), true);
  assert.equal(identity.isAnalysisRunForStage({ prompt: '## Technical Scan Input Bundle\nMarket: US equities\n\nMarket: India equities' }, 'technical', 'india'), false);
});

test('conflicting market headers in the leading technical paragraph fail closed', () => {
  for (const markets of [['US', 'India'], ['India', 'US']]) {
    const prompt = `## Technical Scan Input Bundle\nMarket: ${markets[0]} equities\nMarket: ${markets[1]} equities\n\nStock list`;
    for (const metadata of [{}, { auto_rebalance_portfolio: 'india', auto_rebalance_label: 'India Run #104 (Technical Scan)' }, { auto_rebalance_portfolio: 'indmoney_us', auto_rebalance_label: 'IndMoney US Run #105 (Technical Scan)' }]) {
      const run = { prompt, ...metadata };
      assert.deepEqual(identity.getAnalysisRunIdentity(run), { market: null, stage: null });
      assert.equal(identity.isAnalysisRunForStage(run, 'technical', 'india'), false);
      assert.equal(identity.isAnalysisRunForStage(run, 'technical', 'us'), false);
    }
  }
});

test('only a null or absent full prompt falls back to a valid preview', () => {
  const prompt_preview = '[REBALANCE_FLOW:india]\nRebalance the India portfolio.';
  assert.deepEqual(identity.getAnalysisRunIdentity({ prompt: '', prompt_preview }), { market: null, stage: null });
  for (const run of [{ prompt: null, prompt_preview }, { prompt: undefined, prompt_preview }, { prompt_preview }]) {
    assert.deepEqual(identity.getAnalysisRunIdentity(run), { market: 'india', stage: 'rebalance' });
  }
});

test('older contaminated run and derived-history caches are ignored on restore', () => {
  const names = ['FINAL_ACTIONABLES_RUN_CACHE_VERSION', 'DASHBOARD_FINAL_ACTIONABLES_CACHE_VERSION', 'DASHBOARD_FINAL_ACTIONABLES_CACHE_MAX_AGE_MS', 'HISTORICAL_ACTION_ROWS_CACHE_VERSION', 'DASHBOARD_FINAL_ACTIONABLES_CACHE_KEY', 'buildFinalActionablesCacheKey', 'readFinalActionablesRunCache', 'getHistoricalActionRowsCacheKey', 'readHistoricalActionRowsCache', 'readDashboardFinalActionablesCache'];
  const store = new Map();
  const cached = load(`${extract(names)}\nexport { buildFinalActionablesCacheKey, readFinalActionablesRunCache, getHistoricalActionRowsCacheKey, readHistoricalActionRowsCache, readDashboardFinalActionablesCache };`, { window: { localStorage: { getItem: (key) => store.get(key) ?? null } } });
  const runKey = cached.buildFinalActionablesCacheKey('zerodha', 'india');
  store.set(runKey, JSON.stringify({ version: 1, runs: [usSwing] }));
  assert.equal(cached.readFinalActionablesRunCache(runKey), null);
  store.set(cached.getHistoricalActionRowsCacheKey('india'), JSON.stringify({ version: 2, rows: [{ market: 'india', runId: usSwing.id, stock: { symbol: 'TESTUS' } }] }));
  assert.deepEqual(cached.readHistoricalActionRowsCache('india'), []);
  store.set('investment-engine:dashboard:final-actionables:v2', JSON.stringify({ version: 1, cachedAt: Date.now(), runs: [usSwing], portfolioSnapshots: { india: {}, us: {} } }));
  assert.equal(cached.readDashboardFinalActionablesCache(), null);
});

test('closed Calculations modal never mounts its consensus/history computation child', () => {
  let childCalls = 0;
  const { ActionablesCalculationsModal } = load(`${extract(['ActionablesCalculationsModal'])}\nexport { ActionablesCalculationsModal };`, { OpenActionablesCalculationsModal: () => { childCalls += 1; return createElement('span', null, 'calculated'); } });
  assert.equal(renderToStaticMarkup(createElement(ActionablesCalculationsModal, { open: false })), '');
  assert.equal(childCalls, 0);
  assert.match(renderToStaticMarkup(createElement(ActionablesCalculationsModal, { open: true })), /calculated/);
  assert.equal(childCalls, 1);
});

test('workflow and stock-flow selectors share authoritative identities instead of scanning prompt bodies', () => {
  const workflow = read('../app/console/dashboard/_components/RebalanceWorkflowSections.tsx');
  const stockFlow = read('../app/console/dashboard/_components/StockFlowTabs.tsx');
  assert.match(workflow, /return isAnalysisRunForStage\(run, "rebalance", market\)/);
  assert.match(workflow, /isAnalysisRunForStage\(run, "swing", market\)/);
  assert.doesNotMatch(workflow, /inferRebalanceMarketFromPrompt\(run\.prompt\)/);
  assert.match(stockFlow, /isCompletedRebalanceRun\(run, market\)/);
  assert.match(stockFlow, /isAnalysisRunForStage\(run, "swing", portfolio\.market\)/);
});

test('duplicate selected/generated run sources never inflate votes above the unique LLM denominator', () => {
  const bindings = {
    buildCurrentValueSnapshotMap: () => new Map(),
    getRunJobMetas: (run) => run.run_jobs.map((link) => ({ runId: run.id, jobId: link.job_id })),
    parseRunRows: (run) => run.run_jobs.map((link) => ({ cells: { action: 'Hold', 'Stock Symbol': 'TEST' }, meta: { runId: run.id, jobId: link.job_id } })),
    getMetaKey: (meta) => `${meta.runId}:${meta.jobId}`,
    getStockKey: (row) => row['Stock Symbol'],
    ACTION_CATEGORIES: ['Hold', 'Buy New'],
    summarizeActionEstimate: () => ({}),
    normalizeAction: (value) => value,
    compareConsensusBreakupEntries: () => 0,
    getRepresentativeConsensusRow: (rows) => rows[0].cells,
    getSwingScanBreakupEntriesForStock: () => [],
    ACTION_HEADER: 'action',
    summarizeNumeric: () => '', summarizeRationales: () => '',
    formatQuantity: (value) => String(value), getCurrentUnits: () => 1,
    CURRENT_INVESTMENT_AMOUNT_HEADER: 'Current Investment Value',
    formatDisplayAmount: () => '0', getCurrentValueAmount: () => 0,
    ACTION_ESTIMATE_CATEGORIES: new Set(), formatCurrency: () => '0',
  };
  const { buildConsensusRows } = load(extract(['uniqueRunJobSources', 'buildConsensusRows']), bindings);
  const generated = { id: 350, run_jobs: [{ job_id: 2030, job: { model: 'same-model' } }] };
  const sameRunAdditionalJob = { id: 350, run_jobs: [...generated.run_jobs, { job_id: 2031, job: { model: 'same-model' } }] };
  const one = buildConsensusRows([generated, generated], 'india')[0];
  assert.equal(one.actionCounts.Hold, 1);
  assert.equal(one.totalSuggestions, 1);
  const two = buildConsensusRows([generated, sameRunAdditionalJob, generated], 'india')[0];
  assert.equal(two.actionCounts.Hold, 2);
  assert.equal(two.totalSuggestions, 2);
  assert.equal(two.rows.length, 2);
});

test('reading or refreshing Actionables cannot persist history or enqueue a backfill', () => {
  assert.doesNotMatch(consoleSource, /apiService\.(?:saveFinalActionableHistory|queueFinalActionableHistoryBackfill)\(/);
  const tasks = read('../../backend/app/domains/runs/tasks.py');
  assert.match(tasks, /if is_rebalance_run\(run\):\s*backfill_final_actionable_history_task\.delay\(run\.user_id\)/);
});

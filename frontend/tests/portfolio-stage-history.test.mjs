import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const root = new URL('../', import.meta.url);
const cache = new Map();
function load(path, overrides = {}) {
  if (cache.has(path) && !Object.keys(overrides).length) return cache.get(path);
  const source = readFileSync(new URL(path, root), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const result = { exports: {} };
  const stubs = {
    '@/services/api': { apiService: new Proxy({}, { get() { throw new Error('External requests forbidden in fixture'); } }) },
    '@/app/console/dashboard/_components/StageDurationBreakdownDialog': { StageDurationBreakdownDialog: () => null },
    'next/link': { default: ({ children, ...props }) => React.createElement('a', props, children), __esModule: true },
    ...overrides,
  };
  new Function('require', 'module', 'exports', code)(name => {
    if (name in stubs) return stubs[name];
    if (name.startsWith('./')) return load(path.slice(0, path.lastIndexOf('/') + 1) + name.slice(2) + '.tsx');
    if (name.startsWith('@/')) {
      const suffix = ['.ts', '.tsx'].find(ext => { try { readFileSync(new URL(name.slice(2) + ext, root)); return true; } catch { return false; } });
      return load(name.slice(2) + suffix);
    }
    return require(name);
  }, result, result.exports);
  if (!Object.keys(overrides).length) cache.set(path, result.exports);
  return result.exports;
}
const model = load('lib/portfolioStageHistory.ts');
const shared = load('components/shared/WorkflowStageTile.tsx');
const { PortfolioWorkflowHistoryCard } = load('app/console/runs/_components/PortfolioWorkflowHistoryCard.tsx');
const timestamp = '2026-10-20T14:07:01Z';
const stage = (key, overrides = {}) => ({ stage: key, status: 'completed', started_at: timestamp, completed_at: timestamp,
  provider_count: 3, completed_provider_count: 2, partial_provider_count: 1, failed_provider_count: 1,
  estimated_cost: 0.5, summary: { recommended_stocks: 7, cost_inr: 42 }, ...overrides });
const group = (portfolio = 'india', sequence = 211, overrides = {}) => ({ portfolio, sequence,
  label: `${portfolio === 'india' ? 'India Run' : 'IndMoney US Run'} #${sequence}`, status: 'partial', created_at: timestamp, updated_at: timestamp,
  stages: shared.STAGE_ORDER.map(key => stage(key)), ...overrides });
const run = (id, portfolio = 'india', sequence = 211) => ({ id, auto_rebalance_portfolio: portfolio,
  auto_rebalance_sequence: sequence, status: 'completed', created_at: timestamp, prompt_preview: '[REBALANCE_FLOW:india]', run_jobs: [{}, {}] });

test('verified groups retain market boundaries, legacy identity, retries and deterministic ordering before pagination', () => {
  const groups = [group(), group('indmoney_us'), group('india', 210, { created_at: '2026-10-19T00:00:00Z' })];
  const runs = [run(1), run(2), run(3, 'indmoney_us'), run(4, 'india', 999), { ...run(5), auto_rebalance_sequence: null }];
  const before = structuredClone({ groups, runs });
  const entries = model.buildPortfolioHistoryEntries(groups, runs);
  assert.equal(entries.length, 5);
  assert.equal(entries.filter(entry => entry.group).length, 3);
  assert.deepEqual(entries.filter(entry => entry.run).map(entry => entry.run.id).sort(), [4, 5]);
  assert.equal(entries.at(-1).group.sequence, 210);
  const many = Array.from({ length: 45 }, (_, index) => group('india', index + 1, { created_at: new Date(Date.UTC(2026, 0, index + 1)).toISOString() }));
  const sorted = model.buildPortfolioHistoryEntries(many, []);
  assert.deepEqual([sorted.slice(0, 20).length, sorted.slice(20, 40).length, sorted.slice(40).length], [20, 20, 5]);
  assert.deepEqual(sorted.slice(20, 40).map(entry => entry.group.sequence), Array.from({ length: 20 }, (_, i) => 25 - i));
  assert.deepEqual({ groups, runs }, before);
});

test('six historical adapters preserve status, counts and missing evidence without current/global values', () => {
  for (const key of shared.STAGE_ORDER) {
    const info = model.historicalStageInfo(stage(key, { status: 'partial' }));
    assert.equal(info.runStatus, 'partial');
    assert.equal(info.recommendedStocks, 7);
    assert.equal(info.completedAt, timestamp);
    assert.equal(info.costInr, 42);
    assert.equal(shared.formatLlmCompletion(info), '1/3 (Passed:1, Partial:1, Failed:1)');
  }
  assert.deepEqual(model.historicalStageInfo(), { state: 'idle', runStatus: 'Not recorded' });
  const info = model.historicalStageInfo(stage('technical', { summary: {}, completed_at: null }));
  assert.equal(info.recommendedStocks, null);
  assert.equal(info.costInr, null);
  assert.equal(info.completedAt, null);
});

test('both portfolios render shared tiles, missing stages, historical counts and every retry source', () => {
  for (const portfolio of ['india', 'indmoney_us']) {
    const item = group(portfolio, 211, { stages: [stage('rebalance', { run_id: 9 }), stage('threats', { job_id: 19, status: 'failed', error_message: 'saved timeout' })] });
    const html = renderToStaticMarkup(React.createElement(PortfolioWorkflowHistoryCard, { group: item, runs: [run(8, portfolio), run(9, portfolio), run(10, portfolio === 'india' ? 'indmoney_us' : 'india')], onOpen() {} }));
    assert.equal((html.match(/<article/g) || []).length, 6);
    assert.equal((html.match(/Not recorded/g) || []).length, 4);
    assert.match(html, /Stocks recommended<\/dt><dd[^>]*>7/);
    assert.match(html, /30 Oct|20 Oct/);
    assert.match(html, /Run #8/); assert.match(html, /Run #9/); assert.doesNotMatch(html, /Run #10/);
    assert.match(html, /Request timed out/);
    assert.doesNotMatch(html, /saved timeout/);
    assert.match(html, /stage evidence/);
    assert.match(html, /href="\/console\/runs\/9"/);
    assert.match(html, new RegExp(`/console/auto-rebalance-runs/${portfolio === 'india' ? 'zerodha' : 'indmoneyUs'}/211`));
  }
  const workflow = readFileSync(new URL('app/console/dashboard/_components/RebalanceWorkflowSections.tsx', root), 'utf8');
  assert.match(workflow, /import .*WorkflowStageTile.*from "@\/components\/shared\/WorkflowStageTile"/);
  assert.doesNotMatch(workflow, /function WorkflowStageTile/);
  assert.match(workflow, /mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3/);
});

test('historical stage actions open exact saved runs and group diagnostics, with no action for missing stages', () => {
  for (const portfolio of ['india', 'indmoney_us']) {
    const tiles = [];
    const card = load('app/console/runs/_components/PortfolioWorkflowHistoryCard.tsx', {
      './HistoricalStageLedgerRow': { HistoricalStageLedgerRow: props => { tiles.push(props); return null; } },
    }).PortfolioWorkflowHistoryCard;
    const paths = [];
    const item = group(portfolio, 8, { stages: [stage('swing', { run_id: 42 }), stage('threats', { job_id: 99 })] });
    const child = { ...run(42, portfolio, 8), prompt_preview: `Act as a top-tier ${portfolio === 'india' ? 'India' : 'US'} equities aggressive swing-trading strategist.` };
    renderToStaticMarkup(React.createElement(card, { group: item, runs: [child], onOpen: path => paths.push(path) }));
    const swing = tiles.find(tile => tile.stage === 'swing');
    swing.onClick(); swing.onPromptClick(); swing.onOutputClick();
    assert.deepEqual(paths, Array(3).fill(`/console/${portfolio === 'india' ? 'zerodha' : 'indmoney-us'}-swing-run/42`));
    tiles.find(tile => tile.stage === 'threats').onOutputClick();
    assert.equal(paths.at(-1), `/console/auto-rebalance-runs/${portfolio === 'india' ? 'zerodha' : 'indmoneyUs'}/8`);
    const missing = tiles.find(tile => tile.stage === 'technical');
    assert.equal(missing.onClick, undefined);
    assert.equal(missing.onOutputClick, undefined);
    assert.equal(missing.info.recommendedStocks, undefined);
  }
});

test('history loader fetches every bounded page and propagates failure instead of publishing a partial list', async () => {
  const calls = [];
  const source = readFileSync(new URL('app/console/runs/page.tsx', root), 'utf8');
  const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'loadWorkflowHistory');
  const code = ts.transpileModule(fn.getText(ast) + '\nexport {loadWorkflowHistory}', { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const out = {};
  const api = { getAutoRebalanceHistory: async (portfolio, params) => { calls.push({ portfolio, ...params }); return { items: Array.from({ length: Math.min(params.limit, 251 - params.offset) }, (_, i) => group(portfolio, params.offset + i)), total: 251 }; } };
  new Function('apiService', 'exports', code)(api, out);
  for (const portfolio of ['india', 'indmoney_us']) assert.equal((await out.loadWorkflowHistory(portfolio)).length, 251);
  assert.deepEqual(calls.map(call => call.offset), [0, 50, 100, 150, 200, 250, 0, 50, 100, 150, 200, 250]);
  api.getAutoRebalanceHistory = async (_, params) => { if (params.offset) throw new Error('saved history unavailable'); return { items: Array(50).fill(group()), total: 251 }; };
  await assert.rejects(out.loadWorkflowHistory('india'), /saved history unavailable/);
});

test('desktop and narrow layouts expose six ledger rows without clipping; workflow retains 2x3', async () => {
  const css = await postcss([tailwind({ base: new URL('../', import.meta.url).pathname })]).process('@import "tailwindcss";', { from: new URL('app/globals.css', root).pathname });
  const history = renderToStaticMarkup(React.createElement(PortfolioWorkflowHistoryCard, { group: group('indmoney_us', 120, { status: 'completed' }), runs: [], onOpen() {} }));
  const original = renderToStaticMarkup(React.createElement('div', { id: 'original', className: 'grid gap-4 sm:grid-cols-2 xl:grid-cols-3' }, shared.STAGE_ORDER.map(key => React.createElement(shared.WorkflowStageTile, { key, stage: key, info: model.historicalStageInfo(stage(key)), now: Date.parse(timestamp) }))));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.abort());
    for (const width of [1180, 1920, 390]) {
      await page.setViewportSize({ width, height: 757 });
      await page.setContent(`<style>${css.css}</style><main style="max-width:${width >= 1180 ? width - 260 : width}px;margin:auto">${history}${original}</main>`);
      await page.screenshot({ path: `/tmp/runs-partial-${width}.png`, fullPage: true });
      assert.match(await page.locator('section').innerText(), /Finished with partial results/);
      const boxes = await page.locator('section article').evaluateAll(nodes => nodes.map(n => ({ top: n.offsetTop, width: n.getBoundingClientRect().width })));
      assert.equal(new Set(boxes.map(box => box.top)).size, 6);
      assert.ok(boxes.every(box => box.width <= width));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const region = page.getByRole('region', { name: /stage evidence/ });
      assert.equal(await region.evaluate(node => node.scrollWidth), await region.evaluate(node => node.clientWidth));
      const duration = page.getByRole('button', { name: /Show duration breakdown/ }).first();
      await duration.focus();
      assert.equal(await duration.evaluate(node => node === document.activeElement), true);
      await page.keyboard.press('Tab');
      assert.match(await page.evaluate(() => document.activeElement.getAttribute('aria-label') || ''), /error details/);
      if (width === 1920) {
        assert.equal(new Set(await page.locator('#original article').evaluateAll(nodes => nodes.map(n => n.offsetTop))).size, 2);
      }
    }
  } finally { await browser.close(); }
});


test('run completeness reflects saved stages across both markets without changing execution facts', () => {
  for (const market of ['india', 'indmoney_us']) {
    const full = group(market, 120, { status: 'completed', stages: shared.STAGE_ORDER.map(key => stage(key, {
      completed_provider_count: 3, partial_provider_count: 0, failed_provider_count: 0,
    })) });
    const before = structuredClone(full);
    assert.equal(model.portfolioResultCompleteness(full).label, 'Fully complete');
    const partial = structuredClone(full);
    partial.stages[3].partial_provider_count = 1;
    assert.equal(model.portfolioResultCompleteness(partial).label, 'Finished with partial results');
    partial.stages[3].partial_provider_count = 0;
    partial.stages[3].summary.partial_notice = 'LLM output is partially used';
    assert.equal(model.portfolioResultCompleteness(partial).label, 'Finished with partial results');
    for (const status of ['failed', 'cancelled', 'processing', 'pending', 'unknown']) {
      assert.equal(model.portfolioResultCompleteness({ ...full, status }).complete, false);
      assert.equal(model.portfolioResultCompleteness({ ...full, stages: full.stages.map((s, i) => i ? s : { ...s, status }) }).complete, false);
    }
    assert.equal(model.portfolioResultCompleteness({ ...full, stages: [] }).complete, false);
    assert.equal(model.portfolioResultCompleteness({ ...full, stages: full.stages.slice(1) }).complete, false);
    const missingCounts = structuredClone(full);
    delete missingCounts.stages[0].provider_count;
    assert.equal(model.portfolioResultCompleteness(missingCounts).complete, false);
    const conflicting = structuredClone(full);
    conflicting.stages[3].partial_provider_count = 1;
    conflicting.stages[3].summary.partial_llms = 0;
    assert.equal(model.portfolioResultCompleteness(conflicting).complete, false);
    const html = renderToStaticMarkup(React.createElement(PortfolioWorkflowHistoryCard, { group: partial, runs: [], onOpen() {} }));
    assert.match(html, /Finished with partial results/);
    assert.match(html, /Execution: completed/);
    assert.match(html, /LLM output partial/);
    assert.deepEqual(full, before);
  }
});


test('ledger preserves failed, queued, unavailable and unfinished evidence without inventing durations', () => {
  const item = group('india', 8, { status: 'failed', stages: [
    stage('rebalance', { status: 'failed', completed_at: null, error_message: 'saved timeout', summary: {} }),
    stage('swing', { status: 'queued', completed_at: null, summary: {} }),
  ] });
  const before = structuredClone(item);
  const html = renderToStaticMarkup(React.createElement(PortfolioWorkflowHistoryCard, { group: item, runs: [], runLinksAvailable: false, onOpen() {} }));
  assert.match(html, /Status: failed/);
  assert.match(html, /Status: queued/);
  assert.match(html, /Not recorded/);
  assert.match(html, /still loading or unavailable/);
  assert.doesNotMatch(html, /Show duration breakdown/);
  assert.deepEqual(item, before);
});

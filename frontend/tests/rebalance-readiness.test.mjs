import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import * as icons from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const modules = { react: React, 'react/jsx-runtime': jsxRuntime, 'lucide-react': icons, '@/lib/utils': { cn: (...args) => args.filter(x => typeof x === 'string').join(' ') } };
function load(source, bindings = {}) {
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  new Function('exports', 'require', ...Object.keys(bindings), compiled)(exports, name => {
    assert.ok(modules[name], `Unexpected runtime import: ${name}`);
    return modules[name];
  }, ...Object.values(bindings));
  return exports;
}
const readiness = modules['@/lib/rebalanceReadiness'] = load(read('../lib/rebalanceReadiness.ts'));
modules['@/lib/llmInternetAccess'] = load(read('../lib/llmInternetAccess.ts'));
const { RebalanceReadiness } = load(read('../app/console/_components/RebalanceReadiness.tsx'));
const { LlmModelSelectionPanel } = load(read('../components/shared/LlmModelSelectionPanel.tsx'));
const base = { loading: false, error: null, portfolio: { holdings: [{ symbol: 'FIXTURE' }] }, threats: { status: 'completed', report: { raw_markdown: 'Saved fixture report' } }, selectedSwingCount: 1, blockedReason: null };
const render = (props) => renderToStaticMarkup(RebalanceReadiness({ ...base, ...props }));
const count = (html, value) => (html.match(new RegExp(`>${value}<`, 'g')) || []).length;

test('checklist renders loading, loaded, confirmed empty and failed states', () => {
  assert.equal(count(render({ loading: true, blockedReason: 'Loading rebalance inputs…' }), 'Loading'), 3);
  assert.equal(count(render({}), 'Ready'), 3);
  assert.equal(count(render({ portfolio: null, threats: null, selectedSwingCount: 0 }), 'Missing'), 3);
  const failed = render({ error: 'Read failed', blockedReason: 'Read failed' });
  assert.equal(count(failed, 'Failed'), 3);
  assert.match(failed, /Execution blocked: Read failed/);
  assert.equal(count(render({ threats: { status: 'failed' } }), 'Failed'), 1);
  assert.equal(count(render({ threats: { status: 'processing' } }), 'Loading'), 1);
  assert.equal(count(render({ threats: { status: 'completed', report: null } }), 'Missing'), 1);
});

test('missing optional context remains eligible, while actual input, model and prompt guards are reported', () => {
  assert.match(render({ threats: null, selectedSwingCount: 0 }), /Execution may proceed/);
  for (const blockedReason of ['Enter a prompt.', 'Select at least one model.', 'Submission in progress.', 'The INDmoney holdings snapshot is incomplete.']) {
    const html = render({ blockedReason });
    assert.ok(html.includes(`Execution blocked: ${blockedReason}`));
    assert.doesNotMatch(html, /Execution may proceed/);
  }
});

function modelPanel(estimates, props = {}) {
  return renderToStaticMarkup(React.createElement(LlmModelSelectionPanel, { providers: [{ name: 'openai', configured: true, models: ['a', 'b'], model_estimated_cost_inr: estimates }], selectedKeys: new Set(['openai::a', 'openai::b']), onToggle() {}, showEstimateReadiness: true, ...props }));
}
test('unknown, partial, stale selection, loading and explicit zero estimates stay distinct', () => {
  for (const value of [undefined, null, NaN, Infinity, -1]) assert.equal(readiness.isKnownEstimate(value), false);
  assert.equal(readiness.isKnownEstimate(0), true);
  assert.match(modelPanel({}), /Unknown \(2 model estimates unavailable\)/);
  assert.match(modelPanel({ a: 2 }), /Unknown \(1 model estimate unavailable\)/);
  assert.match(modelPanel({ a: 0, b: 0 }), /Estimated selected total: ₹0.00 reported \(zero not verified\)/);
  assert.match(modelPanel({ a: 1.25, b: 2.5 }), /Estimated selected total: ₹3.75/);
  assert.match(modelPanel({ a: 0, b: 0 }, { loading: true }), /Loading pricing/);
  assert.match(modelPanel({ a: 0, b: 0 }, { selectedKeys: new Set(['retired::model']) }), /Unknown/);
  assert.match(modelPanel({}, { showEstimateReadiness: false }), /Estimated selected total: ₹0.00/);
});

const consoleSource = read('../app/console/_components/PortfolioRebalanceConsole.tsx');
const ast = ts.createSourceFile('console.tsx', consoleSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let declaration;
function walk(node) { if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(ast) === 'loadInputs')) declaration = node.getText(ast); ts.forEachChild(node, walk); }
walk(ast);
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function harness() {
  const requests = [], writes = [], inputRequestRef = { current: 0 };
  const setters = Object.fromEntries(['setLoading', 'setError', 'setPortfolioSnapshot', 'setThreatAnalysis', 'setSwingRuns', 'setSelectedSwingJobIds'].map(name => [name, value => writes.push([name, value])]));
  const callback = load(`${declaration}\nexports.loadInputs = loadInputs;`, { ...setters, inputRequestRef, useCallback: fn => fn, portfolio: 'zerodha', market: 'india', previousClose: new Date('2026-10-30'), normalizeError: err => err.message, parseApiTimestampMs: Date.parse, getSwingJobSelectionId: (id, link) => `${id}:${link.job_id}`, isRunInSwingTradeMarket: () => true, apiService: { zerodhaPortfolioOverview: () => { const request = deferred(); requests.push(request); return request.promise; }, zerodhaThreatsLatest: async () => ({ analysis: base.threats }), getRuns: async () => ({ items: [] }) } }).loadInputs;
  return { callback, requests, writes, inputRequestRef };
}
test('older successful and failed input responses cannot overwrite a newer refresh', async () => {
  for (const rejectOld of [false, true]) {
    const h = harness(); const old = h.callback(); const fresh = h.callback();
    const snapshot = { holdings: [{ symbol: 'NEW' }], captured_at: '2026-10-31' };
    h.requests[1].resolve({ latest: snapshot }); await fresh;
    const before = h.writes.slice();
    if (rejectOld) h.requests[0].reject(new Error('Stale failure')); else h.requests[0].resolve({ latest: { holdings: [{ symbol: 'OLD' }] } });
    await old;
    assert.deepEqual(h.writes, before);
    assert.ok(h.writes.some(([key, value]) => key === 'setPortfolioSnapshot' && value === snapshot));
  }
});
test('unmounted requests cannot update inputs and current failures retain the existing all-or-nothing guard', async () => {
  const h = harness(); const pending = h.callback(); h.inputRequestRef.current++;
  const before = h.writes.slice(); h.requests[0].resolve({ latest: base.portfolio }); await pending;
  assert.deepEqual(h.writes, before);
  const current = harness(); const failed = current.callback(); current.requests[0].reject(new Error('Offline fixture')); await failed;
  assert.ok(current.writes.some(([key, value]) => key === 'setError' && value === 'Offline fixture'));
  assert.ok(current.writes.some(([key, value]) => key === 'setPortfolioSnapshot' && value === null));
  assert.match(consoleSource, /submitBlockedReason=\{inputError\}/);
  assert.match(consoleSource, /return \(\) => \{ inputRequestRef.current \+= 1; \}/);
});

if (process.env.READINESS_FIXTURE_DIR) {
  const dir = process.env.READINESS_FIXTURE_DIR; mkdirSync(dir, { recursive: true });
  for (const [name, props, estimates] of [
    ['loading', { loading: true, blockedReason: 'Loading rebalance inputs…' }, {}],
    ['ready-zero', {}, { a: 0, b: 0 }],
    ['missing-unknown', { threats: null, selectedSwingCount: 0 }, {}],
    ['failed', { error: 'Offline fixture', blockedReason: 'Offline fixture' }, {}],
  ]) writeFileSync(`${dir}/${name}.html`, `<!doctype html><html><meta charset="utf-8"><title>Offline rebalance fixture: ${name}</title><style>body{font:16px system-ui;max-width:1100px;margin:30px;color:#172130}section{border:1px solid #ccd4dd;border-radius:12px;padding:16px;margin-bottom:24px}ul{display:flex;gap:16px;padding:0;list-style:none}li{flex:1;padding:12px;border:1px solid #ddd;border-radius:8px}li div{display:flex;justify-content:space-between;gap:20px}p{line-height:1.6}h1{font-size:22px}svg{width:16px;height:16px}button{padding:8px}span{margin-right:8px}</style><body><h1>Offline rebalance readiness fixture: ${name}</h1>${render(props)}${modelPanel(estimates, { loading: props.loading || false })}</body></html>`);
}

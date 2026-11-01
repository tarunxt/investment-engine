import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import * as icons from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const modules = { 'react/jsx-runtime': jsxRuntime, 'lucide-react': icons, '@/lib/utils': { cn: (...args) => args.filter(x => typeof x === 'string').join(' ') } };
function load(source, bindings = {}) {
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  new Function('exports', 'require', ...Object.keys(bindings), compiled)(exports, name => {
    assert.ok(modules[name], `Unexpected runtime import: ${name}`);
    return modules[name];
  }, ...Object.values(bindings));
  return exports;
}
modules['@/lib/rebalanceRunIdentity'] = load(read('../lib/rebalanceRunIdentity.ts'));
modules['@/lib/rebalanceStageInputs'] = load(read('../lib/rebalanceStageInputs.ts'));
modules['@/lib/rebalanceReadiness'] = load(read('../lib/rebalanceReadiness.ts'));
const rebalance = load(read('../lib/rebalance.ts'));
const { RebalanceReadiness } = load(read('../app/console/_components/RebalanceReadiness.tsx'));
const source = read('../app/console/_components/PortfolioRebalanceConsole.tsx');
const ast = ts.createSourceFile('console.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = ast.statements.filter(node =>
  (ts.isFunctionDeclaration(node) && node.name?.text !== 'PortfolioRebalanceConsole') ||
  (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(ast) === 'INPUT_SECTION_META')),
).map(node => node.getText(ast)).join('\n');
const row = '| NSE | synthetic model | SYNTH | BUY | 1 | fixture |';
const run = { id: 41, prompt: 'Act as a top-tier India aggressive swing-trading strategist.', status: 'completed', created_at: '2026-10-30T12:00:00Z', run_jobs: [51, 52].map(id => ({ job_id: id, job: { id, provider: 'fixture', model: `model-${id}`, status: 'completed', response: row } })) };
for (const link of run.run_jobs) {
  link.run_id = run.id;
  link.stage = 1;
  link.job.prompt = run.prompt;
}
const portfolio = { captured_at: '2026-10-30T12:00:00Z', snapshot_date: '2026-10-30', holdings: [] };
const close = new Date('2026-10-29T10:00:00Z');
const pass = ({ children }) => React.createElement('div', null, children);
function render({ runs = [run], selected = new Set(['41:51', '41:52']), loading = false, error = null, expanded = true } = {}) {
  const values = [portfolio, null, runs, selected, loading, error, expanded, new Set()];
  let index = 0;
  const { RebalanceInputBox } = load(`${declarations}\nexports.RebalanceInputBox = RebalanceInputBox;`, {
    AlertCircle: icons.AlertCircle, BriefcaseBusiness: icons.BriefcaseBusiness, ChevronDown: icons.ChevronDown, ChevronUp: icons.ChevronUp, RefreshCw: icons.RefreshCw, ShieldAlert: icons.ShieldAlert, TrendingUp: icons.TrendingUp, ...rebalance, RebalanceReadiness,
    Card: pass, CardContent: pass, CardHeader: pass, CardTitle: pass, Button: pass, Link: pass, URLs: load(read('../lib/urls.ts')).URLs, CreateJobCard: () => null,
    useState: () => [values[index++], () => {}], useMemo: fn => fn(), useCallback: fn => fn, useRef: value => ({ current: value }), useEffect: () => {},
    useDashboard: () => ({ setPrompt() {}, setOutputSourceSelection() {}, prompt: 'fixture', selectedTargets: new Set(['fixture']), submitting: false }),
    getPreviousMarketClose: () => close,
  });
  return renderToStaticMarkup(RebalanceInputBox({ portfolio: 'zerodha', market: 'india', basePrompt: 'fixture' }));
}
test('selected saved evidence agrees across readiness, tile, body and footer', () => {
  const html = render();
  assert.doesNotMatch(html, /Input context unavailable/);
  assert.match(html, /2 selected model outputs/);
  const stats = '1 runs considered · 2 LLMs considered · 2 stocks recommended';
  assert.equal(html.split(stats).length - 1, 3, html.match(/.{0,20}runs considered.{0,150}/g)?.join('\n'));
  assert.match(html, /2 of 2 LLM outputs/);
  assert.match(html, new RegExp(`${(row.length * 2).toLocaleString('en-IN')} output characters selected`));
  assert.doesNotMatch(html, /No data|0 runs considered|No completed swing-trade runs/);
  const bundle = rebalance.buildRebalanceInputBundle({ market: 'india', portfolio, threats: null, swingRuns: [run], previousClose: close });
  const marker = rebalance.REBALANCE_INPUT_SECTION_MARKERS;
  const length = bundle.split(marker.swing)[1].split(marker.threats)[0].trim().length.toLocaleString('en-IN');
  assert.ok(html.includes(`${length} chars`));
  assert.ok(html.includes(`${length} characters in selected swing input prompt context`));
  assert.match(render({ expanded: false }), /1 runs considered · 2 LLMs considered · 2 stocks recommended/);
});
test('no qualifying jobs and deselected jobs show zero selection consistently', () => {
  for (const options of [{ runs: [], selected: new Set() }, { selected: new Set() }]) {
    const html = render(options);
    assert.match(html, /Missing/);
    assert.equal(html.split('0 runs considered · 0 LLMs considered · 0 stocks recommended').length - 1, 3);
    assert.match(html, /0 of [02] LLM outputs/);
    assert.doesNotMatch(html, /No data/);
  }
  assert.match(render({ runs: [], selected: new Set() }), /No completed India swing-trade runs/);
});
test('a partial selection counts only the chosen saved job and preserves both records', () => {
  const before = structuredClone(run);
  const html = render({ selected: new Set(['41:52']) });
  assert.match(html, /1 selected model outputs/);
  assert.equal(html.split('1 runs considered · 1 LLMs considered · 1 stocks recommended').length - 1, 3);
  assert.match(html, /1 of 2 LLM outputs/);
  assert.match(html, new RegExp(`${row.length} output characters selected`));
  assert.deepEqual(run, before);
});
test('loading and failed input reads never fabricate empty counts in the tile or footer', () => {
  const loading = render({ loading: true });
  assert.match(loading, /Counting characters…/);
  assert.doesNotMatch(loading, /No data|0 runs considered/);
  const failed = render({ runs: [], selected: new Set(), error: 'Synthetic read failure' });
  assert.match(failed, /Input context unavailable/);
  assert.doesNotMatch(failed, /No data|0 runs considered/);
});

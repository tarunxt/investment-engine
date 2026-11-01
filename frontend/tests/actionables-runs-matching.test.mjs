import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
function load(source, bindings = {}) {
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const loaded = { exports: {} };
  new Function('module', 'exports', 'require', ...Object.keys(bindings), compiled)(loaded, loaded.exports, require, ...Object.values(bindings));
  return loaded.exports;
}
const { ActionablesRunGroup, ActionablesEmptyState } = load(read('../components/shared/ActionablesRunGroup.tsx'));
const { withFinalActionablesReadDeadline } = load(read('../lib/finalActionablesReadDeadline.ts'));
const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));
const sourceRun = { id: 450, created_at: '2026-10-31T10:15:00Z', status: 'completed', prompt: 'Instructions\n## Rebalance Input Bundle\nSnapshot date: 2026-10-30; captured at: 2026-10-31T08:00:00Z\n## Swing Trade Run #440\nCreated: 2026-10-31T09:00:00Z\nJob #701\nThreats job #702\n<script>unsafe()</script>' };
const base = { market: 'india', latestRun: null, runCount: 0, stockCount: 0, loading: false, error: null };

for (const market of ['india', 'us']) {
  test(`${market}: pending and failed retrieval never declare an empty result or zero count`, () => {
    for (const state of [{ loading: true }, { error: 'Request failed' }]) {
      const html = render(ActionablesRunGroup, { ...base, market, ...state });
      assert.doesNotMatch(html, /No qualifying|None found|<dd>0<\/dd>|No source input set/);
      assert.match(html, state.loading ? /Checking…/ : /Unavailable/);
      const empty = render(ActionablesEmptyState, { ...base, ...state, hasMatchingRun: false });
      assert.doesNotMatch(empty, /No qualifying|No parsable/);
      assert.match(empty, state.loading ? /role="status"/ : /role="alert"/);
    }
  });
  test(`${market}: success retains source IDs, exact timestamps, and consolidation counts`, () => {
    const html = render(ActionablesRunGroup, { ...base, market, latestRun: sourceRun, runCount: 3, stockCount: 19 });
    for (const value of ['#450', '#440', '#701', '#702', '2026-10-31T10:15:00Z', '2026-10-31T08:00:00Z', '2026-10-31T09:00:00Z', '<dd>3</dd>', '<dd>19</dd>', 'whitespace normalization', 'full normalized prompt']) assert.ok(html.includes(value), value);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /Instructions/);
  });
  test(`${market}: confirmed empty distinguishes missing qualifying run from missing stock rows`, () => {
    const html = render(ActionablesRunGroup, { ...base, market });
    assert.match(html, /No qualifying run in loaded results/);
    assert.match(html, /<dd>0<\/dd>/);
    assert.match(html, /No source input set was selected/);
    assert.match(render(ActionablesEmptyState, { loading: false, error: null, hasMatchingRun: true }), /No parsable stock rows/);
    assert.match(render(ActionablesEmptyState, { loading: false, error: null, hasMatchingRun: false }), /No qualifying rebalance run/);
  });
  test(`${market}: retained source group is explicitly unverified during refresh failure`, () => {
    const html = render(ActionablesRunGroup, { ...base, market, latestRun: sourceRun, runCount: 2, stockCount: 9, error: 'network' });
    assert.match(html, /Refresh failed/);
    assert.match(html, /Current matching results are unverified/);
    assert.match(html, /#450/);
    assert.match(html, /<dd>2<\/dd>/);
    assert.match(render(ActionablesRunGroup, { ...base, market, latestRun: sourceRun, loading: true }), /Refreshing runs; showing the last available source group/);
  });
}

test('late run responses cannot replace newer data, failure, or loading state', async () => {
  const source = read('../app/console/_components/FinalActionablesConsole.tsx');
  const scoped = source.slice(source.indexOf('function ScopedFinalActionablesConsole'));
  const start = scoped.indexOf('  const loadRuns = useCallback(');
  const end = scoped.indexOf('\n  const loadTechnicalScanHistory', start);
  assert.ok(start > 0 && end > start);
  const pending = [];
  const state = { runs: null, loading: false, error: null, writes: [] };
  const { loadRuns } = load(`${scoped.slice(start, end)}\nexport {loadRuns};`, {
    withFinalActionablesReadDeadline,
    useCallback: fn => fn, runsRequestRef: { current: 0 }, market: 'india', runCacheKey: 'fixture',
    setLoading: value => { state.loading = value; }, setError: value => { state.error = value; },
    setRuns: value => { state.runs = value; }, cacheFinalActionablesRuns: (...args) => state.writes.push(args),
    fetchAllFullRuns: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
  });
  const old = loadRuns(), current = loadRuns();
  pending[1].resolve([{ id: 451 }]); await current;
  pending[0].resolve([{ id: 450 }]); await old;
  assert.deepEqual(state.runs, [{ id: 451 }]); assert.equal(state.writes.length, 1);
  const staleFailure = loadRuns(), newest = loadRuns();
  pending[2].reject(new Error('old failure')); await staleFailure;
  assert.equal(state.error, null); assert.equal(state.loading, true);
  pending[3].reject(new Error('current failure')); await newest;
  assert.equal(state.error, 'current failure'); assert.equal(state.loading, false);
  assert.deepEqual(state.runs, [{ id: 451 }]);
});

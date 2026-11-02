import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
function load(path, mocks = {}) {
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const loadedModule = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    (name) => mocks[name] ?? require(name), loadedModule, loadedModule.exports,
  );
  return loadedModule.exports;
}
const fx = load('../lib/fxPresentation.ts');
function render({ rate = 0, costs = [2, 0, null], loading = false, empty = false, error = null, verified = true } = {}) {
  let stateIndex = 0;
  const run = {
    id: 1, status: 'completed', current_stage: 1, prompt_preview: 'Swing trade',
    run_jobs: costs.map((estimated_cost, id) => ({ id, job: {
      id, provider: 'openai', model: 'test', status: 'completed', estimated_cost,
    } })),
  };
  const { RecentJobsTable } = load('../app/console/dashboard/_components/RecentJobsTable.tsx', {
    react: { ...React, useEffect() {}, useRef: () => ({ current: {} }),
      useState: (initial) => [stateIndex++ === 0 ? rate : typeof initial === 'function' ? initial() : initial, () => {}] },
    'lucide-react': { Clock3: () => null, Loader2: () => null },
    'next/link': { default: ({ children }) => React.createElement('span', null, children) },
    'next/navigation': { useRouter: () => ({ push() {} }) },
    '@/lib/utils': { cn: (...classes) => classes.filter(Boolean).join(' ') },
    '@/lib/urls': { URLs: { routes: { console: { jobs: () => '/jobs' } } } },
    '@/lib/fxPresentation': fx,
    '@/lib/rebalance': {}, '@/services/api': {},
    '@/lib/runPresentation': {
      formatRunLabel: () => 'Run 1', getRunDetailPathFromPrompt: () => '/runs/1',
      getRunSheetsPresentation: () => ({ state: 'failed', label: 'Export failed' }),
      getJobSheetsPresentation: () => ({ state: 'failed', label: 'Export failed' }),
    },
    '../_context': { INDIA_TIMEZONE: 'Asia/Kolkata', STATUS_ICONS: {}, STATUS_STYLES: {},
      useDashboard: () => ({ runs: empty ? [] : [run], runsTotal: empty ? 0 : 1, loadingRuns: loading, runsError: error, lastUpdated: verified ? new Date("2026-11-02T06:00:00Z") : null }) },
  });
  return renderToStaticMarkup(React.createElement(RecentJobsTable));
}

test('shared responsive table labels USD rows and totals when FX is unavailable', () => {
  const html = render();
  assert.match(html, /Cost \(USD\)/);
  assert.match(html, /USD \$2.00 \(FX unavailable\)/);
  assert.match(html, /USD \$0.00 \(FX unavailable\)/);
  assert.match(html, /Not captured/);
  assert.match(html, /Known cost:/);
  assert.match(html, /1 not captured/);
  assert.doesNotMatch(html, /Cost \(INR\)|₹/);
  assert.match(html, /overflow-x-auto/);
  assert.match(html, /completed/);
  assert.match(html, /Export failed/);
});

test('verified FX changes the header, rows and total together', () => {
  const html = render({ rate: 86.125, costs: [2, 0] });
  assert.match(html, /Cost \(INR\)/);
  assert.match(html, /INR ₹172.25/);
  assert.match(html, /INR ₹0.00/);
  assert.match(html, /Total cost:/);
  assert.doesNotMatch(html, /FX unavailable|Cost \(USD\)/);
});

test('loading, empty and unknown costs do not invent zero totals', () => {
  assert.match(render({ loading: true }), /Refreshing jobs; showing previously loaded rows/);
  assert.match(render({ empty: true }), /No jobs yet/);
  const html = render({ costs: [null] });
  assert.match(html, /Not captured/);
  assert.doesNotMatch(html, /\$0.00|₹0.00/);
});

// DATA-ERROR-20261102-02: shared body/footer predicates and retained partial rows.
test('initial loading and failed reads never claim settled empty jobs', () => {
  for (const props of [{ loading: true, empty: true, verified: false }, { error: 'Synthetic timeout', empty: true }, { empty: true, verified: false }]) {
    const html = render(props);
    assert.doesNotMatch(html, /No jobs yet/);
  }
  assert.match(render({ empty: true, loading: true }), /Loading jobs…/);
  assert.match(render({ empty: true, error: 'Synthetic timeout' }), /Jobs unavailable/);
  assert.match(render({ empty: true, verified: false }), /Jobs not yet verified/);
  assert.match(render({ empty: true }), /No jobs yet/);
});
test('partial and stale jobs retain data and unverified costs while announcing refresh failure', () => {
  const html = render({ costs: [0.25, null], error: 'Synthetic timeout' });
  assert.match(html, /Showing previously loaded jobs/);
  assert.match(html, /USD \$0.25/);
  assert.match(html, /1 not captured/);
  assert.doesNotMatch(html, /No jobs yet/);
  const refresh = render({ loading: true, costs: [0.25, null] });
  assert.match(refresh, /Refreshing jobs/);
  assert.match(refresh, /USD \$0.25/);
});

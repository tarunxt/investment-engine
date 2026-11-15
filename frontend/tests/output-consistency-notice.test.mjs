import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { createElement } from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const compiled = ts.transpileModule(read('../components/OutputConsistencyNotice.tsx'), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const exports = {};
new Function('exports', 'require', compiled)(exports, (name) => {
  assert.equal(name, 'react/jsx-runtime');
  return jsxRuntime;
});
const render = (metadata) => renderToStaticMarkup(createElement(exports.OutputConsistencyNotice, { metadata }));
const metadata = (overrides = {}) => ({ deterministic_output: { consistency: {
  version: 'credx-output-consistency-v1', check_counts: { consistent: 0, inconsistent: 0, unknown: 4, unchecked: 8 },
  checks: [], detail_limit_reached: false, ...overrides,
} } });

test('absent legacy metadata makes no claim that historical output was checked', () => {
  for (const legacy of [undefined, null, {}, { deterministic_output: { status: 'valid' } }]) assert.equal(render(legacy), '');
});

test('unknown and unsupported text never display a clean validation pass', () => {
  const html = render(metadata());
  assert.match(html, /Output consistency unverified/);
  assert.match(html, /4 checks remain unknown; 8 statements are unchecked/);
  assert.match(html, /Live prices and investment advice were not evaluated/);
  assert.doesNotMatch(html, /No conflicts found|emerald|green/);
});

test('conflicts show quoted evidence, supplied price, precise source scope and bounded detail notice', () => {
  const html = render(metadata({ check_counts: { consistent: 1, inconsistent: 3, unknown: 2, unchecked: 6 },
    detail_limit_reached: true, omitted_check_counts: { inconsistent: 1, unchecked: 10 }, checks: [
      { status: 'inconsistent', code: 'supplied_price_comparison_contradiction', source: { row: 2, fragment: 0 },
        evidence: { statement: 'Current price is below 120.', supplied_price: '124.2' } },
      { status: 'inconsistent', code: 'referenced_run_identity_mismatch', source: { row: 3, fragment: 0 },
        evidence: { statement: 'Swing Trade Run #5', exchange_symbol: 'NSE', stock_symbol: 'ABC' } },
    ] }));
  assert.match(html, /3 supplied-evidence conflicts/);
  assert.match(html, /Row 2 \(fragment 0\)/);
  assert.match(html, /Current price is below 120/);
  assert.match(html, /Price per Unit \(124.2\)/);
  assert.match(html, /Swing Trade Run #5/);
  assert.match(html, /NSE:ABC row in the complete saved source evidence/);
  assert.match(html, /11 check details are omitted, including 1 conflict/);
});

test('supported agreement remains qualified and malformed reports stay unavailable', () => {
  assert.match(render(metadata({ check_counts: { consistent: 2, inconsistent: 0, unknown: 3, unchecked: 8 } })), /No conflicts found in 2 supported checks/);
  assert.match(render(metadata({ check_counts: { consistent: 2, inconsistent: -1, unknown: 0, unchecked: 0 } })), /report unavailable/);
});

test('job and shared run details retain their output tables and add the same advisory notice', () => {
  for (const path of ['../app/console/jobs/[id]/page.tsx', '../app/console/_components/RunDetailPageContent.tsx']) {
    const source = read(path);
    assert.match(source, /OutputConsistencyNotice metadata=\{job.runtime_metadata_json\}/);
    assert.match(source, /InvestmentRecommendationTable[\s\S]*content=\{job.response \?\? ''\}/);
  }
});

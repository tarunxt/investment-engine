// VISUAL-API-RECOVERY-CONTROLS: scoped copy and unchanged request/guard boundaries.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const page = readFileSync(new URL('../app/console/apis/page.tsx', import.meta.url), 'utf8');
const daily = readFileSync(new URL('../app/console/apis/_components/LlmUsageBreakdown.tsx', import.meta.url), 'utf8');
test('top action accurately names both existing reads; trend retry remains independent', () => {
  assert.match(page, /Refresh usage summary and cost trend/);
  assert.match(page, /const refreshAll = useCallback\(\(\) => \{\s+void load\(\);\s+void loadCombinedCostHistories\(\);/);
  assert.match(page, /onRetry=\{loadCombinedCostHistories\}/);
});
for (const [loading, error, label] of [[true, null, 'Refreshing daily breakdown…'], [false, 'Synthetic failure', 'Retry daily breakdown'], [false, null, 'Refresh daily breakdown']]) {
  test(`actual breakdown renders ${label} with its existing loading guard`, () => {
    let cursor = 0;
    const values = ['2026-11-02', null, loading, error, null];
    const hooks = { ...React, useState: () => [values[cursor++], () => {}], useRef: () => ({ current: 0 }), useCallback: fn => fn, useMemo: fn => fn(), useEffect() {} };
    const code = ts.transpileModule(daily, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const mod = { exports: {} };
    new Function('require', 'module', 'exports', code)(name => name === 'react' ? hooks : require(name), mod, mod.exports);
    const tree = mod.exports.default();
    const html = renderToStaticMarkup(tree);
    assert.match(html, new RegExp(label));
    assert.match(html, new RegExp(`aria-disabled="${loading}"`));
    if (error) { assert.match(html, /Usage has not been verified/); assert.doesNotMatch(html, /No usage recorded/); }
    assert.match(daily, /onClick=\{\(\) => \{ if \(!loading\) void load\(\); \}\}/);
  });
}

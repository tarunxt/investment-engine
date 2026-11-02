import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
const source = readFileSync(new URL('../components/RecommendationClaimExplanation.tsx', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX}}).outputText;
const module = {exports: {}};
new Function('require', 'module', 'exports', code)(name => { assert.equal(name, 'react/jsx-runtime'); return jsxRuntime; }, module, module.exports);
const render = item => renderToStaticMarkup(jsxRuntime.jsx(module.exports.ClaimExplanation, {item}));
test('historical and unavailable explanations remain absent', () => {
  for (const item of [null, {}, {state: 'unknown'}, {explanation: null}, {explanation: {reason: 1}}]) assert.equal(render(item), '');
});
test('exact saved reason renders as escaped text', () => {
  assert.equal(render({explanation: {reason: 'Invalidation unmet; neutral evidence.'}}), '<p class="mt-1">Invalidation unmet; neutral evidence.</p>');
  assert.match(render({explanation: {reason: '<script>fixture</script>'}}), /&lt;script&gt;fixture&lt;\/script&gt;/);
});

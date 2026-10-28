import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import * as React from 'react';
const require = createRequire(import.meta.url);
function load(path, bindings = {}) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const code = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join('\n');
  const output = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const result = { exports: {} };
  new Function('exports', 'module', 'require', ...Object.keys(bindings), output)(result.exports, result, require, ...Object.values(bindings));
  return result.exports;
}
const math = load('../lib/portfolioParameters.ts');
const value = (state, key) => math.displayPortfolioParameter(state, key).text;
function edit(state, key, text) { const result = math.editPortfolioParameter(state, key, text); assert.equal(result.error, null); return result.state; }

test('percentage units, linked edits, and exact inverse retain values without round-trip drift', () => {
  let state = math.defaultPortfolioParameters();
  assert.deepEqual(['cash', 'max', 'normalised'].map(key => value(state, key)), ['5.00', '10.00', '9.50']);
  assert.equal(value(edit(state, 'cash', '.5'), 'cash'), '0.50');
  state = edit(state, 'cash', '10'); assert.equal(value(state, 'normalised'), '9.00');
  state = edit(state, 'max', '20'); assert.equal(value(state, 'normalised'), '18.00');
  state = edit(state, 'normalised', '9.5'); assert.equal(value(state, 'max'), '10.555555555556');
  assert.equal(math.displayPortfolioParameter(state, 'max').rounded, true);
  const max = structuredClone(state.max);
  for (let count = 0; count < 100; count++) { state = edit(state, 'cash', '5'); state = edit(state, 'cash', '10'); }
  assert.deepEqual(state.max, max);
  assert.equal(value(state, 'normalised'), '9.50');
  const stepped = math.stepPortfolioParameter(state, 'normalised', 1);
  assert.equal(value(stepped.state, 'normalised'), '9.51');
  assert.deepEqual(math.stepPortfolioParameter(stepped.state, 'normalised', -1).state, state);
});

test('invalid percentages and singular 100% cash never mutate or divide by zero', () => {
  const state = math.defaultPortfolioParameters(), before = structuredClone(state);
  for (const bad of ['', 'not a number', '101', '-1', 'Infinity', '1e2', '0.1234567890123']) assert.equal(math.editPortfolioParameter(state, 'cash', bad).state, null);
  assert.deepEqual(state, before);
  const allCash = edit(state, 'cash', '100'); assert.equal(value(allCash, 'normalised'), '0.00');
  assert.equal(math.editPortfolioParameter(allCash, 'normalised', '1').state, null);
  assert.deepEqual(edit(allCash, 'normalised', '0'), allCash);
  assert.equal(value(edit(allCash, 'max', '20'), 'normalised'), '0.00');
  assert.equal(math.editPortfolioParameter(state, 'normalised', '99').state, null);
  assert.equal(math.stepPortfolioParameter(edit(state, 'cash', '0'), 'cash', -1).state, null);
});

const india = { captured_at: '2026-10-28T12:00:00Z', holdings_count: 2, holdings_market_value: 12000, available_margin: 123, holdings: [{ market_value: 5000 }, { market_value: 7000 }], positions: { net: [{ value: 99999 }], day: [] } };
const us = { captured_at: india.captured_at, parse_status: 'parsed', holdings_count: 2, reported_holdings_count: 2, current_value: 200, holdings: [{ current_value: 90 }, { current_value: 110 }] };
test('readonly assets use selected holdings and the same margin, never positions, buy cost or projected funds', () => {
  assert.deepEqual(math.portfolioParameterAssets(india, 'india', india.available_margin), { portfolioValue: 12000, availableMargin: 123, totalAssets: 12123 });
  assert.deepEqual(math.portfolioParameterAssets(us, 'us', null), { portfolioValue: 200, availableMargin: null, totalAssets: null });
  assert.equal(math.portfolioParameterAssets(us, 'india', null).portfolioValue, null);
  assert.equal(math.portfolioParameterAssets(india, 'us', null).portfolioValue, null);
  assert.equal(math.portfolioParameterAssets(null, 'india', null).totalAssets, null);
  assert.equal(math.portfolioParameterAssets({ ...india, holdings_count: 3 }, 'india', 123).portfolioValue, null);
  assert.equal(math.portfolioParameterAssets({ ...us, holdings: [{ current_value: null }, { current_value: 110 }] }, 'us', null).portfolioValue, null);
  assert.equal(math.portfolioParameterAssets(india, 'india', NaN).availableMargin, null);
  assert.equal(math.portfolioParameterAssets({ ...india, holdings_count: 0, holdings: [], holdings_market_value: 0 }, 'india', 0).totalAssets, 0);
});

function harness() {
  const slots = []; let cursor = 0; let effect;
  return { start() { cursor = 0; }, effect() { return effect?.(); }, hooks: {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; }, useEffect(fn) { effect = fn; },
  } };
}
function find(node, predicate) { if (!node || typeof node !== 'object') return null; if (predicate(node)) return node; return React.Children.toArray(node.props?.children).map(child => find(child, predicate)).find(Boolean) ?? null; }

test('local modal edits, readonly totals, vertical steppers, outside/inside close, Escape and scope isolation', () => {
  const h = harness(); let restored = 0;
  const component = load('../components/PortfolioParametersTile.tsx', { ...math, ...h.hooks, createPortal: node => node, document: { body: {}, activeElement: { focus() { restored += 1; } } } }).PortfolioParametersTile;
  const props = { currency: 'INR', portfolioValue: 12000, availableMargin: 123, totalAssets: 12123, capturedAt: india.captured_at };
  const render = () => { h.start(); return component(props); };
  const tile = find(render(), node => node.props?.['aria-haspopup'] === 'dialog'); tile.props.onClick();
  let tree = render(), modal = find(tree, node => node.props?.role === 'dialog'); assert.ok(modal);
  const cleanup = h.effect();
  const max = find(tree, node => node.props?.id === 'portfolio-parameter-max'); max.props.onChange({ target: { value: '20' } });
  tree = render(); assert.equal(find(tree, node => node.props?.id === 'portfolio-parameter-normalised').props.value, '19.00');
  assert.ok(find(tree, node => node.props?.['aria-label'] === 'Increase Min Cash'));
  assert.ok(find(tree, node => node.props?.['aria-label'] === 'Decrease Min Cash'));
  assert.equal(find(tree, node => node.type === 'input' && /Value|Margin|Assets/.test(node.props?.id ?? '')), null);
  let stopped = 0; modal.props.children.props.onClick({ stopPropagation() { stopped += 1; } }); assert.ok(find(render(), node => node.props?.role === 'dialog'));
  modal.props.onClick({ stopPropagation() { stopped += 1; } }); assert.equal(find(render(), node => node.props?.role === 'dialog'), null); assert.equal(stopped, 2);
  tile.props.onClick(); modal = find(render(), node => node.props?.role === 'dialog');
  modal.props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); assert.equal(find(render(), node => node.props?.role === 'dialog'), null);
  cleanup(); assert.equal(restored, 1);
  const other = harness(); const otherComponent = load('../components/PortfolioParametersTile.tsx', { ...math, ...other.hooks, createPortal: node => node }).PortfolioParametersTile;
  other.start(); const isolated = otherComponent({ ...props, currency: 'USD', availableMargin: null, totalAssets: null }); assert.match(JSON.stringify(isolated), /Max Weight.*10.00/);
  const workflow = readFileSync(new URL('../app/console/dashboard/_components/RebalanceWorkflowSections.tsx', import.meta.url), 'utf8');
  assert.match(workflow, /xl:grid-cols-5/);
  assert.match(workflow, /portfolioParameterAssets\(detailsData.portfolioSnapshot, tradingViewMarket, availableMargin\)/);
  assert.match(workflow, /key=\{`\$\{basketBrokerLabel\}:\$\{tradingViewMarket\}:\$\{detailsData.portfolioSnapshot\?\.captured_at/);
  const componentSource = readFileSync(new URL('../components/PortfolioParametersTile.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(componentSource, /localStorage|apiService|onPlaceOrder|onToggle|onBuyThreshold/);
  assert.match(componentSource, /max-h-\[85vh\].*w-full max-w-lg overflow-auto/);
});

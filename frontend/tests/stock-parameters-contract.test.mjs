import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../lib/stockParameters.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
// An isolated browser mock verifies reads do not rewrite persisted settings.
const storage = new Map();
const window = { localStorage: { getItem: key => storage.get(key) ?? null } };
new Function('exports', 'module', 'window', compiled)(loaded.exports, loaded, window);
const { DEFAULT_STOCK_PARAMETERS: defaults, validateStockParameterValue: validate,
  loadStockParametersFromStorage: load, STOCK_PARAMETERS_STORAGE_KEY: key,
  buildMasterValidationChecklist: checklist } = loaded.exports;
const parameter = id => defaults.find(item => item.id === id);

test('symbol warnings follow the API character and length contract without mutating source identity', () => {
  const rule = parameter('stock-symbol');
  for (const symbol of ['BHARTIARTL', 'PERSISTENT', 'BRK.B', 'M&M', 'BAJAJ-AUTO', '3MINDIA', 'FIXTURE_EQ', 'a'.repeat(64)]) {
    assert.equal(validate(rule, symbol), true, symbol);
  }
  for (const symbol of ['a'.repeat(65), 'BAD SYMBOL', 'NSE:FIXTURE', 'FIX/OTHER', '<script>', 'FIX😀']) {
    assert.equal(validate(rule, symbol), false, symbol);
  }
  // Existing optional-cell behavior is retained outside the required score domain.
  for (const value of ['', '-', 'N/A']) assert.equal(validate(rule, value), true);
  const api = readFileSync(new URL('../../backend/app/domains/recommendation_audit/router.py', import.meta.url), 'utf8');
  assert.match(api, /symbol: str = Query\(min_length=1, max_length=64, pattern=r"\^\[A-Za-z0-9&_\.-\]\+\$"\)/);
});

test('exchange universe and six score defaults agree with stage prompts', () => {
  for (const exchange of ['NASDAQ', 'NYSE', 'AMEX', 'NSE', 'BSE']) assert.equal(validate(parameter('exchange-symbol'), exchange), true);
  for (const exchange of ['UNKNOWN', 'NYSE/AMEX']) assert.equal(validate(parameter('exchange-symbol'), exchange), false);
  const scores = defaults.filter(item => item.id.startsWith('score-rationale-'));
  assert.equal(scores.length, 6);
  for (const score of scores) {
    for (const value of ['-3', '-2', '-1', '0', '1', '2', '3']) assert.equal(validate(score, value), true);
    for (const value of ['', '-', 'N/A', '-4', '4', '1.5', '3%', '1e0', 'bullish']) assert.equal(validate(score, value), false);
  }
  const prompt = readFileSync(new URL('../lib/rebalance.ts', import.meta.url), 'utf8');
  assert.match(prompt, /NASDAQ\/NYSE\/AMEX/);
  assert.match(prompt, /7 integer choices: -3/);
  assert.match(checklist(defaults), /Stock Symbol: 1–64/);
  assert.match(checklist(defaults), /Score Rationale Cruxx: integer from -3 to 3/);
});

test('cached legacy defaults refresh without writes and custom rules and identity survive', () => {
  for (const raw of [undefined, 'not json', '{}']) {
    storage.clear(); if (raw) storage.set(key, raw);
    assert.deepEqual(load(), defaults);
  }
  const legacy = defaults.map(item => ({ ...item, validationRule:
    item.id === 'stock-symbol' ? 'Less than 5 chars' : item.id === 'exchange-symbol' ? 'NASDAQ/NYSE for US & NSE/BSE for Ind'
      : item.id.startsWith('score-rationale-') ? 'number' : item.validationRule }));
  const saved = JSON.stringify(legacy);
  storage.set(key, saved);
  assert.deepEqual(load(), defaults);
  assert.equal(storage.get(key), saved);
  const custom = { ...parameter('stock-symbol'), id: 'custom-identity', description: 'Custom description', validationRule: 'Custom venue rule' };
  storage.set(key, JSON.stringify([custom, { id: 'extra', parameter: 'Extra', validationRule: 'text', description: 'Fixture' }]));
  assert.deepEqual(load().find(item => item.parameter === 'Stock Symbol'), custom);
  assert.equal(load().at(-1).id, 'extra');
  window.localStorage.getItem = () => { throw new Error('Storage unavailable'); };
  assert.deepEqual(load(), defaults);
});

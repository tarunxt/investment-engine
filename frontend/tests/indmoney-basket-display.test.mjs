import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source = fs.readFileSync(new URL('../lib/indmoneyBasketDisplay.ts', import.meta.url), 'utf8');
const sandbox = { exports: {}, Number, Date, Math };
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, sandbox);
const calc = sandbox.exports.indmoneyBasketDisplay;
const input = Object.freeze({ investedAmount: 175.17, currentValue: 220.25, sourceAsOf: '2026-11-07T12:00:00Z', price: 73.13, priceAsOf: '2026-11-07T12:00:00Z', priceSource: 'Alpaca IEX', unavailableReason: null });
test('US target and cost-based actions preserve raw dollar and fractional arithmetic', () => {
  const result = calc(0.2317, 1000, 100, input);
  assert.equal(result.targetAmount, 0.2317 * 1100);
  assert.equal(result.targetStocks, result.targetAmount / 73.13);
  assert.equal(result.actionAmount, result.targetAmount - 175.17);
  assert.equal(result.actionStocks, result.actionAmount / 73.13);
  assert.equal(result.current, 220.25 / 1100);
  assert.equal(input.investedAmount, 175.17);
});
test('missing holdings never become inferred zeros; price-independent amounts remain available', () => {
  const absent = calc(0.2, 1000, 100);
  assert.equal(absent.targetAmount, 220); assert.equal(absent.actionAmount, null);
  assert.equal(absent.current, null); assert.equal(absent.targetStocks, null);
  const noPrice = calc(0.2, 1000, 100, { ...input, price: null });
  assert.equal(noPrice.actionAmount, 220 - 175.17); assert.equal(noPrice.actionStocks, null);
});
test('reject invalid/unvetted price evidence and holding snapshots', () => {
  for (const change of [{price: 0}, {price: Infinity}, {priceSource: 'Quoted LTP'}, {priceSource: 'IEX stale'}, {priceAsOf: null}, {priceAsOf: 'bad'}]) assert.equal(calc(0.2, 1000, 100, {...input, ...change}).targetStocks, null);
  assert.equal(calc(0.2, 1000, 100, {...input, sourceAsOf:null}).actionAmount, null);
  for (const margin of [null, undefined, NaN, Infinity]) assert.equal(calc(0.2, 1000, margin, input).targetAmount, null);
});
test('explicit verified zeros and negative actions remain genuine calculated results', () => {
  const zero = calc(0, 1000, 100, input);
  assert.equal(zero.targetAmount, 0); assert.equal(zero.targetStocks, 0);
  assert.equal(zero.actionAmount, -175.17); assert.equal(zero.action, 'Sell All');
  const empty = calc(0.2, 1000, 100, {...input, investedAmount:0,currentValue:0});
  assert.equal(empty.action, 'Buy New'); assert.equal(empty.actionAmount, 220);
  assert.equal(calc(0, 1000, 100, {...input,price:null}).targetStocks, 0);
  const missingCash=calc(0, 1000, null, input);
  assert.equal(missingCash.current,null); assert.equal(missingCash.action,'Sell All');
  assert.equal(missingCash.targetAmount,0); assert.equal(missingCash.targetStocks,0);
  assert.equal(missingCash.actionAmount,-175.17); assert.equal(missingCash.actionStocks,-175.17/73.13);
});
test('US columns and explanatory popups share the hook, and score disclosure is popup-only', () => {
  const component = fs.readFileSync(new URL('../components/BasketDisplayCalculations.tsx', import.meta.url), 'utf8');
  for (const label of ['Current Weight','Target Weight','Weight Difference','Action New','Action IndMoney Stocks','Action IndMoney Amount','Target IndMoney Stocks','Target IndMoney Amount']) assert.ok(component.includes(label));
  const cells = component.slice(component.indexOf('const cells ='),component.indexOf('const headers ='));
  assert.equal(cells.includes('AllocationScoreContext'),false);
  assert.ok(component.includes('history && currentObservation ? <AllocationScoreContext'));
  assert.ok(component.includes('order units, order amount and readiness are unchanged'));
});
test('identified stale IEX is allowed only as an explicitly disclosed display estimate', () => {
  const stale = calc(0.2, 1000, 100, {...input, priceAsOf:'2026-11-06T12:00:00Z', priceSource:'Alpaca IEX only · partial market coverage · stale last trade · display estimate'});
  assert.equal(stale.targetStocks, 220 / input.price);
  const component = fs.readFileSync(new URL('../components/BasketDisplayCalculations.tsx', import.meta.url),'utf8');
  assert.ok(!component.includes('Stale IEX estimate'));
  assert.ok(component.includes('actionStocks?.toFixed(2)'));
});
test('nonfinite computed values remain unavailable', () => {
  assert.equal(calc(1, Number.MAX_VALUE, Number.MAX_VALUE, input).targetAmount,null);
  assert.equal(calc(2, Number.MAX_VALUE, 0, input).targetAmount,null);
});

test('finite negative wallet margin reduces assets without changing saved inputs', () => {
  assert.equal(calc(0.2, 1000, -100, input).targetAmount, 180);
  assert.equal(calc(0.2, 1000, -100, input).current, input.currentValue / 900);
  assert.equal(calc(0.2, 1000, -1000, input).targetAmount, 0);
  assert.equal(calc(0.2, 1000, -1001, input).targetAmount, null);
});

test('US regular session reflects DST, holidays and shortened trading days', async () => {
  const {usCoreSessionClosed} = await import('../lib/indmoneyBasketDisplay.ts');
  for (const [timestamp,closed] of [
    ['2026-11-07T16:00:00Z',true], ['2026-11-09T14:29:00Z',true],
    ['2026-11-09T14:30:00Z',false], ['2026-11-09T21:00:00Z',true],
    ['2026-07-06T13:30:00Z',false], ['2026-11-26T16:00:00Z',true],
    ['2026-11-27T17:59:00Z',false], ['2026-11-27T18:00:00Z',true],
  ]) assert.equal(usCoreSessionClosed(new Date(timestamp)),closed,timestamp);
});

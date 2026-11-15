import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../lib/tradeAnalysisExecution.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const loaded = { exports: {} };
new Function('exports', 'module', output)(loaded.exports, loaded);
const { tradeExecutionFill, tradeOutcomeLabel } = loaded.exports;

test('failed buy intent is not displayed as a fill or an open position', () => {
  const item = { status: 'FAILED', final_tag: 'OPEN', pnl_outcome_tag: 'OPEN',
    buy_requested_amount: 5, buy_amount: 5, buy_shares: 10, buy_price: 0.5 };
  assert.equal(tradeExecutionFill(item, 'buy').amount, undefined);
  assert.equal(tradeExecutionFill(item, 'buy').shares, undefined);
  assert.equal(tradeOutcomeLabel(item), 'EXECUTION_UNCONFIRMED');
});

test('unconfirmed submissions and exits do not borrow requested amounts', () => {
  const item = { status: 'SUBMITTED', exit_amount: 12, exit_shares: 10 };
  assert.equal(tradeOutcomeLabel(item), 'EXECUTION_UNCONFIRMED');
  assert.equal(tradeExecutionFill(item, 'sell').amount, undefined);
});

test('explicit zero and partial fills are retained, confirmed positions stay open', () => {
  const item = { buy_executed_at: '2026-01-01T00:00:00Z', pnl_outcome_tag: 'OPEN',
    buy_filled_amount: 0, buy_filled_shares: 0, sell_filled_amount: 2, sell_filled_shares: 4 };
  assert.equal(tradeExecutionFill(item, 'buy').amount, 0);
  assert.equal(tradeExecutionFill(item, 'buy').shares, 0);
  assert.equal(tradeExecutionFill(item, 'sell').amount, 2);
  assert.equal(tradeOutcomeLabel(item), 'OPEN');
  assert.equal(tradeOutcomeLabel({ ...item, is_squared_off: true, pnl_outcome_tag: 'LOSS' }), 'LOSS');
});

test('list display uses explicit fill evidence on both sides', () => {
  const page = readFileSync(new URL('../app/console/bullpen-ai/analyse-events/_components/TradeAnalysisListClient.tsx', import.meta.url), 'utf8');
  assert.match(page, /tradeExecutionFill\(item, "buy"\)/);
  assert.match(page, /tradeExecutionFill\(item, "sell"\)/);
  assert.doesNotMatch(page, /buy_filled_amount\s*\?\?|sell_filled_amount\s*\?\?/);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../app/console/sports-rankings/page.tsx', import.meta.url), 'utf8');

test('ranking errors open a detailed accessible diagnostic dialog', () => {
  assert.match(source, /aria-haspopup="dialog"/);
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /What happened/);
  assert.match(source, /How to fix it/);
  assert.match(source, /Technical details/);
  assert.match(source, /Correlation ID/);
  assert.match(source, /Retry now/);
});

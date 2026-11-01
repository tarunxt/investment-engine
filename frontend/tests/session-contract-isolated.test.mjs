import assert from 'node:assert/strict';
import test from 'node:test';
import { SingleFlightByKey } from '../lib/singleFlight.ts';
import { purgePrivateDashboardCache } from '../lib/privateDashboardCache.ts';

test('A9-003-A04 concurrent waiters share a flight and failed refresh permits later recovery', async () => {
  const flights = new SingleFlightByKey();
  let reject;
  let calls = 0;
  const operation = () => {
    calls++;
    return new Promise((_, fail) => { reject = fail; });
  };
  const first = flights.run('synthetic-family-digest', operation);
  const second = flights.run('synthetic-family-digest', operation);
  assert.equal(first, second);
  assert.equal(calls, 1);
  reject(new Error('synthetic storage unavailable'));
  const outcomes = await Promise.allSettled([first, second]);
  assert.ok(outcomes.every(({status}) => status === 'rejected'));
  assert.equal(await flights.run('synthetic-family-digest', async () => 'recovered'), 'recovered');
});

test('A9-R01 private purge is idempotent and preserves public theme', () => {
  const values = new Map([
    ['investment-engine:dashboard-overview-cache:synthetic', 'private fixture'],
    ['investment-engine:theme', 'dark'],
  ]);
  const storage = {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    removeItem(key) { values.delete(key); },
  };
  assert.equal(purgePrivateDashboardCache(storage), 1);
  assert.equal(purgePrivateDashboardCache(storage), 0);
  assert.deepEqual([...values], [['investment-engine:theme', 'dark']]);
  assert.equal(purgePrivateDashboardCache(null), 0);
});

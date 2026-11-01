import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../app/console/indmoney-us/page.tsx', import.meta.url), 'utf8');
const handler = source.match(/const handleRefreshDisplayedData = async \(\) => \{([\s\S]*?)\n  \};/)[1];

function fixture({ selectedId = 4, latestId = 8, fail = false } = {}) {
  const events = [];
  const overview = { history: [{ id: 4 }, { id: 8 }], latest: { id: latestId } };
  const context = {
    selectedSnapshotId: selectedId,
    setLoading: (value) => events.push(['loading', value]),
    setLoadError: (value) => events.push(['error', value]),
    normalizeError: (error) => error.message,
    applyOverview: (...args) => events.push(['apply', ...args]),
    apiService: {
      indmoneyUsPortfolioOverview: async () => { if (fail) throw new Error('Read failed'); return overview; },
      indmoneyUsPortfolioSnapshot: async (id) => { events.push(['detail', id]); return { id }; },
    },
  };
  return { events, run: () => vm.runInNewContext(`(async () => {${handler}})()`, context) };
}

test('display refresh retains selected historical snapshot using reads only', async () => {
  const { events, run } = fixture();
  await run();
  assert.equal(events.find(([name]) => name === 'detail')[1], 4);
  assert.equal(events.find(([name]) => name === 'apply')[2].id, 4);
  assert.deepEqual(events.at(-1), ['loading', false]);
});

test('latest selection uses overview without an extra detail request', async () => {
  const { events, run } = fixture({ selectedId: 8 });
  await run();
  assert.equal(events.some(([name]) => name === 'detail'), false);
  assert.equal(events.find(([name]) => name === 'apply')[2].id, 8);
});

test('failed refresh retains displayed data and exposes failure', async () => {
  const { events, run } = fixture({ fail: true });
  await run();
  assert.equal(events.some(([name]) => name === 'apply'), false);
  assert.deepEqual(events.at(-2), ['error', 'Read failed']);
  assert.deepEqual(events.at(-1), ['loading', false]);
});

test('missing selection lets overview select its current saved snapshot', async () => {
  const { events, run } = fixture({ selectedId: 99 });
  await run();
  assert.equal(events.find(([name]) => name === 'apply')[2], null);
});

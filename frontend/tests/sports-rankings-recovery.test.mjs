import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../lib/sportsRankingsApi.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { RankingReadError, readRankingJson } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

test('500 and 504 reads recover with bounded sequential backoff', async () => {
  const codes = [500, 504, 200], pauses = [], calls = [];
  const result = await readRankingJson('', undefined, async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ competitions: [{ id: 'nhl' }] }), { status: codes.shift() });
  }, async ms => pauses.push(ms));
  assert.equal(result.competitions[0].id, 'nhl');
  assert.deepEqual(pauses, [1500, 3000]);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(c => !c.options.method && c.options.cache === 'no-store'));
});

test('outage retries are capped; 401 and permanent failures are never retried', async () => {
  for (const [status, expected] of [[503, 3], [401, 1], [403, 1]]) {
    let calls = 0;
    await assert.rejects(readRankingJson('', undefined, async () => { calls++; return new Response('{}', { status }); }, async () => {}));
    assert.equal(calls, expected);
  }
});

test('changing selection cancels retries for the old competition', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(readRankingJson('/competitions/nhl', controller.signal, async () => {
    calls++; return new Response('{}', { status: 504 });
  }, async () => controller.abort()), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('network failure can recover without retrying a mutation', async () => {
  let calls = 0;
  const result = await readRankingJson('', undefined, async () => {
    if (++calls === 1) throw new TypeError('network unavailable');
    return new Response('{"ok":true}');
  }, async () => {});
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 2);
});

test('terminal 504 preserves safe diagnostics for the error popup', async () => {
  const error = await readRankingJson('/competitions/uel', undefined, async () => new Response(
    JSON.stringify({ message: 'The backend did not respond in time (14 seconds). Please retry.' }),
    { status: 504, headers: { 'X-Correlation-ID': 'corr-123', 'X-Backend-Proxy-Budget-Ms': '14000', 'Retry-After': '1' } },
  ), async () => {}).catch(value => value);

  assert.ok(error instanceof RankingReadError);
  assert.equal(error.details.code, 'BACKEND_TIMEOUT');
  assert.equal(error.details.status, 504);
  assert.equal(error.details.endpoint, '/backend-api/api/sports-rankings/competitions/uel');
  assert.equal(error.details.correlationId, 'corr-123');
  assert.equal(error.details.proxyBudgetMs, 14000);
  assert.equal(error.details.retryAfter, '1');
  assert.equal(error.details.attempts, 3);
  assert.match(error.details.cause, /service\/database availability problem/);
  assert.equal(error.details.steps.length, 4);
});

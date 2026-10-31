import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { proxyDatabaseDestination } from '../lib/databaseViewerProxy.ts';

const request = () => new Request('https://cred-x.in/database?view=tables', { headers: { cookie: 'viewer=session' } });

test('upstream 500 becomes explicit, private, accessible recovery page', async () => {
  const response = await proxyDatabaseDestination(request(), async () => new Response('secret stack password', { status: 500 }));
  const html = await response.text();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(html, /Database is unavailable/);
  assert.match(html, /does not mean the database is empty/);
  assert.match(html, /href="\/database"/);
  assert.match(html, /href="\/console\/dashboard"/);
  assert.match(html, /:focus-visible/);
  assert.ok(html.includes(response.headers.get('x-support-reference')));
  assert.doesNotMatch(html, /secret stack password|127\.0\.0\.1|8080/);
});

test('connection failures and repeated manual retries remain bounded reads', async () => {
  const references = new Set();
  let calls = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await proxyDatabaseDestination(request(), async (_url, init) => {
      calls++;
      assert.equal(init.method, 'GET');
      assert.equal(init.body, undefined);
      assert.ok(init.signal instanceof AbortSignal);
      throw new Error('sensitive connection configuration');
    });
    assert.equal(response.status, 503);
    references.add(response.headers.get('x-support-reference'));
    assert.doesNotMatch(await response.text(), /sensitive|setInterval|setTimeout|http-equiv="refresh"/);
  }
  assert.equal(calls, 3);
  assert.equal(references.size, 3);
});

test('loading awaits the viewer; successful and confirmed-empty content stay distinct', async () => {
  let finish;
  let settled = false;
  const pending = proxyDatabaseDestination(request(), () => new Promise(resolve => { finish = resolve; })).then(value => { settled = true; return value; });
  await Promise.resolve();
  assert.equal(settled, false);
  finish(new Response('<h1>Tables</h1>'));
  assert.equal(await (await pending).text(), '<h1>Tables</h1>');
  const empty = await proxyDatabaseDestination(request(), async () => new Response('<p>No tables found</p>'));
  assert.equal(empty.status, 200);
  assert.equal(await empty.text(), '<p>No tables found</p>');
});

test('authentication, redirects, cookies, query and access denials pass through', async () => {
  for (const status of [302, 401, 403]) {
    const response = await proxyDatabaseDestination(request(), async (url, init) => {
      assert.equal(url.search, '?view=tables');
      assert.equal(init.headers.get('cookie'), 'viewer=session');
      assert.equal(init.redirect, 'manual');
      return new Response('Viewer authentication', { status, headers: { location: '/database/login', 'set-cookie': 'viewer=session; HttpOnly' } });
    });
    assert.equal(response.status, status);
    assert.equal(response.headers.get('location'), '/database/login');
    assert.equal(response.headers.get('set-cookie'), 'viewer=session; HttpOnly');
    assert.equal(await response.text(), 'Viewer authentication');
  }
});

test('HEAD failure has no body and retains failure status', async () => {
  const response = await proxyDatabaseDestination(new Request('https://cred-x.in/database', { method: 'HEAD' }), async () => new Response(null, { status: 502 }));
  assert.equal(response.status, 503);
  assert.equal(await response.text(), '');
});

test('the exact destination reaches the handler while child routes keep their rewrite', async () => {
  const config = await readFile(new URL('../next.config.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(config, /source: "\/database"/);
  assert.match(config, /source: "\/database\/:path\+"/);
  const route = await readFile(new URL('../app/database/route.ts', import.meta.url), 'utf8');
  assert.match(route, /return proxyDatabaseDestination\(request\)/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { authorizeDatabaseOwner } from '../lib/databaseViewerOwner.ts';
import { proxyDatabaseDestination } from '../lib/databaseViewerProxy.ts';
const req = (path = '/database', method = 'GET') => new Request('https://app.invalid' + path, { method, headers: { cookie: 'authjs.session-token=synthetic', authorization: 'Bearer private', 'x-user-id': '71' } });
const user = { id: 71, is_active: true, role: 'user' };
const options = (extra = {}) => ({ ownerId: '71', backendUrl: 'http://127.0.0.1:8000', readSession: async () => ({ accessToken: 'synthetic' }), fetcher: async (url, init) => {
  assert.equal(url, 'http://127.0.0.1:8000/auth/me');
  assert.equal(init.headers.Authorization, 'Bearer synthetic');
  assert.equal(init.redirect, 'manual'); assert.equal(init.cache, 'no-store'); assert.ok(init.signal instanceof AbortSignal);
  return Response.json(user);
}, ...extra });
test('current active owner only, independent of admin roles, on root and children', async () => {
  for (const path of ['/database', '/database/assets/file']) {
    assert.equal(await authorizeDatabaseOwner(req(path), options()), null);
    for (const identity of [{ ...user, id: 72, role: 'admin' }, { ...user, is_active: false }, { ...user, id: '71' }, {}]) assert.equal((await authorizeDatabaseOwner(req(path), options({ fetcher: async () => Response.json(identity) }))).status, 403);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) assert.equal((await authorizeDatabaseOwner(req(path, method), options())).status, 405);
  }
});
test('missing configuration, session, revoked identity and failed checks fail closed', async () => {
  for (const ownerId of [undefined, '', '0', 'first-admin', ' 71']) assert.equal((await authorizeDatabaseOwner(req(), options({ ownerId, readSession: () => assert.fail('no session read') }))).status, 503);
  assert.equal((await authorizeDatabaseOwner(req(), options({ readSession: async () => null, fetcher: () => assert.fail('no backend read') }))).status, 401);
  for (const status of [401, 403, 302, 500, 503]) assert.equal((await authorizeDatabaseOwner(req(), options({ fetcher: async () => new Response(null, { status }) }))).status, [401, 403].includes(status) ? status : 503);
  for (const fetcher of [async () => { throw new DOMException('timeout', 'TimeoutError'); }, async () => new Response('invalid')]) assert.equal((await authorizeDatabaseOwner(req(), options({ fetcher }))).status, 503);
});
test('both routes invoke authorization before proxy, no rewrite bypass or development identity', () => {
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  for (const path of ['../app/database/route.ts', '../app/database/[...path]/route.ts']) {
    assert.match(read(path), /return protectedDatabaseDestination\(request\)/);
    for (const method of ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']) assert.match(read(path), new RegExp(`export const ${method} = forward`));
  }
  assert.doesNotMatch(read('../next.config.ts'), /source:.*database/);
  const route = read('../lib/databaseViewerRoute.ts');
  assert.match(route, /return denial \?\? proxyDatabaseDestination\(request\)/);
  assert.match(route, /if \(!secret/); assert.match(route, /NEXT_PUBLIC_DISABLE_AUTH === 'true'/);
});
test('viewer gets no application credentials; ambiguous paths and external redirects fail closed', async () => {
  for (const path of ['/database', '/database/assets/file']) {
    const response = await proxyDatabaseDestination(req(path), async (url, init) => {
      assert.equal(url.pathname, path === '/database' ? '/' : '/assets/file');
      for (const name of ['cookie','authorization','x-user-id']) assert.equal(init.headers.get(name), null);
      return new Response('synthetic', { headers: { 'set-cookie': 'authjs.session-token=hostile' } });
    });
    assert.equal(await response.text(), 'synthetic'); assert.equal(response.headers.get('set-cookie'), null);
  }
  for (const path of ['/database/%252e%252e/private','/database/%2fprivate','/database/wrong%5cpath']) assert.equal((await proxyDatabaseDestination(req(path), () => assert.fail('no upstream request'))).status, 400);
  assert.equal((await proxyDatabaseDestination(req(), async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.invalid' } }))).status, 502);
});

test('route orchestration never calls viewer on denial or development bypass', async () => {
  const ts = (await import('typescript')).default;
  const source = readFileSync(new URL('../lib/databaseViewerRoute.ts', import.meta.url), 'utf8').replace(/^import .*;$/gm, '');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  let viewerCalls = 0;
  let tokenReads = 0;
  const env = { DATABASE_VIEWER_OWNER_USER_ID: '71', NEXTAUTH_SECRET: 'synthetic-test-secret' };
  const authorize = (request, settings) => authorizeDatabaseOwner(request, { ...settings, fetcher: async () => Response.json(user) });
  new Function('exports', 'process', 'getToken', 'readCookieNames', 'resolveSessionCookieSecurity', 'authorizeDatabaseOwner', 'proxyDatabaseDestination', compiled)(exports, { env }, async () => { tokenReads++; return { accessToken: 'synthetic' }; }, () => [], () => true, authorize, async () => { viewerCalls++; return new Response('viewer'); });
  const route = exports.protectedDatabaseDestination;
  env.DATABASE_VIEWER_OWNER_USER_ID = '';
  assert.equal((await route(req())).status, 503);
  assert.equal(tokenReads, 0); assert.equal(viewerCalls, 0);
  env.DATABASE_VIEWER_OWNER_USER_ID = '72';
  assert.equal((await route(req())).status, 403); assert.equal(viewerCalls, 0);
  env.DATABASE_VIEWER_OWNER_USER_ID = '71';
  env.NEXT_PUBLIC_DISABLE_AUTH = 'true';
  assert.equal((await route(req())).status, 401); assert.equal(viewerCalls, 0);
  delete env.NEXT_PUBLIC_DISABLE_AUTH;
  delete env.NEXTAUTH_SECRET;
  assert.equal((await route(req())).status, 401); assert.equal(viewerCalls, 0);
  env.NEXTAUTH_SECRET = 'synthetic-test-secret';
  assert.equal((await route(req('/database/query', 'POST'))).status, 405); assert.equal(viewerCalls, 0);
  assert.equal(await (await route(req('/database/assets/file'))).text(), 'viewer');
  assert.equal(viewerCalls, 1);
});

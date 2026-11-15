// Actual caller bodies and installed JWT decoding, isolated from auth config/network.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import * as nodeCrypto from 'node:crypto';
import ts from 'typescript';
import {encode, getToken} from '@auth/core/jwt';
import {getToken as nextAuthGetToken} from 'next-auth/jwt';
import {NextRequest, NextResponse} from 'next/server.js';

const secret = 'synthetic-audit9-boundary-signing-sentinel';
const access = 'synthetic-audit9-access-sentinel';
const env = {NODE_ENV: 'production', NEXTAUTH_SECRET: secret, AUTH_SECRET: secret,
  NEXTAUTH_URL: 'https://app.invalid', BACKEND_API_URL: 'https://backend.invalid', DATABASE_VIEWER_OWNER_USER_ID: '7'};
function compile(relative, dependencies = {}, extras = {}) {
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
  const exports = {};
  new Function('exports', 'require', 'process', 'console', 'fetch', code)(exports,
    name => {assert.ok(name in dependencies, `unexpected import ${name}`); return dependencies[name];},
    {env}, extras.console ?? {warn() {}, error() {}}, extras.fetch ?? (() => assert.fail('external fetch forbidden')));
  return exports;
}
function harness() {
  const calls = {backend: 0, viewer: 0, transport: 0, logs: []};
  const helpers = compile('../lib/authSessionCookie.ts');
  const logger = {warn: (...args) => calls.logs.push(args), error: (...args) => calls.logs.push(args)};
  class RuntimeError extends Error {}
  class DeadlineError extends Error {}
  const transport = {
    ApiOriginCircuitBreaker: class {}, ApiTransportDeadlineError: DeadlineError,
    executeBoundedApiRequest: async options => {
      calls.transport++;
      return {response: {body: '{"synthetic":true}', status: 200, headers: new Headers()}};
    },
  };
  const session = compile('../app/api/bullpen-ai/_lib/serverBackendSession.ts', {
    'node:crypto': nodeCrypto, '@auth/core/jwt': {getToken}, 'next/server': {NextResponse},
    '@/auth': {resolveNextAuthSecret: () => secret, unstable_update: () => assert.fail('no session update')},
    '@/lib/authSessionCookie': helpers, '@/lib/boundedApiTransport': transport,
    '@/lib/singleFlight': {SingleFlightByKey: class {}},
    './backendBullpenRuntime': {BackendRuntimeHttpError: RuntimeError, fetchBackendRuntimeJson: () => assert.fail('no refresh/dispatch')},
  }, {console: logger});
  const proxy = compile('../proxy.ts', {
    'next-auth/jwt': {getToken: nextAuthGetToken}, '@/lib/authRedirect': compile('../lib/authRedirect.ts'),
    '@/lib/authSessionCookie': helpers, 'next/server': {NextResponse},
  }, {console: logger});
  const owner = compile('../lib/databaseViewerOwner.ts');
  const database = compile('../lib/databaseViewerRoute.ts', {
    '@auth/core/jwt': {getToken}, './authSessionCookie': helpers,
    './databaseViewerOwner': {authorizeDatabaseOwner: (request, options) => owner.authorizeDatabaseOwner(request, {
      ...options, fetcher: async () => {calls.backend++; return Response.json({id: 7, is_active: true});},
    })},
    './databaseViewerProxy': {proxyDatabaseDestination: async () => {calls.viewer++; return new Response('synthetic-viewer');}},
  });
  const bff = compile('../app/backend-api/[...path]/route.ts', {
    'next/server': {NextResponse}, '@/lib/boundedApiTransport': transport,
    '@/app/api/bullpen-ai/_lib/serverBackendSession': session,
    '@/app/api/bullpen-ai/_lib/backendBullpenRuntime': {BackendRuntimeHttpError: RuntimeError},
  }, {console: logger});
  return {calls, session, proxy, database, bff};
}
async function cookie({secure = true, expired = false, chunked = false} = {}) {
  const name = `${secure ? '__Secure-' : ''}authjs.session-token`;
  const value = await encode({secret, salt: name, maxAge: expired ? -120 : 3600,
    token: {sub: '7', accessToken: access, refreshToken: 'synthetic-refresh', accessTokenExpiresAt: Date.now() + 3600000}});
  const middle = Math.floor(value.length / 2);
  return chunked ? `${name}.1=${value.slice(middle)}; ${name}.0=${value.slice(0, middle)}` : `${name}=${value}`;
}
const cases = [
  {name: 'malformed Bearer without cookie', headers: {authorization: 'Bearer %'}, allowed: false, databaseStatus: 503},
  {name: 'invalid secure cookie chunks', headers: {cookie: '__Secure-authjs.session-token.0=synthetic-invalid; __Secure-authjs.session-token.1=invalid'}, allowed: false, databaseStatus: 401},
  {name: 'expired secure chunked cookie', headers: {cookie: await cookie({expired: true, chunked: true})}, allowed: false, databaseStatus: 401},
  {name: 'valid secure cookie precedes malformed Bearer', headers: {cookie: await cookie(), authorization: 'Bearer %'}, allowed: true},
  {name: 'valid secure chunks precede malformed Bearer', headers: {cookie: await cookie({chunked: true}), authorization: 'Bearer %'}, allowed: true},
  {name: 'valid plain cookie remains compatible', headers: {cookie: await cookie({secure: false})}, allowed: true},
];

test('installed library early malformed-Bearer throw is exercised', async () => {
  await assert.rejects(() => getToken({req: new Request('https://app.invalid', {headers: {authorization: 'Bearer %'}}), secret}), URIError);
});
for (const fixture of cases) {
  test(`session context and protected BFF: ${fixture.name}`, async () => {
    const h = harness();
    const request = () => new NextRequest('https://app.invalid/backend-api/auth/me', {headers: fixture.headers});
    const context = await h.session.createBackendSessionContext(request());
    assert.equal(context.hasAuthJsSession, fixture.allowed);
    assert.equal(context.accessToken, fixture.allowed ? access : null);
    if (!fixture.allowed) assert.equal(context.refreshToken, null);
    const response = await h.bff.GET(request(), {params: Promise.resolve({path: ['auth', 'me']})});
    assert.equal(response.status, fixture.allowed ? 200 : 401);
    assert.equal(h.calls.transport, fixture.allowed ? 1 : 0);
    assert.equal(h.calls.backend, 0);
    assert.equal(h.calls.viewer, 0);
    for (const log of h.calls.logs) assert.ok(!String(log).includes(access) && !String(log).includes('synthetic-refresh'));
  });
  test(`protected page proxy: ${fixture.name}`, async () => {
    const h = harness();
    const response = await h.proxy.proxy(new NextRequest('https://app.invalid/console/dashboard', {headers: fixture.headers}));
    if (fixture.allowed) {assert.equal(response.status, 200); assert.equal(response.headers.get('x-middleware-next'), '1');}
    else {assert.equal(response.status, 307); assert.equal(new URL(response.headers.get('location')).pathname, '/login');}
    assert.deepEqual([h.calls.backend, h.calls.viewer, h.calls.transport], [0, 0, 0]);
  });
  test(`database owner outer catch: ${fixture.name}`, async () => {
    const h = harness();
    const response = await h.database.protectedDatabaseDestination(new Request('https://app.invalid/database', {headers: fixture.headers}));
    assert.equal(response.status, fixture.allowed ? 200 : fixture.databaseStatus);
    assert.equal(h.calls.backend, fixture.allowed ? 1 : 0);
    assert.equal(h.calls.viewer, fixture.allowed ? 1 : 0);
    assert.equal(h.calls.transport, 0);
    if (!fixture.allowed) assert.equal(response.headers.get('cache-control'), 'no-store');
  });
}

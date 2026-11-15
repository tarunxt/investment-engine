import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { defaultCookies } from '../node_modules/@auth/core/lib/utils/cookie.js';
import { createCSRFToken, validateCSRF } from '../node_modules/@auth/core/lib/actions/callback/oauth/csrf-token.js';

function configuration(production) {
  const source = readFileSync(new URL('../next.config.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022} }).outputText;
  const exports = {};
  new Function('exports', 'process', code)(exports, {env: {NODE_ENV: production ? 'production' : 'development'}});
  return exports.default;
}

test('actual Next header configuration emits synthetic production policy values', async () => {
  const config = configuration(true);
  const rules = await config.headers();
  assert.equal(rules[0].source, '/:path*');
  const headers = Object.fromEntries(rules[0].headers.map(({key, value}) => [key, value]));
  assert.equal(headers['X-Frame-Options'], 'DENY');
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['Strict-Transport-Security'], 'max-age=63072000; includeSubDomains; preload');
  const csp = headers['Content-Security-Policy'];
  for (const directive of ["frame-ancestors 'none'", "object-src 'none'", "script-src 'self' 'unsafe-inline' 'unsafe-eval'", "style-src 'self' 'unsafe-inline'", 'https://accounts.google.com/gsi/client']) assert.ok(csp.includes(directive));
  assert.equal(config.poweredByHeader, false);
  assert.equal((await configuration(false).headers())[0].headers.some(h => h.key === 'Strict-Transport-Security'), false);
});

test('installed Auth.js session and CSRF cookies use Lax HttpOnly with secure production family', () => {
  for (const secure of [true, false]) {
    const cookies = defaultCookies(secure);
    for (const key of ['sessionToken', 'csrfToken']) {
      assert.equal(cookies[key].options.sameSite, 'lax');
      assert.equal(cookies[key].options.httpOnly, true);
      assert.equal(cookies[key].options.secure, secure);
    }
  }
});

test('installed Auth.js double-submit rejects absent/mismatched tokens and permits matching synthetic POST', async () => {
  const options = {secret: 'synthetic-audit9-csrf-sentinel'};
  const initial = await createCSRFToken({options, isPost: false});
  for (const [cookieValue, bodyValue, isPost, expected] of [
    [initial.cookie, initial.csrfToken, true, true],
    [initial.cookie, 'synthetic-mismatch', true, false],
    [undefined, initial.csrfToken, true, false],
    [initial.cookie, initial.csrfToken, false, false],
    ['synthetic-forged|synthetic-hash', 'synthetic-forged', true, false],
  ]) {
    const result = await createCSRFToken({options, cookieValue, bodyValue, isPost});
    assert.equal(Boolean(result.csrfTokenVerified), expected);
    if (expected) assert.doesNotThrow(() => validateCSRF('callback', result.csrfTokenVerified));
    else assert.throws(() => validateCSRF('callback', result.csrfTokenVerified), /CSRF/);
  }
});

test('actual BFF handler has no independent origin gate when synthetic session is supplied', async () => {
  const {NextRequest, NextResponse} = await import('next/server.js');
  const source = readFileSync(new URL('../app/backend-api/[...path]/route.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
  const exports = {};
  const calls = [];
  const requireMock = name => {
    if (name === 'next/server') return {NextResponse};
    if (name.includes('boundedApiTransport')) return {
      ApiOriginCircuitBreaker: class {}, ApiTransportDeadlineError: class extends Error {},
      executeBoundedApiRequest: async options => {
        calls.push(options.method);
        return {response: {body: '{"synthetic":true}', status: 200, headers: new Headers()}};
      },
    };
    if (name.includes('serverBackendSession')) return {
      createBackendSessionContext: async () => ({accessToken: 'synthetic-session-sentinel'}),
      rotateBackendTokens: () => assert.fail('no refresh'),
    };
    if (name.includes('backendBullpenRuntime')) return {BackendRuntimeHttpError: class extends Error {}};
    throw new Error(`Unexpected dependency ${name}`);
  };
  new Function('exports', 'require', 'process', 'fetch', code)(exports, requireMock,
    {env: {BACKEND_API_URL: 'https://backend.invalid'}}, () => assert.fail('no network dispatch'));
  for (const origin of ['https://app.invalid', 'https://cross-site.invalid']) {
    const request = new NextRequest('https://app.invalid/backend-api/jobs', {
      method: 'POST', body: 'synthetic=1', headers: {origin, 'content-type': 'application/x-www-form-urlencoded'},
    });
    const response = await exports.POST(request, {params: Promise.resolve({path: ['jobs']})});
    assert.equal(response.status, 200);
  }
  assert.deepEqual(calls, ['POST', 'POST']);
});

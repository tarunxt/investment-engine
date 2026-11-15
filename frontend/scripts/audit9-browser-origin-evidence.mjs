// Isolated native-browser SameSite/BFF evidence; every backend response is mocked.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {encode} from '@auth/core/jwt';
import {chromium} from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const secret = 'synthetic-audit9-browser-signing-sentinel';
const access = 'synthetic-audit9-server-access-sentinel';
const calls = [];
const listen = async server => {
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  return server.address().port;
};
const close = server => server.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
const backend = createServer((request, response) => {
  calls.push({method: request.method, path: request.url, authorization: request.headers.authorization, cookie: request.headers.cookie});
  response.writeHead(200, {'content-type': 'application/json'});
  response.end(JSON.stringify({authenticated: true}));
});
const backendPort = await listen(backend);
const probe = createServer();
const appPort = await listen(probe);
await close(probe);
const app = `http://127.0.0.1:${appPort}`;
const attacker = createServer((_request, response) => {
  response.writeHead(200, {'content-type': 'text/html'});
  response.end(`<a id="get" href="${app}/backend-api/auth/me">Synthetic navigation</a><form method="post" action="${app}/backend-api/privacy-fixture"><input name="synthetic" value="1"><button>Submit synthetic fixture</button></form>`);
});
const attackerPort = await listen(attacker);
// localhost and 127.0.0.1 are different browser sites; both resolve only locally.
const crossSite = `http://localhost:${attackerPort}`;
const child = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'start', '-p', String(appPort)], {
  cwd: root, env: {PATH: process.env.PATH, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
    NEXTAUTH_SECRET: secret, AUTH_SECRET: secret, NEXTAUTH_URL: app, NEXT_PUBLIC_FRONTEND_URL: app,
    NEXT_PUBLIC_DISABLE_AUTH: 'false', BACKEND_API_URL: `http://127.0.0.1:${backendPort}`, NEXT_PUBLIC_API_URL: `http://127.0.0.1:${backendPort}`},
  stdio: ['ignore', 'pipe', 'pipe'],
});
let startup = '';
child.stdout.on('data', chunk => {startup += chunk;});
child.stderr.on('data', chunk => {startup += chunk;});
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Synthetic Next startup exited ${child.exitCode}: ${startup}`);
    try {if ((await fetch(`${app}/api/auth/session`)).ok) {ready = true; break;}} catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'isolated production frontend ready');
  browser = await chromium.launch({executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox']});
  const context = await browser.newContext();
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort();
  });
  const value = await encode({secret, salt: 'authjs.session-token', token: {
    sub: '7', accessToken: access, refreshToken: 'synthetic-refresh-sentinel', accessTokenExpiresAt: Date.now() + 3600000,
  }});
  await context.addCookies([{name: 'authjs.session-token', value, url: app, sameSite: 'Lax', httpOnly: true, secure: false}]);
  const page = await context.newPage();
  await page.goto(`${app}/backend-api/auth/me`);
  assert.equal(JSON.parse(await page.textContent('body')).authenticated, true);
  assert.equal(calls.at(-1).authorization, `Bearer ${access}`);
  assert.equal(calls.at(-1).cookie, undefined, 'application session cookie is not forwarded');

  const same = await page.evaluate(async () => (await fetch('/backend-api/privacy-fixture', {method: 'POST', body: 'synthetic=1'})).status);
  assert.equal(same, 200);
  assert.equal(calls.at(-1).method, 'POST');

  await page.goto(crossSite);
  const beforeCrossFetch = calls.length;
  const crossResult = await page.evaluate(async target => {
    try {return String((await fetch(target, {method: 'POST', credentials: 'include', headers: {'content-type': 'application/x-www-form-urlencoded'}, body: 'synthetic=1'})).status);} catch {return 'blocked';}
  }, `${app}/backend-api/privacy-fixture`);
  assert.equal(crossResult, 'blocked');
  assert.equal(calls.length, beforeCrossFetch, 'cross-site fetch never reaches mocked backend');

  await Promise.all([page.waitForURL(`${app}/backend-api/privacy-fixture`), page.click('button')]);
  assert.match(await page.textContent('body'), /Not authenticated/);
  assert.equal(calls.length, beforeCrossFetch, 'Lax excludes cookie from cross-site form POST');

  await page.goto(crossSite);
  await Promise.all([page.waitForURL(`${app}/backend-api/auth/me`), page.click('#get')]);
  assert.equal(JSON.parse(await page.textContent('body')).authenticated, true);
  assert.equal(calls.at(-1).authorization, `Bearer ${access}`);
  assert.equal(calls.at(-1).method, 'GET');
  const session = await page.evaluate(async () => (await fetch('/api/auth/session')).text());
  assert.ok(!session.includes(access) && !session.includes('synthetic-refresh-sentinel'));
  console.log(JSON.stringify({cases: 5, passed: 5, failed: 0, skipped: 0,
    checks: ['same-origin server-token transport', 'same-origin POST', 'cross-site fetch denied without backend dispatch', 'cross-site form POST denied without backend dispatch', 'Lax top-level GET allowed and browser session omits provider tokens'],
    chromium: browser.version(), scope: 'loopback synthetic production Next fixture; explicit Lax nonsecure HTTP cookie only'}));
  await context.close();
} finally {
  if (browser) await browser.close();
  const stopped = child.exitCode === null && child.signalCode === null ? once(child, 'exit') : Promise.resolve();
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await Promise.allSettled([stopped, close(backend), close(attacker)]);
}

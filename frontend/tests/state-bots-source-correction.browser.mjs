import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
const require = createRequire(import.meta.url);
const { build } = require(process.env.STATE_BOTS_ESBUILD_PATH || 'esbuild');
const out = resolve('../docs/evidence/state-bots-source-correction');
mkdirSync(out, { recursive: true });
const result = await build({ entryPoints: ['tests/fixtures/state-bots/correction.jsx'], bundle: true, write: false, define: {'process.env': '{}'}, jsx: 'automatic', tsconfig: 'tsconfig.json', plugins: [{ name: 'isolated-components', setup(b) {
  b.onLoad({ filter: /TradingBotsOverviewPage\.tsx$/ }, args => ({ contents: readFileSync(args.path, 'utf8') + '\nexport { TradingBotCard };', loader: 'tsx' }));
  b.onLoad({ filter: /services\/api\.ts$/ }, () => ({ contents: `export const apiService = new Proxy({}, { get: (_, name) => (...args) => { (window.__fixtureApiCalls ??= []).push(String(name)); if (window.__fixtureName === "overview") return new Promise((resolve,reject) => window.__rejectReads.push(() => reject(new Error("Synthetic source unavailable")))); return Promise.reject(new Error("Synthetic source unavailable: " + String(name))); } }); export class APIError extends Error {} export class RequestTimeoutError extends Error {}`, loader: 'js' }));
  b.onLoad({ filter: /UniversalPolymarketScan\.tsx$/ }, () => ({ contents: 'export const UniversalPolymarketScan = () => null;', loader: 'js' }));
  b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'navigation', namespace: 'mock' }));
  b.onResolve({ filter: /^next\/dynamic$/ }, () => ({ path: 'dynamic', namespace: 'mock' }));
  b.onResolve({ filter: /hooks\/useAuth$/ }, () => ({ path: 'auth', namespace: 'mock' }));
  b.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: args.path === 'auth' ? 'export const useAuth = () => ({user: null, loading: true});' : args.path === 'navigation' ? 'export const useRouter = () => ({push() {}, replace() {}}); export const useSearchParams = () => new URLSearchParams();' : 'import React from "react"; export default function dynamic(loader) { const C = React.lazy(() => loader().then(defaultExport => ({default: defaultExport}))); return props => React.createElement(React.Suspense, {fallback: null}, React.createElement(C, props)); }' , loader: 'js', resolveDir: process.cwd() }));
  b.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'link', namespace: 'fixture' }));
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'import React from "react";export default function Link({children, ...props}) {return React.createElement("a", props, children)}', loader: 'js', resolveDir: process.cwd() }));
} }] });
const css = await postcss([tailwind()]).process(readFileSync('app/globals.css', 'utf8'), { from: resolve('app/globals.css') });
const server = createServer((req,res) => { res.setHeader('Content-Type', req.url === '/bundle.js' ? 'application/javascript' : 'text/html'); res.end(req.url === '/bundle.js' ? result.outputFiles[0].text : `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css.css}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1180, height: 757 }, deviceScaleFactor: 1 });
const errors = [], blocked = [];
page.on('pageerror', e => { errors.push(e.message); console.error(e.stack); });
await page.route('**/*', route => {
  const url = new URL(route.request().url());
  if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ positions: [], liveAvailable: false, error: 'Synthetic unavailable positions fixture' }) });
  return route.request().url().startsWith(`http://127.0.0.1:${server.address().port}/`) ? route.continue() : (blocked.push(route.request().url()), route.abort());
});

const evidence = [];
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/?fixture=overview#overview`);
  await page.waitForFunction(() => window.__rejectReads?.length === 3);
  await page.getByRole('button', {name: 'Details', exact: true}).first().click();
  assert.match(await page.locator('body').innerText(), /Loading latest trading bot status in the background/);
  await page.evaluate(() => window.__rejectReads.forEach(reject => reject()));
  await page.getByText('Current trading bot status is unavailable. No current source snapshot was returned.', {exact: true}).first().waitFor();
  assert.doesNotMatch(await page.locator('body').innerText(), /Loading latest trading bot status in the background/);
  await page.screenshot({path: `${out}/overview-failed-after-loading.png`, fullPage: true});
  evidence.push({fixture: 'failed-after-loading', text: await page.locator('body').innerText(), calls: await page.evaluate(() => window.__fixtureApiCalls ?? [])});
  for (const fixture of ['failed', 'zero', 'cached']) {
    await page.evaluate(async () => { localStorage.clear(); await new Promise(resolve => { const request = indexedDB.deleteDatabase('investment-engine-bullpen-ai'); request.onsuccess = request.onerror = request.onblocked = resolve; }); });
    await page.goto(`http://127.0.0.1:${server.address().port}/?fixture=${fixture}#${fixture}`);
    await page.getByText('Total Events Scanned:', {exact: false}).last().waitFor();
    if (fixture === 'failed') await page.getByText('Event results unknown.', {exact: false}).waitFor();
    else await page.getByText('Saved snapshot ·', {exact: false}).last().waitFor();
    const text = await page.locator('body').innerText();
    assert.doesNotMatch(text, /No auto scan results yet|Run Scans and Invest Now above|No auto-run result yet|Not run yet|Not started/);
    if (fixture === 'failed') {
      assert.match(text, /Total Events Scanned: —/);
      assert.match(text, /Events that passed Filters: —/);
      assert.match(text, /Run history unknown/);
      await page.getByRole('button', {name: 'Open LLM completion diagnostics, including selected targets, failures, and captured errors', exact: true}).click();
      await page.getByRole('dialog', {name: 'Stage 2 LLM diagnostics'}).waitFor();
      const diagnostics = await page.getByRole('dialog').innerText();
      assert.match(diagnostics, /completion, runtime and position counts are unknown/);
      assert.doesNotMatch(diagnostics, /0 unique rows|0\/0|Not started|0 completed|Active Positions: 0/);
      await page.screenshot({path: `${out}/failed-diagnostics.png`, fullPage: false});
      assert.equal(await page.getByRole('button', {name:'Close LLM run details'}).evaluate(el => el === document.activeElement), true);
      await page.keyboard.press('Tab');
      assert.equal(await page.getByRole('button', {name:'Close LLM run details'}).evaluate(el => el === document.activeElement), true);
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({state: 'hidden'});
      assert.match(await page.evaluate(() => document.activeElement.getAttribute('aria-label') || ''), /Open LLM completion diagnostics/);
    } else {
      assert.match(text, fixture === 'zero' ? /Total Events Scanned: 0/ : /Total Events Scanned: 12/);
      assert.match(text, /Events that passed Filters: 0/);
      assert.match(text, /Saved snapshot/);
    }
    await page.screenshot({path: `${out}/bullpen-${fixture}.png`, fullPage: true});
    evidence.push({fixture, text, calls: await page.evaluate(() => window.__fixtureApiCalls ?? [])});
  }
  await page.evaluate(async () => { localStorage.clear(); await new Promise(resolve => { const request = indexedDB.deleteDatabase('investment-engine-bullpen-ai'); request.onsuccess = request.onerror = request.onblocked = resolve; }); });
  await page.setViewportSize({width: 390, height: 844});
  await page.goto(`http://127.0.0.1:${server.address().port}/?fixture=failed#failed`);
  await page.getByText('Event results unknown.', {exact: false}).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({path: `${out}/bullpen-failed-narrow.png`, fullPage: true});
  evidence.push({fixture:'failed-narrow', text: await page.locator('body').innerText(), calls: await page.evaluate(() => window.__fixtureApiCalls ?? [])});
  await page.getByRole('button', {name:'Open LLM completion diagnostics, including selected targets, failures, and captured errors', exact: true}).click();
  await page.getByRole('dialog', {name:'Stage 2 LLM diagnostics'}).waitFor();
  await page.screenshot({path: `${out}/failed-diagnostics-narrow.png`, fullPage:false});
  await page.keyboard.press('Escape');
  await page.setViewportSize({width:1180, height:757});
  await page.goto(`http://127.0.0.1:${server.address().port}/?fixture=saved-diagnostics#saved-diagnostics`);
  await page.getByText('LLM ran on 0 unique rows', {exact: true}).waitFor();
  const savedDiagnostics = await page.getByTestId('stage-two-llm-run-dialog').innerText();
  assert.match(savedDiagnostics, /synthetic-saved-run/);
  assert.doesNotMatch(savedDiagnostics, /Stage 2 evidence unknown/);
  await page.screenshot({path: `${out}/cached-zero-diagnostics.png`, fullPage: false});
  evidence.push({fixture: 'cached-zero-diagnostics', text: savedDiagnostics});
  const calls = evidence.flatMap(item => item.calls ?? []);
  assert.ok(calls.length > 3, 'full fixtures must exercise the synthetic passive read failures');
  assert.ok(calls.every(name => name.startsWith('get') || name === 'polymarketState'), JSON.stringify(calls));
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  writeFileSync(`${out}/result.json`, JSON.stringify({timestamp: new Date().toISOString(), viewport:'1180x757 at 100%', narrow:'390x844', calls, errors, blocked, evidence}, null, 2));
  console.log('PASS: actual overview failed-after-loading; full Bullpen failed, verified zero, cached; diagnostics Escape, narrow; no operational calls');
} finally { await browser.close(); server.close(); }

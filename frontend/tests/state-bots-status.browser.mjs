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
const out = resolve('../docs/evidence/state-bots-unknown-zero');
mkdirSync(out, { recursive: true });
const result = await build({ entryPoints: ['tests/fixtures/state-bots/entry.jsx'], bundle: true, write: false, jsx: 'automatic', tsconfig: 'tsconfig.json', plugins: [{ name: 'isolated-components', setup(b) {
  b.onLoad({ filter: /TradingBotsOverviewPage\.tsx$/ }, args => ({ contents: readFileSync(args.path, 'utf8') + '\nexport { TradingBotCard };', loader: 'tsx' }));
  b.onLoad({ filter: /services\/api\.ts$/ }, () => ({ contents: 'export const apiService = new Proxy({}, { get: (_, name) => async () => { (window.__fixtureApiCalls ??= []).push(String(name)); if (name === "polymarketState" && ["success-zero", "populated", "stale-response"].includes(window.__fixtureName)) return { read_source: "runtime", mode: "paper", open_positions: window.__fixtureName === "populated" ? [{shares: 2, cost_basis: 3}] : [], live: { balance: {status: "error"}, redeemed_trades: [], pending_confirmations: [], live_trades_today: 0 } }; throw new Error("Synthetic unavailable read: " + String(name)) } }); export class APIError extends Error {} export class RequestTimeoutError extends Error {}', loader: 'js' }));
  b.onLoad({ filter: /UniversalPolymarketScan\.tsx$/ }, () => ({ contents: 'export const UniversalPolymarketScan = () => null;', loader: 'js' }));
  b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'navigation', namespace: 'mock' }));
  b.onResolve({ filter: /^next\/dynamic$/ }, () => ({ path: 'dynamic', namespace: 'mock' }));
  b.onResolve({ filter: /hooks\/useAuth$/ }, () => ({ path: 'auth', namespace: 'mock' }));
  b.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: args.path === 'auth' ? 'export const useAuth = () => ({user: null, loading: true});' : args.path === 'navigation' ? 'export const useRouter = () => ({push() {}, replace() {}}); export const useSearchParams = () => new URLSearchParams();' : 'export default () => () => null;', loader: 'js' }));
  b.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'link', namespace: 'fixture' }));
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'import React from "react";export default function Link({children, ...props}) {return React.createElement("a", props, children)}', loader: 'js', resolveDir: process.cwd() }));
} }] });
const css = await postcss([tailwind()]).process(readFileSync('app/globals.css', 'utf8'), { from: resolve('app/globals.css') });
const server = createServer((req,res) => { res.setHeader('Content-Type', req.url === '/bundle.js' ? 'application/javascript' : 'text/html'); res.end(req.url === '/bundle.js' ? result.outputFiles[0].text : `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css.css}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1180, height: 757 }, deviceScaleFactor: 1 });
const errors = [], blocked = [];
page.on('pageerror', e => errors.push(e.message));
await page.route('**/*', route => {
  const url = new URL(route.request().url());
  if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ positions: [], liveAvailable: false, error: 'Synthetic unavailable positions fixture' }) });
  return route.request().url().startsWith(`http://127.0.0.1:${server.address().port}/`) ? route.continue() : (blocked.push(route.request().url()), route.abort());
});
const evidence = [];
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  for (const name of ['loading', 'success-zero', 'populated', 'failed', 'partial', 'stale-response', 'queued', 'running']) {
    await page.getByRole('button', { name, exact: true }).click();
    await page.getByRole('status').filter({ hasText: `Fixture: ${name}` }).waitFor();
    await page.getByRole('region', { name: 'Actual Bullpen schedule' }).getByText('Refreshing', { exact: true }).waitFor({state: 'hidden'});
    const text = await page.locator('main').innerText();
    const schedule = await page.getByRole('region', { name: 'Actual Bullpen schedule' }).innerText();
    if (!['success-zero', 'populated', 'stale-response'].includes(name)) assert.match(schedule, /Unknown · source unavailable/);
    else assert.match(schedule, /ACTIVE POSITIONS\n(?:0|1)\n/);
    assert.match(schedule, /Unknown · no run evidence/);
    assert.doesNotMatch(schedule, /Scan coverage\n0 \/ 0/);
    assert.match(schedule, /queue and execution status are unknown/);
    if (['loading', 'failed', 'partial'].includes(name)) assert.match(text, /Bots running: Unknown/);
    if (name === 'success-zero') assert.match(text, /Bots running: 0/);
    if (name === 'stale-response') assert.match(text, /Cached \/ saved snapshot/);
    if (!['queued', 'running'].includes(name)) assert.match(text, /queue and execution status are unknown/);
    await page.screenshot({ path: `${out}/desktop-${name}.png`, fullPage: true });
    if (name === 'failed' || name === 'success-zero') {
      await page.getByRole('region', {name: 'Actual Bullpen schedule'}).locator('.bg-gradient-to-br').first().screenshot({path: `${out}/portfolio-${name}.png`});
      await page.getByTestId('bullpen-stage-one-filters').screenshot({path: `${out}/stage-one-${name}.png`});
    }
    evidence.push({ fixture: name, text });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'stale-response', exact: true }).click();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'narrow layout must not overflow');
  await page.screenshot({ path: `${out}/narrow-stale.png`, fullPage: true });
  await page.getByRole('button', { name: 'failed', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('status').filter({ hasText: 'Fixture: failed' }).waitFor();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'partial');
  await page.getByRole('button', { name: 'Details', exact: true }).focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.getByRole('button', { name: 'Details', exact: true }).getAttribute('aria-expanded'), 'true');
  await page.screenshot({ path: `${out}/narrow-keyboard-details.png`, fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'expanded narrow layout must not overflow');
  assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Details');
  const fixtureApiCalls = await page.evaluate(() => window.__fixtureApiCalls ?? []);
  assert.ok(fixtureApiCalls.every(name => name.startsWith('get') || name === 'polymarketState'), 'fixtures may only attempt passive getters');
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  writeFileSync(`${out}/browser-result.json`, JSON.stringify({ timestamp: new Date().toISOString(), viewport: '1180x757 @ deviceScaleFactor=1, browser zoom 100%', narrow: '390x844', keyboard: 'Enter changes fixture, Tab retains ordered focus, Enter expands actual card Details without operational calls', requestsToOperationalAPIs: 0, fixtureApiCalls, errors, evidence }, null, 2));
  console.log('PASS: 8 actual-card fixtures, desktop, narrow, keyboard; no operational requests');
} finally { await browser.close(); server.close(); }

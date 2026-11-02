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
const workspaceProfile = process.env.STATE_BOTS_WORKSPACE_PROFILE || 'bullpen007';
assert.ok(['bullpen007', 'bullpen-sports'].includes(workspaceProfile));
const out = resolve(process.env.STATE_BOTS_EVIDENCE_DIR || '/tmp/bullpen-amount-modal');
mkdirSync(out, { recursive: true });
const result = await build({ entryPoints: ['tests/fixtures/state-bots/correction.jsx'], bundle: true, write: false, define: {'process.env': '{}'}, jsx: 'automatic', tsconfig: 'tsconfig.json', plugins: [{ name: 'isolated-components', setup(b) {
  // Isolated evidence must not inherit account identifiers from product defaults.
  b.onLoad({ filter: /BullpenAiPageClient\.tsx$/ }, args => ({ contents: readFileSync(args.path, 'utf8')
    .replace(/const BULLPEN_ACCOUNT_USERNAME = [\s\S]*?;/, 'const BULLPEN_ACCOUNT_USERNAME = "synthetic-account";')
    .replace(/const BULLPEN_ACCOUNT_WALLET_FALLBACK =\s*[\s\S]*?;/, 'const BULLPEN_ACCOUNT_WALLET_FALLBACK = "synthetic-wallet";'), loader: 'tsx' }));
  b.onLoad({ filter: /BullpenAutoRunScheduleCard\.tsx$/ }, args => ({ contents: readFileSync(args.path, 'utf8') + '\nexport { StageOneOutputDialog, buildRunDetailScanCandidateDialogState };', loader: 'tsx' }));
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
  for (const fixture of ['failed', 'zero', 'cached']) {
    for (const width of [1180, 390]) {
      await page.setViewportSize({width,height:844});
      await page.goto(`http://127.0.0.1:${server.address().port}/?workspace=${workspaceProfile}#${fixture}`);
      const opener = page.getByRole('button', {name:'Show trade amount formula',exact:true});
      await opener.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', {name:'Trade amount formula',exact:true});
      await dialog.waitFor();
      assert.equal(await dialog.getAttribute('aria-modal'), 'true');
      const close = dialog.getByRole('button', {name:'Close trade amount formula',exact:true});
      assert.equal(await close.evaluate(el => el === document.activeElement), true);
      const content = await dialog.innerText();
      assert.match(content, /Current amount/i);
      assert.match(content, /Waiting for Bullpen cash in hand and occupied-slot data/);
      assert.match(content, /The trade amount will appear here after Bullpen cash in hand/);
      for (const key of ['Tab', 'Shift+Tab', 'Tab']) {
        await page.keyboard.press(key);
        assert.equal(await close.evaluate(el => el === document.activeElement), true);
      }
      const bounds = await close.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({path:`${out}/${workspaceProfile}-${fixture}-${width}.png`,fullPage:false});
      await page.keyboard.press('Escape');
      await dialog.waitFor({state:'hidden'});
      assert.equal(await opener.evaluate(el => el === document.activeElement), true);
      await page.keyboard.press('Enter');
      await dialog.waitFor();
      await close.click();
      await dialog.waitFor({state:'hidden'});
      assert.equal(await opener.evaluate(el => el === document.activeElement), true);
      // Reopening must restore the same formula text and remain dismissible.
      await opener.click();
      await dialog.waitFor();
      assert.equal(await dialog.innerText(), content);
      await page.keyboard.press('Escape');
      await dialog.waitFor({state:'hidden'});
      assert.equal(await opener.evaluate(el => el === document.activeElement), true);
      const calls = await page.evaluate(() => window.__fixtureApiCalls ?? []);
      assert.ok(calls.every(name => name.startsWith('get') || name === 'polymarketState'));
      evidence.push({fixture,width,content,calls});
    }
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  writeFileSync(`${out}/result.json`,JSON.stringify({workspaceProfile,evidence,errors,blocked},null,2));
  console.log(`PASS: ${workspaceProfile} amount formula dialog; 3 source fixtures x 2 widths; Enter, Tab/Shift+Tab, Escape, Close, reopening, focus return; no operational calls`);
} finally {await browser.close();server.close();}

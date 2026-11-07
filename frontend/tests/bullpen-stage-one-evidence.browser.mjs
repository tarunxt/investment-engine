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
const out = resolve(process.env.STATE_BOTS_EVIDENCE_DIR || '/workspace/a6-06-evidence/browser');
mkdirSync(out, { recursive: true });
const result = await build({ entryPoints: ['tests/fixtures/stage-one-evidence.jsx'], bundle: true, write: false, define: {'process.env': '{}'}, jsx: 'automatic', tsconfig: 'tsconfig.json', plugins: [{ name: 'isolated-components', setup(b) {
  // Isolated evidence must not inherit account identifiers from product defaults.
  b.onLoad({ filter: /BullpenAiPageClient\.tsx$/ }, args => ({ contents: readFileSync(args.path, 'utf8')
    .replace(/const BULLPEN_ACCOUNT_USERNAME = [\s\S]*?;/, 'const BULLPEN_ACCOUNT_USERNAME = "synthetic-account";')
    .replace(/const BULLPEN_ACCOUNT_WALLET_FALLBACK =\s*[\s\S]*?;/, 'const BULLPEN_ACCOUNT_WALLET_FALLBACK = "synthetic-wallet";'), loader: 'tsx' }));
  b.onLoad({ filter: /BullpenAutoRunScheduleCard\.tsx$/ }, args => ({ contents: readFileSync(args.path, 'utf8') + '\nexport { StageOneOutputDialog, buildRunDetailScanCandidateDialogState };', loader: 'tsx' }));
  b.onLoad({ filter: /TradingBotsOverviewPage\.tsx$/ }, args => ({ contents: readFileSync(args.path, 'utf8') + '\nexport { TradingBotCard };', loader: 'tsx' }));
  b.onLoad({ filter: /services\/api\.ts$/ }, () => ({ contents: `export const apiService = new Proxy({}, { get: (_, name) => () => { (window.__calls ??= []).push(String(name)); throw Error('Blocked API '+String(name)); } }); export class APIError extends Error {} export class RequestTimeoutError extends Error {}`, loader:'js' }));
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

const evidence=[];
try {
for(const profile of ['bullpen007','bullpen-sports']) for(const width of [1180,390]) for(const mode of ['missing','loading','positive','empty','failed','partial','stale','missing-arrays']) {
 await page.setViewportSize({width,height:844});await page.goto(`http://127.0.0.1:${server.address().port}/?workspace=${profile}&mode=${mode}`);
 const opener=page.getByRole('button',{name:'Stage 1 details',exact:true});await opener.focus();await page.keyboard.press('Enter');const dialog=page.getByRole('dialog',{name:'Stage 1 output',exact:true});await dialog.waitFor();assert.ok(await dialog.evaluate(n=>n.contains(document.activeElement)));
 const text=await dialog.innerText();for(const section of ['Available for Claim','Active Bullpen positions found','Fresh Bullpen Opportunities'])assert.ok(text.toLowerCase().includes(section.toLowerCase()), text);
 if(mode==='empty'){assert.match(text,/contains no active positions/);assert.match(text,/returned no opportunity candidates/);}else if(mode==='positive'){assert.match(text,/Positions \(3\)/);assert.match(text,/saved-run/);}else{assert.match(text,/Positions \(Unknown\)/);assert.doesNotMatch(text,/These live wallet positions were synced|Latest Bullpen Scan Stage 1 completed at/);if(mode!=='stale')assert.match(text,/Opportunity candidates are unknown/);}
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 const close=dialog.getByRole('button',{name:'Close Stage 1 output',exact:true});await close.focus();await page.keyboard.press('Tab');assert.ok(await dialog.evaluate(n=>n.contains(document.activeElement)));await page.keyboard.press('Shift+Tab');assert.ok(await dialog.evaluate(n=>n.contains(document.activeElement)));await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});assert.equal(await opener.evaluate(n=>n===document.activeElement),true);
 await opener.click();await dialog.waitFor();await close.click();await dialog.waitFor({state:'hidden'});assert.equal(await opener.evaluate(n=>n===document.activeElement),true);evidence.push({profile,width,mode});
}
assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);assert.deepEqual(await page.evaluate(()=>window.__calls??[]),[]);writeFileSync(out+'/result.json',JSON.stringify({result:'PASS',cases:evidence.length,evidence,errors,blocked},null,2));console.log('PASS '+evidence.length+' actual Stage1 dialog cases; synthetic sources only; no operations');
}finally{await browser.close();server.close();}

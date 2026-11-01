// Offline A6-02 contract fixture: real pages/history component, synthetic reads only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(path.join(tmpdir(), 'a6-02-fixture-'));
const evidence = process.env.A6_02_EVIDENCE || path.join(tmpdir(), 'a6-02-evidence');
const baseline = process.env.A6_02_BASELINE;
let browser, server;
const cases = [];
try {
  await mkdir(evidence, { recursive: true });
  const aliases = {
    'next/link$': path.join(temp, 'link.tsx'),
    'next/navigation$': path.join(temp, 'navigation.ts'),
    '@/services/api$': path.join(temp, 'api.ts'),
    '@/hooks/useUsdInrRate$': path.join(temp, 'fx.ts'),
    '@/hooks/useHistoricalAnalysisCosts$': path.join(temp, 'costs.ts'),
    '@/components/shared/EventScanRunControls$': path.join(temp, 'controls.tsx'),
    '@/components/shared/EventCalendarTable$': path.join(temp, 'table.tsx'),
    '@/components/shared/MarkdownRenderer$': path.join(temp, 'markdown.tsx'),
    '@': root,
  };
  const sources = ['app/console/zerodha/events/page.tsx', 'app/console/indmoney-us/events/page.tsx', 'app/console/indmoney-us/threats/page.tsx', 'components/shared/ScanHistoryButton.tsx'];
  if (baseline) {
    for (const [i, source] of sources.entries()) {
      await writeFile(path.join(temp, `baseline-${i}.tsx`), execFileSync('git', ['show', `${baseline}:frontend/${source}`], { cwd: root }));
      aliases[`@/${source.replace(/\.tsx$/, '')}$`] = path.join(temp, `baseline-${i}.tsx`);
    }
    // Relative threat report imports resolve from the source page's directory.
    aliases['../../zerodha/threats/_components/ThreatsReportTable$'] = path.join(root, 'app/console/zerodha/threats/_components/ThreatsReportTable.tsx');
    aliases['../../zerodha/threats/_components/ThreatsSummaryCards$'] = path.join(root, 'app/console/zerodha/threats/_components/ThreatsSummaryCards.tsx');
  }
  delete aliases['@'];
  aliases['@'] = root;
  await writeFile(path.join(temp, 'api.ts'), `
export class APIError extends Error {}
window.reads=[]; window.paths=[];
export const apiService=new Proxy({}, {get:(_,name)=>(...args)=>{
 if(!/Latest$|History$|Overview$|Status$/.test(String(name))) throw new Error('Forbidden API '+String(name));
 return new Promise((resolve,reject)=>window.reads.push({name,args,resolve,reject,done:false}));
}});
window.settle=(name,value,error)=>{const read=window.reads.find(r=>r.name===name&&!r.done);if(!read)throw new Error('No pending read '+name);read.done=true;error?read.reject(new APIError(error)):read.resolve(value);};`);
  await writeFile(path.join(temp, 'fx.ts'), 'export const useUsdInrRate=()=>80;');
  await writeFile(path.join(temp, 'costs.ts'), 'export const useHistoricalAnalysisCosts=()=>({});');
  await writeFile(path.join(temp, 'navigation.ts'), 'export const useRouter=()=>({push:path=>window.paths.push(path)});');
  await writeFile(path.join(temp, 'link.tsx'), `import React from 'react';export default function Link({children,...props}){return <a {...props}>{children}</a>;}`);
  await writeFile(path.join(temp, 'controls.tsx'), `import React from 'react';export function EventScanRunControls({disabled}){return <button disabled={disabled}>Run fixture scan</button>;}`);
  await writeFile(path.join(temp, 'table.tsx'), `import React from 'react';export function EventCalendarTable({table}){return <div>Saved table: {table.raw_markdown}</div>;}`);
  await writeFile(path.join(temp, 'markdown.tsx'), `import React from 'react';export default function Markdown({content}){return <pre>{content}</pre>;}`);
  await writeFile(path.join(temp, 'entry.tsx'), `import React from 'react';import {createRoot} from 'react-dom/client';
import India from '@/app/console/zerodha/events/page';import Events from '@/app/console/indmoney-us/events/page';import Threats from '@/app/console/indmoney-us/threats/page';import {ScanHistoryButton} from '@/components/shared/ScanHistoryButton';import {apiService} from '@/services/api';
const loadHistory=()=>apiService.fixtureHistory().then(r=>r.history);const target=new URLSearchParams(location.search).get('target');
const root=createRoot(document.getElementById('root'));window.unmount=()=>root.unmount();
root.render(target==='history'?<div role="dialog" aria-label="Fixture parent"><ScanHistoryButton title="Fixture scan history" emptyMessage="Verified empty history" usdInrRate={80} loadHistory={loadHistory}/></div>:target==='india'?<India/>:target==='events'?<Events/>:<Threats/>);`);
  await writeFile(path.join(temp, 'loader.cjs'), `const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(s){return ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022},fileName:this.resourcePath}).outputText;}`);
  const { webpack } = require('next/dist/compiled/webpack/webpack');
  await new Promise((resolve, reject) => webpack({ mode: 'development', devtool: false, entry: path.join(temp, 'entry.tsx'), output: { path: temp, filename: 'bundle.js' }, resolve: { extensions: ['.tsx', '.ts', '.js'], modules: [path.join(root, 'node_modules')], alias: aliases }, module: { rules: [{ test: /\.tsx?$/, use: path.join(temp, 'loader.cjs') }] }, plugins: [new webpack.DefinePlugin({ 'process.env.NODE_ENV': JSON.stringify('development') })] }, (error, stats) => error || stats.hasErrors() ? reject(error || Error(stats.toString({ all: false, errors: true }))) : resolve()));
  const css = (await require('postcss')([require('@tailwindcss/postcss')({ base: root })]).process('@import "tailwindcss";', { from: path.join(root, 'app/globals.css') })).css;
  const bundle = await readFile(path.join(temp, 'bundle.js'));
  server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/bundle.js' ? 'text/javascript' : req.url === '/style.css' ? 'text/css' : 'text/html');
    res.end(req.url === '/bundle.js' ? bundle : req.url === '/style.css' ? css : '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/bundle.js"></script>');
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const external = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : (external.push(route.request().url()), route.abort()));
  const text = () => page.locator('body').innerText();
  const settle = (name, value, error) => page.evaluate(({ name, value, error }) => window.settle(name, value, error), { name, value, error });
  const open = async target => { await page.goto(`${origin}/?target=${target}`); await page.waitForFunction(() => window.reads); };
  const check = async (id, fn) => { await fn(); cases.push(id); console.log('PASS', id); };
  const snapshot = { snapshot_date: '2026-01-02', captured_at: '2026-01-02T12:00:00Z', current_value: 123.45, holdings_market_value: 123.45, holdings_pnl: 1.25, total_return_value: 1.25, holdings_count: 0, parse_status: 'parsed', holdings: [] };
  const saved = { job_id: 9001, status: 'completed', provider: 'synthetic', model: 'fixture', created_at: '2026-01-02T12:00:00Z', updated_at: '2026-01-02T12:01:00Z', snapshot_date: '2026-01-02', estimated_cost: 0.125, table: { rows: [{}], raw_markdown: 'SYNTHETIC SAVED OUTPUT' }, report: { summary: { main_portfolio_risk: 'SYNTHETIC SAVED RISK' }, tables: [], bottom_line: [], raw_markdown: 'SYNTHETIC SAVED OUTPUT' } };
  for (const width of [1180, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const target of process.env.A6_02_HISTORY_ONLY ? [] : ['india', 'events', 'threats']) {
      const prefix = target === 'india' ? 'zerodha' : 'indmoneyUs';
      const stage = target === 'threats' ? 'Threats' : 'Events';
      const start = async () => { await open(target); await page.waitForFunction(() => window.reads.length >= 2); if (target === 'india') await settle('zerodhaStatus', {}); };
      await check(`${target}-${width}-portfolio-timeout-preserves-independent-output`, async () => {
        await start();
        assert.match(await text(), /Loading/);
        await settle(`${prefix}PortfolioOverview`, null, 'Timeout (synthetic)');
        await page.getByText(/Snapshot availability unknown/).waitFor();
        assert.match(await text(), /Saved analysis availability unknown/);
        assert.doesNotMatch(await text(), /No .*snapshot found|No .*scan has been run/);
        await settle(`${prefix}${stage}Latest`, { analysis: saved });
        await page.getByText('SYNTHETIC SAVED OUTPUT', { exact: true }).first().waitFor({ state: 'attached' });
        assert.doesNotMatch(await text(), /Saved analysis availability unknown|No .*snapshot found/);
        if (target === 'threats') await page.getByText('SYNTHETIC SAVED RISK', { exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: 'Run fixture scan' }).isDisabled(), true);
        await page.screenshot({ path: path.join(evidence, `${target}-portfolio-timeout-${width}.png`), fullPage: true });
      });
      await check(`${target}-${width}-latest-502-preserves-independent-snapshot`, async () => {
        await start();
        await settle(`${prefix}PortfolioOverview`, { latest: snapshot, history: [] });
        await settle(`${prefix}${stage}Latest`, null, 'HTTP 502 (synthetic)');
        await page.getByText(/Saved analysis availability unknown/).waitFor();
        assert.doesNotMatch(await text(), /No .*scan has been run|Snapshot availability unknown/);
        assert.match(await text(), /2026/);
        assert.equal(await page.getByRole('button', { name: 'Run fixture scan' }).isDisabled(), false);
      });
      await check(`${target}-${width}-successful-empty-and-populated-recovery`, async () => {
        await start();
        await settle(`${prefix}PortfolioOverview`, { latest: null, history: [] });
        await settle(`${prefix}${stage}Latest`, { analysis: null });
        await page.getByText(/No .*snapshot found|No synced Zerodha portfolio found/).waitFor();
        assert.doesNotMatch(await text(), /availability unknown/);
        await start();
        await settle(`${prefix}PortfolioOverview`, { latest: snapshot, history: [] });
        await settle(`${prefix}${stage}Latest`, { analysis: null });
        await page.getByText(/No .*scan has been run yet/).waitFor();
        assert.doesNotMatch(await text(), /availability unknown/);
        await start();
        await settle(`${prefix}PortfolioOverview`, { latest: snapshot, history: [] });
        await settle(`${prefix}${stage}Latest`, { analysis: saved });
        await page.getByText('SYNTHETIC SAVED OUTPUT', { exact: true }).first().waitFor({ state: 'attached' });
        assert.doesNotMatch(await text(), /availability unknown|No .*scan has been run/);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      });
    }
    if (!process.env.A6_02_HISTORY_ONLY) await check(`india-${width}-status-failure-does-not-discard-snapshot`, async () => {
      await open('india'); await page.waitForFunction(() => window.reads.length === 3);
      await settle('zerodhaStatus', null, 'HTTP 502 (synthetic status only)');
      await settle('zerodhaPortfolioOverview', { latest: snapshot, history: [] });
      await settle('zerodhaEventsLatest', { analysis: saved });
      await page.getByText('SYNTHETIC SAVED OUTPUT', { exact: true }).first().waitFor({ state: 'attached' });
      assert.doesNotMatch(await text(), /Snapshot availability unknown|No .*snapshot found/);
    });
    await check(`history-${width}-loading-timeout-502-empty-populated-retained-and-recovery`, async () => {
      await open('history');
      await page.getByRole('button', { name: 'Fixture scan history', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Fixture scan history', exact: true });
      assert.match(await dialog.innerText(), /Runs: loading/);
      assert.match(await dialog.innerText(), /Total known cost: Loading/);
      assert.doesNotMatch(await dialog.innerText(), /0 runs|Verified empty history/);
      await settle('fixtureHistory', null, 'Timeout (synthetic)');
      await page.getByText('Timeout (synthetic)', { exact: true }).waitFor();
      assert.match(await dialog.innerText(), /Runs: unknown/);
      assert.match(await dialog.innerText(), /Total known cost: Unknown/);
      assert.doesNotMatch(await dialog.innerText(), /0 runs|Verified empty history/);
      const refresh = page.getByRole('button', { name: 'Refresh scan history' });
      await refresh.click(); await settle('fixtureHistory', null, 'HTTP 502 (synthetic)');
      await page.getByText('HTTP 502 (synthetic)', { exact: true }).waitFor();
      assert.match(await dialog.innerText(), /Runs: unknown/);
      await page.screenshot({ path: path.join(evidence, `history-failed-${width}.png`) });
      await refresh.focus(); await page.keyboard.press('Enter');
      await settle('fixtureHistory', { history: [] });
      await page.getByText('Verified empty history', { exact: true }).waitFor();
      assert.match(await dialog.innerText(), /0 runs/);
      assert.match(await dialog.innerText(), /Total known cost: ₹0\.00/);
      await refresh.click(); await settle('fixtureHistory', null, 'HTTP 502 (synthetic cached empty)');
      await page.getByText('HTTP 502 (synthetic cached empty)').waitFor();
      assert.doesNotMatch(await dialog.innerText(), /0 runs|Verified empty history/);
      const rows = Array.from({ length: 81 }, (_, i) => ({ ...saved, job_id: 9001 + i, run_id: i === 0 ? 8001 : null, estimated_cost: i === 0 ? 0.125 : i === 1 ? 0 : null }));
      await refresh.click(); await settle('fixtureHistory', { history: rows });
      await page.getByText('81 runs', { exact: true }).waitFor();
      assert.match(await dialog.innerText(), /Total known cost: ₹10\.00/);
      assert.equal(await dialog.getByRole('button', { name: /Open details/ }).count(), 81);
      assert.match(await dialog.innerText(), /Not captured/);
      await refresh.click();
      assert.match(await dialog.innerText(), /Runs: loading/);
      assert.match(await dialog.innerText(), /Previously loaded history retained/);
      await settle('fixtureHistory', null, 'Timeout (synthetic retained)');
      await page.getByText('Timeout (synthetic retained)', { exact: true }).waitFor();
      assert.match(await dialog.innerText(), /Runs: unknown/);
      assert.equal(await dialog.getByRole('button', { name: /Open details/ }).count(), 81);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.join(evidence, `history-retained-${width}.png`) });
      await refresh.click(); await settle('fixtureHistory', { history: rows });
      await page.getByText('81 runs', { exact: true }).waitFor();
      await dialog.getByRole('button', { name: 'Open details for run #8001', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.paths), ['/console/runs/8001']);
      await page.getByRole('button', { name: 'Fixture scan history', exact: true }).click();
      await settle('fixtureHistory', { history: rows });
      await page.getByText('81 runs', { exact: true }).waitFor();
      await dialog.getByRole('button', { name: 'Open details for job #9002', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.paths), ['/console/runs/8001', '/console/jobs/9002']);
    });
    await check(`history-${width}-interrupted-reopen-stale-result-escape-unmount`, async () => {
      await open('history');
      const trigger = page.getByRole('button', { name: 'Fixture scan history', exact: true });
      await trigger.click();
      await page.getByRole('button', { name: 'Close scan history' }).focus();
      await page.keyboard.press('Enter');
      await trigger.click();
      await page.waitForFunction(() => window.reads.length === 2);
      await page.evaluate(() => { window.reads[1].done = true; window.reads[1].resolve({ history: [] }); });
      await page.getByText('Verified empty history', { exact: true }).waitFor();
      await settle('fixtureHistory', { history: [saved] });
      assert.match(await text(), /0 runs/);
      assert.doesNotMatch(await text(), /1 runs/);
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('dialog', { name: 'Fixture scan history', exact: true }).count(), 0);
      assert.equal(await page.getByRole('dialog', { name: 'Fixture parent', exact: true }).count(), 1);
      assert.equal(await page.evaluate(() => document.body.style.overflow), '');
      await trigger.click();
      await page.evaluate(() => window.unmount());
      await settle('fixtureHistory', null, 'HTTP 502 (synthetic unmounted)');
    });
  }
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ baseline: baseline || null, cases, passed: cases.length, externalRequests: external, pageErrors: errors, viewports: [1180, 390], note: 'Only synthetic fixture screenshots. No live runtime or report screenshot visual review.' }, null, 2));
  console.log(`PASS ${cases.length} A6-02 offline browser scenarios; no external requests or page errors.`);
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}

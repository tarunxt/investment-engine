// Actual bridge, saved-reader and modal; all APIs are synthetic, and external requests are blocked.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(path.join(os.tmpdir(), 'audit1-detail-scope-'));
const out = process.env.A1_SCOPE_EVIDENCE || '/tmp/audit1-detail-scope-evidence'; await mkdir(out, { recursive: true });
const entry = `import React from 'react';import{createRoot}from'react-dom/client';import{AutomatedRebalanceReliabilityBridge}from'${root}/app/console/automated-rebalance/_components/AutomatedRebalanceReliabilityBridge';
const stages=['threats','swing'];createRoot(document.getElementById('root')).render(<AutomatedRebalanceReliabilityBridge><main><h1>Saved workflow fixture</h1>{stages.map(stage=><button key={stage} aria-label={'Open '+stage+' detail'} data-auto-rebalance-llm-metric='true' data-workflow-stage={stage} data-workflow-portfolio='india' data-workflow-total='1'>LLMs completed: 1/1 (Passed:1)</button>)}<a href='#background'>Background</a></main></AutomatedRebalanceReliabilityBridge>);`;
await writeFile(temp + '/api.ts', `
const call=(name,args)=>{window.calls.push({name,args});};
const job=id=>({id,provider:'synthetic-provider',model:'synthetic-model',status:'completed',prompt:'Historical threat context does not prove membership',response:'Saved synthetic output',estimated_cost:0,created_at:'2020-01-01T00:00:00Z',updated_at:'2020-01-01T00:01:00Z',output_provenance:{source:'api_usage_attempt_events',identities:[{provider:'synthetic-provider',model:'synthetic-model'}],observed_from:'2020-01-01T00:00:00Z',observed_to:'2020-01-01T00:01:00Z'}});
function detail(mode){const d={portfolio:'india',sequence:213,label:'India Run #213',stages:[{stage:'threats',job_id:2266,run_id:null,provider_count:1},{stage:'swing',run_id:464,provider_count:1},{stage:'rebalance',run_id:465,provider_count:1},{stage:'technical',run_id:466,provider_count:1}],runs:[464,465,466].map((id,i)=>({id,prompt:'Historical threat context',jobs:[job(2267+i)]})),standalone_jobs:[job(2266)]};
if(mode==='partial'){d.standalone_jobs[0].status='partial';d.standalone_jobs[0].estimated_cost=null;d.standalone_jobs[0].error_message='Retained partial warning';}
if(mode==='empty'){d.stages[0].job_id=null;d.standalone_jobs=[];}
if(mode==='missing'){d.standalone_jobs=[];}
if(mode==='conflict'){d.stages[0].job_id=2267;}
return d;}
const api={async getAutoRebalanceHistory(...args){call('getAutoRebalanceHistory',args);if(window.mode==='failure')throw Error('Synthetic saved source unavailable');return{items:[detail(window.mode)]};},async getAutoRebalanceHistoryDetail(...args){call('getAutoRebalanceHistoryDetail',args);const mode=window.mode;const data=detail(mode);if(mode==='failure')throw Error('Synthetic saved source unavailable');if(mode==='loading'||mode==='interrupted'&&window.detailCalls++===0)return new Promise(resolve=>window.releases.push(()=>resolve(data)));return data;},async zerodhaThreatsLatest(){call('zerodhaThreatsLatest',[]);throw Error('Synthetic unavailable fallback');},async indmoneyUsThreatsLatest(){call('indmoneyUsThreatsLatest',[]);throw Error('Synthetic unavailable fallback');},async getRuns(){call('getRuns',[]);throw Error('Synthetic unavailable fallback');}};
export const apiService=new Proxy(api,{get(t,key){if(key in t)return t[key];return(...args)=>{window.blockedOperations.push(String(key));throw Error('Blocked operation '+String(key));};}});
`);
await writeFile(temp + '/owner.ts', 'export const captureWorkflowOwner=()=>({synthetic:true});export const requireWorkflowOwner=o=>o;export const onWorkflowOwnerInvalidated=()=>()=>{};');
const js = (await build({ stdin: { contents: entry, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, jsx: 'automatic', alias: { '@': root, '@/services/api': temp + '/api.ts', '@/lib/workflowOwnerLifetime': temp + '/owner.ts' }, define: { 'process.env': '{}', 'process.env.NODE_ENV': '"development"' } })).outputFiles[0].text;
const css = (await postcss([tailwind({ base: root })]).process(await readFile(root + '/app/globals.css', 'utf8'), { from: root + '/app/globals.css' })).css;
const server = createServer((req, res) => { res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript' : 'text/html'); res.end(req.url === '/fixture.js' ? js : `<!doctype html><meta name='viewport' content='width=device-width,initial-scale=1'><style>${css}</style><div id='root'></div><script>window.mode=new URLSearchParams(location.search).get('case')||'success';window.calls=[];window.releases=[];window.detailCalls=0;window.blockedOperations=[];window.fetch=()=>{window.blockedOperations.push('fetch');throw Error('No real API calls');};</script><script src='/fixture.js'></script>`); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage(); const errors = [], external = [], cases = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : (external.push(route.request().url()), route.abort()));
async function open(stage = 'threats') { const opener = page.getByRole('button', { name: 'Open ' + stage + ' detail', exact: true }); await opener.focus(); await page.keyboard.press('Enter'); const dialog = page.getByRole('dialog', { name: stage === 'threats' ? 'Threats Scan LLM details' : 'Swing Scan LLM details', exact: true }); await dialog.waitFor(); assert.ok(await dialog.evaluate(n => n.contains(document.activeElement))); return { dialog, opener }; }
async function close(dialog, opener) { await dialog.getByRole('button', { name: 'Close LLM details', exact: true }).focus(); await page.keyboard.press('Tab'); assert.ok(await dialog.evaluate(n => n.contains(document.activeElement))); await page.keyboard.press('Shift+Tab'); assert.ok(await dialog.evaluate(n => n.contains(document.activeElement))); await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' }); assert.equal(await opener.evaluate(n => n === document.activeElement), true); }
try {
  for (const width of [1180, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const mode of ['success', 'partial', 'empty', 'missing', 'conflict', 'loading', 'failure']) {
      await page.goto(origin + '/console/zerodha?case=' + mode + '#india-workflow'); const { dialog, opener } = await open();
      await dialog.getByText('Opener stage summary: LLMs completed: 1/1 (Passed:1)', { exact: true }).waitFor();
      if (mode === 'loading') {
        await dialog.getByText('Loading LLM details…', { exact: true }).waitFor(); assert.equal(await dialog.locator('tbody tr').count(), 0);
        await page.evaluate(() => releases.splice(0).forEach(resolve => resolve())); await dialog.getByText('Job #2266', { exact: true }).waitFor();
      } else if (mode === 'failure') { await dialog.getByText('Synthetic saved source unavailable', { exact: true }).waitFor(); assert.equal(await dialog.locator('tbody tr').count(), 0); }
      else if (mode === 'empty' || mode === 'missing') {
        await dialog.getByText('This saved-source lookup returned no model-level records.', { exact: true }).waitFor(); assert.equal(await dialog.locator('tbody tr').count(), 0);
        assert.match(await dialog.innerText(), mode === 'empty' ? /No saved run\/job link/ : /Job #2266/);
        assert.equal(await page.evaluate(() => calls.some(c => /Latest|getRuns/.test(c.name))), false, 'valid empty/missing stage never substitutes unrelated fallback records');
      } else {
        const id = mode === 'conflict' ? 2267 : 2266; await dialog.getByText('Job #' + id, { exact: true }).waitFor(); assert.equal(await dialog.locator('tbody tr').count(), 1);
        assert.match(await dialog.innerText(), /1 saved job record returned · 1 complete\/partial statuses · 0 failed/);
        const row = dialog.locator('tbody tr'); assert.match(await row.innerText(), mode === 'conflict' ? /Unknown/ : /Threats Scan/);
        if (mode !== 'conflict') { assert.match(await row.innerText(), /Run: Unknown \(standalone saved job\)/); assert.doesNotMatch(await row.innerText(), /Run #213/); }
        if (mode === 'partial') { assert.match(await row.innerText(), /Retained partial warning/); assert.match(await row.innerText(), /Not available/); } else if (mode === 'success') assert.match(await row.innerText(), /\$0\.0000/);
        assert.match(await row.innerText(), /2020-01-01T00:01:00Z/);
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: out + '/' + mode + '-' + width + '.png' });
      await close(dialog, opener); cases.push({ width, mode });
    }
    await page.goto(origin + '/console/zerodha?case=interrupted'); let view = await open(); await page.waitForFunction(() => releases.length === 1);
    await page.locator('[data-workflow-stage="swing"]').evaluate(n => n.click()); const swing = page.getByRole('dialog', { name: 'Swing Scan LLM details', exact: true }); await swing.getByText('Job #2267', { exact: true }).waitFor();
    await page.evaluate(() => releases.splice(0).forEach(resolve => resolve())); await page.waitForTimeout(100); assert.equal(await swing.getByText('Job #2266', { exact: true }).count(), 0);
    await close(swing, view.opener); cases.push({ width, mode: 'interrupted response cannot overwrite current stage' });
    await page.goto(origin + '/console/zerodha?case=success'); view = await open(); await view.dialog.getByText('Job #2266', { exact: true }).waitFor();
    await page.evaluate(() => { mode = 'failure'; document.querySelector('[data-workflow-stage="swing"]').click(); }); const failed = page.getByRole('dialog', { name: 'Swing Scan LLM details', exact: true }); await failed.getByText('Synthetic saved source unavailable', { exact: true }).waitFor();
    assert.equal(await failed.locator('tbody tr').count(), 0); assert.match(await failed.innerText(), /previous saved source is not verified/i); assert.doesNotMatch(await failed.innerText(), /1 saved job record returned/);
    await close(failed, view.opener); cases.push({ width, mode: 'stale prior source never presented as current' });
    await page.evaluate(() => { mode = 'success'; }); view = await open(); await view.dialog.getByText('Job #2266', { exact: true }).waitFor(); await view.dialog.getByRole('button', { name: 'Close LLM details', exact: true }).click(); await view.dialog.waitFor({ state: 'hidden' }); assert.equal(await view.opener.evaluate(n => n === document.activeElement), true); cases.push({ width, mode: 'reopen and explicit Close' });
    assert.deepEqual(await page.evaluate(() => blockedOperations), []);
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  await writeFile(out + '/results.json', JSON.stringify({ finding: 'JOURNEY-AUTO-DETAIL-SCOPE', cases, errors, external, writes: 0, actualNetworkApiCalls: 0 }, null, 2));
  console.log(JSON.stringify({ result: 'PASS', cases: cases.length, coverage: 'live-shaped explicit stage links, loading/success/empty/missing/failure/partial/conflict/stale, interrupted/repeated navigation, initial focus/Tab/Escape/Close/opener,1180/390', writes: 0, actualNetworkApiCalls: 0 }));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }

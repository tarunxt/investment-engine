/** Offline acceptance: actual Mails page, mocked reads and mutations, no backend. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = process.env.MAIL_PREFS_SOURCE_ROOT || frontend;
const temporary = await mkdtemp(path.join(tmpdir(), 'mail-prefs-fixture-'));
let browser, server;
try {
  await writeFile(path.join(temporary, 'entry.tsx'), `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import MailsPage from ${JSON.stringify(path.join(sourceRoot, 'app/console/apis/_components/LlmUsageBreakdown.tsx'))};
    window.reads=[]; window.mutations=[];
    window.fetch=()=>new Promise((resolve,reject)=>window.reads.push({resolve,reject}));
    // StrictMode creates an obsolete first request: the test settles it last.
    createRoot(document.getElementById('root')).render(<MailsPage/>);
  `);
  await writeFile(path.join(temporary, 'loader.cjs'), `const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(s){return ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020},fileName:this.resourcePath}).outputText;};`);
  const w = require('next/dist/compiled/webpack/webpack');
  await new Promise((resolve, reject) => w.webpack({
    mode: 'development', devtool: false, entry: path.join(temporary, 'entry.tsx'),
    output: { path: temporary, filename: 'bundle.js' },
    resolve: { extensions: ['.tsx', '.ts', '.js'], modules: [path.join(frontend, 'node_modules')], alias: { '@': sourceRoot } },
    module: { rules: [{ test: /\.tsx?$/, use: path.join(temporary, 'loader.cjs') }] },
    plugins: [new w.webpack.DefinePlugin({ 'process.env': JSON.stringify({ NODE_ENV: 'development' }) })],
  }, (error, stats) => error ? reject(error) : stats.hasErrors() ? reject(new Error(stats.toString({ all: false, errors: true }))) : resolve()));
  const bundle = await readFile(path.join(temporary, 'bundle.js'));
  server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/bundle.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
    res.end(req.url === '/bundle.js' ? bundle : '<!doctype html><title>Offline accounting fixture</title><style>body{font:14px sans-serif;max-width:1000px;margin:auto}button{padding:8px;margin:4px}svg{width:18px;height:18px}section{padding:12px;border:1px solid #ddd}button:disabled{opacity:.5}</style><div id="root"></div><script src="/bundle.js"></script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, serviceWorkers: 'block' });
  const external = [], errors = [];
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });

  const region = page.getByRole('region', {name: 'Daily LLM usage'});
  await page.goto(origin);
  await page.waitForFunction(() => window.reads.length === 1);
  assert.match(await region.textContent(), /Loading/);
  await page.evaluate(() => window.reads[0].resolve(new Response(JSON.stringify({detail:'Synthetic read failure'}), {status:503})));
  await region.getByRole('alert').waitFor();
  const refresh = region.getByRole('button', {name:'Refresh', exact:true});
  await refresh.focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.reads.length === 2);
  await page.evaluate(() => {
    const day = document.querySelector('input[type=date]').value;
    const row = {provider:'deepseek',provider_name:'DeepSeek',model:'fixture',source:'bullpen',source_label:'Bullpen',workflow:'Synthetic workflow',requests:1,tokens_in:100,tokens_out:10,estimated_cost:.125,estimated_cost_inr:null,measurement:'estimated'};
    const runs = ['estimated','actual','reconciled'].map((measurement,index)=>({...row,measurement,run_label:'Synthetic run '+index,run_number:index+1,job_id:index+1,status:'failed',timestamp:day+'T06:00:00Z'}));
    window.reads[1].resolve(new Response(JSON.stringify({timezone:'Asia/Kolkata',from_date:day,to_date:day,usd_inr_rate:null,fx_status:'stale',items:[row],runs,coverage_note:'Synthetic coverage unknown; hidden retries unknown'}),{status:200}));
  });
  await region.getByText('Tariff estimate',{exact:true}).waitFor();
  await region.getByText('Provider day total · settlement unknown',{exact:true}).waitFor();
  await region.getByText('Allocated provider day total',{exact:true}).waitFor();
  assert.equal(await region.getByText('Actual',{exact:true}).count(),0);
  await page.setViewportSize({width:375,height:900});
  await refresh.focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.reads.length === 3);
  await page.evaluate(() => window.reads[2].reject(new TypeError('Synthetic network failure')));
  await region.getByRole('alert').waitFor();
  assert.match(await region.textContent(),/previously loaded usage/);
  await region.getByText('Tariff estimate',{exact:true}).waitFor();
  assert.equal(external.length,0); assert.equal(errors.length,0);
  console.log('PASS: actual breakdown component loading, error, keyboard retry, estimate/provider/allocation labels, nullable FX and stale retention at 375px; zero external requests.');
} finally {
  await browser?.close();
  await new Promise(resolve => server ? server.close(resolve) : resolve());
  await rm(temporary,{recursive:true,force:true});
}

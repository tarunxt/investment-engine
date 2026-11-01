// Exercise the real report with local fixtures only; no providers or API writes.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';

const require = createRequire(import.meta.url);
const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(path.join(os.tmpdir(), 'llm-report-'));
const output = process.env.LLM_SCREENSHOT_DIR || '/tmp/llm-report-evidence';
await mkdir(output, { recursive: true });
await writeFile(path.join(temp, 'entry.tsx'), `import React from 'react';import {createRoot} from 'react-dom/client';import Page from '${frontend}/app/console/llms/page';createRoot(document.getElementById('root')).render(<Page/>);`);
await writeFile(path.join(temp, 'api.ts'), `export const apiService={getLlmPerformance:()=>new Promise((resolve,reject)=>window.requests.push({resolve,reject}))};`);
await writeFile(path.join(temp, 'fx.ts'), 'export const useUsdInrRate=()=>0;');
await writeFile(path.join(temp, 'loader.cjs'), `const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(s){return ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020},fileName:this.resourcePath}).outputText}`);
const w = require('next/dist/compiled/webpack/webpack');
await new Promise((resolve, reject) => w.webpack({mode:'development',devtool:false,entry:path.join(temp,'entry.tsx'),output:{path:temp,filename:'bundle.js'},resolve:{extensions:['.tsx','.ts','.js'],modules:[path.join(frontend,'node_modules')],alias:{'@/services/api$':path.join(temp,'api.ts'),'@/hooks/useUsdInrRate$':path.join(temp,'fx.ts'),'@':frontend}},module:{rules:[{test:/\.tsx?$/,use:path.join(temp,'loader.cjs')}]},plugins:[new w.webpack.DefinePlugin({'process.env':JSON.stringify({NODE_ENV:'development'})})]},(error,stats)=>error?reject(error):stats.hasErrors()?reject(Error(stats.toString({all:false,errors:true}))):resolve()));
const css = (await postcss([tailwind({base:frontend})]).process(await readFile(path.join(frontend,'app/globals.css'),'utf8'),{from:path.join(frontend,'app/globals.css')})).css;
const bundle = await readFile(path.join(temp,'bundle.js'));
const server = createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'text/javascript; charset=utf-8':'text/html; charset=utf-8');res.end(req.url==='/bundle.js'?bundle:`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}body{font-family:Arial}</style><div id="root"></div><script>window.requests=[]</script><script src="/bundle.js"></script>`)});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
const page = await browser.newPage();
const errors = [];
page.on('pageerror',e=>errors.push(e.message));
await page.route('**/*',r=>r.request().url().startsWith(base)?r.continue():r.abort());
const settle = async (index,data,fail=false)=>page.evaluate(({index,data,fail})=>window.requests[index][fail?'reject':'resolve'](fail?Error(data):data),{index,data,fail});
const empty = {total_llms:0,total_scans:0,generated_at:'2026-11-01T03:00:00Z',groups:[]};
const fixture = {...empty,total_llms:1,total_scans:1,groups:[{provider:'Fixture',model:'Test model',llm_key:'fixture',total_scans:1,processing_passed:0,processing_failed:0,sheet_export_failed:0,total_cost:0,scan_summaries:[{scan_type:'Test scan',total_scans:1,processing_passed:0,processing_failed:0,sheet_export_passed:0,sheet_export_failed:0,avg_time_taken_ms:null,total_cost:0}],scans:[{job_id:17,scan_type:'Test scan',created_at:'2026-11-01T02:00:00Z',updated_at:'2026-11-01T02:01:00Z',processing_passed:null,sheet_export_passed:null,estimated_cost:null,error_message:'Fixture pending evidence'}]}]};
try {
  for (const width of [1180,390]) {
    await page.setViewportSize({width,height:757});
    await page.goto(base);
    await page.getByRole('status').waitFor();
    const overview=page.getByRole('region',{name:'Report overview',exact:true});
    assert.equal(await overview.getByRole('heading',{name:'LLM Performance',exact:true}).count(),1);
    assert.equal(await overview.getByText('LLMs',{exact:true}).count(),1);
    for(const text of ['LLMs used','Total scans','Generated']) assert.equal(await overview.getByText(text,{exact:true}).count(),1);
    assert.match(await overview.innerText(),/Summarised and listwise LLM performance by scan type/);
    assert.match(await overview.innerText(),/timestamps, runtime, processing pass\/fail/);
    assert.match(await overview.innerText(),/Google Sheets export pass\/fail, cost, and captured errors/);
    assert.match(await overview.innerText(),/Export outcomes are historical report fields/);
    if(width===1180){const metrics=await Promise.all(['LLMs used','Total scans','Generated'].map(t=>overview.getByText(t,{exact:true}).boundingBox()));assert.equal(metrics[0].y,metrics[1].y);assert.equal(metrics[1].y,metrics[2].y);}
    assert.equal(await page.getByText('0',{exact:true}).count(),0);
    assert.equal(await page.getByRole('button',{name:'Refresh'}).isDisabled(),true);
    await page.screenshot({path:path.join(output,`${width}-loading.png`)});
    await settle(0,'Fixture timeout',true);
    await page.getByRole('alert').waitFor();
    assert.equal(await page.getByText('0',{exact:true}).count(),0);
    assert.equal(await page.getByText(/No LLM scans/).count(),0);
    await page.getByRole('button',{name:'Refresh'}).focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(()=>requests.length===2);
    await settle(1,fixture);
    await page.getByRole('heading',{name:'Fixture / Test model'}).waitFor();
    assert.equal(await page.getByRole('alert').count(),0);
    assert.equal(await page.getByText('Fixture pending evidence').count(),1);
    assert.equal(await page.getByText('Fail',{exact:true}).count(),0);
    for(const region of await page.locator('[role=region][tabindex]').all()) {
      await region.focus();
      assert.equal(await region.evaluate(el=>el===document.activeElement),true);
      await page.keyboard.press('ArrowRight');
      await region.evaluate(el=>{el.scrollLeft=0});
    }
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:path.join(output,`${width}-loaded-partial.png`),fullPage:true});
    await page.getByRole('button',{name:'Refresh'}).click();
    await page.getByRole('status').waitFor();
    await settle(2,'Fixture reload failed',true);
    await page.getByRole('alert').waitFor();
    assert.equal(await page.getByText(/may be stale/).count(),1);
    assert.equal(await page.getByRole('heading',{name:'Fixture / Test model'}).count(),1);
    await page.screenshot({path:path.join(output,`${width}-stale.png`),fullPage:true});
    await page.getByRole('button',{name:'Refresh'}).click();
    await settle(3,empty);
    await page.getByText(/No LLM scans/).waitFor();
    assert.equal(await page.getByText('0',{exact:true}).count(),2);
    await page.screenshot({path:path.join(output,`${width}-empty.png`)});
    await page.getByRole('button',{name:'Refresh'}).click();
    const complete=structuredClone(fixture);complete.groups[0].scans[0].processing_passed=true;complete.groups[0].scans[0].sheet_export_passed=false;complete.groups[0].scans[0].estimated_cost=0.125;
    await settle(4,complete);
    await page.getByText('Pass',{exact:true}).waitFor();assert.equal(await page.getByText('Fail',{exact:true}).count(),1);assert.equal(await page.getByText('$0.13 (FX unavailable)',{exact:true}).count(),1);
    await page.screenshot({path:path.join(output,`${width}-loaded-outcomes.png`),fullPage:true});
    await page.goto(`${base}/other`);await page.goto(`${base}/console/llms`);
    await page.getByRole('status').waitFor();
    await settle(0,fixture);
    await page.getByRole('heading',{name:'Fixture / Test model'}).waitFor();
  }
  assert.deepEqual(errors,[]);
  console.log(`PASS: loading, failed, keyboard retry, loaded partial/unknown, stale reload, repeated retry, confirmed empty, navigation, 1180x757 and 390x757, focus and overflow. Local fixtures only. Evidence: ${output}`);
} finally { await browser.close();server.close(); }

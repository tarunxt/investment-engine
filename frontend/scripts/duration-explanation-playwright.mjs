#!/usr/bin/env node
// Mount the production duration dialog with local read-only fixtures.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';

const require = createRequire(import.meta.url), frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'duration-explanation-'));
let browser, server;
try {
  await writeFile(path.join(temporary, 'entry.tsx'), `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {StageDurationBreakdownDialog} from '@/app/console/dashboard/_components/StageDurationBreakdownDialog';
function Fixture(){const [open,setOpen]=useState(false);const [mode,setMode]=useState('fallback');const [tick,setTick]=useState(0);window.rerender=()=>setTick(tick+1);window.timingMode=mode;return <><select aria-label="Fixture" onChange={e=>setMode(e.target.value)}>{['fallback','loaded','failed','loading','empty','active','partial'].map(x=><option key={x}>{x}</option>)}</select><button onClick={()=>setOpen(true)}>Open duration</button><button onClick={()=>setOpen(true)}>Second duration opener</button><button>Threats &amp; Guardrails prompt</button><StageDurationBreakdownDialog open={open} stageLabel="Synthetic rebalance stage with a deliberately long accessible title for keyboard and narrow layout verification" now={Date.parse('2026-11-01T00:01:49Z')} info={{state:mode==='active'?'processing':'completed',startedAt:mode==='empty'?null:'2026-11-01T00:00:00Z',endedAt:mode==='empty'||mode==='active'?null:'2026-11-01T00:01:49Z',provider:'Fixture provider',model:'Exact fixture model',lastRunId:['fallback','empty','active'].includes(mode)?null:42}} onClose={()=>setOpen(false)}/></>}
createRoot(document.getElementById('root')).render(<Fixture/>);`);
  await writeFile(path.join(temporary,'api.ts'), `export const apiService={getRun:async(id,{signal})=>{await new Promise(r=>setTimeout(r,50));if(window.timingMode==='loading')return new Promise(()=>{});if(window.timingMode==='failed')throw new Error('Fixture read failure');return {run_jobs:[{job:{id:1,status:window.timingMode==='partial'?'failed':'completed',provider:'Fixture provider',model:'Exact fixture model',created_at:'2026-11-01T00:00:09Z',updated_at:'2026-11-01T00:01:39Z'}},{job:{id:2,status:'completed',provider:'Second provider',model:'Second exact model',created_at:'2026-11-01T00:00:09Z',updated_at:'2026-11-01T00:01:29Z'}}]}}};`);
  await writeFile(path.join(temporary, 'loader.cjs'), `const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(s){return ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020},fileName:this.resourcePath}).outputText}`);
  const w = require('next/dist/compiled/webpack/webpack');
  await new Promise((resolve,reject)=>w.webpack({mode:'development',devtool:false,entry:path.join(temporary,'entry.tsx'),output:{path:temporary,filename:'bundle.js'},resolve:{extensions:['.tsx','.ts','.js'],modules:[path.join(frontend,'node_modules'),'node_modules'],alias:{...(process.env.DURATION_COMPONENT ? {'@/app/console/dashboard/_components/StageDurationBreakdownDialog$':process.env.DURATION_COMPONENT}:{}),'@/services/api$':path.join(temporary,'api.ts'),'@':frontend}},module:{rules:[{test:/\.tsx?$/,use:path.join(temporary,'loader.cjs')}]},plugins:[new w.webpack.DefinePlugin({'process.env.NODE_ENV':JSON.stringify('development')})]},(error,stats)=>error?reject(error):stats.hasErrors()?reject(new Error(stats.toString({all:false,errors:true}))):resolve()));
  const css = (await postcss([tailwind({base:frontend})]).process('@import "tailwindcss";', {from:path.join(frontend,'app/globals.css')})).css;
  const bundle = await readFile(path.join(temporary,'bundle.js'));
  server = createServer((req,res)=>{if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle)}else{res.setHeader('Content-Type','text/html');res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}body{font:14px sans-serif;margin:16px}</style><div id="root"></div><script src="/bundle.js"></script>`)} });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  let executablePath=process.env.CHROMIUM_PATH;
  if(!executablePath){try{await access('/usr/bin/chromium');executablePath='/usr/bin/chromium'}catch{}}
  browser=await chromium.launchPersistentContext(path.join(temporary,'profile'),{executablePath,headless:true,args:['--no-sandbox']});
  const page=await browser.newPage();const requests=[];const errors=[];const evidence=[];
  await page.route('**/*',route=>{if(route.request().url().startsWith('chrome://')||route.request().url().startsWith(base))return route.continue();requests.push(route.request().url());return route.abort()});
  page.on('pageerror',error=>errors.push(error.message));
  for(const {width,zoom} of [{width:1180,zoom:1},{width:390,zoom:1},{width:1180,zoom:2}]){
    await page.setViewportSize({width,height:757});
    await page.goto('chrome://settings/appearance');
    await page.evaluate(zoom=>chrome.settingsPrivate.setDefaultZoom(zoom),zoom);
    await page.goto(base);
    const metrics=await page.evaluate(()=>({width:innerWidth,dpr:devicePixelRatio,visualScale:visualViewport.scale,cssZoom:getComputedStyle(document.body).zoom,transform:getComputedStyle(document.body).transform}));
    assert.equal(metrics.dpr,zoom);assert.equal(metrics.visualScale,1);assert.equal(metrics.cssZoom,'1');assert.equal(metrics.transform,'none');
    console.log({width,zoom,metrics});
    for(const mode of ['fallback','loaded','failed','loading','empty','active','partial']){
      await page.getByLabel('Fixture').selectOption(mode);
      const trigger=page.getByRole('button',{name:'Open duration'});await trigger.focus();await page.keyboard.press('Enter');
      const dialog=page.getByRole('dialog');await dialog.waitFor();
      const focus=()=>page.evaluate(()=>document.activeElement?.getAttribute('aria-label')||document.activeElement?.textContent);
      assert.equal(await focus(),'Close duration breakdown');
      assert.equal(await dialog.getAttribute('aria-modal'),'true');
      assert.equal(await dialog.getAttribute('aria-labelledby'),'stage-duration-breakdown-title');
      assert.equal(await page.locator('#root').evaluate(n=>n.inert),true);
      await page.getByRole('button',{name:'Threats & Guardrails prompt',includeHidden:true}).evaluate(n=>n.focus());
      assert.equal(await focus(),'Close duration breakdown');
      await page.keyboard.press('Shift+Tab');assert.equal(await focus(),'How timing is measured');
      await page.keyboard.press('Tab');assert.equal(await focus(),'Close duration breakdown');
      await page.keyboard.press('Tab');assert.equal(await focus(),'How timing is measured');
      await page.evaluate(()=>window.rerender());
      await page.waitForTimeout(20);assert.equal(await focus(),'How timing is measured');
      await page.keyboard.press('Tab');assert.equal(await focus(),'Close duration breakdown');
      evidence.push({width,zoom,metrics,mode,semantics:await dialog.ariaSnapshot(),focus:['Open duration','Close duration breakdown','How timing is measured (reverse wrap)','Close duration breakdown (forward wrap)','How timing is measured','How timing is measured (rerender)','Close duration breakdown']});
      if(['loaded','partial'].includes(mode))await dialog.locator('dt').getByText('Second exact model',{exact:false}).waitFor();
      if(mode==='failed')await dialog.getByText(/Fixture read failure/).waitFor();
      if(mode==='loading')await dialog.getByText('Loading detailed LLM timings…').waitFor();
      assert.equal(await dialog.locator('dt').count(),['loaded','partial'].includes(mode)?4:3);
      if(['loaded','partial'].includes(mode)){
        for(const duration of ['00:00:09','00:01:30','00:01:20','00:00:10'])assert.match(await dialog.locator('dl').innerText(),new RegExp(duration));
        assert.match(await dialog.locator('dl').innerText(),/Exact fixture model/);
      }
      assert.match(await dialog.innerText(),/includes provider processing and queue time/);
      assert.equal(await dialog.locator('details').getAttribute('open'),null);
      if(['fallback','failed','active','loading'].includes(mode))assert.equal(await dialog.getByText('Not recorded',{exact:true}).count(),2);
      if(mode==='empty')assert.match(await dialog.locator('header').innerText(),/n\/a/);
      else assert.match(await dialog.locator('header').innerText(),/00:01:49/);
      const summary=dialog.locator('summary');await summary.focus();await page.keyboard.press('Enter');
      await page.waitForFunction(()=>document.querySelector('details').open);
      assert.match(await dialog.innerText(),/timestamp|includes queue/);
      if(['loaded','partial'].includes(mode))assert.match(await dialog.innerText(),/providers run in parallel/);
      else assert.match(await dialog.innerText(),/complete execution window, including provider processing and any queue time/);
      assert.ok(await dialog.evaluate(n=>n.scrollWidth<=n.clientWidth),'dialog overflow');
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'page overflow');
      const rect=await dialog.boundingBox();assert.ok(rect.x>=0&&rect.x+rect.width<=metrics.width);
      await page.screenshot({path:'/tmp/duration-'+width+'-zoom'+zoom+'-'+mode+'.png'});
      await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});assert.equal(await focus(),'Open duration');assert.equal(await page.locator('#root').evaluate(n=>n.inert),false);
      await trigger.click();await dialog.waitFor();assert.equal(await dialog.locator('details').getAttribute('open'),null);
      await dialog.getByRole('button',{name:'Close duration breakdown'}).click();await dialog.waitFor({state:'detached'});
      assert.equal(await focus(),'Open duration');
      const second=page.getByRole('button',{name:'Second duration opener'});await second.focus();await page.keyboard.press('Enter');await dialog.waitFor();
      await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});assert.equal(await focus(),'Second duration opener');
      await second.focus();await page.keyboard.press('Enter');await dialog.waitFor();await second.evaluate(n=>n.remove());
      await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});assert.equal(await page.locator('#root').evaluate(n=>n.inert),false);
      await page.goto(base);
    }
  }
  assert.deepEqual(requests,[]);assert.deepEqual(errors,[]);
  await writeFile('/tmp/duration-focus-evidence.json',JSON.stringify(evidence,null,2));
  console.log('Duration fixtures passed: desktop 100%, narrow 100%, desktop browser zoom 200%; seven states; focus wrap, background inertness, rerender, missing opener, Escape, close and repeated opening; no external requests.');

} finally {
  if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(temporary,{recursive:true,force:true});
}

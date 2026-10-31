#!/usr/bin/env node
// Mount the production shared Stage tile; external services are unavailable.
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
const temporary = await mkdtemp(path.join(os.tmpdir(), 'stage-error-popup-'));
let browser, server;
try {
  await writeFile(path.join(temporary, 'entry.tsx'), `import React from 'react';import {createRoot} from 'react-dom/client';
import {WorkflowStageTile,STAGE_ORDER} from '@/components/shared/WorkflowStageTile';
const messages={sync:'Provider timeout with original sync diagnostic',threats:'Insufficient balance with original credit diagnostic',swing:null,rebalance:'Invalid output contract with original parser diagnostic',technical:'Authentication failed with original auth diagnostic',actionables:'Original execution failure'};
window.fixtureNavigations=0;
createRoot(document.getElementById('root')).render(<>{['Automated Rebalance','Zerodha history','INDmoney history'].map((surface,index)=><section key={surface} aria-label={surface} style={{display:'grid',gridTemplateColumns:'repeat(3,minmax(0,1fr))',gap:12,marginBottom:20}}>{STAGE_ORDER.map((stage,i)=><WorkflowStageTile key={stage} stage={stage} now={0} historical={index>0} onClick={()=>window.fixtureNavigations++} info={{state:stage==='swing'?'completed':'failed',runStatus:stage==='swing'?'partial':'failed',lastRunId:700+index,jobId:900+i,error:messages[stage],partialNotice:'Original partial diagnostic '+surface+' '+stage,partialLlms:1,totalLlms:2,passedLlms:1,errorDetails:[{provider:'Synthetic provider',model:'Synthetic model',message:'Original nested provider exception',runId:700+index,jobId:900+i,status:'partial',httpStatus:429,retrySafe:false,correlationId:'original-correlation',attempt:2,exceptionType:'OriginalException',traceReference:'original-trace',providerResponseBody:'Original provider response body'}]}}/>)}</section>)}</>);`);
  await writeFile(path.join(temporary, 'duration.tsx'), 'export function StageDurationBreakdownDialog(){return null}');
  await writeFile(path.join(temporary, 'loader.cjs'), `const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(s){return ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020},fileName:this.resourcePath}).outputText}`);
  const w = require('next/dist/compiled/webpack/webpack');
  await new Promise((resolve,reject)=>w.webpack({mode:'development',devtool:false,entry:path.join(temporary,'entry.tsx'),output:{path:temporary,filename:'bundle.js'},resolve:{extensions:['.tsx','.ts','.js'],modules:[path.join(frontend,'node_modules'),'node_modules'],alias:{'@/app/console/dashboard/_components/StageDurationBreakdownDialog$':path.join(temporary,'duration.tsx'),'@':frontend}},module:{rules:[{test:/\.tsx?$/,use:path.join(temporary,'loader.cjs')}]},plugins:[new w.webpack.DefinePlugin({'process.env.NODE_ENV':JSON.stringify('development')})]},(error,stats)=>error?reject(error):stats.hasErrors()?reject(new Error(stats.toString({all:false,errors:true}))):resolve()));
  const css = (await postcss([tailwind({base:frontend})]).process('@import "tailwindcss";', {from:path.join(frontend,'app/globals.css')})).css;
  const bundle = await readFile(path.join(temporary,'bundle.js'));
  server = createServer((req,res)=>{if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle)}else{res.setHeader('Content-Type','text/html');res.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}body{font:14px sans-serif;margin:16px}</style><div id="root"></div><script src="/bundle.js"></script>`)} });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  let executablePath=process.env.CHROMIUM_PATH;
  if(!executablePath){try{await access('/usr/bin/chromium');executablePath='/usr/bin/chromium'}catch{}}
  browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
  const page=await browser.newPage();const requests=[];const errors=[];
  await page.route('**/*',route=>{if(route.request().url().startsWith(base))return route.continue();requests.push(route.request().url());return route.abort()});
  page.on('pageerror',error=>errors.push(error.message));
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:1000});await page.goto(base);await page.locator('article').last().waitFor();
    assert.equal(await page.getByRole('dialog').count(),0,'failed stages must wait for icon activation');
    for(const surface of ['Automated Rebalance','Zerodha history','INDmoney history']){
      const section=page.getByRole('region',{name:surface,exact:true});
      const tiles=section.locator('article');assert.equal(await tiles.count(),6);
      for(let index=0;index<6;index++){
        const tile=tiles.nth(index);const trigger=tile.getByRole('button',{name:/Show error details/});
        assert.doesNotMatch(await tile.innerText(),/Original|Partial use:/);
        const errorLine=(await tile.innerText()).split('\n').find(line=>line.startsWith('Error:'));
        assert.ok(errorLine.replace('Error:','').trim().split(/\s+/).length<=3,errorLine);
        if(index===2)assert.match(errorLine,/LLM output partial/);
        await trigger.scrollIntoViewIfNeeded();await trigger.focus();await page.keyboard.press(index%2?' ':'Enter');
        const dialog=page.getByRole('dialog');await dialog.waitFor();
        assert.ok(await dialog.evaluate(node=>node.matches(':modal')));
        assert.ok(await dialog.evaluate(node=>node.contains(document.activeElement)));
        const rect=await dialog.boundingBox();assert.ok(rect.width<=448&&rect.width<=width-30);
        assert.match(await dialog.innerText(),/Original partial diagnostic/);
        assert.match(await dialog.innerText(),/Original nested provider exception/);
        assert.match(await dialog.innerText(),/original-correlation/);
        assert.match(await dialog.innerText(),/original-trace/);
        assert.match(await dialog.innerText(),/Job #90/);
        if(index!==2)assert.match(await dialog.innerText(),/original|Original/);
        await dialog.getByText('Provider response body',{exact:true}).click();assert.match(await dialog.innerText(),/Original provider response body/);
        await page.keyboard.press('Tab');assert.ok(await dialog.evaluate(node=>node.contains(document.activeElement)),'focus must remain inside popup');
        await page.keyboard.press('Shift+Tab');assert.ok(await dialog.evaluate(node=>node.contains(document.activeElement)),'reverse tab focus must remain inside popup');
        assert.match(await dialog.innerText(),new RegExp('Status: '+(index===2?'partial':'failed')));
        assert.match(await dialog.innerText(),/Run #70[0-2]/);
        if(index%3===0)await page.keyboard.press('Escape');
        else if(index%3===1)await dialog.getByRole('button',{name:'Close error details'}).click();
        else await page.mouse.click(2,2);
        await page.locator('dialog').waitFor({state:'detached'});await trigger.waitFor();
        assert.equal(await trigger.getAttribute('aria-expanded'),'false');
        assert.ok(await trigger.evaluate(node=>node===document.activeElement),'dismissal restores icon focus');
      }
    }
    assert.equal(await page.evaluate(()=>window.fixtureNavigations),0,'error icon must not open underlying stage navigation');
  }
  assert.deepEqual(requests,[]);assert.deepEqual(errors,[]);
  console.log('PASS: all six shared tiles across three surfaces, desktop/narrow, compact summary, original details/IDs, keyboard activation, focus containment/restoration, Escape/close/outside dismissal, zero external requests');
} finally {
  if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(temporary,{recursive:true,force:true});
}

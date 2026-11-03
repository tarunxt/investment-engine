// VISUAL-API-RECOVERY-CONTROLS: actual layout, independent deferred sources, no providers.
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
const require=createRequire(import.meta.url), frontend=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=await mkdtemp(path.join(os.tmpdir(),'audit6-api-cost-history-')), output=process.env.API_RECOVERY_EVIDENCE_DIR||'/tmp/audit2-api-recovery-evidence';
await mkdir(output,{recursive:true});
await writeFile(path.join(temp,'entry.tsx'),`import React from 'react';import{createRoot}from'react-dom/client';import Page from '${frontend}/app/console/apis/page';import Layout from '${frontend}/app/console/apis/layout';createRoot(document.getElementById('root')).render(<Layout><Page/></Layout>);`);
await writeFile(path.join(temp,'api.ts'),`const read=(kind,params)=>new Promise((resolve,reject)=>{window.requests.push({kind,params,resolve,reject})});export const apiService={getApiUsageSummary:(params)=>read('usage',params),getLlmCostHistory:(params)=>read('history',params),post:()=>{window.writes++;throw Error('Blocked write')}};`);
await writeFile(path.join(temp,'link.tsx'),`import React from 'react';export default function Link({children,href,...props}){return <a href={href} {...props}>{children}</a>}`);
await writeFile(path.join(temp,'nav.ts'),`export const usePathname=()=>'/console/profile/cost-drivers';`);
await writeFile(path.join(temp,'loader.cjs'),`const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(s){return ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020},fileName:this.resourcePath}).outputText}`);
const w=require('next/dist/compiled/webpack/webpack');
await new Promise((resolve,reject)=>w.webpack({mode:'development',devtool:false,entry:path.join(temp,'entry.tsx'),output:{path:temp,filename:'bundle.js'},resolve:{extensions:['.tsx','.ts','.js'],modules:[path.join(frontend,'node_modules')],alias:{'next/link$':path.join(temp,'link.tsx'),'next/navigation$':path.join(temp,'nav.ts'),'@/services/api$':path.join(temp,'api.ts'),'@':frontend}},module:{rules:[{test:/\.tsx?$/,use:path.join(temp,'loader.cjs')}]},plugins:[new w.webpack.DefinePlugin({'process.env':JSON.stringify({NODE_ENV:'development'})})]},(error,stats)=>error?reject(error):stats.hasErrors()?reject(Error(stats.toString({all:false,errors:true}))):resolve()));
const css=(await postcss([tailwind({base:frontend})]).process(await readFile(path.join(frontend,'app/globals.css'),'utf8'),{from:path.join(frontend,'app/globals.css')})).css;
const bundle=await readFile(path.join(temp,'bundle.js'));const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'text/javascript':'text/html');res.end(req.url==='/bundle.js'?bundle:`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}body{font-family:Arial;padding:24px}</style><div id="root"></div><script>window.requests=[];window.writes=0;window.breakdowns=[];window.fetch=(url,options)=>new Promise((resolve,reject)=>window.breakdowns.push({url,options,resolve,reject}));</script><script src="/bundle.js"></script>`)});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':chromium.executablePath()),args:['--no-sandbox']});
const page=await browser.newPage();const errors=[],external=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>r.request().url().startsWith(base)?r.continue():(external.push(r.request().url()),r.abort()));

const emptyHistory={name:'Synthetic provider',timezone:'Asia/Kolkata',fx_status:'unavailable',days:[],runs:[]};
try {
 for(const width of [1180,390]) {
  await page.setViewportSize({width,height:844});await page.goto(base);
  await page.waitForFunction(()=>requests.length===5&&breakdowns.length===1);
  const daily=page.getByRole('region',{name:'Daily LLM usage'});
  const trend=page.getByRole('region',{name:'LLM cost trend'});
  await daily.getByRole('button',{name:'Refreshing daily breakdown…',exact:true}).waitFor();
  await page.evaluate(()=>{for(const r of requests)r.reject(Error('Synthetic unavailable'));breakdowns[0].reject(Error('Synthetic breakdown unavailable'));});
  const retry=trend.getByRole('button',{name:'Retry cost trend',exact:true});await retry.waitFor();
  await daily.getByRole('button',{name:'Retry daily breakdown',exact:true}).waitFor();
  assert.match(await page.locator('body').innerText(),/not a zero-usage result/);
  assert.equal(await page.getByRole('checkbox').count(),4);
  for(const section of [daily,trend]){
   const heading=await section.getByRole('heading').boundingBox();
   const action=await section.getByRole('button',{name:/Retry (cost trend|daily breakdown)/}).boundingBox();
   const warning=await section.getByRole('alert').boundingBox();
   assert.ok(action.y<warning.y,'panel recovery action stays with its heading before the error detail');
   assert.ok(action.y>=heading.y-2);
  }
  await page.screenshot({path:path.join(output,`failed-aligned-${width}.png`),fullPage:true});
  await retry.focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>requests.length===9);
  assert.equal(await trend.getByRole('button',{name:'Retrying cost trend…',exact:true}).isDisabled(),true);
  assert.equal(await page.evaluate(()=>requests.filter(r=>r.kind==='usage').length),1);
  assert.equal(await page.evaluate(()=>breakdowns.length),1);
  await page.evaluate(value=>{requests[5].resolve(value);for(const r of requests.slice(6))r.reject(Error('Synthetic partial provider failure'));},emptyHistory);
  await trend.getByText(/Cost trend unavailable/).waitFor();
  await daily.getByRole('button',{name:'Retry daily breakdown',exact:true}).focus();await page.keyboard.press('Enter');
  await page.waitForFunction(()=>breakdowns.length===2);
  assert.equal(await page.evaluate(()=>requests.length),9);
  await page.evaluate(()=>breakdowns[1].resolve(new Response(JSON.stringify({from_date:new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'}),timezone:'Asia/Kolkata',items:[],runs:[]}),{status:200})));
  await daily.getByRole('button',{name:'Refresh daily breakdown',exact:true}).waitFor();
  const combined=page.getByRole('button',{name:'Refresh usage summary and cost trend',exact:true});
  await combined.focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>requests.length===14);
  assert.equal(await page.evaluate(()=>requests.slice(9).filter(r=>r.kind==='usage').length),1);
  assert.equal(await page.evaluate(()=>requests.slice(9).filter(r=>r.kind==='history').length),4);
  assert.equal(await page.evaluate(()=>breakdowns.length),2);
  await page.evaluate(()=>{for(const r of requests.slice(9))r.reject(Error('Synthetic retry failed'));});
  await trend.getByRole('button',{name:'Retry cost trend',exact:true}).waitFor();
  assert.match(await trend.innerText(),/previously loaded history/);
  await page.screenshot({path:path.join(output,`partial-retry-${width}.png`),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.equal(await page.evaluate(()=>writes),0);
 await writeFile(path.join(output,'result.json'),JSON.stringify({task:'VISUAL-API-RECOVERY-CONTROLS',result:'PASS',checks:['loading/error/partial/verified-empty','independent daily/trend recovery request counts','truthful combined usage+trend boundary','keyboard activation','1180px/390px alignment','four provider filters retained'],externalRequests:0,mutationCalls:0,limitations:['Synthetic actual-component layout only; no live-route acceptance']},null,2));
 console.log('PASS API recovery layout/request boundaries '+output);
}finally{await browser.close();server.close()}

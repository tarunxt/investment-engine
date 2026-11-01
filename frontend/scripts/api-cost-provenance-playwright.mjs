// Offline component integration: real settings shell, layout, details and review.
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
const temp=await mkdtemp(path.join(os.tmpdir(),'api-cost-provenance-')), output=process.env.API_COST_SCREENSHOT_DIR||'/tmp/api-cost-provenance-evidence';
await mkdir(output,{recursive:true});
await writeFile(path.join(temp,'entry.tsx'),`import React from 'react';import{createRoot}from'react-dom/client';import Page from '${frontend}/app/console/apis/page';import Breakdown from '${frontend}/app/console/apis/_components/LlmUsageBreakdown';createRoot(document.getElementById('root')).render(<><Page/><div style={{marginTop:16}}><Breakdown/></div></>);`);
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
const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>r.request().url().startsWith(base)?r.continue():r.abort());

const settle=async(index,data,fail=false)=>page.evaluate(({index,data,fail})=>window.requests[index][fail?'reject':'resolve'](fail?Error(data):data),{index,data,fail});
const usage=()=>page.getByRole('region',{name:'Daily LLM usage'});
const trend=()=>page.getByRole('region',{name:'LLM cost trend'});
const item={provider:'openai',provider_name:'OpenAI',model:'fixture-model',source:'bullpen',source_label:'Bullpen',workflow:'Fixture workflow',requests:2,tokens_in:100,tokens_out:20,estimated_cost:0.125,estimated_cost_inr:null,measurement:'estimated'};
const respond=async(index,items=[],fail=false)=>page.evaluate(({index,items,fail})=>{const r=window.breakdowns[index];const q=new URL(r.url,location.href).searchParams;const date=q.get('custom_start');r.resolve({ok:!fail,json:async()=>fail?{detail:'The backend did not respond in time (4 seconds). Please retry.'}:{timezone:'Asia/Kolkata',from_date:date,to_date:date,period_label:date,usd_inr_rate:null,fx_status:'unavailable',coverage_note:'Fixture partial attribution: older days reconstructed from job estimates.',items,runs:[]}})},{index,items,fail});
const start=async()=>{await page.goto(base);await page.waitForFunction(()=>requests.length===5&&breakdowns.length===1);await settle(0,{timezone:'Asia/Kolkata',items:[],fx_status:'unavailable'});};
try{
 for(const width of [1180,390]){
  await page.setViewportSize({width,height:757});await start();
  await usage().getByText('Loading LLM usage breakdown...').waitFor();await page.screenshot({path:path.join(output,`loading-${width}.png`),fullPage:true});
  for(let i=1;i<=4;i++)await settle(i,'Cost history could not be loaded.',true);
  await respond(0,[],true);await usage().getByRole('alert').waitFor();assert.equal(await usage().getByText(/No non-zero/).count(),0);
  await page.screenshot({path:path.join(output,`failed-${width}.png`),fullPage:true});
  await usage().getByRole('button',{name:'Refresh',exact:true}).focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>breakdowns.length===2);await respond(1,[]);await usage().getByText(/No non-zero/).waitFor();await page.screenshot({path:path.join(output,`verified-empty-${width}.png`),fullPage:true});
  await usage().getByRole('button',{name:'Refresh',exact:true}).click();await page.waitForFunction(()=>breakdowns.length===3);await respond(2,[],true);await usage().getByRole('alert').waitFor();assert.equal(await usage().getByText(/No non-zero/).count(),0);
  await usage().getByRole('button',{name:'Refresh',exact:true}).click();await page.waitForFunction(()=>breakdowns.length===4);await respond(3,[item]);await usage().getByText('OpenAI · fixture-model').waitFor();await page.screenshot({path:path.join(output,`loaded-${width}.png`),fullPage:true});
  await usage().getByRole('button',{name:'Refresh',exact:true}).click();await page.waitForFunction(()=>breakdowns.length===5);await respond(4,[],true);await usage().getByRole('alert').waitFor();await usage().getByText('OpenAI · fixture-model').waitFor();await usage().getByText(/Showing previously loaded usage/).waitFor();await page.screenshot({path:path.join(output,`stale-${width}.png`),fullPage:true});
  await usage().getByRole('button',{name:'Show previous breakdown day'}).click();await page.waitForFunction(()=>breakdowns.length===6);await respond(5,[]);await usage().getByText(/No non-zero/).waitFor();
  await usage().getByRole('button',{name:'Show next breakdown day'}).click();await page.waitForFunction(()=>breakdowns.length===7);await respond(6,[item]);await usage().getByText('OpenAI · fixture-model').waitFor();
  await trend().getByRole('button',{name:'Retry cost trend',exact:true}).click();await page.waitForFunction(()=>requests.length===9);
  for(let i=5;i<9;i++)await settle(i,{provider:['openai','anthropic','gemini','deepseek'][i-5],fx_status:'unavailable',coverage_note:'Provider-ledger totals take precedence over reconstructed job estimates.',generated_at:'2026-10-31T12:00:00Z',days:[{date:'2026-10-31',estimated_cost:0.125,estimated_cost_inr:null}],runs:[]});
  await trend().getByRole('img').waitFor();await trend().getByText('Cost (USD)',{exact:true}).waitFor();
  for(const name of ['OpenAI','Anthropic','Gemini','DeepSeek']){const control=trend().getByRole('checkbox',{name,exact:true});assert.equal(await control.isChecked(),true);await control.uncheck();await control.check();}
  await trend().getByRole('button',{name:/Show exact value for OpenAI/}).focus();await page.keyboard.press('Enter');await trend().getByText('Exact value: $0.125000').waitFor();
  await page.screenshot({path:path.join(output,`trend-loaded-${width}.png`),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.equal(await page.evaluate(()=>writes),0);
 }
 // Partial trend retains three providers and names the failed provider.
 await start();await respond(0,[item]);await settle(1,'timeout',true);
 for(let i=2;i<5;i++)await settle(i,{provider:['openai','anthropic','gemini','deepseek'][i-1],fx_status:'unavailable',days:[{date:'2026-10-31',estimated_cost:0.125,estimated_cost_inr:null}],runs:[]});
 await trend().getByRole('img').waitFor();await trend().getByRole('alert').waitFor();assert.equal(await trend().getByRole('button',{name:/Show exact value for OpenAI/}).count(),0);await page.screenshot({path:path.join(output,'partial-390.png'),fullPage:true});
 // A superseded previous-day response cannot overwrite the newer selected day.
 await usage().getByRole('button',{name:'Show previous breakdown day'}).click();await page.waitForFunction(()=>breakdowns.length===2);
 await usage().getByRole('button',{name:'Show next breakdown day'}).click();await page.waitForFunction(()=>breakdowns.length===3);
 await respond(2,[]);await usage().getByText(/No non-zero/).waitFor();await respond(1,[item]);await page.waitForTimeout(30);assert.equal(await usage().getByText('OpenAI · fixture-model').count(),0);
 // Isolated focus/input persistence across asynchronous state updates.
 for(const width of [1180,390]){
  await page.setViewportSize({width,height:757});await start();
  const dateInput=usage().locator('input[aria-label="Breakdown date"]');
  const refresh=usage().getByRole('button',{name:'Refresh',exact:true});
  const selected=await dateInput.inputValue();
  const focused=async control=>assert.equal(await control.evaluate(e=>e===document.activeElement),true);
  await dateInput.focus();await respond(0,[],true);await usage().getByRole('alert').waitFor();await focused(dateInput);assert.equal(await dateInput.inputValue(),selected);
  await refresh.focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>breakdowns.length===2);
  await focused(refresh);assert.equal(await refresh.getAttribute('aria-disabled'),'true');await page.keyboard.press('Enter');await page.keyboard.press('Space');assert.equal(await page.evaluate(()=>breakdowns.length),2);await respond(1,[item]);await usage().getByText('OpenAI · fixture-model').waitFor();await focused(refresh);
  await page.keyboard.press('Enter');await page.waitForFunction(()=>breakdowns.length===3);await focused(refresh);
  await respond(2,[],true);await usage().getByRole('alert').waitFor();await focused(refresh);assert.equal(await dateInput.inputValue(),selected);
  await usage().getByText('OpenAI · fixture-model').waitFor();
  await page.keyboard.press('Enter');await page.waitForFunction(()=>breakdowns.length===4);await respond(3,[]);await usage().getByText(/No non-zero/).waitFor();await focused(refresh);await page.screenshot({path:path.join(output,`focus-recovered-${width}.png`),fullPage:true});
  await dateInput.focus();await dateInput.fill('2026-10-30');await page.waitForFunction(()=>breakdowns.length===5);await focused(dateInput);await respond(4,[item]);await usage().getByText('OpenAI · fixture-model').waitFor();await focused(dateInput);assert.equal(await dateInput.inputValue(),'2026-10-30');
  assert.deepEqual(await page.evaluate(()=>breakdowns.map(({url,options})=>{const q=new URL(url,location.href).searchParams;return {path:new URL(url,location.href).pathname,method:options.method,cache:options.cache,credentials:options.credentials,period:q.get('period'),sameDay:q.get('custom_start')===q.get('custom_end')};})),Array(5).fill({path:'/backend-api/api-usage/llms/breakdown',method:'GET',cache:'no-store',credentials:'same-origin',period:'custom',sameDay:true}));
 }
 assert.deepEqual(errors,[]);console.log('PASS: actual components at 1180x757 and 390x757: loading, failed, verified empty, failed-after-empty, loaded, cached stale, date back/forward, keyboard retry/points, four filters, USD, no clipping, focus/input retention, duplicate retry suppression, exact read-only GET contract, no external calls/writes. '+output);
}finally{await browser.close();server.close()}

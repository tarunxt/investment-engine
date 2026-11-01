// A6-08 offline acceptance: actual API page and cost-history modal, synthetic deferred reads only.
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
const temp=await mkdtemp(path.join(os.tmpdir(),'audit6-api-cost-history-')), output=process.env.A6_API_COST_EVIDENCE_DIR||'/tmp/audit6-api-cost-history-evidence';
await mkdir(output,{recursive:true});
await writeFile(path.join(temp,'entry.tsx'),`import React from 'react';import{createRoot}from'react-dom/client';import Page from '${frontend}/app/console/apis/page';createRoot(document.getElementById('root')).render(<Page/>);`);
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

const evidence=[];
const settle=async(index,data,fail=false)=>page.evaluate(({index,data,fail})=>window.requests[index][fail?'reject':'resolve'](fail?Error(data):data),{index,data,fail});
const empty={name:'Synthetic provider',timezone:'Asia/Kolkata',fx_status:'unavailable',days:[],runs:[],has_more_days:true,has_more_runs:true};
const populated={...empty,days:[{date:'2026-11-01',requests:2,tokens_in:100,tokens_out:20,estimated_cost:0.125,estimated_cost_inr:null}],runs:[{job_id:9001,timestamp:'2026-11-01T00:00:00Z',model:'synthetic-model',status:'completed',estimated_cost:0.125,estimated_cost_inr:null}]};
const usageItem={name:'OpenAI',category:'LLM',configured:true,daily_requests:2,daily_tokens_in:100,daily_tokens_out:20,daily_estimated_cost:0.125,daily_estimated_cost_inr:null};
const title=()=>page.getByRole('heading',{name:'LLM Cost History',exact:true});
const modal=()=>title().locator('../..').locator('..');
const tab=label=>modal().getByRole('button',{name:label,exact:true});
const open=async()=>{const n=await page.evaluate(()=>requests.length);await page.getByTitle('Show LLM cost history').focus();await page.keyboard.press('Enter');await title().waitFor();await page.waitForFunction(n=>requests.length===n+1,n);return n;};
const close=async()=>{await page.getByRole('button',{name:'Close LLM cost history',exact:true}).focus();await page.keyboard.press('Enter');await title().waitFor({state:'hidden'});};
const start=async()=>{await page.goto(base);await page.waitForFunction(()=>requests.length===5);await settle(0,{timezone:'Asia/Kolkata',items:[usageItem],fx_status:'unavailable'});for(let n=1;n<=4;n++)await settle(n,empty);await page.getByTitle('Show LLM cost history').waitFor();};
try{
for(const width of [1180,390]){
 await page.setViewportSize({width,height:757});await start();
 let n=await open();
 for(const label of ['Day-wise','All runs']){await tab(label).focus();await page.keyboard.press('Enter');await modal().getByText('Loading LLM cost history...', {exact:true}).waitFor();assert.doesNotMatch(await modal().innerText(),/No runs recorded|No daily history recorded/);}
 await settle(n,'Synthetic timeout',true);
 for(const label of ['Day-wise','All runs']){await tab(label).click();await modal().getByRole('alert').waitFor();assert.doesNotMatch(await modal().innerText(),/No runs recorded|No daily history recorded/);await modal().getByText('Cost history is unavailable. Close and reopen history to retry.',{exact:true}).waitFor();}
 await page.screenshot({path:path.join(output,`failed-${width}.png`),fullPage:false});await close();
 n=await open();await settle(n,empty);
 await tab('Day-wise').click();await modal().getByText('No daily history recorded for this LLM yet.',{exact:true}).waitFor();
 await tab('All runs').click();await modal().getByText('No runs recorded for this LLM yet.',{exact:true}).waitFor();
 await page.screenshot({path:path.join(output,`verified-empty-${width}.png`),fullPage:false});
 let next=await page.evaluate(()=>requests.length);await modal().getByRole('button',{name:'See more',exact:true}).click();await page.waitForFunction(n=>requests.length===n+1,next);await settle(next,'Synthetic refresh failed',true);
 for(const label of ['Day-wise','All runs']){await tab(label).click();await modal().getByRole('alert').waitFor();assert.doesNotMatch(await modal().innerText(),/No runs recorded|No daily history recorded/);await modal().getByText(/Showing previously loaded history/).waitFor();}
 await close();n=await open();await settle(n,populated);
 for(const label of ['Day-wise','All runs']){await tab(label).click();await modal().getByText('$0.13 (FX unavailable)',{exact:true}).waitFor();}
 next=await page.evaluate(()=>requests.length);await modal().getByRole('button',{name:'See more',exact:true}).click();await page.waitForFunction(n=>requests.length===n+1,next);await settle(next,'Synthetic refresh failed',true);
 for(const label of ['Day-wise','All runs']){await tab(label).click();await modal().getByText(/Showing previously loaded history/).waitFor();await modal().getByText('$0.13 (FX unavailable)',{exact:true}).waitFor();assert.doesNotMatch(await modal().innerText(),/No runs recorded|No daily history recorded/);}
 await page.screenshot({path:path.join(output,`cached-populated-failure-${width}.png`),fullPage:false});
 const bounds=await modal().boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width);const escapedFocus=await page.getByTitle('Show LLM cost history').evaluate(el=>{el.focus();return el===document.activeElement});
 await page.keyboard.press('Escape');const escapeClosed=await title().count()===0;
 evidence.push({width,states:'both tabs loading/failure/verified-empty/cached-empty failure/populated/cached-populated failure',keyboardActivation:true,modalEscapeClosed:escapeClosed,backgroundCanReceiveFocus:escapedFocus,dialogRoleCount:await page.getByRole('dialog').count(),modalBounds:bounds});
 if(await title().count())await close();
 // Closed read cannot reopen or contaminate a later modal.
 n=await open();await close();await settle(n,{...populated,name:'Stale closed provider'});await page.waitForTimeout(25);assert.equal(await title().count(),0);
 n=await open();await close();const fresh=await open();await settle(fresh,empty);await modal().getByText('No daily history recorded for this LLM yet.',{exact:true}).waitFor();await settle(n,populated);await page.waitForTimeout(25);assert.equal(await modal().getByText('No daily history recorded for this LLM yet.',{exact:true}).count(),1);assert.equal(await modal().getByText('synthetic-model',{exact:true}).count(),0);await close();
 // Newer expanded history wins even if the older request fails afterward.
 n=await open();await settle(n,populated);next=await page.evaluate(()=>requests.length);await modal().getByRole('button',{name:'See more',exact:true}).click();await page.waitForFunction(n=>requests.length===n+1,next);await tab('All runs').click();
 // Pending read disables the UI's next expansion; closing/reopening supplies supported supersession above.
 assert.equal(await modal().getByRole('button',{name:'Loading...',exact:true}).isDisabled(),true);await close();await settle(next,'Stale dismissed failure',true);await page.waitForTimeout(25);assert.equal(await title().count(),0);
 assert.equal(await page.evaluate(()=>writes),0);assert.deepEqual(await page.evaluate(()=>requests.filter(r=>!['usage','history'].includes(r.kind))),[]);
}
assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
await writeFile(path.join(output,'result.json'),JSON.stringify({timestamp:new Date().toISOString(),actualComponents:['ApisPage','LlmCostHistoryModal'],evidence,writes:0,external,errors,limitations:['Existing cost modal exposes no dialog role, permits background focus and does not close on Escape. This harness records those gaps without changing production code.','Synthetic isolated browser acceptance; not authenticated production UI or real cost history.']},null,2));
console.log('PASS source-state and stale-response acceptance: both tabs at1180/390;0writes/external/errors. Existing modal keyboard/semantics limitations recorded. '+output);
}finally{await browser.close();server.close()}

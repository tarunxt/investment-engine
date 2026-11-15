import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
const require=createRequire(import.meta.url),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=await mkdtemp(path.join(os.tmpdir(),'runs-hierarchy-')),output=process.env.RUN_HIERARCHY_EVIDENCE_DIR||'/tmp/credx-runs-hierarchy-evidence';
let browser,server;
try {
 await mkdir(output,{recursive:true});
 const baseline=execFileSync('git',['show','c7d4942e03a3d0be320195b11fbbf24c5e83b94c:frontend/app/console/runs/_components/PortfolioWorkflowHistoryCard.tsx'],{cwd:root,encoding:'utf8'}).replace("'./HistoricalStageLedgerRow'",JSON.stringify(root+'/app/console/runs/_components/HistoricalStageLedgerRow'));
 await writeFile(temp+'/before.tsx',baseline);
 await writeFile(temp+'/entry.tsx',`import React from 'react';import{createRoot}from'react-dom/client';import{PortfolioWorkflowHistoryCard as After}from'@/app/console/runs/_components/PortfolioWorkflowHistoryCard';import{PortfolioWorkflowHistoryCard as Before}from'./before';import Detail from '@/app/console/_components/RunDetailPageContent';import{AutoRebalanceHistoryDetailClient as Workflow}from'@/app/console/auto-rebalance-runs/_components/AutoRebalanceHistoryClient';import{group,runs}from'./fixture';const Card=location.search.includes('before')?Before:After;createRoot(document.getElementById('root')).render(<main style={{padding:16,maxWidth:1100,margin:'auto'}}>{location.pathname.includes('/auto-rebalance-runs/')?<Workflow portfolio="indmoneyUs" sequence={120}/>:location.pathname.endsWith('/442')?<Detail/>:<Card group={group} runs={runs} runLinksAvailable={!location.search.includes('loading')} initialView="diagnostics" onOpen={path=>location.href=path}/>}</main>);`);
 await writeFile(temp+'/fixture.ts',`const stamp='2026-11-01T00:00:00Z';const state=new URLSearchParams(location.search).get('state')||'partial';export const group={portfolio:'indmoney_us',sequence:120,label:'IndMoney US Run #120',status:state==='partial'?'completed':state,created_at:stamp,updated_at:stamp,stages:['swing','rebalance','technical'].map((stage,i)=>({stage,run_id:442-i,status:state,summary:{},provider_count:2,completed_provider_count:state==='completed'?2:1,partial_provider_count:state==='partial'?1:0,failed_provider_count:state==='failed'?1:0}))};const job={id:901,provider:'Fixture provider',model:'Fixture model',status:state,response:'Saved useful output',prompt:'Saved original prompt',created_at:stamp,updated_at:stamp};export const runs=location.search.includes('empty')?[]:group.stages.map(stage=>({id:stage.run_id,status:state,auto_rebalance_portfolio:'indmoney_us',auto_rebalance_sequence:120,auto_rebalance_label:group.label,prompt_preview:stage.stage==='swing'?'Indmoney US swing trade':stage.stage==='technical'?'## Technical Scan Input Bundle':'[rebalance_flow:us]',run_jobs:[{job,job_id:901}],created_at:stamp,updated_at:stamp}));export const apiService={getRun:async()=>({...runs[0],current_stage:1,prompt:runs[0].prompt_preview}),getAutoRebalanceHistoryDetail:async()=>({...group,runs:runs.map(r=>({...r,jobs:[job]})),standalone_jobs:[]}),getApiUsageSummary:async()=>({}),};export class APIError extends Error{}`);
 await writeFile(temp+'/navigation.ts',`export function useParams(){return{id:'442'}}export function usePathname(){return location.pathname}const router={replace:()=>{},back:()=>history.back()};export function useRouter(){return router}export function useSearchParams(){return new URLSearchParams(location.search)}`);
 await writeFile(temp+'/link.tsx',`import React from'react';export default function Link({href,children,prefetch,...props}){return <a href={href} {...props}>{children}</a>}`);
 await writeFile(temp+'/stub.tsx',`export default function Stub(){return null}export function StageDurationBreakdownDialog(){return null}export class WSClient{connect(){}disconnect(){}on(){return()=>{}}}`);
 await writeFile(temp+'/loader.cjs',`const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(s){return ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020},fileName:this.resourcePath}).outputText}`);
 const w=require('next/dist/compiled/webpack/webpack');
 await new Promise((resolve,reject)=>w.webpack({mode:'development',devtool:false,entry:temp+'/entry.tsx',output:{path:temp,filename:'bundle.js'},resolve:{extensions:['.tsx','.ts','.js'],modules:[root+'/node_modules'],alias:{'next/navigation$':temp+'/navigation.ts','next/link$':temp+'/link.tsx','@/services/api$':temp+'/fixture.ts','@/services/websocket$':temp+'/stub.tsx','@/components/InvestmentRecommendationTable$':temp+'/stub.tsx','@/app/console/dashboard/_components/StageDurationBreakdownDialog$':temp+'/stub.tsx','@':root}},module:{rules:[{test:/\.tsx?$/,use:temp+'/loader.cjs'}]},plugins:[new w.webpack.DefinePlugin({'process.env':JSON.stringify({NODE_ENV:'development'})})]},(e,s)=>e?reject(e):s.hasErrors()?reject(Error(s.toString({all:false,errors:true}))):resolve()));
 const css=(await postcss([tailwind({base:root})]).process(await readFile(root+'/app/globals.css','utf8'),{from:root+'/app/globals.css'})).css;
 const bundle=await readFile(temp+'/bundle.js');server=createServer((req,res)=>{if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript; charset=utf-8');res.end(bundle)}else {res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style><div id="root"></div><script src="/bundle.js"></script>')}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox']});const page=await browser.newPage();const errors=[],external=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>r.request().url().startsWith(base)?r.continue():(external.push(r.request().url()),r.abort()));
 const records=[];
 for(const width of [1440,390]){await page.setViewportSize({width,height:1000});for(const mode of ['before','after']){await page.goto(base+'/console/runs?'+mode);await page.getByRole('tab',{name:'Diagnostics and earlier context'}).waitFor();await page.screenshot({path:output+'/'+mode+'-'+width+'.png',fullPage:true});if(mode==='after'){const link=page.getByRole('link',{name:/Swing Scan stage run · Run #442/});assert.equal(await link.getAttribute('href'),'/console/indmoney-us-swing-run/442');await link.focus();assert.ok(await link.evaluate(el=>document.activeElement===el));records.push({width,links:await page.locator('a:visible').evaluateAll(els=>els.map(el=>({label:el.textContent,href:el.getAttribute('href')})))});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.getByRole('tab',{name:'Run summary',exact:true}).click();await page.goBack();await page.getByRole('link',{name:/Swing Scan stage run · Run #442/}).waitFor();}}}
 for(const state of ['completed','failed','partial']){await page.goto(base+'/console/runs?state='+state);await page.getByRole('link',{name:/Swing Scan stage run · Run #442/}).waitFor();assert.ok((await page.locator('section').textContent()).includes(state==='partial'?'Execution: completed':state));}
 await page.goto(base+'/console/runs?empty');await page.getByText('0 stage runs',{exact:true}).waitFor();await page.goto(base+'/console/runs?loading');await page.getByText('Stage run links are still loading or unavailable').waitFor();
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000});
  await page.goto(base+'/console/auto-rebalance-runs/indmoneyUs/120');
  await page.getByRole('navigation',{name:'Run hierarchy'}).getByText('Workflow · IndMoney US Run #120').waitFor();
  const workflowText=await page.locator('main').innerText();
  assert.ok(workflowText.includes('Current stage: —'));
  assert.ok(workflowText.includes('Total LLM cost: —'));
  assert.ok(!/[â�]/.test(workflowText));
  assert.ok(workflowText.includes('COMPLETED') && workflowText.includes('PARTIAL'));
  await page.screenshot({path:output+'/workflow-'+width+'.png',fullPage:true});
  await page.goto(base+'/console/indmoney-us-swing-run/442');
  await page.getByRole('navigation',{name:'Run hierarchy'}).getByText('Swing Scan stage run · Run #442').waitFor();
  await page.getByRole('heading',{level:1,name:'Stage run #442',exact:true}).waitFor();
  await page.getByText('Workflow #120 · IndMoney US Run #120 (Swing Scan)',{exact:true}).waitFor();
  await page.getByText('Fixture model · Provider job #901 · Stage run #442',{exact:true}).waitFor();
  assert.ok(!/[â�]/.test(await page.locator('main').innerText()));
  records.push({surface:'stage detail',width,heading:await page.locator('h1').innerText(),breadcrumb:await page.getByRole('navigation',{name:'Run hierarchy'}).innerText(),parent:await page.getByText('Workflow #120 · IndMoney US Run #120 (Swing Scan)',{exact:true}).innerText()});
  await page.screenshot({path:output+'/stage-'+width+'.png',fullPage:true});
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);await writeFile(output+'/readback.json',JSON.stringify({records,errors,external},null,2));console.log('PASS: desktop/narrow labels/routes, keyboard focus, back restoration, success/failed/partial, empty/loading links, workflow/stage breadcrumbs, provider IDs; no external requests. '+output);
}finally{await browser?.close();await new Promise(r=>server?server.close(r):r());await rm(temp,{recursive:true,force:true});}

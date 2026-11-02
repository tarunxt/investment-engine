#!/usr/bin/env node
// Production components, synthetic accounts, mocked reads; every external request and mutation fails closed.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const require=createRequire(import.meta.url), root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const tmp=await mkdtemp(path.join(os.tmpdir(),'p1-workflow-'));
const evidence=process.env.P1_EVIDENCE_DIR||'/tmp/p1-workflow-evidence';
let server,browser;
try {
 await mkdir(evidence,{recursive:true});
 await writeFile(path.join(tmp,'entry.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import {WorkflowSurfaceHost,DashboardStockFlowSlot} from '${root}/app/console/_components/WorkflowSurfaceHost';import India from '${root}/app/console/zerodha/page';import US from '${root}/app/console/indmoney-us/page';import {usePathname,useRouter} from 'next/navigation';import {useAuth} from '@/hooks/useAuth';function App(){const route=usePathname();const router=useRouter();useAuth();return <WorkflowSurfaceHost><nav><button onClick={()=>router.push('/console/zerodha#india-workflow')}>Fixture India</button><button onClick={()=>router.push('/console/indmoney-us#us-workflow')}>Fixture US</button><button onClick={()=>router.push('/console/dashboard')}>Fixture Dashboard</button><button onClick={()=>window.changeOwner(43)}>Fixture account</button></nav>{route.includes('zerodha')?<India/>:route.includes('indmoney-us')?<US/>:<><h1>Dashboard existing content fixture</h1><DashboardStockFlowSlot/></>}</WorkflowSurfaceHost>}createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);`);
 await writeFile(path.join(tmp,'navigation.tsx'),`import {useSyncExternalStore} from 'react';const subscribe=cb=>{window.addEventListener('popstate',cb);return()=>window.removeEventListener('popstate',cb)};const router={push:href=>{history.pushState({},'',href);window.dispatchEvent(new Event('popstate'))},replace:href=>{history.replaceState({},'',href);window.dispatchEvent(new Event('popstate'))}};export const useRouter=()=>router;export const usePathname=()=>useSyncExternalStore(subscribe,()=>location.pathname);export const useSearchParams=()=>new URLSearchParams(location.search);`);
 await writeFile(path.join(tmp,'link.tsx'),`import React from 'react';import {useRouter} from 'next/navigation';export default function Link({href,prefetch,children,onClick,...props}){const router=useRouter();return <a {...props} href={href} onClick={e=>{e.preventDefault();router.push(href);onClick?.(e)}}>{children}</a>}`);
 await writeFile(path.join(tmp,'dynamic.tsx'),`import React,{lazy,Suspense} from 'react';export default function dynamic(loader){const Component=lazy(()=>loader().then(value=>({default:value.default||value})));return function Dynamic(props){return <Suspense fallback={<p>Loading fixture chunk…</p>}><Component {...props}/></Suspense>}}`);
 await writeFile(path.join(tmp,'auth.ts'),`import {useSyncExternalStore} from 'react';let user={id:42,is_active:true,email:'fixture@example.test',username:'fixture'};window.changeOwner=id=>{user={...user,id};window.dispatchEvent(new Event('fixture-owner'))};export function useAuth(){const current=useSyncExternalStore(cb=>{window.addEventListener('fixture-owner',cb);return()=>window.removeEventListener('fixture-owner',cb)},()=>user);return {user:current,loading:false}}`);
 await writeFile(path.join(tmp,'fx.ts'),`export const useUsdInrRate=()=>83.5;`);
 await writeFile(path.join(tmp,'api.ts'),`
 export class APIError extends Error{}; export class NetworkError extends Error{};
 window.apiCalls=[];window.forbidden=[];window.activePolls=0;window.maxActivePolls=0;
 const record=(method,args)=>window.apiCalls.push({method,args,time:performance.now()});
 const empty={latest:null,history:[]};
 const fixed={getProfile:{zerodha_buy_threshold:2.5,indmoney_buy_threshold:2.5,preferences_writable:false},zerodhaStatus:{connected:false},zerodhaLoginUrl:{configured:false,login_url:null},zerodhaPortfolioOverview:empty,indmoneyUsPortfolioOverview:empty,zerodhaThreatsLatest:null,indmoneyUsThreatsLatest:null,zerodhaThreatsHistory:{history:[]},indmoneyUsThreatsHistory:{history:[]},getAutoRebalanceHistory:{history:[],items:[],total:0},getRuns:{items:[],total:0,page:1,limit:100,pages:0},getAllFullRuns:[],zerodhaOrders:{data:[]},getApiUsageSummary:{fx_status:'valid',usd_inr_rate:83.5}};
 export const apiService=new Proxy({}, {get:(target,key)=>{
 if(key in target)return target[key];
 if(key==='getRun')return async id=>{record(key,[id]);window.activePolls++;window.maxActivePolls=Math.max(window.maxActivePolls,window.activePolls);try{await new Promise(r=>setTimeout(r,window.pollDelay||20));return {id,status:'processing',created_at:'2026-11-01T10:00:00Z',updated_at:'2026-11-01T10:00:00Z',run_jobs:[],prompt:'Market: india\\nSwing Scan',total_jobs:1,completed_jobs:0}}finally{window.activePolls--}};
 if(Object.hasOwn(fixed,key))return async(...args)=>{record(key,args);return fixed[key]};
 return async(...args)=>{record(key,args);window.forbidden.push(key);throw Error('Unexpected mocked API operation '+String(key))};
 },set:(target,key,value)=>{target[key]=value;return true}});
 `);
 await writeFile(path.join(tmp,'css.cjs'),`module.exports=function(){return 'export default {navigation:"india-navigation"}';}`);
 await writeFile(path.join(tmp,'loader.cjs'),`const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(s){return ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020},fileName:this.resourcePath}).outputText}`);
 const w=require('next/dist/compiled/webpack/webpack');
 await new Promise((resolve,reject)=>w.webpack({mode:'development',devtool:false,entry:path.join(tmp,'entry.tsx'),output:{path:tmp,filename:'bundle.js',publicPath:'/'},resolve:{extensions:['.tsx','.ts','.js'],modules:[path.join(root,'node_modules'),'node_modules'],alias:{'next/navigation$':path.join(tmp,'navigation.tsx'),'next/link$':path.join(tmp,'link.tsx'),'next/dynamic$':path.join(tmp,'dynamic.tsx'),'@/hooks/useAuth$':path.join(tmp,'auth.ts'),'@/hooks/useUsdInrRate$':path.join(tmp,'fx.ts'),'@/services/api$':path.join(tmp,'api.ts'),'@':root}},module:{rules:[{test:/\.tsx?$/,use:path.join(tmp,'loader.cjs')},{test:/\.module\.css$/,use:path.join(tmp,'css.cjs')}]},plugins:[new w.webpack.DefinePlugin({'process.env':JSON.stringify({NODE_ENV:'development'})})]},(error,stats)=>error?reject(error):stats.hasErrors()?reject(Error(stats.toString({all:false,errors:true}))):resolve()));
 server=createServer(async(req,res)=>{if(req.url.endsWith('.js')){res.setHeader('Content-Type','text/javascript');try{res.end(await readFile(path.join(tmp,path.basename(req.url))))}catch{res.statusCode=404;res.end('Missing fixture chunk')}}else{res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:Arial}table{border-collapse:collapse}td,th{padding:8px}button,a{margin:4px}section{margin-top:20px}</style><div id="root"></div><script src="/bundle.js"></script>')}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[],external=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():(external.push(route.request().url()),route.abort()));
 // Cold Dashboard Stock Flow loads without the workflow's both-market hydration or timer.
 await page.goto(origin+'/console/dashboard');await page.getByText('Rebalance Stock Flow',{exact:true}).waitFor();
 assert.equal(await page.getByRole('navigation',{name:'Automated rebalance views'}).count(),0);
 assert.equal(await page.evaluate(()=>window.apiCalls.filter(x=>x.method==='zerodhaThreatsLatest'||x.method==='getAutoRebalanceHistory').length),0);
 await page.getByRole('button',{name:'Fixture India',exact:true}).click();
 await page.getByRole('navigation',{name:'Automated rebalance views'}).waitFor();
 assert.equal(await page.locator('#india-workflow').count(),1);
 assert.equal(await page.getByText('Rebalance Stock Flow',{exact:true}).count(),0);
 assert.ok(await page.evaluate(()=>document.querySelector('#saved-portfolio-snapshots').compareDocumentPosition(document.querySelector('#india-workflow'))&Node.DOCUMENT_POSITION_FOLLOWING));
 const hydration=await page.evaluate(()=>window.apiCalls.filter(x=>x.method==='getAutoRebalanceHistory').length);
 assert.ok(hydration>=2);
 // Sibling navigation retains the one runtime; it cannot hydrate both markets again.
 await page.getByRole('button',{name:'US stage ledger',exact:true}).click();
 await page.locator('#us-workflow nav').waitFor();
 assert.equal(await page.evaluate(()=>window.apiCalls.filter(x=>x.method==='getAutoRebalanceHistory').length),hydration);
 assert.ok(await page.evaluate(()=>document.querySelector('[role="tablist"]').compareDocumentPosition(document.querySelector('#us-workflow'))&Node.DOCUMENT_POSITION_FOLLOWING));
 // Pending saved-snapshot continuation is discarded when leaving its page.
 await page.getByRole('button',{name:'Sync Now',exact:true}).click();
 await page.getByRole('dialog').waitFor();
 await page.getByRole('button',{name:'Fixture India',exact:true}).click();
 await page.locator('#india-workflow nav').waitFor();
 assert.equal(await page.getByRole('dialog').count(),0);
 await page.getByRole('button',{name:'Fixture US',exact:true}).click();await page.locator('#us-workflow nav').waitFor();
 assert.equal(await page.getByRole('dialog').count(),0);
 await page.getByRole('button',{name:'Fixture account',exact:true}).click();await page.locator('#us-workflow nav').waitFor();
 assert.ok(await page.evaluate(()=>window.apiCalls.filter(x=>x.method==='getProfile').length)>=2);
 assert.deepEqual(await page.evaluate(()=>window.forbidden),[]);
 assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
 await page.screenshot({path:path.join(evidence,'us-workflow-synthetic.png'),fullPage:true});
 const result={result:'PASS',checks:['cold Dashboard Stock Flow has no workflow hydration','one runtime across sibling navigation','both-market baseline hydration retained','India append after saved workspace','US append outside tabs','pending US dialog unmounted on navigation','account owner reconstructs configuration','no external requests or mutations'],calls:await page.evaluate(()=>window.apiCalls),errors,external,limits:['Synthetic empty saved datasets; not complete row/column and overlay-family acceptance.','Fixture Dashboard content, real Stock Flow and portfolio pages.']};
 await writeFile(path.join(evidence,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
} finally {await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(tmp,{recursive:true,force:true});}

#!/usr/bin/env node
// Mount the four production pages with read-only offline fixtures.
// Derive the reference gutter from the actual Zerodha root wrapper and shared shell.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
const require=createRequire(import.meta.url), frontend=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temporary=await mkdtemp(path.join(os.tmpdir(),'sidebar-space-'));
const output=process.env.SIDEBAR_SCREENSHOT_DIR || '/tmp/credx-page-gutters';
let browser,server;
try {
  await mkdir(output,{recursive:true});
  const routes=['runs','mails','prompts','llms'];
  const referenceSource=await readFile(path.join(frontend,'app/console/zerodha/page.tsx'),'utf8');
  const referenceClass=referenceSource.match(/<div className="(mx-auto flex flex-col gap-6)">/)[1];
  const specimenSources={
    dashboard:'app/console/dashboard/page.tsx',
    jobs:'app/console/jobs/page.tsx',
    'sports-rankings':'app/console/sports-rankings/page.tsx',
    'bullpen-ai':'app/console/bullpen-ai/_components/BullpenAiPageShell.tsx',
    bullpen008:'app/console/bullpen008/_components/Bullpen008PageShell.tsx',
    'trading-bots':'app/console/trading-bots/_components/TradingBotsOverviewPage.tsx',
    'analyse-runs':'app/console/bullpen-ai/analyse-runs/_components/RunAuditListClient.tsx',
    'analyse-events':'app/console/bullpen-ai/analyse-events/_components/TradeAnalysisListClient.tsx',
    'auto-rebalance-runs':'app/console/auto-rebalance-runs/_components/AutoRebalanceHistoryClient.tsx',
  };
  const specimens={};
  for(const [route,file]of Object.entries(specimenSources)){
    const source=await readFile(path.join(frontend,file),'utf8');
    const match=source.match(/className="([^"]*mx-auto[^"]*max-w-7xl[^"]*)"/);
    assert.ok(match,file+' wide root');specimens[route]={outer:match[1]};
  }
  for(const [route,file]of Object.entries({'bullpen-history':'app/console/bullpen-ai/_components/BullpenRunHistoryScreen.tsx','bullpen008-history':'app/console/bullpen008/_components/Bullpen008RunHistoryScreen.tsx'})){
    const source=await readFile(path.join(frontend,file),'utf8');specimens[route]={tag:'main',outer:source.match(/<main className="([^"]*)"/)[1],inner:source.match(/className="([^"]*mx-auto[^\"]*max-w-\[96rem\][^\"]*)"/)[1]};
  }
  const finalSource=await readFile(path.join(frontend,'app/console/_components/FinalActionablesConsole.tsx'),'utf8');specimens['final-actionables']={outer:'min-h-screen bg-gray-50',inner:finalSource.match(/<main className="([^"]*mx-auto[^\"]*max-w-7xl[^\"]*)"/)[1]};
  specimens['intentional-form']={outer:'mx-auto max-w-xl space-y-4 p-6',narrow:true};
  const allRoutes=[...routes,...Object.keys(specimens),'loading-shell'];
  const entries={};
  for(const mode of ['before','after']){
    const imports=[];
    for(const route of routes){
      const original=path.join(frontend,'app/console',route,'page.tsx');
      let source=mode==='before'?execFileSync('git',['show','18fa66dbbdc9de4559db106bb1c78edd8ba27d78:frontend/app/console/'+route+'/page.tsx'],{cwd:frontend,encoding:'utf8'}):await readFile(original,'utf8');
      source=source.replace(/(from\s+['"])(\.\.?\/[^'"]+)(['"])/g,(_,prefix,relative,suffix)=>prefix+path.resolve(path.dirname(original),relative)+suffix);
      const file=path.join(temporary,mode+'-'+route+'.tsx');await writeFile(file,source);imports.push("import "+route+" from '"+file+"';");
    }
    const entry=path.join(temporary,'entry-'+mode+'.tsx');
    await writeFile(entry,`import React from 'react';import {createRoot} from 'react-dom/client';import {ConsoleShell} from '${frontend}/app/console/_components/ConsoleShell';import {ConsoleShellSkeleton} from '${frontend}/app/console/_components/ConsoleShellSkeleton';${imports.join('')}const specimens=${JSON.stringify(specimens)};function Specimen({name}){const shape=specimens[name];const Root=shape.tag||'div';const contents=<section><h1>Synthetic layout {name}</h1><div className='overflow-x-auto' data-testid='sample-table' tabIndex={0}><table className='min-w-[200rem] text-sm'><tbody><tr><td>Nested table content</td></tr></tbody></table></div><form className='mx-auto max-w-xl p-6' data-testid='narrow-form'><label>Intentional form<input/></label></form></section>;return <><Root className={shape.outer}>{shape.inner?<div className={shape.inner}>{contents}</div>:contents}</Root><div className='fixed hidden'><div className='mx-auto max-w-7xl p-6' data-testid='popup-width'>Popup sizing stays separate</div></div></>}const pages={runs,mails,prompts,llms};const name=location.pathname.split('/').pop();const Page=pages[name];createRoot(document.getElementById('root')).render(name==='loading-shell'?<ConsoleShellSkeleton/>:<ConsoleShell>{Page?<Page/>:specimens[name]?<Specimen name={name}/>:<div className=${JSON.stringify(referenceClass)}><h1>Zerodha source-layout reference</h1><section className='rounded-xl border p-5'>Synthetic reference surface</section></div>}</ConsoleShell>);`);
    entries[mode]=entry;
  }
  await writeFile(path.join(temporary,'navigation.tsx'),`import {useSyncExternalStore} from 'react';export function useRouter(){return {replace:()=>{},push:()=>{}}}export function usePathname(){return useSyncExternalStore(cb=>{window.addEventListener('popstate',cb);return()=>window.removeEventListener('popstate',cb)},()=>location.pathname)}export function useSearchParams(){return new URLSearchParams(location.search)}`);
  await writeFile(path.join(temporary,'link.tsx'),`import React from 'react';export default function Link({href,prefetch,children,onClick,...props}){return <a {...props} href={href} onClick={e=>{e.preventDefault();history.pushState({},'',href);window.dispatchEvent(new Event('popstate'));onClick?.(e)}}>{children}</a>}`);
  await writeFile(path.join(temporary,'auth.ts'),`export function useAuth(){return {user:{id:42,username:'fixture',full_name:'Demo User',email:'demo@example.test'},logout:async()=>{window.logoutCalls++},loading:false,error:null}}`);
  await writeFile(path.join(temporary,'api.ts'), `export class APIError extends Error{};const stamp='2026-10-31T12:00:00Z';const scans=Array.from({length:15},(_,i)=>({job_id:100+i,run_id:200+i,scan_type:'Synthetic stage',created_at:stamp,updated_at:stamp,processing_passed:true,sheet_export_passed:false,estimated_cost:0,time_taken_ms:5000,error_message:'Synthetic export unavailable'}));export const apiService={getPrompts:async()=>[],getApiUsageSummary:async()=>({fx_status:'unavailable',usd_inr_rate:null}),getRuns:async()=>({items:[],total:0}),getBullpenAutoLiveHistory:async()=>({items:[],has_next:false}),getAutoRebalanceHistory:async(portfolio)=>({total:1,items:[{portfolio,sequence:1,label:'Synthetic '+portfolio+' Run #1',status:'completed',created_at:stamp,updated_at:stamp,stages:['sync','threats','swing','rebalance','technical','actionables'].map(stage=>({stage,status:'completed',summary:{},completed_provider_count:1,failed_provider_count:0,provider_count:1}))}]}),getLlmPerformance:async()=>({total_llms:1,total_scans:15,generated_at:stamp,groups:[{llm_key:'fixture',provider:'Synthetic',model:'Offline model',total_scans:15,processing_passed:15,processing_failed:0,sheet_export_failed:15,total_cost:0,scans,scan_summaries:[{scan_type:'Synthetic stage',total_scans:15,processing_passed:15,processing_failed:0,sheet_export_passed:0,sheet_export_failed:15,avg_time_taken_ms:5000,total_cost:0}]}]}),updateProfile:async()=>{window.fixtureWrites++;throw Error('Unexpected profile write')}}`);
  await writeFile(path.join(temporary,'loader.cjs'),`const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(s){return ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020},fileName:this.resourcePath}).outputText}`);
  const w=require('next/dist/compiled/webpack/webpack');
  await new Promise((resolve,reject)=>w.webpack({mode:'development',devtool:false,entry:entries,output:{path:temporary,filename:'bundle-[name].js'},resolve:{extensions:['.tsx','.ts','.js'],modules:[path.join(frontend,'node_modules'),'node_modules'],alias:{'next/navigation$':path.join(temporary,'navigation.tsx'),'next/link$':path.join(temporary,'link.tsx'),'@/hooks/useAuth$':path.join(temporary,'auth.ts'),'@/services/api$':path.join(temporary,'api.ts'),'@':frontend}},module:{rules:[{test:/\.tsx?$/,use:path.join(temporary,'loader.cjs')}]},plugins:[new w.webpack.DefinePlugin({'process.env':JSON.stringify({NODE_ENV:'development'})})]},(error,stats)=>error?reject(error):stats.hasErrors()?reject(Error(stats.toString({all:false,errors:true}))):resolve()));
  const css={};const cssSource=await readFile(path.join(frontend,'app/globals.css'),'utf8');for(const mode of ['before','after'])css[mode]=(await postcss([tailwind({base:frontend})]).process(mode==='before'?cssSource.replace('@import \"./console-layout.css\";',''):cssSource,{from:path.join(frontend,'app/gutters-'+mode+'.css')})).css;
  const bundles={before:await readFile(path.join(temporary,'bundle-before.js')),after:await readFile(path.join(temporary,'bundle-after.js'))};
  server=createServer((req,res)=>{if(req.url.startsWith('/bundle-')){res.setHeader('Content-Type','text/javascript');res.end(bundles[req.url.includes('before')?'before':'after'])}else {res.setHeader('Content-Type','text/html');res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css[req.url.includes('before')?'before':'after']}body{font-family:Arial,sans-serif}</style><div id="root"></div><script>window.logoutCalls=0;window.profileWrites=0</script><script src="/bundle-${req.url.includes('before')?'before':'after'}.js"></script>`)}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const page=await browser.newPage(); const errors=[],external=[];
  page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)});
  await page.route('**/*',route=>route.request().url().startsWith(base)?route.continue():(external.push(route.request().url()),route.abort()));
  await page.addInitScript(()=>{localStorage.setItem('investment-engine:theme-preference','system');localStorage.setItem('unrelated-user-preference','preserve-me')});
  await page.addInitScript(()=>{window.fixtureWrites=0;window.fetch=async(input,options)=>{if(options?.method&&options.method!=='GET'){window.fixtureWrites++;throw Error('Blocked write')}return new Response(JSON.stringify({items:[],workflow_runs:[]}),{status:200,headers:{'Content-Type':'application/json'}})}});
  const measurements=[];
  const measure=()=>page.evaluate(()=>{const shell=document.querySelector('[data-console-shell]');const root=shell.firstElementChild;const r=root.getBoundingClientRect(),c=root.firstElementChild.getBoundingClientRect(),s=shell.getBoundingClientRect(),style=getComputedStyle(root);return{left:r.left,right:r.right,width:r.width,contentLeft:c.left,contentRight:c.right,paddingLeft:style.paddingLeft,paddingRight:style.paddingRight,shellLeft:s.left,shellRight:s.right,scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth}});
  for(const width of [1996,1440,1180,1023,390]){
    await page.setViewportSize({width,height:900});await page.goto(base+'/console/zerodha?after');await page.getByRole('heading',{name:'Zerodha source-layout reference'}).waitFor();const reference=await measure();
    for(const route of allRoutes){
      const pair={width,route,reference};
      for(const mode of ['before','after']){
        await page.goto(base+'/console/'+route+'?'+mode);
        await page.locator('[data-console-shell] > :first-child').waitFor();
        if(route==='llms')await page.getByRole('heading',{name:'Synthetic / Offline model'}).waitFor();
        if(route==='runs')await page.getByRole('heading',{name:/Synthetic .* Run #1/}).first().waitFor();
        if(route==='mails')await page.getByText('No Cred-X mail attempts have been recorded yet.').waitFor();
        if(route==='prompts')await page.getByRole('heading',{name:'Prompt Library',exact:true}).waitFor();
        pair[mode]=await measure();
        if(specimens[route])await page.getByRole('heading',{name:'Synthetic layout '+route,exact:true}).waitFor();
        if(width>=1024&&mode==='after'&&!specimens[route]?.narrow){
          assert.ok(Math.abs(pair[mode].left-reference.left)<1,route+' left root gutter');assert.ok(Math.abs(pair[mode].right-reference.right)<1,route+' right root gutter');assert.ok(Math.abs(pair[mode].contentLeft-reference.left)<1,route+' inner left padding');assert.ok(Math.abs(pair[mode].contentRight-reference.right)<1,route+' inner right padding');
        }
        if(specimens[route]){
          const popupMax=await page.getByTestId('popup-width').evaluate(el=>getComputedStyle(el).maxWidth);assert.notEqual(popupMax,'none','popup max width preserved');
          const formMax=await page.getByTestId('narrow-form').evaluate(el=>getComputedStyle(el).maxWidth);assert.notEqual(formMax,'none','narrow form width preserved');
          const table=page.getByTestId('sample-table');await table.evaluate(el=>el.scrollLeft=el.scrollWidth);assert.ok(await table.evaluate(el=>el.scrollLeft>0),'internal table retains scrolling');
        }
        // Synthetic screenshots redact the page's static demonstration recipient.
        await page.evaluate(()=>{const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);while(walker.nextNode())walker.currentNode.textContent=walker.currentNode.textContent.replaceAll('tarun.singh6893@gmail.com','demo@example.test').replaceAll('Tarun Singh','Demo User')});
        if(width>=1024)assert.ok(pair[mode].scroll<=pair[mode].client,'no desktop document overflow');
        if(width===1996||width===390)await page.screenshot({path:path.join(output,mode+'-'+route+'-'+width+'.png')});
        if(route==='llms'){
          const table=page.locator('table').last(),scroller=table.locator('..');await table.scrollIntoViewIfNeeded();await scroller.evaluate(el=>el.scrollLeft=el.scrollWidth);assert.ok(await table.isVisible());assert.ok(await scroller.evaluate(el=>el.scrollWidth<=el.clientWidth||el.scrollLeft>0),'wide nested table remains scrollable');
        }
        if(route==='mails'&&mode==='after'){
          const trigger=page.getByRole('button',{name:/Stage and scan completion/});await trigger.scrollIntoViewIfNeeded();await trigger.click({force:true});const dialog=page.getByRole('dialog',{name:'Stage and scan completion',exact:true});await dialog.waitFor();const box=await dialog.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+1);await page.keyboard.press('Tab');assert.ok(await dialog.evaluate(el=>el.contains(document.activeElement)));await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
        }
        assert.equal(await page.evaluate(()=>window.fixtureWrites),0);
      }
      if(specimens[route]?.narrow)assert.deepEqual(pair.after,pair.before,'intentional narrow layout unchanged');
      if(width<1024)assert.deepEqual(pair.after,pair.before,'mobile layout unchanged for '+route);
      measurements.push(pair);
    }
  }
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);await writeFile(path.join(output,'results.json'),JSON.stringify(measurements,null,2));console.log(JSON.stringify({result:'PASS',measurements,screenshots:output},null,2));
}finally{if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(temporary,{recursive:true,force:true})}

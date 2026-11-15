#!/usr/bin/env node
// Actual run-history list with synthetic older completed runs and unbroken diagnostics.
// Compare pre-density and compact styles, with original duration-popup behavior recorded.
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
const output=process.env.DENSITY_EVIDENCE_DIR || '/tmp/credx-history-overflow-evidence';
let browser,server;
try {
  await mkdir(output,{recursive:true});
  await writeFile(path.join(temporary,'entry.tsx'), `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {ConsoleShell} from '${frontend}/app/console/_components/ConsoleShell';import {AutoRebalanceHistoryListClient} from '${frontend}/app/console/auto-rebalance-runs/_components/AutoRebalanceHistoryClient';import {StageDurationBreakdownDialog} from '${frontend}/app/console/dashboard/_components/StageDurationBreakdownDialog';function Fixture(){const[open,setOpen]=useState(false);return <ConsoleShell><AutoRebalanceHistoryListClient portfolio='zerodha'/><button onClick={()=>setOpen(true)}>Duration fixture</button><button>Underlying prompt fixture</button><StageDurationBreakdownDialog open={open} stageLabel='Synthetic duration' info={{}} now={0} onClose={()=>setOpen(false)}/></ConsoleShell>}createRoot(document.getElementById('root')).render(<Fixture/>);`);
  await writeFile(path.join(temporary,'navigation.tsx'),`import {useSyncExternalStore} from 'react';export function useRouter(){return {replace:()=>{}}}export function usePathname(){return useSyncExternalStore(cb=>{window.addEventListener('popstate',cb);return()=>window.removeEventListener('popstate',cb)},()=>location.pathname)}export function useSearchParams(){return new URLSearchParams(location.search)}`);
  await writeFile(path.join(temporary,'link.tsx'),`import React from 'react';export default function Link({href,prefetch,children,onClick,...props}){return <a {...props} href={href} onClick={e=>{e.preventDefault();history.pushState({},'',href);window.dispatchEvent(new Event('popstate'));onClick?.(e)}}>{children}</a>}`);
  await writeFile(path.join(temporary,'auth.ts'),`export function useAuth(){return {user:{id:42,username:'fixture',full_name:'Demo User',email:'demo@example.test'},logout:async()=>{window.logoutCalls++},loading:false,error:null}}`);
  await writeFile(path.join(temporary,'api.ts'), `const stamp='2026-10-31T12:00:00Z';export const apiService={getAutoRebalanceHistory:async()=>{if(location.search.includes('empty'))return{items:[]};if(location.search.includes('failed'))throw Error('Synthetic history failure');if(location.search.includes('loading'))return new Promise(()=>{});return({items:Array.from({length:12},(_,i)=>({portfolio:'india',sequence:208-i,label:'Zerodha Auto run #'+(208-i),status:i<2?'failed':'completed',error_message:i>=6?'Original unbroken diagnostic '+ 'source_reference_'.repeat(20):null,created_at:stamp,completed_at:stamp,current_stage:'actionables',total_estimated_cost:.02,stages:['sync','threats','swing','rebalance','technical','actionables'].map(stage=>({stage,status:i<2?'failed':'completed',provider_count:2,completed_provider_count:2,failed_provider_count:0,summary:{},started_at:stamp,completed_at:stamp,estimated_cost:0,error_message:i>=6?'Original provider diagnostic '+ 'source_reference_'.repeat(20):null}))}))});},updateProfile:async()=>{window.profileWrites++;throw Error('Unexpected profile write')}}`);
  await writeFile(path.join(temporary,'loader.cjs'),`const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(s){return ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020},fileName:this.resourcePath}).outputText}`);
  await writeFile(path.join(temporary,'css-loader.cjs'),`module.exports=function(s){return 'module.exports='+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z_][\\w-]*)/g)].map(m=>[m[1],m[1]])))};`);
  const w=require('next/dist/compiled/webpack/webpack');
  await new Promise((resolve,reject)=>w.webpack({mode:'development',devtool:false,entry:path.join(temporary,'entry.tsx'),output:{path:temporary,filename:'bundle.js'},resolve:{extensions:['.tsx','.ts','.js'],modules:[path.join(frontend,'node_modules'),'node_modules'],alias:{'next/navigation$':path.join(temporary,'navigation.tsx'),'next/link$':path.join(temporary,'link.tsx'),'@/hooks/useAuth$':path.join(temporary,'auth.ts'),'@/services/api$':path.join(temporary,'api.ts'),'@':frontend}},module:{rules:[{test:/\.tsx?$/,use:path.join(temporary,'loader.cjs')},{test:/\.css$/,use:path.join(temporary,'css-loader.cjs')}]},plugins:[new w.webpack.DefinePlugin({'process.env':JSON.stringify({NODE_ENV:'development'})})]},(error,stats)=>error?reject(error):stats.hasErrors()?reject(Error(stats.toString({all:false,errors:true}))):resolve()));
  const source=await readFile(path.join(frontend,'app/globals.css'),'utf8');
  const styles=await readFile(path.join(frontend,'components/BasketMetricPopup.module.css'),'utf8');
  const baselineStyles=execFileSync('git',['show','d0f071dc4d84d3b0d7cd17c0593b6230c11cac8e:frontend/components/BasketMetricPopup.module.css'],{cwd:frontend,encoding:'utf8'});
  const css={};
  for(const mode of ['before','after'])css[mode]=(await postcss([tailwind({base:frontend})]).process(mode==='before'?source.replace('@import "./desktop-density.css";',''):source,{from:path.join(frontend,'app/globals.'+mode+'.css')})).css+(mode==='before'?baselineStyles:styles).replaceAll(':global(.dark)','.dark');
  const bundle=await readFile(path.join(temporary,'bundle.js'));
  server=createServer((req,res)=>{if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle)}else {res.setHeader('Content-Type','text/html');res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css[req.url.includes('before')?'before':'after']}body{font-family:Arial,sans-serif}</style><div id="root"></div><script>window.logoutCalls=0;window.profileWrites=0</script><script src="/bundle.js"></script>`)}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const page=await browser.newPage(); const errors=[],external=[];
  page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)});
  await page.route('**/*',route=>route.request().url().startsWith(base)?route.continue():(external.push(route.request().url()),route.abort()));
  await page.addInitScript(()=>{localStorage.setItem('investment-engine:theme-preference','system');localStorage.setItem('unrelated-user-preference','preserve-me')});
  const measurements=[];
  for(const width of [1180,1165,1024,390]){
    await page.setViewportSize({width,height:757});
    for(const mode of ['before','after']){
      await page.goto(base+'/console/auto-rebalance-runs/zerodha?'+mode);
      await page.getByRole('heading',{name:'Zerodha Auto run #197',exact:true}).waitFor();
      const cards=page.locator('main a[href*="/auto-rebalance-runs/zerodha/"]');assert.equal(await cards.count(),12);
      const measure=await page.evaluate(()=>({width:innerWidth,client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,root:getComputedStyle(document.documentElement).fontSize}));
      const record={mode,...measure};measurements.push(record);
      await cards.nth(6).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,mode+'-'+width+'-completed.png')});
      if(!process.env.HISTORY_CAPTURE_BASELINE){
        assert.ok(measure.scroll<=measure.client,JSON.stringify(measure));
        for(let i=0;i<12;i++){
          const card=cards.nth(i);await card.scrollIntoViewIfNeeded();const rect=await card.boundingBox();
          const badges=card.locator('span').filter({hasText:/^(completed|failed)$/i});
          for(let j=0;j<await badges.count();j++){const badge=await badges.nth(j).boundingBox();assert.ok(badge.x>=rect.x&&badge.x+badge.width<=rect.x+rect.width+1,'badge must stay inside card');}
          if(i>=6)assert.equal(await card.getByText('Original provider diagnostic '+'source_reference_'.repeat(20),{exact:true}).count(),6,'retain every original diagnostic');
          await card.focus();assert.ok(await card.evaluate(el=>document.activeElement===el));
        }
      }
      const trigger=page.getByRole('button',{name:'Duration fixture',exact:true});await trigger.scrollIntoViewIfNeeded();await trigger.focus();await page.keyboard.press('Enter');const dialog=page.getByRole('dialog');await dialog.waitFor();
      const staysOnTrigger=await trigger.evaluate(el=>document.activeElement===el);await page.keyboard.press('Tab');const next=await page.evaluate(()=>document.activeElement.textContent);await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});record.durationFocus={staysOnTrigger,next};
    }
  }
  for(const width of [1180,390]){
    await page.setViewportSize({width,height:757});
    for(const state of ['loading','empty','failed']){
      await page.goto(base+'/console/auto-rebalance-runs/zerodha?after&'+state);
      const text=state==='loading'?'Loading runs…':state==='empty'?'No Zerodha auto-rebalance runs have been recorded yet.':'Synthetic history failure';
      await page.getByText(text,{exact:true}).waitFor();
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth));
    }
  }
  for(let i=0;i<measurements.length;i+=2)assert.deepEqual(measurements[i].durationFocus,measurements[i+1].durationFocus,'duration popup focus behavior must match pre-density baseline');
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);await writeFile(path.join(output,'results.json'),JSON.stringify(measurements,null,2));console.log(JSON.stringify({result:'PASS',measurements,screenshots:output},null,2));
}finally{if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(temporary,{recursive:true,force:true})}

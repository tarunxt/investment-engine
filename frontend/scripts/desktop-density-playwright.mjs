#!/usr/bin/env node
// Shared desktop density acceptance: actual shell, stage/history and popup components.
// Dashboard summary and dense table here are representative synthetic content;
// the separate dashboard-freshness fixture mounts the full production dashboard.
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
const output=process.env.DENSITY_EVIDENCE_DIR || '/tmp/credx-density-evidence';
let browser,server;
try {
  await mkdir(output,{recursive:true});
  await writeFile(path.join(temporary,'entry.tsx'), `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {ConsoleShell} from '${frontend}/app/console/_components/ConsoleShell';
import {STAGE_ORDER,WorkflowStageTile} from '${frontend}/components/shared/WorkflowStageTile';
import {PortfolioWorkflowHistoryCard} from '${frontend}/app/console/runs/_components/PortfolioWorkflowHistoryCard';
import {BasketMetricPopup} from '${frontend}/components/BasketMetricPopup';
import {TotalDataStatus} from '${frontend}/app/console/dashboard/_components/TotalDataStatus';
function Fixture(){const[tab,setTab]=useState('india'),[popup,setPopup]=useState(false);const stamp='2026-10-31T12:00:00Z';const info={state:'failed',runStatus:'failed',lastRunId:701,jobId:901,error:'Synthetic detailed failure: retained source evidence',passedLlms:1,totalLlms:2};return <ConsoleShell><h1 className='text-3xl font-semibold'>Dashboard</h1><p className='text-sm'>Synthetic offline density verification</p><div className='my-5 grid gap-4 sm:grid-cols-3'>{['Zerodha','INDmoney','Bullpen'].map(source=><section key={source} className='rounded-2xl border p-5'><h2 className='text-lg'>{source}</h2><strong className='text-3xl'>₹120,000</strong><TotalDataStatus info={{source:'Stored synthetic snapshot',capturedAt:stamp,complete:true}}/></section>)}</div><h2 className='my-4 text-xl'>Automated Rebalance</h2><div aria-label='Six stage workflow' role='region' tabIndex={0} className='overflow-x-auto rounded-xl pb-3 focus-visible:ring-2'><div className='grid grid-flow-col auto-cols-[minmax(17rem,1fr)] gap-4'>{STAGE_ORDER.map(stage=><WorkflowStageTile key={stage} stage={stage} info={info} now={0}/>)}</div></div><div role='tablist' aria-label='Portfolio history' className='my-4 flex gap-3'>{[['india','Zerodha history'],['us','INDmoney history']].map(([key,label])=><button key={key} role='tab' aria-selected={tab===key} className='rounded-xl border px-4 py-2 text-sm' onClick={()=>setTab(key)}>{label}</button>)}</div><div role='tabpanel'><PortfolioWorkflowHistoryCard group={{portfolio:tab,sequence:1,label:tab==='india'?'Zerodha Run #1':'INDmoney Run #1',status:'failed',created_at:stamp,updated_at:stamp,stages:STAGE_ORDER.map(stage=>({stage,status:'failed',run_id:701,job_id:901,summary:{},completed_provider_count:1,failed_provider_count:1,provider_count:2,error_message:info.error}))}} runs={[]} onOpen={()=>{}}/></div><h2 className='my-4 text-xl'>Dense table</h2><div role='region' aria-label='Dense table scroll' tabIndex={0} className='max-h-80 overflow-auto rounded-xl border focus-visible:ring-2'><table className='min-w-[92rem] w-full text-left text-sm'><thead><tr>{Array.from({length:18},(_,i)=><th key={i} className='sticky top-0 bg-muted px-3 py-3'>Column {i+1}</th>)}</tr></thead><tbody>{Array.from({length:50},(_,i)=><tr key={i}>{Array.from({length:18},(_,j)=><td key={j} className='border-t px-3 py-3'>{i+1} / {j+1} · 123.45</td>)}</tr>)}</tbody></table></div><button className='my-4 rounded-xl border px-4 py-2 text-sm' onClick={()=>setPopup(true)}>Open calculation</button>{popup&&<BasketMetricPopup title='Action Zerodha Stocks' eyebrow='Synthetic calculation' summary={{label:'Action stock quantity',value:'+3',subtitle:'Display only',status:'success',notice:'Synthetic calculation, no account action',metrics:[{label:'Quantity',value:'3'},{label:'Price',value:'100'},{label:'Amount',value:'300'}]}} onClose={()=>setPopup(false)}><p>Original synthetic source evidence</p><table><tbody><tr><td>Source</td><td>Stored fixture</td></tr></tbody></table></BasketMetricPopup>}</ConsoleShell>};createRoot(document.getElementById('root')).render(<Fixture/>);`);
  await writeFile(path.join(temporary,'navigation.tsx'),`import {useSyncExternalStore} from 'react';export function useRouter(){return {replace:()=>{}}}export function usePathname(){return useSyncExternalStore(cb=>{window.addEventListener('popstate',cb);return()=>window.removeEventListener('popstate',cb)},()=>location.pathname)}export function useSearchParams(){return new URLSearchParams(location.search)}`);
  await writeFile(path.join(temporary,'link.tsx'),`import React from 'react';export default function Link({href,prefetch,children,onClick,...props}){return <a {...props} href={href} onClick={e=>{e.preventDefault();history.pushState({},'',href);window.dispatchEvent(new Event('popstate'));onClick?.(e)}}>{children}</a>}`);
  await writeFile(path.join(temporary,'auth.ts'),`export function useAuth(){return {user:{id:42,username:'fixture',full_name:'Demo User',email:'demo@example.test'},logout:async()=>{window.logoutCalls++},loading:false,error:null}}`);
  await writeFile(path.join(temporary,'api.ts'),`export const apiService={updateProfile:async()=>{window.profileWrites++;throw Error('Unexpected profile write')}}`);
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
  server=createServer((req,res)=>{if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle)}else {res.setHeader('Content-Type','text/html');res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css[req.url.includes('before')?'before':'after']}body{font-family:Arial,sans-serif}</style><div id="root"></div><script>window.logoutCalls=0;window.profileWrites=0</script><script src="/bundle.js"></script>`)}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const page=await browser.newPage(); const errors=[],external=[];
  page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)});
  await page.route('**/*',route=>route.request().url().startsWith(base)?route.continue():(external.push(route.request().url()),route.abort()));
  await page.addInitScript(()=>{localStorage.setItem('investment-engine:theme-preference','system');localStorage.setItem('unrelated-user-preference','preserve-me')});
  const measurements=[];
  for(const width of [1996,1165,1024,1023,390]){
    await page.setViewportSize({width,height:900});
    const metrics={};
    for(const mode of ['before','after']){
      await page.goto(base+'/console/dashboard?'+mode);
      await page.getByRole('heading',{name:'Dashboard',exact:true}).waitFor();
      const open=page.getByRole('button',{name:'Open navigation'});if(await open.isVisible())await open.click();
      const nav=page.getByRole('navigation',{name:'Console navigation'});await nav.waitFor();
      metrics[mode]=await page.evaluate(()=>({root:parseFloat(getComputedStyle(document.documentElement).fontSize),zoom:getComputedStyle(document.documentElement).zoom,sidebar:document.querySelector('nav').closest('.fixed').getBoundingClientRect().width,text:parseFloat(getComputedStyle(document.querySelector('main p')).fontSize),bodyScroll:document.documentElement.scrollWidth,viewport:innerWidth}));
      assert.equal(metrics[mode].zoom,'1');assert.ok(metrics[mode].bodyScroll<=width,'no page-level horizontal overflow');
      if(width<1024){await nav.locator('xpath=ancestor::div[contains(@class,"fixed")][1]').locator('button').first().click();}
      await page.screenshot({path:path.join(output,mode+'-'+width+'-dashboard.png')});
      for(const name of ['Six stage workflow','Zerodha Run #1 six stages; scroll horizontally']){
        const region=page.getByRole('region',{name,exact:true});assert.equal(await region.locator('article').count(),6);
        await region.scrollIntoViewIfNeeded();await region.focus();await page.keyboard.press('End');
        await region.evaluate(el=>el.scrollLeft=el.scrollWidth);
        const last=await region.locator('article').last().boundingBox(),r=await region.boundingBox();assert.ok(last.x+last.width<=r.x+r.width+1,'sixth card reachable without clipping');
      }
      for(const tab of ['Zerodha history','INDmoney history']){
        await page.getByRole('tab',{name:tab}).click({force:true});const panel=page.getByRole('tabpanel');assert.equal(await panel.locator('article').count(),6);
        const error=panel.getByRole('button',{name:/Show error details/}).last();await error.scrollIntoViewIfNeeded();await error.focus();await page.keyboard.press('Enter');
        const dialog=page.getByRole('dialog');await dialog.waitFor();const rect=await dialog.boundingBox();assert.ok(rect.x>=0&&rect.y>=0&&rect.x+rect.width<=width+1&&rect.y+rect.height<=901);await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});assert.ok(await error.evaluate(el=>el===document.activeElement));
      }
      const table=page.getByRole('region',{name:'Dense table scroll'});await table.scrollIntoViewIfNeeded();await table.focus();await page.keyboard.press('ArrowRight');await table.evaluate(el=>{el.scrollLeft=el.scrollWidth;el.scrollTop=el.scrollHeight});assert.ok(await table.evaluate(el=>el.scrollTop>0));
      await page.getByRole('button',{name:'Open calculation'}).click({force:true});let popup=page.getByRole('dialog',{name:'Action Zerodha Stocks',exact:true});await popup.waitFor();let rect=await popup.boundingBox();metrics[mode].popup={width:rect.width,height:rect.height,eyebrow:await popup.locator('p').first().evaluate(el=>getComputedStyle(el).fontSize)};assert.ok(rect.x>=0&&rect.y>=0&&rect.x+rect.width<=width+1&&rect.y+rect.height<=901);
      await popup.getByRole('button',{name:'Calculation details',exact:true}).click();const nested=page.getByRole('dialog',{name:'Behind the number',exact:true});await nested.waitFor();rect=await nested.boundingBox();assert.ok(rect.x>=0&&rect.x+rect.width<=width+1);await page.keyboard.press('Tab');assert.ok(await nested.evaluate(el=>el.contains(document.activeElement)));await page.screenshot({path:path.join(output,mode+'-'+width+'-nested-popup.png')});await page.keyboard.press('Escape');await nested.waitFor({state:'detached'});await page.keyboard.press('Escape');await popup.waitFor({state:'detached'});
      assert.equal(await page.evaluate(()=>window.profileWrites+window.logoutCalls),0);
    }
    
    if(width>=1024){assert.ok(Math.abs(metrics.after.sidebar/metrics.before.sidebar-.67)<.01);assert.ok(metrics.after.text>=11)}else assert.deepEqual(metrics.after,metrics.before,'mobile sizing unchanged');
    measurements.push({width,...metrics});
  }
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);await writeFile(path.join(output,'results.json'),JSON.stringify(measurements,null,2));console.log(JSON.stringify({result:'PASS',measurements,screenshots:output},null,2));
}finally{if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(temporary,{recursive:true,force:true})}

import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
const require=createRequire(import.meta.url),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=await mkdtemp(path.join(os.tmpdir(),'report-refresh-')),output=process.env.REPORT_REFRESH_EVIDENCE_DIR||'/tmp/report-refresh-evidence';
let browser,server;
try {
 await mkdir(output,{recursive:true});
 await writeFile(temp+'/entry.tsx',`import React from 'react';import{createRoot}from'react-dom/client';import Runs from '@/app/console/runs/page';import Llms from '@/app/console/llms/page';const Page=location.pathname.includes('llms')?Llms:Runs;createRoot(document.getElementById('root')).render(<main style={{padding:16}}><Page/></main>);`);
 await writeFile(temp+'/fixture.ts',`const params=new URLSearchParams(location.search);window.fixture={phase:params.get('state')||'loading',pending:[]};const group=portfolio=>({portfolio,sequence:7,label:portfolio+' saved workflow 7',status:window.fixture.phase==='partial'?'partial':'completed',created_at:'2026-11-01T00:00:00Z',updated_at:'2026-11-01T00:00:00Z',stages:window.fixture.phase==='partial'?[{stage:'swing',run_id:42,status:'partial',summary:{},provider_count:2,completed_provider_count:1,partial_provider_count:1,failed_provider_count:0}]:[]});const result=portfolio=>({items:window.fixture.phase==='empty'?[]:[group(portfolio)],total:window.fixture.phase==='empty'?0:1});export const apiService={getLlmPerformance:()=>window.fixture.phase==='refresh'?new Promise((resolve,reject)=>window.fixture.pending.push({resolve:()=>resolve({total_llms:0,total_scans:0,groups:[]}),reject})):Promise.resolve({total_llms:0,total_scans:0,groups:[]}),getRuns:async()=>({items:[],pages:1}),getAutoRebalanceHistory:async portfolio=>{if(window.fixture.phase==='loading'||window.fixture.phase==='refresh')return new Promise((resolve,reject)=>window.fixture.pending.push({resolve:()=>resolve(result(portfolio)),reject}));if(window.fixture.phase==='error')throw Error('Synthetic unavailable history');return result(portfolio)},getBullpenAutoLiveHistory:async()=>({items:[],pages:1})};export class APIError extends Error{}`);
 await writeFile(temp+'/navigation.ts',`const router={replace:(path)=>history.replaceState({},'',path),push:(path)=>{history.pushState({},'',path);window.dispatchEvent(new Event('fixture-detail'))}};export function useRouter(){return router}export function useSearchParams(){return new URLSearchParams(location.search)}`);
 await writeFile(temp+'/link.tsx',`import React from'react';export default function Link({href,children,prefetch,...props}){return <a href={href} {...props}>{children}</a>}`);
 await writeFile(temp+'/fx.ts',`export const useUsdInrRate=()=>0;`);
 await writeFile(temp+'/context.ts',`export const INDIA_TIMEZONE='Asia/Kolkata';`);
 await writeFile(temp+'/loader.cjs',`const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(s){return ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020},fileName:this.resourcePath}).outputText}`);
 const w=require('next/dist/compiled/webpack/webpack');
 await new Promise((resolve,reject)=>w.webpack({mode:'development',devtool:false,entry:temp+'/entry.tsx',output:{path:temp,filename:'bundle.js'},resolve:{extensions:['.tsx','.ts','.js'],modules:[root+'/node_modules'],alias:{'@/hooks/useUsdInrRate$':temp+'/fx.ts','next/navigation$':temp+'/navigation.ts','next/link$':temp+'/link.tsx','@/services/api$':temp+'/fixture.ts',[root+'/app/console/dashboard/_context']:temp+'/context.ts','@':root}},module:{rules:[{test:/\.tsx?$/,use:temp+'/loader.cjs'}]},plugins:[new w.webpack.DefinePlugin({'process.env':JSON.stringify({NODE_ENV:'development'})})]},(e,s)=>e?reject(e):s.hasErrors()?reject(Error(s.toString({all:false,errors:true}))):resolve()));
 const css=(await postcss([tailwind({base:root})]).process(await readFile(root+'/app/globals.css','utf8'),{from:root+'/app/globals.css'})).css;
 const bundle=await readFile(temp+'/bundle.js');server=createServer((req,res)=>{if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript; charset=utf-8');res.end(bundle)}else {res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style><div id="root"></div><script src="/bundle.js"></script>')}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});const page=await browser.newPage({deviceScaleFactor:1});const errors=[],external=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>r.request().url().startsWith(base)?r.continue():(external.push(r.request().url()),r.abort()));
 const readback=[];
 for(const theme of ['light','dark']) for(const [width,zoom] of [[1180,1],[390,1],[1180,2]]) {
  await page.setViewportSize({width,height:757});
  const pair=[];
  for(const report of ['runs','llms']) {
   await page.goto(base+'/console/'+report+'?state=empty');
   await page.evaluate(({theme,zoom})=>{document.documentElement.classList.toggle('dark',theme==='dark');document.documentElement.style.zoom=zoom;},{theme,zoom});
   const button=page.getByRole('button',{name:'Refresh',exact:true});await button.waitFor();
   await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Refresh'&&!b.disabled));
   const style=async()=>{await page.waitForTimeout(250);return button.evaluate(el=>{const s=getComputedStyle(el),i=getComputedStyle(el.querySelector('svg'));return {radius:s.borderRadius,height:s.height,fontSize:s.fontSize,weight:s.fontWeight,tracking:s.letterSpacing,transform:s.textTransform,shadow:s.boxShadow,color:s.color,borderColor:s.borderColor,background:s.backgroundColor,gap:s.gap,iconWidth:i.width,iconHeight:i.height};});};
   await page.mouse.move(0,0);await button.evaluate(el=>el.blur());
   pair.push(await style());
   const defaultImage=await button.screenshot({path:output+'/'+theme+'-'+width+'-'+zoom+'-'+report+'-default.png',animations:'disabled'});
   if(process.env.REPORT_REFRESH_BASELINE) continue;
   await button.hover();await page.screenshot({path:output+'/'+theme+'-'+width+'-'+zoom+'-'+report+'-hover.png'});pair.push(await style());
   await page.mouse.move(0,0);await button.evaluate(el=>el.blur());
   await page.keyboard.press('Tab');await button.focus();assert.ok(await button.evaluate(el=>document.activeElement===el));
   assert.equal(await button.evaluate(el=>el.matches(':focus-visible')),true);
   await page.screenshot({path:output+'/'+theme+'-'+width+'-'+zoom+'-'+report+'-focus.png'});pair.push(await style());
   await page.evaluate(()=>window.fixture.phase='refresh');
   await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('button[data-variant="outline"]').disabled);
   assert.equal(await button.isDisabled(),true);assert.ok(await button.locator('svg').evaluate(el=>getComputedStyle(el).animationName!=='none'));
   pair.push(await style());
   const count=await page.evaluate(()=>window.fixture.pending.length);await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>window.fixture.pending.length),count);
   await page.screenshot({path:output+'/'+theme+'-'+width+'-'+zoom+'-'+report+'-loading.png'});
   await page.evaluate(()=>{window.fixture.phase='empty';window.fixture.pending.forEach(p=>p.resolve())});
   await page.waitForFunction(()=>!document.querySelector('button[data-variant="outline"]').disabled);
   await button.evaluate(el=>el.blur());await page.mouse.move(0,0);
   assert.deepEqual(await button.screenshot({animations:'disabled'}),defaultImage,'default appearance must return after refresh');
   // A second refresh fails; keyboard retry must recover with no duplicate requests.
   await page.evaluate(()=>{window.fixture.phase='refresh';window.fixture.pending=[]});await button.click();
   assert.ok(await button.isDisabled());await page.evaluate(()=>window.fixture.pending.forEach(p=>p.reject?.(new Error('Synthetic refresh failure'))));
   await page.getByText(/Synthetic refresh failure/).first().waitFor();assert.ok(await button.isEnabled());
   await page.evaluate(()=>{window.fixture.phase='refresh';window.fixture.pending=[]});await button.focus();await page.keyboard.press('Enter');assert.ok(await button.isDisabled());
   await page.evaluate(()=>{window.fixture.phase='empty';window.fixture.pending.forEach(p=>p.resolve())});await page.waitForFunction(()=>!document.querySelector('button[data-variant="outline"]').disabled);
   assert.equal(await page.getByText(/Synthetic refresh failure/).count(),0);
   // Reload during another pending refresh proves the route can remount safely.
   await page.evaluate(()=>{window.fixture.phase='refresh';window.fixture.pending=[]});await button.click();assert.ok(await button.isDisabled());
   await page.reload();await button.waitFor();await page.waitForFunction(()=>!document.querySelector('button[data-variant="outline"]').disabled);
  }
  if(!process.env.REPORT_REFRESH_BASELINE) for(let state=0;state<4;state++) assert.deepEqual(pair[state],pair[state+4]);readback.push({theme,width,zoom,styles:pair});
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);await writeFile(output+'/readback.json',JSON.stringify(readback,null,2));console.log('PASS report refresh matrix: '+readback.length+' theme/viewport/zoom pairs, equal computed styles, hover, keyboard, loading, duplicate prevention; synthetic APIs only. '+output);
}finally{await browser?.close();await new Promise(r=>server?server.close(r):r());await rm(temp,{recursive:true,force:true});}

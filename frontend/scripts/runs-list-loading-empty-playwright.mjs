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
const temp=await mkdtemp(path.join(os.tmpdir(),'runs-list-')),output=process.env.RUNS_LIST_EVIDENCE_DIR||'/tmp/credx-runs-list-evidence';
let browser,server;
try {
 await mkdir(output,{recursive:true});
 await writeFile(temp+'/entry.tsx',`import React from 'react';import{createRoot}from'react-dom/client';import Page from '@/app/console/runs/page';createRoot(document.getElementById('root')).render(<main style={{padding:16}}><Page/></main>);`);
 await writeFile(temp+'/fixture.ts',`const params=new URLSearchParams(location.search);window.fixture={phase:params.get('state')||'loading',pending:[]};const group=portfolio=>({portfolio,sequence:7,label:portfolio+' saved workflow 7',status:window.fixture.phase==='partial'?'partial':'completed',created_at:'2026-11-01T00:00:00Z',updated_at:'2026-11-01T00:00:00Z',stages:window.fixture.phase==='partial'?[{stage:'swing',run_id:42,status:'partial',summary:{},provider_count:2,completed_provider_count:1,partial_provider_count:1,failed_provider_count:0}]:[]});const result=portfolio=>({items:window.fixture.phase==='empty'?[]:[group(portfolio)],total:window.fixture.phase==='empty'?0:1});export const apiService={getRuns:async()=>({items:[],pages:1}),getAutoRebalanceHistory:async portfolio=>{if(window.fixture.phase==='loading'||window.fixture.phase==='refresh')return new Promise((resolve,reject)=>window.fixture.pending.push({resolve:()=>resolve(result(portfolio)),reject}));if(window.fixture.phase==='error')throw Error('Synthetic unavailable history');return result(portfolio)},getBullpenAutoLiveHistory:async()=>({items:[],pages:1})};export class APIError extends Error{}`);
 await writeFile(temp+'/navigation.ts',`const router={replace:(path)=>history.replaceState({},'',path),push:(path)=>{history.pushState({},'',path);window.dispatchEvent(new Event('fixture-detail'))}};export function useRouter(){return router}export function useSearchParams(){return new URLSearchParams(location.search)}`);
 await writeFile(temp+'/link.tsx',`import React from'react';export default function Link({href,children,prefetch,...props}){return <a href={href} {...props}>{children}</a>}`);
 await writeFile(temp+'/context.ts',`export const INDIA_TIMEZONE='Asia/Kolkata';`);
 await writeFile(temp+'/loader.cjs',`const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(s){return ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020},fileName:this.resourcePath}).outputText}`);
 const w=require('next/dist/compiled/webpack/webpack');
 await new Promise((resolve,reject)=>w.webpack({mode:'development',devtool:false,entry:temp+'/entry.tsx',output:{path:temp,filename:'bundle.js'},resolve:{extensions:['.tsx','.ts','.js'],modules:[root+'/node_modules'],alias:{'next/navigation$':temp+'/navigation.ts','next/link$':temp+'/link.tsx','@/services/api$':temp+'/fixture.ts',[root+'/app/console/dashboard/_context']:temp+'/context.ts','@':root}},module:{rules:[{test:/\.tsx?$/,use:temp+'/loader.cjs'}]},plugins:[new w.webpack.DefinePlugin({'process.env':JSON.stringify({NODE_ENV:'development'})})]},(e,s)=>e?reject(e):s.hasErrors()?reject(Error(s.toString({all:false,errors:true}))):resolve()));
 const css=(await postcss([tailwind({base:root})]).process(await readFile(root+'/app/globals.css','utf8'),{from:root+'/app/globals.css'})).css;
 const bundle=await readFile(temp+'/bundle.js');server=createServer((req,res)=>{if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript; charset=utf-8');res.end(bundle)}else {res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style><div id="root"></div><script src="/bundle.js"></script>')}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox']});const page=await browser.newPage({deviceScaleFactor:1});const errors=[],external=[],records=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>r.request().url().startsWith(base)?r.continue():(external.push(r.request().url()),r.abort()));
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000});
  for(const state of ['loading','empty','populated','error','partial']){
   await page.goto(base+'/console/runs?state='+state+'&tab=indmoney');
   await page.getByRole('heading',{name:'Run History'}).waitFor();
   if(state==='empty')await page.getByText('No results',{exact:true}).waitFor();
   if(state==='populated'||state==='partial')await page.getByText('indmoney_us saved workflow 7',{exact:false}).first().waitFor();
   if(state==='error')await page.getByText('Results unavailable',{exact:true}).waitFor();
   if(state==='loading'){await page.getByText('Loading results…',{exact:true}).waitFor();assert.equal(await page.getByText('No results',{exact:true}).count(),0);assert.match(await page.getByRole('tab',{name:/IndMoney Runs/}).innerText(),/—/);}
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   await page.screenshot({path:output+'/'+state+'-'+width+'.png',fullPage:true});
   records.push({width,state,zoom:await page.evaluate(()=>devicePixelRatio),text:await page.locator('main').innerText()});
  }
  await page.goto(base+'/console/runs?state=populated&tab=zerodha');
  const tab=page.getByRole('tab',{name:/Zerodha/});await tab.focus();await page.keyboard.press('Enter');assert.equal(await tab.getAttribute('aria-selected'),'true');
  await page.getByText('india saved workflow 7',{exact:false}).first().waitFor();
  await page.evaluate(()=>{window.fixture.phase='refresh'});await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await page.getByRole('status').waitFor();assert.ok((await page.locator('main').innerText()).includes('india saved workflow 7'));assert.equal(await tab.getAttribute('aria-selected'),'true');
  await page.screenshot({path:output+'/retained-refresh-'+width+'.png',fullPage:true});
  await tab.focus();await page.evaluate(()=>{window.fixture.phase='populated';window.fixture.pending.forEach(p=>p.resolve())});assert.ok(await tab.evaluate(el=>document.activeElement===el));await page.getByRole('button',{name:'Refresh',exact:true}).waitFor({state:'visible'});
  // Browser Back returns to the filtered Runs URL; actual component remount reads the retained query.
  await page.evaluate(()=>{history.pushState({},'','/fixture-detail')});await page.goBack();assert.match(page.url(),/tab=zerodha/);assert.equal(await tab.getAttribute('aria-selected'),'true');
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);const result={timestamp:new Date().toISOString(),records,errors,external,checks:['actual RunsPage','desktop 100%','narrow 390px no overflow','keyboard tab selection','retained category, keyboard focus and saved records on refresh','Back URL/category restoration']};await writeFile(output+'/readback.json',JSON.stringify(result,null,2));assert.equal(JSON.parse(await readFile(output+'/readback.json','utf8')).records.length,10);console.log('PASS '+output);
}finally{await browser?.close();await new Promise(r=>server?server.close(r):r());await rm(temp,{recursive:true,force:true});}

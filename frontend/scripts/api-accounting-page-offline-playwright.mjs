// A12-002 actual API page: delayed/failed/empty/stale provider lifecycle. Synthetic reads only.
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,readFile,mkdir,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
const require=createRequire(import.meta.url), frontend=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=await mkdtemp(path.join(os.tmpdir(),'audit6-api-cost-history-')), output=process.env.A12_PAGE_EVIDENCE_DIR||'/tmp/a12-api-page-evidence';
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


const settle = (index, data, fail=false) => page.evaluate(({index,data,fail}) => window.requests[index][fail?'reject':'resolve'](fail?Error(data):data), {index,data,fail});
const history = (provider, cost=.125) => ({provider,name:provider,timezone:'Asia/Kolkata',fx_status:'stale',usd_inr_rate:null,days:[{date:'2026-11-01',estimated_cost:cost,estimated_cost_inr:null,requests:1,tokens_in:100,tokens_out:0}],runs:[],coverage_note:'Synthetic tariff estimate; billed completeness unknown'});
const trend = page.getByRole('region', {name:'LLM cost trend',exact:true});
const point = provider => trend.getByRole('button',{name:new RegExp('Show exact value for '+provider+' ')});
try {
 for (const width of [1180,375]) {
  await page.setViewportSize({width,height:900});
  await page.goto(base);
  await page.waitForFunction(()=>requests.length===5);
  await settle(0,{timezone:'Asia/Kolkata',items:[],fx_status:'stale'});
  await trend.getByText('Loading combined LLM cost chart...', {exact:true}).waitFor();
  // Resolve only OpenAI: three peers remain pending. Its line must be usable.
  await settle(1,history('openai'));
  await point('OpenAI').waitFor();
  await point('OpenAI').focus(); await page.keyboard.press('Enter');
  await trend.getByText('Exact value: $0.125000',{exact:true}).waitFor();
  assert.equal(await point('DeepSeek').count(),0);
  for (const provider of ['OpenAI','Anthropic','Gemini','DeepSeek']) {
   assert.equal(await trend.getByRole('checkbox',{name:provider,exact:true}).count(),1);
  }
  const openai = trend.getByRole('checkbox',{name:'OpenAI',exact:true});
  await openai.focus(); await page.keyboard.press('Space');
  assert.equal(await point('OpenAI').count(),0);
  await page.keyboard.press('Space'); await point('OpenAI').waitFor();
  await settle(2,'Synthetic Anthropic failure',true);
  await trend.getByRole('alert').waitFor();
  await point('OpenAI').waitFor();
  await settle(3,{...history('gemini'),days:[]});
  await settle(4,history('deepseek',.25));
  await point('DeepSeek').waitFor();
  const retry = trend.getByRole('button',{name:'Retry cost trend',exact:true});
  await retry.waitFor();
  await retry.focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(()=>requests.length===9);
  // Existing lines stay visible while one refresh fails and peers are pending.
  await settle(5,'Synthetic OpenAI refresh failure',true);
  await point('OpenAI').waitFor();
  await trend.getByRole('alert').waitFor();
  await settle(6,history('anthropic',.5));
  await point('Anthropic').waitFor();
  await settle(7,{...history('gemini'),days:[]});
  await settle(8,history('deepseek',.375));
  await point('DeepSeek').waitFor();
  assert.match(await trend.textContent(),/previously loaded; retry failed/);
  await point('OpenAI').focus(); await page.keyboard.press('Enter');
  await trend.getByText('Exact value: $0.125000',{exact:true}).waitFor();
  await page.screenshot({path:path.join(output,`provider-lifecycle-${width}.png`),fullPage:false});
  assert.equal(await page.evaluate(()=>writes),0);
 }
 assert.deepEqual(errors,[]); assert.deepEqual(external,[]);
 await writeFile(path.join(output,'result.json'),JSON.stringify({actualComponents:['ApisPage','CombinedLlmCostChart'],widths:[1180,375],delayedProviderIndependent:true,keyboardControls:4,partialFailure:true,emptyProvider:true,staleRetention:true,writes:0,external,errors},null,2));
 console.log('PASS actual API page: independent delayed-provider rendering, four keyboard controls, partial failure, empty provider, retry and stale retention at 1180/375; zero writes/external/errors. '+output);
} finally {await browser.close();server.close();await rm(temp,{recursive:true,force:true})}

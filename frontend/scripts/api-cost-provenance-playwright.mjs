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
await writeFile(path.join(temp,'entry.tsx'),`import React from 'react';import{createRoot}from'react-dom/client';import Page from '${frontend}/app/console/apis/page';createRoot(document.getElementById('root')).render(<Page/>);`);
await writeFile(path.join(temp,'api.ts'),`const read=(kind,params)=>new Promise((resolve,reject)=>{window.requests.push({kind,params,resolve,reject})});export const apiService={getApiUsageSummary:(params)=>read('usage',params),getLlmCostHistory:(params)=>read('history',params),post:()=>{window.writes++;throw Error('Blocked write')}};`);
await writeFile(path.join(temp,'link.tsx'),`import React from 'react';export default function Link({children,href,...props}){return <a href={href} {...props}>{children}</a>}`);
await writeFile(path.join(temp,'nav.ts'),`export const usePathname=()=>'/console/profile/cost-drivers';`);
await writeFile(path.join(temp,'loader.cjs'),`const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(s){return ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020},fileName:this.resourcePath}).outputText}`);
const w=require('next/dist/compiled/webpack/webpack');
await new Promise((resolve,reject)=>w.webpack({mode:'development',devtool:false,entry:path.join(temp,'entry.tsx'),output:{path:temp,filename:'bundle.js'},resolve:{extensions:['.tsx','.ts','.js'],modules:[path.join(frontend,'node_modules')],alias:{'next/link$':path.join(temp,'link.tsx'),'next/navigation$':path.join(temp,'nav.ts'),'@/services/api$':path.join(temp,'api.ts'),'@':frontend}},module:{rules:[{test:/\.tsx?$/,use:path.join(temp,'loader.cjs')}]},plugins:[new w.webpack.DefinePlugin({'process.env':JSON.stringify({NODE_ENV:'development'})})]},(error,stats)=>error?reject(error):stats.hasErrors()?reject(Error(stats.toString({all:false,errors:true}))):resolve()));
const css=(await postcss([tailwind({base:frontend})]).process(await readFile(path.join(frontend,'app/globals.css'),'utf8'),{from:path.join(frontend,'app/globals.css')})).css;
const bundle=await readFile(path.join(temp,'bundle.js'));const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'text/javascript':'text/html');res.end(req.url==='/bundle.js'?bundle:`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}body{font-family:Arial;padding:24px}</style><div id="root"></div><script>window.requests=[];window.writes=0;</script><script src="/bundle.js"></script>`)});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':chromium.executablePath()),args:['--no-sandbox']});
const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>r.request().url().startsWith(base)?r.continue():r.abort());
const providers=['openai','anthropic','gemini','deepseek'];
const history=(provider,fx='valid',empty=false,cost=1)=>({provider,name:provider,timezone:'Asia/Kolkata',usd_inr_rate:fx==='unavailable'?null:84,fx_status:fx,fx_source:'Persisted FX fixture',fx_as_of:'2026-10-30T12:00:00Z',generated_at:'2026-10-31T12:00:00Z',coverage_note:'Provider-ledger totals take precedence over reconstructed job estimates.',days:empty?[]:[{date:'2026-10-31',estimated_cost:cost,estimated_cost_inr:fx==='valid'?cost*84:null,requests:1,tokens_in:2,tokens_out:3}],runs:[],total_runs:0});
const usage={timezone:'Asia/Kolkata',items:[],fx_status:'unavailable'};
const settle=async(index,data,fail=false)=>page.evaluate(({index,data,fail})=>{window.requests[index][fail?'reject':'resolve'](fail?Error(data):data)},{index,data,fail});
const start=async()=>{await page.goto(base);await page.waitForFunction(()=>requests.length===5);};
const settleHistories=async(startIndex,fx='valid',empty=false,cost=1)=>{for(let i=0;i<4;i++)await settle(startIndex+i,history(providers[i],fx,empty,cost));};
const chart=()=>page.locator('section').filter({has:page.getByRole('heading',{name:'Combined LLM API Cost Trend'})});
try{
for(const width of [1440,390]){
 await page.setViewportSize({width,height:900});
 await start();await page.getByText('Loading combined LLM cost chart...').waitFor();await page.screenshot({path:path.join(output,`loading-${width}.png`)});
 // A confirmed empty usage breakdown is independent of failed cost history.
 await settle(0,usage);await page.getByText('No API usage data yet.').waitFor();
 for(let i=1;i<=4;i++)await settle(i,'backend timeout after 4 seconds',true);
 await page.getByRole('button',{name:'Retry cost trend',exact:true}).waitFor();assert.equal(await page.getByText('No LLM cost history available yet.').count(),0);assert.equal(await chart().getByRole('img').count(),0);
 await page.screenshot({path:path.join(output,`failed-${width}.png`)});
 await page.getByRole('button',{name:'Retry cost trend',exact:true}).focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>requests.length===9);assert.equal(await page.evaluate(()=>requests.filter(r=>r.kind==='usage').length),1);
 await settleHistories(5);await chart().getByRole('img').waitFor();await chart().getByText('Cost (INR)',{exact:true}).waitFor();assert.equal(await page.getByText('No API usage data yet.').count(),1);assert.equal(await chart().getByRole('alert').count(),0);await page.screenshot({path:path.join(output,`success-${width}.png`)});
 // A failed refresh retains and explicitly marks prior history.
 await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.waitForFunction(()=>requests.length===14);await settle(9,usage);for(let i=10;i<14;i++)await settle(i,'timeout',true);await chart().locator('summary').click();await page.getByText('previously loaded; retry failed',{exact:false}).first().waitFor();assert.equal(await chart().getByRole('img').count(),1);await page.screenshot({path:path.join(output,`stale-history-${width}.png`)});
 assert.equal(await page.evaluate(()=>writes),0);
}
await start();await settle(0,usage);await settleHistories(1,'valid',true);await page.getByText('No LLM cost history available yet.').waitFor();assert.equal(await chart().getByRole('alert').count(),0);
// Unknown FX does not discard native costs, and mixed provider conversions never share an INR axis.
for(const fx of ['stale','unavailable']){
 await start();await settle(0,usage);await settle(1,history('openai'));await settle(2,history('anthropic',fx));await settle(3,history('gemini'));await settle(4,history('deepseek'));await chart().getByText('Cost (USD)',{exact:true}).waitFor();await chart().locator('summary').click();assert.ok(await chart().getByText('native USD retained',{exact:false}).count()>0);assert.ok(await chart().getByText('Persisted FX fixture',{exact:false}).count()>0);assert.equal(await chart().getByText('Cost (INR)',{exact:true}).count(),0);
 await chart().getByRole('button',{name:'Show exact value for Anthropic 31 Oct: $1.000000'}).focus();await page.keyboard.press('Enter');await chart().getByText('Exact value: $1.000000').waitFor();await page.screenshot({path:path.join(output,`mixed-${fx}.png`)});
}
// One failed provider cannot hide the other providers or invent a zero-valued line.
await start();await settle(0,usage);await settle(1,'timeout',true);for(let i=2;i<=4;i++)await settle(i,history(providers[i-1]));await chart().getByRole('img').waitFor();await page.getByRole('button',{name:'Retry cost trend',exact:true}).waitFor();assert.equal(await chart().getByRole('button',{name:/Show exact value for OpenAI/}).count(),0);assert.equal(await page.getByText('No LLM cost history available yet.').count(),0);
await page.screenshot({path:path.join(output,'partial-failure.png')});
// Newest refresh wins even when older promises settle last.
await start();await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.waitForFunction(()=>requests.length===10);await settle(5,usage);await settleHistories(6,'valid',false,2);await chart().getByText('Cost (INR)',{exact:true}).waitFor();await settle(0,usage);await settleHistories(1,'valid',false,999);assert.equal(await chart().getByRole('button',{name:/83816/}).count(),0);await chart().getByRole('button',{name:/₹168.0000/}).first().waitFor();assert.equal(await chart().getByRole('button',{name:/₹83916.0000/}).count(),0);
// Usage failure and successful cost history are independent too.
await start();await settle(0,'usage timeout',true);await settleHistories(1);await page.getByText('API usage is unavailable. Use Refresh to retry.').waitFor();await chart().getByRole('img').waitFor();assert.equal(await page.getByText('No API usage data yet.').count(),0);
assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>writes),0);console.log('PASS: loading, independent usage/trend states, confirmed empty, failure, partial provider failure, keyboard read-only retry, INR/USD mixed/stale/unknown FX provenance, retained history, late response protection, desktop/mobile; no writes or external calls. Evidence: '+output);
}finally{await browser.close();server.close()}

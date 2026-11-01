// A6-07 offline acceptance: actual Bullpen008PageClient, synthetic read-only bootstrap/stage requests.
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
const temp=await mkdtemp(path.join(os.tmpdir(),'audit6-bullpen008-')), output=process.env.A6_BULLPEN008_EVIDENCE_DIR||'/tmp/audit6-bullpen008-evidence';
await mkdir(output,{recursive:true});
await writeFile(path.join(temp,'entry.tsx'),`import React from 'react';import{createRoot}from'react-dom/client';import{Bullpen008PageClient}from'${frontend}/app/console/bullpen008/_components/Bullpen008PageClient';createRoot(document.getElementById('root')).render(<Bullpen008PageClient/>);`);
await writeFile(path.join(temp,'api.ts'),`const read=(kind,params)=>new Promise((resolve,reject)=>{window.requests.push({kind,params,resolve,reject})});export const apiService=new Proxy({getBullpen008Bootstrap:(params)=>read('bootstrap',params),getBullpen008Stage:(...params)=>read('stage',params)},{get:(target,key)=>target[key]||(()=>{window.writes++;throw Error('Blocked non-read '+String(key))})});`);
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
const fixture=(overrides={})=>({settings:{custom_exclude_phrases:[],execution_mode:'shadow',closing_window_days:30,auto_refresh_minutes:360},state:{running:false,paused:false,emergency_stop:false,execution_mode:'shadow'},latest_run:null,inherited_runs:[],alerts:[],risk_state:{},...overrides});
const run=(overrides={})=>({id:'synthetic-run',status:'failed',stages:[],wallet_snapshot:{},...overrides});
const settle=async(index,data,fail=false)=>page.evaluate(({index,data,fail})=>{const r=window.requests[index];r.settled=true;r[fail?'reject':'resolve'](fail?Error(data):data)},{index,data,fail});
const start=async(width)=>{await page.setViewportSize({width,height:757});await page.goto(base);await page.waitForFunction(()=>requests.length===1);};
const refresh=async()=>{const n=await page.evaluate(()=>requests.length);const control=page.getByRole('button',{name:'Refresh',exact:true});await control.focus();await page.keyboard.press('Enter');await page.waitForFunction(n=>requests.length===n+1,n);return n;};
try{
for(const width of [1180,390]){
 await start(width);await page.getByLabel('Loading Bullpen 008 workspace').waitFor();assert.doesNotMatch(await page.locator('body').innerText(),/No Bullpen runs|0 positions/);
 await settle(0,'Synthetic bootstrap unavailable',true);await page.getByRole('alert').waitFor();assert.doesNotMatch(await page.locator('body').innerText(),/Idle|0 active|pending|No Bullpen runs|Start schedule|Run six stages/);await page.screenshot({path:path.join(output,`failed-${width}.png`),fullPage:true});
 const retry=page.getByRole('button',{name:'Retry',exact:true});await retry.focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>requests.length===2);await settle(1,fixture());await page.getByText('No Bullpen runs are available yet.',{exact:true}).waitFor();await page.getByText('Wallet positions unavailable — no snapshot was captured.',{exact:true}).waitFor();await page.getByText('No recorded run',{exact:false}).waitFor();assert.doesNotMatch(await page.locator('body').innerText(),/0 positions in saved/);await page.screenshot({path:path.join(output,`verified-empty-${width}.png`),fullPage:true});
 let n=await refresh();await settle(n,fixture({latest_run:run({wallet_snapshot:{positions:[],balance:{status:'ready',available_balance_usd:0}}})}));await page.getByText('0 positions in saved run snapshot',{exact:true}).waitFor();await page.getByText('No positions in the saved run snapshot.',{exact:true}).waitFor();await page.getByLabel('Stage 1 progress unavailable',{exact:true}).waitFor();
 n=await refresh();await settle(n,fixture({latest_run:run({wallet_snapshot:{positions:[{market_id:'synthetic-market',question:'Synthetic market',exposure_usd:12}],balance:{status:'ready',available_balance_usd:8}}}),alerts:[{id:1,payload:{question:'Synthetic warning'},side:'YES',breach_type:'synthetic',source:'fixture'}]}));await page.getByText('Synthetic market',{exact:true}).waitFor();await page.getByText('$20.00',{exact:true}).waitFor();
 n=await refresh();await settle(n,'Synthetic refresh unavailable',true);await page.getByText(/Showing the last successful response/).waitFor();await page.getByText('Synthetic market',{exact:true}).waitFor();await page.getByText('Synthetic warning',{exact:true}).waitFor();await page.getByText('$20.00',{exact:true}).waitFor();await page.screenshot({path:path.join(output,`cached-refresh-failed-${width}.png`),fullPage:true});
 n=await refresh();await settle(n,fixture({latest_run:run({stages:[{stage_number:4,status:'finished',duration_seconds:2,stage_version:'synthetic',outputs:{metrics:{invested:25}}}]})}));await page.waitForFunction(()=>requests.some(r=>r.kind==='stage'&&!r.settled));const detail=await page.evaluate(()=>requests.findIndex(r=>r.kind==='stage'&&!r.settled));await settle(detail,'Synthetic stage detail unavailable',true);await page.getByText('Stage 4 detail is unavailable. Target rows and certified exits cannot be verified.',{exact:true}).waitFor();await page.getByText('Target portfolio unavailable — Stage 4 detail could not be loaded.',{exact:true}).waitFor();await page.getByText('Certified exits unavailable — Stage 4 detail could not be loaded.',{exact:true}).waitFor();await page.getByText('Scan & schedule settings',{exact:true}).waitFor();await page.screenshot({path:path.join(output,`stage4-failed-${width}.png`),fullPage:true});
 n=await refresh();await settle(n,fixture({latest_run:run({status:'running'})}));await page.getByText('Risk monitoring unavailable',{exact:true}).waitFor();await page.getByText('Warning episodes are not included while a run is active.',{exact:true}).waitFor();assert.doesNotMatch(await page.locator('body').innerText(),/No Bullpen 008 warning episodes|No verified regime-change episode|No active trigger episode/);await page.screenshot({path:path.join(output,`active-monitoring-omitted-${width}.png`),fullPage:true});
 // Return to a terminal record before polling can start another fixture read.
 n=await refresh();await settle(n,fixture());await page.getByText('No Bullpen runs are available yet.',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>writes),0);assert.ok((await page.evaluate(()=>requests)).every(r=>['bootstrap','stage'].includes(r.kind)));
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);evidence.push({width,states:7,readCalls:await page.evaluate(()=>requests.length),pageOverflow:overflow});
}
assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
await writeFile(path.join(output,'result.json'),JSON.stringify({timestamp:new Date().toISOString(),actualComponent:'Bullpen008PageClient',evidence,writes:0,external,errors,limitations:['Synthetic local component verification only; no production or private report pixels reviewed.','Mutation and settings controls never activated; only bootstrap/stage getters permitted.']},null,2));console.log('PASS A6-07 actual component source states desktop/narrow keyboard Retry/Refresh; 0mutations/external/errors. '+output);
}finally{await browser.close();server.close()}

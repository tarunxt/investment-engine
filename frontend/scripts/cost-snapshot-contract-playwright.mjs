// Synthetic component lifecycle acceptance. No backend, credentials or AWS calls.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium} from 'playwright';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=await mkdtemp(path.join(os.tmpdir(),'cost-snapshot-contract-'));
await writeFile(path.join(dir,'entry.tsx'),`import React from 'react';import{createRoot}from'react-dom/client';import{CostUsageProvider,useCostUsage}from'${root}/app/console/profile/cost-drivers/CostUsageProvider';function Probe(){const c=useCostUsage();return <><p>fixture total {String(c.data.summary.monthToDateAwsCost)}</p><button onClick={()=>c.load()}>Read snapshot</button><button onClick={()=>c.load(true)}>Collect explicitly</button><button onClick={()=>c.setSelectedMonth('2026-07')}>Historical month</button></>}createRoot(document.getElementById('root')).render(<React.StrictMode><CostUsageProvider><Probe/></CostUsageProvider></React.StrictMode>);`);
await build({entryPoints:[path.join(dir,'entry.tsx')],outfile:path.join(dir,'bundle.js'),bundle:true,jsx:'automatic',nodePaths:[path.join(root,'node_modules')],define:{'process.env':JSON.stringify({NODE_ENV:'development'})},plugins:[{name:'synthetic-boundaries',setup(b){
 b.onResolve({filter:/^(next\/link|@\/components\/ui\/button|@\/services\/api|\.\/OptimizationActionCenter)$/},a=>({path:a.path,namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},a=>({loader:'jsx',resolveDir:root,contents:a.path==='@/services/api'?`export const apiService={get:url=>new Promise((resolve,reject)=>window.requests.push({method:'GET',url,resolve,reject})),post:url=>new Promise((resolve,reject)=>window.requests.push({method:'POST',url,resolve,reject}))}`:a.path==='./OptimizationActionCenter'?`export const OptimizationActionCenter=()=>null`:a.path==='next/link'?`export default function Link(p){return <a {...p}/>} `:`export function Button(p){return <button {...p}/>}`}));
 b.onResolve({filter:/^@\//},a=>({path:path.join(root,a.path.slice(2))+'.ts'}));
}}]});
const bundle=await readFile(path.join(dir,'bundle.js'));
const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'text/javascript':'text/html');res.end(req.url==='/bundle.js'?bundle:'<div id="root"></div><script>window.requests=[]</script><script src="/bundle.js"></script>')});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
const page=await browser.newPage();const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('BROWSER ERROR',e.message)});await page.route('**/*',r=>r.request().url().startsWith(base)?r.continue():r.abort());
const fixture=(overrides={})=>({summary:{monthToDateAwsCost:null},debug:{snapshotState:'not_collected',collectionOccurred:false,lastAwsRefreshTime:null,...overrides}});
const settle=async(i,data,fail=false)=>page.evaluate(({i,data,fail})=>window.requests[i][fail?'reject':'resolve'](fail?Error('synthetic failure'):data),{i,data,fail});
const waitCount=async n=>page.waitForFunction(n=>window.requests.length===n,n);
try{
 await page.goto(base);await waitCount(1);await page.getByRole('status').filter({hasText:'no AWS collection requested'}).waitFor();
 await settle(0,fixture());await page.getByText('Cost totals are unknown for this month.').waitFor();assert.match(await page.locator('body').innerText(),/not_collected.*Collection on this request: none/);
 await page.getByRole('button',{name:'Read snapshot',exact:true}).click();await waitCount(2);await settle(1,fixture({snapshotState:'stored',sourceAgeSeconds:3600,lastAwsRefreshTime:'2026-10-31T00:00:00Z',billingProvenance:{collectedAt:'2026-10-31T00:00:00Z',dataCutoff:null,complete:false,estimateState:'estimated',currency:'USD',requestedPeriod:{startInclusive:'2026-10-01',endExclusive:'2026-11-01'},meter:{requests:5}},storageExposure:{state:'partial',grossMonthlyExposureUsd:null,tariffVersion:'2026-11-01',source:'public tariff',exclusions:'Retained backups are not approved removable capacity.'}}));
 await page.getByText('Account aggregate coverage: partial;', {exact:false}).waitFor();assert.match(await page.locator('body').innerText(),/3600 seconds.*Usage data cutoff: unknown/);assert.match(await page.locator('body').innerText(),/Gross recurring exposure: unknown/);
 await page.getByRole('button',{name:'Read snapshot',exact:true}).click();await waitCount(3);assert.match(await page.locator('body').innerText(),/2026-10-31/);await settle(2,null,true);await page.getByRole('alert').waitFor();assert.match(await page.locator('body').innerText(),/2026-10-31/);
 await page.getByRole('button',{name:'Collect explicitly'}).click();await waitCount(4);assert.equal(await page.evaluate(()=>requests[3].method),'POST');await settle(3,fixture({snapshotState:'stale',servedStaleData:true,collectionOccurred:true,lastAwsRefreshTime:'2026-10-31T00:00:00Z'}));await page.getByText('Snapshot: stale.',{exact:false}).waitFor();
 await page.getByRole('button',{name:'Historical month'}).click();await waitCount(5);assert.match(await page.evaluate(()=>requests[4].url),/2026-07/);await settle(4,fixture());await page.getByText('Cost totals are unknown for this month.').waitFor();
 assert.deepEqual(await page.evaluate(()=>requests.map(r=>r.method)),['GET','GET','GET','POST','GET']);assert.deepEqual(errors,[]);
 console.log('PASS: actual provider component loading, absent, partial/estimated, source age/cutoff, unpriced storage, retained failed read, explicit collection, stale fallback and month switch; synthetic HTTP boundaries only.');
}finally{await browser.close();server.close()}

// Actual saved history error/retry UI; synthetic API fixture, no external access.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
const require=createRequire(import.meta.url);
const {build}=require(process.env.ACTIONABLES_ESBUILD_PATH||'esbuild');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=process.env.AUDIT6_FINAL_EVIDENCE_DIR||'/tmp/audit7-schema-browser';
await mkdir(out,{recursive:true});
const entry=`import React from 'react';import{createRoot}from'react-dom/client';
import{AutoRebalanceHistoryListClient}from'./app/console/auto-rebalance-runs/_components/AutoRebalanceHistoryClient';
window.__reads=0;window.__fail=true;createRoot(document.getElementById('root')).render(<AutoRebalanceHistoryListClient portfolio="zerodha"/>);`;
const result=await build({stdin:{contents:entry,resolveDir:root,loader:'tsx'},bundle:true,write:false,jsx:'automatic',tsconfig:path.join(root,'tsconfig.json'),define:{'process.env.NODE_ENV':'"development"','process.env':'{}'},plugins:[{name:'offline',setup(b){
 b.onResolve({filter:/^next\/link$/},()=>({path:'link',namespace:'mock'}));
 b.onResolve({filter:/^next\/navigation$/},()=>({path:'navigation',namespace:'mock'}));
 b.onResolve({filter:/hooks\/useUsdInrRate$/},()=>({path:'fx',namespace:'mock'}));
 b.onResolve({filter:/services\/api$/},()=>({path:'api',namespace:'mock'}));
 b.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:args.path==='link'?'import React from "react";export default ({children,...props})=>React.createElement("a",props,children);':args.path==='navigation'?'export const useRouter=()=>({push(){}});export const useSearchParams=()=>new URLSearchParams();':args.path==='fx'?'export const useUsdInrRate=()=>null;':'export const apiService=new Proxy({},{get:(_,name)=>(...args)=>{if(name!=="getAutoRebalanceHistory")throw Error("Unexpected fixture API "+name);window.__reads++;return window.__fail?Promise.reject(Error("Workflow history and policy are unavailable until the workflow schema is ready.")):Promise.resolve({items:[],total:0});}});export class APIError extends Error{};export class RequestTimeoutError extends Error{};',loader:'js',resolveDir:root}));
}}]});
const css=await postcss([tailwind()]).process(await readFile(path.join(root,'app/globals.css'),'utf8'),{from:path.join(root,'app/globals.css')});
const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'application/javascript':'text/html');res.end(req.url==='/bundle.js'?result.outputFiles[0].text:`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css.css}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`)});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||chromium.executablePath(),args:['--no-sandbox']});
const errors=[],blocked=[],evidence=[];
try{const page=await browser.newPage({viewport:{width:1180,height:757}});page.on('pageerror',e=>{errors.push(e.message);console.error(e.stack)});await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():(blocked.push(route.request().url()),route.abort()));
await page.goto(origin);
for(const width of [1180,390]){
 await page.setViewportSize({width,height:844});
 await page.getByText('Workflow history and policy are unavailable until the workflow schema is ready.',{exact:false}).waitFor();
 assert.equal(await page.getByText(/No Zerodha auto-rebalance runs/).count(),0);
 await page.getByRole('button',{name:'Refresh',exact:true}).click();
 await page.getByText('Workflow history and policy are unavailable until the workflow schema is ready.',{exact:false}).waitFor();
}
await page.evaluate(()=>window.__fail=false);
await page.getByRole('button',{name:'Refresh',exact:true}).click();
await page.getByText('No Zerodha auto-rebalance runs have been recorded yet.',{exact:true}).waitFor();
assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);assert.ok(await page.evaluate(()=>window.__reads)>=4);
console.log('PASS: actual history component unavailable branch, repeated reads, mobile/desktop, retry to verified empty; no external requests');
}finally{await browser.close();await new Promise(r=>server.close(r))}

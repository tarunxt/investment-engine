// F11: real calculations modal, synthetic saved data, no backend/provider access.
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
const out=process.env.AUDIT6_FINAL_EVIDENCE_DIR||'/tmp/audit7-f11-browser';
await mkdir(out,{recursive:true});
const entry=`import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{OpenActionablesCalculationsModal,DEFAULT_SCORE_MATRIX_FORMULA_CONFIG,buildConsensusRows}from'./app/console/_components/FinalActionablesConsole';
import{REBALANCE_HEADER_ORDER}from'./components/InvestmentRecommendationTable';
const row={'Exchange Symbol':'NSE','Stock Symbol':'SYNTHETIC','Stock Name':'Synthetic fixture','Current Units':'—','Action (Buy/Add/Sell All/Trim/Hold/Buy New)':'Buy New','Units Change':'2','Final Units':'—','Units to Buy':'2','Price Per Unit':'100','Total Buy Amount':'200'};
const run={id:950,status:'partial',created_at:'2026-11-01T00:00:00Z',prompt:'[REBALANCE_FLOW:india] Rebalance the India portfolio.',run_jobs:[1,2].map(i=>({job_id:950+i,job:{provider:'synthetic',model:'fixture-'+i,status:'completed',created_at:'2026-11-01T00:00:00Z',response:'| '+REBALANCE_HEADER_ORDER.join(' | ')+' |\\n| '+REBALANCE_HEADER_ORDER.map(()=>'---').join(' | ')+' |\\n| '+REBALANCE_HEADER_ORDER.map(h=>row[h]??(h.startsWith('Score Rationale')?'3':'—')).join(' | ')+' |'}}))};
const saved=buildConsensusRows([run],'india',{holdings:[{exchange:'NSE',tradingsymbol:'SYNTHETIC',quantity:6,market_value:600}]});window.__stockCount=saved.length;
function Fixture(){const[state,setState]=useState('loading'),[open,setOpen]=useState(true);window.__setState=setState;const retained=state.startsWith('retained'),populated=state==='populated'||retained;return <><button onClick={()=>setOpen(true)}>Open calculations</button><OpenActionablesCalculationsModal open={open} onClose={()=>setOpen(false)} title='Synthetic India Final' market='india' stocks={populated?saved:[]} technicalScans={{}} formulaConfig={DEFAULT_SCORE_MATRIX_FORMULA_CONFIG} onFormulaConfigChange={()=>{}} runs={[]} loading={state==='loading'||state==='retained-loading'} loadError={state==='failed'||state==='retained-failed'?'Synthetic read unavailable':null} onRetry={()=>setState('verified-zero')}/></>};createRoot(document.getElementById('root')).render(<Fixture/>);`;
const result=await build({stdin:{contents:entry,resolveDir:root,loader:'tsx'},bundle:true,write:false,jsx:'automatic',tsconfig:path.join(root,'tsconfig.json'),define:{'process.env.NODE_ENV':'"development"','process.env':'{}'},plugins:[{name:'offline',setup(b){
 b.onLoad({filter:/FinalActionablesConsole\.tsx$/},async args=>({contents:await readFile(args.path,'utf8')+'\nexport {OpenActionablesCalculationsModal};',loader:'tsx'}));
 b.onResolve({filter:/^next\/link$/},()=>({path:'link',namespace:'mock'}));
 b.onResolve({filter:/^next\/navigation$/},()=>({path:'navigation',namespace:'mock'}));
 b.onResolve({filter:/hooks\/useUsdInrRate$/},()=>({path:'fx',namespace:'mock'}));
 b.onResolve({filter:/services\/api$/},()=>({path:'api',namespace:'mock'}));
 b.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:args.path==='link'?'import React from "react";export default ({children,...props})=>React.createElement("a",props,children);':args.path==='navigation'?'export const useRouter=()=>({push(){}});export const useSearchParams=()=>new URLSearchParams();':args.path==='fx'?'export const useUsdInrRate=()=>null;':'export const apiService=new Proxy({},{get:(_,name)=>(...args)=>{(window.__apiCalls??=[]).push(String(name));return Promise.reject(Error("Blocked fixture API"));}});export class APIError extends Error{};export class RequestTimeoutError extends Error{};',loader:'js',resolveDir:root}));
}}]});
const css=await postcss([tailwind()]).process(await readFile(path.join(root,'app/globals.css'),'utf8'),{from:path.join(root,'app/globals.css')});
const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'application/javascript':'text/html');res.end(req.url==='/bundle.js'?result.outputFiles[0].text:`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css.css}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`)});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||chromium.executablePath(),args:['--no-sandbox']});
const errors=[],blocked=[],evidence=[];
try{const page=await browser.newPage({viewport:{width:1180,height:757}});page.on('pageerror',e=>{errors.push(e.message);console.error(e.stack)});await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():(blocked.push(route.request().url()),route.abort()));
await page.goto(origin);const dialog=page.getByRole('dialog',{name:'Synthetic India Final Excel layout'});await dialog.waitFor();assert.equal(await page.evaluate(()=>window.__stockCount),1);
for(const width of [1180,390]){await page.setViewportSize({width,height:844});for(const state of ['loading','failed','verified-zero','populated','retained-loading','retained-failed']){
 await page.evaluate(state=>window.__setState(state),state);
 const expected=state==='loading'?'LLMs consolidated in this view: Loading… Stocks: Loading…':state==='failed'?'LLMs consolidated in this view: Unknown. Stocks: Unknown.':state==='verified-zero'?'LLMs consolidated in this view: 0. Stocks: 0.':`LLMs consolidated in this view: 2. Stocks: 1.${state.startsWith('retained')?' Previously available results; '+(state==='retained-loading'?'refresh in progress':'refresh failed')+'.':''}`;
 await dialog.getByText(expected,{exact:true}).waitFor();if(state==='populated'){await dialog.getByText('Add More',{exact:true}).first().waitFor();}if(state==='failed'){await dialog.getByRole('button',{name:'Try again'}).focus();await page.keyboard.press('Enter');await dialog.getByText('LLMs consolidated in this view: 0. Stocks: 0.',{exact:true}).waitFor();await page.evaluate(()=>window.__setState('failed'));}
 const bounds=await dialog.boundingBox();assert.ok(bounds.x>=0&&bounds.width<=width);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:path.join(out,`${width}-${state}.png`),fullPage:false});evidence.push({width,state,expected});
}}
await dialog.getByRole('button',{name:'Select inputs for Actionables Calculations'}).focus();await page.keyboard.press('Enter');await page.getByRole('heading',{name:'Select Actionables inputs',exact:true}).waitFor();
assert.deepEqual(await page.evaluate(()=>window.__apiCalls??[]),[]);assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);await writeFile(path.join(out,'result.json'),JSON.stringify({timestamp:new Date().toISOString(),result:'PASS',evidence,errors,blocked,apiCalls:0},null,2));console.log('PASS F11: partial model units, retained held snapshot resolves Add More; real calculations modal; 12 state/viewport fixtures; retry keyboard and nested input dialog; zero API calls');
}finally{await browser.close();await new Promise(r=>server.close(r))}

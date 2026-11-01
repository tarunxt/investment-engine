// A6-11: real analytics page; synthetic source/cache states; no live requests.
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
const {build}=require(process.env.ACTIONABLES_ESBUILD_PATH||'/tmp/credx-build/node_modules/esbuild');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=process.env.AUDIT6_TRADE_EVIDENCE_DIR||'/tmp/audit6-trade-analytics';
await mkdir(out,{recursive:true});
const entry=`import React from 'react';import{createRoot}from'react-dom/client';
import{TradeAnalysisListClient}from'./app/console/bullpen-ai/analyse-events/_components/TradeAnalysisListClient';
import{buildTradeAnalysisFiltersKey,writeTradeAnalysisCache}from'./lib/bullpenTradeAnalysisFallback';
sessionStorage.removeItem('investment-engine:bullpen-trade-analysis:last-known-good:v1');window.__reads=[];window.__pending=[];window.__seedCache=data=>writeTradeAnalysisCache({userId:9001,filtersKey:buildTradeAnalysisFiltersKey({status:'',finalTag:'',fromDate:'',toDate:'',strategyVersion:'',category:'',topic:''}),data,now:Date.now()-60_000});
createRoot(document.getElementById('root')).render(<TradeAnalysisListClient/>);`;
const result=await build({stdin:{contents:entry,resolveDir:root,loader:'tsx'},bundle:true,write:false,jsx:'automatic',tsconfig:path.join(root,'tsconfig.json'),define:{'process.env.NODE_ENV':'"development"','process.env':'{}'},plugins:[{name:'offline',setup(b){
 b.onResolve({filter:/^next\/link$/},()=>({path:'link',namespace:'mock'}));
 b.onResolve({filter:/^next\/navigation$/},()=>({path:'navigation',namespace:'mock'}));
 b.onResolve({filter:/hooks\/useAuth$/},()=>({path:'auth',namespace:'mock'}));
 b.onResolve({filter:/services\/api$/},()=>({path:'api',namespace:'mock'}));
 b.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:args.path==='link'?'import React from "react";export default ({children,...props})=>React.createElement("a",props,children);':args.path==='navigation'?'export const useRouter=()=>({push(){}});export const useSearchParams=()=>new URLSearchParams();':args.path==='auth'?'const user={id:9001};export const useAuth=()=>({user});':'export const apiService=new Proxy({},{get:(_,name)=>(...args)=>{window.__reads.push({name:String(name),args});if(name!=="bullpenAiTradeAnalysis")throw Error("Blocked unexpected API method");return new Promise((resolve,reject)=>window.__pending.push({resolve,reject}));}});export class APIError extends Error{};export class RequestTimeoutError extends Error{};',loader:'js',resolveDir:root}));
}}]});
const css=await postcss([tailwind()]).process(await readFile(path.join(root,'app/globals.css'),'utf8'),{from:path.join(root,'app/globals.css')});
const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'application/javascript':'text/html');res.end(req.url==='/bundle.js'?result.outputFiles[0].text:`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css.css}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`)});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
const errors=[],blocked=[],evidence=[];
try{const page=await browser.newPage({viewport:{width:1180,height:757}});page.on('pageerror',e=>{errors.push(e.message);console.error(e.stack)});await page.route('**/*',route=>new URL(route.request().url()).origin===origin&&route.request().method()==='GET'&&!new URL(route.request().url()).pathname.startsWith('/api/')?route.continue():(blocked.push(route.request().url()),route.abort()));
const response=(kind)=>({items:kind==='populated'||kind==='open-only'?[{id:'synthetic-trade',title:'Synthetic saved trade',status:kind==='open-only'?'OPEN':'CLOSED',final_tag:kind==='open-only'?'OPEN':'PROFIT',pnl_outcome_tag:kind==='open-only'?'OPEN':'PROFIT',is_squared_off:kind!=='open-only',buy_tags:['Synthetic tag'],net_pnl:kind==='open-only'?null:12.5,buy_amount:100,buy_shares:10,buy_price:0.5}]:[],summary:{total_executed_trades:kind==='zero'?0:1,open_positions:kind==='open-only'?1:0,closed_positions:kind==='populated'?1:0,total_net_pnl:kind==='populated'?12.5:0,win_rate:kind==='populated'?1:0,average_pnl_percent:null,average_holding_period_seconds:null,total_fees:0},learning_insights:{recommendations:kind==='populated'?['Synthetic saved recommendation']:[],profitable_tags:[],unprofitable_tags:[],exit_reasons_ranked_by_pnl:[],buy_reasons_ranked_by_pnl:[],average_pnl_by_confidence_bucket:[],average_pnl_by_liquidity_bucket:[],win_rate_by_tag:[],average_pnl_by_tag:[],total_pnl_by_strategy_version:[]}});
const stat=(label)=>page.getByText(label,{exact:true}).locator('xpath=../..').locator('[data-slot="card-content"]');
for(const width of [1180,390]){await page.setViewportSize({width,height:844});for(const state of ['failed','verified-zero','populated','open-only','cached-zero','cached-populated']){
 await page.goto(origin+'/?fixture='+state+'-'+width);await page.getByRole('heading',{name:'Bullpen Trade Analysis'}).waitFor();await page.waitForFunction(()=>window.__pending.length===1);
 assert.equal((await stat('Executed Trades').innerText()).trim(),'…');await page.getByRole('tab',{name:'Learning Insights'}).focus();await page.keyboard.press('Enter');await page.getByText('Loading learning insights…',{exact:true}).waitFor();assert.equal(await page.getByText('Learning Insights JSON',{exact:true}).count(),0);assert.equal(await page.getByText('No signals yet.',{exact:true}).count(),0);
 if(state.startsWith('cached'))await page.evaluate(data=>window.__seedCache(data),response(state==='cached-zero'?'zero':'populated'));
 if(state==='failed'||state.startsWith('cached'))await page.evaluate(()=>window.__pending[0].reject(Error('Synthetic primary and fallback unavailable')));else await page.evaluate(data=>window.__pending[0].resolve(data),response(state==='verified-zero'?'zero':state));
 if(state==='failed'){await page.getByText('Synthetic primary and fallback unavailable',{exact:true}).waitFor();assert.equal((await stat('Executed Trades').innerText()).trim(),'Unavailable');assert.equal((await stat('Win Rate').innerText()).trim(),'Unavailable');assert.ok(await page.getByText('Learning insights unavailable.',{exact:true}).count()>0);assert.equal(await page.getByText('No signals yet.',{exact:true}).count(),0);assert.equal(await page.getByText('Learning Insights JSON',{exact:true}).count(),0);await page.screenshot({path:path.join(out,`${width}-failed-learning.png`),fullPage:true});await page.getByRole('tab',{name:'Trades'}).click();assert.equal(await page.getByText('No executed Bullpen trades matched the current filters yet.',{exact:true}).count(),0);await page.screenshot({path:path.join(out,`${width}-failed-trades.png`),fullPage:true});await page.getByRole('tab',{name:'Learning Insights'}).click();await page.getByRole('button',{name:'Retry',exact:true}).focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>window.__pending.length===2);await page.evaluate(data=>window.__pending[1].resolve(data),response('zero'));await page.getByText('No signals yet.',{exact:true}).first().waitFor();}
 else{await page.getByText('Learning Insights JSON',{exact:true}).waitFor();const closed=state==='populated'||state==='cached-populated';assert.equal((await stat('Executed Trades').innerText()).trim(),state==='verified-zero'||state==='cached-zero'?'0':'1');assert.equal((await stat('Win Rate').innerText()).trim(),closed?'100%':'Unavailable');if(closed)await page.getByText('Synthetic saved recommendation',{exact:true}).waitFor();else await page.getByText('No signals yet.',{exact:true}).first().waitFor();if(state.startsWith('cached'))await page.getByText(/Live refresh failed; showing saved trade analysis from/).waitFor();await page.getByText('Learning Insights JSON',{exact:true}).click();await page.locator('pre').getByText(/recommendations/).waitFor();}
 await page.getByRole('tab',{name:'Learning Insights'}).focus();await page.keyboard.press('ArrowLeft');await page.getByRole('tab',{name:'Trades',selected:true}).waitFor();if(state==='populated'||state==='open-only'||state==='cached-populated')await page.getByText('Synthetic saved trade',{exact:true}).waitFor();else await page.getByText('No executed Bullpen trades matched the current filters yet.',{exact:true}).waitFor();
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));const calls=await page.evaluate(()=>window.__reads);assert.ok(calls.every(x=>x.name==='bullpenAiTradeAnalysis'));await page.screenshot({path:path.join(out,`${width}-${state}.png`),fullPage:true});evidence.push({width,state,calls});
}}
assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);await writeFile(path.join(out,'result.json'),JSON.stringify({timestamp:new Date().toISOString(),result:'PASS',evidence,errors,blocked,liveRequests:0},null,2));console.log('PASS: real trade-analysis page;12 state/viewport fixtures; unknown/loading/verified zero/closed/open/cache; learning JSON and keyboard retry/tabs; no live requests');
}finally{await browser.close();await new Promise(r=>server.close(r))}

// A6-05: actual stock tile/detail provenance; synthetic fixtures, no network access.
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
const out=process.env.AUDIT6_HOLDING_EVIDENCE_DIR||'/tmp/audit6-holding-provenance';
await mkdir(out,{recursive:true});
const entry=`import React from 'react';import{createRoot}from'react-dom/client';
import{ActionSummaryStockTile,DEFAULT_SCORE_MATRIX_FORMULA_CONFIG,buildConsensusRows}from'./app/console/_components/FinalActionablesConsole';
import{REBALANCE_HEADER_ORDER}from'./components/InvestmentRecommendationTable';
const state=location.hash.slice(1)||'venue-order';const venues=state.startsWith('venue')?['NSE','BSE']:['NSE'];
const row=exchange=>({'Exchange Symbol':exchange,'Stock Symbol':'SYNTHETIC','Stock Name':'Synthetic fixture','Current Units':'7','Current Value':'700','Action (Buy/Add/Sell All/Trim/Hold/Buy New)':'Hold','Units Change':'0','Final Units':'7','Units to Buy':'0','Price Per Unit':'100','Total Buy Amount':'0'});
const run={id:950,status:'completed',created_at:'2026-11-01T00:00:00Z',prompt:'[REBALANCE_FLOW:india] Rebalance the India portfolio.',run_jobs:venues.map((v,i)=>({job_id:950+i,job:{provider:'synthetic',model:'fixture-'+v,status:'completed',created_at:'2026-11-01T00:00:00Z',response:'| '+REBALANCE_HEADER_ORDER.join(' | ')+' |\\n| '+REBALANCE_HEADER_ORDER.map(()=>'---').join(' | ')+' |\\n| '+REBALANCE_HEADER_ORDER.map(h=>row(v)[h]??(h.startsWith('Score Rationale')?'3':'—')).join(' | ')+' |'}}))};
const holdings=[{exchange:'BSE',tradingsymbol:'SYNTHETIC',quantity:9,market_value:900,average_price:202},{exchange:'NSE',tradingsymbol:'SYNTHETIC',quantity:4,market_value:400,average_price:101}];
const snapshot=state==='unavailable'?null:{holdings:state==='matched-zero'?[{...holdings[1],quantity:0,market_value:0,average_price:0}]:state==='absent'?[holdings[0]]:state==='venue-reversed'?[...holdings].reverse():holdings,positions:{}};
const stocks=buildConsensusRows([run],'india',snapshot);window.__stockContexts=stocks.map(s=>({venue:s.exchange,...s.positionContext}));
createRoot(document.getElementById('root')).render(<main className='space-y-4 p-4'>{stocks.map(stock=><section key={stock.key} aria-label={stock.exchange+' holding fixture'}><h1>{stock.exchange} holding fixture</h1><ActionSummaryStockTile action='Hold' stock={stock} market='india' formulaConfig={DEFAULT_SCORE_MATRIX_FORMULA_CONFIG} technicalScan={null} setupGroups={{}} detailsData={{portfolioSnapshot:snapshot,eventsAnalysis:null,threatsAnalysis:null,error:state==='unavailable'?'Synthetic snapshot unavailable':null}} historicalRows={[]} onSetupClick={()=>{}}/></section>)}</main>);`;
const result=await build({stdin:{contents:entry,resolveDir:root,loader:'tsx'},bundle:true,write:false,jsx:'automatic',tsconfig:path.join(root,'tsconfig.json'),define:{'process.env.NODE_ENV':'"development"','process.env':'{}'},plugins:[{name:'offline',setup(b){
 b.onLoad({filter:/FinalActionablesConsole\.tsx$/},async args=>({contents:await readFile(args.path,'utf8')+'\nexport {ActionSummaryStockTile};',loader:'tsx'}));
 b.onResolve({filter:/^next\/link$/},()=>({path:'link',namespace:'mock'}));
 b.onResolve({filter:/^next\/navigation$/},()=>({path:'navigation',namespace:'mock'}));
 b.onResolve({filter:/hooks\/useUsdInrRate$/},()=>({path:'fx',namespace:'mock'}));
 b.onResolve({filter:/services\/api$/},()=>({path:'api',namespace:'mock'}));
 b.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:args.path==='link'?'import React from "react";export default ({children,...props})=>React.createElement("a",props,children);':args.path==='navigation'?'export const useRouter=()=>({push(){}});export const useSearchParams=()=>new URLSearchParams();':args.path==='fx'?'export const useUsdInrRate=()=>null;':'export const apiService=new Proxy({},{get:(_,name)=>(...args)=>{(window.__apiCalls??=[]).push(String(name));if(name==="zerodhaOrders")return Promise.resolve({data:[{exchange:"BSE",tradingsymbol:"SYNTHETIC",status:"COMPLETE",transaction_type:"BUY",filled_quantity:9,average_price:404,order_id:"synthetic-bse",order_timestamp:"2026-11-01T00:00:00Z"},{exchange:"NSE",tradingsymbol:"SYNTHETIC",status:"COMPLETE",transaction_type:"BUY",filled_quantity:4,average_price:303,order_id:"synthetic-nse",order_timestamp:"2026-11-01T00:00:00Z"}]});if(name==="getFinalActionableHistory")return Promise.resolve({items:[],has_more:false,next_cursor:null});return Promise.reject(Error("Synthetic read unavailable"));}});export class APIError extends Error{};export class RequestTimeoutError extends Error{};',loader:'js',resolveDir:root}));
}}]});
const css=await postcss([tailwind()]).process(await readFile(path.join(root,'app/globals.css'),'utf8'),{from:path.join(root,'app/globals.css')});
const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'application/javascript':'text/html');res.end(req.url==='/bundle.js'?result.outputFiles[0].text:`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css.css}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`)});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
const errors=[],blocked=[],evidence=[];
try{const page=await browser.newPage({viewport:{width:1180,height:757}});page.on('pageerror',e=>{errors.push(e.message);console.error(e.stack)});await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():(blocked.push(route.request().url()),route.abort()));
for(const width of [1180,390]){await page.setViewportSize({width,height:844});for(const state of ['venue-order','venue-reversed','absent','matched-zero','unavailable']){
 await page.goto(origin+'/?fixture='+state+'#'+state);
 const expected=state==='absent'?'Latest portfolio snapshot · no matching instrument; zero inferred from snapshot absence, not a verified holding quantity':state==='unavailable'?'Captured model holdings (snapshot unavailable)':'Latest portfolio snapshot · matched holding';
 const venues=state.startsWith('venue')?['NSE','BSE']:['NSE'];
 for(const venue of venues){const tile=page.getByRole('region',{name:venue+' holding fixture'});await tile.getByText('Position: '+expected+'. Quantities are model estimates before market rounding.',{exact:true}).waitFor();
 const trigger=tile.getByRole('button',{name:'Open SYNTHETIC captured details',exact:true});await trigger.focus();await page.keyboard.press('Enter');const dialog=page.getByRole('dialog',{name:'SYNTHETIC',exact:true});await dialog.waitFor();
 const consensus=dialog.getByRole('button',{name:'Provider consensus & technical scan'});await consensus.click();
 if(state.startsWith('venue')){await dialog.getByText(new RegExp((venue==='NSE'?'303':'404')+'.*'+(venue==='NSE'?'4':'9')+' units')).waitFor();assert.doesNotMatch(await dialog.innerText(),new RegExp((venue==='NSE'?'404':'303')+'.* units'));}
 if(state==='absent'||state==='unavailable')assert.equal(await dialog.getByText('Buy price / date time',{exact:true}).count(),0);
 assert.equal(await dialog.evaluate(el=>el.contains(document.activeElement)),true);await page.keyboard.press('Tab');assert.equal(await dialog.evaluate(el=>el.contains(document.activeElement)),true);await page.keyboard.press('Shift+Tab');assert.equal(await dialog.evaluate(el=>el.contains(document.activeElement)),true);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(out,`${width}-${state}-${venue}.png`),fullPage:false});await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});assert.equal(await trigger.evaluate(el=>el===document.activeElement),true);
 }
 const contexts=await page.evaluate(()=>window.__stockContexts);if(state==='absent'){assert.equal(contexts[0].holdingMatch,'absent');assert.equal(contexts[0].currentUnits,0);}if(state==='matched-zero'){assert.equal(contexts[0].holdingMatch,'matched');assert.equal(contexts[0].currentUnits,0);}if(state==='unavailable'){assert.equal(contexts[0].source,'captured-model-rows');assert.equal(contexts[0].currentUnits,7);}if(state.startsWith('venue')){assert.equal(contexts.find(x=>x.venue==='NSE').currentUnits,4);assert.equal(contexts.find(x=>x.venue==='BSE').currentUnits,9);}
 const calls=await page.evaluate(()=>window.__apiCalls??[]);assert.ok(calls.every(name=>['zerodhaOrders','getFinalActionableHistory','getStockSourceObservations'].includes(name)),JSON.stringify(calls));evidence.push({width,state,contexts,calls});
}}
assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);await writeFile(path.join(out,'result.json'),JSON.stringify({timestamp:new Date().toISOString(),result:'PASS',evidence,errors,blocked,liveRequests:0},null,2));console.log('PASS: actual stock tiles/details; exact NSE/BSE evidence in both orders; inferred absence/matched zero/captured fallback; desktop/narrow/keyboard; zero live requests');
}finally{await browser.close();await new Promise(r=>server.close(r))}

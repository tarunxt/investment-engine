#!/usr/bin/env node
// Actual hook and draft safety rules; mocked quotes, no financial execution.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
const frontend=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),temporary=await mkdtemp(path.join(os.tmpdir(),'basket-refresh-'));
let browser,server;
try{
 const mock=path.join(temporary,'api.ts');
 await writeFile(mock,`export const apiService={zerodhaQuoteCapabilities:async()=>{window.capabilities++;return{upstox_ltp_enabled:true}},zerodhaDisplayQuotes:(keys,signal)=>{window.calls.push({keys,signal});return new Promise((resolve,reject)=>window.pending.push({resolve,reject}))}};`);
 const entry=`import React,{useState}from'react';import{createRoot}from'react-dom/client';import{useBasketDisplayQuotes}from'./components/BasketDisplayCalculations';import{editableDraftIssues}from'./lib/basketEditableDraft';
 window.calls=[];window.pending=[];window.capabilities=0;
 window.reply=(i,kind='ok')=>{if(kind==='error'){window.pending[i].reject(new Error('HTTP 429'));return}window.pending[i].resolve({quotes:[],missing:[],upstox_quotes:kind==='missing'?[]:window.calls[i].keys.map(instrument=>({instrument,price:100+i,source:'Upstox mock',as_of:new Date(Date.now()-(kind==='old'?180000:0)).toISOString()}))})};
 function Basket({open,scope,keys}){const q=useBasketDisplayQuotes(open,'india',keys,scope);const[units,setUnits]=useState(9),[selected,setSelected]=useState(true);window.result=q;window.edit=()=>{setUnits(17);setSelected(false)};const quote=q.upstoxQuotes[0];window.issues=editableDraftIssues({units,price:quote?.price??null,currentUnits:100,exchange:'NSE',draftContext:{action:'Add More',suggestedUnits:9,source:quote?.source,asOf:quote?.as_of}});return <output>{JSON.stringify({units,selected})}</output>}
 function App(){const[props,setProps]=useState({open:true,scope:'A',keys:['NSE:AAA']}),[mounted,setMounted]=useState(true);window.configure=p=>setProps(v=>({...v,...p}));window.unmount=()=>setMounted(false);return mounted?<Basket {...props}/>:null}createRoot(document.getElementById('root')).render(<App/>);`;
 const bundle=await build({stdin:{contents:entry,loader:'tsx',resolveDir:frontend},bundle:true,write:false,outfile:path.join(temporary,'bundle.js'),format:'iife',alias:{'@/services/api':mock,'@':frontend},loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"production"'}});
 server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<div id="root"></div><script>${bundle.outputFiles[0].text}</script>`)});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE??'/usr/bin/chromium',args:['--no-sandbox']});const page=await browser.newPage();page.on('pageerror',e=>console.error(e));await page.clock.install();await page.goto(`http://127.0.0.1:${server.address().port}`);
 const settle=()=>page.waitForTimeout(50);
 const count=()=>page.evaluate(()=>window.calls.length),advance=ms=>page.clock.fastForward(ms);
 const reply=async(i,k)=>{await page.evaluate(([i,k])=>window.reply(i,k),[i,k]);await settle()};
 const change=async p=>{await page.evaluate(p=>window.configure(p),p);await settle()};
 const visibility=async h=>{await page.evaluate(h=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:h?'hidden':'visible'});document.dispatchEvent(new Event('visibilitychange'))},h);await settle()};
 await settle();assert.equal(await count(),1);await reply(0);await page.evaluate(()=>window.edit());await settle();
 await advance(30000);assert.equal(await count(),2);await advance(180000);assert.equal(await count(),2,'no overlapping requests');await reply(1);
 await visibility(true);await visibility(false);assert.equal(await count(),2,'rapid tab switching cannot create a quote burst');
 assert.deepEqual(await page.evaluate(()=>JSON.parse(document.querySelector('output').textContent)),{units:17,selected:false});assert.equal(await page.evaluate(()=>window.capabilities),1);
 await visibility(true);await advance(300000);assert.equal(await count(),2);await visibility(false);assert.equal(await count(),3);await reply(2,'error');assert.equal(await page.evaluate(()=>window.result.upstoxQuotes.length),0);
 await visibility(true);await visibility(false);assert.equal(await count(),3,'visibility respects error cooldown');await advance(59000);assert.equal(await count(),3);await advance(1000);assert.equal(await count(),4);await reply(3,'error');await advance(119000);assert.equal(await count(),4);await advance(1000);assert.equal(await count(),5);await reply(4,'old');assert.ok(await page.evaluate(()=>window.issues.some(s=>s.includes('old or future'))));
 await advance(30000);assert.equal(await count(),6);await reply(5,'missing');assert.ok(await page.evaluate(()=>window.issues.some(s=>s.includes('Genuine Upstox'))));
 await advance(30000);assert.equal(await count(),7);await change({scope:'B',keys:['NSE:BBB']});assert.equal(await count(),8);assert.equal(await page.evaluate(()=>window.calls[6].signal.aborted),true);await reply(6);assert.equal(await page.evaluate(()=>window.result.upstoxQuotes.length),0,'ignore late old basket response');await reply(7);assert.equal(await page.evaluate(()=>window.result.upstoxQuotes[0].instrument),'NSE:BBB');assert.equal(await page.evaluate(()=>window.issues.length),0);
 await advance(30000);assert.equal(await count(),9);await change({open:false});assert.equal(await page.evaluate(()=>window.calls[8].signal.aborted),true);await reply(8);await advance(300000);assert.equal(await count(),9);
 await change({open:true});assert.equal(await count(),10);await reply(9);await page.evaluate(()=>window.result.retry());await settle();assert.equal(await count(),11);await reply(10);
 await advance(30000);assert.equal(await count(),12);await page.evaluate(()=>window.unmount());await settle();assert.equal(await page.evaluate(()=>window.calls[11].signal.aborted),true);await reply(11);await advance(300000);assert.equal(await count(),12);
 // Reload to exercise sequential 50-instrument batches and their cleanup.
 await page.reload();await settle();await change({scope:'batch',keys:Array.from({length:51},(_,i)=>'NSE:S'+i)});
 assert.equal(await count(),2);assert.equal(await page.evaluate(()=>window.calls[1].keys.length),50);
 await reply(1);assert.equal(await count(),3);assert.equal(await page.evaluate(()=>window.calls[2].keys.length),1);
 await reply(2);assert.equal(await page.evaluate(()=>window.result.upstoxQuotes.length),51);
 await advance(30000);assert.equal(await count(),4);await change({open:false});await reply(3);assert.equal(await count(),4,'closing stops remaining batches');
 await change({open:true,scope:'oversized',keys:Array.from({length:501},(_,i)=>'NSE:S'+i)});assert.equal(await count(),4);assert.ok(await page.evaluate(()=>window.result.error.includes('500')));await advance(300000);assert.equal(await count(),4,'oversized baskets do not poll');
 await change({scope:'backoff',keys:['NSE:CCC']});assert.equal(await count(),5);
 for(const [index,delay] of [[4,60000],[5,120000],[6,240000],[7,300000],[8,300000]]){await reply(index,'error');await advance(delay-1000);assert.equal(await count(),index+1);await advance(1000);assert.equal(await count(),index+2)}
 await reply(9);await advance(30000);assert.equal(await count(),11,'success restores 30 second interval');await change({open:false});
 console.log('PASS: periodic refresh, no overlap, preserved edits/selection, capability stability, visibility pause/resume, 429 backoff/recovery, old/missing/fresh quote gating, scope race, close/reopen, retry, unmount. No broker or execution calls.');
}finally{await browser?.close();if(server)await new Promise(r=>server.close(r));await rm(temporary,{recursive:true,force:true})}

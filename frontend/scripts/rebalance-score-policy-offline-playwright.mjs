#!/usr/bin/env node
/** Actual components, synthetic inputs, no external requests. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
const require=createRequire(import.meta.url),frontend=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temporary=await mkdtemp(path.join(os.tmpdir(),'audit7-score-ui-')),asOf='2026-10-28T12:00:00Z',raw=72.8/24;
const modulePath=name=>JSON.stringify(path.join(frontend,name));
await writeFile(path.join(temporary,'entry.tsx'),`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {useBasketDisplayCalculations} from ${modulePath('components/BasketDisplayCalculations.tsx')};
import {calculateWeightedRationaleScore} from ${modulePath('lib/scoreMatrixMath.ts')};
function Fixture(){
 const [mode,setMode]=useState('positive'),[open,setOpen]=useState(true);window.fixtureMode=mode;
 const rows=[...[3,3,2,1,3,1].map(multiplier=>({score:3,multiplier})),{score:8.8,multiplier:1,denominatorWeight:2},{score:3,multiplier:5},{score:2.5,multiplier:4}];
 const calculated=calculateWeightedRationaleScore(rows,mode==='custom'?1:null).finalScore;
 const score=mode==='negative'?-calculated:mode==='zero'?0:mode==='missing'?null:calculated;
 const stock={symbol:'SYNTH',exchange:'NSE',score,ltp:100,currentValue:0,scoreSources:mode==='legacy-only'?[]:[{runId:2,createdAt:mode==='stale'?'2026-10-20T12:00:00Z':'${asOf}',completed:!['partial','failed'].includes(mode),status:mode==='partial'?'partial':mode==='failed'?'failed':'completed',market:'india'}]};
 const c=useBasketDisplayCalculations(open,'india',[stock],10000,'${asOf}','Zerodha');
 return <><nav>{['positive','negative','zero','missing','custom','partial','failed','stale','legacy-only','error','delayed'].map(m=><button key={m} onClick={()=>setMode(m)}>{m}</button>)}<button onClick={()=>setOpen(false)}>Close basket</button><button onClick={()=>setOpen(true)}>Reopen basket</button></nav>
 {open&&<table><thead><tr>{c.headers}</tr></thead><tbody><tr data-testid='score-row'>{c.cells(stock)}</tr></tbody></table>}{c.popup}
 <output data-testid='raw-arithmetic'>{String(score)}</output><output data-testid='state'>{c.error??(c.loading?'loading':'ready')}</output></>;
}createRoot(document.getElementById('root')).render(<Fixture/>);`);
await writeFile(path.join(temporary,'api.ts'),`export const apiService={getBasketScoreHistory:async p=>{const r=await fetch('/history?mode='+window.fixtureMode+'&days='+p.days);if(!r.ok)throw new Error('Synthetic history unavailable');return r.json();}};`);
await writeFile(path.join(temporary,'loader.cjs'),`const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(s){return ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020},fileName:this.resourcePath}).outputText;};`);
await writeFile(path.join(temporary,'css-loader.cjs'),`module.exports=function(s){const names=[...s.matchAll(/\\.([a-zA-Z_][\\w-]*)/g)].map(m=>m[1]);return 'module.exports='+JSON.stringify(Object.fromEntries(names.map(n=>[n,n])))+';';};`);
let browser,server;const errors=[],denied=[];
try {
 const w=require('next/dist/compiled/webpack/webpack');await new Promise((resolve,reject)=>w.webpack({mode:'development',devtool:false,entry:path.join(temporary,'entry.tsx'),output:{path:temporary,filename:'bundle.js'},resolve:{extensions:['.tsx','.ts','.js'],modules:[path.join(frontend,'node_modules'),'node_modules'],alias:{'@/services/api$':path.join(temporary,'api.ts'),'@':frontend}},module:{rules:[{test:/\.tsx?$/,use:path.join(temporary,'loader.cjs')},{test:/\.css$/,use:path.join(temporary,'css-loader.cjs')}]},plugins:[new w.webpack.DefinePlugin({'process.env.NODE_ENV':JSON.stringify('development')})]},(e,s)=>e?reject(e):s.hasErrors()?reject(new Error(s.toString({all:false,errors:true}))):resolve()));
 const bundle=await readFile(path.join(temporary,'bundle.js')),styles=(await readFile(path.join(frontend,'components/BasketMetricPopup.module.css'),'utf8')).replaceAll(':global(.dark)','.dark');
 server=createServer((req,res)=>{const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/'){res.setHeader('Content-Type','text/html');return res.end(`<meta charset='utf-8'><style>${styles}body{font:14px sans-serif}td,th{padding:12px}button{padding:8px}</style><div id='root'></div><script src='/bundle.js'></script>`);}
  if(url.pathname==='/bundle.js'){res.setHeader('Content-Type','text/javascript');return res.end(bundle);}
  if(url.pathname!=='/history'){res.writeHead(404);return res.end();}
  if(url.searchParams.get('mode')==='error'){res.writeHead(503);return res.end();}
  const days=Number(url.searchParams.get('days')),data={market:'india',symbols:['SYNTH'],days,as_of:asOf,window_start:new Date(Date.parse(asOf)-days*86400000).toISOString(),timezone:'UTC',truncated:false,notes:[],observations:[{id:1,run_id:1,symbol:'SYNTH',exchange:'NSE',score:raw,action:'Add more',covered_at:asOf,completed:true,coverage_status:'suggested',formula_version:'score-matrix-v1'}]};
  const send=()=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));};if(url.searchParams.get('mode')==='delayed')setTimeout(send,250);else send();
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE??'/usr/bin/chromium'});
 const context=await browser.newContext({viewport:{width:1500,height:1000},serviceWorkers:'block'});
 await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){denied.push(route.request().url());return route.abort('blockedbyclient');}return route.continue();});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);
 const scoreButton=page.getByLabel('SYNTH Historical Weighted Score calculation',{exact:true});await scoreButton.filter({hasText:'3.0'}).waitFor();
 assert.match(await page.getByTestId('score-row').textContent(),/Raw formula score: 3.033333333333.*Effective allocation score: 3/s);
 assert.equal(await page.getByTestId('raw-arithmetic').textContent(),String(raw));
 async function historySummary(){await scoreButton.click();const summary=page.getByRole('dialog',{name:'Historical Weighted Score',exact:true});await summary.waitFor();return summary;}
 let summary=await historySummary();assert.match(await summary.textContent(),/Raw formula score.*3.0333.*Effective allocation score.*3/s);
 await summary.getByRole('button',{name:'Calculation details',exact:true}).click();const details=page.getByRole('dialog',{name:'Behind the number',exact:true});await details.waitFor();
 assert.match(await details.textContent(),/score-matrix-raw-effective-v2/);
 const currentRow=details.getByRole('row').filter({hasText:'Current calculation'});assert.match(await currentRow.textContent(),/3.033333333333.*3.*effective allocation score/s);
 assert.match(await details.getByRole('region',{name:'Excluded original scores'}).textContent(),/Run #1.*3.033333333333.*Legacy eligibility is unchanged/s);
 await details.getByRole('button',{name:'Back to summary',exact:true}).click();await summary.getByRole('button',{name:'Done',exact:true}).click();
 for(const [mode,expected,rawText] of [['negative','-3.0','-3.033333333333'],['zero','0.0','0'],['custom','3.0','72.8'],['partial','3.0','3.033333333333']]){
  await page.getByRole('button',{name:mode,exact:true}).click();await scoreButton.filter({hasText:expected}).waitFor();const row=await page.getByTestId('score-row').textContent();assert.match(row,/Raw formula score:.*Effective allocation score:/s);assert.ok(row.includes(rawText));
 }
 for(const mode of ['missing','failed','stale','legacy-only','error']){
  await page.getByRole('button',{name:mode,exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-testid=state]').textContent!=='loading');assert.equal(await scoreButton.textContent(),'Unavailable');assert.doesNotMatch(await page.getByTestId('score-row').textContent(),/Effective allocation score:/);
 }
 await page.getByRole('button',{name:'delayed',exact:true}).click();await page.getByRole('button',{name:'Close basket',exact:true}).click();await page.getByRole('button',{name:'negative',exact:true}).click();await page.getByRole('button',{name:'Reopen basket',exact:true}).click();await scoreButton.filter({hasText:'-3.0'}).waitFor();
 await page.waitForTimeout(300);assert.equal(await scoreButton.textContent(),'-3.0');
 for(let attempt=0;attempt<2;attempt++){summary=await historySummary();assert.match(await summary.textContent(),/Effective allocation score/);await summary.getByRole('button',{name:'Done',exact:true}).click();}
 assert.deepEqual(errors,[]);assert.deepEqual(denied,[]);
 console.log('PASS: actual basket row, summary and detail preserve raw 3.033333333333333, use effective 3, and explain legacy exclusion. Negative/zero/custom/missing/partial/failed/stale/error, interrupted reads and repeated popups pass. External requests: 0.');
}finally{await browser?.close();if(server)await new Promise(r=>server.close(r));await rm(temporary,{recursive:true,force:true});}

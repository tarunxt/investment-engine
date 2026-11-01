/** Real ledger component, deterministic local data, isolated network. No workflow execution. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, readFile, writeFile, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
const require=createRequire(import.meta.url);
const frontend=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temporary=await mkdtemp(path.join(tmpdir(),'auto-stages-ledger-'));
const evidence=process.env.AUTO_STAGES_EVIDENCE || '/tmp/auto-stages-evidence';
const mixedFailure=process.env.AUTO_STAGES_MIXED_FAILURE === '1';
await mkdir(evidence,{recursive:true});
let server,browser;
try {
 await writeFile(path.join(temporary,'entry.tsx'),`
 import React,{useState} from 'react';
 import {createRoot} from 'react-dom/client';
 import {WorkflowStageLedger,WorkflowStageLedgerViews} from ${JSON.stringify(path.join(frontend,'components/shared/WorkflowStageLedger.tsx'))};
 import {WorkflowStageTile,STAGE_ORDER} from ${JSON.stringify(path.join(frontend,'components/shared/WorkflowStageTile.tsx'))};
 window.actions=[];
 const now=Date.parse('2026-11-01T03:00:00Z');
 function Fixture(){
 const [market,setMarket]=useState('India'),[view,setView]=useState('ledger'),[state,setState]=useState(new URLSearchParams(location.search).get('fixture')||'loaded'),[checks,setChecks]=useState({});
 const call=(name)=>()=>window.actions.push(name);
 const stages=STAGE_ORDER.map((stage,index)=>{
 const partial=market==='US'&&stage==='rebalance'&&state==='loaded';
 const completed=state==='empty'?null:'2026-10-30T14:13:00Z';
 const info=state==='empty'?{state:'idle'}:{state:state==='loading'?'queued':state==='failed'&&stage==='rebalance'?'failed':'completed',completedAt:completed,startedAt:'2026-10-30T14:11:00Z',endedAt:'2026-10-30T14:13:00Z',totalLlms:2,completedLlms:2,passedLlms:partial?1:2,partialLlms:partial?${mixedFailure ? 0 : 1}:0,failedLlms:partial?${mixedFailure ? 1 : 0}:0,recommendedStocks:index===1?null:state==='zero'?0:13,rebalanceInputs:1,costInr:null,runStatus:partial?'partial':state==='stale'?'stale':null,error:state==='failed'&&stage==='rebalance'?'Provider timeout':null,partialNotice:partial?'${mixedFailure ? 'One provider completed and one provider failed.' : 'One saved LLM response was partial.'}':null};
 if(state==='derived'){
   info.state=stage==='technical'?'failed':'idle';
   info.runStatus=stage==='technical'?'failed':stage==='actionables'?'derived from latest rebalance/technical scan':'completed';
   info.evidence=stage==='actionables'?{kind:'derived',references:['Timestamp source: run #102 · failed · 2026-11-01T12:00:00Z','Stock-count source: run #101 · completed · 2026-10-30T12:00:00Z']}:{kind:'saved',references:['india workflow #7 · '+stage+' · '+info.runStatus+' · 2026-10-30T12:00:00Z']};
 }
 return <WorkflowStageTile key={stage} stage={stage} info={info} now={now} selectable={state==='selection'} selected={Boolean(checks[stage])} onClick={state==='selection'?()=>setChecks({...checks,[stage]:!checks[stage]}):call('open:'+stage)} onInfoClick={!['sync','actionables'].includes(stage)?call('models:'+stage):undefined} onInputClick={stage!=='sync'?call('inputs:'+stage):undefined} onPromptClick={!['sync','actionables'].includes(stage)?call('prompt:'+stage):undefined} onOutputClick={call('output:'+stage)} onSyncNowClick={stage==='sync'?call('sync'):undefined} onPlaceOrderClick={stage==='actionables'?call('order:'+market):undefined} placeOrderLabel={market==='US'?'Final Order':'Place Order'} onCalculationsClick={stage==='actionables'?call('calculation'):undefined}/>;
 });
 return <main className="mx-auto max-w-[1380px] p-4 text-slate-700"><h1 className="mb-3 text-xl font-bold text-slate-950">Automated rebalance · offline fixture</h1>
 <WorkflowStageLedgerViews market={market==='India'?'zerodha':'indmoneyUs'} view={view} onChange={(m,v)=>{setMarket(m==='zerodha'?'India':'US');setView(v)}}/>
 <label className="mb-3 block text-xs">Fixture state <select value={state} onChange={e=>setState(e.target.value)}>{['loaded','loading','empty','failed','stale','zero','selection','derived'].map(s=><option key={s}>{s}</option>)}</select></label>
 <article className="rounded-2xl border border-indigo-200 bg-indigo-50/50 p-4"><div className="flex justify-between gap-3"><div><h2 className="text-xl font-bold text-slate-950">Run {market==='India'?'Zerodha':'Indmoney'} Auto-Rebalance</h2><p className="mt-2 text-sm">Last run: {state==='empty'?'n/a':'30 Oct 19:43'}</p></div><section aria-label="Run controls"><h3 className="text-sm font-semibold">Run controls</h3><button className="mt-2 rounded-lg bg-indigo-700 px-4 py-2 text-white" onClick={call('run')}>Run</button></section></div>
 <WorkflowStageLedger enabled view={view} historyHref="#history" onStockFlowClick={call('flow')}>{stages}</WorkflowStageLedger>
 <footer className="mt-3 rounded-xl border border-emerald-100 bg-emerald-50 p-3 text-sm">Cumulative LLM time: 00:08:39 · Total cost incurred in last Auto-rebalance: n/a</footer></article><p id="history">Offline fixture history destination</p></main>;
 }
 createRoot(document.getElementById('root')).render(<Fixture/>);
 `);
 await writeFile(path.join(temporary,'loader.cjs'),`const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(s){return ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020},fileName:this.resourcePath}).outputText;};`);
 const w=require('next/dist/compiled/webpack/webpack');
 await new Promise((resolve,reject)=>w.webpack({mode:'development',devtool:false,entry:path.join(temporary,'entry.tsx'),output:{path:temporary,filename:'bundle.js'},resolve:{extensions:['.tsx','.ts','.js'],modules:[path.join(frontend,'node_modules')],alias:{'@':frontend}},module:{rules:[{test:/\.tsx?$/,use:path.join(temporary,'loader.cjs')}]},plugins:[new w.webpack.DefinePlugin({'process.env':JSON.stringify({NODE_ENV:'development'})})]},(error,stats)=>error?reject(error):stats.hasErrors()?reject(new Error(stats.toString({all:false,errors:true}))):resolve()));
 const postcss=require('postcss'),tailwind=require('@tailwindcss/postcss');
 const css=(await postcss([tailwind({base:frontend})]).process('@import "tailwindcss";',{from:path.join(frontend,'auto-stages-fixture.css')})).css;
 const bundle=await readFile(path.join(temporary,'bundle.js'));
 server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'text/javascript':req.url==='/style.css'?'text/css':'text/html');res.end(req.url==='/bundle.js'?bundle:req.url==='/style.css'?css:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Offline stage ledger</title><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/bundle.js"></script>');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1180,height:757},deviceScaleFactor:1});
 const consoleErrors=[];page.on('pageerror',error=>consoleErrors.push(error.message));
 await page.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
 await page.goto(origin);await page.getByRole('table').waitFor();
 assert.equal(await page.locator('tbody tr').count(),6);
 assert.deepEqual(await page.locator('thead th').allTextContents(),['Stage','Evidence time','Completion / inputs','Stocks','Duration','Error']);
 assert.equal(await page.getByRole('status').count(),0);
 await page.screenshot({path:path.join(evidence,'india-desktop.png'),fullPage:true});
 await page.getByRole('button',{name:'US stage ledger',exact:true}).focus();await page.keyboard.press('Enter');
 assert.equal(await page.getByRole('status').count(),1);
 if(mixedFailure){assert.match(await page.locator('tbody').innerText(),/Passed:1/);assert.match(await page.locator('tbody').innerText(),/Failed:1/);}
 assert.match(await page.getByRole('status').innerText(),/Rebalance has partial output/);
 assert.equal(await page.locator('tbody tr').filter({hasText:'LLM output partial'}).count(),1);
 await page.screenshot({path:path.join(evidence,'us-partial-desktop.png'),fullPage:true});
 // Error dialog repeated opening, Escape and native focus restoration.
 const errors=page.getByRole('button',{name:/Show error details/});
 for(let i=0;i<2;i++){await errors.click();await page.getByRole('dialog').waitFor();await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'detached'});assert.equal(await errors.evaluate(el=>el===document.activeElement),true);}
 const rebalance=page.getByRole('button',{name:/04 Rebalance/});await rebalance.focus();await page.keyboard.press('Enter');
 assert.match(await page.getByRole('region',{name:'Saved evidence and configuration'}).innerText(),/Rebalance/);
 for(const [name,action] of [['Inputs','inputs:rebalance'],['Models','models:rebalance'],['Prompt','prompt:rebalance'],['Saved output','output:rebalance'],['Stock Flow','flow'],['Open stage','open:rebalance']]){await page.getByRole('button',{name,exact:true}).click();assert.equal(await page.evaluate(()=>window.actions.at(-1)),action);}
 assert.equal(await page.evaluate(()=>window.actions.some(a=>a==='run'||a==='sync'||a.startsWith('order:'))),false);
 await page.getByRole('link',{name:'History',exact:true}).click();assert.match(page.url(),/#history$/);await page.goBack();assert.equal(await page.locator('tbody tr').count(),6);
 const duration=page.getByRole('button',{name:'Duration',exact:true});
 for(let i=0;i<2;i++){await duration.click();const dialog=page.getByRole('dialog');await dialog.waitFor();assert.equal(await dialog.evaluate(el=>el.contains(document.activeElement)),true);await page.keyboard.press('Tab');assert.equal(await dialog.evaluate(el=>el.contains(document.activeElement)),true);await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});assert.equal(await duration.evaluate(el=>el===document.activeElement),true);}
 await page.getByRole('button',{name:'Saved evidence and configuration',exact:true}).click();await page.getByLabel('Stage',{exact:true}).selectOption('actionables');
 await page.getByRole('button',{name:'Calculation',exact:true}).click();assert.equal(await page.evaluate(()=>window.actions.at(-1)),'calculation');
 await page.screenshot({path:path.join(evidence,'evidence-desktop.png'),fullPage:true});
 await page.getByRole('button',{name:'Run and order controls',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Run and order controls',exact:true}).getAttribute('aria-pressed'),'true');assert.equal(await page.getByRole('table').count(),0);assert.equal(await page.getByRole('button',{name:'Final Order',exact:true}).count(),1);assert.equal(await page.getByRole('button',{name:'Place Order',exact:true}).count(),0);
 await page.screenshot({path:path.join(evidence,'execution-desktop.png'),fullPage:true});
 await page.getByRole('button',{name:'India stage ledger',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Place Order',exact:true}).count(),1);assert.equal(await page.getByRole('button',{name:'Final Order',exact:true}).count(),0);
 for(const state of ['loading','empty','failed','stale','zero','selection']){
 await page.getByLabel('Fixture state').selectOption(state);assert.equal(await page.locator('tbody tr').count(),6);
 if(state==='loading')assert.match(await page.locator('tbody').innerText(),/queued/i);
 if(state==='empty'){assert.match(await page.locator('tbody').innerText(),/Not available/);assert.doesNotMatch(await page.locator('tbody').innerText(),/Passed:2/);}
 if(state==='failed')assert.equal(await page.locator('tbody tr').filter({hasText:'Request timed out'}).count(),1);
 if(state==='stale')assert.match(await page.locator('tbody').innerText(),/stale/i);
 if(state==='zero'){assert.equal(await page.locator('tbody tr').nth(2).locator('td').nth(2).innerText(),'0');assert.equal(await page.locator('tbody tr').nth(1).locator('td').nth(2).innerText(),'n/a');}
 if(state==='selection'){const check=page.getByRole('checkbox',{name:/Select Rebalance/});await check.focus();await page.keyboard.press('Space');assert.equal(await check.isChecked(),true);await page.getByRole('button',{name:'Run and order controls',exact:true}).click();assert.match(await page.getByRole('region',{name:'Sync and order controls'}).innerText(),/Next run: Rebalance/);assert.equal(await page.getByRole('checkbox',{name:'Rebalance',exact:true}).isChecked(),true);await page.getByRole('button',{name:'India stage ledger',exact:true}).click();}
 }
 await page.getByLabel('Fixture state').selectOption('loaded');
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'US stage ledger',exact:true}).click();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.screenshot({path:path.join(evidence,'us-partial-narrow-left.png'),fullPage:true});
 const region=page.getByRole('region',{name:'Saved stage ledger, scroll for all columns'});await region.focus();await page.keyboard.press('ArrowRight');await region.evaluate(el=>el.scrollLeft=el.scrollWidth);
 assert.equal(await region.evaluate(el=>el.scrollLeft>0),true);
 await page.screenshot({path:path.join(evidence,'us-partial-narrow.png'),fullPage:true});
 await page.getByRole('button',{name:/06 Actionables/}).click();await page.getByRole('button',{name:'Calculation',exact:true}).focus();await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>window.actions.at(-1)),'calculation');
 // Reload and repeated stage selection retain separate failed/historical/derived labels.
 await page.goto(origin+'/?fixture=derived');
 for(let i=0;i<2;i++){
 await page.getByRole('button',{name:/06 Actionables/}).click();
 assert.match(await page.locator('tbody tr').last().innerText(),/Derived summary · saved final execution not established/);
 const sources=page.getByRole('list',{name:'Evidence sources'});
 assert.match(await sources.innerText(),/Timestamp source: run #102 · failed/);
 assert.match(await sources.innerText(),/Stock-count source: run #101 · completed/);
 await page.getByRole('button',{name:/05 Technical/}).click();
 assert.match(await page.getByRole('list',{name:'Evidence sources'}).innerText(),/india workflow #7 · technical · failed/);
 await page.reload();await page.getByRole('table').waitFor();
 }
 assert.equal(await page.evaluate(()=>window.actions.length),0);
 await page.screenshot({path:path.join(evidence,'derived-provenance.png'),fullPage:true});
 assert.deepEqual(consoleErrors,[]);
 console.log('PASS: 6 rows; value inventory; India/US; partial row and summary; all evidence callbacks; loading/empty/failed/stale/zero/selection; repeated dialogs; Escape/focus/keyboard; back navigation; narrow scroll; market-specific orders; no execution callbacks triggered.');
 console.log('Screenshots: '+evidence);
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(temporary,{recursive:true,force:true});}

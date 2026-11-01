/** Actual overview with local summary fixtures. No backend or operational calls. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
const require=createRequire(import.meta.url);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=await mkdtemp(path.join(tmpdir(),'bots-overview-'));
const evidence=process.env.BOTS_EVIDENCE_DIR;
let browser,server;
try {
 await writeFile(path.join(temp,'api.ts'),`export class APIError extends Error {status=503}; export const apiService=new Proxy({}, {get:(_,name)=>{if(!['getTradingBotsSummary','polymarketState','getBullpenAutoLiveDashboardSummary'].includes(String(name)))throw new Error('Operational call: '+String(name));return ()=> {window.calls.push(name);return new Promise((resolve,reject)=>window.pending.push({name,resolve,reject}));};}});`);
 await writeFile(path.join(temp,'scan.tsx'),'export function UniversalPolymarketScan(){return null}');
 await writeFile(path.join(temp,'entry.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import {TradingBotsOverviewPage} from ${JSON.stringify(process.env.BOTS_COMPONENT_PATH || path.join(root,'app/console/trading-bots/_components/TradingBotsOverviewPage.tsx'))};import {buildTradingBotsOverviewShell} from ${JSON.stringify(path.join(root,'lib/tradingBots.ts'))};window.fixtureShell=buildTradingBotsOverviewShell;window.calls=[];window.pending=[];window.settle=(kind)=>{for(const p of window.pending.splice(0)){if(p.name!=='getTradingBotsSummary'||kind==='failed'){p.reject(new Error('Fixture unavailable'));continue;}const overview=buildTradingBotsOverviewShell('Fixture source');overview.generatedAt=kind==='stale'?'2026-01-01T00:00:00Z':'2026-10-31T10:00:00Z';if(kind==='loaded'||kind==='partial')overview.bots.forEach((b,i)=>{if(kind==='partial'&&i>0)return;Object.assign(b,{source:'api',status:i===0?'running':'stopped',mode:'paper',moneyInvested:100,currentValue:110,profitLoss:10,returnPct:10,activePositionsCount:0,tradesToday:0});});p.resolve({generated_at:overview.generatedAt,cards:kind==='empty'?[]:overview.bots.map(b=>({id:b.id,name:b.name,source:b.source,status:b.status,mode:b.mode,invested_usd:b.moneyInvested,current_value_usd:b.currentValue,pnl_usd:b.profitLoss,return_pct:b.returnPct,active_positions:b.activePositionsCount,trades_today:b.tradesToday}))});}};createRoot(document.getElementById('root')).render(<TradingBotsOverviewPage/>);`);
 await writeFile(path.join(temp,'loader.cjs'),`const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(s){return ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020},fileName:this.resourcePath}).outputText;}`);
 const w=require('next/dist/compiled/webpack/webpack');
 await new Promise((resolve,reject)=>w.webpack({mode:'development',devtool:false,entry:path.join(temp,'entry.tsx'),output:{path:temp,filename:'bundle.js'},resolve:{extensions:['.tsx','.ts','.js'],modules:[path.join(root,'node_modules')],alias:{'@/services/api':path.join(temp,'api.ts'),'./UniversalPolymarketScan':path.join(temp,'scan.tsx'),'@':root}},module:{rules:[{test:/\.tsx?$/,use:path.join(temp,'loader.cjs')}]},plugins:[new w.webpack.DefinePlugin({'process.env':JSON.stringify({NODE_ENV:'development'})})]},(e,s)=>e?reject(e):s.hasErrors()?reject(new Error(s.toString({all:false,errors:true}))):resolve()));
 const postcss=require('postcss');const tailwind=require('@tailwindcss/postcss');
 const css=(await postcss([tailwind({base:root})]).process(await readFile(path.join(root,'app/globals.css'),'utf8'),{from:path.join(root,'app/globals.css')})).css;
 const bundle=await readFile(path.join(temp,'bundle.js'));
 server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'text/javascript; charset=utf-8':req.url==='/style.css'?'text/css; charset=utf-8':'text/html; charset=utf-8');res.end(req.url==='/bundle.js'?bundle:req.url==='/style.css'?css:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body style="padding:16px"><div id="root"></div><script src="/bundle.js"></script></body></html>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
 const context=await browser.newContext({viewport:{width:1180,height:757},serviceWorkers:'block'});
 const external=[],errors=[];await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():(external.push(r.request().url()),r.abort()));
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 if(evidence)await mkdir(evidence,{recursive:true});
 if(process.env.BOTS_BASELINE_ONLY){
  await page.goto(origin);await page.waitForFunction(()=>window.pending.length===3);
  await page.screenshot({path:path.join(evidence,'before-loading-desktop.png')});
 }else{
 for(const state of ['loading','loaded','empty','failed','partial','stale']){
  await page.goto(origin);await page.waitForFunction(()=>window.pending.length===3);
  if(state!=='loading')await page.evaluate(s=>window.settle(s),state);
  if(state!=='loading')await page.getByText('Loading the latest shared bot state in the background.',{exact:false}).waitFor({state:'hidden'});
  for(const [name,metric] of [['Runtime context','Bots running'],['Capital and performance','Total money invested'],['Positions and exposure','Live exposure']]){
   const tab=page.getByRole('tab',{name,exact:true});await tab.click();await page.getByRole('tabpanel').getByRole('rowheader',{name:metric,exact:true}).waitFor();
   if(state==='loading'||state==='empty'||state==='failed'){
    if(name!=='Runtime context')assert.match(await page.getByRole('tabpanel').textContent(),/—/);
   }
   if(state==='loaded'&&name==='Capital and performance')assert.match(await page.getByRole('tabpanel').textContent(),/\$400/);
   if(state==='stale')assert.match(await page.getByText('Last refreshed',{exact:false}).first().textContent(),/Jan/);
   if(evidence)await page.screenshot({path:path.join(evidence,`${state}-${name.split(' ')[0]}.png`)});
  }
  await page.getByRole('button',{name:'Return to Runtime context'}).click();assert.equal(await page.getByRole('tab',{name:'Runtime context',exact:true}).getAttribute('aria-selected'),'true');
  await page.keyboard.press('ArrowRight');await page.getByRole('tab',{name:'Capital and performance',exact:true}).waitFor();assert.equal(await page.getByRole('tab',{name:'Capital and performance',exact:true}).getAttribute('aria-selected'),'true');
  const details=page.getByRole('button',{name:'Details',exact:true}).first();for(let i=0;i<2;i++){await details.click();assert.equal(await details.getAttribute('aria-expanded'),'true');await details.click();assert.equal(await details.getAttribute('aria-expanded'),'false');}
  assert.equal(await page.getByRole('link',{name:'Open',exact:true}).count(),4);
  await page.setViewportSize({width:390,height:844});
  const lastTab=await page.getByRole('tab',{name:'Positions and exposure',exact:true}).boundingBox();const panel=await page.getByRole('tabpanel').boundingBox();assert.ok(lastTab.y+lastTab.height<=panel.y,'Narrow tabs must not overlap content');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);if(evidence)await page.screenshot({path:path.join(evidence,`${state}-narrow.png`)});await page.setViewportSize({width:1180,height:757});
 }
 await page.evaluate(()=>{history.pushState({},'', '/fixture-away');});await page.goBack();await page.getByRole('heading',{name:'Overview',exact:true}).waitFor();
 }
 assert.deepEqual(external,[]);assert.deepEqual(errors,[]);console.log(process.env.BOTS_BASELINE_ONLY?'PASS: baseline desktop captured.':'PASS: six source states (including stale source), back navigation; all three views; desktop and narrow without tab overlap; keyboard; repeated details; four console links; zero external requests.');
}finally{await browser?.close();if(server)await new Promise(r=>server.close(r));await rm(temp,{recursive:true,force:true});}

/** Actual scanner component with isolated local data; never contacts a provider. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const frontend = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'scanner-fixture-'));
const evidence = process.env.SCANNER_EVIDENCE_DIR;
const source = await readFile(path.join(frontend, 'app/console/technical-setups/page.tsx'), 'utf8');
const catalogue = {};
new Function('exports', ts.transpileModule(await readFile(path.join(frontend,'lib/technicalSetups.ts'),'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(catalogue);
await writeFile(path.join(temporary, 'entry.tsx'), `
import React from 'react'; import {createRoot} from 'react-dom/client';
import Page from ${JSON.stringify(path.join(frontend, 'app/console/technical-setups/page.tsx'))};
createRoot(document.getElementById('root')).render(<Page/>);`);
await writeFile(path.join(temporary, 'final.ts'), `
export const fetchAllFullRuns=()=>new Promise((resolve,reject)=>{window.fixtureResolve=()=>resolve([]);window.fixtureReject=()=>reject(new Error('Offline source unavailable'));});
export const buildTechnicalScanMap=()=>({}); export const compareSetupStocksByAction=()=>0;
export const extractRebalanceInputFingerprint=()=>''; export const buildConsensusRows=()=>[];
export const isCompletedRebalanceRun=()=>true; export const finalActionCategoryDomId=()=> 'buy-new';
export const getSetupStockActionClasses=()=>({row:'',cell:'',nameCell:''});
export const getSetupStockGroups=(_rows,_scans,market)=>market==='us'||location.search.includes('empty')?{}:{'Breakout + retest':{setup:'Breakout + retest',stocks:[{key:'fixture',name:'Fixture stock',symbol:'FIXTURE',market:'india',action:'Buy New',currentUnits:'Unavailable',currentValue:location.search.includes('stale')?'INR 100 · saved 2020-01-01T00:00:00Z':'INR 100 · fixture only'}]}};
`);
await writeFile(path.join(temporary, 'api.ts'), `export const apiService={zerodhaPortfolioOverview:async()=>{if(location.search.includes('partial'))throw new Error('Offline portfolio unavailable');return {latest:null}},indmoneyUsPortfolioOverview:async()=>({latest:null})};`);
await writeFile(path.join(temporary, 'link.tsx'), `import React from 'react';export default function Link(p){return <a {...p}/>};export function TradingViewSymbolLink({children}){return <a href='#fixture-symbol'>{children}</a>}`);
await writeFile(path.join(temporary, 'loader.cjs'), `const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(s){return ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020},fileName:this.resourcePath}).outputText;};`);
let server, browser;
try {
  const w = require('next/dist/compiled/webpack/webpack');
  await new Promise((resolve,reject)=>w.webpack({mode:'development',devtool:false,entry:path.join(temporary,'entry.tsx'),output:{path:temporary,filename:'bundle.js'},resolve:{extensions:['.tsx','.ts','.js'],modules:[path.join(frontend,'node_modules')],alias:{'@/app/console/_components/FinalActionablesConsole$':path.join(temporary,'final.ts'),'@/services/api$':path.join(temporary,'api.ts'),'next/link$':path.join(temporary,'link.tsx'),'@/components/shared/TradingViewSymbolLink$':path.join(temporary,'link.tsx'),'@':frontend}},module:{rules:[{test:/\.tsx?$/,use:path.join(temporary,'loader.cjs')}]},plugins:[new w.webpack.DefinePlugin({'process.env.NODE_ENV':JSON.stringify('development')})]},(e,s)=>e?reject(e):s.hasErrors()?reject(new Error(s.toString({all:false,errors:true}))):resolve()));
  const { compile } = await import('@tailwindcss/node');
  const css = await compile('@import "tailwindcss";', {base:frontend,onDependency:()=>{}});
  const styles = css.build(source.split(/[\s"'`{}]+/));
  const bundle = await readFile(path.join(temporary,'bundle.js'));
  server=createServer((req,res)=>{if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript; charset=utf-8');return res.end(bundle);}res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}body{font-family:Arial,sans-serif;margin:24px}</style><div id="root"></div><script src="/bundle.js"></script>`);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/usr/bin/chromium'});
  const context=await browser.newContext({viewport:{width:1180,height:757},serviceWorkers:'block'});
  const denied=[],errors=[];
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){denied.push(route.request().url());return route.abort();}return route.continue();});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const capture=async name=>{if(evidence){await mkdir(evidence,{recursive:true});await page.screenshot({path:path.join(evidence,name+'.png'),fullPage:true});await page.screenshot({path:path.join(evidence,name+'-viewport.png')});}};
  await page.goto(origin);await page.getByRole('status').waitFor();
  assert.equal(await page.getByRole('status').count(),1);
  assert.equal(await page.locator('tbody').getByText(/Loading|Unavailable|\(0\)/).count(),0);
  assert.equal(await page.locator('table[aria-describedby="setup-counts-status"]').count(),2);
  assert.equal(await page.locator('thead tr').first().locator('th').count(),5);
  assert.equal(await page.locator('tbody tr').count(),45);
  // Every offscreen catalogue rule and score is preserved, not just the four mapped examples.
  for (const row of [...catalogue.BULLISH_SETUPS,...catalogue.BEARISH_SETUPS]) {
    const cells=await page.locator('#'+catalogue.technicalSetupDomId(row.setup)).locator('td').allTextContents();
    assert.deepEqual(cells,[row.setup, row.confidence.toFixed(1)+'/10',row.bestUse,row.trigger,row.invalidation]);
  }
  await capture('loading-1180');
  const sort=page.getByRole('button',{name:'Confidence',exact:true}).first();
  await sort.focus();await page.keyboard.press('Enter');
  assert.equal(await sort.locator('..').getAttribute('aria-sort'),'descending');
  await page.keyboard.press('Enter');assert.equal(await sort.locator('..').getAttribute('aria-sort'),'ascending');
  const beforeSwitch=await page.locator('tbody tr').first().getAttribute('id');
  const comparison=page.getByRole('tab',{name:'Setup comparison',exact:true});
  const guidance=page.getByRole('tab',{name:'Sorting guidance',exact:true});
  await guidance.click();assert.equal(await guidance.getAttribute('aria-selected'),'true');
  assert.equal(await page.getByRole('table').count(),0);
  const guidancePanel=page.getByRole('tabpanel',{name:'Sorting guidance',exact:true});
  for(const value of ['Highest stock count, then highest confidence, then alphabetical','Highest confidence first','Toggle descending and ascending order','SellAll, Add More, Buy New, Trim, Hold'])assert.match(await guidancePanel.textContent(),new RegExp(value));
  assert.equal(await page.getByText('No sort or trade was executed in this visual audit.').count(),0);
  await capture('guidance-1180');
  await page.getByRole('button',{name:'Return to Setup comparison',exact:true}).click();
  assert.equal(await sort.evaluate(el=>el===document.activeElement),true);
  assert.equal(await sort.locator('..').getAttribute('aria-sort'),'ascending');
  assert.equal(await page.locator('tbody tr').first().getAttribute('id'),beforeSwitch);
  await comparison.focus();await page.keyboard.press('ArrowRight');
  assert.equal(await guidance.evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('Home');assert.equal(await comparison.evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('End');assert.equal(await guidance.evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('ArrowLeft');assert.equal(await comparison.evaluate(el=>el===document.activeElement),true);
  for(const table of await page.getByRole('table').all()) {
    for(const header of await table.locator('thead button').all()) {
      const prior=await header.locator('..').getAttribute('aria-sort');
      await header.focus();await page.keyboard.press('Enter');
      const next=prior==='descending'?'ascending':'descending';
      assert.equal(await header.locator('..').getAttribute('aria-sort'),next);
      await page.keyboard.press('Enter');
      assert.equal(await header.locator('..').getAttribute('aria-sort'),next==='ascending'?'descending':'ascending');
    }
  }
  await page.evaluate(()=>window.fixtureResolve());await page.getByRole('status').waitFor({state:'detached'});
  assert.equal(await page.locator('table[aria-describedby]').count(),0);
  const setup=page.getByRole('button',{name:/Breakout \+ retest/});await setup.click();
  await page.getByRole('dialog').waitFor();assert.match(await page.getByRole('dialog').textContent(),/INR 100 · fixture only/);
  for(let i=0;i<2;i++){await page.getByRole('button',{name:'Close setup stocks popup'}).click();await page.getByRole('dialog').waitFor({state:'detached'});await setup.click();}
  await page.getByRole('button',{name:'Close setup stocks popup'}).click();await capture('loaded-1180');
  await page.setViewportSize({width:390,height:844});await capture('loaded-narrow');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const overflow=page.locator('#setup-comparison-panel .overflow-x-auto').first();
  await overflow.evaluate(el=>el.scrollLeft=el.scrollWidth);
  assert.equal(await overflow.evaluate(el=>el.scrollLeft>0),true);
  await guidance.click();await capture('guidance-narrow');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.goto(origin+'/?empty');await page.getByRole('status').waitFor();await page.evaluate(()=>window.fixtureResolve());
  await page.getByRole('status').waitFor({state:'detached'});assert.equal(await page.locator('tbody').getByText(/\(0\)/).count(),45);
  await page.goto(origin);await page.getByRole('status').waitFor();await page.evaluate(()=>window.fixtureReject());
  await page.getByRole('alert').waitFor();assert.equal(await page.locator('tbody').getByText(/Unavailable/).count(),45);
  assert.equal(await page.locator('tbody').getByText(/\(0\)/).count(),0);await capture('failed-narrow');
  await page.getByRole('button',{name:'Retry counts'}).click();await page.getByRole('status').waitFor();
  assert.equal(await page.locator('tbody').getByText(/Loading|Unavailable|\(0\)/).count(),0);
  await page.evaluate(()=>window.fixtureResolve());await page.getByRole('status').waitFor({state:'detached'});
  await page.goto(origin+'/?partial');await page.getByRole('alert').waitFor();assert.match(await page.getByRole('alert').textContent(),/Offline portfolio unavailable/);
  assert.equal(await page.locator('tbody').getByText(/\(0\)/).count(),0);
  await page.goBack();await page.getByRole('status').waitFor();
  await page.goto(origin+'/?stale');await page.getByRole('status').waitFor();await page.evaluate(()=>window.fixtureResolve());
  await page.getByRole('status').waitFor({state:'detached'});await page.getByRole('button',{name:/Breakout \+ retest/}).click();
  assert.match(await page.getByRole('dialog').textContent(),/INR 100 · saved 2020-01-01T00:00:00Z/);
  assert.doesNotMatch(await page.getByRole('dialog').textContent(),/fresh|live|current quote/i);
  assert.deepEqual(denied,[]);assert.deepEqual(errors,[]);
  console.log('PASS: every field/score/rule in 45 catalogue rows; five columns; shared loading; comparison/guidance tabs and return; retained sort and focus; keyboard sorting/tab arrows/Home/End; loaded counts/actions; dialog reopen; desktop/narrow overflow; empty, failed/retry, partial fail-closed, historical saved value preservation; back navigation; no external requests.');
} finally {await browser?.close();if(server)await new Promise(r=>server.close(r));await rm(temporary,{recursive:true,force:true});}

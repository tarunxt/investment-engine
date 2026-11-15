// Isolated browser verification of the real hook and popup, with read-only fixture data.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { chromium } from 'playwright';
const require = createRequire(import.meta.url);
const webpack = require('next/dist/compiled/webpack/webpack-lib');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(path.join(tmpdir(), 'basket-metric-'));
const compile = text => ts.transpileModule(text, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX}}).outputText;
let browser;
try {
  for (const [source, name] of [['components/BasketMetricPopup.tsx','popup'],['components/BasketDisplayCalculations.tsx','hook'],['lib/basketDisplayCalculations.ts','math']]) {
    let text = await readFile(path.join(root, source), 'utf8');
    text = text.replace('import styles from "./BasketMetricPopup.module.css";', 'const styles = new Proxy({}, {get: (_, key) => key});')
      .replace('"./BasketMetricPopup"','"./popup.js"').replace('"@/lib/basketDisplayCalculations"','"./math.js"')
      .replace('import { apiService } from "@/services/api";', 'const apiService = { getBasketScoreHistory: async () => window.fixture };');
    await writeFile(path.join(temp, `${name}.js`), compile(text));
  }
  await writeFile(path.join(temp, 'entry.js'), compile(`import React from 'react'; import {createRoot} from 'react-dom/client'; import {useBasketDisplayCalculations} from './hook.js';
    const stock={symbol:'CDSL',exchange:'NSE',score:2.491666666667,action:'Buy New',ltp:null,limitPrice:1232};
    window.fixture={market:'india',symbols:['CDSL'],as_of:'2026-10-29T17:30:01Z',window_start:'2026-10-24T17:30:01Z',timezone:'UTC',days:5,truncated:false,observations:[{id:1,run_id:447,symbol:'CDSL',exchange:'NSE',covered_at:'2026-10-29T12:00:00Z',score:2.491666666667,action:'Buy New',formula_version:'Original saved score',completed:true,coverage_status:'suggested'}],notes:['Missing observations are never zero.']};
    function App(){const state=useBasketDisplayCalculations(true,'india',[stock],288785.71,'2026-10-29T09:11:18Z','Zerodha');return <main><h1>Basket popup verification</h1><table><tbody><tr>{state.cells(stock)}</tr></tbody></table>{state.popup}</main>} createRoot(document.getElementById('root')).render(<App/>);`));
  await new Promise((resolve,reject) => webpack({mode:'development',entry:path.join(temp,'entry.js'),output:{path:temp,filename:'bundle.js'},resolve:{modules:[path.join(root,'node_modules'),'node_modules']},devtool:false},(err,stats)=>err || stats.hasErrors()?reject(err || new Error(stats.toString({all:false,errors:true}))):resolve()));
  const css = (await readFile(path.join(root,'components/BasketMetricPopup.module.css'),'utf8')).replaceAll(':global(.dark)', '.dark');
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setContent(`<html><head><style>*{box-sizing:border-box}body{font-family:Arial,sans-serif;margin:0;background:#e4eee9}button{font:inherit;border:0;background:none}main{padding:30px}.overflow-x-auto{overflow-x:auto}${css}</style></head><body><div id="root"></div></body></html>`);
  await page.addScriptTag({path:path.join(temp,'bundle.js')});
  for(const dark of [false,true]){
    await page.evaluate(dark=>document.documentElement.classList.toggle('dark',dark),dark);
    for(const [kind,value] of [['Final Weight','9.5%'],['Historical Weighted Score','2.4917'],['ZerodhaStocks','22'],['Zerodha Amount','₹27,104.00']]){
      const opener=page.getByRole('button',{name:`CDSL ${kind} calculation`,exact:true});await opener.click();
      const summary=page.getByRole('dialog',{name:kind,exact:true});await summary.waitFor();
      assert.equal(await summary.locator('.value').textContent(),value);
      assert.equal(await summary.evaluate(e=>getComputedStyle(e).backgroundColor),dark?'rgb(32, 39, 56)':'rgb(255, 255, 255)');
      assert.equal(await summary.getByText('Missing observations are never zero.').count(),0);
      await summary.getByRole('button',{name:'Calculation details',exact:true}).click();
      const details=page.getByRole('dialog',{name:'Behind the number'});await details.waitFor();
      assert.equal(await page.locator('.overlay[inert]').count(),1);
      assert.equal(await details.getByText('Missing observations are never zero.').count(),1);
      if(kind==='Historical Weighted Score') assert.equal(await details.locator('table').evaluate(e=>getComputedStyle(e).color),dark?'rgb(244, 246, 255)':'rgb(22, 58, 50)');
      await details.getByRole('button',{name:'Back to summary'}).focus();await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'Close calculation details');
      await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),1);
      assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'Calculation details');
      if(kind==='ZerodhaStocks')await page.screenshot({path:path.join(temp,dark?'midnight.png':'mint.png')});
      await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),0);
      assert.equal(await opener.evaluate(e=>e===document.activeElement),true);
    }
  }
  await page.setViewportSize({width:320,height:700});
  await page.getByRole('button',{name:'CDSL Historical Weighted Score calculation',exact:true}).click();
  await page.getByRole('button',{name:'Calculation details',exact:true}).click();
  const details=page.getByRole('dialog',{name:'Behind the number'});
  assert.equal(await details.evaluate(e=>e.scrollWidth<=e.clientWidth),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:path.join(temp,'mobile.png')});
  await details.getByRole('button',{name:'Back to summary'}).click();
  assert.equal(await page.getByRole('dialog').count(),1);
  assert.deepEqual(errors,[]);
  console.log('PASS: four metrics, both themes, detail preservation, focus trap/return, Escape layering, mobile overflow.');
  if(process.env.POPUP_SCREENSHOT_DIR){const {copyFile,mkdir}=await import('node:fs/promises');await mkdir(process.env.POPUP_SCREENSHOT_DIR,{recursive:true});for(const name of ['mint.png','midnight.png','mobile.png'])await copyFile(path.join(temp,name),path.join(process.env.POPUP_SCREENSHOT_DIR,name));}
} finally {await browser?.close();await rm(temp,{recursive:true,force:true});}

#!/usr/bin/env node
/** Offline acceptance of the production saved-output loader and dialog. No production calls. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { chromium } from 'playwright';
const require = createRequire(import.meta.url);
const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'saved-output-fixture-'));
const entry = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {PromptTemplateDialog} from ${JSON.stringify(path.join(frontend,'app/console/automated-rebalance/_components/PromptTemplateDialog.tsx'))};
import {readZerodhaSwingSettings,zerodhaSwingSettingsKey} from ${JSON.stringify(path.join(frontend,'lib/swingTrade.ts'))};
function App(){
  const [open,setOpen]=useState(null);
  const [settings,setSettings]=useState(()=>readZerodhaSwingSettings(42));
  return <>
    <button onClick={()=>setOpen('threats')}>Open preview</button>
    <button onClick={()=>setOpen('swing')}>Edit Swing Scan</button>
    {open&&<PromptTemplateDialog title={'Zerodha '+open+' prompt'} body="TOKEN_FIXTURE_ONLY"
      swingSettings={open==='swing'?settings:undefined}
      onSaveSwingSettings={value=>{localStorage.setItem(zerodhaSwingSettingsKey(42),JSON.stringify(value));setSettings(value)}}
      onClose={()=>setOpen(null)} onReviewInputs={()=>{window.reviewed=true;setOpen(null)}}/>}
  </>;
}
createRoot(document.getElementById('root')).render(<App/>);`;
let browser, server;
try {
  await writeFile(path.join(temporary,'entry.tsx'),entry);
  await writeFile(path.join(temporary,'loader.cjs'),`const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(s){return ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020},fileName:this.resourcePath}).outputText;};`);
  const w=require('next/dist/compiled/webpack/webpack');
  await new Promise((resolve,reject)=>w.webpack({mode:'development',devtool:false,entry:path.join(temporary,'entry.tsx'),output:{path:temporary,filename:'bundle.js'},resolve:{extensions:['.tsx','.ts','.js'],modules:[path.join(frontend,'node_modules'),'node_modules']},module:{rules:[{test:/\.tsx?$/,use:path.join(temporary,'loader.cjs')}]},plugins:[new w.webpack.DefinePlugin({'process.env.NODE_ENV':JSON.stringify('development')})]},(e,s)=>e?reject(e):s.hasErrors()?reject(new Error(s.toString({all:false,errors:true}))):resolve()));
  const css=(await postcss([tailwind()]).process('@import "tailwindcss";',{from:path.join(frontend,'app/fixture.css')})).css;
  const bundle=await readFile(path.join(temporary,'bundle.js'));
  server=createServer((req,res)=>{if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');return res.end(bundle)}res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<meta charset="utf-8"><style>${css}</style><div id="root"></div><script src="/bundle.js"></script>`)});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
  const context=await browser.newContext();
  const external=[];
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){external.push(route.request().url());return route.abort()}return route.continue()});
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin);
  const dialog=page.getByRole('dialog');
  for(const width of [1440,390]) {
    await page.setViewportSize({width,height:900});
    await page.getByText('Open preview',{exact:true}).click();
    await dialog.getByText('Template only',{exact:true}).waitFor();
    assert.match(await dialog.textContent(),/not the eventual request/);
    assert.equal(await dialog.getByText('TOKEN_FIXTURE_ONLY').isVisible(),false);
    assert.equal(await dialog.locator('input,textarea').count(),0);
    await page.screenshot({path:'/tmp/prompt-context-'+width+'.png'});
    await dialog.locator('summary').click();
    assert.equal(await dialog.getByText('TOKEN_FIXTURE_ONLY').isVisible(),true);
    await page.keyboard.press('Escape'); await dialog.waitFor({state:'detached'});
    await page.getByText('Open preview',{exact:true}).click();
    await page.getByRole('button',{name:'Review selected inputs'}).click();
    await dialog.waitFor({state:'detached'});assert.equal(await page.evaluate(()=>window.reviewed),true);
  }
  const edit = page.getByRole('button',{name:'Edit Swing Scan'});
  const count = dialog.getByLabel('Stocks to search');
  const amount = dialog.getByLabel('Amount to invest');
  const horizon = dialog.getByLabel('Swing horizon');
  const save = dialog.getByRole('button',{name:'Save settings'});
  await edit.click();
  assert.deepEqual(await Promise.all([count.inputValue(),amount.inputValue(),horizon.inputValue()]),['5','50,000','1–3 months']);
  await count.fill('1.5');
  assert.equal(await save.isDisabled(),true);
  await count.fill('8');
  await amount.fill('0');
  assert.equal(await save.isDisabled(),true);
  await amount.fill('125000');
  await horizon.fill('6–2 weeks');
  assert.equal(await save.isDisabled(),true);
  await horizon.fill('2–6 weeks');
  const preview = await dialog.locator('pre').innerText();
  assert.match(preview,/Choose exactly 8 stocks/);
  assert.match(preview,/INR 1,25,000/);
  assert.match(preview,/reaching target in 2–6 weeks/);
  assert.doesNotMatch(preview,/50,000|1–3 months|2–12 weeks/i);
  await save.click();
  await dialog.getByText('Saved for your next Zerodha Swing Scan in this browser.').waitFor();
  await page.reload();
  await edit.click();
  assert.deepEqual(await Promise.all([count.inputValue(),amount.inputValue(),horizon.inputValue()]),['8','1,25,000','2–6 weeks']);
  await count.fill('1');
  assert.match(await dialog.locator('pre').innerText(),/Choose exactly 1 stock\./);
  await page.keyboard.press('Escape');
  await edit.click();
  assert.equal(await count.inputValue(),'8');
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log('PASS: template review on desktop and mobile, live Swing inputs, invalid values, save, reload and discard.');
} finally {await browser?.close();await new Promise(r=>server?server.close(r):r());await rm(temporary,{recursive:true,force:true});}

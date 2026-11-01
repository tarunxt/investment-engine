#!/usr/bin/env node
/** Offline acceptance of the production saved-output loader and dialog. No production calls. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { chromium } from 'playwright';
const require = createRequire(import.meta.url);
const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'saved-output-fixture-'));
const entry = `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {PromptTemplateDialog} from ${JSON.stringify(path.join(frontend,'app/console/automated-rebalance/_components/PromptTemplateDialog.tsx'))};function App(){const [open,setOpen]=useState(false);return <><button onClick={()=>setOpen(true)}>Open preview</button>{open&&<PromptTemplateDialog title="Zerodha Threats Scan prompt" body="TOKEN_FIXTURE_ONLY" onClose={()=>setOpen(false)} onReviewInputs={()=>{window.reviewed=true;setOpen(false)}}/>}</>}createRoot(document.getElementById('root')).render(<App/>);`;
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
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log('PASS: desktop/narrow template distinction, collapsed tokens, read-only, review handoff, Escape, zero external requests. Input loading/empty/error/partial inapplicable to synchronous template dialog.');
} finally {await browser?.close();await new Promise(r=>server?server.close(r):r());await rm(temporary,{recursive:true,force:true});}

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
const temp=await mkdtemp(path.join(tmpdir(),'bot-recovery-'));
const evidence=path.resolve(root,'../docs/verification/state-bots-page-error-recovery');
let browser,server;
try {
 await mkdir(evidence,{recursive:true});
 await writeFile(path.join(temp,'entry.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import {BotStateReadError} from ${JSON.stringify(path.join(root,'components/console/BotStateReadError.tsx'))};const q=new URLSearchParams(location.search);const retained=q.has('partial');createRoot(document.getElementById('root')).render(<main><BotStateReadError pageName={q.has('direct')?'Polymarket Direct Bot':'Polymarket Copy Bot'} error={'HTTP 503: Endpoint unavailable (synthetic fixture)'} retained={retained}/>{retained?<p>Previously verified fixture: account value $123.45</p>:null}</main>);`);
 await writeFile(path.join(temp,'loader.cjs'),`const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(s){return ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020},fileName:this.resourcePath}).outputText;}`);
 const w=require('next/dist/compiled/webpack/webpack');
 await new Promise((resolve,reject)=>w.webpack({mode:'development',devtool:false,entry:path.join(temp,'entry.tsx'),output:{path:temp,filename:'bundle.js'},resolve:{extensions:['.tsx','.ts','.js'],modules:[path.join(root,'node_modules')]},module:{rules:[{test:/\.tsx?$/,use:path.join(temp,'loader.cjs')}]},plugins:[new w.webpack.DefinePlugin({'process.env':JSON.stringify({NODE_ENV:'development'})})]},(e,s)=>e?reject(e):s.hasErrors()?reject(new Error(s.toString({all:false,errors:true}))):resolve()));
 const css=(await require('postcss')([require('@tailwindcss/postcss')({base:root})]).process(await readFile(path.join(root,'app/globals.css'),'utf8'),{from:path.join(root,'app/globals.css')})).css;
 const bundle=await readFile(path.join(temp,'bundle.js'));
 server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'text/javascript':req.url==='/style.css'?'text/css':'text/html');res.end(req.url==='/bundle.js'?bundle:req.url==='/style.css'?css:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body style="padding:24px"><div id="root"></div><script src="/bundle.js"></script></body></html>')}).listen(0,'127.0.0.1');
 await new Promise(r=>server.once('listening',r));const origin=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});const external=[],errors=[];
 page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():(external.push(r.request().url()),r.abort()));
 for(const direct of [false,true])for(const partial of [false,true]){
  const id=`${direct?'direct':'copy'}-${partial?'partial':'error'}`;
  await page.goto(origin+`/?${direct?'direct&':''}${partial?'partial':''}`);
  await page.getByRole('heading',{name:/state unavailable/}).waitFor();
  assert.match(await page.getByRole('status').innerText(),/data could not be checked/);
  assert.equal(await page.getByRole('button').count(),0);
  assert.equal(await page.getByRole('link',{name:'Back to console'}).getAttribute('href'),'/console');
  if(partial)assert.match(await page.locator('main').innerText(),/123.45/);
  await page.keyboard.press('Tab');assert.equal(await page.getByRole('link').evaluate(e=>e===document.activeElement),true);
  const focus=await page.getByRole('link').evaluate(e=>getComputedStyle(e).outlineStyle);assert.notEqual(focus,'none');
  await page.screenshot({path:path.join(evidence,id+'-desktop100.png')});
  await page.keyboard.press('Tab');await page.keyboard.press('Enter');await page.getByText('HTTP 503:',{exact:false}).waitFor();
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:path.join(evidence,id+'-narrow.png')});
  await page.getByRole('link').click();await page.waitForURL('**/console');await page.goBack();await page.getByRole('heading',{name:/state unavailable/}).waitFor();
  await page.setViewportSize({width:1440,height:900});
 }
 assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
 await writeFile(path.join(evidence,'browser-result.json'),JSON.stringify({timestamp:new Date().toISOString(),cases:4,passed:4,failed:0,desktop:{width:1440,height:900,deviceScaleFactor:1},narrow:{width:390,height:844},checks:['actual recovery component','copy and direct','initial error and retained data','keyboard focus and details','back to console and browser back','no external requests'],limitations:['Populated-success, verified-empty and loading pages are not exercised by this recovery-component browser harness.']},null,2));
 console.log('PASS 4 recovery browser fixtures; desktop100%, narrow, keyboard and back navigation; no external requests.');
}finally{await browser?.close();if(server)await new Promise(r=>server.close(r));await rm(temp,{recursive:true,force:true});}

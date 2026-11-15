/** STATE-Mails-History-FailedVersusEmpty / VISUAL-MAILS-HISTORY-HIERARCHY; actual page, offline reads. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = process.env.MAIL_PREFS_SOURCE_ROOT || frontend;
const temporary = await mkdtemp(path.join(tmpdir(), 'mail-prefs-fixture-'));
let browser, server;
try {
  await writeFile(path.join(temporary, 'entry.tsx'), `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import MailsPage from ${JSON.stringify(path.join(sourceRoot, 'app/console/mails/page.tsx'))};
    window.reads=[];window.mutations=[];
    window.fetch=(url,options={})=>{
      if(options.method&&options.method!=='GET'){window.mutations.push(url);return Promise.reject(new Error('Forbidden mutation'));}
      const source=String(url).includes('api.github.com')?'github':String(url).includes('/history')?'mail':null;
      if(source)return new Promise(resolve=>window.reads.push({source,resolve}));
      return Promise.resolve(new Response(JSON.stringify({items:[]}),{status:200}));
    };
    window.settleOne=(source,index,status,items)=>{const r=window.reads.filter(r=>r.source===source)[index];if(!r||r.done)throw new Error('Missing pending fixture read');r.done=true;r.resolve(new Response(JSON.stringify(source==='github'?{workflow_runs:items}:{items}),{status}));};
    window.settle=(source,status,items)=>window.reads.filter(r=>r.source===source&&!r.done).forEach(r=>{r.done=true;r.resolve(new Response(JSON.stringify(source==='github'?{workflow_runs:items}:{items}),{status}));});
    createRoot(document.getElementById('root')).render(<React.StrictMode><MailsPage/></React.StrictMode>);
  `);
  await writeFile(path.join(temporary, 'loader.cjs'), `const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(s){return ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020},fileName:this.resourcePath}).outputText;};`);
  const w = require('next/dist/compiled/webpack/webpack');
  await new Promise((resolve, reject) => w.webpack({
    mode: 'development', devtool: false, entry: path.join(temporary, 'entry.tsx'),
    output: { path: temporary, filename: 'bundle.js' },
    resolve: { extensions: ['.tsx', '.ts', '.js'], modules: [path.join(frontend, 'node_modules')], alias: { '@': sourceRoot } },
    module: { rules: [{ test: /\.tsx?$/, use: path.join(temporary, 'loader.cjs') }] },
    plugins: [new w.webpack.DefinePlugin({ 'process.env': JSON.stringify({ NODE_ENV: 'development' }) })],
  }, (error, stats) => error ? reject(error) : stats.hasErrors() ? reject(new Error(stats.toString({ all: false, errors: true }))) : resolve()));
  const css=(await require('postcss')([require('@tailwindcss/postcss')({base:frontend})]).process(await readFile(path.join(frontend,'app/globals.css'),'utf8'),{from:path.join(frontend,'app/globals.css')})).css;
  const bundle=await readFile(path.join(temporary,'bundle.js'));
  server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'text/javascript; charset=utf-8':req.url==='/style.css'?'text/css; charset=utf-8':'text/html; charset=utf-8');res.end(req.url==='/bundle.js'?bundle:req.url==='/style.css'?css:'<!doctype html><title>Offline history fixture</title><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/bundle.js"></script>');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true});
  const context=await browser.newContext({viewport:{width:1180,height:757},serviceWorkers:'block'});
  const external=[],errors=[];
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():(external.push(route.request().url()),route.abort()));
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const panel=page.getByRole('region',{name:'Sent mail history',exact:true}),results=panel.getByRole('tabpanel'),refresh=panel.getByRole('button',{name:'Refresh',exact:true});
  const tab=name=>panel.getByRole('tab',{name:new RegExp('^'+name)});
  const settle=(source,status,items=[])=>page.evaluate(args=>window.settle(...args),[source,status,items]);
  const noEmpty=async()=>assert.doesNotMatch(await results.textContent(),/No .*recorded yet|No GitHub workflow notifications/);
  const output=path.resolve(frontend,'../artifacts/visual-mails-history');await mkdir(output,{recursive:true});
  const shot=async name=>{await panel.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,name+'.png')});};
  const item=(id,category)=>({id,category,status:'sent',trigger:'Fixture only',subject:'Saved '+category+' notification',created_at:'2026-11-01T00:00:00Z',recipients:[],message:'Local fixture',remarks:'Fixture',warnings:[]});
  const run={id:1,name:'Fixture checks',run_number:7,status:'completed',conclusion:'success',display_title:'Local workflow result',event:'pull_request',head_branch:'fixture',head_sha:'12345678',created_at:'2026-11-01T00:00:00Z',html_url:origin+'/workflow'};
  await page.goto(origin);await results.getByRole('status').waitFor();
  assert.equal(await panel.getByRole('tab').count(),5);assert.match(await tab('All Cred-X').textContent(),/Unavailable/);assert.equal(await refresh.getAttribute('aria-disabled'),'true');await noEmpty();await shot('desktop-loading');
  // StrictMode creates two reads per source: resolve the latest before the older one.
  await page.waitForFunction(()=>window.reads.filter(r=>r.source==='mail').length===2&&window.reads.filter(r=>r.source==='github').length===2);
  await page.evaluate(({run})=>{window.settleOne('mail',1,503,[]);window.settleOne('github',1,200,[run]);},{run});
  await results.getByRole('alert').waitFor();
  await page.evaluate(({item})=>{window.settleOne('mail',0,200,[item]);window.settleOne('github',0,503,[]);},{item:item(99,'runs')});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await results.locator('article').count(),0);assert.match(await tab('All Cred-X').textContent(),/Unavailable/);
  await results.getByRole('alert').waitFor();await noEmpty();assert.match(await tab('GitHub checks').textContent(),/1/);await shot('desktop-unavailable-partial');
  await tab('GitHub checks').click();await results.getByText('Local workflow result',{exact:true}).waitFor();assert.equal(await results.getByRole('alert').count(),0);await shot('desktop-github');
  await tab('GitHub checks').focus();
  for(const [key,name] of [['Home','All Cred-X'],['ArrowDown','Run notifications'],['End','GitHub checks'],['ArrowDown','All Cred-X']]){await page.keyboard.press(key);assert.equal(await tab(name).getAttribute('aria-selected'),'true');assert.equal(await tab(name).evaluate(e=>e===document.activeElement),true);}
  await refresh.focus();await page.keyboard.press('Enter');await results.getByRole('status').waitFor();await noEmpty();assert.equal(await refresh.getAttribute('aria-disabled'),'true');
  const pendingReads=await page.evaluate(()=>window.reads.length);await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>window.reads.length),pendingReads);
  await settle('mail',200,[item(1,'runs'),item(2,'alerts'),item(3,'account')]);await settle('github',200,[run]);await results.getByText('Saved runs notification',{exact:true}).waitFor();assert.equal(await results.locator('article').count(),3);assert.match(await tab('All Cred-X').textContent(),/3/);
  for(const name of ['Run notifications','Risk alerts & tests','Account & security']){await tab(name).click();assert.equal(await results.locator('article').count(),1);}
  const details=results.locator('details');for(let i=0;i<2;i++){await details.locator('summary').click();assert.equal(await details.getAttribute('open'),'');await details.locator('summary').click();assert.equal(await details.getAttribute('open'),null);}
  await tab('All Cred-X').click();await shot('desktop-loaded');
  await tab('Risk alerts & tests').click();await refresh.focus();await page.keyboard.press('Enter');
  assert.equal(await tab('Risk alerts & tests').getAttribute('aria-selected'),'true');
  await settle('mail',503);await settle('github',503);await results.getByRole('alert').waitFor();await noEmpty();
  assert.equal(await tab('Risk alerts & tests').getAttribute('aria-selected'),'true');
  assert.equal(await refresh.evaluate(e=>e===document.activeElement),true);
  await tab('All Cred-X').click();assert.equal(await results.locator('article').count(),3);assert.match(await tab('All Cred-X').textContent(),/3 · cached/);assert.match(await results.getByRole('alert').textContent(),/may be out of date/);await shot('desktop-stale');
  await refresh.click();await settle('mail',200);await settle('github',200);await results.getByText('No Cred-X mail attempts have been recorded yet.',{exact:true}).waitFor();assert.equal(await results.getByRole('alert').count(),0);await shot('desktop-verified-empty');
  await refresh.click();await settle('mail',503);await settle('github',503);await results.getByRole('alert').waitFor();await noEmpty();
  for(const name of ['Run notifications','Risk alerts & tests','Account & security','GitHub checks']){await tab(name).click();await noEmpty();assert.equal(await results.getByRole('alert').count(),1);}
  await page.setViewportSize({width:375,height:812});await tab('All Cred-X').click();await shot('narrow-unavailable');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  for(const button of await panel.getByRole('tab').all()){const box=await button.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=375);}
  await page.goto(origin+'/other');await page.goBack();await settle('mail',200);await settle('github',200);await results.getByText('No Cred-X mail attempts have been recorded yet.',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.mutations),[]);assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
  console.log('PASS loading, failure, partial sources, out-of-order responses, retained category/focus, filters/counts, loaded, stale, verified-empty, retries, keyboard, repeated details, narrow/back; no external requests or mutations. '+output);
}finally{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());await rm(temporary,{recursive:true,force:true});}

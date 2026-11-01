/** A6-15: actual mail page, independent synthetic source outcomes, zero writes. */
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
      if(String(url).includes('/preferences'))return Promise.resolve(new Response(JSON.stringify({items:[]}),{status:new URLSearchParams(location.search).get('pref')==='failed'?503:200}));
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
  server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'text/javascript; charset=utf-8':req.url==='/style.css'?'text/css; charset=utf-8':'text/html; charset=utf-8');res.end(req.url==='/bundle.js'?bundle:req.url==='/style.css'?css:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline history fixture</title><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/bundle.js"></script>');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true});
  const context=await browser.newContext({viewport:{width:1180,height:757},serviceWorkers:'block'});
  const external=[],errors=[];
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():(external.push(route.request().url()),route.abort()));
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const output=process.env.A6_15_EVIDENCE_DIR||'/tmp/audit6-a6-15-browser';await mkdir(output,{recursive:true});
  const records=[];
  const item=(id,market,odds,proceeds)=>({id,category:'alerts',status:'sent',trigger:'Synthetic only',subject:'Synthetic '+market,created_at:'2026-11-01T00:00:00Z',recipients:[],message:'Local fixture',remarks:'Fixture',warnings:[],sell_action:{status:'detected',evaluated_at:'2026-11-01T00:01:00Z',evaluated_market_id:market,market_question:'Synthetic '+market,position_side:'YES',live_held_side_bullpen_odds:odds,sell_threshold:80,shares:10,average_sell_price:50,expected_proceeds:proceeds}});
  for(const width of [1180,390])for(const pref of ['ready','failed'])for(const github of ['ready','failed']){
    await page.setViewportSize({width,height:844});await page.goto(origin+'/?pref='+pref);
    const batch=page.getByRole('region',{name:'Sell batch preparation',exact:true});
    const history=page.getByRole('region',{name:'Sent mail history',exact:true});
    const refresh=history.getByRole('button',{name:'Refresh',exact:true});
    const metrics=()=>batch.locator('p.text-2xl').allTextContents();
    const settle=(source,status,items=[])=>page.evaluate(args=>window.settle(...args),[source,status,items]);
    const unknown=async()=>{assert.deepEqual(await metrics(),['Unknown','Unknown','Unknown','Unknown']);assert.equal(await batch.locator('table').count(),0);assert.doesNotMatch(await batch.innerText(),/No evaluated Sell|No Sell alerts/);};
    const zero=async()=>{assert.deepEqual(await metrics(),['0','0','0','$0.00']);await batch.getByText('No evaluated Sell alerts are present in these mail-history records.',{exact:true}).waitFor();};
    const capture=async state=>{if(pref==='ready'&&github==='failed')await batch.screenshot({path:path.join(output,state+'-'+width+'.png')});};
    await page.waitForFunction(()=>window.reads.filter(r=>r.source==='mail').length===2&&window.reads.filter(r=>r.source==='github').length===2);
    await unknown();assert.equal(await batch.getAttribute('aria-busy'),'true');await capture('loading');
    await settle('github',github==='ready'?200:503);await unknown();
    if(pref==='failed')await page.getByText('Mail preferences could not be loaded.',{exact:true}).first().waitFor();
    await settle('mail',503);await batch.getByRole('alert').waitFor();await unknown();await capture('failed');
    await refresh.click();await unknown();await settle('mail',200);await settle('github',github==='ready'?200:503);await batch.getByText(/successfully loaded mail-history/).waitFor();await zero();await capture('empty');
    await refresh.click();await batch.getByText(/Showing cached mail-history/).waitFor();await zero();
    await settle('mail',503);await settle('github',github==='ready'?200:503);await batch.getByRole('alert').waitFor();await zero();await capture('cached-empty');
    await refresh.click();await settle('mail',200,[item(1,'included',70,12.5),item(2,'recovered',85,8),item(3,'unverified',undefined,4)]);await settle('github',github==='ready'?200:503);
    await batch.locator('tbody tr').first().waitFor();assert.deepEqual(await metrics(),['1','1','1','$12.50']);assert.equal(await batch.locator('tbody tr').count(),3);await capture('populated');
    await refresh.focus();await page.keyboard.press('Enter');await batch.getByText(/Showing cached mail-history/).waitFor();assert.deepEqual(await metrics(),['1','1','1','$12.50']);
    await settle('mail',503);await settle('github',github==='ready'?200:503);await batch.getByRole('alert').waitFor();assert.deepEqual(await metrics(),['1','1','1','$12.50']);assert.equal(await batch.locator('tbody tr').count(),3);assert.equal(await refresh.evaluate(e=>e===document.activeElement),true);await capture('cached-populated');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.deepEqual(await page.evaluate(()=>window.mutations),[]);records.push({width,pref,github,passed:true});
  }
  assert.deepEqual(external,[]);assert.deepEqual(errors,[]);await writeFile(path.join(output,'result.json'),JSON.stringify({timestamp:new Date().toISOString(),records,external,errors,mutations:0},null,2));
  console.log('PASS A6-15 actual full mail page: eight preference/GitHub/width combinations; loading, failed, verified empty/populated, cached refresh/failure, calculations, keyboard focus; zero writes/external requests. '+output);
}finally{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());await rm(temporary,{recursive:true,force:true});}

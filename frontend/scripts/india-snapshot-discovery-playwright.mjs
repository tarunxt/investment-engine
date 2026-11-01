#!/usr/bin/env node
// Render the real portfolio page offline. All API methods are fixtures; writes fail closed.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp, readFile, writeFile, rm, mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
const require=createRequire(import.meta.url);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const tmp=await mkdtemp(path.join(os.tmpdir(),'india-hierarchy-'));
const evidence=process.env.INDIA_EVIDENCE_DIR||'/tmp/india-snapshot-discovery-evidence';
let server,browser;
try {
  await mkdir(evidence,{recursive:true});
  await writeFile(path.join(tmp,'entry.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import Page from '${root}/app/console/zerodha/page';createRoot(document.getElementById('root')).render(<main style={{padding:24}}><Page/></main>);`);
  const mainRef=execFileSync('git',['rev-parse','origin/main'],{cwd:root,encoding:'utf8'}).trim();
  for(const name of ['page.tsx','_components/PortfolioSnapshotsPanel.tsx','_components/ZerodhaConnectionGuide.tsx','_components/IndiaPortfolioNav.module.css']){await mkdir(path.dirname(path.join(tmp,'baseline',name)),{recursive:true});await writeFile(path.join(tmp,'baseline',name),execFileSync('git',['show',mainRef+':frontend/app/console/zerodha/'+name],{cwd:root}));}
  await writeFile(path.join(tmp,'entry-before.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import Page from './baseline/page';createRoot(document.getElementById('root')).render(<main style={{padding:24}}><Page/></main>);`);
  await writeFile(path.join(tmp,'css.cjs'),`module.exports=function(){return 'export default {navigation: "india-navigation"}';}`);
  await writeFile(path.join(tmp,'link.tsx'),`import React from 'react';export default function Link(props){return <a {...props}/>}`);
  await writeFile(path.join(tmp,'api.ts'),`
export class APIError extends Error {}
const mode=new URLSearchParams(location.search).get('mode')||'saved';
window.apiCalls=[];
const snapshot={snapshot_date:'2026-10-30',captured_at:'2026-10-30T09:00:00Z',source:'offline_fixture',holdings_count:0,net_positions_count:0,day_positions_count:0,holdings_market_value:125000,holdings_pnl:2500,holdings_day_change_value:50,available_margin:1000,positions_pnl:0,positions_m2m:0,holdings:[],positions:{net:[],day:[]}};
const read=async(name,data)=>{window.apiCalls.push(name);if(mode==='connection-failed'&&name==='status')throw new APIError('Fixture connection status failed');if(mode==='loading'&&name==='portfolio')await new Promise(r=>setTimeout(r,1800));if((mode==='failed'||(mode==='partial'&&window.apiCalls.filter(x=>x==='portfolio').length>1))&&name==='portfolio')throw new APIError('Fixture saved-data request failed');return data};
export const apiService=new Proxy({
zerodhaStatus:()=>read('status',{connected:mode==='connected',expires_at:'2026-11-01T12:00:00Z'}),
zerodhaLoginUrl:()=>read('login-url',{configured:mode!=='unconfigured',login_url:'/fixture-kite-login'}),
zerodhaPortfolioOverview:()=>read('portfolio',{latest:mode==='empty'?null:snapshot,history:mode==='empty'?[]:[snapshot,{...snapshot,snapshot_date:'2026-10-29'}]}),
zerodhaPortfolioSnapshot:date=>mode==='partial'?Promise.reject(new APIError('Fixture historical snapshot unavailable')):read('snapshot',{...snapshot,snapshot_date:date}),
zerodhaOrders:()=>read('orders',{data:[]})
},{get:(target,key)=>key in target?target[key]:()=>{window.apiCalls.push('FORBIDDEN:'+String(key));throw Error('Unexpected API action '+String(key))}});`);
  await writeFile(path.join(tmp,'loader.cjs'),`const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(s){return ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020},fileName:this.resourcePath}).outputText}`);
  const w=require('next/dist/compiled/webpack/webpack');
  await new Promise((resolve,reject)=>w.webpack({mode:'development',devtool:false,entry:{after:path.join(tmp,'entry.tsx'),before:path.join(tmp,'entry-before.tsx')},output:{path:tmp,filename:'bundle-[name].js'},resolve:{extensions:['.tsx','.ts','.js'],modules:[path.join(root,'node_modules'),'node_modules'],alias:{'next/link$':path.join(tmp,'link.tsx'),'@/services/api$':path.join(tmp,'api.ts'),'@':root}},module:{rules:[{test:/\.tsx?$/,use:path.join(tmp,'loader.cjs')},{test:/\.module\.css$/,use:path.join(tmp,'css.cjs')}]},plugins:[new w.webpack.DefinePlugin({'process.env':JSON.stringify({NODE_ENV:'development'})})]},(error,stats)=>error?reject(error):stats.hasErrors()?reject(Error(stats.toString({all:false,errors:true}))):resolve()));
  const navCss=(await readFile(path.join(root,'app/console/zerodha/_components/IndiaPortfolioNav.module.css'),'utf8')).replaceAll(':global(.dark)','.dark').replaceAll('.navigation','.india-navigation');
  const css=(await postcss([tailwind({base:root})]).process(await readFile(path.join(root,'app/globals.css'),'utf8'),{from:path.join(root,'app/globals.css')})).css;
  const bundles={after:await readFile(path.join(tmp,'bundle-after.js')),before:await readFile(path.join(tmp,'bundle-before.js'))};
  server=createServer((req,res)=>{if(req.url.startsWith('/bundle-')){res.setHeader('Content-Type','text/javascript');res.end(bundles[req.url.includes('before')?'before':'after'])}else{res.setHeader('Content-Type','text/html');res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}${navCss}body{font-family:Arial,sans-serif}</style><div id="root"></div><script src="/bundle-${req.url.includes("version=before")?"before":"after"}.js"></script>`)}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1180,height:757}});const errors=[],external=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():(external.push(route.request().url()),route.abort()));
  const calls=[];
  const visit=async mode=>{if(await page.evaluate(()=>!!window.apiCalls))calls.push(...await page.evaluate(()=>window.apiCalls));await page.goto(origin+'/?mode='+mode);await page.getByRole('heading',{name:/^(?:Zerodha portfolio|India Portfolio · Zerodha)$/,exact:true}).waitFor()};
  const guidance=()=>page.locator('summary').filter({hasText:'Connection guidance'});
  const saved=()=>page.getByRole('region',{name:'Saved portfolio snapshots'});
  for(const width of [1180,390]) {
    await page.setViewportSize({width,height:width===1180?757:844});
    await page.goto(origin+'/?version=before');
    await page.getByRole('heading',{name:/^(?:Zerodha portfolio|India Portfolio · Zerodha)$/,exact:true}).waitFor();
    await page.screenshot({path:path.join(evidence,'baseline-'+width+'.png')});
    for(const mode of ['saved','loading','empty','failed','partial','connection-failed','unconfigured','connected']) {
      await visit(mode);
      const link=page.getByRole('link',{name:'View saved snapshot',exact:true});
      await link.waitFor();
      assert.ok((await link.boundingBox()).y<(width===1180?757:844));
      assert.match(await link.locator('..').textContent(),/without signing in to Zerodha.*Reconnect separately/);
      await page.screenshot({path:path.join(evidence,mode+'-'+width+'.png')});
      if(!['empty','failed'].includes(mode)) await page.waitForFunction(()=>window.apiCalls.filter(x=>x==='portfolio').length>=2);
      if(mode==='loading') await saved().getByRole('heading',{name:'Portfolio Snapshots'}).waitFor();
      const before=await page.evaluate(()=>window.apiCalls.slice());
      await link.focus();await page.keyboard.press('Enter');
      await page.waitForFunction(()=>location.hash==='#saved-portfolio-snapshots');
      assert.equal(await saved().evaluate(el=>el===document.activeElement),true);
      if(mode!=='connected' && await saved().getByRole('button',{name:'Sync Portfolio',exact:true}).count()) assert.equal(await saved().getByRole('button',{name:'Sync Portfolio',exact:true}).isEnabled(),false);
      assert.equal(await page.locator('details[open]').count(),0);
      await page.keyboard.press('Tab');
      assert.equal(await page.getByRole('link',{name:'Back to portfolio top'}).evaluate(el=>el===document.activeElement),true);
      await page.keyboard.press('Enter');
      await page.waitForFunction(()=>location.hash==='#portfolio-top');
      assert.equal(await page.locator('#portfolio-top').evaluate(el=>el===document.activeElement),true);
      assert.deepEqual(await page.evaluate(()=>window.apiCalls),before);
      await page.goBack();await page.waitForFunction(()=>location.hash==='#saved-portfolio-snapshots');
      if(mode==='loading') await saved().getByRole('heading',{name:'Portfolio Snapshots'}).waitFor();
      if(mode==='empty') await saved().getByText('No portfolio snapshots yet').waitFor();
      if(mode==='failed') {await saved().getByRole('alert').waitFor();assert.equal(await page.getByText('No portfolio snapshots yet').count(),0);}
      if(mode==='partial') await saved().getByText('Fixture saved-data request failed').waitFor();
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      assert.equal(await page.evaluate(()=>devicePixelRatio),1);
      await page.screenshot({path:path.join(evidence,mode+'-destination-'+width+'.png')});
    }
    await page.goto(origin+'/console/zerodha?mode=saved#saved-portfolio-snapshots');
    await saved().waitFor();
    await page.waitForFunction(()=>document.activeElement?.id==='saved-portfolio-snapshots');
    assert.match(await saved().textContent(),/Source: offline_fixture/);
    await saved().getByText("Settled Holdings Value (excludes T1)", {exact:true}).waitFor();
    await saved().getByText("Settled holdings value trend (excludes T1) across saved portfolio snapshots.", {exact:true}).waitFor();
    await page.getByRole('link',{name:'Back to portfolio top'}).click();
    await guidance().click();
    await page.getByRole('button',{name:'Connect With Zerodha',exact:true}).waitFor();
    assert.equal(await page.getByRole('link',{name:'Open full-page login'}).getAttribute('href'),'/fixture-kite-login');
    await guidance().click();calls.push(...await page.evaluate(()=>window.apiCalls));
  }
  assert.deepEqual(calls.filter(x=>x.startsWith('FORBIDDEN')),[]);assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
  const result={result:'PASS',mainRef,checks:['before/after real page offline fixtures at 1180 and 390px, 100% scale','prominent link before connection guidance','saved, loading, empty, failed, partial, unavailable connection, unconfigured and connected states','native fragment destination focus and Tab order','return to top, browser back, direct deep link after asynchronous mount','no API calls from anchor navigation','sync disabled while disconnected; both existing connection choices retained','snapshot provenance retained','zero external requests or forbidden actions'],apiCalls:calls,limits:['Local fixture rendering only; no production QA or provider actions.','Source PDF finding supplied by native reviewer; no claim of personally viewing source pixels.']};
  await writeFile(path.join(evidence,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));

} finally {await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(tmp,{recursive:true,force:true});}

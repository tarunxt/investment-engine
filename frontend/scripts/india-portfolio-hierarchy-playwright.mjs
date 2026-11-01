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
const evidence=process.env.INDIA_EVIDENCE_DIR||'/tmp/india-portfolio-evidence';
let server,browser;
try {
  await mkdir(evidence,{recursive:true});
  await writeFile(path.join(tmp,'entry.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import Page from '${root}/app/console/zerodha/page';createRoot(document.getElementById('root')).render(<main style={{padding:24}}><Page/></main>);`);
  const mainRef=execFileSync('git',['rev-parse','origin/main'],{cwd:root,encoding:'utf8'}).trim();
  for(const name of ['page.tsx','_components/PortfolioSnapshotsPanel.tsx','_components/ZerodhaConnectionGuide.tsx']){await mkdir(path.dirname(path.join(tmp,'baseline',name)),{recursive:true});await writeFile(path.join(tmp,'baseline',name),execFileSync('git',['show',mainRef+':frontend/app/console/zerodha/'+name],{cwd:root}));}
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
  server=createServer((req,res)=>{if(req.url.startsWith('/bundle-')){res.setHeader('Content-Type','text/javascript');res.end(bundles[req.url.includes('before')?'before':'after'])}else{res.setHeader('Content-Type','text/html');res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}${req.url.includes("version=before")?"":navCss}body{font-family:Arial,sans-serif}</style><div id="root"></div><script src="/bundle-${req.url.includes("version=before")?"before":"after"}.js"></script>`)}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1180,height:757}});const errors=[],external=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():(external.push(route.request().url()),route.abort()));
  const calls=[];
  const visit=async mode=>{if(await page.evaluate(()=>!!window.apiCalls))calls.push(...await page.evaluate(()=>window.apiCalls));await page.goto(origin+'/?mode='+mode);await page.getByRole('heading',{name:'Zerodha portfolio',exact:true}).waitFor()};
  const guidance=()=>page.locator('summary').filter({hasText:'Connection guidance'});
  const saved=()=>page.getByRole('region',{name:'Saved portfolio snapshots'});
  for(const width of [1180,390]){await page.setViewportSize({width,height:width===1180?757:844});await page.goto(origin+'/?version=before');await page.getByRole('heading',{name:'Zerodha',exact:true}).waitFor();await page.screenshot({path:path.join(evidence,'baseline-'+width+'.png')});}
  await page.setViewportSize({width:1180,height:757});
  await visit('saved');await saved().getByRole('heading',{name:'Portfolio Snapshots'}).waitFor();
  assert.equal(await page.locator('details').getAttribute('open'),null);
  assert.equal(await page.getByRole('button',{name:'Connect With Zerodha',exact:true}).isVisible(),false);
  assert.equal(await saved().getByRole('button',{name:'Sync Portfolio',exact:true}).isDisabled(),true);
  assert.ok((await saved().boundingBox()).y<757);
  assert.match(await page.locator('header').textContent(),/India.*Saved snapshot.*30 Oct 2026.*Not connected/);
  assert.equal(await page.getByRole('navigation',{name:'Portfolio stages and markets'}).getByRole('link').count(),18);
  assert.equal(await page.evaluate(()=>devicePixelRatio),1);
  assert.match(await saved().textContent(),/Source: offline_fixture.*Holdings: 0/);
  const links=await page.getByRole('navigation').getByRole('link').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('href')));
  for(const market of ['zerodha','indmoney-us'])for(const stage of ['','/swing-trade','/threats','/events','/rebalance','/final-actionables'])assert.ok(links.includes('/console/'+market+stage));
  assert.equal(await page.getByRole('link',{name:'Portfolio',exact:true}).evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(124, 58, 237)');
  await page.screenshot({path:path.join(evidence,'desktop-saved.png')});
  await page.evaluate(()=>document.documentElement.classList.add('dark'));await page.waitForFunction(()=>getComputedStyle([...document.querySelectorAll('nav a')].find(e=>e.textContent==='Swing Trade')).backgroundColor==='rgb(46, 16, 101)');await page.screenshot({path:path.join(evidence,'desktop-dark.png')});await page.evaluate(()=>document.documentElement.classList.remove('dark'));
  await guidance().click();await page.getByText('Kite Connect integration — save daywise portfolio history and manage orders').waitFor();
  await page.getByPlaceholder('Paste request_token here').waitFor();assert.equal(await page.getByRole('link',{name:'Open full-page login'}).getAttribute('href'),'/fixture-kite-login');
  await page.screenshot({path:path.join(evidence,'desktop-connection.png')});await guidance().click();
  await saved().getByText('Snapshot Detail',{exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(evidence,'desktop-context.png')});await page.evaluate(()=>scrollTo(0,0));
  assert.match(await saved().getByRole('button',{name:'Sync Portfolio',exact:true}).getAttribute('title'),/Stale/);
  await page.locator('svg g.cursor-pointer circle').first().click();await page.waitForFunction(()=>document.querySelector('header').textContent.includes('29 Oct 2026'));
  await visit('partial');await saved().getByText('Fixture saved-data request failed').waitFor();assert.match(await page.locator('header').textContent(),/30 Oct 2026/);
  await visit('saved');
  for(let n=0;n<3;n++){await guidance().focus();await page.keyboard.press('Enter');assert.equal(await page.getByRole('button',{name:'Connect With Zerodha',exact:true}).isVisible(),true);assert.equal(await page.getByText('Option 2: Manual Token').isVisible(),true);await page.keyboard.press('Enter');assert.equal(await page.locator('details').getAttribute('open'),null)}
  await page.getByRole('button',{name:'Show Zerodha login status',exact:true}).click();await page.getByText(/Saved snapshots remain available/).waitFor();
  await page.getByRole('button',{name:'Show Zerodha login status',exact:true}).click();
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(evidence,'narrow-saved.png')});
  await guidance().click();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(evidence,'narrow-connection.png')});await guidance().click();
  await visit('connection-failed');await saved().getByRole('heading',{name:'Portfolio Snapshots'}).waitFor();assert.match(await page.locator('header').textContent(),/Connection status unavailable/);
  await visit('empty');await saved().getByText('No portfolio snapshots yet').waitFor();
  await visit('failed');await saved().getByRole('alert').waitFor();assert.equal(await page.getByText('No portfolio snapshots yet').count(),0);assert.match(await page.locator('header').textContent(),/Saved snapshot status unavailable/);
  await visit('loading');await saved().getByText('Loading portfolio history…').waitFor();await saved().getByRole('heading',{name:'Portfolio Snapshots'}).waitFor();
  await visit('unconfigured');assert.equal(await page.getByText('Finish one-time Zerodha setup').isVisible(),false);await guidance().click();await page.getByText('Finish one-time Zerodha setup').waitFor();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await visit('connected');await saved().getByRole('button',{name:'Sync Portfolio',exact:true}).waitFor();assert.equal(await saved().getByRole('button',{name:'Sync Portfolio',exact:true}).isEnabled(),true);assert.equal(await page.locator('details').count(),0);assert.equal(await page.getByRole('button',{name:'Disconnect Zerodha',exact:true}).isVisible(),true);
  await page.goBack();await page.getByRole('heading',{name:'Zerodha portfolio',exact:true}).waitFor();
  calls.push(...await page.evaluate(()=>window.apiCalls));assert.deepEqual(calls.filter(x=>x.startsWith('FORBIDDEN')),[]);assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
  const result={result:'PASS',mainRef,sourceReview:'Actual source pixels reviewed by /root/verify_remaining_visual_requirements; this executor used the supplied preservation map.',apiCalls:calls,checks:['baseline and changed render comparison','purple selected and lavender stage links','dark navigation palette','all 12 market-stage destinations','source and holdings count','both connection methods and full-page login','connection failure retains saved snapshot','100% device scale','saved snapshot while disconnected','dated stale sync disclosure','historical selection updates metadata','partial overview failure retains loaded snapshot','snapshot date and connection metadata','18 existing stage and market links','collapsed setup','keyboard repeated open-close','connection details','desktop 1180x757','390px no page overflow','empty','failed does not claim absent data','loading to loaded','unconfigured setup collapsed','connected controls and explicit sync enablement','back navigation','zero external requests'],limits:['Synthetic empty holdings exercise existing empty tables; no real account data used.','No production authentication, connection, sync, order, or provider actions.']};
  await writeFile(path.join(evidence,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
} finally {await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(tmp,{recursive:true,force:true});}

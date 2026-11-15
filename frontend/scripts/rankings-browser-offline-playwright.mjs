/** Render the real Rankings page with local fixtures; never contact providers or production. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const require = createRequire(import.meta.url);
const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'rankings-fixture-'));
const artifacts = process.env.RANKINGS_ARTIFACT_DIR || '/tmp/rankings-browser-evidence';
let browser, server;
try {
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(temporary, 'entry.tsx'), `import React from 'react';import {createRoot} from 'react-dom/client';import Page from ${JSON.stringify(path.join(frontend,'app/console/sports-rankings/page.tsx'))};createRoot(document.getElementById('root')).render(<Page/>);`);
  await writeFile(path.join(temporary,'loader.cjs'), `const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(s){return ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020},fileName:this.resourcePath}).outputText;};`);
  const w = require('next/dist/compiled/webpack/webpack');
  await new Promise((resolve,reject)=>w.webpack({mode:'development',devtool:false,entry:path.join(temporary,'entry.tsx'),output:{path:temporary,filename:'bundle.js'},resolve:{extensions:['.tsx','.ts','.js'],alias:{'@':frontend},modules:[path.join(frontend,'node_modules'),'node_modules']},module:{rules:[{test:/\.tsx?$/,use:path.join(temporary,'loader.cjs')}]},plugins:[new w.webpack.DefinePlugin({'process.env.NODE_ENV':JSON.stringify('development')})]},(e,s)=>e?reject(e):s.hasErrors()?reject(new Error(s.toString({all:false,errors:true}))):resolve()));
  const css = await require('postcss')([require('@tailwindcss/postcss')({base:frontend})]).process(await readFile(path.join(frontend,'app/globals.css'),'utf8'),{from:path.join(frontend,'app/globals.css')});
  const bundle = await readFile(path.join(temporary,'bundle.js'));
  server=createServer((req,res)=>{if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');return res.end(bundle)}res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css.css}</style><div id="root"></div><script src="/bundle.js"></script>`)});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/usr/bin/chromium'});
  const context=await browser.newContext({viewport:{width:1180,height:757},deviceScaleFactor:1});
  let mode='failed', reads=0;
  const forbidden=[],errors=[];
  const fixture={id:'epl',code:'epl',code_verified:true,name:'Fixture Premier League',sport:'Football',sport_id:'football',category:'Football',scope:'England',entry_kind:'imported_competition',reference_url:'https://example.test/reference',source_id:'fixture-feed',status:'ready',ranking_kind:'Standings',source_url:'https://example.test/dataset',source_as_of:'2026-10-30',checked_at:'2026-11-01T02:00:00Z',successful_at:'2026-11-01T01:00:00Z',season:'2026/27',ranked_count:1,note:'Local fixture — published league table',error:null,participants:[{name:'Fixture United',aliases:['United']}],events:[{title:'Fixture United vs Fixture City',slug:'fixture-match'}],rows:[{name:'Fixture United',rank:1,points:42,rating:7,group:'League',record:'12 played',imported_names:['United']}]};
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==origin||request.method()!=='GET'){forbidden.push(request.method()+' '+url);return route.abort()}
    if(!url.pathname.startsWith('/backend-api/'))return route.continue();
    reads++;
    if(mode==='loading'){await new Promise(r=>setTimeout(r,2000));return route.fulfill({contentType:'application/json',body:JSON.stringify({competitions:[]})})}
    if(mode==='failed'||(mode==='partial'&&reads>2))return route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({detail:'Local fixture repository unavailable'})});
    const data={...fixture,...(mode==='stale'?{status:'stale',error:'Local fixture refresh failed'}:{})};
    return route.fulfill({contentType:'application/json',body:JSON.stringify(url.searchParams.has('view')?{competitions:mode==='empty'?[]:[data]}:data)});
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const tab=name=>page.getByRole('tab',{name,exact:true});
  const screenshot=name=>page.screenshot({path:path.join(artifacts,name+'.png'),fullPage:true});
  async function open(state){mode=state;reads=0;await page.goto(origin);if(state==='loading')await page.getByRole('tabpanel').getByText('Loading repository…',{exact:true}).waitFor();else if(state==='failed')await page.getByRole('alert').waitFor();else if(state==='empty')await page.getByText('No ranking lists match your filters.').waitFor();else await page.getByRole('heading',{name:fixture.name}).waitFor();}
  await open('failed');assert.equal(await page.getByRole('alert').count(),1);assert.match(await page.getByRole('alert').innerText(),/unknown, not a verified empty/);assert.deepEqual(await page.locator('header strong').allTextContents(),['—','—','—','—','—']);await screenshot('failed-desktop');
  const passiveReads=reads;
  await tab('Unavailable repository').focus();await page.keyboard.press('ArrowRight');await tab('Filters and rules').evaluate(e=>{if(e!==document.activeElement)throw Error('Tab focus missing')});
  await page.getByLabel('Find competition or participant').fill('hockey');await page.getByLabel('Filter by ranking availability').selectOption('Reference only');
  const summary=page.locator('summary');await summary.focus();await page.keyboard.press('Enter');assert.equal(await page.locator('details').getAttribute('open'),'');await screenshot('filters-desktop');
  await page.getByRole('button',{name:'Return to Unavailable repository'}).click();assert.equal(await tab('Unavailable repository').getAttribute('aria-selected'),'true');
  await page.keyboard.press('End');assert.equal(await page.getByLabel('Find competition or participant').inputValue(),'hockey');assert.equal(await page.getByLabel('Filter by ranking availability').inputValue(),'Reference only');assert.equal(reads,passiveReads);
  await page.setViewportSize({width:390,height:844});await screenshot('filters-narrow');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.setViewportSize({width:1180,height:757});
  for(const state of ['loading','empty','loaded','stale','partial']){
    if(state==='partial')await page.clock.install();
    await open(state);
    if(state==='partial'){await page.clock.fastForward(61000);await page.getByRole('alert').waitFor();assert.match(await page.getByRole('alert').innerText(),/Last loaded data remains visible/);assert.equal(await page.getByRole('heading',{name:fixture.name}).count(),1);}
    if(state==='stale')await page.getByText('This feed has not been checked within an hour. Displayed data may be stale.').waitFor();
    await screenshot(state+'-desktop');
    if(state==='loaded'){
      await page.getByLabel('Search teams or players').fill('United');await tab('Filters and rules').click();await page.getByLabel('Filter by sport').selectOption('Football');await tab('Repository').click();assert.equal(await page.getByLabel('Search teams or players').inputValue(),'');
      await page.setViewportSize({width:390,height:844});await screenshot('loaded-narrow');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.setViewportSize({width:1180,height:757});
    }
  }
  assert.deepEqual(forbidden,[]);assert.deepEqual(errors,[]);
  const result={result:'PASS',checks:['failed unknown counters and count','single recovery banner','semantic tab keyboard and focus','filter values survive view changes','native disclosure keyboard','return focus','tab changes do not read data','loading','empty success','loaded detail and source fields','stale disclosure','partial polling retains loaded data','desktop 1180x757 at device scale 1','narrow 390px no page overflow'],forbiddenRequests:forbidden,pageErrors:errors,scope:'Actual page and production CSS rendered in an isolated fixture host; app shell and production data excluded. Recovery and provider action controls were not clicked.'};
  await writeFile(path.join(artifacts,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await browser?.close();if(server)await new Promise(r=>server.close(r));await rm(temporary,{recursive:true,force:true});}

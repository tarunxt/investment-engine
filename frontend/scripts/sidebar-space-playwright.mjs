#!/usr/bin/env node
// Production sidebar and shell, synthetic identity, no backend or provider traffic.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
const require=createRequire(import.meta.url), frontend=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temporary=await mkdtemp(path.join(os.tmpdir(),'sidebar-space-'));
const output=process.env.SIDEBAR_SCREENSHOT_DIR || '/tmp/credx-sidebar-screenshots';
let browser,server;
try {
  await mkdir(output,{recursive:true});
  await writeFile(path.join(temporary,'entry.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import {ConsoleShell} from '${frontend}/app/console/_components/ConsoleShell';import {SIDEBAR_SECTIONS,ACCOUNT_NAVIGATION} from '${frontend}/app/console/_components/sidebarNavigationConfig';window.sections=SIDEBAR_SECTIONS;window.account=ACCOUNT_NAVIGATION;createRoot(document.getElementById('root')).render(<ConsoleShell><h1>Navigation layout verification</h1><p>Synthetic offline fixture</p></ConsoleShell>);`);
  await writeFile(path.join(temporary,'navigation.tsx'),`import {useSyncExternalStore} from 'react';export function useRouter(){return {replace:()=>{}}}export function usePathname(){return useSyncExternalStore(cb=>{window.addEventListener('popstate',cb);return()=>window.removeEventListener('popstate',cb)},()=>location.pathname)}export function useSearchParams(){return new URLSearchParams(location.search)}`);
  await writeFile(path.join(temporary,'link.tsx'),`import React from 'react';export default function Link({href,prefetch,children,onClick,...props}){return <a {...props} href={href} onClick={e=>{e.preventDefault();history.pushState({},'',href);window.dispatchEvent(new Event('popstate'));onClick?.(e)}}>{children}</a>}`);
  await writeFile(path.join(temporary,'auth.ts'),`export function useAuth(){return {user:{id:42,username:'fixture',full_name:'Demo User',email:'demo@example.test'},logout:async()=>{window.logoutCalls++},loading:false,error:null}}`);
  await writeFile(path.join(temporary,'api.ts'),`export const apiService={updateProfile:async()=>{window.profileWrites++;throw Error('Unexpected profile write')}}`);
  await writeFile(path.join(temporary,'loader.cjs'),`const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(s){return ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020},fileName:this.resourcePath}).outputText}`);
  const w=require('next/dist/compiled/webpack/webpack');
  await new Promise((resolve,reject)=>w.webpack({mode:'development',devtool:false,entry:path.join(temporary,'entry.tsx'),output:{path:temporary,filename:'bundle.js'},resolve:{extensions:['.tsx','.ts','.js'],modules:[path.join(frontend,'node_modules'),'node_modules'],alias:{'next/navigation$':path.join(temporary,'navigation.tsx'),'next/link$':path.join(temporary,'link.tsx'),'@/hooks/useAuth$':path.join(temporary,'auth.ts'),'@/services/api$':path.join(temporary,'api.ts'),'@':frontend}},module:{rules:[{test:/\.tsx?$/,use:path.join(temporary,'loader.cjs')}]},plugins:[new w.webpack.DefinePlugin({'process.env':JSON.stringify({NODE_ENV:'development'})})]},(error,stats)=>error?reject(error):stats.hasErrors()?reject(Error(stats.toString({all:false,errors:true}))):resolve()));
  const css=(await postcss([tailwind({base:frontend})]).process(await readFile(path.join(frontend,'app/globals.css'),'utf8'),{from:path.join(frontend,'app/globals.css')})).css;
  const bundle=await readFile(path.join(temporary,'bundle.js'));
  server=createServer((req,res)=>{if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle)}else if(/^\/[a-zA-Z0-9_.-]+\.js$/.test(req.url)){res.setHeader('Content-Type','text/javascript');readFile(path.join(temporary,req.url.slice(1))).then(data=>res.end(data)).catch(()=>{res.statusCode=404;res.end()})}else {res.setHeader('Content-Type','text/html');res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}body{font-family:Arial,sans-serif}</style><div id="root"></div><script>window.logoutCalls=0;window.profileWrites=0</script><script src="/bundle.js"></script>`)}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const page=await browser.newPage(); const errors=[],external=[],scriptRequests=[];
  page.on('request',request=>{if(request.resourceType()==='script')scriptRequests.push(request.url())});
  page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)});
  await page.route('**/*',route=>route.request().url().startsWith(base)?route.continue():(external.push(route.request().url()),route.abort()));
  await page.addInitScript(()=>{localStorage.setItem('investment-engine:theme-preference','system');localStorage.setItem('unrelated-user-preference','preserve-me')});
  const measurements=[];
  for(const [width,height,zoom] of [[1180,757,1],[1165,747,1],[1165,747,.67],[390,747,1],[390,747,.67]]) {
    await page.setViewportSize({width:Math.round(width/zoom),height:Math.round(height/zoom)});
    scriptRequests.length=0;
    await page.goto(base+'/console/dashboard');
    const nav=page.getByRole('navigation',{name:'Console navigation',includeHidden:true});
    await nav.waitFor({state:'attached'});
    // Emulate browser zoom through its equivalent CSS viewport dimensions.
    const open=page.getByRole('button',{name:'Open navigation'});
    if(await open.isVisible())await open.click();
    await nav.waitFor();
    assert.equal(await nav.locator('a[href="/console/google-sheets"]').count(),0);
    const storageBefore=await page.evaluate(()=>({...localStorage}));
    const box=await nav.boundingBox();
    assert.ok(box.height>height/zoom*.60,`navigation should occupy most height: ${box.height}`);
    measurements.push({width,height,zoom,navigationHeight:box.height,viewportHeight:height/zoom});
    await page.screenshot({animations:'disabled',path:path.join(output,`sidebar-home-${width}-${Math.round(zoom*100)}.png`)});
    const roots=await page.evaluate(()=>window.sections.flatMap(s=>s.entries.map(e=>({name:e.name,href:e.href,group:e.type==='group',children:e.children?.map(c=>({name:c.name,href:c.href}))}))));
    const groups=await page.evaluate(()=>window.sections.map(s=>s.label));
    for(const label of groups)assert.equal(await nav.getByRole('heading',{name:label,exact:true}).count(),1);
    for(const entry of roots){
      const target=entry.group?nav.getByRole('button',{name:entry.name,exact:true}):nav.getByRole('link',{name:entry.name,exact:true});
      await target.scrollIntoViewIfNeeded();await target.focus();
      assert.ok(await target.evaluate(el=>document.activeElement===el));
      const r=await target.boundingBox(),n=await nav.boundingBox();assert.ok(r.y>=n.y-1&&r.y+r.height<=n.y+n.height+1,entry.name);
      if(entry.group){
        await page.keyboard.press('Enter');assert.equal(await target.getAttribute('aria-expanded'),'true');
        for(const child of entry.children){
          const link=nav.locator(`a[href="${child.href}"]`);
          assert.equal(await link.count(),1,`${child.name} remains reachable`);
          await link.focus();assert.ok(await link.evaluate(el=>document.activeElement===el));
        }
        await target.focus();await page.keyboard.press(' ');assert.equal(await target.getAttribute('aria-expanded'),'false');
      }
    }

    const directoryButton=page.getByRole('button',{name:'All destinations',exact:true});
    const portfolios=nav.getByRole('button',{name:'Portfolios',exact:true});
    await portfolios.click();
    assert.ok(scriptRequests.every(url=>url.endsWith('/bundle.js')),'directory chunk must stay off initial route');
    await directoryButton.click();
    const directory=page.getByRole('dialog',{name:'All destinations'});
    await directory.waitFor();
    assert.ok(scriptRequests.some(url=>!url.endsWith('/bundle.js')),'directory loads on demand');
    const expected=await page.evaluate(()=>[...window.sections.flatMap(s=>s.entries.flatMap(e=>e.type==='group'?e.children:[e])),...window.account].map(e=>e.href));
    assert.equal(await directory.locator('tbody tr').count(),expected.length);
    for(const href of expected)assert.equal(await directory.locator(`a[href="${href}"]`).count(),1);
    assert.equal(await directory.locator('a[href="/console/google-sheets"]').count(),0);
    assert.ok(await directory.evaluate(el=>el.scrollWidth<=el.clientWidth),'directory must not clip horizontally');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({animations:'disabled',path:path.join(output,`sidebar-directory-${width}-${Math.round(zoom*100)}.png`)});
    const firstDirectoryControl=directory.getByRole('button',{name:'Primary navigation',exact:true});
    await firstDirectoryControl.focus();await page.keyboard.press('Shift+Tab');
    assert.ok(await directory.locator('a').last().evaluate(el=>el===document.activeElement),'native modal contains keyboard focus');
    await directory.locator('a').last().scrollIntoViewIfNeeded();
    await page.screenshot({animations:'disabled',path:path.join(output,`sidebar-directory-end-${width}-${Math.round(zoom*100)}.png`)});
    await page.keyboard.press('Escape');await directory.waitFor({state:'hidden'});
    assert.ok(await directoryButton.evaluate(el=>el===document.activeElement),'Escape restores trigger focus');
    assert.equal(await portfolios.getAttribute('aria-expanded'),'true','directory preserves group state');
    await directoryButton.click();await directory.getByRole('button',{name:'Primary navigation',exact:true}).click();
    await directory.waitFor({state:'hidden'});
    await directoryButton.click();await directory.getByRole('button',{name:'Return to primary navigation',exact:true}).click();
    await directory.waitFor({state:'hidden'});
    await directoryButton.click();
    await directory.locator('a[href="/console/automated-rebalance"]').focus();await page.keyboard.press('Enter');
    await directory.waitFor({state:'hidden'});
    if(await open.isVisible())await open.click();
    assert.equal(await nav.locator('[aria-current="page"]').getAttribute('href'),'/console/automated-rebalance');
    await page.screenshot({animations:'disabled',path:path.join(output,`sidebar-rebalance-${width}-${Math.round(zoom*100)}.png`)});
    await page.goBack();
    await page.goForward();
    assert.equal(await nav.locator('[aria-current="page"]').getAttribute('href'),'/console/automated-rebalance');
    // Navigate to a destination low in the list; route transition reveals and highlights it.
    await page.evaluate(()=>{history.pushState({},'','/console/apis');window.dispatchEvent(new Event('popstate'))});
    const active=nav.locator('[aria-current="page"]');await active.waitFor();
    await page.waitForFunction(()=>{const nav=document.querySelector('nav'),a=nav.querySelector('[aria-current="page"]');const n=nav.getBoundingClientRect(),r=a.getBoundingClientRect();return r.top>=n.top&&r.bottom<=n.bottom});
    assert.equal(await active.getAttribute('href'),'/console/apis');
    const activeParent=nav.getByRole('button',{name:'Integrations',exact:true});
    assert.equal(await activeParent.getAttribute('aria-expanded'),'true');
    assert.equal(await activeParent.evaluate(el=>el.classList.contains('bg-sidebar-accent')),false,'expanded parent must leave filled selection on destination');
    assert.equal(await active.evaluate(el=>el.classList.contains('bg-sidebar-accent')),true);
    const rootRow=nav.locator('a[href="/console/dashboard"]');
    const heights=await Promise.all([rootRow,activeParent,active].map(el=>el.evaluate(node=>node.getBoundingClientRect().height)));
    assert.ok(heights.every(h=>Math.abs(h-heights[0])<1),'root, group and child use the same row height');
    await activeParent.focus();await page.keyboard.press('Enter');
    assert.equal(await activeParent.getAttribute('aria-expanded'),'false');
    assert.equal(await activeParent.evaluate(el=>el.classList.contains('bg-sidebar-accent')),true,'collapsed active group retains route cue');
    await page.keyboard.press('Enter');
    await page.screenshot({animations:'disabled',path:path.join(output,`sidebar-active-${width}-${Math.round(zoom*100)}.png`)});

    await rootRow.click();
    if(await open.isVisible())await open.click();
    await page.goBack();
    assert.equal(await nav.locator('[aria-current="page"]').getAttribute('href'),'/console/apis','Back restores destination and group');
    const summary=page.locator('summary').filter({hasText:'Account'});
    await summary.focus();await page.keyboard.press('Enter');
    const panel=page.getByRole('region',{name:'Account and appearance'});await panel.waitFor();
    const before=await nav.boundingBox();assert.equal(before.height,box.height,'expanded account must not shrink navigation');
    for(const item of await page.evaluate(()=>window.account))assert.equal(await panel.locator(`a[href="${item.href}"]`).count(),1);
    const appearance=panel.locator('summary');await appearance.focus();await page.keyboard.press(' ');
    assert.ok(await panel.getByRole('button',{name:'Light',exact:true}).isVisible());
    assert.ok(await panel.getByRole('button',{name:'Dark',exact:true}).isVisible());
    await panel.getByRole('button',{name:'Dark',exact:true}).focus();
    const panelRect=await panel.boundingBox();assert.ok(panelRect.y>=0&&panelRect.y+panelRect.height<=height/zoom);
    await page.keyboard.press('Escape');assert.equal(await panel.isVisible(),false);assert.ok(await summary.evaluate(el=>el===document.activeElement));
    assert.deepEqual(await page.evaluate(()=>({...localStorage})),storageBefore,'layout interactions must preserve preferences');
    assert.equal(await page.evaluate(()=>window.profileWrites+window.logoutCalls),0);
    await page.screenshot({animations:'disabled',path:path.join(output,`sidebar-${width}-${Math.round(zoom*100)}.png`)});
    await summary.click();await panel.waitFor();await page.screenshot({animations:'disabled',path:path.join(output,`sidebar-account-${width}-${Math.round(zoom*100)}.png`)});
    await page.getByRole('heading',{name:'Navigation layout verification'}).click({force:true});assert.equal(await panel.isVisible(),false);
    await summary.focus();await page.keyboard.press('Enter');await panel.waitFor();
    const preferences=panel.locator('a[href="/console/profile/preferences"]');
    await preferences.focus();await page.keyboard.press('Enter');
    assert.equal(await panel.isVisible(),false);
    if(await open.isVisible())await open.click();
    assert.equal(await page.locator('summary[aria-label="Account and appearance, current section"]').count(),1);
    await summary.click();await panel.waitFor();
    assert.equal(await preferences.getAttribute('aria-current'),'page');
    await page.keyboard.press('Escape');
    // Tab follows ordinary browser order and scrolls lower entries into view.
    await nav.getByRole('link').first().focus();
    let reachedAccount=false;
    for(let i=0;i<60;i++){
      await page.keyboard.press('Tab');
      if(await summary.evaluate(el=>el===document.activeElement)){reachedAccount=true;break}
      assert.ok(await nav.evaluate(el=>el.contains(document.activeElement)),'Tab should traverse navigation before account');
    }
    assert.ok(reachedAccount,'Tab must reach account controls');
  }
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log(JSON.stringify({result:'PASS',measurements,screenshots:output,checks:'all root/child/directory destinations, two-column directory and return controls, modal focus containment/Escape restoration, group-state preservation, back/forward, matched row heights, single active fill, named groups, scroll, active route on transition, keyboard expand/collapse, focus and Escape restoration, compact account, bounded expanded panel, unchanged preferences, zero profile/logout/external requests'},null,2));
}finally{if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(temporary,{recursive:true,force:true})}

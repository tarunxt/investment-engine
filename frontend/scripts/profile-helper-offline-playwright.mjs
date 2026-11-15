#!/usr/bin/env node
// Actual ProfilePage and production CSS, with auth/API replaced by synthetic fixtures.
// No external requests are allowed. Before uses the verified audited main component.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
const require=createRequire(import.meta.url), frontend=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temporary=await mkdtemp(path.join(os.tmpdir(),'profile-helper-'));
const output=process.env.PROFILE_HELPER_EVIDENCE_DIR || '/tmp/a8-004-profile-evidence';
let browser,server;
try {
  await mkdir(output,{recursive:true});
  const profilePath=path.join(frontend,'app/console/profile/page.tsx');
  await writeFile(path.join(temporary,'before.tsx'),execFileSync('git',['show','da317a1097cef97089e3a745b9e20b4952af6a48:frontend/app/console/profile/page.tsx'],{cwd:frontend,encoding:'utf8'}));
  await writeFile(path.join(temporary,'entry.tsx'), `import React from 'react';import {createRoot} from 'react-dom/client';import Before from './before';import After from '${profilePath}'; const Page=location.search.includes('before')?Before:After;createRoot(document.getElementById('root')).render(<main className="mx-auto max-w-2xl p-6"><p>SYNTHETIC OFFLINE PROFILE FIXTURE</p><Page/></main>);`);
  await writeFile(path.join(temporary,'auth.ts'),`const auth={user:{username:'fixture',email:'fixture@example.test',full_name:'Fixture User'},refreshAuth:async()=>{}};export function useAuth(){return auth}`);
  await writeFile(path.join(temporary,'api.ts'),`export const apiService={getProfile:async()=>({bio:'Synthetic profile',avatar_url:''}),updateProfile:async()=>{window.fixtureWrites++; await new Promise(r=>window.finishSave=r);if(window.failSave)throw Error('Synthetic update failure')}}`);
  await writeFile(path.join(temporary,'loader.cjs'),`const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(s){return ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020},fileName:this.resourcePath}).outputText}`);
  await writeFile(path.join(temporary,'css-loader.cjs'),`module.exports=function(s){return 'module.exports='+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z_][\\w-]*)/g)].map(m=>[m[1],m[1]])))};`);
  const w=require('next/dist/compiled/webpack/webpack');
  await new Promise((resolve,reject)=>w.webpack({mode:'development',devtool:false,entry:path.join(temporary,'entry.tsx'),output:{path:temporary,filename:'bundle.js'},resolve:{extensions:['.tsx','.ts','.js'],modules:[path.join(frontend,'node_modules'),'node_modules'],alias:{'@/hooks/useAuth$':path.join(temporary,'auth.ts'),'@/services/api$':path.join(temporary,'api.ts'),'@':frontend}},module:{rules:[{test:/\.tsx?$/,use:path.join(temporary,'loader.cjs')},{test:/\.css$/,use:path.join(temporary,'css-loader.cjs')}]},plugins:[new w.webpack.DefinePlugin({'process.env':JSON.stringify({NODE_ENV:'development'})})]},(error,stats)=>error?reject(error):stats.hasErrors()?reject(Error(stats.toString({all:false,errors:true}))):resolve()));
  const source=await readFile(path.join(frontend,'app/globals.css'),'utf8');
  const css=(await postcss([tailwind({base:frontend})]).process(source+'\n@source inline("text-[0.8rem]");',{from:path.join(frontend,'app/globals.css')})).css;
  const bundle=await readFile(path.join(temporary,'bundle.js'));
  server=createServer((req,res)=>{if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle)}else {res.setHeader('Content-Type','text/html');res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}body{font-family:Arial,sans-serif}</style><div id="root"></div><script>window.fixtureWrites=0</script><script src="/bundle.js"></script>`)}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const page=await browser.newPage(); const errors=[],external=[];
  page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)});
  await page.route('**/*',route=>route.request().url().startsWith(base)?route.continue():(external.push(route.request().url()),route.abort()));
  const measurements=[];const helperPixels=new Map();
  for(const theme of ['light','dark'])for(const scenario of [{name:'desktop',width:1180,height:757,zoom:1},{name:'mobile',width:390,height:844,zoom:1},{name:'zoom200',width:590,height:378,zoom:2}]){
    await page.setViewportSize({width:scenario.width,height:scenario.height});
    for(const mode of ['before','after']){
      await page.goto(base+'/?'+mode);
      await page.evaluate(theme=>document.documentElement.classList.toggle('dark',theme==='dark'),theme);
      const helper=page.getByText('This is your public display name. It cannot be changed.',{exact:true});
      await helper.waitFor();
      const username=page.getByLabel('Username',{exact:true});assert.ok(await username.isDisabled());assert.equal(await username.inputValue(),'fixture');
      assert.ok(await page.getByLabel('Email',{exact:true}).isDisabled());
      const metrics=await helper.evaluate(el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect(),root=getComputedStyle(document.documentElement);return {font:parseFloat(s.fontSize),root:root.fontSize,cssZoom:root.zoom,visualScale:visualViewport.scale,dpr:devicePixelRatio,width:r.width,height:r.height,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,overflow:s.overflow,whiteSpace:s.whiteSpace,color:s.color,background:getComputedStyle(document.body).backgroundColor,pageWidth:document.documentElement.scrollWidth,viewport:innerWidth}});
      assert.equal(metrics.cssZoom,'1');assert.equal(metrics.visualScale,1);assert.equal(metrics.dpr,1);
      assert.ok(metrics.pageWidth<=scenario.width);assert.ok(metrics.scrollHeight<=metrics.clientHeight+1);assert.notEqual(metrics.whiteSpace,'nowrap');
      if(mode==='after')assert.ok(metrics.font>=11,'helper meets density floor');
      if(mode==='before'&&scenario.name==='desktop')assert.ok(metrics.font<11,'baseline reproduces reported failure');
      const pixels=await helper.screenshot({path:path.join(output,`${mode}-${theme}-${scenario.name}-helper.png`)});
      const key=theme+'-'+scenario.name;if(mode==='before')helperPixels.set(key,pixels);else assert.notDeepEqual(pixels,helperPixels.get(key),'helper screenshot changes from audited baseline');
      await page.screenshot({path:path.join(output,`${mode}-${theme}-${scenario.name}-default.png`),fullPage:true});
      // Disabled input remains disabled on hover and is skipped by keyboard navigation.
      await username.hover({force:true});assert.ok(await username.isDisabled());
      await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'full_name');
      await page.screenshot({path:path.join(output,`${mode}-${theme}-${scenario.name}-focus.png`),fullPage:true});
      await page.getByRole('button',{name:'Update profile'}).hover();
      await page.screenshot({path:path.join(output,`${mode}-${theme}-${scenario.name}-hover.png`),fullPage:true});
      // Only the explicitly substituted in-memory update function runs here.
      await page.getByRole('button',{name:'Update profile'}).click();
      assert.ok(await page.getByRole('button',{name:'Saving...'}).isDisabled());
      assert.equal(await helper.innerText(),'This is your public display name. It cannot be changed.');
      await page.screenshot({path:path.join(output,`${mode}-${theme}-${scenario.name}-loading.png`),fullPage:true});
      await page.evaluate(()=>window.finishSave());await page.getByText('Your profile has been successfully updated.').waitFor();
      await page.evaluate(()=>window.failSave=true);await page.getByRole('button',{name:'Update profile'}).click();await page.evaluate(()=>window.finishSave());await page.getByText('Synthetic update failure').waitFor();
      await page.screenshot({path:path.join(output,`${mode}-${theme}-${scenario.name}-error.png`),fullPage:true});
      assert.equal(await page.evaluate(()=>window.fixtureWrites),2);
      // Interrupt a third synthetic save by reloading; the route must recover cleanly.
      await page.evaluate(()=>window.failSave=false);await page.getByRole('button',{name:'Update profile'}).click();
      assert.ok(await page.getByRole('button',{name:'Saving...'}).isDisabled());assert.equal(await page.evaluate(()=>window.fixtureWrites),3);
      await page.reload();await helper.waitFor();assert.ok(await page.getByLabel('Username',{exact:true}).isDisabled());
      assert.equal(await page.evaluate(()=>window.fixtureWrites),0);assert.ok(await page.getByRole('button',{name:'Update profile'}).isEnabled());
      measurements.push({theme,scenario:scenario.name,mode,...metrics});
    }
  }
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  await writeFile(path.join(output,'results.json'),JSON.stringify({result:'PASS',zoom200:'590x378 CSS viewport models reflow for 1180x757 at 200%; native browser zoom not automated',measurements},null,2));
  console.log(JSON.stringify({result:'PASS',cases:measurements.length,screenshots:output}));
}finally{if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(temporary,{recursive:true,force:true})}

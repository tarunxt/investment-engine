/** Actual Profile and shared Input, compiled application CSS; synthetic offline API only. */
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
const temp=await mkdtemp(path.join(tmpdir(),'shared-input-'));
const output=process.env.A8_OUTPUT || path.join(temp,'evidence');
let browser,server;
try {
  await mkdir(output,{recursive:true});
  await writeFile(path.join(temp,'auth.ts'),`const user={username:'fixture-user',email:'fixture@example.test',full_name:'Synthetic Profile'}; export const useAuth=()=>({user,refreshAuth:async()=>{}});`);
  await writeFile(path.join(temp,'api.ts'),`export const apiService={getProfile:async()=>({bio:'Synthetic multiline biography',avatar_url:'https://example.test/avatar.png'}),updateProfile:(body)=>{window.submission=body;return new Promise((resolve,reject)=>{window.finish=()=>reject(new Error('Synthetic save failure'));});}};`);
  await writeFile(path.join(temp,'entry.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import Profile from ${JSON.stringify(path.join(root,'app/console/profile/page.tsx'))};import {Input} from ${JSON.stringify(path.join(root,'components/ui/input.tsx'))};createRoot(document.getElementById('root')).render(<main><p>Offline synthetic Profile fixture</p><Profile/><label htmlFor="invalid">Synthetic invalid state</label><Input id="invalid" aria-invalid="true" defaultValue="Invalid fixture"/><label htmlFor="variant">Error variant</label><Input id="variant" variant="error"/><select aria-label="Legacy select"><option>Boxed select fixture</option></select></main>);`);
  await writeFile(path.join(temp,'loader.cjs'),`const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(s){return ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020},fileName:this.resourcePath}).outputText;};`);
  const w=require('next/dist/compiled/webpack/webpack');
  await new Promise((resolve,reject)=>w.webpack({mode:'development',devtool:false,entry:path.join(temp,'entry.tsx'),output:{path:temp,filename:'bundle.js'},resolve:{extensions:['.tsx','.ts','.js'],modules:[path.join(root,'node_modules')],alias:{'@/hooks/useAuth':path.join(temp,'auth.ts'),'@/services/api':path.join(temp,'api.ts'),'@':root}},module:{rules:[{test:/\.tsx?$/,use:path.join(temp,'loader.cjs')}]},plugins:[new w.webpack.DefinePlugin({'process.env':JSON.stringify({NODE_ENV:'development'})})]},(e,s)=>e?reject(e):s.hasErrors()?reject(new Error(s.toString({all:false,errors:true}))):resolve()));
  const postcss=require('postcss');
  let source=await readFile(path.join(root,'app/globals.css'),'utf8');
  if(process.env.A8_BASELINE) source=source.replace('.dark input:not([data-slot="input"])','.dark input');
  const css=(await postcss([require('@tailwindcss/postcss')({base:root})]).process(source,{from:path.join(root,'app/globals.css')})).css;
  const bundle=await readFile(path.join(temp,'bundle.js'));
  server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'text/javascript':req.url==='/style.css'?'text/css':'text/html');res.end(req.url==='/bundle.js'?bundle:req.url==='/style.css'?css:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline Profile fixture</title><link rel="stylesheet" href="/style.css"><style>body{padding:24px}main{max-width:720px;margin:auto}</style><div id="root"></div><script src="/bundle.js"></script>');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const observations=[];
  for(const theme of ['light','dark']) for(const [name,width,height,zoom] of [['desktop',1180,757,1],['mobile',390,844,1],['zoom200',1180,757,2]]) {
    const context=await browser.newContext({viewport:{width,height},serviceWorkers:'block'});
    await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
    const page=await context.newPage();await page.goto(origin);
    await page.evaluate(({theme,zoom})=>{document.documentElement.className=theme;document.body.style.zoom=String(zoom);},{theme,zoom});
    await page.locator('#avatar_url').waitFor();await page.waitForFunction(()=>document.querySelector('#avatar_url').value.includes('example.test'));
    await page.waitForTimeout(300);
    const styles=()=>page.locator('#full_name').evaluate(el=>{const s=getComputedStyle(el);return {top:s.borderTopColor,bottom:s.borderBottomColor,bg:s.backgroundColor,width:s.borderBottomWidth};});
    const normal=await styles();
    const disabled=await page.locator('#username').evaluate(el=>({disabled:el.disabled,bg:getComputedStyle(el).backgroundColor,value:el.value}));
    assert.equal(disabled.disabled,true);assert.equal(disabled.value,'fixture-user');
    await page.locator('#full_name').hover();const hover=await styles();
    await page.keyboard.press('Tab');await page.locator('#full_name').focus();assert.equal(await page.locator('#full_name').evaluate(el=>el.matches(':focus-visible')),true);
    await page.waitForTimeout(250);const focused=await styles();
    const invalid=await page.locator('#invalid').evaluate(el=>getComputedStyle(el).borderBottomColor);
    const boxed=await page.locator('#bio').evaluate(el=>getComputedStyle(el).borderTopColor);
    if(process.env.A8_BASELINE && theme==='dark') assert.notEqual(normal.top,'rgba(0, 0, 0, 0)');
    else {assert.equal(normal.top,'rgba(0, 0, 0, 0)');assert.equal(normal.bg,'rgba(0, 0, 0, 0)');assert.notEqual(disabled.bg,normal.bg);assert.notEqual(focused.bottom,normal.bottom);assert.notEqual(invalid,normal.bottom);}
    assert.notEqual(boxed,'rgba(0, 0, 0, 0)');assert.equal(hover.top,normal.top);
    await page.screenshot({path:path.join(output,`${theme}-${name}.png`),fullPage:true});
    // Deterministic screenshot assertion: unchanged repeated render has identical pixels.
    assert.deepEqual(await page.screenshot({fullPage:true,caret:'hide',animations:'disabled'}),await page.screenshot({fullPage:true,caret:'hide',animations:'disabled'}));
    await page.locator('#full_name').fill('Edited synthetic name');
    await page.getByRole('button',{name:'Update profile',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'Saving...'}).isDisabled(),true);
    assert.deepEqual(await page.evaluate(()=>window.submission),{full_name:'Edited synthetic name',bio:'Synthetic multiline biography',avatar_url:'https://example.test/avatar.png'});
    await page.screenshot({path:path.join(output,`${theme}-${name}-loading.png`),fullPage:true});
    await page.evaluate(()=>window.finish());await page.getByText('Synthetic save failure',{exact:true}).waitFor();
    assert.equal(await page.locator('#full_name').inputValue(),'Edited synthetic name');assert.equal(await page.locator('#email').isDisabled(),true);
    await page.screenshot({path:path.join(output,`${theme}-${name}-error.png`),fullPage:true});
    observations.push({theme,name,zoom,normal,hover,focused,disabled,invalid,boxed});await context.close();
  }
  await writeFile(path.join(output,'computed-styles.json'),JSON.stringify(observations,null,2));
  console.log(`PASS 6 theme/viewport combinations; computed geometry, disabled fill/attributes, keyboard focus, hover, invalid, boxed textarea, mocked loading/save-error and payload preservation. ${process.env.A8_BASELINE?'Dark baseline override reproduced.':''}`);
} finally {await browser?.close();await new Promise(r=>server?server.close(r):r());await rm(temp,{recursive:true,force:true});}

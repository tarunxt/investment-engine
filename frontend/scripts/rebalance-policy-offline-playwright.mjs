/** Offline browser acceptance of the actual run control and saved-policy notice. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
const require=createRequire(import.meta.url),frontend=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temporary=await mkdtemp(path.join(tmpdir(),'rebalance-policy-fixture-'));
let browser,server;
try {
  await writeFile(path.join(temporary,'entry.tsx'),`
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {AnalysisOnlyRunControl,RunSideEffectPolicyNotice} from ${JSON.stringify(path.join(frontend,'components/shared/AnalysisOnlyRunControl.tsx'))};
    function Fixture(){const [checked,setChecked]=useState(false),[busy,setBusy]=useState(false),[policy,setPolicy]=useState(null);window.setPolicy=setPolicy;
    return <><AnalysisOnlyRunControl checked={checked} disabled={busy} onChange={setChecked}/>
    <button disabled={busy} onClick={()=>{setBusy(true);setPolicy(checked?{version:1,mode:'analysis_only'}:null)}}>Reserve</button>
    <button onClick={()=>{setBusy(false);setChecked(false)}}>Interrupt</button>
    <section aria-label="Saved summary"><RunSideEffectPolicyNotice policy={policy}/></section>
    <dialog open aria-label="Saved detail"><RunSideEffectPolicyNotice policy={policy}/></dialog></>}
    createRoot(document.getElementById('root')).render(<Fixture/>);
  `);
  await writeFile(path.join(temporary,'loader.cjs'),`const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(s){return ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020},fileName:this.resourcePath}).outputText;};`);
  const w=require('next/dist/compiled/webpack/webpack');
  await new Promise((resolve,reject)=>w.webpack({mode:'development',devtool:false,entry:path.join(temporary,'entry.tsx'),output:{path:temporary,filename:'bundle.js'},resolve:{extensions:['.tsx','.ts','.js'],modules:[path.join(frontend,'node_modules')],alias:{'@':frontend}},module:{rules:[{test:/\.tsx?$/,use:path.join(temporary,'loader.cjs')}]},plugins:[new w.webpack.DefinePlugin({'process.env.NODE_ENV':JSON.stringify('development')})]},(error,stats)=>error?reject(error):stats.hasErrors()?reject(new Error(stats.toString({all:false,errors:true}))):resolve()));
  const bundle=await readFile(path.join(temporary,'bundle.js'));
  server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'text/javascript':'text/html');res.end(req.url==='/bundle.js'?bundle:'<!doctype html><title>Offline run policy</title><div id="root"></div><script src="/bundle.js"></script>')});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||chromium.executablePath(),headless:true});
  const context=await browser.newContext({serviceWorkers:'block'}),external=[],errors=[];
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){external.push(route.request().url());return route.abort()}return route.continue()});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);
  const checkbox=page.getByRole('checkbox'),notes=page.getByRole('note');await checkbox.waitFor();
  assert.equal(await checkbox.isChecked(),false);assert.equal(await notes.count(),0);
  await checkbox.check();await page.getByRole('button',{name:'Reserve',exact:true}).click();assert.equal(await checkbox.isDisabled(),true);assert.equal(await notes.count(),2);
  await page.getByRole('button',{name:'Interrupt',exact:true}).click();assert.equal(await checkbox.isChecked(),false);assert.equal(await notes.count(),2);
  await page.getByRole('button',{name:'Reserve',exact:true}).click();assert.equal(await notes.count(),0);
  for(const policy of [null,{version:1,mode:'existing_preferences'},{version:0,mode:'analysis_only'},{}]){await page.evaluate(value=>window.setPolicy(value),policy);await page.waitForTimeout(20);assert.equal(await notes.count(),0)}
  await page.evaluate(()=>window.setPolicy({version:1,mode:'analysis_only'}));await notes.first().waitFor();assert.equal(await notes.count(),2);
  assert.deepEqual(external,[]);assert.deepEqual(errors,[]);console.log('PASS actual control and saved-policy notice: defaults, opt-out, disabled, interrupted/repeated, legacy/malformed; zero external requests');
} finally {await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(temporary,{recursive:true,force:true})}

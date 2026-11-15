// Offline import form integration; every save resolves locally without network writes.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
const require=createRequire(import.meta.url), frontend=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=await mkdtemp(path.join(os.tmpdir(),'us-import-')), output=process.env.IMPORT_SCREENSHOT_DIR||'/tmp/us-import-evidence';
await mkdir(output,{recursive:true});
const baseline=process.env.IMPORT_BASELINE==='1';
const component=baseline?path.join(temp,'Baseline.tsx'):path.join(frontend,'app/console/indmoney-us/_components/IndMoneyUsPasteCard.tsx');
if(baseline)await writeFile(component,execFileSync('git',['show','c7d4942e03a3d0be320195b11fbbf24c5e83b94c:frontend/app/console/indmoney-us/_components/IndMoneyUsPasteCard.tsx'],{cwd:frontend}));
await writeFile(path.join(temp,'entry.tsx'),`import React,{useState}from'react';import{createRoot}from'react-dom/client';import{IndMoneyUsPasteCard}from '${component}';function Fixture(){const[saving,setSaving]=useState(false);const[error,setError]=useState(null);window.fixture={setSaving,setError};return <IndMoneyUsPasteCard saving={saving} error={error} onSubmit={data=>new Promise((resolve,reject)=>{window.submissions.push(data);window.finish=resolve;window.fail=reject})}/>};createRoot(document.getElementById('root')).render(<Fixture/>);`);
await writeFile(path.join(temp,'loader.cjs'),`const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(s){return ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020},fileName:this.resourcePath}).outputText}`);
const w=require('next/dist/compiled/webpack/webpack');
await new Promise((resolve,reject)=>w.webpack({mode:'development',devtool:false,entry:path.join(temp,'entry.tsx'),output:{path:temp,filename:'bundle.js'},resolve:{extensions:['.tsx','.ts','.js'],modules:[path.join(frontend,'node_modules')],alias:{'@':frontend}},module:{rules:[{test:/\.tsx?$/,use:path.join(temp,'loader.cjs')}]},plugins:[new w.webpack.DefinePlugin({'process.env':JSON.stringify({NODE_ENV:'development'})})]},(error,stats)=>error?reject(error):stats.hasErrors()?reject(Error(stats.toString({all:false,errors:true}))):resolve()));
const css=(await postcss([tailwind({base:frontend})]).process(await readFile(path.join(frontend,'app/globals.css'),'utf8'),{from:path.join(frontend,'app/globals.css')})).css;
const bundle=await readFile(path.join(temp,'bundle.js'));const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'text/javascript':'text/html');res.end(req.url==='/bundle.js'?bundle:`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}body{font-family:Arial;padding:24px}</style><div id="root"></div><script>window.submissions=[];</script><script src="/bundle.js"></script>`)});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>r.request().url().startsWith(base)?r.continue():r.abort());
try{
for(const {width,height} of [{width:1440,height:1000},{width:390,height:844}]){
 await page.setViewportSize({width,height});await page.goto(base+'/console/indmoney-us');
 const save=page.getByRole('button',{name:'Save Snapshot'}),input=page.getByLabel('Paste INDmoney data here');
 await save.waitFor();assert.equal(await save.isDisabled(),true);assert.equal(await input.inputValue(),'');
 await page.screenshot({path:path.join(output,`${baseline?'before':'after'}-closed-${width}.png`),fullPage:true});
 if(baseline)continue;
 const summary=page.locator('summary');await summary.focus();await page.keyboard.press('Enter');
 assert.equal(await page.locator('details').getAttribute('open'),'');
 await page.getByText('Illustrative example only:',{exact:false}).waitFor();
 assert.equal(await save.isDisabled(),true);assert.equal(await input.inputValue(),'');assert.equal(await page.evaluate(()=>submissions.length),0);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.screenshot({path:path.join(output,`after-example-${width}.png`),fullPage:true});
 await page.keyboard.press('Space');assert.equal(await page.locator('details').getAttribute('open'),null);
 await page.keyboard.press('Tab');assert.equal(await page.getByLabel('Snapshot timestamp').evaluate(el=>el===document.activeElement),true);
 for(let step=0;step<12 && !await input.evaluate(el=>el===document.activeElement);step++)await page.keyboard.press('Tab');
 assert.equal(await input.evaluate(el=>el===document.activeElement),true);
 await input.fill('   ');assert.equal(await save.isDisabled(),true);
 await input.fill('Current Value\n$110.00');await page.evaluate(()=>fixture.setSaving(true));assert.equal(await save.isDisabled(),true);
 await page.screenshot({path:path.join(output,`saving-${width}.png`),fullPage:true});
 await page.evaluate(()=>fixture.setSaving(false));await save.click();await page.waitForFunction(()=>submissions.length===1);
 assert.equal(await page.evaluate(()=>submissions[0].raw_text),'Current Value\n$110.00');
 await page.evaluate(()=>{fixture.setError('Fixture save failed');fail(Error('fixture failure'))});await page.getByText('Fixture save failed').waitFor();
 assert.equal(await input.inputValue(),'Current Value\n$110.00');await page.screenshot({path:path.join(output,`failed-${width}.png`),fullPage:true});
 await page.evaluate(()=>fixture.setError(null));await save.click();await page.waitForFunction(()=>submissions.length===2);await page.evaluate(()=>finish());
 await page.getByText('Snapshot saved. Check its parse status',{exact:false}).waitFor();assert.equal(await input.inputValue(),'');assert.equal(await save.isDisabled(),true);
 await page.screenshot({path:path.join(output,`success-${width}.png`),fullPage:true});
 await page.goto(base+'/fixture-away');await page.goBack();await save.waitFor();assert.equal(new URL(page.url()).pathname,'/console/indmoney-us');assert.equal(await save.isDisabled(),true);
}
assert.deepEqual(errors,[]);console.log('PASS '+(baseline?'baseline screenshots':'empty/whitespace, disclosure keyboard, focus order, unchanged partial payload, saving, failure preservation, success reset, safe back, desktop/narrow overflow')+'; local component fixtures only; '+output);
}finally{await browser.close();server.close()}

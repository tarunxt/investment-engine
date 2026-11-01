// Offline integration of the actual Prompt Library with safe API fixtures.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
const require=createRequire(import.meta.url), frontend=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=await mkdtemp(path.join(os.tmpdir(),'prompts-discovery-')), output=process.env.PROMPTS_SCREENSHOT_DIR||'/tmp/prompts-discovery-evidence';
await mkdir(output,{recursive:true});
await writeFile(path.join(temp,'entry.tsx'),`import React from 'react';import{createRoot}from'react-dom/client';import Page from '${frontend}/app/console/prompts/page';createRoot(document.getElementById('root')).render(<Page/>);`);
await writeFile(path.join(temp,'api.ts'),`export class APIError extends Error{};export const apiService={getPrompts:()=>new Promise((resolve,reject)=>{window.requests.push({resolve,reject})}),updatePrompt:(id,data)=>{window.writes.push({id,...data});return Promise.resolve({...data,id,is_system:false,source_prompt_id:1,version:5,updated_at:'2026-06-07'})},createPrompt:(data)=>{window.writes.push(data);return Promise.resolve({...data,id:99,is_system:false,version:1,updated_at:'2026-06-07'})}};`);
await writeFile(path.join(temp,'link.tsx'),`import React from 'react';export default function Link({children,href,...props}){return <a href={href} {...props}>{children}</a>}`);
await writeFile(path.join(temp,'nav.ts'),`export const usePathname=()=>'/console/profile/cost-drivers';`);
await writeFile(path.join(temp,'loader.cjs'),`const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(s){return ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020},fileName:this.resourcePath}).outputText}`);
const w=require('next/dist/compiled/webpack/webpack');
await new Promise((resolve,reject)=>w.webpack({mode:'development',devtool:false,entry:path.join(temp,'entry.tsx'),output:{path:temp,filename:'bundle.js'},resolve:{extensions:['.tsx','.ts','.js'],modules:[path.join(frontend,'node_modules')],alias:{'next/link$':path.join(temp,'link.tsx'),'next/navigation$':path.join(temp,'nav.ts'),'@/services/api$':path.join(temp,'api.ts'),'@':frontend}},module:{rules:[{test:/\.tsx?$/,use:path.join(temp,'loader.cjs')}]},plugins:[new w.webpack.DefinePlugin({'process.env':JSON.stringify({NODE_ENV:'development'})})]},(error,stats)=>error?reject(error):stats.hasErrors()?reject(Error(stats.toString({all:false,errors:true}))):resolve()));
const css=(await postcss([tailwind({base:frontend})]).process(await readFile(path.join(frontend,'app/globals.css'),'utf8'),{from:path.join(frontend,'app/globals.css')})).css;
const bundle=await readFile(path.join(temp,'bundle.js'));const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'text/javascript':'text/html');res.end(req.url==='/bundle.js'?bundle:`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}body{font-family:Arial;padding:24px}</style><div id="root"></div><script>window.requests=[];window.writes=[];</script><script src="/bundle.js"></script>`)});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>r.request().url().startsWith(base)?r.continue():r.abort());
const fixture=[{id:1,name:'Portfolio Event Calendar Scan Flow',description:'Portfolio event calendar prompt used by Zerodha and INDmoney US event scans for upcoming price-sensitive company events.',body:'[TASK]\nCreate one markdown table listing upcoming price-sensitive events.\n[ROLE]\nAct as an equity market calendar analyst.\n[OBJECTIVE]\n'+('Upcoming earnings, results, board meetings, AGMs. '.repeat(20)),is_system:true,version:2,updated_at:'2026-06-07T10:00:00Z'},...Array.from({length:7},(_,i)=>({id:i+2,name:'Other prompt '+i,body:'Preserved other prompt '+i,is_system:true,version:3,updated_at:'2026-06-07'})),{id:20,name:'My private prompt',description:null,body:'Private content',is_system:false,source_prompt_id:1,version:4,updated_at:'2026-06-07'}];
const settle=async(data,fail=false)=>page.evaluate(({data,fail})=>window.requests[0][fail?'reject':'resolve'](fail?Error(data):data),{data,fail});
try{
for(const width of [1180,390,320]){
 await page.setViewportSize({width,height:757});await page.goto(base);await page.getByText('Loading prompts…').waitFor();await settle(fixture);await page.getByText('System v2',{exact:true}).waitFor();
 assert.equal(await page.getByText('Other prompt 6',{exact:true}).count(),1);
 assert.equal(await page.getByText('India',{exact:true}).count(),1);assert.equal(await page.getByText('US',{exact:true}).count(),1);
 await page.screenshot({path:path.join(output,`catalogue-${width}.png`),fullPage:true});
 const preview=page.locator('summary').first();await preview.focus();await page.keyboard.press('Enter');await page.getByRole('region',{name:'Portfolio Event Calendar Scan Flow preview'}).waitFor();
 const panel=page.getByRole('region',{name:'Portfolio Event Calendar Scan Flow preview'});
 const panelBox=await panel.boundingBox();
 for(const action of await panel.getByRole('button').all()){
  const box=await action.boundingBox();assert.ok(box.x>=panelBox.x && box.x+box.width<=panelBox.x+panelBox.width+0.5,`Preview action must fit panel at ${width}px: ${JSON.stringify({box,panelBox})}`);
  assert.equal(await action.evaluate(el=>el.scrollWidth>el.clientWidth),false,'Button label must fit its own box');
 }
 assert.equal(await panel.evaluate(el=>el.scrollWidth>el.clientWidth),false,'Preview must not overflow internally');
 await page.screenshot({path:path.join(output,`preview-${width}.png`),fullPage:true});
 for(let i=0;i<2;i++){await page.getByRole('button',{name:'Return to Prompt catalogue'}).click();assert.equal(await preview.evaluate(el=>el===document.activeElement),true);await page.keyboard.press('Enter');}
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.getByRole('button',{name:'Open full prompt'}).click();await page.getByText('Edit My Version',{exact:true}).waitFor();await page.getByText('Saving changes creates or updates your personal version.',{exact:false}).waitFor();await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await page.getByRole('tab',{name:'My Prompts'}).click();await page.getByText('My private prompt',{exact:true}).waitFor();await page.locator('summary').focus();await page.keyboard.press('Enter');await page.getByRole('button',{name:'Return to Prompt catalogue'}).click();assert.equal(await page.getByRole('tab',{name:'My Prompts'}).getAttribute('aria-selected'),'true');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.getByRole('button',{name:'Rules',exact:true}).click();await page.getByRole('button',{name:/Stock Parameters/}).click();await page.getByRole('heading',{name:'Stock Parameters'}).waitFor();await page.mouse.click(2,2);
 assert.equal(await page.evaluate(()=>writes.length),0);
}
await page.goto(base);await settle(fixture);await page.getByRole('button',{name:'New Prompt',exact:true}).click();await page.getByRole('heading',{name:'New Prompt'}).waitFor();await page.getByRole('button',{name:'Cancel',exact:true}).click();
await page.getByRole('button',{name:'Edit prompt: Portfolio Event Calendar Scan Flow',exact:true}).click();await page.getByRole('button',{name:'Save My Version',exact:true}).click();await page.waitForFunction(()=>writes.length===1);assert.equal(await page.evaluate(()=>writes[0].id),20);assert.equal(await page.locator('button[title="Open expanded prompt"]').first().textContent(),fixture[0].body);
await page.goto(base);await settle([]);await page.getByText('No system prompts configured.').waitFor();await page.screenshot({path:path.join(output,'empty.png')});
await page.goto(base);await settle('Fixture unavailable',true);await page.getByText('System prompts unavailable.').waitFor();assert.equal(await page.getByText('No system prompts configured.').count(),0);await page.screenshot({path:path.join(output,'failed.png')});
// A response with fewer records is shown as supplied, without fabricated totals or recency.
await page.goto(base);await settle([fixture[0]]);await page.getByText('System v2',{exact:true}).waitFor();assert.equal(await page.getByText('Updated 07 Jun 2026',{exact:true}).count(),1);assert.equal(await page.evaluate(()=>writes.length),0);assert.deepEqual(errors,[]);
console.log('PASS catalogue, all records, preview, repeated return/focus, scopes, editor cancel, Rules, loading/empty/failed, partial older response, 1180x757,390px and320px with preview action bounding-box containment; no external calls, zero navigation writes, fixture-only private update preserves source. Screenshots: '+output);
}finally{await browser.close();server.close()}

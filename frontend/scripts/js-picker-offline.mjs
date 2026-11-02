import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(), temp=await mkdtemp('/tmp/a9-image-browser-');
await writeFile(path.join(temp,'api.ts'),`export class APIError extends Error{};export const apiService={getProviders:async()=>{window.reads++;return[{name:'openai',configured:true,models:['fixture-model']}]}}`);
await writeFile(path.join(temp,'entry.tsx'),`import React from 'react';import{createRoot}from'react-dom/client';import{EventScanRunControls}from'${root}/components/shared/EventScanRunControls';window.reads=0;window.runs=[];createRoot(document.getElementById('root')).render(<EventScanRunControls selectionMode="multiple" defaultTargets={[]} disableImplicitDefaultTarget onRunMultiple={targets=>window.runs.push(targets)}/>);`);
await build({entryPoints:[path.join(temp,'entry.tsx')],outdir:temp,entryNames:'bundle',splitting:true,format:'esm',bundle:true,platform:'browser',jsx:'automatic',nodePaths:[path.join(root,'node_modules')],alias:{'@':root,'@/services/api':path.join(temp,'api.ts'),react:path.join(root,'node_modules/react'),'react-dom':path.join(root,'node_modules/react-dom')},define:{'process.env':JSON.stringify({NODE_ENV:'development',__NEXT_IMAGE_OPTS:require('next/dist/shared/lib/image-config').imageConfigDefault})}});

const server=createServer(async(req,res)=>{res.setHeader('content-type',req.url.endsWith('.js')?'text/javascript':'text/html');res.end(req.url.endsWith('.js')?await readFile(path.join(temp,path.basename(req.url))):'<div id="root"></div><script type="module" src="/bundle.js"></script>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
try{
browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',async r=>{if(new URL(r.request().url()).origin!==origin)return r.abort();if(r.request().url().includes('LlmModel'))await new Promise(resolve=>setTimeout(resolve,350));return r.continue();});await page.goto(origin);await page.waitForFunction(()=>window.reads===1);const picker=page.getByRole('button',{name:'Select LLMs',exact:true});await picker.focus();await page.keyboard.press('Enter');await page.getByRole('dialog').waitFor();await page.getByRole('status').filter({hasText:'Loading model selection'}).waitFor();assert.equal(await picker.evaluate(el=>el===document.activeElement),true);await page.getByText('fixture-model',{exact:true}).click();await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),0);await picker.click();await page.getByText('fixture-model',{exact:true}).waitFor();await page.getByRole('button',{name:'Close LLM selector'}).click();await page.getByRole('button',{name:'Run Events Scan',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.runs),[[{provider:'openai',model:'fixture-model'}]]);assert.equal(await page.evaluate(()=>window.reads),1);assert.deepEqual(errors,[]);console.log('PASS keyboard open, Escape, close/reopen, selection continuity, target callback, single provider fixture read');
}finally{await browser?.close();server.close();}

#!/usr/bin/env node
// Production disclosure component/call sites and CSS; synthetic state, no API access.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
const require=createRequire(import.meta.url), root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=await mkdtemp(path.join(os.tmpdir(),'disclosure-'));
const output=process.env.DISCLOSURE_OUTPUT || '/tmp/disclosure-evidence';
const baseline=process.env.DISCLOSURE_BASELINE;
const source=baseline?execFileSync('git',['show',`${baseline}:frontend/app/console/zerodha/page.tsx`],{cwd:root,encoding:'utf8'}):await readFile(path.join(root,'app/console/zerodha/page.tsx'),'utf8');
const semanticTokens=[...new Set([...((await readFile(path.join(root,'app/globals.css'),'utf8')).matchAll(/class~="(bg-[a-z]+-[0-9]+(?:\/[0-9]+)?)"/g))].map(m=>m[1]))];
const component=source.slice(source.indexOf('function StatusRevealButton('),source.indexOf('// ─── Place-order form'));
const controls=source.slice(source.indexOf('      <div className="flex flex-wrap items-center justify-end gap-2">'),source.indexOf('      {showConnectionDetails ? ('));
let browser,server;
try {
 await mkdir(output,{recursive:true});
 await writeFile(path.join(temp,'entry.tsx'),`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {CheckCircle2,LogOut,Link2} from 'lucide-react';import {Button} from '${root}/components/ui/button';import {cn} from '${root}/lib/utils';${component}\nfunction Fixture(){const [showConnectionDetails,setShowConnectionDetails]=useState(false),[showRedirectDetails,setShowRedirectDetails]=useState(false);const status={connected:!location.search.includes('disconnected')},configured=!location.search.includes('unconfigured');return <main style={{padding:24}}><h1>Synthetic disclosure fixture</h1>${controls}<p>{showConnectionDetails?'Connection details expanded':'Connection details collapsed'}</p><p>{showRedirectDetails?'Redirect details expanded':'Redirect details collapsed'}</p><Button variant="outline" disabled aria-label="Loading fixture">Loading fixture</Button><Button variant="outline" disabled aria-label="Unavailable fixture">Unavailable fixture</Button><Button variant="outline" aria-invalid="true" aria-label="Invalid fixture">Invalid fixture</Button><div className="bg-emerald-50/50">Positive surface</div><div className="bg-blue-50/50">Information surface</div></main>};createRoot(document.getElementById('root')).render(<Fixture/>);`);
 await writeFile(path.join(temp,'loader.cjs'),`const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(s){return ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020},fileName:this.resourcePath}).outputText}`);
 const w=require('next/dist/compiled/webpack/webpack');
 await new Promise((resolve,reject)=>w.webpack({mode:'development',devtool:false,entry:path.join(temp,'entry.tsx'),output:{path:temp,filename:'bundle.js'},resolve:{extensions:['.tsx','.ts','.js'],modules:[path.join(root,'node_modules')],alias:{'@':root}},module:{rules:[{test:/\.tsx?$/,use:path.join(temp,'loader.cjs')}]},plugins:[new w.webpack.DefinePlugin({'process.env.NODE_ENV':JSON.stringify('development')})]},(e,s)=>e?reject(e):s.hasErrors()?reject(Error(s.toString({all:false,errors:true}))):resolve()));
 const cssSource=baseline?execFileSync('git',['show',`${baseline}:frontend/app/globals.css`],{cwd:root,encoding:'utf8'}):await readFile(path.join(root,'app/globals.css'),'utf8');
 const css=(await postcss([tailwind({base:root})]).process(cssSource,{from:path.join(root,'app/globals.css')})).css;
 const bundle=await readFile(path.join(temp,'bundle.js'));
 server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'text/javascript':'text/html');res.end(req.url==='/bundle.js'?bundle:`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}body{font-family:Arial;background:var(--background);color:var(--foreground)}</style><div id="root"></div>${semanticTokens.map(t=>`<div hidden data-semantic-probe class="${t}"></div>`).join('')}<script src="/bundle.js"></script>`)});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 const page=await browser.newPage(),external=[],errors=[],results=[],semanticSurfaces=[];
 page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>r.request().url().startsWith(base)?r.continue():(external.push(r.request().url()),r.abort()));
 for(const theme of ['light','dark']) for(const [name,width,zoom] of [['desktop',1180,1],['mobile',390,1],['zoom200',1180,2]]){
  await page.setViewportSize({width:Math.round(width/zoom),height:Math.round(757/zoom)});await page.goto(base);await page.locator('button').first().waitFor();
  await page.evaluate(t=>document.documentElement.classList.toggle('dark',t==='dark'),theme);
  semanticSurfaces.push({theme,name,values:await page.locator('[data-semantic-probe]').evaluateAll(es=>es.map(e=>({token:e.className,background:getComputedStyle(e).backgroundColor})))});
  // Half CSS viewport checks 200% reflow; native browser zoom is reported separately.
  const metrics=await page.evaluate(()=>({width:innerWidth,dpr:devicePixelRatio,scale:visualViewport.scale}));
  for(const label of ['Show Zerodha connection details','Show Zerodha redirect URL details']){
   const b=page.getByRole('button',{name:label,exact:true});
   await page.mouse.move(0,0);await b.evaluate(e=>e.blur());await page.waitForTimeout(250);
   const read=()=>b.evaluate(e=>{const s=getComputedStyle(e);return {background:s.backgroundColor,color:s.color,ring:s.boxShadow,hover:e.matches(':hover'),focus:e.matches(':focus-visible'),expanded:e.getAttribute('aria-expanded')}});
   const rest=await read();const restPixels=await b.screenshot();await page.screenshot({path:path.join(output,`${theme}-${name}-${label.includes('connection')?'connection':'redirect'}-default.png`)});
   await b.hover();await page.waitForTimeout(250);const hover=await read();const hoverPixels=await b.screenshot();
   await page.screenshot({path:path.join(output,`${theme}-${name}-${label.includes('connection')?'connection':'redirect'}-hover.png`)});
   await page.mouse.move(0,0);await page.keyboard.press('Tab');await b.focus();await page.waitForTimeout(250);const focus=await read();
   await page.screenshot({path:path.join(output,`${theme}-${name}-${label.includes('connection')?'connection':'redirect'}-focus.png`)});
   await page.keyboard.press('Enter');await page.mouse.move(0,0);await b.evaluate(e=>e.blur());await page.waitForTimeout(250);const expanded=await read();
   await page.screenshot({path:path.join(output,`${theme}-${name}-${label.includes('connection')?'connection':'redirect'}-expanded.png`)});
   const neutral=rest.background==='rgba(0, 0, 0, 0)';
   results.push({theme,name,zoom,metrics,label,rest,hover,focus,expanded,neutral});
   if(!baseline){assert.notDeepEqual(restPixels,hoverPixels,'Hover screenshot must visibly differ');if(theme==='dark')assert.equal(rest.color,hover.color,'Dark semantic icon color remains stable');assert.ok(neutral,JSON.stringify(results.at(-1)));assert.notEqual(hover.background,rest.background);assert.equal(focus.focus,true);assert.notEqual(focus.ring,'none');assert.notEqual(focus.background,rest.background);assert.equal(expanded.expanded,'true');assert.notEqual(expanded.background,rest.background)}
   await b.click();await b.evaluate(e=>e.blur());
  }
  for(const label of ['Loading fixture','Unavailable fixture']){const b=page.getByRole('button',{name:label,exact:true});assert.equal(await b.isDisabled(),true);assert.equal(await b.evaluate(e=>getComputedStyle(e).opacity),'0.5')}
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.notEqual(await page.getByRole('button',{name:'Invalid fixture',exact:true}).evaluate(e=>getComputedStyle(e).boxShadow),'none');
 }
 await page.goto(base+'?disconnected&unconfigured');
 await page.getByRole('button',{name:'Show Zerodha login status',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Show Zerodha redirect URL details',exact:true}).count(),0);
 await page.getByRole('button',{name:'Show Zerodha login status',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'Show Zerodha login status',exact:true}).getAttribute('aria-expanded'),'true');
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 await writeFile(path.join(output,'results.json'),JSON.stringify({baseline:baseline||null,results,semanticSurfaces,errors,external,baselineFailures:results.filter(r=>!r.neutral).length,zoomMethod:'Half CSS viewport for 200% reflow; actual browser user zoom remains unverified'},null,2));
 console.log(JSON.stringify({cases:results.length,baselineFailures:results.filter(r=>!r.neutral).length,external,errors}));
}finally{await browser?.close();await new Promise(r=>server?server.close(r):r());await rm(temp,{recursive:true,force:true})}

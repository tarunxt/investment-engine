// VISUAL-FORMULA-GRID-REFLOW: actual formula leaf, optionally from verified P1 postimage.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=await mkdtemp(path.join(os.tmpdir(),'formula-readable-'));
const output=process.env.FORMULA_EVIDENCE_DIR||'/tmp/formula-readable-evidence';await mkdir(output,{recursive:true});
const target=path.join(root,'app/console/_components/FinalActionablesConsole.tsx');
const source=process.env.FORMULA_SOURCE_FILE||target;
const blob=execFileSync('git',['hash-object',source],{encoding:'utf8'}).trim();
if(process.env.FORMULA_EXPECTED_BLOB)assert.equal(blob,process.env.FORMULA_EXPECTED_BLOB);
const code=await readFile(source,'utf8');
await writeFile(temp+'/entry.tsx',`import React,{useState}from'react';import{createRoot}from'react-dom/client';import{ActionablesFormulaModal,ScoreReferenceTables,DEFAULT_SCORE_MATRIX_FORMULA_CONFIG,saveScoreMatrixFormulaConfig,loadScoreMatrixFormulaConfig}from'${target}';function Fixture(){const[open,setOpen]=useState(false),[config,setConfig]=useState(DEFAULT_SCORE_MATRIX_FORMULA_CONFIG);window.currentConfig=config;window.persist=()=>saveScoreMatrixFormulaConfig(config);window.restored=loadScoreMatrixFormulaConfig;return <div role="dialog" aria-label="Fixture parent calculations" onKeyDown={e=>{if(e.key==='Escape')window.outerEscape++}}><button onClick={()=>setOpen(true)}>Open formulas</button>{location.search.includes('compact')?<ScoreReferenceTables formulaConfig={config} onFormulaConfigChange={setConfig}/>:<ActionablesFormulaModal open={open} formulaConfig={config} onFormulaConfigChange={setConfig} onClose={()=>setOpen(false)}/>}</div>}createRoot(document.getElementById('root')).render(<Fixture/>);`);
await writeFile(temp+'/link.tsx',`import React from'react';export default function Link({children,href,...props}){return <a href={href} {...props}>{children}</a>}`);
await writeFile(temp+'/nav.ts',`export const useRouter=()=>({push:()=>{window.mutations++}});export const useSearchParams=()=>new URLSearchParams();export const usePathname=()=>'/fixture';`);
await writeFile(temp+'/api.ts',`export class APIError extends Error{};export const apiService=new Proxy({},{get:(_,key)=>()=>{window.mutations++;throw Error('Blocked '+String(key))}});`);
await build({entryPoints:[temp+'/entry.tsx'],outfile:temp+'/bundle.js',bundle:true,jsx:'automatic',nodePaths:[root+'/node_modules'],alias:{'@':root,'next/link':temp+'/link.tsx','next/navigation':temp+'/nav.ts','@/services/api':temp+'/api.ts',...(process.env.FORMULA_REVIEW_HOOK?{'@/hooks/useReviewDialog':process.env.FORMULA_REVIEW_HOOK}:{})},plugins:[{name:'actual-formula-leaf',setup(b){b.onLoad({filter:/FinalActionablesConsole\.tsx$/},()=>({contents:code+'\nexport {ActionablesFormulaModal,ScoreReferenceTables};',loader:'tsx',resolveDir:path.dirname(target)}));}}],define:{'process.env':'{}','process.env.NODE_ENV':'"development"'}});
const css=(await postcss([tailwind({base:root})]).process(await readFile(root+'/app/globals.css','utf8'),{from:root+'/app/globals.css'})).css;
const js=await readFile(temp+'/bundle.js');const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'text/javascript':'text/html');res.end(req.url==='/bundle.js'?js:`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>window.mutations=0;window.outerEscape=0</script><script src="/bundle.js"></script>`)});await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;const errors=[],external=[];
try{
 browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:1180,height:757}});const origin='http://127.0.0.1:'+server.address().port;
 page.on('pageerror',e=>{errors.push(e.message);console.error('PAGEERROR',e.message)});await page.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():(external.push(r.request().url()),r.abort()));
 const snapshot=()=>page.locator('input').evaluateAll(nodes=>nodes.map(n=>({label:n.getAttribute('aria-label'),value:n.value,type:n.type,step:n.step})));
 await page.goto(origin+'/?compact');await page.getByRole('heading',{name:'Score Symbol matrix',exact:true}).waitFor();const compact=await snapshot();
 const columns=await page.getByRole('heading',{name:'Model-action input weights',exact:true}).evaluate(n=>getComputedStyle(n.closest('section')).gridTemplateColumns.split(' ').length);assert.equal(columns,3);
 await page.goto(origin);const opener=page.getByRole('button',{name:'Open formulas',exact:true});await opener.click();const modal=page.getByRole('dialog',{name:'Logics and formulas',exact:true});await modal.waitFor();
 assert.deepEqual(await snapshot(),compact);const initial=await page.evaluate(()=>JSON.stringify(currentConfig));
 for(const width of [1180,390]){
  await page.setViewportSize({width,height:757});
  const headings=modal.getByRole('heading',{level:3}).filter({hasText:/Model-action input weights|Technical Scan Confidence Score|Score Symbol matrix/});const boxes=await headings.evaluateAll(nodes=>nodes.map(n=>{const r=n.closest('section > div').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width}}));assert.equal(boxes.length,3);assert.ok(boxes[0].y<boxes[1].y&&boxes[1].y<boxes[2].y);assert.ok(boxes.every(b=>Math.abs(b.width-boxes[0].width)<1));
  for(const input of await modal.locator('input').all()){await input.focus();assert.equal(await input.evaluate(n=>n===document.activeElement),true);await input.evaluate(n=>n.scrollIntoView({block:'nearest',inline:'nearest'}));}
  for(const region of await modal.getByRole('region').all()){await region.focus();await page.keyboard.press('ArrowRight');assert.equal(await region.evaluate(n=>n===document.activeElement),true);}
  await page.screenshot({path:output+'/stacked-'+width+'.png',fullPage:true});
 }
 assert.equal(await page.evaluate(()=>JSON.stringify(currentConfig)),initial);
 const first=modal.locator('input').first();const label=await first.getAttribute('aria-label');await first.fill('2.5');await first.dispatchEvent('change');await page.evaluate(()=>{window.retainedInput=document.querySelector('input');window.persist()});const changed=await page.evaluate(()=>JSON.stringify(currentConfig));assert.notEqual(changed,initial);assert.equal(await page.evaluate(()=>JSON.stringify(restored())),changed);
 await page.setViewportSize({width:1180,height:757});assert.equal(await first.evaluate(n=>n===window.retainedInput),true);assert.equal(await first.inputValue(),'2.5');
 if(process.env.FORMULA_EXPECT_P1_KEYS==='1'){
  await first.focus();await page.keyboard.press('Escape');await modal.waitFor({state:'hidden'});assert.equal(await opener.evaluate(n=>n===document.activeElement),true);assert.equal(await page.evaluate(()=>outerEscape),0);
  await opener.click();await modal.waitFor();assert.equal(await modal.getByLabel(label,{exact:true}).inputValue(),'2.5');await page.getByRole('button',{name:'Close formulas popup',exact:true}).click();await modal.waitFor({state:'hidden'});assert.equal(await opener.evaluate(n=>n===document.activeElement),true);
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.equal(await page.evaluate(()=>mutations),0);
 await writeFile(output+'/result.json',JSON.stringify({task:'VISUAL-FORMULA-GRID-REFLOW',sourceBlob:blob,result:'PASS',checks:['default compact consumer unchanged','all input labels/values/type/step preserved','full-width stacks at1180/390','focus and keyboard scroll regions','same input node across resize','existing update normalization and save/load persistence',...(process.env.FORMULA_EXPECT_P1_KEYS==='1'?['P1 nested Escape/opener restoration/reopen without outer close']:[])],limitations:['Synthetic leaf fixture; combined P1 owner/session acceptance reserved for integrator']},null,2));console.log('PASS formula readable leaf '+output);
}finally{await browser?.close();await new Promise(r=>server.close(r))}

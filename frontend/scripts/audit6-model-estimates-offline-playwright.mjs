// Synthetic offline browser coverage of actual Swing/CreateJobCard/RunModeFields and model panel.
// Dashboard data/context and unrelated fields are isolated; no production route or provider call.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
const require=createRequire(import.meta.url), {build}=require(process.env.AUDIT6_ESBUILD_PATH||'/tmp/credx-build/node_modules/esbuild');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),out=process.env.AUDIT6_MODEL_EVIDENCE_DIR||'/tmp/audit6-model-estimates-browser';
await mkdir(out,{recursive:true});
const fixture=`import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{PortfolioSwingTradeConsole}from'@/app/console/_components/PortfolioSwingTradeConsole';
import{LlmModelSelectionPanel}from'@/components/shared/LlmModelSelectionPanel';
const q=new URLSearchParams(location.search),state=q.get('state')||'missing',market=q.get('market')||'india';
window.__calls=[];window.__state=state;
const prices=state==='positive'?{a:2,b:3}:state==='partial'?{a:2}:state==='zero'?{a:0,b:0}:{};
window.__providers=[{name:'openai',configured:true,models:['a','b'],model_estimated_cost_inr:prices}];
function App(){const[opened,setOpened]=useState(false),[selected,setSelected]=useState(new Set(['openai::a','openai::b'])),[multipliers,setMultipliers]=useState({});return <main className='mx-auto max-w-5xl p-3'><h1>{market} · {state} estimates fixture</h1><PortfolioSwingTradeConsole portfolio={market==='india'?'zerodha':'indmoneyUs'} market={market}/><button id='dialog-trigger' onClick={()=>{setOpened(true);setTimeout(()=>document.querySelector('dialog').showModal(),0)}}>Open isolated model picker dialog</button>{opened&&<dialog aria-labelledby='picker-title' onClose={()=>{setOpened(false);document.querySelector('#dialog-trigger').focus()}} className='max-h-[90vh] w-[min(90vw,64rem)] overflow-auto rounded-xl p-4'><h2 id='picker-title'>Synthetic model picker container</h2><LlmModelSelectionPanel organized providers={window.__providers} selectedKeys={selected} loading={state==='loading'} showEstimateReadiness selectedMultipliers={multipliers} onMultiplierChange={(key,value)=>setMultipliers(x=>({...x,[key]:value}))} onToggle={key=>setSelected(x=>{const n=new Set(x);n.has(key)?n.delete(key):n.add(key);return n})}/><button onClick={()=>document.querySelector('dialog').close()}>Close picker</button></dialog>}</main>};createRoot(document.getElementById('root')).render(<App/>);`;
const contextMock=`import React from 'react';export const DashboardProvider=({children})=>children;export const useDashboard=()=>({prompt:'Synthetic offline prompt',scheduledAt:'',submitting:false,submitError:null,selectedTargets:new Set(['openai::a','openai::b']),isLoading:window.__state==='loading',providers:window.__providers,toggleTarget:()=>{},toggleAllForProvider:()=>{},selectAllTargets:()=>{},unselectAllTargets:()=>{},savedModelMixes:[],selectedModelMixId:null,applyModelMix:()=>{},saveModelMix:()=>{},renameModelMix:()=>{},deleteModelMix:()=>{},handleSubmit:e=>{e.preventDefault();window.__calls.push('submit');}});`;
const unrelated=['DashboardHeader','RecentJobsTable','PortfolioAnalysisNav','SwingTradeInvestmentAmountField','TemplateField','PromptField','ScheduleField','LlmModelMixControls'];
await build({stdin:{contents:fixture,resolveDir:root,sourcefile:'fixture.tsx',loader:'tsx'},bundle:true,outfile:path.join(out,'bundle.js'),jsx:'automatic',plugins:[{name:'offline-only',setup(b){b.onResolve({filter:/.*/},args=>{if(args.path==='../_context'||args.path==='@/app/console/dashboard/_context')return{path:'context',namespace:'fixture'};const name=args.path.split('/').at(-1);if(unrelated.includes(name))return{path:name,namespace:'fixture'};if(args.path.startsWith('@/'))return b.resolve(path.join(root,args.path.slice(2)),{resolveDir:root,kind:args.kind});});b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path==='context'?contextMock:`export const ${args.path}=()=>null;`,loader:'tsx',resolveDir:root}));}}]});
const css=(await postcss([tailwind()]).process(await readFile(path.join(root,'app/globals.css'),'utf8'),{from:path.join(root,'app/globals.css')})).css;
const bundle=await readFile(path.join(out,'bundle.js'));
const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'application/javascript':'text/html; charset=utf-8');res.end(req.url==='/bundle.js'?bundle:`<!doctype html><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><style>${css}</style><div id='root'></div><script src='/bundle.js'></script>`)});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
const page=await browser.newPage(),errors=[],blocked=[],results=[];
page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():(blocked.push(r.request().url()),r.abort()));
try{for(const market of ['india','us'])for(const width of [1180,390])for(const state of ['loading','missing','partial','zero','positive']){
await page.setViewportSize({width,height:844});await page.goto(`${origin}/?market=${market}&state=${state}`);await page.getByRole('heading',{name:`${market} · ${state} estimates fixture`}).waitFor();
const create=page.getByRole('button',{name:'Create Job',exact:true});await create.focus();await page.keyboard.press('Enter');
const summary=page.getByText(/^Estimated selected total:/);await summary.waitFor();
assert.match(await summary.innerText(),state==='loading'?/Loading pricing/:state==='positive'?/₹5.00/:/Unknown/);
if(['missing','partial','zero'].includes(state)){await page.getByRole('status').filter({hasText:'Cost estimate incomplete'}).waitFor();assert.doesNotMatch(await summary.innerText(),/₹0\.00/);}
const trigger=page.getByRole('button',{name:'Open isolated model picker dialog'});await trigger.focus();await page.keyboard.press('Enter');const dialog=page.getByRole('dialog',{name:'Synthetic model picker container'});await dialog.waitFor();
assert.match(await dialog.getByText(/^Estimated selected total:/).innerText(),state==='loading'?/Loading pricing/:state==='positive'?/₹5.00/:/Unknown/);
if(state!=='loading'){const tab=dialog.getByRole('tab',{name:'Selection summary'});await tab.focus();await page.keyboard.press('ArrowRight');await dialog.getByRole('tab',{name:'OpenAI choices',selected:true}).waitFor();const checks=dialog.getByRole('checkbox');assert.equal(await checks.count(),2);const badge=dialog.getByText(/^Selected estimate:/);assert.ok(await badge.evaluate(e=>{const d=e.closest('dialog').getBoundingClientRect(),r=e.getBoundingClientRect();return r.left>=d.left&&r.right<=d.right&&e.scrollWidth<=e.clientWidth+1}),'provider estimate badge fits and wraps inside narrow dialog');if(state==='positive'){await dialog.getByRole('button',{name:'Increase a multiplier'}).click();await dialog.getByRole('tab',{name:'Selection summary'}).click();await dialog.getByText('Estimated selected total: ₹7.00',{exact:true}).waitFor();}else{assert.doesNotMatch(await dialog.innerText(),/Selected estimate: ₹0|Estimate: ₹0|Est\. ₹0/);}}
assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
await page.screenshot({path:path.join(out,`${market}-${width}-${state}.png`),fullPage:true});
await dialog.getByRole('button',{name:'Close picker'}).click();await dialog.waitFor({state:'hidden'});assert.equal(await trigger.evaluate(e=>e===document.activeElement),true);assert.deepEqual(await page.evaluate(()=>window.__calls),[]);results.push({market,width,state});}
assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);await writeFile(path.join(out,'result.json'),JSON.stringify({timestamp:new Date().toISOString(),results,errors,blocked,operationalCalls:0,scope:'Actual Swing console/CreateJobCard/RunModeFields with isolated context; actual model panel in synthetic native dialog container, not a production dialog route.'},null,2));console.log(`PASS ${results.length} actual-component scenarios, no external or operational calls`);
}finally{await browser.close();server.close();}

// Offline browser regression: extracts the real StageLlmSelectorDialog; no API clients or jobs.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import ts from 'typescript';
import { chromium } from 'playwright';
import { compile } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';
const require = createRequire(import.meta.url);
const webpack = require('next/dist/compiled/webpack/webpack').webpack;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.env.MODEL_PICKER_EVIDENCE_DIR || '/tmp/auto-models-evidence');
mkdirSync(output, { recursive: true });
const workflow = readFileSync(resolve(root, 'app/console/dashboard/_components/RebalanceWorkflowSections.tsx'), 'utf8');
const ast = ts.createSourceFile('workflow.tsx', workflow, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const extract = name => ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)?.getText(ast);
const tileAst = ts.createSourceFile('tile.tsx', readFileSync(resolve(root, 'components/shared/WorkflowStageTile.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const stageMetadata = tileAst.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(tileAst) === 'STAGE_METADATA')).getText(tileAst).replace(/^export /, '');
const inventory = {
  anthropic: ['claude-opus-4-7','claude-sonnet-4-6','claude-3-7-sonnet-latest','claude-3-5-sonnet-latest','claude-3-5-haiku-latest','claude-3-opus-latest','claude-3-sonnet-20240229','claude-3-haiku-20240307'],
  gemini: ['gemini-2.5-flash','gemini-2.5-pro','gemini-2.0-flash','gemini-2.0-flash-lite','gemini-3-flash-preview'],
  openai: ['gpt-4.1','gpt-4.1-mini','gpt-4.1-nano','gpt-4o','gpt-4o-mini','gpt-4.5-preview','o4-mini','o3','o3-mini'],
  deepseek: ['deepseek-v4-flash','deepseek-v4-pro'],
};
writeFileSync(resolve(output, 'fixture.tsx'), `
import React, {useState, useCallback, useEffect, useRef, useMemo, useId} from '${root}/node_modules/react/index.js';
import {createRoot} from '${root}/node_modules/react-dom/client.js';
import {History, Loader2, X, ChevronDown, ChevronRight} from 'lucide-react';
import {LlmModelSelectionPanel} from '${root}/components/shared/LlmModelSelectionPanel';
import {LlmModelMixControls} from '${root}/components/shared/LlmModelMixControls';
import {ModelPickerDialogFrame} from '${root}/components/shared/ModelPickerDialogFrame';
import {threatInputRationale} from '${root}/app/console/dashboard/_components/threatInputRationale';
import {Button} from '${root}/components/ui/button';
import {cn} from '${root}/lib/utils';
const inventory=${JSON.stringify(inventory)};
const catalog=Object.entries(inventory).map(([name,models])=>({name,models,configured:true,model_estimated_cost_inr:Object.fromEntries(models.map(model=>[model,0])),model_compatibility:Object.fromEntries(models.map((model,index)=>[model,{compatible:name!=='anthropic'||index<2,reason:'Unavailable with current API access.'}])),model_last_run_web_search_used:{'gpt-4o-mini':true,'deepseek-v4-flash':true}}));
const MODEL_MIX_STORAGE_KEY='offline-fixture-mixes';
const readSavedModelMixes=()=>[{id:'compatible-models-system',name:'Compatible models',targets:['openai::gpt-4o-mini']}];
const useUsdInrRate=()=>0;
const formatInrCost=value=>typeof value==='number'?'₹'+value.toFixed(2):'n/a';
${stageMetadata}
${extract('getStageLabel')}
const fetchAllFullRuns=async()=>[];
const buildStageLlmHistoryEntries=()=>[];
const normalizeError=error=>String(error);
const Link=props=><a {...props}/>;
const URLs={routes:{console:{runDetail:id=>'/fixture-run/'+id}}};
const getRunOutputStatusClass=()=>'';
const getRunOutputStatusLabel=value=>value;
const formatTimestamp=value=>value;
const formatInrCostFromUsd=()=> 'Unavailable';
${extract('getLlmSelectorScanLabel')}
${extract('getLlmSelectorTitle')}
${extract('StageLlmSelectorDialog')}
const parseTimestampMs=value=>Date.parse(value)||0;
const getInputMarketBadgeClass=()=>'';
const getInputMarketLabel=()=> 'India';
const getInputStatusBadgeClass=()=>'';
const formatUsdAsVerifiedInr=()=> 'Unavailable';
${extract('InputSelectionDialog')}

function App(){
 const [inputOpen,setInputOpen]=useState(false),[ids,setIds]=useState(new Set(['fixture-0']));
 const [open,setOpen]=useState(false),[state,setState]=useState('loaded'),[selected,setSelected]=useState(new Set(['openai::gpt-4o-mini']));
 const providers=state==='empty'||state==='failed'||state==='loading'?[]:catalog;
 return <><main><button id="input-open" onClick={()=>setInputOpen(true)}>Open inputs</button><button id="open" onClick={()=>setOpen(true)}>Open picker</button><select aria-label="Fixture state" value={state} onChange={e=>setState(e.target.value)}>{['loaded','loading','empty','failed','partial'].map(value=><option key={value}>{value}</option>)}</select><p>Offline fixtures only</p></main>
 <InputSelectionDialog open={inputOpen} stage="rebalance" candidates={state==='empty'||state==='failed'||state==='loading'?[]:Array.from({length:40},(_,i)=>({id:'fixture-'+i,jobNo:'Fixture '+i,label:'Saved input '+i,status:i%2?'partial':'completed',source:'saved',timestamp:null}))} selectedIds={ids} usdInrRate={0} loading={state==='loading'} error={state==='failed'?'Fixture input read failed':state==='partial'?'Fixture partial input read':null} onToggle={id=>setIds(old=>{const next=new Set(old);next.has(id)?next.delete(id):next.add(id);return next;})} onToggleAll={()=>{}} onResetDefaults={()=>{}} onClose={()=>setInputOpen(false)}/>
 <StageLlmSelectorDialog open={open} stage="threats" portfolio="zerodha" providers={providers} selectedKeys={selected} selectedMultipliers={{}} onMultiplierChange={()=>{}} onToggle={key=>setSelected(new Set([key]))} onSelectAll={()=>{}} onClear={()=>setSelected(new Set())} onReplaceSelection={setSelected} onResetDefaults={()=>setSelected(new Set(['openai::gpt-4o-mini']))} onClose={()=>setOpen(false)} loading={state==='loading'} error={state==='failed'?'Fixture provider read failed':state==='partial'?'Some provider data is stale; previous catalog retained.':null} onRetry={()=>setState('loaded')}/></>;
}
createRoot(document.getElementById('root')).render(<App/>);
`);
writeFileSync(resolve(output, 'loader.cjs'), `const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(source){return ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText;};`);
await new Promise((yes,no)=>webpack({ mode:'development',entry:resolve(output,'fixture.tsx'),context:root,resolve:{extensions:['.tsx','.ts','.js'],alias:{'@':root},modules:[resolve(root,'node_modules'),'node_modules']},module:{rules:[{test:/\.tsx?$/,use:resolve(output,'loader.cjs')}]},output:{path:output,filename:'fixture.js'},devtool:false},(error,stats)=>error||stats.hasErrors()?no(error||new Error(stats.toString({all:false,errors:true}))):yes()));
const scanner=new Scanner({sources:[{base:root,pattern:'components/shared/*.{ts,tsx}',negated:false},{base:root,pattern:'app/console/dashboard/_components/RebalanceWorkflowSections.tsx',negated:false},{base:root,pattern:'components/ui/button.tsx',negated:false}]});
const compiler=await compile('@import "tailwindcss";',{base:root,onDependency:()=>{}});
writeFileSync(resolve(output,'fixture.css'),compiler.build(scanner.scan()));
writeFileSync(resolve(output,'index.html'),'<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
const server=createServer((req,res)=>{const file=req.url==='/fixture.js'?'fixture.js':req.url==='/fixture.css'?'fixture.css':'index.html';res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(readFileSync(resolve(output,file)));});
await new Promise(yes=>server.listen(0,'127.0.0.1',yes));
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
let checks=0;
try {
 const page=await browser.newPage({viewport:{width:1180,height:757},deviceScaleFactor:1});
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>route.request().url().startsWith('http://127.0.0.1:')?route.continue():route.abort());
 await page.goto('http://127.0.0.1:'+server.address().port);
 const open=async()=>{await page.locator('#open').click();await page.getByRole('dialog').waitFor();};
 const shot=async name=>page.screenshot({path:resolve(output,name+'.png'),fullPage:true});
 await open();
 assert.equal(await page.getByRole('dialog').getByRole('heading',{name:'Threats Scan',exact:true}).count(),1);
 assert.match(await page.getByRole('dialog').innerText(),/Check risks in the economy, sectors, and your holdings/);
 assert.equal(await page.getByRole('tab').count(),6);checks++;
 assert.equal(await page.getByRole('button',{name:'Close LLM selector'}).evaluate(el=>el===document.activeElement),true);checks++;
 assert.equal(await page.getByRole('dialog').getAttribute('aria-modal'),'true');
 assert.equal(await page.locator('main').evaluate(el=>Boolean(el.closest('[inert]'))),true);
 await page.locator('#input-open').evaluate(el=>el.focus());
 assert.equal(await page.getByRole('dialog').evaluate(el=>el.contains(document.activeElement)),true);checks+=3;
 writeFileSync(resolve(output,'model-semantics.json'),JSON.stringify({baseline:await page.evaluate(()=>({innerWidth,innerHeight,devicePixelRatio,visualViewportScale:visualViewport.scale})),snapshot:await page.getByRole('dialog').ariaSnapshot(),labelledby:await page.getByRole('dialog').getAttribute('aria-labelledby'),initialFocus:'Close LLM selector',forwardWrap:'Done → Show LLM run history',reverseWrap:'Show LLM run history → Done'},null,2));
 await shot('desktop-summary');
 const labels={anthropic:'Anthropic',gemini:'Gemini',openai:'OpenAI',deepseek:'DeepSeek'};
 for(const [provider,models] of Object.entries(inventory)){
  await page.getByRole('tab',{name:labels[provider]+' choices',exact:true}).click();
  const inputs=page.getByRole('radio'); assert.equal(await inputs.count(),models.length);checks++;
  for(const model of models) assert.equal(await page.getByText(model,{exact:true}).count(),1);
  if(provider==='anthropic'){assert.equal(await page.locator('input:disabled').count(),6);checks++;}
  await shot('desktop-'+provider);
  await page.locator('input[type=radio]').last().scrollIntoViewIfNeeded();
  const lastModel=await page.locator('input[type=radio]').last().boundingBox();
  const footer=await page.getByRole('button',{name:'Done',exact:true}).boundingBox();
  assert.ok(lastModel.y+lastModel.height<footer.y);checks++;
  await shot('desktop-'+provider+'-end');
 }
 await page.getByRole('tab',{name:'Model mix templates',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'Edit',exact:true}).isDisabled(),true);
 assert.equal(await page.getByRole('button',{name:'Delete',exact:true}).isDisabled(),true);checks+=2;
 await shot('desktop-templates');
 await page.getByRole('tab',{name:'OpenAI choices',exact:true}).click();
 await page.getByRole('searchbox').fill('gpt-4o-mini');assert.equal(await page.getByRole('radio').count(),1);checks++;
 assert.equal(await page.getByRole('radio').isChecked(),true);checks++;
 await page.getByRole('tab',{name:'Gemini choices',exact:true}).click();assert.equal(await page.getByRole('radio').count(),0);checks++;
 await page.getByRole('searchbox').fill('');assert.equal(await page.getByRole('radio').count(),5);checks++;
 await page.getByRole('tab',{name:'OpenAI choices',exact:true}).click();assert.equal(await page.locator('input:checked').count(),1);checks++;
 await page.getByRole('radio').first().check();await page.getByRole('tab',{name:'Selection summary',exact:true}).click();
 await page.getByRole('tab',{name:'OpenAI choices',exact:true}).click();assert.equal(await page.getByRole('radio').first().isChecked(),true);checks++;
 await page.getByRole('tab',{name:'Selection summary',exact:true}).focus();await page.keyboard.press('ArrowRight');assert.equal(await page.getByRole('tab',{name:'Anthropic choices',exact:true}).getAttribute('aria-selected'),'true');checks++;
 await page.keyboard.press('End');assert.equal(await page.getByRole('tab',{name:'Model mix templates',exact:true}).getAttribute('aria-selected'),'true');checks++;
 await page.getByRole('button',{name:'Done',exact:true}).focus();await page.keyboard.press('Tab');assert.equal(await page.getByRole('button',{name:/Show LLM run history/}).evaluate(el=>el===document.activeElement),true);checks++;
 await page.keyboard.press('Shift+Tab');assert.equal(await page.getByRole('button',{name:'Done',exact:true}).evaluate(el=>el===document.activeElement),true);checks++;
 await page.getByRole('button',{name:/Show LLM run history/}).click();
 await page.getByText('No prior LLM jobs were found for this stage.',{exact:true}).waitFor();checks++;
 await shot('desktop-history-empty');
 await page.keyboard.press('Escape');assert.equal(await page.locator('#open').evaluate(el=>el===document.activeElement),true);checks++;
 for(const state of ['loading','empty','failed','partial']){
  await page.getByRole('combobox',{name:'Fixture state'}).selectOption(state);await open();await shot('desktop-'+state);
  if(state==='loading')assert.match(await page.getByRole('dialog').innerText(),/Loading provider models/);
  if(state==='empty')assert.match(await page.getByRole('dialog').innerText(),/No provider models/);
  if(state==='failed')assert.match(await page.getByRole('dialog').innerText(),/Fixture provider read failed/);
  if(state==='partial')assert.match(await page.getByRole('dialog').innerText(),/previous catalog retained/);
  checks++;await page.getByRole('button',{name:'Close LLM selector'}).click();
 }
 await page.getByRole('combobox',{name:'Fixture state'}).selectOption('loaded');
 await page.setViewportSize({width:390,height:844});await open();await shot('narrow-summary');
 for(const provider of Object.keys(inventory)){
  await page.getByRole('tab',{name:labels[provider]+' choices',exact:true}).click();
  const dialog=page.getByRole('dialog');assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth),true);checks++;
  const box=await page.getByRole('button',{name:'Done',exact:true}).boundingBox();assert.ok(box.y+box.height<=844);checks++;
  await shot('narrow-'+provider);
  await page.locator('input[type=radio]').last().scrollIntoViewIfNeeded();
  const lastModel=await page.locator('input[type=radio]').last().boundingBox();
  const footer=await page.getByRole('button',{name:'Done',exact:true}).boundingBox();
  assert.ok(lastModel.y+lastModel.height<footer.y);checks++;
  await shot('narrow-'+provider+'-end');
 }
 await page.getByRole('tab',{name:'Model mix templates',exact:true}).click();await shot('narrow-templates');
 await page.keyboard.press('Escape');await open();await page.getByRole('button',{name:'Done',exact:true}).click();assert.equal(await page.getByRole('dialog').count(),0);checks++;
 await page.setViewportSize({width:320,height:757});await open();
 await page.getByRole('tab',{name:'Anthropic choices',exact:true}).click();
 assert.equal(await page.getByRole('dialog').evaluate(el=>el.scrollWidth<=el.clientWidth),true);checks++;
 await shot('narrow-320-anthropic');
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('main').evaluate(el=>el.closest('[inert]')===null),true);checks++;
 await page.setViewportSize({width:1180,height:757});
 const focusEvidence=[];
 for(const state of ['loaded','loading','empty','failed','partial']){
  await page.getByRole('combobox',{name:'Fixture state'}).selectOption(state);
  await page.locator('#input-open').click();
  const dialog=page.getByRole('dialog',{name:'Select Rebalance Scan inputs',exact:true});
  await dialog.waitFor();
  assert.equal(await dialog.getAttribute('aria-modal'),'true');
  assert.equal(await page.getByRole('button',{name:'Close input selection'}).evaluate(el=>el===document.activeElement),true);
  assert.equal(await page.locator('main').evaluate(el=>Boolean(el.closest('[inert]'))),true);
  await page.locator('#open').evaluate(el=>el.focus());
  assert.equal(await dialog.evaluate(el=>el.contains(document.activeElement)),true);
  await page.getByRole('button',{name:'Done',exact:true}).focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.getByRole('button',{name:'Close input selection'}).evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.getByRole('button',{name:'Done',exact:true}).evaluate(el=>el===document.activeElement),true);
  if(state==='loaded'){
   const selected=page.getByRole('checkbox',{name:'Select all LLM jobs in Fixture 0',exact:true});
   assert.equal(await selected.isChecked(),true);
   await selected.focus(); await page.keyboard.press('Space'); assert.equal(await selected.isChecked(),false);
   await page.getByRole('checkbox',{name:'Select all LLM jobs in Fixture 39',exact:true}).scrollIntoViewIfNeeded();
  }
  await shot('input-desktop-'+state);
  focusEvidence.push({state,role:await dialog.getAttribute('role'),labelledby:await dialog.getAttribute('aria-labelledby'),snapshot:await dialog.ariaSnapshot(),sequence:['Open inputs','Close input selection','Done','Tab → Close input selection','Shift+Tab → Done','Escape → Open inputs']});
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#input-open').evaluate(el=>el===document.activeElement),true);
  checks+=8;
 }
 for(const width of [390,320]){
  await page.setViewportSize({width,height:844});
  await page.getByRole('combobox',{name:'Fixture state'}).selectOption('loaded');
  await page.locator('#input-open').click();
  const dialog=page.getByRole('dialog');
  assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  await shot('input-narrow-'+width);
  await page.getByRole('button',{name:'Close input selection'}).click();
  assert.equal(await page.locator('#input-open').evaluate(el=>el===document.activeElement),true); checks+=2;
 }
 writeFileSync(resolve(output,'input-focus-evidence.json'),JSON.stringify(focusEvidence,null,2));
 assert.deepEqual(errors,[]);checks++;
 writeFileSync(resolve(output,'results.json'),JSON.stringify({checks,errors,inventory,viewport:{desktop:[1180,757],narrow:[390,844]},source:'real StageLlmSelectorDialog extracted with offline history/FX fixtures; real panel, frame and template controls'},null,2));
 console.log(JSON.stringify({checks,output,errors}));
}finally{await browser.close();server.close();}

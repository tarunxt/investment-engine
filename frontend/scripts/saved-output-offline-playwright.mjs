#!/usr/bin/env node
/** Offline acceptance of the production saved-output loader and dialog. No production calls. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { chromium } from 'playwright';
const require = createRequire(import.meta.url);
const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'saved-output-fixture-'));
const source = await readFile(path.join(frontend, 'app/console/dashboard/_components/RebalanceWorkflowSections.tsx'), 'utf8');
const start = source.indexOf('  const showStageOutput = useCallback(');
const end = source.indexOf('  useEffect(() => {\n    const handleOpenStageOutput', start);
assert.ok(start > 0 && end > start);
const loader = source.slice(start, end);
const tileAst = ts.createSourceFile('tile.tsx', await readFile(path.join(frontend, 'components/shared/WorkflowStageTile.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const stageMetadata = tileAst.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(tileAst) === 'STAGE_METADATA')).getText(tileAst).replace(/^export /, '');
const entry = `import React,{useState,useRef,useCallback} from 'react';
import {createRoot} from 'react-dom/client';
import {SavedOutputDialog} from ${JSON.stringify(path.join(frontend,'components/shared/SavedOutputDialog.tsx'))};
${stageMetadata}
const getStageOutputRoute=(portfolio,stage)=>'/console/'+portfolio+'/'+stage;
const normalizeError=e=>e.message;
const getLatestRunTimestamp=run=>run.updated_at;
const sortRunsByLatestTimestamp=runs=>runs;
const isCompletedRebalanceRun=(run,market)=>run.market===market;
const isAnalysisRunForStage=()=>true,isTechnicalScanRun=()=>true;
const getRunOutputSummary=()=>'',getRunOutputDisplayLabel=()=>'';
window.fixture={mode:'success',delay:0};window.calls=[];
const read=async portfolio=>{window.calls.push(portfolio);const mode=window.fixture.mode,delay=window.fixture.delay;await new Promise(r=>setTimeout(r,delay));if(mode==='failed')throw Error('Saved output request failed (403)');return {analysis:mode==='empty'?null:{job_id:71,status:mode==='jobfailed'?'failed':'completed',provider:'fixture',model:'offline',created_at:'2026-10-30T10:00:00Z',updated_at:'2026-10-31T12:00:00Z',error_message:mode==='jobfailed'?'Saved job failed':null,report:mode==='jobfailed'?null:mode==='structured'?{tables:[{title:'Saved risk table'}]}:{raw_markdown:'Saved threat report for '+portfolio+' <script>window.executed=true</script>'}}};};
const apiService={zerodhaThreatsLatest:()=>read('zerodha'),indmoneyUsThreatsLatest:()=>read('indmoneyUs'),zerodhaPortfolioOverview:async()=>({latest:null}),indmoneyUsPortfolioOverview:async()=>({latest:null})};
const fetchAllFullRuns=async()=>[{id:17,market:'india',updated_at:'2026-10-30T00:00:00Z',run_jobs:[]}];
function App(){const [outputDialog,setOutputDialog]=useState(null);const outputRequestRef=useRef(0);
${loader}
const close=()=>{outputRequestRef.current++;setOutputDialog(null)};
return <><button onClick={()=>showStageOutput('zerodha','threats')}>Open India</button><button onClick={()=>showStageOutput('indmoneyUs','threats')}>Open US</button><button onClick={()=>showStageOutput('zerodha','sync')}>Open Sync</button><button onClick={()=>showStageOutput('zerodha','rebalance',17)}>Open Historical</button><button onClick={()=>showStageOutput('indmoneyUs','rebalance',17)}>Wrong Market</button>
{outputDialog&&<SavedOutputDialog {...outputDialog} onClose={close} onRetry={()=>showStageOutput(outputDialog.portfolio,outputDialog.stage,outputDialog.requestedRunId)}><div>{outputDialog.loading?<p role='status'>Loading output…</p>:outputDialog.error?<p role='alert'>{outputDialog.error}</p>:<pre>{outputDialog.body}</pre>}</div></SavedOutputDialog>}</>};createRoot(document.getElementById('root')).render(<App/>);`;
let browser, server;
try {
  await writeFile(path.join(temporary,'entry.tsx'),entry);
  await writeFile(path.join(temporary,'loader.cjs'),`const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(s){return ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020},fileName:this.resourcePath}).outputText;};`);
  const w=require('next/dist/compiled/webpack/webpack');
  await new Promise((resolve,reject)=>w.webpack({mode:'development',devtool:false,entry:path.join(temporary,'entry.tsx'),output:{path:temporary,filename:'bundle.js'},resolve:{extensions:['.tsx','.ts','.js'],modules:[path.join(frontend,'node_modules'),'node_modules']},module:{rules:[{test:/\.tsx?$/,use:path.join(temporary,'loader.cjs')}]},plugins:[new w.webpack.DefinePlugin({'process.env.NODE_ENV':JSON.stringify('development')})]},(e,s)=>e?reject(e):s.hasErrors()?reject(new Error(s.toString({all:false,errors:true}))):resolve()));
  const postcss=require('postcss'),tailwind=require('@tailwindcss/postcss');
  const css=(await postcss([tailwind({base:frontend})]).process('@import "tailwindcss";',{from:path.join(frontend,'app/globals.css')})).css;
  const bundle=await readFile(path.join(temporary,'bundle.js'));
  server=createServer((req,res)=>{if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');return res.end(bundle)}res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}body{font:16px sans-serif}</style><div id="root"></div><script src="/bundle.js"></script>`)});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
  const context=await browser.newContext();
  const external=[];
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){external.push(route.request().url());return route.abort()}return route.continue()});
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin);
  const dialog=page.getByRole('dialog');const close=page.getByRole('button',{name:'Close output view'});
  await page.evaluate(()=>window.fixture.delay=1000);
  await page.getByText('Open India',{exact:true}).click();await page.getByRole('status').waitFor();
  assert.equal(await page.getByText('Retry saved output',{exact:true}).isDisabled(),true);
  await dialog.getByText(/Saved threat report for zerodha/).waitFor();
  assert.match(await dialog.textContent(),/Threats Scan Output/);
  assert.match(await dialog.textContent(),/Job #71 · fixture\/offline · completed/);
  assert.equal(await dialog.locator('time').getAttribute('datetime'),'2026-10-31T12:00:00Z');
  assert.equal(await page.locator('iframe').count(),0);assert.equal(await page.evaluate(()=>window.executed),undefined);
  const link=dialog.getByRole('link');assert.equal(await link.getAttribute('target'),'_blank');assert.equal(await link.getAttribute('rel'),'noopener noreferrer');assert.equal(await link.getAttribute('href'),'/console/zerodha/threats');
  assert.equal(await close.evaluate(e=>e===document.activeElement),true);
  assert.equal(await page.locator('#root').evaluate(e=>e.inert),true);
  await page.keyboard.press('Tab');assert.equal(await page.getByText('Retry saved output',{exact:true}).evaluate(e=>e===document.activeElement),true);
  await page.keyboard.press('Shift+Tab');assert.equal(await close.evaluate(e=>e===document.activeElement),true);
  await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});assert.equal(await page.locator('#root').evaluate(e=>e.inert),false);assert.equal(await page.getByText('Open India',{exact:true}).evaluate(e=>e===document.activeElement),true);
  for(const mode of ['empty','failed','jobfailed','structured']){
    await page.evaluate(mode=>{window.fixture={mode,delay:0}},mode);
    await page.getByText('Open US',{exact:true}).click();
    const text={empty:'No saved threat output is available yet.',failed:'Saved output request failed (403)',jobfailed:'Saved job failed',structured:'Saved risk table'}[mode];
    await dialog.getByText(text,{exact:mode!=='structured'}).waitFor();
    if(mode==='jobfailed')assert.equal(await dialog.locator('time').count(),1);
    if(mode==='failed'){
      await page.evaluate(()=>window.fixture.mode='success');await page.getByText('Retry saved output',{exact:true}).click();await dialog.getByText(/Saved threat report for indmoneyUs/).waitFor();
    }
    await close.click();await dialog.waitFor({state:'detached'});
  }
  await page.getByText('Open Historical',{exact:true}).click();await dialog.getByText('Run #17',{exact:true}).waitFor();
  await page.getByText('Retry saved output',{exact:true}).click();await dialog.getByText('Run #17',{exact:true}).waitFor();await close.click();
  await page.getByText('Wrong Market',{exact:true}).click();await dialog.getByText('No saved LLM output is available yet.').waitFor();assert.equal(await dialog.getByText('Run #17',{exact:true}).count(),0);await close.click();
  await page.getByText('Open Sync',{exact:true}).click();await dialog.getByText('No saved portfolio snapshot is available yet.').waitFor();await close.click();
  await page.evaluate(()=>window.fixture={mode:'success',delay:500});await page.getByText('Open India',{exact:true}).click();await page.getByRole('status').waitFor();await close.click();
  await page.evaluate(()=>window.fixture={mode:'empty',delay:0});await page.getByText('Open US',{exact:true}).click();await dialog.getByText('No saved threat output is available yet.').waitFor();
  await page.waitForTimeout(650);assert.match(await dialog.textContent(),/INDmoney US/);assert.match(await dialog.textContent(),/No saved threat output/);
  await close.click();await page.waitForTimeout(50);assert.equal(await dialog.count(),0);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  const artifact=process.env.SAVED_OUTPUT_ARTIFACT_DIR||'/tmp/saved-output-evidence';await mkdir(artifact,{recursive:true});
  await page.evaluate(()=>window.fixture={mode:'success',delay:0});await page.getByText('Open India',{exact:true}).click();await dialog.getByText(/Saved threat report for zerodha/).waitFor();await page.screenshot({path:path.join(artifact,'saved-output-success.png')});
  const result={result:'PASS',checks:['loading','success','confirmed-empty','403-failure','retry','saved-job-failure','structured-report','timestamp-and-provenance','escaped-output','safe-new-tab-link','keyboard-close','focus-cycle-and-restore','repeated-open','late-response-does-not-reopen-or-replace','snapshot-empty','historical-run-retry-preserves-id','historical-run-market-filter'],externalRequests:external,errors};
  await writeFile(path.join(artifact,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
} finally {await browser?.close();if(server)await new Promise(r=>server.close(r));await rm(temporary,{recursive:true,force:true});}

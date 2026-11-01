// Actual modal + shared execution source reader. Synthetic saved reads only.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {chromium} from 'playwright';
const require=createRequire(import.meta.url);
const {build}=require(process.env.AUDIT7_ESBUILD_PATH||'/tmp/a7-build/node_modules/esbuild');
const workflow=await readFile('app/console/dashboard/_components/RebalanceWorkflowSections.tsx','utf8');
for(const contract of ['loadSnapshot={readLatestIndmoneySnapshot}','readIndmoneySnapshotSource(readLatestIndmoneySnapshot, savedSnapshot)','expected_snapshot_id: workflowSnapshot.id'])assert.ok(workflow.includes(contract));
const bridge=workflow.slice(workflow.indexOf('  const handleIndMoneyContinue = useCallback('),workflow.indexOf('  const lastRunByPortfolio = useMemo('));
const fixture=`import React,{useState,useCallback}from'react';import{createRoot}from'react-dom/client';import{IndMoneySnapshotDialog}from'./app/console/dashboard/_components/IndMoneySnapshotDialog';import{readIndmoneySnapshotSource}from'./lib/indmoneySnapshotSource';
window.requests=[];window.starts=[];window.consumed=[];window.executionErrors=[];
const load=()=>new Promise((resolve,reject)=>window.requests.push({resolve,reject}));
function App(){const[open,setDialogOpen]=useState(true);const[indMoneySyncOnly,setIndMoneySyncOnly]=useState(false);const setDialogError=()=>{};
const runWorkflow=async(portfolio,payload,source)=>{window.starts.push({portfolio,mode:payload?'paste':'reuse',payload,source});if(payload){window.consumed.push({mode:'paste',payload});return;}try{const actual=await readIndmoneySnapshotSource(load,source);window.consumed.push({id:actual.id,captured_at:actual.captured_at,holdings:actual.holdings});}catch(error){window.executionErrors.push(error.message);}};
const syncPortfolioNow=runWorkflow;
${bridge}
return <><button onClick={()=>setDialogOpen(true)}>Reopen</button><IndMoneySnapshotDialog open={open} saving={false} error={null} loadSnapshot={load} onClose={()=>setDialogOpen(false)} onContinue={handleIndMoneyContinue}/></>};createRoot(document.getElementById('app')).render(<App/>);`;
const bundle=await build({stdin:{contents:fixture,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,platform:'browser',jsx:'automatic'});
const snapshot=(id=87,overrides={})=>({id,captured_at:'2026-11-01T08:28:10.767Z',parse_status:'parsed',reported_holdings_count:1,holdings:[{symbol:'SYNTH',quantity:0}],wallet_balance:0,...overrides});
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
const errors=[],results=[];
async function start(timezoneId='UTC'){
 const context=await browser.newContext({timezoneId,viewport:{width:390,height:844}}),page=await context.newPage();
 page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>{errors.push('Unexpected network request');return r.abort();});
 await page.setContent('<div id="app"></div>');await page.addScriptTag({content:bundle.outputFiles[0].text});await page.waitForFunction(()=>window.requests.length===1);return{page,context};
}
async function reply(page,index,latest,error){await page.waitForFunction(i=>window.requests.length>i,index);await page.evaluate(({index,latest,error})=>error?window.requests[index].reject(new Error(error)):window.requests[index].resolve({latest,history:[]}),{index,latest,error});}
const button=p=>p.getByRole('button',{name:'Continue Rebalance'});
async function reuse(p){await p.getByRole('radio').nth(1).check();await button(p).click();}
try{
 for(const timezone of ['UTC','America/New_York']){
  const{page,context}=await start(timezone);await page.getByText('Loading saved snapshot…').waitFor();assert.equal(await page.getByRole('radio').nth(1).isDisabled(),true);
  await reply(page,0,snapshot());await page.getByText(/Snapshot #87 · Captured: 1 Nov 2026, 1:58:10 pm IST/).waitFor();assert.doesNotMatch(await page.locator('body').innerText(),/Historical workflow|28 Oct/);
  await reuse(page);assert.equal(await button(page).isDisabled(),true);await reply(page,1,snapshot());await reply(page,2,snapshot());await page.waitForFunction(()=>window.consumed.length===1);
  const data=await page.evaluate(()=>({start:window.starts[0],consumed:window.consumed[0]}));assert.equal(data.start.source.id,data.consumed.id);assert.equal(data.start.source.captured_at,data.consumed.captured_at);assert.deepEqual(data.consumed.holdings,snapshot().holdings);assert.equal(data.start.source.wallet_balance,0);
  results.push(`label/execution agreement and zero preserved: ${timezone}`);await context.close();
 }
 {
  const{page,context}=await start();await reply(page,0,snapshot());await page.getByText(/Snapshot #87/).waitFor();await reuse(page);
  const newer=snapshot(88,{captured_at:'2026-11-01T09:00:00Z'});await reply(page,1,newer);await page.getByText(/Snapshot #88/).waitFor();await page.getByRole('alert').filter({hasText:'saved snapshot changed'}).waitFor();assert.equal(await page.evaluate(()=>window.starts.length),0);
  await button(page).click();await reply(page,2,newer);await reply(page,3,newer);await page.waitForFunction(()=>window.consumed.length===1);assert.equal(await page.evaluate(()=>window.consumed[0].id),88);results.push('newer response requires review and repeat confirmation');await context.close();
 }
 {
  const{page,context}=await start();await reply(page,0,snapshot());await page.getByText(/Snapshot #87/).waitFor();await reuse(page);await reply(page,1,snapshot());await reply(page,2,snapshot(89));await page.waitForFunction(()=>window.executionErrors.length===1);assert.equal(await page.evaluate(()=>window.consumed.length),0);results.push('execution preflight rejects source changed after confirmation');await context.close();
 }
 for(const[name,latest,error]of[
  ['missing',null],['missing identity',snapshot(0)],['missing capture',snapshot(87,{captured_at:null})],['invalid capture',snapshot(87,{captured_at:'invalid'})],['partial',snapshot(87,{reported_holdings_count:2})],['unparsed',snapshot(87,{parse_status:'unparsed'})],['unknown quantity',snapshot(87,{holdings:[{symbol:'SYNTH',quantity:null}]})],['read error',null,'Synthetic unavailable']
 ]){
  const{page,context}=await start();await reply(page,0,latest,error);await page.getByText('Saved snapshot unavailable').waitFor();assert.equal(await page.getByRole('radio').nth(1).isDisabled(),true);await page.locator('textarea').fill('synthetic manual paste');await button(page).click();await page.waitForFunction(()=>window.consumed.length===1);const paste=await page.evaluate(()=>window.consumed[0]);assert.equal(paste.mode,'paste');assert.equal(paste.payload.raw_text,'synthetic manual paste');assert.ok(Number.isFinite(Date.parse(paste.payload.captured_at)));results.push(`${name}: reuse blocked; paste preserved`);await context.close();
 }
 {
  const{page,context}=await start();await page.getByRole('button',{name:'Cancel'}).click();await page.getByRole('button',{name:'Reopen'}).click();await page.waitForFunction(()=>window.requests.length===2);await reply(page,1,snapshot(90));await page.getByText(/Snapshot #90/).waitFor();await reply(page,0,snapshot(87));assert.match(await page.locator('body').innerText(),/Snapshot #90/);assert.doesNotMatch(await page.locator('body').innerText(),/Snapshot #87/);
  await reuse(page);await page.getByRole('button',{name:'Cancel'}).click();await reply(page,2,snapshot(90));await page.getByRole('button',{name:'Reopen'}).click();await reply(page,3,snapshot(91));await page.getByText(/Snapshot #91/).waitFor();assert.equal(await page.evaluate(()=>window.starts.length),0);results.push('cancel/reopen ignores interrupted and out-of-order reads');await context.close();
 }
 {
  const{page,context}=await start();await reply(page,0,snapshot());await page.getByText(/Snapshot #87/).waitFor();await reuse(page);await reply(page,1,null,'Synthetic verification failure');await page.getByText('Saved snapshot unavailable').waitFor();assert.equal(await button(page).isDisabled(),true);assert.equal(await page.evaluate(()=>window.starts.length),0);await page.getByRole('button',{name:'Cancel'}).click();await page.getByRole('button',{name:'Reopen'}).click();await reply(page,2,snapshot(92));await page.getByText(/Snapshot #92/).waitFor();results.push('verification error clears stale source; reopen recovers');await context.close();
 }
 assert.deepEqual(errors,[]);console.log(`PASS ${results.length} actual modal/source-reader scenarios\n${results.join('\n')}`);
}finally{await browser.close();}

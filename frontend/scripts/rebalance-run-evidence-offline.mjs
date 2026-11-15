/** Render the production ledger with synthetic stages; no application API calls. */
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {buildSync} from 'esbuild';
import {chromium} from 'playwright';
const require=createRequire(import.meta.url), root=process.cwd(), temp=mkdtempSync(path.join(tmpdir(),'run-evidence-'));
let browser;
try {
  buildSync({stdin:{contents:`import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
    import {WorkflowStageLedger} from './components/shared/WorkflowStageLedger';
    import {WorkflowStageTile,STAGE_ORDER} from './components/shared/WorkflowStageTile';
    export function render(active, states){return renderToStaticMarkup(<WorkflowStageLedger active={active} enabled market="zerodha" historyHref="#history" onStockFlowClick={()=>{}}>{STAGE_ORDER.map(stage=><WorkflowStageTile key={stage} stage={stage} info={states[stage]??{state:'idle'}} now={Date.parse('2026-11-15T08:10:00Z')} onClick={()=>{}} />)}</WorkflowStageLedger>);}`,
    resolveDir:root,loader:'tsx'},bundle:true,platform:'node',format:'cjs',outfile:path.join(temp,'fixture.cjs'),alias:{'@':root},jsx:'automatic',logLevel:'error'});
  const {render}=require(path.join(temp,'fixture.cjs'));
  browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const page=await browser.newPage();
  await page.route('**/*',route=>route.abort());
  const old={state:'idle',completedAt:'2026-11-14T08:00:00Z',error:'Previous failure',recommendedStocks:99,portfolioStockCount:99,evidence:{kind:'saved',references:['Previous run #123']}};
  const states={sync:{state:'completed',portfolioStockCount:7,completedAt:'2026-11-15T08:01:00Z'},threats:{...old,state:'queued'},swing:{...old},rebalance:{...old},technical:{...old},actionables:{...old}};
  const blankUpcoming=async()=>{for(const row of await page.locator('tbody tr').all()){const state=await row.locator('th').innerText();if(/idle|queued/.test(state))for(const cell of await row.locator('td').all())assert.equal((await cell.innerText()).trim(),'');}};
  await page.setContent(render(true,states));await blankUpcoming();
  assert.equal((await page.locator('body').innerText()).includes('Previous failure'),false);
  states.swing={state:'failed',lastRunId:301,error:'Current synthetic failure',startedAt:'2026-11-15T08:02:00Z',endedAt:'2026-11-15T08:03:00Z'};
  await page.setContent(render(true,states));await blankUpcoming();assert.match(await page.locator('body').innerText(),/Stage execution failed/);
  await page.setContent(render(false,{swing:old}));assert.match(await page.locator('body').innerText(),/Historical saved evidence/);assert.match(await page.locator('body').innerText(),/Stage execution failed/);
  for(const width of [390,1180]){await page.setViewportSize({width,height:900});await page.setContent(render(true,states));await blankUpcoming();}
  console.log('PASS actual ledger browser rendering: blank upcoming cells including shared Threats count, current failure, historical idle evidence, mobile/desktop; zero API calls');
} finally {await browser?.close();rmSync(temp,{recursive:true,force:true});}

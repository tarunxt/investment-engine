import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';
import ts from 'typescript';
const require=createRequire(import.meta.url);
function load(relative, names=[], bindings={}) {
  const source=readFileSync(new URL(relative,import.meta.url),'utf8');
  const ast=ts.createSourceFile(relative,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const nodes=ast.statements.filter(n=>!ts.isImportDeclaration(n)&&(!names.length||(ts.isFunctionDeclaration(n)&&names.includes(n.name?.text))||(ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>names.includes(d.name.getText(ast))))));
  const code=ts.transpileModule(nodes.map(n=>n.getText(ast)).join('\n')+(names.length?'\nexport {'+names.join(',')+'};':''),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const module={exports:{}};new Function('require','exports','module',...Object.keys(bindings),code)(require,module.exports,module,...Object.values(bindings));return module.exports;
}
const date=load('../lib/datetime.ts');
const workflowPath='../components/shared/WorkflowStageTile.tsx';
const ui=load(workflowPath,['stageErrorRows','getStageOutcome','hasStagePartialOutput','stageTileBorder','formatLlmCompletion','formatRecommendedStockProgress','getLlmStageTileRows','getActionablesStageTileRows','getIdleStageRows','LLM_STAGE_TILE_KEYS','formatBriefTileError','getStageTileError','getTileErrorDetail','isSheetExportError','isInsufficientBalanceError'],{formatCompactStageTime:date.formatCompactStageTime,formatDuration:()=>null,formatRebalanceCost:load('../lib/rebalanceCost.ts').formatRebalanceCost});

test('Kite board shows synced holdings and the shared Rebalance count alongside independent score coverage', () => {
  const cards = load('../lib/independentScorecards.ts', ['cards','isCard']);
  const { kiteBoardRows } = load('../components/shared/WorkflowStageLedger.tsx', ['kiteBoardRows'], {
    isCard: cards.isCard, getIdleStageRows: ui.getIdleStageRows,
  });
  const rebalance = {state:'completed', workflowSequence:244, recommendedStocks:16};
  const values = (stage, info, source = rebalance) => Object.fromEntries(
    kiteBoardRows({stage, info, now:0}, source).map(row => [row.label, row.value]),
  );
  for (const count of [29, 0, null]) {
    assert.equal(values('sync', {portfolioStockCount:count})['Stocks synced'], String(count ?? 'n/a'));
  }
  for (const stage of cards.cards) {
    const info = {state:'failed', workflowSequence:244, recommendedStocks:0, evidenceCoverage:'0/16 scored', error:'Provider timeout'};
    const rows = values(stage, info);
    assert.equal(rows['Stocks recommended'], '16');
    assert.equal(rows['Score coverage'], '0/16 scored');
    assert.equal(rows.Error, 'Request timed out');
    assert.equal(values(stage, info, {...rebalance, recommendedStocks:0})['Stocks recommended'], '0');
    assert.equal(values(stage, info, {...rebalance, workflowSequence:243})['Stocks recommended'], 'n/a');
    assert.equal(values(stage, info, {...rebalance, recommendedStocks:null})['Stocks recommended'], 'n/a');
  }
  assert.equal(values('swing', {recommendedStocks:9})['Stocks recommended'], '9');
});

test('stage timestamp matches requested IST 24-hour examples and preserves offset/naive-UTC parsing',()=>{
  assert.equal(date.formatCompactStageTime('2026-10-30T14:07:01Z'),'30 Oct 19:37');
  assert.equal(date.formatCompactStageTime('2026-10-30T14:13:52Z'),'30 Oct 19:43');
  assert.equal(date.formatCompactStageTime('2026-10-30 14:07:01'),'30 Oct 19:37');
  assert.equal(date.formatCompactStageTime('2026-10-30T19:37:01+05:30'),'30 Oct 19:37');
  assert.equal(date.formatCompactQuoteTime('2026-10-30T14:07:01Z'),'30 Oct: 19:37:01 IST');
  assert.match(date.formatApiTimestamp('2026-10-30T14:07:01Z'),/2026/);
});
test('stage timestamp handles local midnight, date/year/leap boundaries and absent/invalid dates',()=>{
  assert.equal(date.formatCompactStageTime('2026-12-31T18:30:59Z'),'01 Jan 00:00');
  assert.equal(date.formatCompactStageTime('2024-02-28T18:30:00Z'),'29 Feb 00:00');
  assert.equal(date.formatCompactStageTime('2026-10-30T18:29:59Z'),'30 Oct 23:59');
  for(const value of [null,undefined,'','invalid'])assert.equal(date.formatCompactStageTime(value),'Not available');
});
test('requested LLM examples count passed only, omit zero categories and retain nonzero failures',()=>{
  assert.equal(ui.formatLlmCompletion({totalLlms:2,completedLlms:2,passedLlms:2,partialLlms:0,failedLlms:0}),'2/2 (Passed:2)');
  assert.equal(ui.formatLlmCompletion({totalLlms:2,completedLlms:2,passedLlms:1,partialLlms:1,failedLlms:0}),'1/2 (Passed:1, Partial:1)');
  assert.equal(ui.formatLlmCompletion({totalLlms:3,completedLlms:3,passedLlms:1,partialLlms:1,failedLlms:1}),'1/3 (Passed:1, Partial:1, Failed:1)');
  assert.equal(ui.formatLlmCompletion({totalLlms:2,completedLlms:2,partialLlms:0,failedLlms:2}),'0/2 (Passed:0, Failed:2)');
  assert.equal(ui.formatLlmCompletion({totalLlms:2,completedLlms:2,partialLlms:2,failedLlms:0}),'0/2 (Passed:0, Partial:2)');
});
test('zero, unfinished and missing counts never become fabricated passes or hide known failures',()=>{
  assert.equal(ui.formatLlmCompletion({totalLlms:0}),'0/0 (Passed:0)');
  assert.equal(ui.formatLlmCompletion({}),'Not available');
  assert.equal(ui.formatLlmCompletion({totalLlms:2}),'?/2 (Passed:?, Unresolved:2)');
  assert.equal(ui.formatLlmCompletion({totalLlms:2,completedLlms:0}),'0/2 (Passed:0, Unresolved:2)');
  assert.equal(ui.formatLlmCompletion({totalLlms:2,passedLlms:1,partialLlms:0,failedLlms:0}),'1/2 (Passed:1, Unresolved:1)');
  assert.equal(ui.formatLlmCompletion({failedLlms:1}),'?/? (Passed:?, Failed:1)');
  assert.equal(ui.formatLlmCompletion({totalLlms:NaN,passedLlms:-1,failedLlms:1}),'?/? (Passed:?, Failed:1)');
});
test('every Stage tile adapter shares compact timestamps, count-only recommendations and unchanged error/partial evidence',()=>{
  const info={state:'completed',completedAt:'2026-10-30T14:07:01Z',startedAt:'2026-10-29T14:00:00Z',totalLlms:2,completedLlms:2,passedLlms:1,partialLlms:1,failedLlms:0,recommendedStocks:7,error:'Provider timeout',partialNotice:'One output is partially used'};
  const before=structuredClone(info);
  for(const portfolio of ['Zerodha','INDmoney'])for(const stage of ['sync','threats','swing','rebalance','technical','actionables']){
    const rows=ui.getIdleStageRows(stage,info,0);
    assert.equal(rows[0].value,'30 Oct 19:37',portfolio+' '+stage);
    if(stage!=='sync'){
      assert.equal(rows.find(r=>r.label==='Stocks recommended').value,'7');
      assert.equal(rows.find(r=>r.label==='Error').value,'Request timed out');
      assert.match(rows.find(r=>r.label==='Error').detail,/Provider timeout/);
      assert.match(rows.find(r=>r.label==='Error').detail,/One output is partially used/);
      assert.equal(rows.some(r=>r.label==='Partial use'),false);
    }
  }
  assert.deepEqual(info,before);
  for(const value of [null,undefined])assert.equal(ui.formatRecommendedStockProgress({recommendedStocks:value}),'n/a');
  assert.equal(ui.formatRecommendedStockProgress({recommendedStocks:0}),'0');
  const source=readFileSync(new URL('../app/console/dashboard/_components/RebalanceWorkflowSections.tsx',import.meta.url),'utf8');
  assert.match(source,/Last\/Current run.*:\{" "\}\s*\{formatCompactStageTime\(lastRunByPortfolio\[section.portfolio\]\)\}/);
});

test('every stage combines partial and error details in a single concise Error row without changing evidence', () => {
  for (const stage of ['sync','threats','swing','rebalance','technical','actionables']) {
    const info={state:'failed',runStatus:'partial',partialLlms:1,error:'  Provider timeout: original long request diagnostic\nwith second line  ',partialNotice:'Original partial notice with available rows.',errorDetails:[{provider:'test',model:'test',jobId:3,runId:7,message:'original provider exception'}]};
    const before=structuredClone(info);
    const rows=ui.getIdleStageRows(stage,info,0), errors=rows.filter(row=>row.label==='Error');
    assert.equal(errors.length,1); assert.equal(rows.some(row=>row.label==='Partial use'),false);
    assert.equal(errors[0].value,'Request timed out');
    assert.equal(errors[0].detail, info.error+'\n\n'+info.partialNotice);
    assert.deepEqual(errors[0].errorDetails,info.errorDetails); assert.deepEqual(info,before);
    const partial=ui.getStageTileError({state:'completed',partialNotice:'LLM output is partially used: long original explanation.'});
    assert.equal(partial.value,'LLM output partial'); assert.match(partial.detail,/long original explanation/);
  }
  assert.equal(ui.getStageTileError({state:'idle'}).value,'-');
  assert.equal(ui.getStageTileError({state:'completed',error:'None'}).value,'-');
  assert.equal(ui.getStageTileError({state:'completed',runStatus:'partial'}).value,'LLM output partial');
  assert.match(ui.getStageTileError({state:'failed',errorDetails:[{message:'only diagnostic'}]}).detail,/only diagnostic/);
  for (const message of ['quota exceeded','Insufficient balance','authentication failed','invalid output contract','cancelled','unclassified failure']) {
    const words=ui.formatBriefTileError(message).split(/\s+/);assert.ok(words.length>=2&&words.length<=3,message);
  }
});


test('stage and run costs use rupees with the reference rate when FX is unavailable and distinguish partial coverage', () => {
  const { formatRebalanceCost, sumRebalanceCosts } = load('../lib/rebalanceCost.ts');
  const costs = [0.007272, 0.009695, 0.015806, 0.001431].map(costUsd => ({costUsd}));
  const row = ui.getLlmStageTileRows({state: 'completed', ...costs[0]}, 0).find(r => r.label === 'Cost incurred');
  assert.equal(row.value, '₹0.68 (est.)');
  assert.equal(formatRebalanceCost(sumRebalanceCosts(costs, 0)), '₹3.18 (est.)');
  assert.equal(formatRebalanceCost(sumRebalanceCosts(costs, 85)), '₹2.91 (est.)');
  assert.equal(formatRebalanceCost(sumRebalanceCosts([...costs, {}], 0)), '₹3.18 (partial estimate)');
  assert.equal(formatRebalanceCost({costUsd: 0}), '₹0.00 (est.)');
  assert.deepEqual(costs.map(cost => formatRebalanceCost(cost)), ['₹0.68 (est.)', '₹0.90 (est.)', '₹1.47 (est.)', '₹0.13 (est.)']);
  assert.equal(formatRebalanceCost({costUsd: 0.00001}), '<₹0.01 (est.)');
  assert.equal(formatRebalanceCost(sumRebalanceCosts([{costUsd: 1, costInr: 80}, {costUsd: 0.1}, {}], 90)), '₹89.00 (partial estimate)');
  assert.equal(formatRebalanceCost(sumRebalanceCosts([{}], 0)), 'Usage unavailable');
});

test('complete saved evidence can coexist with a historical execution error and different Stage 4 source', () => {
  const info={state:'idle',runStatus:'failed',lastRunId:537,error:'Cancelled by user',
    published:{output_id:447,run_id:539,covered:16,expected:16,used_output_id:433,final_id:450},evidenceCoverage:'16/16 stocks scored'};
  const rows=Object.fromEntries(ui.getLlmStageTileRows(info,0).map(r=>[r.label,r.value]));
  assert.equal(rows['Available output'],'#447 · run #539');
  assert.equal(rows['Recorded execution'],'#537 · failed');
  assert.equal(rows['Stage 4 used'],'Output #433 · final #450');
});

test('zero published coverage is unassessed even when a model job completed', () => {
  const {getStageOutcome}=load(workflowPath,['getStageOutcome','hasStagePartialOutput']);
  assert.equal(getStageOutcome({state:'idle',runStatus:'completed',published:{covered:0,expected:16}}),'unassessed');
});

test('unlaunched stages show only the current workflow and a verified zero worker count', () => {
  for (const stage of ['technical', 'threats', 'pairwise', 'actionables']) {
    const info = {state:'idle', workflowSequence:245, runStatus:'not started'};
    assert.deepEqual(ui.getIdleStageRows(stage, info, 0), [{label:'Workflow', value:'#245 · Not started'}]);
    assert.deepEqual(ui.getIdleStageRows(stage, {...info, runStatus:'interrupted before launch'}, 0), [
      {label:'Workflow',value:'#245 · Interrupted before launch'}, {label:'Model jobs launched',value:'0'},
    ]);
  }
});

test('running, partial and clean tiles have distinct presentation', () => {
  const running = {state:'running', partialLlms:1};
  const rows = Object.fromEntries(ui.getIdleStageRows('rebalance',running,0).map(row => [row.label,row.value]));
  assert.equal(rows['Cost incurred'],'Task running');
  assert.ok(rows['LLMs Used']);
  assert.equal(ui.stageTileBorder(running,'normal'),'normal');
  assert.match(ui.stageTileBorder({...running,state:'completed'},'normal'),/border-red-500/);
  assert.equal(ui.formatRecommendedStockProgress({recommendedStocks:28,commonStocks:11}),'28 (11 common)');
  for (const stage of ['sync','swing','technical','rebalance','threats','pairwise','actionables']) {
    assert.equal(ui.getIdleStageRows(stage,{state:'completed'},0).some(row => row.label==='Error'),false);
  }
});

test('Threats distinguishes returned rows, provisional scores and full assessment', () => {
  const info = {state:'completed', runStatus:'completed',threatCounts:{expected:34,returned:34,scored:0,complete:0,status:'unassessed'}};
  assert.equal(ui.getStageOutcome(info),'unassessed');
  const rows=ui.getLlmStageTileRows(info,0);
  assert.equal(rows.find(r=>r.label==='Listings returned').value,'34/34');
  assert.equal(rows.find(r=>r.label==='Assessment').value,'Insufficient verified risk categories');
  assert.ok(!rows.some(r=>r.label==='Stocks recommended'));
  assert.equal(ui.getStageOutcome({...info,threatCounts:{...info.threatCounts,scored:34,status:'partial'}}),'partial');
});

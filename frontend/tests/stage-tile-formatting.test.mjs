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
const workflowPath='../app/console/dashboard/_components/RebalanceWorkflowSections.tsx';
const ui=load(workflowPath,['formatLlmCompletion','formatRecommendedStockProgress','getLlmStageTileRows','getActionablesStageTileRows','getIdleStageRows','LLM_STAGE_TILE_KEYS','formatBriefTileError','getTileErrorDetail','isSheetExportError','isInsufficientBalanceError'],{formatCompactStageTime:date.formatCompactStageTime,formatDuration:()=>null,formatInrCost:()=>'-'});

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
      assert.equal(rows.find(r=>r.label==='Error').value,'Provider timeout');
      assert.equal(rows.find(r=>r.label==='Partial use').value,info.partialNotice);
    }
  }
  assert.deepEqual(info,before);
  for(const value of [null,undefined])assert.equal(ui.formatRecommendedStockProgress({recommendedStocks:value}),'n/a');
  assert.equal(ui.formatRecommendedStockProgress({recommendedStocks:0}),'0');
  const source=readFileSync(new URL(workflowPath,import.meta.url),'utf8');
  assert.match(source,/Last run:\{" "\}\s*\{formatCompactStageTime\(lastRunByPortfolio\[section.portfolio\]\)\}/);
});

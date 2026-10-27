import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {harness,nodes} from './helpers/workspace-hooks.mjs';
const file=new URL('../components/workspace/IncrementalCalculationSheet.tsx',import.meta.url);
const model={};new Function('exports',ts.transpileModule(readFileSync(new URL('../lib/conceptFLegacyFormula.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(model);
function setup(portfolio='india'){
 let ownerMatches=true;
 const h=harness(file,'OwnedSheet',{owner:1,portfolio},{privateStorageOwnerMatches:()=>ownerMatches,privateLocalStorage:{getItem:()=>null},configKey:'config',DEFAULT_SCORE_MATRIX_FORMULA_CONFIG:{},normalizeScoreMatrixFormulaConfig:x=>x,...model,isAnalysisRunForStage:()=>true,buildConsensusRows:()=>[],buildTechnicalScanMap:()=>({}),buildActionablesCalculationRows:()=>[],headers:['Stock Info'],ConceptFCalculationSheet:'Sheet',ConceptFDetailPanel:'Panel',ConceptFSavedText:'SavedText'});
 return{h,foreign:()=>ownerMatches=false};
}
test('history is market scoped, explicit, and refresh never implies successful empty history',async()=>{
 for(const portfolio of ['india','indmoney_us']){const{h}=setup(portfolio);assert.equal(h.requests.length,1);assert.match(h.requests[0].url,new RegExp('portfolio='+portfolio));assert.equal(h.requests[0].options.cache,'no-store');h.requests[0].resolve({items:[]});await h.flush();assert.match(h.text(),/not a completed empty analysis/);assert.equal(h.requests.length,1);h.cleanup();}
});
test('foreign history and late owner responses fail closed without Run fetching',async()=>{
 const{h}=setup();h.requests[0].resolve({items:[{portfolio:'indmoney_us',sequence:1}]});await h.flush();assert.match(h.text(),/Owned history unavailable/);assert.equal(h.requests.length,1);h.cleanup();
 const other=setup();other.foreign();other.h.requests[0].resolve({items:[]});await other.h.flush();assert.equal(other.h.control('Exact historical sequence').props.disabled,true);other.h.cleanup();
});
test('deliberate sequence and Run selection; duplicate clicks issue one read and no business writes',async()=>{
 const{h}=setup();h.requests[0].resolve({items:[{portfolio:'india',sequence:2,label:'fixture'}]});await h.flush();
 const change=h.control('Exact historical sequence').props.onChange({target:{value:'2'}});await h.flush();assert.equal(h.requests.length,2);h.requests[1].resolve({portfolio:'india',sequence:2,runs:[{id:7}],standalone_jobs:[]});await change;await h.flush();
 const checkbox=nodes(h.tree()).find(n=>n.type==='input');checkbox.props.onChange({target:{checked:true}});await h.flush();
 const load=h.button('Load selected saved Runs');const first=load.props.onClick();load.props.onClick();await h.flush();assert.equal(h.requests.length,3);assert.equal(h.requests[2].url,'/backend-api/runs/7');
 h.requests[2].resolve({id:7,auto_rebalance_portfolio:'india',auto_rebalance_sequence:2,run_jobs:[{job_id:9,job:{id:9,auto_rebalance_portfolio:'india'}}]});await first;await h.flush();assert.match(h.text(),/Job 9/);assert.ok(h.requests.every(row=>!row.options.method));h.cleanup();
});
test('source verifier rejects foreign sequence, malformed jobs and invented Run IDs',async()=>{
 for(const row of [{id:7,auto_rebalance_portfolio:'indmoney_us',auto_rebalance_sequence:2,run_jobs:[]},{id:7,auto_rebalance_portfolio:'india',auto_rebalance_sequence:3,run_jobs:[]},{id:7,auto_rebalance_portfolio:'india',auto_rebalance_sequence:2,run_jobs:[{job_id:9,job:{id:10}}]}])await assert.rejects(()=>model.loadSelectedFormulaRuns({ids:[7],allowed:[7],portfolio:'india',sequence:2,assertCurrent:()=>{},getRun:async()=>row}));
 let calls=0;await assert.rejects(()=>model.loadSelectedFormulaRuns({ids:[8],allowed:[7],portfolio:'india',sequence:2,assertCurrent:()=>{},getRun:async()=>{calls++;}}));assert.equal(calls,0);
});
test('duplicate physical job attribution is rejected instead of weighting a source twice',async()=>{
 const link={job_id:9,job:{id:9,auto_rebalance_portfolio:'india'}};
 const row=id=>({id,auto_rebalance_portfolio:'india',auto_rebalance_sequence:2,run_jobs:[link]});
 await assert.rejects(()=>model.loadSelectedFormulaRuns({ids:[7],allowed:[7],portfolio:'india',sequence:2,assertCurrent:()=>{},getRun:async()=>({...row(7),run_jobs:[link,link]})}),/Duplicate/);
 await assert.rejects(()=>model.loadSelectedFormulaRuns({ids:[7,8],allowed:[7,8],portfolio:'india',sequence:2,assertCurrent:()=>{},getRun:async id=>row(id)}),/multiple selected/);
});

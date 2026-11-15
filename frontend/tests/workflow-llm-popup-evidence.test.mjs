import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { stripTypeScriptTypes } from 'node:module';
const bridge = readFileSync(new URL('../app/console/automated-rebalance/_components/AutomatedRebalanceReliabilityBridge.tsx', import.meta.url), 'utf8');
const evidence = readFileSync(new URL('../lib/workflowLlmEvidence.ts', import.meta.url), 'utf8');
function compile(source, stubs = {}) {
  const exports = [...source.matchAll(/export function (\w+)/g)].map(match => match[1]);
  let code = stripTypeScriptTypes(source, { mode: 'strip' }).replace(/export function /g, 'function ');
  code = code.replace(/export \{ ([^}]+) \};/g, (_, names) => `Object.assign(module.exports, {${names}});`);
  code += `\nObject.assign(module.exports, {${exports.join(',')}});`;
  const module = { exports: {} };
  new Function('module', 'exports', ...Object.keys(stubs), code)(module, module.exports, ...Object.values(stubs));
  return module.exports;
}
function extract(start, end, name, stubs) {
  return compile(bridge.slice(bridge.indexOf(start), bridge.indexOf(end)) + `\nexport { ${name} };`, stubs)[name];
}
const helpers = compile(evidence);
test('one classifier separates partial and malformed saved output from genuine passes', () => {
  assert.deepEqual(helpers.summarizeWorkflowLlmJobs([{status:'completed'}, {status:'partial'}, {status:'failed'}, {status:'processing'}, {status:'completed', response:'partial rebalance table'}]),
    {total:5, passed:1, partial:2, failed:1, unresolved:1});
});
test('explicit metric identity includes zero counts rather than falling back to another run', () => {
  const fn = extract('function inferMetricContext(', '\nfunction inferStageFromPrompt(', 'inferMetricContext');
  assert.deepEqual(fn({dataset:{workflowStage:'technical', workflowPortfolio:'india', workflowTotal:'0', workflowPassed:'0', workflowRunId:'12', workflowSequence:'3'}}, {}),
    {stage:'technical',portfolio:'india',expectedTotal:0,runId:12,sequence:3,jobId:null,passed:0,partial:null,failed:null});
});
const collect = extract('function collectStageJobs(', '\nfunction toStageJob(', 'collectStageJobs', {inferStageFromPrompt: () => 'technical'});
test('explicit stage run excludes similarly named jobs from other runs', () => {
  const rows=collect({stages:[{stage:'technical',run_id:12}], runs:[{id:12,prompt:'',jobs:[{id:1,prompt:''}]},{id:13,prompt:'technical scan',jobs:[{id:2,prompt:''}]}],standalone_jobs:[]}, 'technical');
  assert.deepEqual(rows.map(j=>j.id),[1]);
});
function loader(apiService) {
  return extract('async function loadSavedStageJobs(', '\nfunction metadataNumber(', 'loadSavedStageJobs', {
    apiService, retryRead: f=>f(), runMatchesPortfolio: (r,p)=>r.auto_rebalance_portfolio===p,
    stageLabel: s=>s, toStageJob: j=>j, collectStageJobs: collect,
    loadThreatFallback:()=>{throw new Error('Unexpected threat fallback')},
    loadRecentRunFallback:()=>{throw new Error('Unexpected run fallback')},
  });
}
test('exact run read never substitutes another workflow on failure or mismatch', async () => {
  const fn=loader({getRun: async()=>{throw new Error('unavailable')}});
  await assert.rejects(fn({runId:12,portfolio:'india',stage:'technical'}),/unavailable/);
  const wrong=loader({getRun:async()=>({id:12,auto_rebalance_portfolio:'indmoney_us'})});
  await assert.rejects(wrong({runId:12,portfolio:'india',stage:'technical'}),/does not match/);
});
test('zero models without identity remains zero without searching an older nonzero run', async()=> {
  assert.deepEqual(await loader({})({expectedTotal:0,portfolio:'india',stage:'technical'}), {label:'Saved technical · no model rows recorded',jobs:[]});
});
test('exact sequence with no jobs reports empty evidence, not other runs',async()=> {
  const fn=loader({getAutoRebalanceHistoryDetail:async(p,s)=>({portfolio:p,sequence:s,label:'India #8',stages:[{stage:'technical',run_id:12}],runs:[],standalone_jobs:[]})});
  assert.deepEqual(await fn({sequence:8,portfolio:'india',stage:'technical'}),{label:'India #8',jobs:[]});
});
test('loading and unavailable do not display fabricated zero outcomes',()=> {
  assert.match(bridge,/loading \? "Loading model-level evidence…" : error \? "Model-level evidence unavailable"/);
  assert.match(bridge,/setRows\(\[\]\);\s*setRunLabel\(null\)/);
  assert.doesNotMatch(bridge,/\["completed", "success", "passed", "partial"\]/);
});

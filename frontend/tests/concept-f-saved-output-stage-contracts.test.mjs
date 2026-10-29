import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import ts from 'typescript';import {harness,nodes,text} from './helpers/workspace-hooks.mjs';
// F19: exact saved stage output, not a complete export or a newly run analysis.
function load(file){const out={};new Function('exports',ts.transpileModule(readFileSync(new URL('../lib/'+file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(out);return out;}
const flow=load('conceptFStockFlow.ts'),privacy=load('conceptFResearch.ts');
const source='a'.repeat(64),receipt='b'.repeat(64);
const row=portfolio=>({id:7,owner_id:1,portfolio,inputs:{source_hash:source}});
function saved(stage,portfolio='india',status='completed'){return {stage,status,checkpoint:{result_hash:receipt,result:{data:{job_id:19,response:JSON.stringify({schema_version:1,currency:portfolio==='india'?'INR':'USD',provenance:{input_hash:source},recommendations:[{instrument:portfolio==='india'?'NSE:DEMO':'US:DEMO',action:'hold',current_units:'0',final_units:'0',allocation:'0'}]})}}}};}
function view(stage,portfolio='india',masked=false,extra={}){return harness(new URL('../components/workspace/ConceptFSavedOutputs.tsx',import.meta.url),'ConceptFSavedOutputs',{row:row(portfolio),stage,masked,onDiagnostics:()=>{},onInputs:()=>{}},{...flow,...privacy,...extra});}
function field(h,name){return nodes(h.tree()).find(n=>n.type==='tr'&&nodes(n).some(c=>c.type==='th'&&text(c)===name));}
for(const name of ['threats','swing','rebalance','technical','actionables'])test('F19 '+name+' admits only same-source saved recommendations in either market',async()=>{
 for(const portfolio of ['india','indmoney_us']){const stage=saved(name,portfolio),before=structuredClone(stage),h=view(stage,portfolio);assert.match(text(field(h,'action_count')),/1/);assert.match(h.text(),new RegExp(name+' output'));h.button('Source links').props.onClick();await h.flush();assert.equal(nodes(h.tree()).find(n=>n.type==='a'&&n.props.href==='/console/jobs/19').props.href,'/console/jobs/19');assert.match(h.text(),new RegExp(receipt));assert.deepEqual(stage,before);assert.equal(h.requests.length,0);h.cleanup();}
});
test('F19 sync acquisition receipt and unavailable stages never imply a successful zero-action scan',()=>{
 for(const stage of [undefined,{stage:'sync',status:'completed',checkpoint:{result:{data:{snapshot_id:4}}}},saved('technical','india','processing'),saved('threats','india','failed'),saved('swing','india','cancelled')]){const h=view(stage);assert.match(text(field(h,'action_count')),/Unavailable/);assert.equal(h.requests.length,0);h.cleanup();}
});
test('F19 partial and explicit empty saved outputs remain distinct from missing/mismatched evidence',()=>{
 const partial=view(saved('technical','india','partial'));assert.match(text(field(partial,'action_count')),/1Admitted partial rows; not complete output/);partial.cleanup();
 const empty=saved('actionables');const document=JSON.parse(empty.checkpoint.result.data.response);document.recommendations=[];empty.checkpoint.result.data.response=JSON.stringify(document);const h=view(empty);assert.match(text(field(h,'action_count')),/0/);assert.match(h.text(),/Saved completed · empty/);h.cleanup();
 for(const change of [v=>{v.provenance.input_hash='c'.repeat(64);},v=>{v.currency='USD';},v=>{v.recommendations.push({...v.recommendations[0]});}]){const stage=saved('swing'),doc=JSON.parse(stage.checkpoint.result.data.response);change(doc);stage.checkpoint.result.data.response=JSON.stringify(doc);const bad=view(stage);assert.match(text(field(bad,'action_count')),/Unavailable/);assert.match(bad.text(),/unparseable/);bad.cleanup();}
});
test('F19 masked other-stage clipboard is bounded display evidence, never full private export',async()=>{
 for(const name of ['threats','swing','technical','actionables']){let copied;const h=view(saved(name),'india',true,{navigator:{clipboard:{writeText:async value=>{copied=value;}}}});await h.button('Copy view (masked)').props.onClick();await h.flush();const payload=JSON.parse(copied);assert.equal(payload.stage,name);assert.equal(payload.kind,'bounded_saved_output_view_not_complete_export');assert.equal(payload.output,'Investment values masked');assert.doesNotMatch(copied,/NSE:DEMO|recommendations|current_units/);assert.equal(h.requests.length,0);h.cleanup();}
});

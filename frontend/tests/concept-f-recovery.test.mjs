import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import ts from 'typescript';import {harness} from './helpers/workspace-hooks.mjs';
const researchStages=[['sync','Sync Portfolio'],['threats','Threats Scan'],['swing','Swing Scan'],['rebalance','Rebalance'],['technical','Technical Scan'],['actionables','Actionables']];
const row={id:7,owner_id:1,portfolio:'india',version:2,inputs:{source_hash:'a'.repeat(64),plan_hash:'b'.repeat(64),orders_authorized:false},stages:researchStages.map(([stage])=>({stage,status:'pending',attempts:0,error:null})),progress:{progress_rank:[2,0],display_state:'unknown_spend',observed_at:'2026-10-25T00:00:00Z',history_complete:false,unresolved_spend:true,inflight_cost_possible:true,actions:{retry:false}}};
const canonicalExports={};new Function('exports',ts.transpileModule(readFileSync(new URL('../lib/researchProgress.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(canonicalExports);
const {newerResearch}=canonicalExports;
function setup(){return harness(new URL('../components/workspace/ConceptFResearchRecovery.tsx',import.meta.url),'ConceptFResearchRecovery',{row},{researchStages,newerResearch,safeResearchData:x=>x,useSearchParams:()=>new URLSearchParams(),usePathname:()=>'/console/zerodha/research',useRouter:()=>({replace(){}})});}
test('explicit verification double click issues one GET and unknown spend never becomes retry permission',async()=>{const h=setup();assert.equal(h.requests.length,0);const button=h.button('Verify saved result');button.props.onClick();button.props.onClick();assert.equal(h.requests.length,1);assert.equal(h.requests[0].url,'/backend-api/runs/analysis-workflows/7?include_readiness=true');h.requests[0].resolve(row);await h.flush();assert.match(h.text(),/Verified saved identity 7/);assert.match(h.text(),/possible; inspect receipts before retry/);assert.match(h.text(),/Retry is unavailable/);assert.equal(h.requests.some(r=>r.options.method),false);});
test('wrong owner, source, identity, stale version or missing spend state fails closed',async()=>{for(const change of [{owner_id:2},{id:8},{version:1},{inputs:{...row.inputs,source_hash:'c'.repeat(64)}},{progress:{...row.progress,unresolved_spend:undefined}}]){const h=setup();h.button('Verify saved result').props.onClick();h.requests[0].resolve({...row,...change});await h.flush();assert.match(h.text(),/Outcome remains unknown/);assert.doesNotMatch(h.text(),/Verified saved identity/);assert.equal(h.requests.length,1);}});
test('unmounted lifetime drops late read and a failed read cannot retain an apparently current receipt',async()=>{const h=setup();h.button('Verify saved result').props.onClick();h.cleanup();h.requests[0].resolve(row);await h.flush();assert.doesNotMatch(h.text(),/Verified saved identity/);const next=setup();next.button('Verify saved result').props.onClick();next.requests[0].resolve(row);await next.flush();next.button('Verify saved result').props.onClick();next.requests[1].reject(new Error('synthetic read failure'));await next.flush();assert.doesNotMatch(next.text(),/Verified saved identity/);assert.match(next.text(),/Outcome remains unknown/);});

const checkpoint=(version,rank,time='2026-10-25T00:00:00Z')=>({...row,version,progress:{...row.progress,progress_rank:[version,...rank],observed_at:time}});
async function verify(h,value){h.button('Verify saved result').props.onClick();h.requests.at(-1).resolve(value);await h.flush();}
for(const [name,stale] of [
 ['version',checkpoint(3,[9],'2026-10-26T00:00:00Z')],
 ['same-version rank',checkpoint(4,[1],'2026-10-26T00:00:00Z')],
 ['same-version observation time',checkpoint(4,[2],'2026-10-24T00:00:00Z')],
 ['equal metadata with conflicting stage evidence',{...checkpoint(4,[2]),stages:row.stages.map((stage,index)=>index===0?{...stage,error:'conflicting evidence'}:stage)}],
])test('recovery rejects '+name+' regression while preserving last-known history and admitting legitimate advance',async()=>{
 const h=setup();await verify(h,checkpoint(4,[2]));assert.match(h.text(),/Verified saved identity 7 · version 4/);
 await verify(h,stale);assert.match(h.text(),/Outcome remains unknown/);assert.match(h.text(),/Last known saved identity 7 · version 4/);assert.doesNotMatch(h.text(),/Verified saved identity|Retry is reported available/);
 await verify(h,checkpoint(4,[3],'2026-10-26T00:00:00Z'));assert.match(h.text(),/Verified saved identity 7 · version 4/);assert.doesNotMatch(h.text(),/Outcome remains unknown/);
 assert.equal(h.requests.length,3);assert.equal(h.requests.some(r=>r.options.method),false);h.cleanup();
});
test('transient read failure cannot erase high-water or admit a stale or foreign recovery receipt',async()=>{
 const h=setup();await verify(h,checkpoint(5,[2]));h.button('Verify saved result').props.onClick();await h.flush();assert.doesNotMatch(h.text(),/Verified saved identity/);assert.match(h.text(),/current verification is pending/);
 h.requests.at(-1).reject(Error('timeout'));await h.flush();assert.match(h.text(),/Last known saved identity 7 · version 5/);assert.match(h.text(),/current verification is unknown/);
 await verify(h,checkpoint(4,[9]));assert.doesNotMatch(h.text(),/Verified saved identity/);
 await verify(h,{...checkpoint(6,[3]),owner_id:2});assert.doesNotMatch(h.text(),/Verified saved identity/);assert.match(h.text(),/Last known saved identity 7 · version 5/);
 await verify(h,checkpoint(6,[3]));assert.match(h.text(),/Verified saved identity 7 · version 6/);assert.equal(h.requests.some(r=>r.options.method),false);h.cleanup();
});

test('an exactly unchanged full receipt remains verified even with reordered JSON object keys',async()=>{
 const h=setup();const original=checkpoint(4,[2]);await verify(h,original);
 function reorder(value){if(Array.isArray(value))return value.map(reorder);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).reverse().map(([key,item])=>[key,reorder(item)]));return value;}
 await verify(h,reorder(structuredClone(original)));assert.match(h.text(),/Verified saved identity 7 · version 4/);assert.doesNotMatch(h.text(),/Outcome remains unknown|Last known saved identity/);assert.equal(h.requests.length,2);assert.equal(h.requests.some(r=>r.options.method),false);h.cleanup();
});
test('equal metadata cannot hide changed nested optional evidence or added receipt fields',async()=>{
 for(const extra of [{input_readiness:{current:true}},{stages:row.stages.map((stage,index)=>index===1?{...stage,checkpoint:{result:{items:['changed']}}}:stage)}]){
  const h=setup();await verify(h,checkpoint(4,[2]));await verify(h,{...checkpoint(4,[2]),...extra});assert.match(h.text(),/Outcome remains unknown/);assert.doesNotMatch(h.text(),/Verified saved identity/);h.cleanup();
 }
});

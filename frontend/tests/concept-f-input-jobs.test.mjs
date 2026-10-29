import {readFileSync} from 'node:fs';
import test from 'node:test';import assert from 'node:assert/strict';import {harness,nodes} from './helpers/workspace-hooks.mjs';
const runs=[{id:7,status:'completed',created_at:'2026-10-25T00:00:00Z',run_jobs:[{job_id:11,job:{id:11,status:'completed',provider:'fake',model:'offline',estimated_cost:0}},{job_id:12,job:{id:12,status:'failed',provider:'fake',model:'offline',estimated_cost:null,error_message:'Synthetic error'}}]},{id:8,status:'failed',run_jobs:[]}];
function setup(selected=[]){const calls=[];const h=harness(new URL('../components/workspace/ConceptFInputJobs.tsx',import.meta.url),'ConceptFInputJobs',{runs,selected,masked:false,onChange:keys=>calls.push(keys)},{safeResearchData:x=>x});return {...h,calls};}
test('run expansion is deliberate and selecting all includes failed identities without fetching or dispatching',async()=>{const h=setup();assert.equal(nodes(h.tree()).some(n=>n.props?.['aria-label']==='Use saved run 7 job 11'),false);h.button('Expand run 7').props.onClick();await h.flush();assert.equal(nodes(h.tree()).some(n=>n.props?.['aria-label']==='Use saved run 7 job 11'),true);h.button('Select all saved jobs').props.onClick();assert.deepEqual(h.calls,[['7:11','7:12']]);assert.equal(h.requests.length,0);assert.match(h.text(),/No INR conversion/);assert.match(h.text(),/Inspect saved error/);});
test('completed and explicit no-default selection remain distinct and never infer zero for missing cost',async()=>{const h=setup(['7:12']);h.button('Select completed saved jobs').props.onClick();h.button('Reset to explicit defaults (none)').props.onClick();assert.deepEqual(h.calls,[['7:11'],[]]);h.button('Expand run 7').props.onClick();await h.flush();assert.match(h.text(),/Unknown/);const group=nodes(h.tree()).find(n=>n.props?.['aria-label']==='Select all jobs in run 7');assert.equal(group.props['aria-checked'],'mixed');group.props.onChange({target:{checked:false}});assert.deepEqual(h.calls.at(-1),[]);assert.equal(h.requests.length,0);});
test('empty source run stays visible and cannot become an implicit successful scan',async()=>{const h=setup();h.button('Expand run 8').props.onClick();await h.flush();assert.match(h.text(),/No linked jobs are recorded/);const group=nodes(h.tree()).find(n=>n.props?.['aria-label']==='Select all jobs in run 8');assert.equal(group.props.disabled,true);assert.equal(h.requests.length,0);});
test('Done is a local explicit selection boundary and never performs a read or mutation',()=>{let done=0;const h=harness(new URL('../components/workspace/ConceptFInputJobs.tsx',import.meta.url),'ConceptFInputJobs',{runs,selected:['7:11'],onChange(){throw new Error('Done must not change selected identities');},onDone(){done++;}},{safeResearchData:x=>x});h.button('Done selecting inputs').props.onClick();assert.equal(done,1);assert.equal(h.requests.length,0);});

test('input picker exposes admitted market and saved creation/model/status without claiming capture time',async()=>{const h=harness(new URL('../components/workspace/ConceptFInputJobs.tsx',import.meta.url),'ConceptFInputJobs',{runs,selected:[],market:'indmoney_us',onChange(){}},{safeResearchData:x=>x});assert.match(h.text(),/Run 7 · US/);assert.match(h.text(),/record created/);h.button('Expand run 7').props.onClick();await h.flush();assert.match(h.text(),/Job \/ creation time/);assert.match(h.text(),/Model \/ source/);assert.match(h.text(),/completed/);assert.doesNotMatch(h.text(),/captured at/);h.cleanup();});

test('F28 run total uses exactly displayed estimates, not selected jobs',()=>{
 const priced=[{...runs[0],run_jobs:runs[0].run_jobs.map((link,i)=>({...link,job:{...link.job,estimated_cost:[0.12,0.23][i]}}))}];
 const h=harness(new URL('../components/workspace/ConceptFInputJobs.tsx',import.meta.url),'ConceptFInputJobs',{runs:priced,selected:['7:11'],market:'india',masked:false,onChange(){}},{safeResearchData:x=>x});
 assert.match(h.text(),/Saved run estimate: USD 0.35/);assert.match(h.text(),/All 2 displayed jobs; not settled charges/);assert.equal(h.requests.length,0);
});
test('F28 total retains zero and refuses missing invalid empty or ambiguous estimates',()=>{
 for(const [costs,market,expected] of [[[0,0],'india','USD 0'],[[0.1,null],'india','Unknown'],[[0.1,undefined],'india','Unknown'],[[0.1,Infinity],'india','Unknown'],[[0.1,NaN],'india','Unknown'],[[0.1,-1],'india','Unknown'],[[0.1,'0.2'],'india','Unknown'],[[],'india','Unknown'],[[1,2],undefined,'Unknown'],[[Number.MAX_VALUE,Number.MAX_VALUE],'india','Unknown']]){
  const run={...runs[0],run_jobs:costs.map((cost,i)=>({job_id:11+i,job:{...runs[0].run_jobs[0].job,estimated_cost:cost}}))};
  const h=harness(new URL('../components/workspace/ConceptFInputJobs.tsx',import.meta.url),'ConceptFInputJobs',{runs:[run],selected:[],market,masked:false,onChange(){}},{safeResearchData:x=>x});
  assert.ok(h.text().includes('Saved run estimate: '+expected));assert.equal(h.requests.length,0);
 }
});
test('F28 default masking hides aggregate and per-job amounts after expansion',async()=>{
 const priced=[{...runs[0],run_jobs:[{...runs[0].run_jobs[0],job:{...runs[0].run_jobs[0].job,estimated_cost:8877.665}}]}];
 const h=harness(new URL('../components/workspace/ConceptFInputJobs.tsx',import.meta.url),'ConceptFInputJobs',{runs:priced,selected:[],market:'indmoney_us',onChange(){}},{safeResearchData:x=>x});
 h.button('Expand run 7').props.onClick();await h.flush();assert.match(h.text(),/Saved run estimate: Masked/);assert.doesNotMatch(h.text(),/8877|8,877/);assert.equal(h.requests.length,0);
});

test('F28 caller propagates its financial mask to the saved input picker',()=>{const source=readFileSync(new URL('../components/workspace/ConceptFLegacyFormula.tsx',import.meta.url),'utf8');assert.match(source,/<ConceptFInputJobs masked=\{masked\}/);});

test('F28 duplicate job identities cannot be counted twice in a run estimate',()=>{
 const job={...runs[0].run_jobs[0],job:{...runs[0].run_jobs[0].job,estimated_cost:0.12}};
 const h=harness(new URL('../components/workspace/ConceptFInputJobs.tsx',import.meta.url),'ConceptFInputJobs',{runs:[{...runs[0],run_jobs:[job,job]}],selected:[],market:'india',masked:false,onChange(){}},{safeResearchData:x=>x});
 assert.match(h.text(),/Saved run estimate: Unknown/);assert.doesNotMatch(h.text(),/USD 0.24/);assert.equal(h.requests.length,0);
});

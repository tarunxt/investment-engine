import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../app/console/apis/page.tsx', import.meta.url), 'utf8');
const modal = source.slice(source.indexOf('function LlmCostHistoryModal('), source.indexOf('export default function ApisPage'));
const compiled = ts.transpileModule(`const API_TIMEZONE='Asia/Kolkata'; const X=()=>null; const formatFxTimestamp=()=>null; const getTodayIso=()=>''; const formatCalendarDate=x=>x; const formatConvertedCost=(inr,usd)=>'$'+usd; const formatHistoryTimestamp=x=>x; ${modal}; exports.Modal=LlmCostHistoryModal`, {compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
const fixtureModule = {exports:{}};
new Function('require','module','exports',compiled)(require,fixtureModule,fixtureModule.exports);
const history={name:'Synthetic provider',timezone:'Asia/Kolkata',fx_status:'unavailable',days:[],runs:[]};
const render=(props)=>renderToStaticMarkup(React.createElement(fixtureModule.exports.Modal,{history:null,loading:false,error:null,activeTab:'day-wise',onTabChange(){},onClose(){},onSeeMoreDays(){},onSeeMoreRuns(){},...props}));
for (const activeTab of ['day-wise','all-runs']) {
 test(`${activeTab}: loading, timeout, cached empty, recovery and populated retention`,()=>{
  assert.match(render({activeTab,loading:true}),/Loading LLM cost history/);
  for(const prior of [null,history]) {
   const failed=render({activeTab,history:prior,error:'Synthetic timeout'});
   assert.match(failed,/History is unverified/);
   assert.doesNotMatch(failed,/No runs recorded|No daily history recorded/);
  }
  const partial={...history, [activeTab==='day-wise'?'runs':'days']:[activeTab==='day-wise'?{job_id:123,timestamp:'2026-11-01T00:00:00Z',estimated_cost:0.125}:{date:'2026-11-01',estimated_cost:0.125}]};
  assert.match(render({activeTab,history:partial,error:'Synthetic timeout'}),/history is unverified/);
  assert.doesNotMatch(render({activeTab,history:partial,loading:true}),/No runs recorded|No daily history recorded/);
  const recovered=render({activeTab,history});
  assert.match(recovered,activeTab==='all-runs'?/No runs recorded/:/No daily history recorded/);
  assert.doesNotMatch(recovered,/unverified/);
  const populated={...history,days:[{date:'2026-11-01',requests:1,tokens_in:12,tokens_out:4,estimated_cost:0.125}],runs:[{job_id:123,timestamp:'2026-11-01T00:00:00Z',model:'synthetic',status:'completed',estimated_cost:0.125}]};
  const cached=render({activeTab,history:populated,error:'Synthetic timeout'});
  assert.match(cached,/Showing previously loaded history/);
  assert.match(cached,/\$0.125/);
  assert.doesNotMatch(cached,/No runs recorded|No daily history recorded/);
 });
}
test('closed or superseded modal requests cannot commit a response or failure',()=>{
 assert.match(source,/const request = \+\+costHistoryRequest.current/);
 assert.match(source,/if \(request !== costHistoryRequest.current\) return;\s+setCostHistory\(res\)/);
 assert.match(source,/if \(request !== costHistoryRequest.current\) return;\s+setCostHistoryError/);
 assert.match(source,/const closeCostHistory = useCallback\(\(\) => \{\s+costHistoryRequest.current \+= 1/);
});

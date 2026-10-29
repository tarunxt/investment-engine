import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {allowedModule,surfaceAllowed,surfaceVisible,validCollection,surfaceFor} from '../lib/modulePolicy.ts';
const ids=['zerodha_rebalance','indmoney_us','bullpen_research','bullpen_live','copy_trader','prediction_direct','market_scanner','ai_studio','sheets_export','sports_rankings'];
function policy(selected=[],owner=1){return {schema_version:1,owner_id:owner,version:1,modules:ids.map(id=>({module_id:id,label:id,category:'synthetic',connection:{kind:'none',state:'not_required'},entitlement:{jurisdiction:'allowed',plan:'allowed'},execution:{capable:false,action_confirmed:false},requires:[],selection:{enabled:selected.includes(id),version:1,schedules_paused:true,config:{schema_version:1}},availability:{available:!id.startsWith('bullpen')&&!['copy_trader','prediction_direct'].includes(id),reason:null},capabilities:{view:{allowed:selected.includes(id),reasons:[]},export:{allowed:false,reasons:['NO_AUTHORITY']}}})),presentation:{schema_version:1,surfaces:[{path:'/console/zerodha',module_ids:['zerodha_rebalance'],capability:'view'},{path:'/console/indmoney-us',module_ids:['indmoney_us'],capability:'view'},{path:'/console/bullpen-ai',module_ids:['bullpen_research'],capability:'view'}],api_rules:[{path:'/zerodha',module_ids:['zerodha_rebalance'],capability:'view'},{path:'/indmoney-us',module_ids:['indmoney_us'],capability:'view'}],core_paths:['/console/profile','/console/jobs','/console/runs','/console/apis'],preferences_path:'/console/profile/preferences',safety_activity_path:'/console/profile/activity',connections_path:'/console/profile/connections'}};}
for(const selected of [[],['zerodha_rebalance'],['indmoney_us'],['zerodha_rebalance','indmoney_us']])test(`server-driven visible routes: ${selected.join(',')||'none'}`,()=>{
 const data=policy(selected);assert.equal(surfaceVisible(data,'/console/zerodha/events'),selected.includes('zerodha_rebalance'));assert.equal(surfaceAllowed(data,'/console/indmoney-us/rebalance'),selected.includes('indmoney_us'));
 assert.equal(surfaceVisible(data,'/console/profile/activity'),true);assert.equal(surfaceVisible(data,'/console/unknown-future-page'),false);
 assert.equal(surfaceVisible(data,'/console/zerodha-other'),false);
});
test('unavailable versus selected-but-not-ready never grants operations',()=>{
 const data=policy(['bullpen_research','zerodha_rebalance']);assert.equal(surfaceVisible(data,'/console/bullpen-ai'),true);
 data.modules[0].capabilities.view.allowed=false;assert.equal(surfaceVisible(data,'/console/zerodha'),true);assert.equal(surfaceAllowed(data,'/console/zerodha'),false);
 assert.equal(allowedModule(data,'sheets_export','export'),false);
});
test('owner, malformed/duplicate catalog and policy shape fail closed',()=>{
 const data=policy();assert.equal(validCollection(data,1),true);assert.equal(validCollection(data,2),false);
 assert.equal(validCollection({...data,modules:[...data.modules.slice(1),data.modules[1]]},1),false);
 assert.equal(validCollection({...data,presentation:null},1),false);
 assert.equal(surfaceAllowed(null,'/console/zerodha'),false);
});
test('most specific typed surface governs nested routes',()=>{
 const data=policy(['zerodha_rebalance']);data.presentation.surfaces.push({path:'/console/zerodha/restricted',module_ids:['bullpen_live'],capability:'view'});
 assert.equal(surfaceFor(data,'/console/zerodha/restricted/12').module_ids[0],'bullpen_live');assert.equal(surfaceAllowed(data,'/console/zerodha/restricted/12'),false);
});
test('in-flight optional and aggregate reads abort on disable, failure and account switch',async()=>{
 const file=new URL('../lib/moduleRequests.ts',import.meta.url);let js=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 js=js.replace(/(['"])\.\/modulePolicy\1/g,JSON.stringify(new URL('../lib/modulePolicy.ts',import.meta.url).href));
 const gate=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
 const previous=globalThis.window;globalThis.window={location:{origin:'https://synthetic.invalid'}};
 try{
  gate.installModulePolicy(policy(['zerodha_rebalance']));const old=gate.moduleRequestSignal('/backend-api/zerodha/portfolio');const summary=gate.moduleRequestSignal('/backend-api/dashboard/summary');assert.equal(old.aborted,false);
  gate.installModulePolicy(policy(['indmoney_us']));assert.equal(old.aborted,true);assert.equal(summary.aborted,true);
  assert.throws(()=>gate.moduleRequestSignal('/backend-api/zerodha/portfolio'),{name:'AbortError'});
  const next=gate.moduleRequestSignal('/backend-api/indmoney-us/portfolio');gate.clearModulePolicy();assert.equal(next.aborted,true);
  assert.throws(()=>gate.moduleRequestSignal('/backend-api/indmoney-us/portfolio'),{name:'AbortError'});
  assert.doesNotThrow(()=>gate.moduleRequestSignal('/backend-api/me/modules'));
  assert.doesNotThrow(()=>gate.moduleRequestSignal('/backend-api/account/operations/diagnostics'));
  assert.doesNotThrow(()=>gate.moduleRequestSignal('/backend-api/account/operations/privacy-requests'));

  assert.doesNotThrow(()=>gate.moduleRequestSignal('/backend-api/me/modules/safety-activity'));
  gate.installModulePolicy(policy([],2));assert.throws(()=>gate.moduleRequestSignal('/backend-api/indmoney-us/portfolio'),{name:'AbortError'});
 }finally{globalThis.window=previous;}
});

test('new bounded market history and advisory writes require explicit server rules and abort on policy change',async()=>{
 const file=new URL('../lib/moduleRequests.ts',import.meta.url);let js=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;js=js.replace(/(['"])\.\/modulePolicy\1/g,JSON.stringify(new URL('../lib/modulePolicy.ts',import.meta.url).href));const gate=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));const previous=globalThis.window;globalThis.window={location:{origin:'https://synthetic.invalid'}};
 try{const data=policy(['zerodha_rebalance']);for(const category of ['buy-threshold','recommendation-history'])for(const [portfolio,module]of [['india','zerodha_rebalance'],['indmoney_us','indmoney_us']])data.presentation.api_rules.push({path:'/uat2/simulation/'+category+'/'+portfolio,module_ids:[module],capability:'view'});gate.installModulePolicy(data);const signal=gate.moduleRequestSignal('/backend-api/uat2/simulation/recommendation-history/india?symbol=ALPHA');assert.equal(signal.aborted,false);assert.throws(()=>gate.moduleRequestSignal('/backend-api/uat2/simulation/buy-threshold/indmoney_us'),{name:'AbortError'});gate.clearModulePolicy();assert.equal(signal.aborted,true);assert.throws(()=>gate.moduleRequestSignal('/backend-api/uat2/simulation/recommendation-history/india?symbol=ALPHA'),{name:'AbortError'});gate.installModulePolicy(policy(['zerodha_rebalance']));assert.throws(()=>gate.moduleRequestSignal('/backend-api/uat2/simulation/buy-threshold/india'),{name:'AbortError'});}finally{globalThis.window=previous;}
});

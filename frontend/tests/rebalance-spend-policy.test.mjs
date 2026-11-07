import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('../lib/rebalanceSpendAuthorization.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const api={};new Function('exports',code)(api);
function fixture(){const values=new Map();return {storage:{getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)},locks:{request:(_key,fn)=>fn()}};}
const initial={owner:7,market:'india',choice:{intent:'new_workflow',revision:0}};
const reply=auth=>({portfolio:'india',sequence:1,label:'fixture',spend_scope_id:1,reservation_created:true,side_effect_policy:auth.side_effect_policy});
test('pending UUID retains analysis-only policy when retry UI choice changes',async()=>{
 const f=fixture();let original;
 await assert.rejects(()=>api.authorizeAndClaimWorkflow({...initial,...f,analysisOnly:true,reserve:async auth=>{original=auth;throw Error('lost response')}}),/lost response/);
 let replay;
 await assert.rejects(()=>api.authorizeAndClaimWorkflow({...initial,...f,choice:{intent:'retry_authorization',revision:99,observedRequestId:original.spend_request_id},analysisOnly:false,reserve:async auth=>{replay=auth;return {...reply(auth),reservation_created:false}}}),/No stages restarted/);
 assert.equal(replay.spend_request_id,original.spend_request_id);
 assert.deepEqual(replay.side_effect_policy,{version:1,mode:'analysis_only'});
});
test('a missing or changed server policy cannot acknowledge execution',async()=>{
 for(const policy of [undefined,{version:1,mode:'existing_preferences'}]){
  const f=fixture();await assert.rejects(()=>api.authorizeAndClaimWorkflow({...initial,...f,analysisOnly:true,reserve:async auth=>({...reply(auth),side_effect_policy:policy})}),/did not confirm/);
  assert.equal(JSON.parse(f.storage.getItem(api.spendStorageKey(7,'india'))).state,'pending');
 }
});

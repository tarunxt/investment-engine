import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function moduleAt(path, require=()=>{throw Error('unexpected import')}){const exports={};new Function('exports','require',compile(readFileSync(new URL(path,import.meta.url),'utf8')))(exports,require);return exports;}
const owner=moduleAt('../lib/workflowOwnerLifetime.ts');
const {workflowOwnedApi}=moduleAt('../lib/workflowOwnedApi.ts',()=>owner);
const auth=moduleAt('../lib/rebalanceSpendAuthorization.ts');
const source=readFileSync(new URL('../app/console/dashboard/_components/RebalanceWorkflowSections.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('workflow.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='reserveAutoRebalanceRunMetadata');
function entry(authorize){return new Function('getAutoRebalancePortfolioKey','authorizeAndClaimWorkflow',compile(fn.getText(ast))+';return reserveAutoRebalanceRunMetadata;')(()=> 'india',authorize);}
function storage(){const map=new Map();return {getItem:key=>map.get(key)||null,setItem:(key,value)=>map.set(key,value)};}
const choice={intent:'new_workflow',revision:0};
test('owner change while readiness loads cannot begin authorization or another actor request',async()=>{
 owner.setWorkflowOwner(7);const captured=owner.captureWorkflowOwner();let calls=0,authorization=0;
 const scoped=workflowOwnedApi({getAutoRebalanceSpendReadiness:async()=>{owner.setWorkflowOwner(8);return {paid_execution_available:true}},reserveAutoRebalanceRunLabel:async()=>{calls++}},captured);
 await assert.rejects(()=>entry(async()=>{authorization++})('zerodha',7,choice,true,scoped),/owner changed/);
 assert.equal(calls,0);assert.equal(authorization,0);
});
test('owner change after pending UUID cannot send its payload under another owner',async()=>{
 owner.setWorkflowOwner(7);const captured=owner.captureWorkflowOwner();const saved=storage();let calls=0;
 const scoped=workflowOwnedApi({getAutoRebalanceSpendReadiness:async()=>({paid_execution_available:true}),reserveAutoRebalanceRunLabel:async()=>{calls++}},captured);
 const authorize=options=>auth.authorizeAndClaimWorkflow({...options,storage:saved,locks:{request:(_key,fn)=>{owner.setWorkflowOwner(8);return fn()}}});
 await assert.rejects(()=>entry(authorize)('zerodha',7,choice,true,scoped),/owner changed/);
 assert.equal(calls,0);assert.equal(JSON.parse(saved.getItem(auth.spendStorageKey(7,'india'))).state,'pending');
 assert.equal(saved.getItem(auth.spendStorageKey(8,'india')),null);
});
test('an in-flight old-owner reply cannot acknowledge execution or cross-owner state',async()=>{
 owner.setWorkflowOwner(7);const captured=owner.captureWorkflowOwner();const saved=storage();let complete,started;
 const entered=new Promise(resolve=>{started=resolve});
 const scoped=workflowOwnedApi({getAutoRebalanceSpendReadiness:async()=>({paid_execution_available:true}),reserveAutoRebalanceRunLabel:(_market,_analysisOnly,authorization)=>{started();return new Promise(resolve=>{complete=()=>resolve({portfolio:'india',sequence:1,label:'synthetic',spend_scope_id:1,reservation_created:true,side_effect_policy:authorization.side_effect_policy})})}},captured);
 const authorize=options=>auth.authorizeAndClaimWorkflow({...options,storage:saved,locks:{request:(_key,fn)=>fn()}});
 const pending=entry(authorize)('zerodha',7,choice,true,scoped);await entered;owner.setWorkflowOwner(8);complete();
 await assert.rejects(()=>pending,/owner changed/);
 assert.equal(JSON.parse(saved.getItem(auth.spendStorageKey(7,'india'))).state,'pending');
 assert.equal(saved.getItem(auth.spendStorageKey(8,'india')),null);
});

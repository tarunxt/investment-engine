import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('../app/console/dashboard/_components/RebalanceWorkflowSections.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('workflow.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const node=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='reserveAutoRebalanceRunMetadata');
const code=ts.transpileModule(node.getText(ast),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const choice={intent:'new_workflow',revision:0};
const authorization={spend_intent:'new_workflow',spend_request_id:'synthetic',spend_observed_revision:0,side_effect_policy:{version:1,mode:'analysis_only'}};
function load(api){return new Function('apiService','getAutoRebalancePortfolioKey','authorizeAndClaimWorkflow',code+';return reserveAutoRebalanceRunMetadata;')({getAutoRebalanceSpendReadiness:async()=>({paid_execution_available:true}),...api},()=> 'india',async options=>options.reserve(authorization));}
for(const policy of [undefined,null,{}, {version:0,mode:'analysis_only'}, {version:1,mode:'existing_preferences'}]){
 test(`unconfirmed opt-out fails before workflow starts: ${JSON.stringify(policy)}`,async()=>{
  const reserve=load({reserveAutoRebalanceRunLabel:async()=>({portfolio:'india',sequence:1,label:'Synthetic',side_effect_policy:policy})});
  await assert.rejects(()=>reserve('zerodha',7,choice,true),/server did not confirm/);
 });
}
test('confirmed suppression is forwarded alongside owner-aware cap consent',async()=>{
 const calls=[];const reserve=load({reserveAutoRebalanceRunLabel:async(...args)=>{calls.push(args);return {portfolio:'india',sequence:1,label:'Synthetic',side_effect_policy:{version:1,mode:'analysis_only'}}}});
 assert.equal((await reserve('zerodha',7,choice,true)).auto_rebalance_sequence,1);
 assert.deepEqual(calls,[['india',true,authorization]]);
});

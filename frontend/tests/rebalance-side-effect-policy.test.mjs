import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('../app/console/dashboard/_components/RebalanceWorkflowSections.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('workflow.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const node=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='reserveAutoRebalanceRunMetadata');
const code=ts.transpileModule(node.getText(ast),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
for(const policy of [undefined,null,{}, {version:0,mode:'analysis_only'}, {version:1,mode:'existing_preferences'}]){
  test(`unconfirmed opt-out fails before workflow starts: ${JSON.stringify(policy)}`,async()=>{
    const reserve=new Function('apiService','getAutoRebalancePortfolioKey',code+';return reserveAutoRebalanceRunMetadata;')({reserveAutoRebalanceRunLabel:async()=>({portfolio:'india',sequence:1,label:'Synthetic',side_effect_policy:policy})},()=> 'india');
    await assert.rejects(()=>reserve('zerodha',true),/server did not confirm/);
  });
}
test('confirmed policy is forwarded and normal legacy response remains compatible',async()=>{
  const calls=[];let confirmed=true;
  const reserve=new Function('apiService','getAutoRebalancePortfolioKey',code+';return reserveAutoRebalanceRunMetadata;')({reserveAutoRebalanceRunLabel:async(...args)=>{calls.push(args);return {portfolio:'india',sequence:1,label:'Synthetic',...(confirmed?{side_effect_policy:{version:1,mode:'analysis_only'}}:{})}}},()=> 'india');
  assert.equal((await reserve('zerodha',true)).auto_rebalance_sequence,1);
  confirmed=false;assert.equal((await reserve('zerodha')).auto_rebalance_sequence,1);
  assert.deepEqual(calls,[['india',true],['india',false]]);
});

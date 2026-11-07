import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('../app/console/automated-rebalance/_components/AutomatedRebalanceReliabilityBridge.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('bridge.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const names=['compactText','findMetricElement','inferStageFromText','inferMetricContext'];
const functions=ast.statements.filter(node=>ts.isFunctionDeclaration(node)&&names.includes(node.name?.text)).map(node=>node.getText(ast)).join('\n');
const compiled=ts.transpileModule(functions,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const {findMetricElement,inferMetricContext}=new Function(compiled+';return {findMetricElement,inferMetricContext}')();
for(const portfolio of ['india','indmoney_us'])for(const stage of ['threats','swing','rebalance','technical'])test(portfolio+' '+stage+' ledger metric has explicit context independent of surrounding titles',()=>{
 const root={parentElement:null};const metric={dataset:{autoRebalanceLlmMetric:'true',workflowStage:stage,workflowPortfolio:portfolio,workflowTotal:'2'},textContent:'Misleading Rebalance surrounding label',parentElement:root};
 assert.equal(findMetricElement({dataset:{},textContent:'2 / 2',parentElement:metric},root),metric);
 assert.deepEqual(inferMetricContext(metric,root),{portfolio,stage,expectedTotal:2});
});
test('unknown explicit market cannot select a saved-data owner',()=>{const root={parentElement:null,textContent:''};assert.equal(inferMetricContext({dataset:{workflowStage:'swing',workflowPortfolio:'untrusted',workflowTotal:'2'},textContent:'2 / 2',parentElement:root},root),null);});
test('malformed explicit totals do not select an invented exact job count',()=>{const root={parentElement:null};for(const total of ['-1','NaN','1.5','0'])assert.equal(inferMetricContext({dataset:{workflowStage:'swing',workflowPortfolio:'india',workflowTotal:total},textContent:'',parentElement:root},root).expectedTotal,null);});

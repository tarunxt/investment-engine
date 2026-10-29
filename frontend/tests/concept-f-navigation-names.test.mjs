import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const model={};new Function('exports',ts.transpileModule(readFileSync(new URL('../lib/conceptFNavigationNames.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(model);
test('navigation labels retain canonical identity separately and reject non-text overrides',()=>{
 assert.deepEqual(model.navigationLabel('India desk','Zerodha'),{label:'India desk',canonical:'Zerodha',custom:true});
 for(const value of [null,undefined,{},[],false,'  '])assert.deepEqual(model.navigationLabel(value,'Zerodha'),{label:'Zerodha',canonical:'Zerodha',custom:false});
});
test('display aliases are bounded and strip control/direction characters without becoming destinations',()=>{
 const value=model.navigationLabel('\u202eDesk\n'+('X'.repeat(80)),'INDmoney US');
 assert.equal(value.label.length,48);assert.doesNotMatch(value.label,/[\p{Cc}\p{Cf}]/u);assert.equal(value.canonical,'INDmoney US');
});
test('saved ranking reorders existing links only; unknown routes append without changing routes',()=>{
 const links=[{href:'/console/zerodha'},{href:'/console/indmoney-us'},{href:'/console/profile/activity'}];
 const ranked=[...links].sort((a,b)=>model.navigationRank(a.href,['/console/indmoney-us','/console/zerodha'])-model.navigationRank(b.href,['/console/indmoney-us','/console/zerodha']));
 assert.deepEqual(ranked.map(row=>row.href),['/console/indmoney-us','/console/zerodha','/console/profile/activity']);
 assert.deepEqual(links.map(row=>row.href),['/console/zerodha','/console/indmoney-us','/console/profile/activity']);
});

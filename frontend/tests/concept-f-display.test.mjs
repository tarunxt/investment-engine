import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const model={};new Function('exports',ts.transpileModule(readFileSync(new URL('../lib/workspaceDisplay.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(model);
test('display preferences persist only for their exact owner and contain no account data',()=>{
 const raw=JSON.stringify({schema:1,owner:7101,masked:false,density:'compact',module:'indmoney_us',balance:999});
 assert.deepEqual(model.readDisplay(raw,7101),{schema:1,owner:7101,masked:false,density:'compact',module:'indmoney_us'});
 assert.deepEqual(model.readDisplay(raw,7102),model.defaultDisplay(7102));assert.notEqual(model.displayKey(7101),model.displayKey(7102));
});
test('corrupt and legacy display states fail to masking with comfortable density',()=>{for(const raw of [null,'broken','null','{"schema":0,"owner":7101}','{"schema":1,"owner":7101,"masked":false,"density":"compact","module":"../../foreign"}'])assert.deepEqual(model.readDisplay(raw,7101),{schema:1,owner:7101,masked:true,density:'comfortable',module:null});});

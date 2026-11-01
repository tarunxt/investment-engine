import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
const source=readFileSync(new URL('../lib/runHierarchy.ts',import.meta.url),'utf8');
const context={exports:{}};
vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,context);
const {recordedStageRunLabel}=context.exports;
test('stage labels use recorded run association, independent of display order and failure state',()=>{
 const stages=[{stage:'technical',run_id:440},{stage:'swing',run_id:442},{stage:'rebalance',run_id:441}];
 assert.equal(recordedStageRunLabel(442,stages),'Swing Scan stage run');
 assert.equal(recordedStageRunLabel(441,stages),'Rebalance stage run');
 assert.equal(recordedStageRunLabel(440,stages),'Technical Scan stage run');
});
test('missing and multiple associations do not invent a single stage name',()=>{
 assert.equal(recordedStageRunLabel(442,[]),'Stage run (stage name unavailable)');
 assert.equal(recordedStageRunLabel(442,[{stage:'swing',run_id:442},{stage:'technical',run_id:442}]),'Swing Scan / Technical Scan stage run');
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
const source = readFileSync(new URL('../app/console/dashboard/_components/threatInputRationale.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
const { threatInputRationale: rationale } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const next = {id:'threats:next',source:'next',jobNo:'Upcoming run',label:'Upcoming portfolio snapshot',status:'reserved',error:null};
const saved = {id:'portfolio:zerodha:latest',source:'run-job',jobNo:'Latest snapshot',label:'Latest Zerodha portfolio snapshot',status:'synced',error:null};
const describe = (ids, options=[next,saved], loading=false, error=null) => rationale(options,new Set(ids),loading,error);
test('upcoming-only describes future reservation and excludes saved source',()=>{
 const text=describe([next.id]);
 assert.match(text,/1 source selected.*Included reservation: Upcoming run.*has not been generated.*Portfolio Sync must complete/);
 assert.match(text,/Not included: Latest snapshot/);
 assert.doesNotMatch(text,/Included saved source/);
});
test('saved-only includes exact reference without claiming upcoming input',()=>{
 const text=describe([saved.id]);
 assert.match(text,/1 source selected.*Included saved source: Latest snapshot \(Latest Zerodha portfolio snapshot\)/);
 assert.doesNotMatch(text,/Included reservation/);
});
test('mixed and empty selections match count and preserve input sets',()=>{
 const ids=new Set([next.id,saved.id]);
 assert.match(rationale([next,saved],ids,false,null),/2 sources selected.*Included reservation.*Included saved source/);
 assert.deepEqual([...ids],[next.id,saved.id]);
 const empty=describe([]);assert.match(empty,/0 sources selected.*No inputs are included/);
 assert.doesNotMatch(empty,/Included reservation|Included saved source/);
});
test('loading and failed reads do not assert verified inclusion',()=>{
 for(const text of [describe([next.id],[],true),describe([saved.id],[],false,'read failed')]) {
  assert.match(text,/1 source selected/);assert.doesNotMatch(text,/Included reservation|Included saved source/);
 }
});
test('confirmed missing and partial sources expose unmet prerequisites',()=>{
 assert.match(describe([saved.id],[next]),/Unmet source prerequisite: portfolio:zerodha:latest.*No saved snapshot is currently available/);
 assert.match(describe([saved.id],[{...saved,status:'partial',error:'Some holdings unavailable'}]),/Source prerequisite: review Latest snapshot \(partial: Some holdings unavailable\)/);
 assert.match(describe([],[]),/0 sources selected.*No saved snapshot is currently available/);
});

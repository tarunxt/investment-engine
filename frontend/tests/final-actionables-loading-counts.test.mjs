import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
const source = readFileSync(new URL('../app/console/_components/FinalActionablesConsole.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('console.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const fn = ast.statements.find(node => node.name?.text === 'calculationsCountSummary');
const fixtureModule = { exports: {} };
new Function('exports', ts.transpileModule(fn.getText(ast), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(fixtureModule.exports);
const summary = fixtureModule.exports.calculationsCountSummary;
test('slow and failed reads never fabricate empty counts', () => {
  for (const [loading, error] of [[true, null], [false, 'Request timed out'], [false, 'Unavailable']]) {
    assert.doesNotMatch(summary([], loading, error), /: 0|No stocks|No calculations/);
  }
  assert.match(summary([], true), /Loading/);
  assert.match(summary([], false, 'timeout'), /Unknown/);
});
test('verified empty and populated results retain exact counts', () => {
  assert.match(summary([], false), /view: 0\. Stocks: 0/);
  assert.match(summary([{ rows: [1, 2] }], false), /view: 2\. Stocks: 1/);
});
test('refresh preserves counts and labels retained evidence', () => {
  for (const [loading, error] of [[true, null], [false, 'timeout']]) {
    assert.match(summary([{ rows: [1] }], loading, error), /view: 1\. Stocks: 1\. Previously available/);
  }
  assert.match(source, /calculationsCountSummary\(displayedStocks, loading, loadError\)/);
});
const deadlineModule = { exports: {} };
new Function('exports', ts.transpileModule(readFileSync(new URL('../lib/finalActionablesReadDeadline.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(deadlineModule.exports);
const bounded = deadlineModule.exports.withFinalActionablesReadDeadline;
test('aggregate deadline rejects stalled reads, ignores late success, then permits recovery', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  await assert.rejects(bounded(pending, 5), /did not finish loading in time/);
  finish([{ id: 'synthetic-late' }]);
  assert.deepEqual(await bounded(Promise.resolve([{ id: 'synthetic-recovery' }]), 100), [{ id: 'synthetic-recovery' }]);
  await assert.rejects(bounded(Promise.reject(new Error('synthetic failure')), 100), /synthetic failure/);
});

test('slow complete reads remain recoverable until the hard deadline without dropping source IDs',async()=>{
 let finish;let notices=0;
 const pending=new Promise(resolve=>{finish=resolve;});
 const result=bounded(pending,100,()=>{notices++;},5);
 await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(notices,1);
 const history=Array.from({length:338},(_,id)=>({id:id+1,prompt:`complete historical source ${id+1}`}));
 finish(history);
 assert.deepEqual(await result,history);
});
test('hard deadline stops a stalled read and prevents a late success; timers clear after success/failure',async()=>{
 let finish;let notices=0;
 const pending=new Promise(resolve=>{finish=resolve;});
 await assert.rejects(bounded(pending,15,()=>{notices++;},5),/did not finish loading in time/);
 assert.equal(notices,1);finish([{id:'too late'}]);
 let lateNotices=0;
 await bounded(Promise.resolve([]),100,()=>{lateNotices++;},5);
 await assert.rejects(bounded(Promise.reject(new Error('failed read')),100,()=>{lateNotices++;},5),/failed read/);
 await new Promise(resolve=>setTimeout(resolve,10));assert.equal(lateNotices,0);
});

test('automatic technical polling does not restart an in-flight bounded history read',()=>{
 const scoped=source.slice(source.indexOf('function ScopedFinalActionablesConsole'));
 assert.match(scoped,/if \(!technicalScanIsActive \|\| technicalScanRunning \|\| loading\) return;/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync(new URL('../app/console/bullpen-ai/_components/bullpenStageOneEvidence.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.ESNext}});
const { getStageOneDialogEvidence: evidence } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const complete = { timerCompletedAt: '2026-11-01T00:00:00Z', outputs: {phase_status:'completed', total_items:0, accepted_candidates_count:0, active_positions_total:0, available_for_claim:[]} };
const flags = state => ['scanKnown','candidatesKnown','positionsKnown','claimsKnown'].map(key => state[key]);
for (const phase of ['failed','error','unavailable','unknown','incomplete','not_evaluated','blocked','aborted','cancelled','partial','running','pending']) {
  test(`${phase} source cannot turn fallback arrays/counts into verified zero`, () => {
    assert.deepEqual(flags(evidence({...complete, outputs:{...complete.outputs,phase_status:phase}})), [false,false,false,false]);
  });
}
test('loading and unavailable initial source stay unknown', () => {
  assert.deepEqual(flags(evidence({timerCompletedAt:null,outputs:{}})), [false,false,false,false]);
});
test('complete explicit empty totals and claim collection establish zero', () => {
  assert.deepEqual(flags(evidence(complete)), [true,true,true,true]);
});
test('success with missing/null collections and no totals does not establish zero', () => {
  assert.deepEqual(flags(evidence({...complete, outputs:{phase_status:'completed', accepted_candidates:null,active_positions_found:null, available_for_claim:null}})), [false,false,false,false]);
});
test('partial scan keeps totals unknown even with a completion timestamp', () => {
  assert.deepEqual(flags(evidence({...complete,outputs:{...complete.outputs,partial_scan:true}})), [false,false,false,false]);
});
test('dated successful nonempty saved totals remain known', () => {
  const saved = evidence({...complete,outputs:{...complete.outputs,total_items:12,accepted_candidates_count:2,active_positions_total:1}});
  assert.deepEqual(flags(saved), [true,true,true,true]);
  assert.match(saved.label,/Saved Stage 1 evidence.*2026-11-01T00:00:00Z/);
});
test('independent sources remain independent when one count is missing', () => {
  assert.deepEqual(flags(evidence({...complete,outputs:{...complete.outputs,active_positions_total:null}})), [true,true,false,true]);
});
test('incomplete full universe never implies complete empty counts', () => {
  assert.deepEqual(flags(evidence({...complete,outputs:{...complete.outputs,scan_scope:'full_universe',scan_completeness:'incomplete'}})), [false,false,false,false]);
});

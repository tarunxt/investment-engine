import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const source = readFileSync(new URL('../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx', import.meta.url), 'utf8');
const start = source.indexOf('              const isIncompleteUniverse =');
const end = source.indexOf('              const showStageSpinner', start);
assert.ok(start > 0 && end > start);
// Exercise the production display expressions with finished/running/legacy evidence.
const display = new Function('stage', 'isStageOneActive', `
const selectedRunSummaryTile = 'last';
const runIsActive = isStageOneActive;
const immediateSuccess = false, investPreviewFinished = false;
const workflowRunForMonitor = {}, stageOneResultSource = 'auto', independentStageOneView = null;
const displayedScanProgress = {scannedMarkets: 32502, currentPage: 30};
const getWorkflowToneClasses = tone => tone;
${source.slice(start, end)}
return {label:stageStatusLabel, progress:stageProgressLabel, percent:stageProgressPercent, tone:toneClasses};
`);
const stage = { key:'scan', state:'finished', timerCompletedAt:'2026-09-07', progressPercent:100, progressLabel:'32502/32502 events', tone:'green', outputs:{scan_scope:'full_universe',scan_completeness:'incomplete'}};
test('partial or unverified universe never claims full completion',()=>{
  for(const proof of ['incomplete', undefined]) {
    const result = display({...stage,outputs:{...stage.outputs,scan_completeness:proof}},false);
    assert.equal(result.label,'Incomplete');
    assert.equal(result.tone,'yellow');
    assert.equal(result.percent,0);
    assert.match(result.progress,/Partial results/);
  }
});
test('verified final cursor keeps completion and active scan keeps progress',()=>{
  assert.equal(display({...stage,outputs:{...stage.outputs,scan_completeness:'complete'}},false).label,'Finished');
  assert.equal(display(stage,true).label,'Working');
  assert.equal(display({...stage,outputs:{scan_scope:'trending'}},false).label,'Finished');
});

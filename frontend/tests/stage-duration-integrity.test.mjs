import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
// Execute the production pure calculations without a browser or provider calls.
const dateSource = read('../lib/datetime.ts').split('type FormatApiTimestampOptions')[0].replace('export function', 'function');
const dialogSource = read('../app/console/dashboard/_components/StageDurationBreakdownDialog.tsx');
const helpers = dialogSource.slice(dialogSource.indexOf('function parseTimestampMs'), dialogSource.indexOf('export function StageDurationBreakdownDialog'));
const { build, parse } = new Function(stripTypeScriptTypes(dateSource + helpers) + '\nreturn {build:buildDurationBreakdown,parse:parseTimestampMs};')();
const tileSource = read('../components/shared/WorkflowStageTile.tsx');
const tileHelpers = tileSource.slice(tileSource.indexOf('export function parseTimestampMs'), tileSource.indexOf('export function formatInrCost')).replaceAll('export function', 'function');
const tileDuration = new Function(stripTypeScriptTypes(tileHelpers) + '\nreturn formatDuration;')();
const info = {state:'completed',startedAt:'2026-01-01T00:00:00Z',endedAt:'2026-01-01T00:03:00Z'};
const job = (id, start, end) => ({job:{id,status:'completed',provider:'Synthetic',model:'Fixture',created_at:start,updated_at:end}});

test('naive UTC and offset-aware instants agree in every viewer timezone', () => {
  for (const zone of ['UTC','Asia/Kolkata','America/New_York']) {
    process.env.TZ = zone;
    assert.equal(parse('2026-01-01 00:00:00'),parse('2026-01-01T05:30:00+05:30'));
    assert.equal(build({...info,startedAt:'2026-01-01 00:00:00'},null,0).totalDuration,'00:03:00');
  }
});
test('negative intervals remain explicit in both the tile and popup', () => {
  const bad = {...info,endedAt:'2025-12-31T23:59:59Z'};
  assert.match(build(bad,null,0).totalDuration,/Invalid interval/);
  assert.match(tileDuration(bad.startedAt,bad.endedAt),/Invalid interval/);
});
test('parallel job rows are individual windows and the residual is unattributed', () => {
  const run={run_jobs:[job(1,'2026-01-01T00:00:00Z','2026-01-01T00:02:00Z'),job(2,'2026-01-01T00:00:30Z','2026-01-01T00:02:30Z')]};
  const saved=JSON.stringify(run);
  const result=build(info,run,0);
  assert.equal(result.totalDuration,'00:03:00');
  assert.deepEqual(result.steps.map(x=>x.duration),['00:00:00','00:02:00','00:02:00','00:00:30']);
  assert.match(result.steps.at(-1).label,/Unattributed/);
  assert.match(result.steps.at(-1).detail,/not a measured phase/);
  assert.equal(JSON.stringify(run),saved);
});
test('missing terminal updates never fall back to the current clock', () => {
  const result=build(info,{run_jobs:[job(1,'2026-01-01T00:00:00Z',null)]},Date.now());
  assert.equal(result.steps[1].duration,'n/a');
  assert.equal(result.steps.at(-1).duration,'n/a');
});
test('empty, missing, invalid and active stage timestamps preserve uncertainty', () => {
  for (const run of [null,{run_jobs:[]}]) {
    assert.equal(build({state:'completed'},run,Date.now()).totalDuration,'n/a');
    assert.equal(build(info,run,0).steps.filter(x=>x.duration==='Not recorded').length,2);
  }
  assert.equal(parse('invalid'),null);
  assert.equal(build({...info,endedAt:null},null,Date.now()).totalDuration,'n/a');
  assert.equal(build({...info,state:'processing',endedAt:null},null,Date.parse(info.endedAt)).totalDuration,'00:03:00');
});
test('negative job windows and phase gaps are never silently clamped', () => {
  const result=build(info,{run_jobs:[job(1,'2026-01-01T00:00:30Z','2026-01-01T00:00:29Z')]},0);
  assert.match(result.steps[1].duration,/Invalid interval/);
  const before=build(info,{run_jobs:[job(1,'2025-12-31T23:59:59Z','2026-01-01T00:04:00Z')]},0);
  assert.match(before.steps[0].duration,/Invalid interval/);
  assert.match(before.steps.at(-1).duration,/Invalid interval/);
});

test('capture precision preserves even subsecond negative intervals', () => {
  const precise = {...info,startedAt:'2026-01-01T00:00:00.900Z',endedAt:'2026-01-01T00:00:00.800Z'};
  assert.match(build(precise,null,0).totalDuration,/Invalid interval/);
  assert.match(tileDuration(precise.startedAt,precise.endedAt),/Invalid interval/);
});

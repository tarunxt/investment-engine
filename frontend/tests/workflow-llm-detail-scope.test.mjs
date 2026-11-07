import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const loadedModule = { exports: {} };
const text = readFileSync(new URL('../lib/workflowLlmDetailScope.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
new Function('exports', 'module', compiled)(loadedModule.exports, loadedModule);
const { selectWorkflowStageJobs, describeWorkflowJobs, describeRecentJobs, describeSavedThreat } = loadedModule.exports;
const job = id => ({ id, provider: 'synthetic-provider', model: 'synthetic-model', status: 'completed', prompt: 'Historical threat context is not stage attribution', response: 'Saved synthetic evidence', estimated_cost: 0, created_at: '2020-01-01T00:00:00Z', updated_at: '2020-01-01T00:01:00Z', output_provenance: { source: 'api_usage_attempt_events', identities: [{ provider: 'synthetic-provider', model: 'synthetic-model' }], observed_from: '2020-01-01T00:00:00Z', observed_to: '2020-01-01T00:01:00Z' } });
const fixture = () => ({ portfolio: 'india', sequence: 213, label: 'India Run #213', stages: [{ stage: 'threats', job_id: 2266, run_id: null }, { stage: 'swing', run_id: 464 }, { stage: 'rebalance', run_id: 465 }, { stage: 'technical', run_id: 466 }], runs: [464, 465, 466].map((id, i) => ({ id, prompt: 'Prior threat context; do not guess membership', jobs: [job(2267 + i)] })), standalone_jobs: [job(2266)] });
const freeze = value => { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); } return value; };

test('live-shaped workflow213 selects only standalone Threats2266; unrelated prompts cannot widen membership', () => {
  const detail = freeze(fixture()), before = JSON.stringify(detail);
  const selected = selectWorkflowStageJobs(detail, 'threats');
  assert.deepEqual(selected.jobs.map(j => j.id), [2266]); assert.equal(selected.warning, null);
  assert.equal(selected.jobs[0], detail.standalone_jobs[0]);
  const provenance = describeWorkflowJobs(detail, selected.jobs)[2266];
  assert.equal(provenance.stage, 'threats'); assert.equal(provenance.evidence, 'job-link'); assert.equal(provenance.standalone, true); assert.deepEqual(provenance.runIds, []);
  assert.equal(JSON.stringify(detail), before); assert.equal(selected.jobs[0].estimated_cost, 0); assert.equal(selected.jobs[0].updated_at, '2020-01-01T00:01:00Z'); assert.equal(selected.jobs[0].output_provenance, detail.standalone_jobs[0].output_provenance);
});
for (const [stage, runId, jobId] of [['swing', 464, 2267], ['rebalance', 465, 2268], ['technical', 466, 2269]]) test(stage + ': only the explicit saved run is included', () => {
  const detail = fixture(), selected = selectWorkflowStageJobs(detail, stage), attribution = describeWorkflowJobs(detail, selected.jobs)[jobId];
  assert.deepEqual(selected.jobs.map(j => j.id), [jobId]); assert.equal(attribution.stage, stage); assert.equal(attribution.evidence, 'run-link'); assert.deepEqual(attribution.runIds, [runId]);
});
test('absent or missing stage links are explicit unavailability, not guessed prompt matches', () => {
  const detail = fixture(); detail.stages = [{ stage: 'threats', run_id: null, job_id: null }];
  const missing = selectWorkflowStageJobs(detail, 'threats'); assert.deepEqual(missing.jobs, []); assert.match(missing.warning, /No saved run\/job link/);
  detail.stages = [{ stage: 'threats', job_id: 9999 }]; const absent = selectWorkflowStageJobs(detail, 'threats'); assert.deepEqual(absent.jobs, []); assert.match(absent.warning, /Job #9999/);
});
test('unrelated run payload omission cannot hide a valid standalone stage record', () => {
  const detail = fixture(); delete detail.runs[0].jobs; const selected = selectWorkflowStageJobs(detail, 'threats');
  assert.deepEqual(selected.jobs.map(j => j.id), [2266]); assert.equal(describeWorkflowJobs(detail, selected.jobs)[2266].stage, 'threats');
});
test('conflicting job/run links remain Unknown with both actual links retained', () => {
  const detail = fixture(); detail.stages.push({ stage: 'threats', job_id: 2267 }); const selected = selectWorkflowStageJobs(detail, 'threats');
  const attribution = describeWorkflowJobs(detail, selected.jobs)[2267]; assert.equal(attribution.stage, null); assert.deepEqual(attribution.jobStageLinks, ['threats']); assert.deepEqual(attribution.runStageLinks, ['swing']); assert.deepEqual(attribution.runIds, [464]);
});
test('all jobs in a linked run retain status, errors, Unknown/zero costs and ordering', () => {
  const detail = fixture(); detail.runs[0].jobs.push({ ...job(2300), status: 'partial', estimated_cost: null, error_message: 'Retained partial notice' }); const selected = selectWorkflowStageJobs(freeze(detail), 'swing');
  assert.deepEqual(selected.jobs.map(j => j.id), [2267, 2300]); assert.equal(selected.jobs[1], detail.runs[0].jobs[1]); assert.equal(selected.jobs[1].estimated_cost, null); assert.equal(selected.jobs[1].status, 'partial'); assert.equal(selected.jobs[1].error_message, 'Retained partial notice');
});
test('fallback provenance does not turn prompt guesses or source labels into a run/stage ID', () => {
  const item = job(2266); const recent = describeRecentJobs([{ id: 700, run_jobs: [{ job: item }] }], [item])[2266]; assert.equal(recent.stage, null); assert.deepEqual(recent.runIds, [700]);
  const analysis = describeSavedThreat(2266)[2266]; assert.equal(analysis.stage, 'threats'); assert.equal(analysis.evidence, 'analysis-endpoint'); assert.deepEqual(analysis.runIds, []);
});

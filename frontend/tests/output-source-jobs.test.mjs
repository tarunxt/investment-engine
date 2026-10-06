import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const modules = {};
function load(path) {
  const compiled = ts.transpileModule(read(path), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const exports = {};
  new Function('exports', 'require', 'crypto', compiled)(exports, (name) => {
    assert.ok(modules[name], `Unexpected import ${name}`);
    return modules[name];
  }, webcrypto);
  return exports;
}
modules['@/lib/rebalanceRunIdentity'] = load('../lib/rebalanceRunIdentity.ts');
modules['@/lib/rebalanceStageInputs'] = load('../lib/rebalanceStageInputs.ts');
const { buildOutputSourceJobs, outputSourceJobsForPrompt } = load('../lib/outputSourceJobs.ts');
const hash = (text) => createHash('sha256').update(text).digest('hex');
function run(jobIds = [11, 12]) {
  const metadata = { prompt: 'India swing-trade study', auto_rebalance_portfolio: 'india',
    auto_rebalance_label: 'India Run #1 (Swing Scan)', status: 'completed' };
  return { id: 5, ...metadata, run_jobs: jobIds.map((id) => ({ run_id: 5, job_id: id, stage: 1,
    job: { id, ...metadata, response: 'Exact original ₹ source\n  whitespace. ' } })) };
}

test('same-content independent samples remain separate; exact repeated delivery deduplicates only its ID', async () => {
  const source = run();
  const before = structuredClone(source);
  const refs = await buildOutputSourceJobs([source, source], 'india');
  assert.deepEqual(refs, [11, 12].map((id) => ({ run_id: 5, job_id: id,
    response_sha256: hash(source.run_jobs[0].job.response) })));
  assert.deepEqual(source, before);
});

test('partial runs retain original failed/empty sibling text and index only available completed/partial responses', async () => {
  const source = run([11, 12, 13, 14]);
  source.status = 'partial';
  source.run_jobs[1].job.status = 'partial';
  source.run_jobs[2].job.status = 'failed';
  source.run_jobs[3].job.response = null;
  const before = structuredClone(source);
  const refs = await buildOutputSourceJobs([source], 'india');
  assert.deepEqual(refs.map((ref) => ref.job_id), [11, 12]);
  assert.deepEqual(source, before);
});

test('changed duplicate representation and oversized evidence fail without truncation', async () => {
  const source = run([11]);
  const changed = structuredClone(source);
  changed.run_jobs[0].job.response += 'changed';
  await assert.rejects(buildOutputSourceJobs([source, changed], 'india'), /conflicting/);
  source.run_jobs[0].job.response = 'é'.repeat(1_000_001);
  await assert.rejects(buildOutputSourceJobs([source], 'india'), /UTF-8 bytes/);
  await assert.rejects(buildOutputSourceJobs([run(Array.from({ length: 201 }, (_, i) => i + 1))], 'india'), /At most 200/);
});

test('manual prompt binding checks exact bundle; removed or changed selection stays unchecked', async () => {
  const selection = { runs: [run()], market: 'india', inputBundle: 'exact selected bundle' };
  assert.equal((await outputSourceJobsForPrompt(`[REBALANCE_FLOW:india]\ncustom instructions\n\n${selection.inputBundle}`, selection)).length, 2);
  assert.equal(await outputSourceJobsForPrompt('custom prompt without bundle', selection), undefined);
  assert.equal(await outputSourceJobsForPrompt(selection.inputBundle, null), undefined);
  assert.equal(await outputSourceJobsForPrompt(`unclassified instructions\n\n${selection.inputBundle}`, selection), undefined);
  assert.equal(await outputSourceJobsForPrompt(`[REBALANCE_FLOW:us]\n\n${selection.inputBundle}`, selection), undefined);
});

test('both submission paths add evidence beside existing prompts/options', () => {
  const automatic = read('../app/console/dashboard/_components/RebalanceWorkflowSections.tsx');
  assert.match(automatic, /\.\.\.buildRunPayload\(\{[\s\S]*?scanLabel: "Rebalance Scan",\s*\}\), output_source_jobs: outputSourceJobs/);
  const manual = read('../app/console/dashboard/_context.tsx');
  assert.match(manual, /prompt: trimmedPrompt,\s*targets,\s*output_source_jobs: await outputSourceJobsForPrompt\(trimmedPrompt, outputSourceSelection\)/);
  for (const option of ['scheduled_at', 'allow_parallel', 'auto_export_enabled', 'export_spreadsheet_url',
    'export_sheet_name', 'export_investment_amount', 'export_title']) assert.ok(manual.includes(`${option}:`));
});

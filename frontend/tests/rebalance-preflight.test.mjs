import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
function load(path) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('exports', code)(exports);
  return exports;
}
const { collectPreflightErrors } = load('../lib/rebalancePreflight.ts');
const { validateTechnicalInstruments, resolveTechnicalPriceEvidence } = load('../lib/technicalPriceEvidence.ts');

test('all independent failures are collected, including synchronous failures', async () => {
  const errors = await collectPreflightErrors([
    {label:'Models', run:async()=>{throw new Error('Choose a configured model');}},
    {label:'Snapshot', run:async()=>({id:1})},
    {label:'Inputs', run:()=>{throw new Error('Missing saved job');}},
  ]);
  assert.deepEqual(errors, ['Models — Choose a configured model', 'Inputs — Missing saved job']);
  assert.deepEqual(await collectPreflightErrors([]), []);
});

test('the observed TVS MOTOR label names the bad entry before calling quotes', async () => {
  let reads = 0;
  await assert.rejects(resolveTechnicalPriceEvidence(['NSE:BEL', 'NSE:TVS MOTOR'], async()=>{reads++;}), /NSE:TVS MOTOR.*Correct the source/);
  assert.equal(reads, 0);
});

test('exact identities remain distinct and duplicate instruments are removed', () => {
  assert.deepEqual(validateTechnicalInstruments(['NSE:M&M', 'BSE:M&M', 'NSE:M&M']), ['NSE:M&M','BSE:M&M']);
  for (const keys of [[], ['US:BEL'], ['NSE:'], Array.from({length:501}, (_,i)=>`NSE:S${i}`)]) {
    assert.throws(()=>validateTechnicalInstruments(keys));
  }
  assert.equal(validateTechnicalInstruments(Array.from({length:500}, (_,i)=>`NSE:S${i}`)).length,500);
});

test('Run checks and handles errors before resetting stages or reserving a workflow', () => {
  const source = readFileSync(new URL('../app/console/dashboard/_components/RebalanceWorkflowSections.tsx', import.meta.url), 'utf8');
  const run = source.slice(source.indexOf('  const runWorkflow = useCallback('));
  const checked = run.indexOf('errors = await collectPreflightErrors(checks)');
  const blocked = run.indexOf('if (errors.length || !isCurrentWorkflowOwner(runtimeOwner))');
  assert.ok(checked > 0 && blocked > checked);
  for (const operation of ['resetPortfolio(portfolio)', 'reserveAutoRebalanceRunMetadata(portfolio', 'markRunning(portfolio, "sync")', 'apiService.createRun(']) {
    assert.ok(run.indexOf(operation) > blocked, operation);
  }
  assert.match(run.slice(0, checked), /Stage 2 publication/);
  assert.match(run.slice(0, checked), /sourceSelections/);
  assert.match(run.slice(0, checked), /unavailable selected models/);
  assert.match(run.slice(0, checked), /read\(id\)/);
  assert.match(source, /Pre-run checks found issues/);
  assert.match(source, /preflightPortfolio === section.portfolio \? "Checking…"/);
});

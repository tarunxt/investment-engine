import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
// All run/job/workflow IDs, timestamps and counts below are arbitrary synthetic fixtures.
// Execute the real read-only hydration callback against synthetic API results.
const source = readFileSync(process.env.A7_L05_SOURCE ?? new URL('../app/console/dashboard/_components/RebalanceWorkflowSections.tsx', import.meta.url), 'utf8');
const functions = ['summarizeAutoRebalanceHistoryStage', 'getAutoRebalanceSummaryNumber', 'getLatestAutoRebalanceHistoryItem'].map(name => {
  const start = source.indexOf(`function ${name}(`);
  return source.slice(start, source.indexOf('\nfunction ', start + 1));
});
const start = source.indexOf('  const loadLatestIdleStageInfo = useCallback(async () => {');
const code = ts.transpileModule([...functions, source.slice(start, source.indexOf('\n  useEffect(() => {', start)), 'return loadLatestIdleStageInfo;'].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const mergeCode = readFileSync(new URL('../lib/stockFlowEvidence.ts', import.meta.url), 'utf8').split('export function mergeStageEvidence')[1];
const mergeStageEvidence = new Function(ts.transpileModule('function mergeStageEvidence' + mergeCode + '\nreturn mergeStageEvidence;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)();
const stages = ['sync', 'threats', 'swing', 'rebalance', 'technical', 'actionables'];
const oldTime = '2026-10-30T12:00:00Z', newTime = '2026-11-01T12:00:00Z';
const record = (status, count) => ({ portfolio: 'india', sequence: 7, created_at: newTime, updated_at: newTime, completed_at: newTime, stages: [{ stage: 'actionables', status, started_at: newTime, completed_at: newTime, run_id: 10, job_id: 20, provider_count: 2, completed_provider_count: 1, failed_provider_count: 1, partial_provider_count: 0, estimated_cost: 0, summary: { recommended_stocks: count } }] });
async function hydrate({ runs = [], histories = [], initial, historyFailure, onError = () => {} } = {}) {
  let states = initial ?? Object.fromEntries(['zerodha', 'indmoneyUs'].map(market => [market, Object.fromEntries(stages.map(stage => [stage, { state: 'idle' }]))]));
  const apiService = Object.fromEntries(['zerodhaPortfolioOverview', 'indmoneyUsPortfolioOverview', 'zerodhaThreatsLatest', 'indmoneyUsThreatsLatest'].map(key => [key, async () => ({})]));
  apiService.getAutoRebalanceHistory = async market => { if (historyFailure) throw historyFailure; return { items: market === 'india' ? histories : [] }; };
  const context = {
    setWorkflowHistoryError: onError, normalizeError: error => error.message,
    apiService, fetchDashboardRecentFullRuns: async () => runs, useCallback: fn => fn, usdInrRate: 1,
    getLatestStageRun: (rows, stage, market) => market === 'india' ? rows.find(row => row.stage === stage) : undefined,
    getLatestMatchingRebalanceRuns: (rows, market) => market === 'india' ? rows.filter(row => row.stage === 'rebalance') : [],
    getLatestRunTimestamp: run => run.updated_at, parseTimestampMs: time => Date.parse(time ?? '') || 0,
    buildConsensusRows: rows => rows.flatMap(row => Array.from({length: row.stocks ?? 0}, () => ({}))),
    countUniqueStocksFromRun: run => run.stocks,
    summarizeRunForIdleTile: run => run ? { completedAt: run.updated_at, runStatus: run.status, lastRunId: run.id } : {},
    withInrCost: value => value,
    mergeStageEvidence,
    STAGE_ORDER: stages, setStates: updater => { states = updater(states); },
  };
  await new Function(...Object.keys(context), code)(...Object.values(context))();
  return states;
}
test('failed technical timestamp and historical count sources remain explicit after repeated hydration', async () => {
  const runs = [{id: 101, stage: 'rebalance', status: 'completed', updated_at: oldTime, stocks: 11}, {id: 102, stage: 'technical', status: 'failed', updated_at: newTime, stocks: null}];
  const before = structuredClone(runs), result = await hydrate({runs}), summary = result.zerodha.actionables;
  assert.equal(summary.state, 'idle');
  assert.equal(summary.evidence.kind, 'derived');
  assert.equal(summary.recommendedStocks, 11);
  assert.ok(summary.evidence.references.some(value => value.includes('Timestamp source: run #102 · failed')));
  assert.ok(summary.evidence.references.some(value => value.includes('Stock-count source: run #101 · completed')));
  assert.deepEqual(runs, before);
  assert.deepEqual(await hydrate({runs}), result);
});
test('saved final record preserves its own workflow, job, zero, partial and terminal status', async () => {
  for (const [status, count] of [['completed', 0], ['partial', 3], ['failed', null], ['interrupted', null]]) {
    const histories = [record(status, count)], before = structuredClone(histories);
    const result = (await hydrate({histories})).zerodha.actionables;
    assert.equal(result.evidence.kind, 'saved');
    assert.equal(result.runStatus, status);
    assert.equal(result.recommendedStocks ?? null, count);
    assert.ok(result.evidence.references.some(value => value.includes('india workflow #7')));
    assert.ok(result.evidence.references.includes('Job #20'));
    assert.deepEqual(histories, before);
  }
});
test('missing evidence stays unknown and hydration cannot overwrite an active failed stage', async () => {
  const result = await hydrate();
  assert.equal(result.zerodha.actionables.completedAt, null);
  assert.equal(result.zerodha.actionables.recommendedStocks, null);
  assert.equal(result.zerodha.actionables.evidence, undefined);
  result.zerodha.technical = { state: 'failed', lastRunId: 301, error: 'Synthetic timeout' };
  const reloaded = await hydrate({initial: result});
  assert.deepEqual(reloaded.zerodha.technical, result.zerodha.technical);
});

test('default reconciliation remains unchanged and newer derivation can supersede older saved final', () => {
  const observed = {completedAt: newTime, evidence: {kind: 'derived'}};
  const saved = {completedAt: newTime, evidence: {kind: 'saved'}};
  assert.equal(mergeStageEvidence(observed, saved).evidence.kind, 'derived');
  assert.equal(mergeStageEvidence(observed, saved, true).evidence.kind, 'saved');
  assert.equal(mergeStageEvidence(observed, {...saved, completedAt: oldTime}, true).evidence.kind, 'derived');
});

test('history read failure is unavailable and cannot replace saved evidence with empty history', async () => {
  const initial = await hydrate({histories: [record('completed', 3)]});
  let error;
  const result = await hydrate({initial, historyFailure: Error('Workflow schema is not ready'), onError: value => {error=value;}});
  assert.match(error, /Saved workflow history unavailable.*Workflow schema is not ready/);
  assert.deepEqual(result, initial);
  await hydrate({initial, onError: value => {error=value;}});
  assert.equal(error, null);
});

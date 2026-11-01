// Characterization only: changing these expectations requires an approved score policy.
// Node 22.18+ can load the production TypeScript helpers without provider or UI dependencies.
import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateWeightedRationaleScore, isScoreMatrixRowOutOfBounds } from '../lib/scoreMatrixMath.ts';
import { historicalMean, allocateDisplayScores, defaultDisplayParameters, displayScoreAccepted } from '../lib/basketDisplayCalculations.ts';

const bounded = (score, multiplier, extra = {}) => ({score, multiplier, validationRule: {min: -3, max: 3}, ...extra});
const fixture = () => [
  ...[3,3,2,1,3,1].map(weight => bounded(3, weight)),
  bounded(8.8, 1, {denominatorWeight: 2, outOfBoundsDenominatorWeight: 3, validationRule: {min: 0, max: 10}}),
  bounded(3, 0, {validationRule: {min: -3, max: 3, integerOnly: true}}),
  bounded(3, 5, {validationRule: {min: -3, max: 3, integerOnly: true}}),
  bounded(2.5, 4),
];
const timestamp = '2026-10-28T12:00:00Z';
const observation = score => ({id: 1, run_id: 1, symbol: 'SYNTH', exchange: 'NSE', covered_at: timestamp, score, action: 'Add more', formula_version: 'score-matrix-v1', completed: true, coverage_status: 'suggested'});
const history = score => ({market: 'india', symbols: ['SYNTH'], as_of: timestamp, window_start: '2026-10-23T12:00:00Z', timezone: 'UTC', days: 5, truncated: false, observations: [observation(score)], notes: []});

test('F04 characterization: component-valid default rows produce 72.8/24 and disappear from historical allocation', () => {
  const rows = fixture(), original = structuredClone(rows);
  assert.ok(rows.every(row => !isScoreMatrixRowOutOfBounds(row)));
  const result = calculateWeightedRationaleScore(rows);
  assert.equal(result.denominator, 24);
  assert.equal(result.finalScore, 72.8 / 24);
  assert.equal(result.finalScore, 3.033333333333333);
  const saved = history(result.finalScore), before = structuredClone(saved);
  const mean = historicalMean(saved, 'SYNTH', 'NSE');
  assert.deepEqual(mean, {rows: [], sum: 0, score: null});
  assert.equal(allocateDisplayScores([{key: 'NSE:SYNTH', score: mean.score}], defaultDisplayParameters()).weights.size, 0);
  assert.equal(displayScoreAccepted(result.finalScore, -2.5, 1.5, false), false);
  assert.equal(displayScoreAccepted(result.finalScore, -2.5, 1.5, true), true);
  assert.deepEqual(rows, original);
  assert.deepEqual(saved, before);
});

test('F04 characterization: reader boundaries, missing, malformed and current partial sources', () => {
  for (const score of [-3, 0, 3]) assert.equal(historicalMean(history(score), 'SYNTH', 'NSE').score, score);
  for (const score of [-3.000001, 3.000001, null, NaN, Infinity]) assert.equal(historicalMean(history(score), 'SYNTH', 'NSE').score, null);
  const empty = {...history(null), observations: []};
  const current = {symbol: 'SYNTH', exchange: 'NSE', market: 'india', calculatedAt: timestamp, score: 3, sources: [{runId: 2, createdAt: timestamp, completed: false, status: 'partial', market: 'india'}]};
  assert.equal(historicalMean(empty, 'SYNTH', 'NSE', current).score, 3);
  for (const score of [72.8/24, -72.8/24, null]) assert.equal(historicalMean(empty, 'SYNTH', 'NSE', {...current, score}).score, null);
  for (const status of ['failed', 'processing']) assert.equal(historicalMean(empty, 'SYNTH', 'NSE', {...current, sources: [{...current.sources[0], status}]}).score, null);
  assert.equal(historicalMean(empty, 'SYNTH', 'NSE', {...current, sources: [{...current.sources[0], createdAt: empty.window_start}]}).score, null);
  assert.deepEqual(historicalMean(empty, 'SYNTH', 'NSE', current), historicalMean(empty, 'SYNTH', 'NSE', current));
});

test('F04 characterization: user denominator remains authoritative and missing inputs retain existing semantics', () => {
  assert.equal(calculateWeightedRationaleScore(fixture(), 30).finalScore, 72.8/30);
  const rows = fixture(); rows[6].score = null;
  assert.deepEqual(calculateWeightedRationaleScore(rows), {finalScore: 64/22, denominator: 22});
  assert.deepEqual(calculateWeightedRationaleScore([bounded(null, 3)]), {finalScore: null, denominator: 0});
  assert.deepEqual(calculateWeightedRationaleScore([bounded(0, 3)]), {finalScore: 0, denominator: 3});
  assert.deepEqual(calculateWeightedRationaleScore([bounded(NaN, 3)]), {finalScore: null, denominator: 0});
});

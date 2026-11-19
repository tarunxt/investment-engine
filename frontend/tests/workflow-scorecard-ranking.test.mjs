import assert from 'node:assert/strict';
import test from 'node:test';
import { readScorecardManifest, workflowRanking, weightedSigned } from '../lib/workflowScorecardRanking.ts';

const listing = 'NSE:OIL';
const base = -1.55;
const listings = [{exchange: 'NSE', symbol: 'OIL', effectiveScore: base}];
const pairRow = value => ({Listing: listing, 'Pairwise /100': value, 'Valid comparisons': '2'});
const threatRow = value => ({Exchange: 'NSE', 'Stock Symbol': 'OIL', 'Stock Threat /100': value});
function ranking(pairs, threats) {
  return workflowRanking(listings, {tables: [
    {key: 'pairwise_scores', rows: pairs}, {key: 'stock_threat_scores', rows: threats},
  ]})[0];
}

test('all scorecard combinations agree across signed and 100-point scales', () => {
  for (const pair of [null, 0, 100]) for (const threat of [null, 0, 100]) {
    const row = ranking(pair === null ? [] : [pairRow(String(pair))], threat === null ? [] : [threatRow(String(threat))]);
    const signed = weightedSigned(base, {pairwise: pair, stock_threat: threat});
    assert.equal(row.pairwise, pair);
    assert.equal(row.stock_threat, threat);
    assert.equal(row.score, (signed + 3) * 100 / 6);
  }
  assert.equal(ranking([pairRow('0')], []).score.toFixed(2), '23.92');
});

test('duplicates and malformed observations cannot replace unique evidence', () => {
  assert.equal(ranking([pairRow('0'), pairRow('100')], []).pairwise, null);
  assert.equal(ranking([pairRow('')], [threatRow('101')]).stock_threat, null);
  const row = {listing, pairwise: 0, stock_threat: null};
  const manifest = rows => '[WORKFLOW_SCORECARDS_V1]' + JSON.stringify({job_id: 15, rows});
  assert.equal(readScorecardManifest(manifest([row,row])), null);
  assert.equal(readScorecardManifest(manifest([row])).get(listing).comparisons, null);
  assert.equal(readScorecardManifest(manifest([{...row, comparisons: 2}])).get(listing).comparisons, 2);
});

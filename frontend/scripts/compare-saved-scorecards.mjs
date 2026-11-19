// Run with Node 22.18+: node scripts/compare-saved-scorecards.mjs saved-replay.json [valuation.json]
import { readFile } from 'node:fs/promises';
import { allocateIndiaEquities } from '../lib/basketDisplayCalculations.ts';

const [recordPath, valuationPath] = process.argv.slice(2);
if (!recordPath) throw new Error('Supply the saved workflow-final-v2 JSON and optionally a matching valuation snapshot.');
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const record = await read(recordPath);
if (record.schema !== 'workflow-final-v2' || record.broker !== 'india' || record.formula_version !== 'score-matrix-v2')
  throw new Error('Expected a saved India workflow-final-v2 score-matrix-v2 calculation.');
const valuation = valuationPath ? await read(valuationPath) : null;
// Valuation supplies asOf, sequence, assets, parameters and listings keyed by exchange:symbol.
// Each listing supplies isin, holding, price and priorScores (eligible observations excluding current).
if (valuation && (valuation.sequence !== record.workflow_sequence || !Number.isFinite(Date.parse(valuation.asOf)) ||
    !(valuation.assets > 0) || !valuation.parameters?.valid)) throw new Error('Incomplete or mismatched valuation snapshot.');
const cards = new Map(record.actionable_ranking.rows.map(row => [row.listing, row]));
if (cards.size !== record.rows.length || cards.size !== record.actionable_ranking.rows.length)
  throw new Error('Incomplete or ambiguous saved ranking.');
function scenario(baseWeight, pairWeight, threatWeight) {
  const rows = record.rows.map(row => {
    const key = row.exchange + ':' + row.symbol;
    const card = cards.get(key);
    if (!card) throw new Error('Missing saved scorecard for ' + key);
    const inputs = row.formula_inputs;
    const base = inputs.detailedRationaleFinalScore ?? inputs.meanScore;
    const components = [[base, baseWeight], [card.pairwise == null ? null : card.pairwise * 0.06 - 3, pairWeight],
      [card.stock_threat == null ? null : (100 - card.stock_threat) * 0.06 - 3, threatWeight]];
    const available = components.filter(([value]) => value != null);
    const signed = base == null ? null : available.reduce((sum, [value, weight]) =>
      sum + Math.max(-3, Math.min(3, value)) * weight, 0) / available.reduce((sum, [, weight]) => sum + weight, 0);
    if (baseWeight === 98 && ((signed == null) !== (row.effectiveScore == null) ||
        (signed != null && Math.abs(signed - row.effectiveScore) > 1e-8))) throw new Error('Baseline mismatch for ' + key);
    return {key, signed};
  }).sort((a,b) => (b.signed ?? -Infinity) - (a.signed ?? -Infinity) || a.key.localeCompare(b.key));
  let allocation = null;
  if (valuation) {
    const listings = rows.map(({key,signed}) => {
      const snapshot = valuation.listings[key];
      if (!snapshot?.isin || !(snapshot.price > 0) || !Number.isSafeInteger(snapshot.holding) || snapshot.holding < 0 ||
          !Array.isArray(snapshot.priorScores) || !snapshot.priorScores.every(Number.isFinite))
        throw new Error('Missing pricing, holdings, identity or history for ' + key);
      const values = signed == null ? snapshot.priorScores : [...snapshot.priorScores, signed];
      return {...snapshot, key, score: values.length ? values.reduce((a,b) => a+b,0)/values.length : null};
    });
    const {venues} = allocateIndiaEquities(listings, valuation.parameters, valuation.assets);
    allocation = listings.map(row => {
      const shares = venues.get(row.key)?.shares;
      if (shares == null) throw new Error('Incomplete target for ' + row.key);
      return {listing: row.key, shares, targetRupees: shares * row.price, tradeRupees: (shares-row.holding)*row.price};
    });
  }
  return {weights:[baseWeight,pairWeight,threatWeight], rows, allocation};
}
const baseline = scenario(98,1,1);
for (const current of [baseline, scenario(90,5,5), scenario(80,10,10)]) {
  const old = new Map(baseline.allocation?.map(row => [row.listing,row]));
  const changes = current.allocation?.map(row => ({...row, targetChangeRupees:row.targetRupees-old.get(row.listing).targetRupees}));
  console.log(JSON.stringify({sequence:record.workflow_sequence, valuationAsOf:valuation?.asOf ?? null,
    weights:current.weights, changedRanks:current.rows.filter((row,i)=>row.key !== baseline.rows[i].key).length,
    rankings:current.rows, allocation:changes ?? null,
    entries:changes?.filter(row=>row.shares>0 && old.get(row.listing).shares===0).map(row=>row.listing) ?? null,
    exits:changes?.filter(row=>!row.shares && old.get(row.listing).shares>0).map(row=>row.listing) ?? null,
    grossTurnoverRupees:changes?.reduce((sum,row)=>sum+Math.abs(row.tradeRupees),0) ?? null}));
}

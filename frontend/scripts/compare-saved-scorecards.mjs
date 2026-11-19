// Node 22.18+ · compare-saved-scorecards.mjs workflow.json [prior-workflow.json ...]
import { readFile } from 'node:fs/promises';
import { allocateIndiaEquities } from '../lib/basketDisplayCalculations.ts';

const paths = process.argv.slice(2);
if (!paths.length) throw new Error('Supply a saved India workflow and optional saved prior workflows.');
const records = await Promise.all(paths.map(async path => JSON.parse(await readFile(path, 'utf8'))));
const baselineWeights = [98,1,1];

function weighted(card, weights) {
  if (card.base == null) return null;
  const values = [card.base, card.pair == null ? null : card.pair * .06 - 3,
    card.threat == null ? null : (100-card.threat)*.06 - 3];
  let total = 0, denominator = 0;
  values.forEach((v,i) => {
    if (v == null) return;
    if (!Number.isFinite(v)) throw new Error('Invalid component');
    total += Math.max(-3, Math.min(3,v)) * weights[i];
    denominator += weights[i];
  });
  return total / denominator;
}

const close = (a,b) => a === b || Number.isFinite(a) && Number.isFinite(b) && Math.abs(a-b) < 1e-8;
function index(record) {
  if (record.schema !== 'workflow-final-v2' || record.formula_version !== 'score-matrix-v2' || record.broker !== 'india' ||
      record.actionable_ranking?.version !== 'weighted-98-1-1-v1') throw new Error('Expected a saved India score-matrix-v2 workflow.');
  const cards = new Map(record.actionable_ranking.rows.map(r => [r.listing,r]));
  const rows = new Map();
  for (const r of record.rows) {
    const key = r.exchange + ':' + r.symbol, card = cards.get(key);
    if (!card || rows.has(key)) throw new Error('Missing or duplicate listing '+key);
    const components = {base:r.formula_inputs.detailedRationaleFinalScore ?? r.formula_inputs.meanScore,
      pair:card.pairwise, threat:card.stock_threat};
    if (!close(weighted(components,baselineWeights),r.effectiveScore)) throw new Error('Baseline mismatch for '+key);
    rows.set(key,{components, score:r.effectiveScore, action:r.action});
  }
  if (rows.size !== record.actionable_ranking.rows.length) throw new Error('Incomplete ranking');
  return {record, rows};
}
const [current,...archives] = records.map(index);
const {record,rows} = current;
const v = record.valuation?.schema === 'india-valuation-v1' ? record.valuation : null;
const listings = new Map(v?.listings.map(row=>[row.key,row]));
if (v && (v.sequence !== record.workflow_sequence || v.asOf !== record.captured_at ||
    listings.size !== v.listings.length || listings.size !== rows.size ||
    !v.parameters.valid || !Number.isFinite(Date.parse(v.holdingsAsOf)) ||
    Date.parse(v.asOf)-Date.parse(v.windowStart) !== v.parameters.days*86400000)) throw new Error('Mismatched saved valuation');
const priorCards = new Map();
let totalPrior = 0, comparablePrior = 0;
for (const [key,row] of rows) {
  if (!v) continue;
  const listing = listings.get(key);
  if (!listing || !close(row.score, listing.effectiveScore)) throw new Error('Valuation score mismatch for '+key);
  const seen = new Set();
  for (const obs of listing.prior) {
    const lookup = JSON.stringify([key,obs.run_id]);
    if (obs.exchange+':'+obs.symbol !== key || seen.has(obs.run_id) || !Number.isFinite(obs.score) ||
        !(Date.parse(obs.covered_at)>Date.parse(v.windowStart) && Date.parse(obs.covered_at)<=Date.parse(v.asOf)))
      throw new Error('Invalid saved observation for '+key);
    seen.add(obs.run_id);
    const matching = archives.filter(({record:r,rows:rs}) => r.workflow_sequence === obs.workflow_sequence &&
      (r.rebalance_run_ids?.includes(obs.run_id) || r.technical_run_id === obs.run_id) && rs.has(key) &&
      rs.get(key).action === obs.action && close(rs.get(key).score,obs.score));
    totalPrior++;
    if (matching.length === 1) {
      priorCards.set(lookup,matching[0].rows.get(key).components);
      comparablePrior++;
    }
  }
}
function scenario(weights, mode) {
  const rankings = [...rows].map(([key,row])=>({key,signed:weighted(row.components,weights)}))
    .sort((a,b)=>(b.signed??-Infinity)-(a.signed??-Infinity)||a.key.localeCompare(b.key));
  const means = rankings.map(({key,signed})=>{
    const listing=listings.get(key);
    if (!listing) return {key,score:null};
    const values=listing.prior.map(obs=>{
      if (mode === 'current-run-only') return obs.score;
      const card=priorCards.get(JSON.stringify([key,obs.run_id]));
      return card ? weighted(card,weights) : null;
    });
    if (listing.currentIncluded) values.unshift(signed);
    const score=values.length && values.every(Number.isFinite) ? values.reduce((a,b)=>a+b,0)/values.length : null;
    if (mode === 'current-run-only' && weights===baselineWeights && !close(score,listing.score)) throw new Error('Saved mean mismatch for '+key);
    return {...listing,key,score};
  });
  let allocation=null;
  if (v && Number.isFinite(v.assets) && v.assets>0 && means.every(r=>r.score!=null && r.price>0 && r.priceSource?.startsWith('Upstox ') &&
      Number.isFinite(Date.parse(r.priceAsOf)) && Number.isSafeInteger(r.holding) && r.holding>=0 && r.isin)) {
    const {venues}=allocateIndiaEquities(means,v.parameters,v.assets);
    allocation=means.map(r=>{
      const shares=venues.get(r.key)?.shares;
      if (!Number.isSafeInteger(shares)) throw new Error('Invalid target for '+r.key);
      const units=shares-r.holding;
      return {listing:r.key,shares,units,targetRupees:shares*r.price,tradeRupees:units*r.price};
    });
  }
  return {mode,weights,rankings,historicalMeans:means.map(({key,score})=>({key,score})),allocation};
}
const baseline=scenario(baselineWeights,'current-run-only');
const original=new Map(baseline.allocation?.map(r=>[r.listing,r]));
if (baseline.allocation) {
  if (v.baseline.length!==original.size || new Set(v.baseline.map(r=>r.listing)).size!==original.size ||
      v.baseline.some(r=>!original.has(r.listing)||['shares','units','targetRupees','tradeRupees'].some(k=>original.get(r.listing)[k]!==r[k])))
    throw new Error('Captured targets or amounts differ from offline replay');
}
for (const mode of ['current-run-only','full-window']) for (const weights of [baselineWeights,[90,5,5],[80,10,10]]) {
  const result=scenario(weights,mode), trades=result.allocation;
  console.log(JSON.stringify({...result,sequence:record.workflow_sequence,valuationAsOf:v?.asOf??null,
    coverage:v ? {eligiblePrior:totalPrior,comparablePrior} : null,
    changedRanks:result.rankings.filter((r,i)=>r.key!==baseline.rankings[i].key).length,
    entries:trades?.filter(r=>r.shares>0 && original.get(r.listing).shares===0).map(r=>r.listing)??null,
    exits:trades?.filter(r=>!r.shares && original.get(r.listing).shares>0).map(r=>r.listing)??null,
    allocation:trades?.map(r=>({...r,targetChangeRupees:r.targetRupees-original.get(r.listing).targetRupees}))??null,
    grossTurnoverRupees:trades?.reduce((sum,r)=>sum+Math.abs(r.tradeRupees),0)??null}));
}

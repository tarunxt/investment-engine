// Node 22.18+ · compare-saved-scorecards.mjs workflow.json [prior-workflow.json ...]
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { allocateDisplayScores, allocateIndiaEquities, indmoneyActionSizing } from '../lib/basketDisplayCalculations.ts';

const paths = process.argv.slice(2);
if (!paths.length) throw new Error('Supply a saved workflow and optional saved prior workflows.');
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

function digest(card) {
  const hash = createHash('sha256').update('india-score-components-v1');
  for (const key of ['base','pair','threat']) {
    const value = card[key];
    if (value === null) { hash.update('0'); continue; }
    if (!Number.isFinite(value)) return null;
    const bytes = Buffer.alloc(8);
    bytes.writeDoubleBE(value);
    hash.update('1').update(bytes);
  }
  return hash.digest('hex');
}
const close = (a,b) => a === b || Number.isFinite(a) && Number.isFinite(b) && Math.abs(a-b) < 1e-8;
function index(record) {
  if (record.schema !== 'workflow-final-v2' || record.formula_version !== 'score-matrix-v2' || !['india','indmoney_us'].includes(record.broker) ||
      record.actionable_ranking?.version !== 'weighted-98-1-1-v1') throw new Error('Expected a saved score-matrix-v2 workflow.');
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
const us = record.broker === 'indmoney_us';
if (archives.some(a => a.record.broker !== record.broker)) throw new Error('Prior workflow broker differs');
const v = (us ? ['us-valuation-v1'] : ['india-valuation-v1','india-valuation-v2']).includes(record.valuation?.schema) ? record.valuation : null;
const listings = new Map(v?.listings.map(row=>[row.key,row]));
if (v && (v.sequence !== record.workflow_sequence || (us ? v.capturedAt : v.asOf) !== record.captured_at ||
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
    const alias = us && listing.eligible && obs.exchange === 'US' && obs.symbol === listing.listing?.symbol;
    if ((!alias && obs.exchange+':'+obs.symbol !== key) || seen.has(obs.run_id) || !Number.isFinite(obs.score) ||
        !(Date.parse(obs.covered_at)>Date.parse(v.windowStart) && Date.parse(obs.covered_at)<=Date.parse(v.asOf)))
      throw new Error('Invalid saved observation for '+key);
    seen.add(obs.run_id);
    const matching = !obs.component_sha256 ? [] : archives.filter(({record:r,rows:rs}) => r.workflow_sequence === obs.workflow_sequence &&
      (r.rebalance_run_ids?.includes(obs.run_id) || r.technical_run_id === obs.run_id) && rs.has(key) &&
      digest(rs.get(key).components) === obs.component_sha256 && rs.get(key).action === obs.action && close(rs.get(key).score,obs.score));
    totalPrior++;
    if (obs.components && (!obs.component_sha256 || digest(obs.components) === obs.component_sha256) && close(weighted(obs.components,baselineWeights),obs.score)) {
      priorCards.set(lookup,obs.components);
      comparablePrior++;
    } else if (matching.length === 1 && !obs.components) {
      priorCards.set(lookup,matching[0].rows.get(key).components);
      comparablePrior++;
    }
  }
}
function scenario(weights, mode) {
  const rankings = [...rows].map(([key,row])=>({key,signed:weights===baselineWeights ? row.score : weighted(row.components,weights)}))
    .sort((a,b)=>(b.signed??-Infinity)-(a.signed??-Infinity)||a.key.localeCompare(b.key));
  const means = rankings.map(({key,signed})=>{
    const listing=listings.get(key);
    if (!listing || v.historyAvailable === false) return {...listing,key,score:null};
    const values=listing.prior.map(obs=>{
      if (mode === 'current-run-only' || weights === baselineWeights) return obs.score;
      const card=priorCards.get(JSON.stringify([key,obs.run_id]));
      return card ? weighted(card,weights) : null;
    });
    if (listing.currentIncluded) values.unshift(signed);
    const score=values.length && values.every(Number.isFinite) ? values.reduce((a,b)=>a+b,0)/values.length : null;
    if (mode === 'current-run-only' && weights===baselineWeights && !close(score,listing.score)) throw new Error('Saved mean mismatch for '+key);
    return {...listing,key,score};
  });
  let allocation=null;
  let listingResults=null;
  if (us && v) {
    const {weights} = allocateDisplayScores(means.filter(row => row.eligible),v.parameters);
    listingResults = means.map(row => {
      const weight = row.eligible && row.score != null ? weights.get(row.key) ?? 0 : null;
      return {listing:row.key, weight, ...indmoneyActionSizing(weight,v.assets,row.holding?.investedValue ?? null,row.quote?.price ?? null)};
    });
  } else if (v) {
    const completeRanks=means.every(r=>r.score!=null && /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(r.isin));
    const priced=means.map(r=>({...r, price:r.price>0 && r.priceSource?.startsWith('Upstox ') &&
      Number.isFinite(Date.parse(r.priceAsOf)) ? r.price : null}));
    const {venues}=allocateIndiaEquities(priced,v.parameters,v.assets);
    listingResults=priced.map(r=>{
      const venue=venues.get(r.key);
      const shares=completeRanks && Number.isSafeInteger(venue?.shares) ? venue.shares : null;
      const units=shares!=null && Number.isSafeInteger(r.holding) && r.holding>=0 ? shares-r.holding : null;
      return {listing:r.key,shares,units,targetRupees:shares!=null && r.price!=null ? shares*r.price : null,
        tradeRupees:units!=null && r.price!=null ? units*r.price : null};
    });
    if (listingResults.every(r=>r.tradeRupees!=null && r.targetRupees!=null)) allocation=listingResults;
  }
  const historicalMeans=means.map(({key,score})=>({key,score})).sort((a,b)=>
    (b.score??-Infinity)-(a.score??-Infinity)||a.key.localeCompare(b.key));
  return {mode,weights,rankings,historicalMeans,listingResults,allocation};
}
function actionBand(score) {
  if (score == null) return null;
  if (score >= 1) return 'Positive';
  if (score >= -1) return 'Hold';
  return score >= -2 ? 'Trim' : 'Sell All';
}
const baseline=scenario(baselineWeights,'current-run-only');
const original=new Map(baseline.allocation?.map(r=>[r.listing,r]));
if (v?.schema === 'india-valuation-v2' || v?.schema === 'us-valuation-v1' || baseline.allocation) {
  const targets=new Map(baseline.listingResults.map(r=>[r.listing,r]));
  if (v.baseline.length!==targets.size || new Set(v.baseline.map(r=>r.listing)).size!==targets.size ||
      v.baseline.some(r=>!targets.has(r.listing)||(us ? ['weight','targetAmount','targetStocks','amount','stocks','price'] : ['shares','units','targetRupees','tradeRupees']).some(k=>targets.get(r.listing)[k]!==r[k])))
    throw new Error('Captured targets or amounts differ from offline replay');
}
for (const mode of ['current-run-only','full-window']) for (const weights of [baselineWeights,[90,5,5],[80,10,10]]) {
  const result=scenario(weights,mode), trades=result.allocation;
  if (us) {
    const targets = new Map(baseline.listingResults?.map(r => [r.listing,r.targetAmount]));
    console.log(JSON.stringify({...result, sequence:record.workflow_sequence, currency:"USD", valuationAsOf:v?.asOf ?? null,
      allocation:result.listingResults?.map(r => ({...r, targetChangeUsd:r.targetAmount == null || targets.get(r.listing) == null ? null : r.targetAmount - targets.get(r.listing)})) ?? null}));
    continue;
  }
  console.log(JSON.stringify({...result,sequence:record.workflow_sequence,valuationAsOf:v?.asOf??null,
    coverage:v && v.historyAvailable !== false ? {eligiblePrior:totalPrior,comparablePrior} : null,
    thresholdCrossings:result.rankings.flatMap(({key,signed}) => {
      const from=actionBand(rows.get(key).score), to=actionBand(signed);
      return from !== null && to !== null && from !== to ? [{listing:key,from,to}] : [];
    }),
    assets:v?.assets ?? null,
    changedRanks:result.rankings.filter((r,i)=>r.key!==baseline.rankings[i].key).length,
    changedWindowRanks:result.historicalMeans.every(r=>r.score!=null) && baseline.historicalMeans.every(r=>r.score!=null)
      ? result.historicalMeans.filter((r,i)=>r.key!==baseline.historicalMeans[i].key).length : null,
    entries:trades?.filter(r=>r.shares>0 && original.get(r.listing).shares===0).map(r=>r.listing)??null,
    exits:trades?.filter(r=>!r.shares && original.get(r.listing).shares>0).map(r=>r.listing)??null,
    allocation:trades?.map(r=>({...r,targetChangeRupees:r.targetRupees-original.get(r.listing).targetRupees}))??null,
    grossTurnoverRupees:trades?.reduce((sum,r)=>sum+Math.abs(r.tradeRupees),0)??null}));
}

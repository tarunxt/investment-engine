// Input JSON: {costBps, periods:[{asOf,end,totalReturns,scenarios}]}. Each scenarios
// array contains the JSON lines from compare-saved-scorecards for that decision.
// Returns are decimal subsequent total returns keyed by exchange:symbol.
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export function forwardPerformance({costBps, periods}) {
  if (!Number.isFinite(costBps) || costBps < 0 || costBps >= 10000 || !Array.isArray(periods) || !periods.length)
    throw new Error('Supply explicit trading costs and at least one forward period.');
  const costRate = costBps / 10000;
  const states = new Map();
  let previousEnd;
  for (const period of periods) {
    const start = Date.parse(period.asOf), end = Date.parse(period.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || previousEnd !== undefined && start !== previousEnd)
      throw new Error('Use contiguous, chronological forward return periods.');
    const seen = new Set();
    for (const scenario of period.scenarios.filter(s => s.mode === 'full-window')) {
      const key = scenario.weights.join('/');
      if (seen.has(key) || previousEnd !== undefined && !states.has(key)) throw new Error('Scenario coverage changed.');
      seen.add(key);
      if (Date.parse(scenario.valuationAsOf) !== start || !Array.isArray(scenario.allocation) || !(Number.isFinite(scenario.assets) && scenario.assets > 0))
        throw new Error('Each scenario requires complete allocation at the opening timestamp.');
      const state = states.get(key) ?? {nav:1, peak:1, drawdown:0, holdings:new Map(), turnover:0, crossings:0};
      const targets = new Map();
      for (const row of scenario.allocation) {
        if (targets.has(row.listing) || !Number.isFinite(row.targetRupees) || row.targetRupees < 0) throw new Error('Invalid listing target.');
        targets.set(row.listing, row.targetRupees / scenario.assets);
      }
      const invested = [...targets.values()].reduce((a,b) => a+b,0);
      if (invested > 1 + 1e-10) throw new Error('Targets exceed available capital.');
      const keys = new Set([...targets.keys(),...state.holdings.keys()]);
      const turnoverAt = nav => [...keys].reduce((sum,k) => sum + Math.abs((targets.get(k) ?? 0)*nav-(state.holdings.get(k) ?? 0)),0);
      // Self-financing rebalance: cash plus new positions equals NAV less costs on both sides.
      let low = 0, high = state.nav;
      for (let i=0;i<60;i++) {
        const mid = (low+high)/2;
        if (mid+turnoverAt(mid)*costRate > state.nav) high=mid; else low=mid;
      }
      state.turnover += turnoverAt(low)/state.nav;
      state.crossings += scenario.thresholdCrossings.length;
      state.holdings = new Map();
      let nav = low*(1-invested);
      for (const [listing,weight] of targets) {
        if (!weight) continue;
        const change = period.totalReturns?.[listing];
        if (!Number.isFinite(change) || change < -1) throw new Error('Missing or invalid forward return for '+listing);
        const balance = low*weight*(1+change);
        state.holdings.set(listing,balance);
        nav += balance;
      }
      if (!(Number.isFinite(nav) && nav > 0)) throw new Error('Portfolio exhausted or invalid.');
      state.nav = nav;
      state.peak = Math.max(state.peak,nav);
      state.drawdown = Math.max(state.drawdown,1-nav/state.peak);
      states.set(key,state);
    }
    if (!seen.size || seen.size !== states.size) throw new Error('All scenarios must cover every period.');
    previousEnd=end;
  }
  return [...states].map(([weights,s]) => ({weights,periods:periods.length,costBps,netReturn:s.nav-1,
    periodEndMaxDrawdown:s.drawdown,cumulativeGrossTurnover:s.turnover,thresholdCrossings:s.crossings}));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = JSON.parse(await readFile(process.argv[2],'utf8'));
  console.log(JSON.stringify(forwardPerformance(input),null,2));
}

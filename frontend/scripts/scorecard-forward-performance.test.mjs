import test from 'node:test';
import assert from 'node:assert/strict';
import {forwardPerformance} from './scorecard-forward-performance.mjs';
const period=(asOf,end,r)=>({asOf,end,totalReturns:{'NSE:TEST':r},scenarios:[{mode:'full-window',weights:[98,1,1],assets:100,valuationAsOf:asOf,thresholdCrossings:[],allocation:[{listing:'NSE:TEST',targetRupees:100}]}]});
test('starting from cash charges entry costs and measures drawdown at period ends',()=>{
  const periods=[period('2026-01-01','2026-01-02',0.1),period('2026-01-02','2026-01-03',-0.2)];
  const [result]=forwardPerformance({costBps:100,periods});
  assert.ok(Math.abs(result.netReturn-(1.1*0.8/1.01-1))<1e-12);
  assert.ok(Math.abs(result.periodEndMaxDrawdown-0.2)<1e-12);
  delete periods[1].totalReturns['NSE:TEST'];
  assert.throws(()=>forwardPerformance({costBps:100,periods}),/forward return/);
});

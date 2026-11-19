import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

test('saved valuation and full-window component coverage', t => {
  const dir=mkdtempSync(join(tmpdir(),'scores-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const date='2026-01-06T12:00:00Z', key='NSE:TEST';
  const record={schema:'workflow-final-v2',broker:'india',formula_version:'score-matrix-v2',workflow_sequence:2,
    captured_at:date,rows:[{exchange:'NSE',symbol:'TEST',action:'Hold',effectiveScore:.98,formula_inputs:{meanScore:1}}],
    actionable_ranking:{version:'weighted-98-1-1-v1',rows:[{listing:key,pairwise:50,stock_threat:50}]}};
  const prior={...record,workflow_sequence:1,rebalance_run_ids:[12]};
  const listing={key,isin:'IN0000000001',price:10,priceSource:'Upstox LTP',priceAsOf:date,holding:2,score:.98,
    effectiveScore:.98,currentIncluded:true,prior:[{run_id:12,workflow_sequence:1,symbol:'TEST',exchange:'NSE',action:'Hold',score:.98,covered_at:'2026-01-04T13:00:00Z'}]};
  record.valuation={schema:'india-valuation-v1',sequence:2,asOf:date,windowStart:'2026-01-01T12:00:00Z',holdingsAsOf:date,
    assets:1000,parameters:{days:5,cash:5,normalised:9.5,maximumStocks:20,valid:true},listings:[listing],
    baseline:[{listing:key,shares:9,units:7,targetRupees:90,tradeRupees:70}]};
  function run(...records) {
    const files=records.map((r,i)=>{const path=join(dir,i+'.json');writeFileSync(path,JSON.stringify(r));return path;});
    return spawnSync(process.execPath,[fileURLToPath(new URL('./compare-saved-scorecards.mjs',import.meta.url)),...files],{encoding:'utf8'});
  }
  function results(...r) {
    const result=run(...r);assert.equal(result.status,0,result.stderr);
    return result.stdout.trim().split('\n').map(line=>JSON.parse(line));
  }
  const incomplete=results(record);
  assert.equal(incomplete[0].allocation[0].tradeRupees,70);
  assert.equal(incomplete[4].allocation,null);
  const complete=results(record,prior);
  assert.equal(complete[4].coverage.comparablePrior,1);
  assert.equal(complete[4].historicalMeans[0].score,.9);
  assert.equal(complete[1].historicalMeans[0].score,.94);
  assert.equal(results(record,prior,prior)[4].allocation,null);
  listing.price=20;
  assert.notEqual(run(record).status,0);
  listing.price=10;
  record.valuation.sequence=3;
  assert.notEqual(run(record).status,0);
});

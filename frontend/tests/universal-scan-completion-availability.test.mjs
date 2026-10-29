import assert from 'node:assert/strict';
import test from 'node:test';
import {harness} from './helpers/workspace-hooks.mjs';

test('a saved snapshot without optional completion evidence renders unavailable without claiming completion',async()=>{
 for(const completion of [undefined,null]){
  const snapshot={scannedAt:'2026-10-01T01:00:00Z',sourceScanCompletedAt:completion,totalCandidates:5,scanExportId:'saved',questions:[]};
  const h=harness(new URL('../app/console/trading-bots/_components/UniversalPolymarketScan.tsx',import.meta.url),'UniversalPolymarketScan',{}, {
   useCallback:fn=>fn,fetchUniversalSnapshot:async()=>({snapshot}),waitForRetry:async()=>{},
   window:{setInterval:()=>1,clearInterval:()=>{}},dateLabel:value=>value,durationLabel:value=>String(value),
   UniversalScanAutoRunCard:'AutoRunCard',FileSpreadsheet:'Icon',Menu:'Icon',X:'Icon',
  });
  try{
   await h.flush();
   assert.match(h.text(),/Started: 2026-10-01T01:00:00Z/);
   assert.match(h.text(),/Completed: Unavailable/);
   assert.doesNotMatch(h.text(),/Completed: 2026/);
   assert.equal(h.requests.length,0);
  }finally{h.cleanup();}
 }
});

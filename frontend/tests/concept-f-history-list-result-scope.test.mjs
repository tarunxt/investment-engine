import test from 'node:test';
import assert from 'node:assert/strict';
import {harness} from './helpers/workspace-hooks.mjs';
function setup(){
 const props={portfolio:'zerodha'},requests=[],timers=new Map();let nextTimer=0;
 const h=harness(new URL('../app/console/auto-rebalance-runs/_components/AutoRebalanceHistoryClient.tsx',import.meta.url),'AutoRebalanceHistoryListClient',props,{
  useWorkspaceDisplay:()=>({value:{masked:true,owner:1}}),apiPortfolio:p=>p==='zerodha'?'india':'indmoney_us',portfolioLabel:p=>p==='zerodha'?'Zerodha':'IndMoney',
  apiService:{getAutoRebalanceHistory:(portfolio,options)=>new Promise((resolve,reject)=>requests.push({portfolio,options,resolve,reject}))},
  window:{setTimeout:fn=>{const id=++nextTimer;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id)},
  URLs:{routes:{console:{dashboard:()=>'/console/dashboard',autoRebalanceRunDetail:(p,s)=>`/history/${p}/${s}`}}},
  Button:'button',Link:'a',Clock3:'icon',ArrowLeft:'icon',RefreshCw:'icon',Loader2:'icon',ChevronRight:'icon',StatusBadge:'status',StageSummary:'stage',stageCardTone:()=>'',STAGE_LABELS:{},formatTime:String,formatCost:String,
 });
 return {h,props,requests,timers,runTimers(){const pending=[...timers.values()];timers.clear();pending.forEach(fn=>fn());}};
}
const item=(portfolio='india')=>({portfolio,sequence:7,label:'exact saved '+portfolio,status:'completed',stages:[],created_at:'2026-10-28',total_estimated_cost:null,completed_at:null});
test('prior-market error is hidden under the next portfolio heading before scheduled reads run',async()=>{
 const {h,props,requests,runTimers}=setup();runTimers();requests[0].reject(Error('India-only failure'));await h.flush();assert.match(h.text(),/India-only failure/);props.portfolio='indmoneyUs';await h.flush();assert.match(h.text(),/IndMoney Auto-Rebalance Runs/);assert.doesNotMatch(h.text(),/India-only failure/);assert.match(h.text(),/Loading runs/);assert.equal(requests.length,1);h.cleanup();
});
test('empty prior history cannot claim the unqueried next market has no records',async()=>{
 const {h,props,requests,runTimers}=setup();runTimers();requests[0].resolve({items:[]});await h.flush();assert.match(h.text(),/No Zerodha auto-rebalance runs/);props.portfolio='indmoneyUs';await h.flush();assert.doesNotMatch(h.text(),/No IndMoney auto-rebalance runs/);assert.match(h.text(),/Loading runs/);runTimers();requests[1].resolve({items:[]});await h.flush();assert.match(h.text(),/No IndMoney auto-rebalance runs/);h.cleanup();
});
test('current-market failures stay explicit and late previous responses cannot replace them',async()=>{
 const {h,props,requests,runTimers}=setup();runTimers();props.portfolio='indmoneyUs';await h.flush();runTimers();requests[1].reject(Error('Current US failure'));await h.flush();requests[0].resolve({items:[item()]});await h.flush();assert.match(h.text(),/Current US failure/);assert.doesNotMatch(h.text(),/exact saved india|No IndMoney/);h.cleanup();
});
test('verified rows retain their existing exact portfolio filter and no financial action is sent',async()=>{
 const {h,props,requests,runTimers}=setup();runTimers();requests[0].resolve({items:[item()]});await h.flush();assert.match(h.text(),/exact saved india/);props.portfolio='indmoneyUs';await h.flush();assert.doesNotMatch(h.text(),/exact saved india/);runTimers();requests[1].resolve({items:[item('indmoney_us')]});await h.flush();assert.match(h.text(),/exact saved indmoney_us/);assert.deepEqual(requests.map(r=>[r.portfolio,r.options]),[['india',{limit:100}],['indmoney_us',{limit:100}]]);h.cleanup();
});
test('unmount invalidates late errors; a fresh owner boundary starts with no old result',async()=>{
 const first=setup();first.runTimers();first.h.cleanup();first.requests[0].reject(Error('Old-owner failure'));await first.h.flush();assert.doesNotMatch(first.h.text(),/Old-owner failure/);const next=setup();assert.match(next.h.text(),/Loading runs/);assert.doesNotMatch(next.h.text(),/Old-owner failure|No Zerodha/);next.h.cleanup();
});

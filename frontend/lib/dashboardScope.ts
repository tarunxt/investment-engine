import type {DashboardSummaryResponse} from '@/types/api';
import {moduleScopeKey,surfaceAllowed,type ModuleCollection} from './modulePolicy';

export type InitialDashboardScope={owner:number;generation:string;policy:string};
export function acceptInitialDashboard(summary:DashboardSummaryResponse|null,binding:InitialDashboardScope|null,
 manifest:ModuleCollection|null,owner:number|null|undefined,generation:string|undefined):DashboardSummaryResponse|null {
 return summary&&binding&&manifest&&owner===manifest.owner_id&&binding.owner===owner&&
  generation&&binding.generation===generation&&binding.policy===moduleScopeKey(manifest)?summary:null;
}

/** Defence in depth for cached/server summaries; backend scope is authoritative. */
export function scopeDashboardSummary(summary:DashboardSummaryResponse,manifest:ModuleCollection|null):DashboardSummaryResponse {
 const india=surfaceAllowed(manifest,'/console/zerodha');
 const us=surfaceAllowed(manifest,'/console/indmoney-us');
 const bullpen=surfaceAllowed(manifest,'/console/bullpen-ai');
 const allowed:Record<string,boolean>={zerodha:india,indmoney_us:us,bullpen,portfolio_history:india||us||bullpen,fx:us||bullpen};
 return {...summary,
  sections:Object.fromEntries(Object.entries(summary.sections).filter(([key])=>allowed[key]===true)),
  fx:us||bullpen?summary.fx:{...summary.fx,value:null,source:null,as_of:null,age_seconds:null,status:'unavailable'},
  usd_inr_rate:us||bullpen?summary.usd_inr_rate:null,
  usd_inr_status:us||bullpen?summary.usd_inr_status:'unavailable',
  usd_inr_source:us||bullpen?summary.usd_inr_source:null,
  usd_inr_as_of:us||bullpen?summary.usd_inr_as_of:null,
  usd_inr_age_seconds:us||bullpen?summary.usd_inr_age_seconds:null,
  zerodha:india?summary.zerodha:null,indmoney_us:us?summary.indmoney_us:null,bullpen:bullpen?summary.bullpen:null,
  portfolio_history:{...summary.portfolio_history,india:india?summary.portfolio_history.india:[],
   indmoney:us?summary.portfolio_history.indmoney:[],bullpen:bullpen?summary.portfolio_history.bullpen:[],combined:[]}};
}

export function completeSelectedTotal(values:(number|null|undefined)[]):number|null {
 return values.length&&values.every(v=>typeof v==='number'&&Number.isFinite(v))
  ? (values as number[]).reduce((a,b)=>a+b,0):null;
}

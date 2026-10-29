import {recordedCostTimestamp} from './conceptFCostReceipts';
import {allowedModule,type ModuleCollection} from './modulePolicy';
import type {DashboardSummaryResponse,DashboardHistoryPoint} from '@/types/api';
export type ConceptFDashboardData={zerodha?:{snapshot:{captured_at:string;holdings_count:number;history?:DashboardHistoryPoint[];holdings_market_value?:number|null;source?:string;source_receipt_id?:string;top_holdings?:{symbol:string;company_name?:string|null;weight_percent?:number|null}[]}|null}|null;indmoney_us?:{snapshot:{captured_at:string;holdings_count:number;history?:DashboardHistoryPoint[];current_value?:number|null;top_holdings?:{symbol:string;company_name?:string|null;weight_percent?:number|null}[]}|null}|null;portfolio_history?:{india?:DashboardHistoryPoint[];indmoney?:DashboardHistoryPoint[]};fx?:DashboardSummaryResponse['fx']};

export function conceptFPortfolios(manifest:ModuleCollection,summary:ConceptFDashboardData|null) {
 return manifest.modules.filter(m=>m.selection.enabled&&['zerodha_rebalance','indmoney_us'].includes(m.module_id)).map(module=>{
  const india=module.module_id==='zerodha_rebalance',allowed=allowedModule(manifest,module.module_id);
  const snapshot=allowed?(india?summary?.zerodha?.snapshot:summary?.indmoney_us?.snapshot):null;
  return {module,allowed,india,label:india?'Zerodha':'INDmoney',currency:india?'INR':'USD',root:india?'/console/zerodha':'/console/indmoney-us',portfolio:india?'india':'indmoney_us',snapshot,
   value:!allowed?null:india?summary?.zerodha?.snapshot?.holdings_market_value:summary?.indmoney_us?.snapshot?.current_value,
   history:!allowed?[]:india?(summary?.zerodha?.snapshot?.source==='owned_synthetic_acquisition_journal'?summary.zerodha.snapshot.history??[]:summary?.zerodha?.snapshot?.history??summary?.portfolio_history?.india??[]):ownedUsdHistory(summary?.indmoney_us?.snapshot?.history,manifest.owner_id)};
 });
}

/** Legacy portfolio_history.indmoney is converted INR, never a USD series.
 * Native USD history comes only from the accepted INDmoney snapshot contract.
 * Owned India journals never borrow unrelated generic snapshot histories. */

/** Explicit combined presentation requires both native sources and dated valid FX. */
export function conceptFCombinedTotal(manifest:ModuleCollection,summary:ConceptFDashboardData|null,now=Date.now()):number|null {
 const portfolios=conceptFPortfolios(manifest,summary),fx=summary?.fx;
 if(portfolios.length!==2||portfolios.some(p=>!p.allowed||typeof p.value!=='number'||!Number.isFinite(p.value)||p.value<0||!recordedCostTimestamp(p.snapshot?.captured_at)||Date.parse(p.snapshot!.captured_at)>now)||fx?.pair!=='USD/INR'||fx.status!=='valid'||!fx.source||!fx.as_of||!recordedCostTimestamp(fx.as_of)||typeof fx.value!=='number'||!Number.isFinite(fx.value)||fx.value<=0)return null;
 const captured=Date.parse(fx.as_of);
 if(!Number.isFinite(now)||captured>now||typeof fx.age_seconds!=='number'||!Number.isFinite(fx.age_seconds)||fx.age_seconds<0||!Number.isFinite(fx.stale_after_seconds)||fx.stale_after_seconds<=0||Math.max(fx.age_seconds,(now-captured)/1000)>fx.stale_after_seconds)return null;
 const total=portfolios.reduce((sum,p)=>sum+(p.value as number)*(p.currency==='USD'?fx.value!:1),0);
 return Number.isFinite(total)?total:null;
}

/** Reject an unbound series as a whole; missing observations remain chart gaps. */
export function ownedUsdHistory(points:DashboardHistoryPoint[]|undefined,owner:number):DashboardHistoryPoint[]{
 if(!Array.isArray(points)||!Number.isSafeInteger(owner)||owner<1)return [];
 const ids=new Set<number>();
 for(const p of points){
  if(p.metric!=='accepted_us_portfolio_value_v1'||p.currency!=='USD'||p.owner_id!==owner||!Number.isSafeInteger(p.snapshot_id)||p.snapshot_id!<1||ids.has(p.snapshot_id!)||!recordedCostTimestamp(p.captured_at)||!/^([a-f0-9]{64})$/.test(p.import_source_hash??'')||typeof p.recorded_value_known!=='boolean')return [];
  if(p.supersedes_id!=null&&(!Number.isSafeInteger(p.supersedes_id)||p.supersedes_id<1||p.supersedes_id===p.snapshot_id))return [];
  if(p.recorded_value_known?(typeof p.recorded_value!=='number'||!Number.isFinite(p.recorded_value)||p.recorded_value<0):p.recorded_value!==null)return [];
  ids.add(p.snapshot_id!);
 }
 return points.map(p=>({...p}));
}

import {URLs} from "@/lib/urls";

export const apiPath = () => URLs.runs.list() + "/scorecards/india/bottom-fishing";
export const route = "/console/zerodha/bottom-fishing";
export const stages = ["sync", "screen", "score", "actionables"] as const;
export type Stage = typeof stages[number];
export const titles = {sync:"Sync Kite portfolio", screen:"Bottom Fishing Screen", score:"Bottom Fishing Scorecard", actionables:"Bottom Fishing Actionables"};
export const labels: Record<string,string> = {bounce:"Support bounce", proximity:"Floor proximity", strength:"Relative strength", recovery:"Recovery", roce:"ROCE", sales:"Sales growth", profit:"Profit growth", leverage:"Debt / equity"};
export type Settings = {screen_query?:string; latest_results?:boolean; inputs:string[]; capital:number; weights:Record<string,number>};
export type Row = {symbol:string; sources:string[]; discovered?:string; score?:number; price?:number; breakout?:number; max_buy?:number; stop?:number; target?:number; rr?:number; risk?:number; qty?:number; reason:string; points?:Record<string,number>};
type Setup = {discovered:string; discovery:number; low:number; high:number; invalid?:boolean};
type Coverage = {at:string; universe:number; covered:number; patterns?:number; current_candles?:number; query_passed?:number; query_excluded?:number; query_missing?:number};
type KiteHolding = {tradingsymbol:string; exchange:string; quantity:number; average_price:number;
  last_price:number; invested_value:number; market_value:number; pnl:number; day_change_percentage?:number};
type KiteSync = {captured_at:string; holdings_count?:number; holdings?:KiteHolding[];
  holdings_market_value?:number; holdings_pnl?:number; available_margin?:number};
export type State = {kite_sync?:KiteSync; screen_query?:{text:string;latest_results:boolean}; sync?:Coverage; at?:string; market_as_of?:string; error?:string; status?:string; scans?:Coverage[]; rows?:Row[]; setups?:Record<string,Setup>;
  positions?:Record<string,{qty:number; entry:string; price:number; stop:number; target:number}>; realized?:number; closed?:{symbol:string; qty:number; reason:string; pnl:number; end:string}[]};
export type Output = {request_id?:number; finished_at?:string; mode:string; settings?:Settings; state:State};
export type Manual = {kite_sync?:KiteSync; id:number; status:string; stage?:Stage; error?:string};
export type Snapshot = {query_fields?:string[]; version:number; settings:Settings; state:State; manual?:Manual; review?:Output};
export const num = (x?:number) => x == null ? "—" : x.toLocaleString("en-IN",{maximumFractionDigits:2});
export const date = (x?:string) => x ? new Date(x).toLocaleString("en-IN",{timeZone:"Asia/Kolkata",hour12:false}) : "—";
export const latestOutput = (data:Snapshot):Output => data.review ?? {mode:"Kite portfolio", state:{}};
export function stageOutput(data:Snapshot, stage:Stage):Output {
  const job = data.manual;
  if (stage === "sync" && job?.kite_sync && pending(job.status)) {
    return {mode:"Manual review",request_id:job.id,state:{kite_sync:job.kite_sync,status:"completed"}};
  }
  return latestOutput(data);
}
export const pending = (status?:string) => status === "queued" || status === "running";

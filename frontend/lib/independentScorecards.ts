import { URLs } from "@/lib/urls";
import { apiService } from "@/services/api";
import type { AutoRebalancePortfolioKey, ProviderModelTarget } from "@/types/api";
import type { ScoreMatrixFormulaConfig } from "@/app/console/_components/FinalActionablesConsole";

export const cards = ["rebalance", "technical", "threats", "pairwise"] as const;
export type CardKey = typeof cards[number];
export type CardWeights = Record<CardKey, number>;
export type CardPolicy = { weights: CardWeights; factors: Partial<Record<CardKey, Record<string, number>>>; actions?: Record<string, number> };
export const defaultWeights: CardWeights = {rebalance:98*17/22, technical:98*5/22, threats:1, pairwise:1};
export function migratedPolicy(config: ScoreMatrixFormulaConfig): CardPolicy {
  const fields = config.detailedRationaleMultipliers;
  const rebalance = Object.fromEntries(["cruxx","technical-short","technical-medium","technical-long","fundamentals-short","fundamentals-medium-long","action"].map(k => [k, Math.max(0,fields[k==="action"?"mean-mode-action":k] ?? 0)]));
  const technical = {candles: Math.max(0,fields["last-5-candles-trend"]??0), premarket: Math.max(0,fields["premarket-trend"]??0)};
  const rw=Object.values(rebalance).reduce((a,b)=>a+b,0), tw=technical.candles+technical.premarket;
  return {weights:rw+tw ? {rebalance:98*rw/(rw+tw),technical:98*tw/(rw+tw),threats:1,pairwise:1} : {...defaultWeights},
    factors:{...(rw && Object.values(rebalance).some((w,i)=>w!==[3,3,2,1,3,1,4][i])?{rebalance}:{}),...(tw && (technical.candles!==5||technical.premarket!==0)?{technical}:{})},actions:config.actionScores};
}
export type VerifiedListing = {symbol:string;venue:string;security_id:string;share_class:string;source_url:string};
export type StockInput = {listing:string;name:string;origin:string;units:number|null};
export type SourceRevision = {id:number;sequence:number;created_at:string};
export type CardRef = {id:number;card:CardKey;run_id:number};
export type SourceDetail = {id:number;manifest:{sequence:number;as_of:string;snapshot_id:number;snapshot_at:string;swing_job_ids:number[];verified_listings?:VerifiedListing[];stocks:StockInput[];unresolved:Record<string,unknown>[]};attempts:CardRef[]; finals:{id:number}[]};
export type CardRow = {listing:string;score:number|null;coverage:string;terms?:Record<string,number|null>; [field:string]:unknown};
export type CardResult = {id:number;status:string;rows:CardRow[];jobs:number;completed:number;model_tables?:{job_id:number;slot:number;model:string;rows:Record<string,unknown>[]}[];scored?:number;errors?:{job_id:number;reason:string}[]};
export type FinalRow = StockInput & {symbol:string;exchange:string;scores:Record<CardKey,number|null>;contributions:Record<CardKey,number|null>;status:string;rank:number|null;final:number|null;signed:number|null;action:string|null;suggested_units:number|null;sizing_reason?:string;settled:number|null;price:number|null;value:number|null;available_weight:number};
export type CardFinal = {id:number;sequence:number;revision_id:number;schema:"independent-scorecards-v1";policy:CardPolicy;rows:FinalRow[];attempts:Partial<Record<CardKey,number>>;source_runs:Partial<Record<CardKey,number>>};
export const isCard = (value:string):value is CardKey => (cards as readonly string[]).includes(value);
export function scorecardApi(client: Pick<typeof apiService,"get"|"post">, market: AutoRebalancePortfolioKey) {
  const base=URLs.runs.list()+"/scorecards/"+market;
  return {
    savedPolicy:()=>client.get<CardPolicy|null>(base+"/saved-policy"),
    latestFinal:(seq?:number)=>client.get<CardFinal|null>(base+"/latest-final"+(seq?"?sequence="+seq:"")),
    prompt:(revision:number,card:CardKey)=>client.get<{prompt:string}>(base+"/revisions/"+revision+"/"+card+"/prompt"),
    list:()=>client.get<SourceRevision[]>(base+"/revisions"),
    read:(id:number)=>client.get<SourceDetail>(base+"/revisions/"+id),
    publish:(data:{request_key:string;sequence:number;snapshot_id?:number;captured_at:string;swing_job_ids:number[];verified_listings?:VerifiedListing[]})=>client.post<{id:number}>(base+"/revisions",data,{timeoutMs:65_000}),
    start:(revision:number,card:CardKey,data:{sequence:number;request_key:string;targets:ProviderModelTarget[];retry_attempt_id?:number})=>client.post<{id:number;run_id:number}>(base+"/revisions/"+revision+"/"+card+"/start",data,{timeoutMs:65_000}),
    result:(id:number)=>client.get<CardResult>(base+"/attempts/"+id,{timeoutMs:22_000}),
    final:(id:number)=>client.get<CardFinal>(base+"/finals/"+id),
    compare:(revision:number,sequence:number,attempts:Partial<Record<CardKey,number>>,config:CardPolicy,previous:ScoreMatrixFormulaConfig)=>client.post<{comparison:Record<string,unknown>[]}>(base+"/revisions/"+revision+"/final",{sequence,attempts,...config,compare_with:previous}),
    finalize:(revision:number,sequence:number,attempts:Partial<Record<CardKey,number>>,config:CardPolicy)=>client.post<CardFinal>(base+"/revisions/"+revision+"/final",{sequence,attempts,...config}),
  };
}


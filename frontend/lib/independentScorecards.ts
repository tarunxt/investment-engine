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
export type RebalanceReadiness = {ready:number;provisional:number;awaiting:number;repairable?:number;rows:{
  listing:string;verified_listing:string;state:"ready"|"provisional"|"awaiting";sessions:Record<string,number>;missing:Record<string,string>}[]};
export type RebalanceCounts = {assessed:number; complete:number; provisional:number; unassessed:number};
export type RebalanceAudit = {weights:Record<string,number>; coverage:RebalanceCounts; actions:Record<string,number>;
  jobs:{job_id:number;slot:number;model:string;listings:number;counts:Record<string,number>;fields:[string,string,string][]}[]};
export type PairRecovery = {root:number;output:number;phase:string;next_at:number;error?:string|null;listings:Record<string,{needs:string[];reason:string;attempts:number;next_retry:number|null;last_attempt:number|null;last_success:number|null}>};
export type FinalCounts = {pairwise?:{used:number;judged:number;expected:number;completed_output?:number};id:number;rebalance_output:number|null;rebalance_inputs:number|null;assessed:number;complete:number;holds:number;eligible:number;blocked:number};
export type PairCounts = {mode:"full"|"balanced";listings:number;ready:number;expected:number;eligible:number;judged:number;returned:number;one_missing:number;both_missing:number;complete_stocks:number;jobs:number;errors:number;benchmark_ready:number;carried?:number};
export type ThreatDiagnostics = {scoreable:number; without_sources:number; confidence_rejected:number; confidence_recovered:number};
export type AvailableOutput = {recovery?:PairRecovery;threat_diagnostics?:ThreatDiagnostics;counts?:RebalanceCounts;actions?:Record<string,number>;threat_returned?:number;threat_complete?:number;threat_status?:string;output_id:number;run_id:number|null;pair_counts?:PairCounts;covered:number;expected:number;used_output_id:number|null;final_id:number|null};
export type WorkflowCoverage = {revision_id:number|null;listing_count?:number;final_summary?:FinalCounts;cards:Partial<Record<"rebalance"|"technical"|"pairwise"|"threats",AvailableOutput>>};
export type CardRef = {id:number;card:CardKey;run_id:number};
export type SourceDetail = {id:number;manifest:{sequence:number;as_of:string;snapshot_id:number;snapshot_at:string;swing_job_ids:number[];verified_listings?:VerifiedListing[];stocks:StockInput[];unresolved:Record<string,unknown>[]};attempts:CardRef[]; finals:{id:number}[]};
export type CardRow = {listing:string;score:number|null;coverage:string;terms?:Record<string,number|null>; [field:string]:unknown};
export type CardResult = {recovery?:PairRecovery;threat_target?:ProviderModelTarget|null;threat_diagnostics?:ThreatDiagnostics;rebalance_readiness?:RebalanceReadiness;evidence_only?:boolean;recovered_from?:number;rebalance_audit?:RebalanceAudit;threat_version?:number;threat_counts?:{expected:number;returned:number;scored:number;complete:number;verified_cells:number;jobs_passed:number};id:number;attempt_cost_inr?:number|null;attempt_elapsed_seconds?:number;pair_counts?:PairCounts;evidence_readiness?:Record<string,unknown>[];observed_at?:string;as_of?:string;revision_id?:number;stage4_method?:string;technical_counts?:{expected:number;complete:number;provisional:number;insufficient:number;commentary:number};status:string;research_notices?:string[];rows:CardRow[];jobs:number;completed:number;balanced_schedule?:Record<string,unknown>|null;cost_per_judgment_usd?:number|null;order_checks?:Record<string,unknown>[];recovered_pairs?:Record<string,unknown>[];model_tables?:{job_id:number;slot:number;model:string;rows:Record<string,unknown>[]}[];scored?:number;errors?:{job_id:number;reason:string}[]};
export type FinalRow = StockInput & {trade_eligible?:boolean;symbol:string;exchange:string;scores:Record<CardKey,number|null>;contributions:Record<CardKey,number|null>;status:string;rank:number|null;final:number|null;signed:number|null;action:string|null;suggested_units:number|null;sizing_reason?:string;settled:number|null;price:number|null;value:number|null;available_weight:number};
export type CardFinal = {id:number;sequence:number;revision_id:number;schema:"independent-scorecards-v1";policy:CardPolicy;rows:FinalRow[];attempts:Partial<Record<CardKey,number>>;source_runs:Partial<Record<CardKey,number|null>>};
export const isCard = (value:string):value is CardKey => (cards as readonly string[]).includes(value);
export function scorecardApi(client: Pick<typeof apiService,"get"|"post">, market: AutoRebalancePortfolioKey) {
  const base=URLs.runs.list()+"/scorecards/"+market;
  return {
    rebalanceReadiness:(revision:number)=>client.post<RebalanceReadiness>(base+"/revisions/"+revision+"/rebalance/readiness",{},{timeoutMs:190_000}),
    prepareSwingSource:(sequence:number)=>client.post<{id:number;sequence:number;listings:number;snapshot_id:number;swing_job_ids:number[]}>(base+"/workflows/"+sequence+"/prepare-swing-source",{}),
    coverage:(sequence:number)=>client.get<WorkflowCoverage>(base+"/workflows/"+sequence+"/coverage"),
    technicalExecutions:(rows:Record<string,unknown>[])=>client.post<Record<string,unknown>>(base+"/technical-execution-review",rows),
    pairTrials:()=>client.get<Record<string,unknown>[]>(base+"/pairwise-trials"),
    technicalValidation:()=>client.get<{status:string;holdout_start:string;holdout_end_exclusive:string;monitoring:{dates:number;qualifying_dates:number;expected:number;scored:number;unknown_outcomes:number};holdout_open:boolean;holdout:Record<string,unknown>;development_sensitivities:Record<string,{paired_dates:number;mean_change:number}>;calibration:{status:string;training_rows:number;test_rows:number;brier?:number;baseline_brier?:number;bins:{decile:number;n:number;predicted:number;observed:number;wilson_95:number[]}[]}}>(base+"/technical-validation"),
    performance:()=>client.get<{eligible_workflows:number;rows:Record<string,unknown>[];top_n:number;one_way_cost_bps:number;benchmark:string}>(base+"/research-performance"),
    savedPolicy:()=>client.get<CardPolicy|null>(base+"/saved-policy"),
    latestFinal:(seq?:number)=>client.get<CardFinal|null>(base+"/latest-final"+(seq?"?sequence="+seq:"")),
    prompt:(revision:number,card:CardKey)=>client.get<{prompt:string}>(base+"/revisions/"+revision+"/"+card+"/prompt"),
    list:()=>client.get<SourceRevision[]>(base+"/revisions"),
    read:(id:number)=>client.get<SourceDetail>(base+"/revisions/"+id),
    publish:(data:{request_key:string;sequence:number;snapshot_id?:number;captured_at:string;swing_job_ids:number[];verified_listings?:VerifiedListing[]})=>client.post<{id:number}>(base+"/revisions",data,{timeoutMs:65_000}),
    start:(revision:number,card:CardKey,data:{sequence:number;request_key:string;targets:ProviderModelTarget[];retry_attempt_id?:number;check_pair_order?:boolean;pair_mode?:"full"|"balanced";estimated_budget_inr?:number;evidence_only?:boolean})=>client.post<{id:number;run_id:number|null;scoring_version?:number}>(base+"/revisions/"+revision+"/"+card+"/start",data,{timeoutMs:card==="rebalance"?190_000:65_000}),
    repairThreats:(id:number)=>client.post<CardResult>(base+"/attempts/"+id+"/repair-threat-evidence",{},{timeoutMs:110_000}),
    repairPairs:(id:number)=>client.post<CardResult>(base+"/attempts/"+id+"/repair-pair-evidence",{},{timeoutMs:110_000}),
    recover:(id:number)=>client.post<CardResult>(base+"/attempts/"+id+"/recover",{},{timeoutMs:190_000}),
    result:(id:number)=>client.get<CardResult>(base+"/attempts/"+id,{timeoutMs:22_000}),
    final:(id:number)=>client.get<CardFinal>(base+"/finals/"+id),
    compare:(revision:number,sequence:number,attempts:Partial<Record<CardKey,number>>,config:CardPolicy,previous:ScoreMatrixFormulaConfig)=>client.post<{comparison:Record<string,unknown>[]}>(base+"/revisions/"+revision+"/final",{sequence,attempts,...config,compare_with:previous}),
    finalize:(revision:number,sequence:number,attempts:Partial<Record<CardKey,number>>,config:CardPolicy)=>client.post<CardFinal>(base+"/revisions/"+revision+"/final",{sequence,attempts,...config}),
  };
}


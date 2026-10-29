import {buildTechnicalScanMap} from '@/app/console/_components/FinalActionablesConsole';
import {inspectStockJob,type StockOutputState} from './stockFlowEvidence';
import {isAnalysisRunForStage,type AnalysisRunStage} from './rebalanceRunIdentity';
import {savedJobElapsed} from './savedJobPresentation';
import {legacyUtcTimestamp} from './recordedTiming';
import type {RunResponse} from '@/types/api';
export const MATRIX_STAGES:AnalysisRunStage[]=['threats','swing','rebalance','technical'];
export type MatrixSource={key:string;runId:number;jobId:number;stage:AnalysisRunStage;provider:string;model:string;state:StockOutputState;stocks:string[];elapsed:number|null};
const identity=(row:Record<string,string>)=>[(row['Exchange Symbol']??'').trim().toUpperCase(),(row['Stock Symbol']??'').trim().toUpperCase()].join(':');
/** Projects only the caller's already selected jobs. No latest-run resolution, holdings or provider reads. */
export function selectedStockMatrix(runs:RunResponse[],market:'india'|'us'){
 const sources:MatrixSource[]=[],stocks=new Map<string,{key:string;symbol:string;exchange:string}>();
 for(const run of runs){const stage=MATRIX_STAGES.find(value=>isAnalysisRunForStage(run,value,market));if(!stage)continue;
  for(const link of run.run_jobs){let parsed:{state:StockOutputState;rows:Record<string,string>[]}=inspectStockJob(run,link);const keys=new Set<string>();
   // Technical aliases have a distinct admitted parser; never infer their absence from the recommendation parser.
   if(stage==='technical'&&link.job.status==='completed'&&link.job.response?.trim()){
    const rows=Object.values(buildTechnicalScanMap([{...run,run_jobs:[link]}])).map(row=>({'Stock Symbol':row.stockSymbol,'Exchange Symbol':row.exchangeSymbol}));
    parsed={state:rows.length?'populated':'unparseable',rows};
   }
   for(const row of parsed.rows){const key=identity(row),symbol=row['Stock Symbol']?.trim().toUpperCase();if(!symbol)continue;keys.add(key);stocks.set(key,{key,symbol,exchange:(row['Exchange Symbol']??'').trim().toUpperCase()});}
   sources.push({key:run.id+':'+link.job_id,runId:run.id,jobId:link.job_id,stage,provider:link.job.provider,model:link.job.model,state:parsed.state,stocks:[...keys],elapsed:['completed','failed','canceled','cancelled','partial'].includes(link.job.status)?savedJobElapsed(legacyUtcTimestamp(link.job.created_at??''),legacyUtcTimestamp(link.job.updated_at??'')):null});
  }
 }
 return {sources,stocks:[...stocks.values()].sort((a,b)=>a.key.localeCompare(b.key))};
}
export function aboveSavedBuyThreshold(action:string,score:number|null,threshold:number|null):boolean|null{
 if(threshold===null||!Number.isFinite(threshold)||score===null||!Number.isFinite(score))return null;
 return (action==='Buy New'||action==='Add more')&&score>threshold;
}

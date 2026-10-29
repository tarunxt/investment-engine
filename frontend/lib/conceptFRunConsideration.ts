import type {RunResponse} from '@/types/api';
import {getAnalysisRunIdentity} from './rebalanceRunIdentity';
import {inspectStockJob} from './stockFlowEvidence';
import {buildTechnicalScanMap} from '@/app/console/_components/FinalActionablesConsole';
import {legacyUtcTimestamp,recordedTiming} from './recordedTiming';
/** Only explicitly selected, already-authorized job projections enter here.
 * A latest label is descriptive within that selection, never source resolution. */
export type ConsiderationUsage={stockCount:number;rows:{run:number;key:string}[]};
export function runConsideration(runs:RunResponse[],market:'india'|'us',usage?:ConsiderationUsage){
 const rows=runs.map(run=>{
  const identity=getAnalysisRunIdentity(run);
  const admitted=identity.market===market&&identity.stage!==null;
  const stamp=legacyUtcTimestamp(run.created_at??'');
  const time=recordedTiming(stamp,stamp,[]).total===0?Date.parse(stamp):null;
  const jobs=run.run_jobs.map(link=>{
   const generic=inspectStockJob(run,link);
   const technical=identity.stage==='technical'?Object.values(buildTechnicalScanMap([{...run,run_jobs:[link]}])):null;
   const technicalRows=technical?[...new Map(technical.map(row=>[row.exchangeSymbol+':'+row.stockSymbol,{'Exchange Symbol':row.exchangeSymbol,'Stock Symbol':row.stockSymbol}])).values()]:[];
   const parsed=technical?(technicalRows.length?{state:'populated' as const,rows:technicalRows}:{state:link.job.status==='completed'&&link.job.response?.trim()?'unparseable' as const:generic.state,rows:[]}):generic;
   return {id:link.job_id,provider:link.job.provider,model:link.job.model,status:link.job.status,state:parsed.state,
    rows:admitted&&['populated','empty'].includes(parsed.state)?parsed.rows.length:null,
    identities:admitted?parsed.rows.map(row=>[(row['Exchange Symbol']??'').trim().toUpperCase(),(row['Stock Symbol']??'').trim().toUpperCase()].join(':')):[]};
  });
  return {id:run.id,label:run.auto_rebalance_label??'Saved Run '+run.id,createdAt:run.created_at,stage:admitted?identity.stage:null,time,jobs,
   parsedRows:jobs.every(job=>job.rows!==null)?jobs.reduce((sum,job)=>sum+job.rows!,0):null,
   rowsUsed:admitted&&usage?new Set(usage.rows.filter(row=>row.run===run.id).map(row=>row.key)).size:null};
 });
 const latest=new Map<string,number>();
 for(const row of rows)if(row.stage&&row.time!==null)latest.set(row.stage,Math.max(latest.get(row.stage)??-Infinity,row.time));
 const stocks=new Set(rows.flatMap(row=>row.jobs.flatMap(job=>job.identities)));
 return {rows:rows.map(row=>({...row,latest:row.stage!==null&&row.time!==null&&latest.get(row.stage)===row.time})),
  runCount:rows.length,jobCount:rows.reduce((sum,row)=>sum+row.jobs.length,0),completedJobs:rows.reduce((sum,row)=>sum+row.jobs.filter(job=>job.status==='completed').length,0),
  stockCount:usage?.stockCount??null,parsedStockCount:stocks.size,coverageComplete:rows.length>0&&rows.every(row=>row.stage!==null&&row.jobs.length>0&&row.jobs.every(job=>job.rows!==null))};
}

import {inspectSavedStockJob,stockOutputMessage} from './stockFlowEvidence';
import {getSignedUnitsChange,getRowRationaleDisplayScore,RATIONALE_SCORE_HEADERS,inspectRecordedRationaleScore} from '@/app/console/_components/FinalActionablesConsole';
import type {AutoRebalanceJobDetailResponse} from '@/types/api';
/** Exact saved response identity, not a live portfolio or a new voting algorithm. */
export function capturedStockSources(jobs:AutoRebalanceJobDetailResponse[],stock:Record<string,string>){
 const symbol=stock['Stock Symbol']?.trim().toUpperCase(),exchange=stock['Exchange Symbol']?.trim().toUpperCase();
 const counts=new Map<number,number>();for(const job of jobs)counts.set(job.id,(counts.get(job.id)??0)+1);
 const entries=jobs.slice(0,100).filter((job,index,all)=>all.findIndex(item=>item.id===job.id)===index).map(job=>{
  const base={id:job.id,provider:job.provider,model:job.model,status:job.status,created_at:job.created_at,updated_at:job.updated_at,cells:undefined as Record<string,string>|undefined,units:null as number|null,amount:null as string|null,score:null as number|null,numericSourceAdmitted:false};
  if(!Number.isSafeInteger(job.id)||job.id<1||counts.get(job.id)!==1)return{...base,state:'ambiguous source identity',matched:false,action:null};
  const parsed=inspectSavedStockJob(job),matches=symbol&&exchange?parsed.rows.filter(row=>row['Stock Symbol']?.trim().toUpperCase()===symbol&&row['Exchange Symbol']?.trim().toUpperCase()===exchange):[];
  if(!symbol||!exchange)return{...base,state:'exchange/ticker identity unverified',matched:false,action:null};
  if(matches.length!==1)return{...base,state:matches.length>1?'ambiguous duplicate stock rows':parsed.state==='populated'?'not mentioned in this saved output':stockOutputMessage(parsed.state),matched:false,action:null};
  const cells=matches[0],literal=(value:string|undefined)=>!value?.trim()||(/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value.trim())&&Number.isFinite(Number(value.replace(/,/g,''))));
  const unitsAdmitted=['Current Units','Units Change','Units to Buy'].every(field=>literal(cells[field]));
  const scoreAdmitted=RATIONALE_SCORE_HEADERS.every(field=>!cells[field]?.trim()||inspectRecordedRationaleScore(cells[field]).state==='accepted');
  return{...base,state:stockOutputMessage(parsed.state),matched:true,action:cells['Action (Buy/Add/Sell All/Trim/Hold/Buy New)']??cells['Action']??null,cells,units:unitsAdmitted?getSignedUnitsChange(cells):null,amount:cells['Total Buy Amount']?.trim()||null,score:scoreAdmitted?getRowRationaleDisplayScore(cells):null,numericSourceAdmitted:unitsAdmitted&&scoreAdmitted};
 });
 return{entries,matching:entries.filter(row=>row.matched).length,inspected:entries.length,total:jobs.length,complete:jobs.length<=100,identityVerified:!!symbol&&!!exchange};
}

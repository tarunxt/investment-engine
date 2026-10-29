import type {RunResponse} from '@/types/api';
import {unitDifference} from './conceptFStockFlow';
/** Actual owned GET response shape; caller identity remains server-authenticated. */
export function admitRecordedRun(value:unknown,requested:number):RunResponse {
 const row=value as RunResponse;
 if(!Number.isSafeInteger(requested)||requested<=0||!row||row.id!==requested||typeof row.prompt!=='string'||typeof row.status!=='string'||!Number.isSafeInteger(row.current_stage)||!Array.isArray(row.run_jobs))throw new Error('Exact saved run required');
 const ids=new Set<number>();
 for(const link of row.run_jobs){const job=link?.job;if(!link||!Number.isSafeInteger(link.id)||link.id<=0||ids.has(link.id)||link.run_id!==requested||!Number.isSafeInteger(link.job_id)||link.job_id<=0||!Number.isSafeInteger(link.stage)||link.stage<1||!job||job.id!==link.job_id||typeof job.prompt!=='string'||typeof job.provider!=='string'||typeof job.model!=='string'||typeof job.status!=='string'||job.response!==null&&job.response!==undefined&&typeof job.response!=='string')throw new Error('Exact related saved job required');ids.add(link.id);}
 return row;
}
/** Exact display over recorded estimates only, never a bill, quote or spend grant. */
export function recordedRunUsage(run:RunResponse){
 const links=run.run_jobs,counts=new Map<number,number>();for(const link of links)counts.set(link.job_id,(counts.get(link.job_id)??0)+1);
 const usable=links.filter(link=>counts.get(link.job_id)===1),duplicate=usable.length!==links.length;
 const priced=usable.filter(({job})=>typeof job.estimated_cost==='number'&&Number.isFinite(job.estimated_cost)&&job.estimated_cost>=0);
 let subtotal:string|null=priced.length?'0':null;for(const {job} of priced){if(subtotal===null)break;subtotal=unitDifference(subtotal,String(-job.estimated_cost!));}
 const incomplete=!links.length||duplicate||priced.length!==links.length||subtotal===null;
 const tokens=(key:'tokens_in'|'tokens_out')=>!links.length||duplicate||usable.some(({job})=>!Number.isSafeInteger(job[key])||job[key]!<0)?null:usable.reduce((sum,{job})=>sum+BigInt(job[key]!),BigInt(0)).toString();
 const tokensIn=tokens('tokens_in'),tokensOut=tokens('tokens_out');
 return {subtotal,total:incomplete?null:subtotal,incomplete,duplicate,missingCostLinks:links.length-priced.length,tokensIn,tokensOut,tokensTotal:tokensIn===null||tokensOut===null?null:(BigInt(tokensIn)+BigInt(tokensOut)).toString()};
}

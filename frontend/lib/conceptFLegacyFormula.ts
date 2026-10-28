import type {RunResponse} from '@/types/api';
/** Existing history detail supplies the allowed IDs; the owned server getter
 * authorizes the caller. Never fetch an arbitrary ID from an editable URL. */
export async function loadSelectedFormulaRuns({ids,allowed,portfolio,sequence,getRun,assertCurrent}:{ids:number[];allowed:number[];portfolio:'india'|'indmoney_us';sequence:number;getRun:(id:number)=>Promise<RunResponse>;assertCurrent:()=>void}):Promise<RunResponse[]>{
 if(!ids.length||ids.some(id=>!Number.isSafeInteger(id)||id<1||!allowed.includes(id))||new Set(ids).size!==ids.length)throw new Error('Choose known owned history sources');
 const result:RunResponse[]=[], admittedJobs=new Set<number>();
 for(let start=0;start<ids.length;start+=4){
  assertCurrent();const batch=await Promise.all(ids.slice(start,start+4).map(async id=>{
   const row=await getRun(id);assertCurrent();
   if(row.id!==id||row.auto_rebalance_portfolio!==portfolio||row.auto_rebalance_sequence!==sequence||!Array.isArray(row.run_jobs))throw new Error('Exact saved source binding changed');
   if(new Set(row.run_jobs.map(link=>link?.job_id)).size!==row.run_jobs.length)throw new Error('Duplicate saved job links are ambiguous');
   if(row.run_jobs.some(link=>!link||!Number.isSafeInteger(link.job_id)||link.job_id<1||link.job?.id!==link.job_id
     ||link.job.auto_rebalance_portfolio&&link.job.auto_rebalance_portfolio!==portfolio))throw new Error('Saved job source binding changed');
   return row;
  }));assertCurrent();for(const row of batch)for(const link of row.run_jobs){if(admittedJobs.has(link.job_id))throw new Error('Same saved job attributed to multiple selected Runs');admittedJobs.add(link.job_id);}result.push(...batch);
 }
 return result;
}

export function selectFormulaJobs(runs:RunResponse[],keys:string[]):RunResponse[]{
 const available=new Set(runs.flatMap(run=>run.run_jobs.map(link=>`${run.id}:${link.job_id}`)));
 if(new Set(keys).size!==keys.length||keys.some(key=>!available.has(key)))throw new Error('Exact saved job selection required');
 const selected=new Set(keys);
 return runs.map(run=>({...run,run_jobs:run.run_jobs.filter(link=>{
  if(link.job?.id!==link.job_id)throw new Error('Saved job link changed');
  if(link.job.auto_rebalance_portfolio&&link.job.auto_rebalance_portfolio!==run.auto_rebalance_portfolio)throw new Error('Saved job market differs from run');
  return selected.has(`${run.id}:${link.job_id}`);
 }),synthesis_response:null,decision_response:null})).filter(run=>run.run_jobs.length>0);
}

/** URL state is a request to inspect, never authority to fetch a foreign ID. */
export function formulaRunSelection(raw:string|null,allowed:number[]):number[]{
 if(!raw)return [];
 if(raw.length>2000||!/^\d+(,\d+)*$/.test(raw))throw new Error('Unsupported saved source selection');
 const ids=raw.split(',').map(Number);
 if(ids.length>100||new Set(ids).size!==ids.length||ids.some(id=>!Number.isSafeInteger(id)||id<1||!allowed.includes(id)))throw new Error('Saved source not in this owned history');
 return ids;
}

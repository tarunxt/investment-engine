import type {AutoRebalanceHistoryDetailResponse} from '@/types/api';
import {canonicalRecordedCost,recordedCostTimestamp} from './conceptFCostReceipts';
import {legacyUtcTimestamp,recordedTiming} from './recordedTiming';
/** Existing authenticated exact-history response only. Never an owner assertion from this legacy shape. */
export function legacyCostGroups(record:AutoRebalanceHistoryDetailResponse,portfolio:string,sequence:number){
 if(record.portfolio!==portfolio||record.sequence!==sequence||!Number.isSafeInteger(sequence)||sequence<1||!Array.isArray(record.runs)||!Array.isArray(record.standalone_jobs)||record.runs.length>100||record.standalone_jobs.length>100)return null;
 const groups=[...record.runs.map(run=>({id:'run-'+run.id,runId:Number.isSafeInteger(run.id)&&run.id>0?run.id:null,label:'Run '+run.id,jobs:run.jobs})),{id:'standalone',runId:null,label:'Standalone saved jobs',jobs:record.standalone_jobs}];
 if(groups.some(group=>!Array.isArray(group.jobs)||group.jobs.length>100)||new Set(groups.map(group=>group.id)).size!==groups.length)return null;
 const seen=new Set<number>();
 return groups.map(group=>({...group,jobs:group.jobs.map(job=>{
  if(!Number.isSafeInteger(job.id)||job.id<1||seen.has(job.id))throw new Error('Ambiguous saved job identity');seen.add(job.id);
  const at=recordedCostTimestamp(legacyUtcTimestamp(job.created_at)),updated=typeof job.updated_at==='string'?recordedCostTimestamp(legacyUtcTimestamp(job.updated_at)):null;
  const count=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
  const lifecycle=at&&updated?recordedTiming(at,updated,[{id:job.id,provider:job.provider,model:job.model,status:job.status,created_at:at,updated_at:updated}]):null;
  const metadata=job.runtime_metadata_json;
  return {id:job.id,provider:job.provider,model:job.model,status:job.status,diagnostics:{tokensIn:count(job.tokens_in),tokensOut:count(job.tokens_out),createdAt:at,updatedAt:updated,lifecycleSeconds:lifecycle?.complete?lifecycle.total:null,measuredProviderSeconds:null,webSearchUsed:typeof job.web_search_used==='boolean'?job.web_search_used:null,runtimeMetadataPresent:metadata!==null&&typeof metadata==='object'&&!Array.isArray(metadata)},cost:canonicalRecordedCost(typeof job.estimated_cost==='number'&&Number.isFinite(job.estimated_cost)&&job.estimated_cost>=0?String(job.estimated_cost):null),at};
 })})).filter(group=>group.jobs.length);
}

import type {AutoRebalanceHistoryDetailResponse,AutoRebalanceStageResponse} from '@/types/api';
import {admitTimingJob,legacyUtcTimestamp,recordedTiming,type TimingJob} from './recordedTiming';
/** Already-authorized history only; no fallback from an absent requested run to another job. */
export function legacyRecordedTiming(record:AutoRebalanceHistoryDetailResponse,stage:AutoRebalanceStageResponse){
 let jobs:TimingJob[]|null=null;
 try{
  let source;
  if(stage.run_id!=null){if(!Number.isSafeInteger(stage.run_id)||stage.run_id<1)throw new Error('Exact run required');const matches=record.runs.filter(row=>row.id===stage.run_id);if(matches.length!==1)throw new Error('Exact run required');source=matches[0].jobs;}
  else if(stage.job_id!=null){if(!Number.isSafeInteger(stage.job_id)||stage.job_id<1)throw new Error('Exact job required');source=record.standalone_jobs.filter(row=>row.id===stage.job_id);if(source.length!==1)throw new Error('Exact job required');}
  if(source){if(!Array.isArray(source)||source.length>100)throw new Error('Bounded jobs required');jobs=source.map(job=>admitTimingJob(job,job.id,{provider:job.provider,model:job.model}));}
 }catch{jobs=null;}
 const timing=recordedTiming(stage.started_at?legacyUtcTimestamp(stage.started_at):null,stage.completed_at?legacyUtcTimestamp(stage.completed_at):null,jobs);
 return {timing,sourceJobs:jobs??[],sourceVerified:jobs!==null,sourceKind:stage.run_id!=null?'saved run':stage.job_id!=null?'saved job':'no linked job',sourceId:stage.run_id??stage.job_id??null};
}

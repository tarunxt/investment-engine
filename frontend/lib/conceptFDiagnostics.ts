import {safeResearchData} from './conceptFResearch';
/** Exact saved failure contract from jobs/failure_diagnostics.py. No retry authority. */
export function savedFailureDiagnostic(job:{id:number;provider:string;model:string;error_message?:string|null;updated_at:string;runtime_metadata_json?:unknown}){
 const metadata=job.runtime_metadata_json;
 const raw=metadata&&typeof metadata==='object'&&!Array.isArray(metadata)?(metadata as Record<string,unknown>).failure_diagnostics:null;
 const d=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:null;
 const admitted=Number.isSafeInteger(job.id)&&job.id>0&&d?.job_id===job.id&&d.provider===job.provider&&d.model===job.model;
 const text=(value:unknown)=>typeof value==='string'&&value.trim()?String(safeResearchData(value)):'Unavailable';
 const id=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0?String(value):'Unavailable';
 const otherMetadata=metadata&&typeof metadata==='object'&&!Array.isArray(metadata)?safeResearchData(Object.fromEntries(Object.entries(metadata).slice(0,200).filter(([key])=>key!=='failure_diagnostics'))):null;
 return {admitted,otherMetadata,fields:[['Provider',text(job.provider)],['Model',text(job.model)],['Job ID',id(job.id)],['Run ID',admitted?id(d.run_id):'Unavailable'],['HTTP status',admitted&&Number.isInteger(d.http_status)&&Number(d.http_status)>=100&&Number(d.http_status)<=599?String(d.http_status):'Unavailable'],['Retry safe',admitted&&typeof d.retry_safe==='boolean'?(d.retry_safe?'Recorded yes · not authorization':'Recorded no'):'Unavailable'],['Correlation ID',admitted?text(d.correlation_id):'Unavailable'],['Attempt',admitted?id(d.attempt):'Unavailable'],['Exception type',admitted?text(d.exception_type):'Unavailable'],['Trace reference',admitted?text(d.trace_reference):'Unavailable'],['Saved update',text(job.updated_at)]],message:job.error_message??(admitted&&typeof d.exception_message==='string'?d.exception_message:null),body:admitted&&typeof d.provider_response_body==='string'?d.provider_response_body:null};
}

export type DiagnosticJob={id:number;provider:string;model:string;error_message?:string|null;updated_at:string;runtime_metadata_json?:Record<string,unknown>|null};
export function admitDiagnosticJob(raw:unknown,id:number,expected:{provider:string;model:string}):DiagnosticJob{
 const job=raw as DiagnosticJob;
 if(!job||!Number.isSafeInteger(id)||id<1||job.id!==id||job.provider!==expected.provider||job.model!==expected.model||!expected.provider||!expected.model||typeof job.updated_at!=='string'||job.updated_at.length>100||(job.error_message!=null&&typeof job.error_message!=='string')||(job.runtime_metadata_json!=null&&(typeof job.runtime_metadata_json!=='object'||Array.isArray(job.runtime_metadata_json))))throw new Error('Exact saved diagnostic job required');
 return {id,provider:job.provider,model:job.model,error_message:job.error_message??null,updated_at:job.updated_at,runtime_metadata_json:job.runtime_metadata_json??null};
}

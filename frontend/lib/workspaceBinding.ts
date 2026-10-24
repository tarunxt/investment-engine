/** Display classification only. Backend input validation remains authoritative. */
export type RunInputs={source_hash?:string;plan_hash?:string;source?:{snapshot_id?:number|null;source_receipt_id?:string;simulation_only?:boolean;connection?:{id?:string;version?:number}|null}};
export function workspaceBindingState(inputs:RunInputs|undefined,portfolio:string,binding:{id:string;version:number}|null,latestId:number|undefined){
 const source=inputs?.source;if(!source)return 'unverified';
 if(portfolio==='india'){
  if(!binding||!source.connection?.id||!Number.isInteger(source.connection.version))return 'unverified';
  if(source.connection.id!==binding.id||source.connection.version!==binding.version)return 'different_binding';
 }
 if(!Number.isInteger(source.snapshot_id)||!Number.isInteger(latestId))return 'unverified';
 return source.snapshot_id===latestId?'matches_recorded_inputs':'different_binding';
}

export function checklistReady(inputs:RunInputs|undefined,version:number,readiness:{current?:boolean;version?:number;source_hash?:string;plan_hash?:string;orders_authorized?:boolean}|undefined){return readiness?.current===true&&readiness.orders_authorized===false&&readiness.version===version&&typeof inputs?.source_hash==='string'&&typeof inputs.plan_hash==='string'&&readiness.source_hash===inputs.source_hash&&readiness.plan_hash===inputs.plan_hash;}

/** A native journal has no snapshot row. Exact server validation binds its latest
 * owned receipt/hash; current connection identity/version is checked separately. */
export function currentPlanReady(inputs:RunInputs|undefined,version:number,readiness:Parameters<typeof checklistReady>[2],portfolio:string,binding:{id:string;version:number}|null,latestId:number|undefined){
 if(!checklistReady(inputs,version,readiness))return false;
 const source=inputs?.source;
 if(portfolio==='india'&&source?.snapshot_id===null&&source.simulation_only===true&&typeof source.source_receipt_id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(source.source_receipt_id))return !!binding&&source.connection?.id===binding.id&&source.connection.version===binding.version;
 return workspaceBindingState(inputs,portfolio,binding,latestId)==='matches_recorded_inputs';
}

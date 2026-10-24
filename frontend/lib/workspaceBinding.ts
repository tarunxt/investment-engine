/** Display classification only. Backend input validation remains authoritative. */
export type RunInputs={source_hash?:string;plan_hash?:string;source?:{snapshot_id?:number|null;connection?:{id?:string;version?:number}|null}};
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

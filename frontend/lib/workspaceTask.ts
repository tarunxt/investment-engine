export type WorkspaceRun={id:number;portfolio:string;status:string;stage:string;version:number};
export type WorkspaceOrder={id:string;module_id:string;state:string;unresolved:boolean;actions?:{confirm?:boolean}};
export function nextWorkspaceTask({module,available,connected,run,orders,activityKnown}:{module:string;available:boolean;connected:boolean;run?:WorkspaceRun;orders:WorkspaceOrder[];activityKnown:boolean}){
 const unresolved=orders.find(x=>x.module_id===module&&x.unresolved);
 if(unresolved)return {label:'Resolve recorded order outcome',href:'/console/profile/activity',reason:`Recorded order state: ${unresolved.state}. Reconcile before any new instruction.`};
 const review=orders.find(x=>x.module_id===module&&x.state==='awaiting_approval');
 if(review)return {label:'Review exact instructions',href:'/console/profile/activity',reason:'A recorded review is available. No consent or fill is inferred.'};
 if(!activityKnown)return {label:'Check recorded activity',href:'/console/profile/activity',reason:'Activity is unavailable; no safe or empty outcome is inferred.'};
 if(!available)return {label:'Review module availability',href:'/console/profile/preferences#modules',reason:'The selected module has not passed its availability gate.'};
 if(run&&run.status!=='completed')return {label:'Resume research activity',href:`/console/uat2#analysis-workflow-${run.id}`,reason:`Research ${run.id} · version ${run.version} · ${run.status} · ${run.stage}. Opening it does not restart work.`};
 if(run?.status==='completed')return {label:'Review research result',href:`/console/uat2#analysis-workflow-${run.id}`,reason:`Research ${run.id} · version ${run.version} completed. This is not approval or an execution receipt.`};
 if(!connected)return {label:module==='indmoney_us'?'Review manual import':'Review connection setup',href:module==='indmoney_us'?'/console/indmoney-us':'/console/profile/connections',reason:'Connection or accepted source readiness still needs review.'};
 return {label:'Review research setup',href:'/console/uat2',reason:'Review inputs and usage before deliberately starting research.'};
}

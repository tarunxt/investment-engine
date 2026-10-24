export const researchStages=[['sync','Sync Portfolio','Validate the owned frozen holdings source'],['threats','Threats Scan','Review risks in the frozen research inputs'],['swing','Swing Scan','Run the configured opportunity analysis'],['rebalance','Rebalance','Evaluate the configured portfolio proposal'],['technical','Technical Scan','Review supported technical conditions'],['actionables','Actionables','Create a research result for separate plan review']] as const;
export type StartBinding={source_hash:string;plan_hash:string;snapshot_id:number|null;module_version?:number};
export async function researchRequestKey(owner:string,portfolio:string,binding:StartBinding,nonce='default'){
 if(!(binding.snapshot_id===null||Number.isInteger(binding.snapshot_id)&&binding.snapshot_id>0)||binding.module_version!==undefined&&(!Number.isInteger(binding.module_version)||binding.module_version<1))throw new Error('Verified source and module versions required');
 if(!/^[a-f0-9]{64}$/.test(binding.source_hash)||!/^[a-f0-9]{64}$/.test(binding.plan_hash))throw new Error('Verified frozen hashes required');
 const bytes=new TextEncoder().encode(JSON.stringify([owner,portfolio,binding.source_hash,binding.plan_hash,binding.snapshot_id,binding.module_version??null,nonce]));
 const hash=await crypto.subtle.digest('SHA-256',bytes);return 'research-v1:'+Array.from(new Uint8Array(hash),value=>value.toString(16).padStart(2,'0')).join('');
}
export function newerResearch<T extends {version:number;progress?:{progress_rank?:number[];observed_at?:string}}>(current:T|undefined,incoming:T):T{
 if(!current)return incoming;
 const left=current.progress?.progress_rank??[current.version],right=incoming.progress?.progress_rank??[incoming.version];
 for(let index=0;index<Math.max(left.length,right.length);index++){if((right[index]??0)>(left[index]??0))return incoming;if((right[index]??0)<(left[index]??0))return current;}
 const incomingTime=Date.parse(incoming.progress?.observed_at??''),currentTime=Date.parse(current.progress?.observed_at??'');
 return Number.isFinite(incomingTime)&&(!Number.isFinite(currentTime)||incomingTime>currentTime)?incoming:current;
}
export function researchStateLabel(state:string){return ({source_partial:'Source incomplete',invalid_input:'Inputs need review',budget_stop:'Budget stopped',unknown_spend:'Spending receipt unresolved',policy_stopped:'Policy stopped',cancel_requested:'Cancellation requested',cancelled:'Cancelled',completed:'Research completed',failed:'Research failed',partial:'Research partially completed',paused:'Research paused',queued:'Queued',processing:'Research in progress',skipped:'Scheduled run skipped'} as Record<string,string>)[state]??'State needs review';}

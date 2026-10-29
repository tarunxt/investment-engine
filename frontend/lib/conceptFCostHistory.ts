import {recordedCosts,recordedCostTimestamp} from './conceptFCostReceipts';
import type {Workflow} from '@/app/console/automated-rebalance/_components/ServerAnalysis';
const stages=['sync','threats','swing','rebalance','technical','actionables'];
export function costHistoryInstant(value:unknown){const at=recordedCostTimestamp(value);return at===null?null:Date.parse(at);}
function sum(values:(string|null)[]){let total=BigInt(0);for(const value of values){if(value===null||!/^\d{1,18}(?:\.\d{1,12})?$/.test(value))return null;const[a,b='']=value.split('.');total+=BigInt(a)*BigInt(10)**BigInt(12)+BigInt(b.padEnd(12,'0'));}if(!values.length)return null;const digits=total.toString().padStart(13,'0'),fraction=digits.slice(-12).replace(/0+$/,'');return digits.slice(0,-12)+(fraction?'.'+fraction:'');}
/** Already-fetched selected-module records only; never chooses another owner/market. */
export function ownedCostHistory(raw:Workflow[],owner:number,portfolio:string){
 const counts=new Map<number,number>();for(const row of raw.slice(0,100))counts.set(row?.id,(counts.get(row?.id)??0)+1);
 const admitted=raw.slice(0,100).filter(row=>row?.owner_id===owner&&row.portfolio===portfolio&&Number.isSafeInteger(row.id)&&row.id>0&&counts.get(row.id)===1&&Number.isSafeInteger(row.version)&&row.version>=0&&row.inputs?.orders_authorized===false&&/^[a-f0-9]{64}$/.test(row.inputs.source_hash)&&/^[a-f0-9]{64}$/.test(row.inputs.plan_hash)&&Array.isArray(row.stages)&&row.stages.length===6&&new Set(row.stages.map(item=>item.stage)).size===6&&row.stages.every(item=>stages.includes(item.stage)));
 const runs=admitted.map(row=>{const entries=row.stages.map(stage=>({stage,provider:row.inputs.plan?.stages?.[stage.stage]?.provider??'Not recorded',model:row.inputs.plan?.stages?.[stage.stage]?.model??'Not recorded',receipts:recordedCosts(stage.checkpoint.attempts,stage.attempts,stage.checkpoint.job_history)}));return {row,createdAt:recordedCostTimestamp((row.progress as {created_at?:unknown}|undefined)?.created_at),at:costHistoryInstant((row.progress as {created_at?:unknown}|undefined)?.created_at),entries,completeTotal:sum(entries.map(item=>item.receipts.total)),knownSubtotal:sum(entries.map(item=>item.receipts.knownSubtotal).filter((value):value is string=>value!==null))};});
 return {runs,rejected:raw.length-admitted.length,truncated:raw.length>100};
}
export function filterCostHistory(runs:ReturnType<typeof ownedCostHistory>['runs'],filter:{stage:string;model:string;days:number;now:number}){
 return runs.filter(run=>!filter.days||run.at===null||run.at>filter.now||run.at>=filter.now-filter.days*86400000).map(run=>({...run,entries:run.entries.filter(item=>(filter.stage==='all'||item.stage.stage===filter.stage)&&(filter.model==='all'||item.provider+'/'+item.model===filter.model))})).filter(run=>run.entries.length);
}

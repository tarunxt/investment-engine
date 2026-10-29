import type {Workflow} from '@/app/console/automated-rebalance/_components/ServerAnalysis';
import {safeResearchData} from './conceptFResearch';
import {recordedCostTimestamp} from './conceptFCostReceipts';
export type USSummaryIdentity={owner:number;research:number;version:number;source:string;plan:string;snapshot:number;result:string};
export function usSummaryIdentity(row:Workflow):USSummaryIdentity|null{
 if(!row||typeof row!=='object')return null;
 const snapshot=row.inputs?.source?.snapshot_id,stages=Array.isArray(row.stages)?row.stages:[];
 const result=(stages.find(stage=>stage?.stage==='actionables')?.checkpoint as {result_hash?:unknown}|undefined)?.result_hash;
 if(typeof result!=='string'||!/^[a-f0-9]{64}$/.test(result)||row.portfolio!=='indmoney_us'||row.status!=='completed'||!Number.isSafeInteger(row.owner_id)||row.owner_id<1||!Number.isSafeInteger(row.id)||row.id<1||!Number.isSafeInteger(row.version)||row.version<0||row.inputs?.orders_authorized!==false||!Number.isSafeInteger(snapshot)||!snapshot||snapshot<1||![row.inputs.source_hash,row.inputs.plan_hash].every(v=>/^[a-f0-9]{64}$/.test(v))||!Array.isArray(row.stages)||row.stages.length!==6||new Set(row.stages.map(s=>s?.stage)).size!==6||!['sync','threats','swing','rebalance','technical','actionables'].every(key=>row.stages.some(stage=>stage?.stage===key&&stage.status==='completed')))return null;
 return{owner:row.owner_id,research:row.id,version:row.version,source:row.inputs.source_hash,plan:row.inputs.plan_hash,snapshot,result};
}
export type USSavedSummary={version:string;capturedAt:string;snapshot:number;result:string;rows:{instrument:string;action:string;signal:string|null}[]};
export function admitUSSummary(raw:unknown,identity:USSummaryIdentity):USSavedSummary{
 const p=raw as Record<string,unknown>,actions=p?.actions;
 if(!p||p.schema_version!==1||p.owner_id!==identity.owner||p.workflow_id!==identity.research||p.portfolio!=='indmoney_us'||p.currency!=='USD'||p.connection!==null||p.snapshot_id!==identity.snapshot||p.source_hash!==identity.source||p.plan_hash!==identity.plan||p.result_hash!==identity.result||p.simulation!==true||p.orders_authorized!==false||p.current!==true||!recordedCostTimestamp(p.captured_at)||![p.version,p.result_hash].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v))||!Array.isArray(actions)||!actions.length||actions.length>200)throw new Error('Exact current owned USD proposal required');
 const seen=new Set<string>();const rows=actions.map((value:unknown)=>{const action=value as Record<string,unknown>;if(!action||typeof action.instrument!=='string'||!/^US:[A-Z0-9&_.-]{1,64}$/.test(action.instrument)||seen.has(action.instrument)||action.evidence_hash!==p.result_hash||typeof action.action!=='string'||!['buy','add','trim','sell','hold'].includes(action.action)||!['buy','sell','none'].includes(String(action.side)))throw new Error('Bounded unique source-bound US actions required');seen.add(action.instrument);return{instrument:action.instrument,action:action.action,signal:typeof action.rationale==='string'&&action.rationale.trim()?String(safeResearchData(action.rationale)):null};});
 return{version:p.version as string,capturedAt:p.captured_at as string,snapshot:identity.snapshot,result:identity.result,rows};
}

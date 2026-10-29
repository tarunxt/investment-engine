import type {Workflow} from '@/app/console/automated-rebalance/_components/ServerAnalysis';
import {displayProduct,stockStageOutput,type FlowStage} from './conceptFStockFlow';
import {safeResearchData} from './conceptFResearch';
const decimal=(v:unknown)=>typeof v==='string'&&v.length<=40&&/^\d+(?:\.\d+)?$/.test(v)&&Number.isFinite(Number(v))?v:null;
/** Frozen user policy is not a live funds, suitability or execution validation. */
export function savedConstraints(row:Workflow){
 const raw=row.inputs.research_setup as unknown as {owner_id?:unknown;portfolio?:unknown;source_hash?:unknown;version?:unknown;constraints?:Record<string,unknown>}|undefined;
 if(!/^[a-f0-9]{64}$/.test(row.inputs.source_hash)||!/^[a-f0-9]{64}$/.test(row.inputs.research_setup_hash??'')||!raw||raw.owner_id!==row.owner_id||raw.portfolio!==row.portfolio||raw.source_hash!==row.inputs.source_hash||raw.version!=='synthetic-research-options-v1')return null;
 const p=raw.constraints;if(!p||Object.keys(p).sort().join(',')!=='horizon_days,maximum_position_percent,maximum_turnover_percent,minimum_cash'||!Number.isSafeInteger(p.horizon_days)||Number(p.horizon_days)<1||Number(p.horizon_days)>3650)return null;
 const cash=decimal(p.minimum_cash),weight=decimal(p.maximum_position_percent),turnover=decimal(p.maximum_turnover_percent);
 if(cash===null||weight===null||turnover===null||Number(weight)>100||Number(turnover)>100)return null;
 return{horizon:Number(p.horizon_days),cash,weight,turnover};
}
export function savedAllocations(row:Workflow,stage:FlowStage|undefined){
 const output=stockStageOutput(stage?.stage==='rebalance'?stage:undefined,row.inputs.source_hash,row.portfolio==='india'?'INR':'USD');
 const valid=output.rows.every(item=>Number(item.allocation)>=0&&Number(item.allocation)<=1);
 return{...output,state:valid?output.state:'unparseable',rows:valid?output.rows.map(item=>({instrument:item.instrument,proposed:displayProduct(item.allocation,'100'),why:typeof item.rationale==='string'&&item.rationale.trim()?String(safeResearchData(item.rationale)):'Not supplied'})):[]};
}

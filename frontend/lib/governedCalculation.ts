export type GovernedPortfolio='india'|'indmoney_us';
export const governedStages=['sync','threats','swing','rebalance','technical','actionables'] as const;
export type GovernedRow={id:string;instrument:string;action:'hold'|'buy'|'trim'|'sell';current_units:string;final_units:string;allocation:string;units_change:string;units_change_kind:'arithmetic_from_recorded_units'};
export type GovernedStage={stage:typeof governedStages[number];status:string;job_id:number|null;state:'available'|'not_completed'|'not_applicable';result_hash:string|null;response_hash:string|null;provider:string|null;model:string|null;prompt_version:string|null;rows:GovernedRow[]};
export type GovernedCatalogue={schema_version:1;source_kind:'governed_stage_jobs';owner_id:number;portfolio:GovernedPortfolio;limit:30;items:{id:number;workflow_version:number;status:string;module_version:number|null;recorded_at:string}[]};
export type GovernedEvidence={schema_version:1;source_kind:'governed_stage_jobs';owner_id:number;portfolio:GovernedPortfolio;workflow_id:number;workflow_version:number;workflow_status:string;module_version:number;source_hash:string;plan_hash:string;captured_at:string;currency:'INR'|'USD';simulation:true;historical:true;orders_authorized:false;current_readiness:'not_established';budget_verification:'not_assessed';integrity:'frozen_job_checkpoint_verified';missing_fields:string[];stages:GovernedStage[];evidence_hash:string};
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const id=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>0;
const version=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=0;
const bounded=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=128;
const decimal=(value:unknown):value is string=>bounded(value)&&/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value);
export function validGovernedCatalogue(value:unknown,owner:number,portfolio:GovernedPortfolio):value is GovernedCatalogue{
 const x=value as GovernedCatalogue;
 return !!x&&x.schema_version===1&&x.source_kind==='governed_stage_jobs'&&x.owner_id===owner&&x.portfolio===portfolio&&x.limit===30&&Array.isArray(x.items)&&x.items.length<=30&&new Set(x.items.map(row=>row?.id)).size===x.items.length&&x.items.every(row=>!!row&&id(row.id)&&version(row.workflow_version)&&bounded(row.status)&&(row.module_version===null||id(row.module_version))&&bounded(row.recorded_at));
}
export function validGovernedEvidence(value:unknown,owner:number,portfolio:GovernedPortfolio,workflow:number,expectedVersion:number):value is GovernedEvidence{
 const x=value as GovernedEvidence;
 if(!x||x.schema_version!==1||x.source_kind!=='governed_stage_jobs'||x.owner_id!==owner||x.portfolio!==portfolio||x.workflow_id!==workflow||x.workflow_version!==expectedVersion||!bounded(x.workflow_status)||!id(x.module_version)||x.simulation!==true||x.historical!==true||x.orders_authorized!==false||x.current_readiness!=='not_established'||x.budget_verification!=='not_assessed'||x.integrity!=='frozen_job_checkpoint_verified'||!hash(x.source_hash)||!hash(x.plan_hash)||!hash(x.evidence_hash)||!bounded(x.captured_at)||x.currency!==(portfolio==='india'?'INR':'USD')||!Array.isArray(x.missing_fields)||x.missing_fields.length!==9||!['confidence','rationale','scores','technical_setup','current_quotes','cash','fees','tax','legacy_formula_inputs'].every(field=>x.missing_fields.includes(field))||!Array.isArray(x.stages)||x.stages.length!==6)return false;
 const jobs=x.stages.filter(stage=>stage&&stage.job_id!==null).map(stage=>stage.job_id);
 if(new Set(jobs).size!==jobs.length)return false;
 return governedStages.every((name,index)=>{const stage=x.stages[index];return stage?.stage===name&&bounded(stage.status)&&(stage.job_id===null||id(stage.job_id))&&Array.isArray(stage.rows)&&stage.rows.length<=200&&(
  stage.state==='available'?stage.stage!=='sync'&&id(stage.job_id)&&hash(stage.result_hash)&&hash(stage.response_hash)&&stage.provider==='fake'&&bounded(stage.model)&&bounded(stage.prompt_version)&&new Set(stage.rows.map(row=>row?.instrument)).size===stage.rows.length&&stage.rows.every(row=>!!row&&row.id===stage.job_id+':'+row.instrument&&/^[A-Z]+:[A-Z0-9&_.-]{1,64}$/.test(row.instrument)&&(portfolio==='india'?['NSE','BSE']:['US','NYSE','NASDAQ','NYSEARCA','NYSEAMERICAN','AMEX']).includes(row.instrument.split(':')[0])&&['hold','buy','trim','sell'].includes(row.action)&&[row.current_units,row.final_units,row.allocation,row.units_change].every(decimal)&&row.units_change_kind==='arithmetic_from_recorded_units'):
  ['not_completed','not_applicable'].includes(stage.state)&&stage.rows.length===0);});
}

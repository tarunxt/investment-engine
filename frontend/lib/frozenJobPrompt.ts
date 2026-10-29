import type {JobResponse} from '@/types/api';
export type FrozenPromptBinding={job:number;research:number;stage:string;portfolio:'india'|'indmoney_us';provider:string;model:string;sourceHash:string;planHash:string;promptVersion:string;planVersion:string};
/** The owning Job GET enforces owner scope. This additionally checks the exact persisted analysis/plan binding. */
export function admitFrozenJobPrompt(value:unknown,expected:FrozenPromptBinding):string{
 if(!Number.isSafeInteger(expected.job)||expected.job<1||!Number.isSafeInteger(expected.research)||expected.research<1||!['threats','swing','rebalance','technical'].includes(expected.stage)||!['india','indmoney_us'].includes(expected.portfolio)||![expected.provider,expected.model,expected.promptVersion,expected.planVersion].every(item=>typeof item==='string'&&item.length>0)||!(/^[a-f0-9]{64}$/.test(expected.sourceHash))||!(/^[a-f0-9]{64}$/.test(expected.planHash)))throw Error('Complete frozen prompt binding required');
 const job=value as JobResponse,context=job?.request_context_json as Record<string,unknown>|undefined;
 if(!job||job.id!==expected.job||job.provider!==expected.provider||job.model!==expected.model||job.auto_rebalance_portfolio!==expected.portfolio||typeof job.prompt!=='string'||!context||context.kind!=='durable_analysis_v1'||context.workflow_id!==expected.research||context.stage!==expected.stage||context.source_hash!==expected.sourceHash||context.plan_hash!==expected.planHash||context.prompt_version!==expected.promptVersion||context.plan_version!==expected.planVersion||context.analysis_only!==true||context.orders_authorized!==false)throw Error('Exact frozen saved Job request required');
 return job.prompt;
}

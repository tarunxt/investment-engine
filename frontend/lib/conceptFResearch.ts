export const evidenceViews=['Summary','Inputs','Outputs','Model & LLM','Diagnostics','Stock flow','Duration','Prompt','Costs'] as const;
const secret=/(credential|password|secret|authorization|access.?token|refresh.?token|api.?key|cookie|private.?key)/i;
/** Owned saved structures are inert data, never executable markup or instructions. */
export function safeResearchData(value:unknown,depth=0):unknown{
 if(depth>12)return '[Nested data exceeds display bound]';
 if(Array.isArray(value))return value.slice(0,200).map(item=>safeResearchData(item,depth+1));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).slice(0,200).map(([key,item])=>[key,secret.test(key)?'[Restricted]':safeResearchData(item,depth+1)]));
 if(typeof value==='string')return /-----BEGIN .*PRIVATE KEY-----|\b(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{12,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}|\b(?:authorization|cookie|set-cookie|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|password|secret|private[ _-]?key|credentials?)["']?\s*[:=]\s*["']?\S+|https?:\/\/[^/\s]+@/i.test(value)?'[Restricted]':value.slice(0,16000);
 return typeof value==='number'&&!Number.isFinite(value)?null:value;
}
export function evidenceFields(value:unknown):[string,unknown][]{
 if(!value||typeof value!=='object'||Array.isArray(value))return value==null?[]:[['value',safeResearchData(value)]];
 return Object.entries(safeResearchData(value) as Record<string,unknown>);
}

export function researchSourceLink(raw:string):string|null{
 try{
  const url=new URL(raw);
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password)return null;
  for(const key of url.searchParams.keys())if(/token|secret|password|api.?key|signature|authorization/i.test(key))return null;
  return url.href;
 }catch{return null;}
}

export function recordedStageSeconds(start?:string|null,end?:string|null):number|null{
 const left=Date.parse(start??''),right=Date.parse(end??'');
 return Number.isFinite(left)&&Number.isFinite(right)&&right>=left?(right-left)/1000:null;
}
/** An explicitly requested missing stage must never fall back to another output. */
export function selectResearchStage<T extends {stage:string}>(stages:T[],requested:string|null):T|undefined{return requested===null?stages[0]:stages.find(stage=>stage.stage===requested);}
export function savedStageStatus(status:unknown):{label:string;tone:'queued'|'running'|'complete'|'attention'|'unknown'}{switch(status){case 'pending':return {label:'Not started',tone:'queued'};case 'queued':return {label:'Queued',tone:'queued'};case 'processing':return {label:'Running',tone:'running'};case 'completed':return {label:'Completed',tone:'complete'};case 'partial':return {label:'Partial',tone:'attention'};case 'failed':return {label:'Failed',tone:'attention'};case 'cancelled':return {label:'Cancelled',tone:'attention'};case 'paused':return {label:'Paused',tone:'attention'};case 'skipped':return {label:'Skipped',tone:'attention'};default:return {label:'Not recorded',tone:'unknown'};}}

/** The legacy "Cumulative LLM time" was an earliest-start/latest-end scan span,
 * not summed provider duration. Reconstruct only a complete recorded four-scan span. */
export function recordedScanSpan(stages:unknown):number|null {
 if(!Array.isArray(stages))return null;
 const expected=['threats','swing','rebalance','technical'];const rows=expected.map(key=>stages.filter(row=>row&&row.stage===key));
 if(rows.some(matches=>matches.length!==1))return null;
 const bounds=rows.map(([row])=>[row.started_at,row.completed_at].map(value=>typeof value==='string'&&/T/.test(value)&&/(Z|[+-]\d{2}:\d{2})$/.test(value)?Date.parse(value):NaN));
 if(bounds.some(([start,end])=>!Number.isFinite(start)||!Number.isFinite(end)||end<start))return null;
 return (Math.max(...bounds.map(row=>row[1]))-Math.min(...bounds.map(row=>row[0])))/1000;
}

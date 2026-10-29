import {stockStageOutput,type FlowStage} from './conceptFStockFlow';
import {savedTextPages} from './conceptFSavedText';
export type AssessmentRow={instrument:string;action:string;severity:string|null;review:string|null;sourceDate:string|null;references:string[]|null};
const text=(value:unknown,bound=256000)=>{if(typeof value!=='string'||new TextEncoder().encode(value).length>bound)return null;const checked=savedTextPages(value);return checked.state==='available'||checked.state==='empty'?value:checked.state==='restricted'?'[Restricted]':null;};
/** Display only saved claims. Never infer risk, holding membership, freshness or citations. */
export function stageAssessment(stage:FlowStage|undefined,sourceHash:string,currency:'INR'|'USD'){
 const output=stockStageOutput(stage,sourceHash,currency);
 const rows:AssessmentRow[]=output.rows.map(row=>({instrument:row.instrument,action:row.action,severity:typeof row.severity==='string'&&['critical','high','medium','low'].includes(row.severity.toLowerCase())?row.severity.toLowerCase():null,review:text(row.rationale),sourceDate:typeof row.source_date==='string'&&/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(row.source_date)&&Number.isFinite(Date.parse(row.source_date))?row.source_date:null,references:Array.isArray(row.sources)&&row.sources.length<=20&&row.sources.every(value=>text(value,16000)!==null)?row.sources.map(value=>text(value,16000)!):null}));
 return {state:output.state,receipt:output.hash,job:output.job,rows};
}
export function selectedAssessment(rows:AssessmentRow[],receipt:string|null,requested:string|null,pinned:string|null){return receipt&&pinned===receipt?rows.find(row=>row.instrument===requested)??null:null;}

import {researchStages} from './researchProgress';
import {stockStageOutput,type FlowStage,type FlowOutput} from './conceptFStockFlow';
export type StageSummary={key:string|null;label:string;purpose:string;status:string;attempts:number|null;outputState:FlowOutput['state'];proposals:number|null;job:number|null};
/** Forward only display metadata, never the saved checkpoint/body or financial fields. */
export function stageSummaryData(stage:(FlowStage&{attempts?:number})|undefined,sourceHash:string,currency:'INR'|'USD'):StageSummary{
 const definition=researchStages.find(([key])=>key===stage?.stage),output=stockStageOutput(stage,sourceHash,currency);
 return {key:definition?.[0]??null,label:definition?.[1]??'Saved stage unavailable',purpose:definition?.[2]??'This stage record is missing; no replacement result is selected.',status:stage&&['queued','processing','completed','partial','failed','cancelled','paused','skipped'].includes(stage.status)?stage.status:'Not recorded',attempts:typeof stage?.attempts==='number'&&Number.isSafeInteger(stage.attempts)&&stage.attempts>=0?stage.attempts:null,outputState:output.state,proposals:['parsed','empty','partial'].includes(output.state)?output.rows.length:null,job:output.job};
}

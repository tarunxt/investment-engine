import { URLs } from "./urls";
import type { apiService } from "@/services/api";
import type { ProviderModelTarget } from "@/types/api";
import type { CardKey, CardWeights } from "./independentScorecards";

export const libraryPath = "/console/zerodha/scorecards/library";
export const boardPath = "/console/zerodha#india-workflow";
export const boardChanged = "zerodha-scorecard-board-changed";
export const sourceLabels = {listings:"Listing identity and price", positions:"Holdings and position sizes", swing:"Stage 2 Swing evidence"};
export type SourceKey = keyof typeof sourceLabels;
export type Intro = {id:string; name:string; summary:string};
export type Method = Intro & {inputs:string; prompt:string; columns:string[]};
export type Definition = Method & {sources:SourceKey[]; target:ProviderModelTarget};
export type Board = {latest?:Record<string,{id:number;sequence:number;status:string}>; version:number; enabled:string[]; weights:Record<string,number>; custom:Definition[]; catalog:Intro[]};
export type Change = {version:number; add?:string; definition?:Definition; weights:Record<string,number>};
export function boardApi(client:Pick<typeof apiService,"get"|"post">) {
  const base = URLs.runs.list()+"/scorecards/india";
  return {
    read:()=>client.get<Board>(base+"/board"),
    save:(change:Change)=>client.post<Board>(base+"/board",change),
    method:(id:string)=>client.get<Method>(base+"/methodology/"+encodeURIComponent(id)),
    start:(revision:number,id:string,sequence:number,version:number)=>client.post<{id:number;run_id:number}>(base+"/revisions/"+revision+"/custom/"+id+"/start",{sequence, board_version:version}),
  };
}
export function boardWeights(board:Board):CardWeights {
  return {rebalance:0, technical:0, threats:0, pairwise:0, ...board.weights};
}
export const cardLabel = (board:Board, id:string) => [...board.catalog,...board.custom].find(d=>d.id===id)?.name ?? id;
export function initialPercentages(board:Board, addition?:string) {
  const exact = board.enabled.map(id=>({id, points: (board.weights[id] ?? 0)*100}));
  const values:Record<string,number> = Object.fromEntries(exact.map(({id,points})=>[id, Math.floor(points+1e-8)]));
  const remainder = 10000-Object.values(values).reduce((a,b)=>a+b,0);
  exact.sort((a,b)=>(b.points-values[b.id])-(a.points-values[a.id])).slice(0,Math.max(0,remainder)).forEach(({id})=>values[id]++);
  if (addition) values[addition]=0;
  return Object.fromEntries(Object.entries(values).map(([id,v])=>[id,String(v/100)]));
}
export type BoardRunChoices = Partial<Record<CardKey,number>> & Record<string,number|undefined>;

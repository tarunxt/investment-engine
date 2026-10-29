import type {IndMoneyUsPortfolioSnapshotSummary} from '@/types/api';

/** Preserve missing/invalid/unaccepted observations as gaps, and retain real zero. */
export function manualHistory(history:IndMoneyUsPortfolioSnapshotSummary[]){
 return [...history].sort((a,b)=>(Date.parse(a.captured_at)-Date.parse(b.captured_at)||a.id-b.id)).map(snapshot=>({...snapshot,value:snapshot.acceptance_state==='accepted'&&snapshot.parser_current===true&&snapshot.import_provenance?.currency==='USD'&&Number.isFinite(Date.parse(snapshot.captured_at))&&snapshot.current_value!=null&&Number.isFinite(snapshot.current_value)?snapshot.current_value:null}));
}
export function historySegments<T extends {value:number|null;captured_at?:string;id?:number;supersedes_id?:number|null}>(points:T[]):T[][]{
 const segments:T[][]=[];let run:T[]=[],previous:number|null=null;const replaced=new Set(points.flatMap(point=>typeof point.supersedes_id==='number'&&Number.isSafeInteger(point.supersedes_id)&&point.supersedes_id>0?[point.supersedes_id]:[]));
 for(const point of points){
  if(point.value===null){if(run.length)segments.push(run);run=[];previous=null;continue;}
  const parsed=typeof point.captured_at==='string'?Date.parse(point.captured_at):NaN,time=Number.isFinite(parsed)?parsed:null;
  // Superseded versions are retained as observations, never performance steps.
  if(typeof point.id==='number'&&replaced.has(point.id)){if(run.length)segments.push(run);segments.push([point]);run=[];previous=null;continue;}
  if((typeof point.supersedes_id==='number'||time!==null&&previous!==null&&time<=previous)&&run.length){segments.push(run);run=[];}
  run.push(point);previous=time;
 }
 if(run.length)segments.push(run);return segments;
}

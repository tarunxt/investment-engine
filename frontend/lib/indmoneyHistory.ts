import type {IndMoneyUsPortfolioSnapshotSummary} from '@/types/api';

/** Preserve missing/invalid/unaccepted observations as gaps, and retain real zero. */
export function manualHistory(history:IndMoneyUsPortfolioSnapshotSummary[]){
 return [...history].sort((a,b)=>a.captured_at.localeCompare(b.captured_at)||a.id-b.id).map(snapshot=>({...snapshot,value:snapshot.acceptance_state==='accepted'&&snapshot.parser_current===true&&snapshot.import_provenance?.currency==='USD'&&snapshot.current_value!=null&&Number.isFinite(snapshot.current_value)?snapshot.current_value:null}));
}
export function historySegments<T extends {value:number|null}>(points:T[]):T[][]{
 const segments:T[][]=[];let run:T[]=[];
 for(const point of points){if(point.value===null){if(run.length)segments.push(run);run=[];}else run.push(point);}
 if(run.length)segments.push(run);return segments;
}

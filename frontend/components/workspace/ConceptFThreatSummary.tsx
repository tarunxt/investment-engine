'use client';
import {useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {apiService} from '@/services/api';
import {admitThreatSource,type ThreatMeta,type ThreatSource} from '@/lib/conceptFSavedThreats';
import {savedSeveritySummary} from '@/lib/conceptFThreatSummary';
import {recordedCostTimestamp} from '@/lib/conceptFCostReceipts';

export function ConceptFThreatSummary({owner,portfolio,items,scopeKey}:{owner:number;portfolio:'india'|'indmoney_us';items:ThreatMeta[];scopeKey:string}){
 const [selected,setSelected]=useState(''),[record,setRecord]=useState<{key:string;source:ThreatSource}|null>(null),[pending,setPending]=useState<string|null>(null),[error,setError]=useState<string|null>(null);
 const controller=useRef<AbortController|null>(null),epoch=useRef(0),busy=useRef(false),active=useRef(true);
 const key=scopeKey+':'+owner+':'+portfolio+':'+selected;
 useEffect(()=>{active.current=true;return()=>{active.current=false;controller.current?.abort();busy.current=false;};},[owner,portfolio,scopeKey]);
 function cancel(){epoch.current++;controller.current?.abort();busy.current=false;setPending(null);}
 function choose(value:string){cancel();setRecord(null);setError(null);setSelected(items.some(row=>String(row.job_id)===value)?value:'');}
 async function read(){
  if(busy.current||!items.some(row=>String(row.job_id)===selected))return;
  const ticket=++epoch.current,abort=new AbortController();controller.current?.abort();controller.current=abort;busy.current=true;setPending(key);setError(null);setRecord(null);
  try{const value=await apiService.fetch('/backend-api/uat2/simulation/threat-history/'+portfolio+'/'+selected,{signal:abort.signal,cache:'no-store',timeoutMs:8000});const source=admitThreatSource(value,owner,portfolio,Number(selected),null);if(active.current&&!abort.signal.aborted&&ticket===epoch.current)setRecord({key,source});}
  catch{if(active.current&&!abort.signal.aborted&&ticket===epoch.current)setError(key);}
  finally{if(active.current&&ticket===epoch.current){busy.current=false;setPending(null);}}
 }
 const source=record?.key===key&&items.some(row=>row.job_id===record.source.job_id)?record.source:null,counts=source?savedSeveritySummary(source):null,root=portfolio==='india'?'/console/zerodha':'/console/indmoney-us';
 return <details className="mt-3" onToggle={event=>{if(!event.currentTarget.open)cancel();}} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();event.currentTarget.open=false;cancel();event.currentTarget.querySelector<HTMLElement>('summary')?.focus();}}}>
  <summary className="concept-f-text-link min-h-11 cursor-pointer">Inspect saved severity summary</summary>
  <div className="space-y-3 pt-3" role="region" aria-label={'Saved severity summary '+(portfolio==='india'?'India':'US')}>
   <p className="text-sm">Choose a saved report explicitly. Reading it never selects a latest report automatically, starts a scan or verifies current portfolio risk.</p>
   <label className="block text-sm">Saved report<select aria-label={'Saved threat report for '+(portfolio==='india'?'India':'US')} className="mt-2 min-h-11 w-full rounded border bg-background p-2" value={selected} onChange={event=>choose(event.target.value)}><option value="">Choose a report</option>{items.map(row=><option key={row.job_id} value={row.job_id}>Report {row.job_id} · {row.status} · {row.provider}/{row.model}</option>)}</select></label>
   <button type="button" className="concept-f-secondary" disabled={!selected||pending===key} onClick={()=>void read()}>Read saved severity summary</button>
   {pending===key&&<p role="status">Reading the exact owned saved report…</p>}
   {error===key&&<p role="alert">Saved severity source could not be verified. No zero-risk or current-risk result is inferred.</p>}
   {source&&<div className="space-y-3 break-words">
    {counts?<><h3 className="font-semibold">{counts.total} saved severity labels · report {source.job_id}</h3><p>Very high {counts.veryHigh} · high {counts.high} · medium {counts.medium} · low {counts.low}</p><p className="text-sm">These count severity-labelled cells using the original report rule. Repeated labels are not distinct risks, current flags or verified holdings relationships.</p></>:<p role="status">No quantified severity summary is established for this saved report. Inspect its exact source for completion and parsing state. This is not a zero-risk conclusion.</p>}
    <p className="text-xs">Captured source time: {source.source_metadata_verified&&recordedCostTimestamp(source.captured_at)?source.captured_at:'Unverified'}. Historical model output; no current-risk authority.</p>
    <Link prefetch={false} className="concept-f-text-link inline-flex min-h-11 items-center" href={root+'/research/threat-history?'+new URLSearchParams({riskJob:String(source.job_id),riskVersion:source.source_version,riskView:'Summary'})}>Open exact saved report</Link>
    <p className="break-all text-xs">Saved report version: {source.source_version}</p>
   </div>}
  </div>
 </details>;
}

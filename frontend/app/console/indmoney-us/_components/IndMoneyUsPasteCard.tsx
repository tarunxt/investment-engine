'use client';

import {useState,useRef,useEffect} from 'react';
import {useSession} from 'next-auth/react';
import {useAuth} from '@/hooks/useAuth';
import {apiService} from '@/services/api';
import {Button} from '@/components/ui/button';
import type {IndMoneyUsPortfolioSnapshotCreateRequest,IndMoneyUsPortfolioSnapshotDetail} from '@/types/api';

const CSV_TEMPLATE='symbol,company_name,currency,quantity,market_price,invested_value,current_value,total_pnl,total_pnl_percent\nUATA,Synthetic Alpha,USD,2,55,100,110,10,10\n';
function localTime(){const d=new Date();return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);}

export function IndMoneyUsPasteCard({saving,error,onSubmit,initiallyOpen=false,financialMasked=false}:{saving:boolean;error:string|null;onSubmit:(data:IndMoneyUsPortfolioSnapshotCreateRequest)=>Promise<void>;initiallyOpen?:boolean;financialMasked?:boolean}){
 const {user}=useAuth();const {data:session,status}=useSession();
 const owner=status==='authenticated'?user?.id:undefined;
 // A keyed lifetime removes prior-owner text/previews before effects run.
 return owner===undefined?<p>Sign in to review a manual import.</p>:<OwnedImport key={`${owner}:${session?.generation}`} saving={saving} error={error} onSubmit={onSubmit} initiallyOpen={initiallyOpen} financialMasked={financialMasked}/>;
}

export function OwnedImport({saving,error,onSubmit,initiallyOpen=false,financialMasked=false}:{saving:boolean;error:string|null;onSubmit:(data:IndMoneyUsPortfolioSnapshotCreateRequest)=>Promise<void>;initiallyOpen?:boolean;financialMasked?:boolean}){
 const amount=(value:number|null|undefined)=>value==null?'Missing':financialMasked?'Masked':value;
 const [open,setOpen]=useState(initiallyOpen),[raw,setRaw]=useState(''),[captured,setCaptured]=useState(localTime),[format,setFormat]=useState<'paste'|'csv'>('paste'),[period,setPeriod]=useState(false),[correction,setCorrection]=useState('');
 const [preview,setPreview]=useState<IndMoneyUsPortfolioSnapshotDetail|null>(null),[pending,setPending]=useState(false),[fault,setFault]=useState<string|null>(null),[saved,setSaved]=useState(false);
 const epoch=useRef(0);const alive=useRef(true);const accepting=useRef(false);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;epoch.current++;};},[]);
 function invalidate(){epoch.current++;setPreview(null);setFault(null);setSaved(false);setPending(false);}
 async function upload(event:React.ChangeEvent<HTMLInputElement>){
  const file=event.target.files?.[0];if(!file)return;invalidate();const ticket=epoch.current;
  if(file.size>200000){setFault('CSV exceeds the 200 KB source bound. No preview or acceptance was requested.');return;}
  try{const value=await file.text();if(alive.current&&epoch.current===ticket){setFormat('csv');setRaw(value);}}catch{if(alive.current&&epoch.current===ticket)setFault('The local CSV could not be read. No import was requested.');}
 }
 function payload():IndMoneyUsPortfolioSnapshotCreateRequest{return{raw_text:raw,captured_at:new Date(captured).toISOString(),format,currency:'USD',day_return_period:period?'1d_same_asof':'unknown',supersedes_id:correction?Number(correction):null};}
 async function review(event:React.FormEvent){event.preventDefault();const ticket=++epoch.current;setPending(true);setPreview(null);setFault(null);setSaved(false);
  try{const value=await apiService.indmoneyUsPreviewImport(payload());if(alive.current&&epoch.current===ticket)setPreview(value);}catch(e){if(alive.current&&epoch.current===ticket)setFault(e instanceof Error?e.message:'Preview unavailable');}finally{if(alive.current&&epoch.current===ticket)setPending(false);}}
 async function accept(){if(saving||accepting.current||!preview?.content_hash||preview.parser_current!==true||preview.acceptance_state!=='preview')return;const ticket=epoch.current;accepting.current=true;
  try{await onSubmit({...payload(),accepted_preview_id:preview.id,acceptance_hash:preview.content_hash});if(alive.current&&epoch.current===ticket){setPreview(null);setRaw('');setSaved(true);}}catch{/* Parent surfaces save errors. */}finally{accepting.current=false;}}
 return <section className="space-y-4 rounded-xl border border-blue-200 bg-blue-50 p-5 min-w-0">
  <button type="button" className="text-left font-semibold" aria-expanded={open} onClick={()=>setOpen(!open)}>Manual INDmoney import · Preview and accept</button>
  <p className="text-sm">Manual import and analysis only. No direct US trading integration. Nothing feeds recommendations until you accept a validated preview.</p>
  {open&&<form onSubmit={review} className="space-y-4">
   <div className="flex flex-wrap gap-4">
    <label>Source format <select aria-label="Source format" value={format} onChange={e=>{invalidate();setFormat(e.target.value as 'paste'|'csv');}}><option value="paste">Pasted holdings screen</option><option value="csv">CSV template v2</option></select></label>
    <label>As-of time <input aria-label="As-of time" type="datetime-local" required value={captured} onChange={e=>{invalidate();setCaptured(e.target.value);}}/></label>
    <label>Currency <input aria-label="Currency" value="USD" readOnly className="w-16"/></label>
    <label>Corrects snapshot ID (optional) <input aria-label="Corrects snapshot ID" type="number" min="1" value={correction} onChange={e=>{invalidate();setCorrection(e.target.value);}} className="w-24"/></label>
   </div>
   <a className="underline" href={`data:text/csv;charset=utf-8,${encodeURIComponent(CSV_TEMPLATE)}`} download="indmoney-us-v2.csv">Download stable CSV template</a>
   <label className="block">Upload CSV<input type="file" accept=".csv,text/csv,text/plain" disabled={saving||pending} onChange={event=>void upload(event)} className="mt-2 block max-w-full text-sm"/></label>
   <label className="block">Holdings source <textarea aria-label="Holdings source" value={raw} required maxLength={200000} rows={9} className="mt-2 w-full rounded border p-3 font-mono text-sm" onChange={e=>{invalidate();setRaw(e.target.value);}}/></label>
   <label className="flex gap-2"><input type="checkbox" checked={period} onChange={e=>{invalidate();setPeriod(e.target.checked);}}/>Daily dollars and percentage both describe the same one-day period ending at this as-of time.</label>
   <Button type="submit" disabled={pending||saving||!raw.trim()||!captured}>{pending?'Parsing preview…':'Preview import'}</Button>
  </form>}
  {(fault||error)&&<p role="alert">{fault||error}</p>}
  {saved&&<p role="status">Validated snapshot accepted. Prior versions remain in history.</p>}
  {preview&&<section aria-label="Import preview" className="space-y-3 rounded border bg-white p-4 break-words">
   <h3 className="font-semibold">{preview.acceptance_state==='quarantined'?'Quarantined — correction required':preview.acceptance_state==='accepted'?'Already accepted — duplicate import':'Review before acceptance'}</h3>
   <p>{preview.holdings_count} holdings · {preview.import_provenance?.currency} · As of {preview.captured_at} · {preview.freshness}</p>
   <p className="text-xs">Parser {preview.import_provenance?.parser_version} · Source SHA256 {preview.import_provenance?.source_hash}</p>
   {preview.parser_current!==true&&<p role="alert">Earlier parser preview: create a new preview before acceptance.</p>}
   <p>FX: no conversion; USD source only. Missing values remain missing.</p>{financialMasked&&<p>Preview amounts are masked. Reveal investment numbers deliberately in Profile to inspect them; the pasted source remains your explicit input.</p>}
   {(preview.import_provenance?.errors??[]).map((x,i)=><p role="alert" key={`e${i}`}>{x}</p>)}
   {(preview.import_provenance?.warnings??[]).map((x,i)=><p key={`w${i}`}>{x}</p>)}
   <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th>Symbol / name</th><th>Quantity</th><th>Invested USD</th><th>Current USD</th><th>Quote USD</th></tr></thead><tbody>{preview.holdings.map((h,i)=><tr key={`${h.symbol}-${i}`}><td>{h.symbol} / {h.company_name}</td><td>{h.quantity??'Missing'}</td><td>{amount(h.invested_value)}</td><td>{amount(h.current_value)}</td><td>{amount(h.market_price)}</td></tr>)}</tbody></table></div>
   <p className="text-xs">Snapshot reference {preview.id} · Content {preview.content_hash}</p>
   <div className="flex flex-wrap gap-3"><Button type="button" variant="outline" disabled={saving} onClick={invalidate}>Back to input</Button><Button type="button" onClick={accept} disabled={saving||pending||preview.parser_current!==true||preview.acceptance_state!=='preview'}>{saving?'Accepting…':'Accept this exact snapshot'}</Button></div>
  </section>}
 </section>;
}

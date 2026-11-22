"use client";

import { useEffect, useRef, useState } from "react";
import type { CardResult, CardRow } from "@/lib/independentScorecards";

type Factor = {weight:number; value:number|null; points:number|null; reason:string|null; inputs:Record<string,number>};
type Source = {instrument?:string; history_hash?:string; tick?:number; master?:string; calendar?:string; action_url?:string;
  actions?: {date:string; kind:string; multiplier:number|null}[]; last_bar?:{as_of:string; url:string; received_at?:string; published_at?:string}};
type Ledger = {version:number; direction:string; coverage_pct:number; range:[number,number]|null; as_of:string; session:string|null;
  input_hash:string; vintage:string; flags:string[]; reason:string; readiness:Record<string,string|number|null>;
  factors:Record<string,Factor>; sources:{stock:Source; benchmark:Source}};
const fmt = (n:unknown, digits=1) => typeof n==="number" && Number.isFinite(n) ? n.toFixed(digits) : "—";
const at = (s?:string) => s ? new Intl.DateTimeFormat("en-IN",{dateStyle:"medium",timeStyle:"short",timeZone:"Asia/Kolkata"}).format(new Date(s))+" IST" : "—";
function lines(row:CardRow) {return row.technical_v3 as Ledger|undefined;}
const cell="border-b border-slate-200 px-3 py-2 align-top";
const link="font-semibold text-indigo-800 underline underline-offset-2";

function Evidence({name,source}:{name:string;source:Source}) {
  const last=source.last_bar;
  return <details className="rounded-lg border p-3"><summary className="cursor-pointer font-semibold">{name} evidence · {source.instrument??"Unknown instrument"}</summary>
    <p>Last candle {at(last?.as_of)} · received {at(last?.received_at)} · published {at(last?.published_at)}</p>
    <div className="flex flex-wrap gap-3">{([["Candle",last?.url],["Calendar",source.calendar],["Corporate actions",source.action_url],["Instrument master",source.master]] as const).map(([label,url])=>
      url?.startsWith("https://")&&<a className={link} key={label} href={url} target="_blank" rel="noreferrer">{label}</a>)}</div>
    {source.actions?.map(a=><p key={a.date+a.kind}>{a.date} · {a.kind} · share multiplier {a.multiplier??"unresolved"}</p>)}
    <p className="break-all text-xs">History hash {source.history_hash??"—"}</p></details>;
}

export function TechnicalStockScores({result,revision,onRecover,onRetryCommentary}:{result:CardResult;revision?:number;
  onRecover?:()=>Promise<CardResult>;onRetryCommentary?:()=>Promise<void>}) {
  const [selection,setSelection]=useState<CardRow|null>(null);
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{if(selection&&!dialog.current?.open) dialog.current?.showModal();},[selection]);
  const [recovered,setRecovered]=useState<{from:number;data:CardResult}|null>(null);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");
  const current=recovered?.from===result.id?recovered.data:result;
  const counts=current.technical_counts;
  const data=selection&&lines(selection);
  const rank={Complete:0,Provisional:1};
  const ordered=counts?[...current.rows].sort((a,b)=>(rank[a.coverage as keyof typeof rank]??2)-(rank[b.coverage as keyof typeof rank]??2)
    || (b.score??-1)-(a.score??-1)):current.rows;
  const unfilled=current.rows.filter(r=>r.score==null).length;
  return <div className="space-y-3 py-2 text-sm">
    <p className="font-semibold">{counts?`${counts.expected} expected · ${counts.complete} complete · ${counts.provisional} provisional · ${counts.insufficient} insufficient · ${counts.commentary} model rows`:
      `${current.rows.length} expected · ${current.rows.length-unfilled} saved scores · ${unfilled} without a score`}</p>
    {counts&&<p>20-session direction · Stage 2 #{revision??current.revision_id} · Output #{current.id} · {current.stage4_method==="v3"?"Validated for Stage 4":"Shadow evaluation · Stage 4 uses the legacy score"}</p>}
    <div className="overflow-x-auto"><table className="w-full text-left"><thead className="bg-slate-100"><tr>
      {["Listing","Score /100","Coverage","Setup / entry","Reason"].map(k=><th key={k} className={cell}>{k}</th>)}</tr></thead>
      <tbody>{ordered.map(r=>{const v=lines(r);const ready=r.readiness as {setup?:string;entry?:string}|undefined;
        return <tr key={r.listing}><th scope="row" className={cell}>{r.listing}</th><td className={cell}><button type="button" className={link}
          aria-label={`Show calculation for ${r.listing}`} onClick={()=>setSelection(r)}>{fmt(r.score)} ↗</button></td>
          <td className={cell}>{r.coverage}{v&&` · ${v.coverage_pct}%`}</td><td className={cell}>{ready?.setup??"—"} · {ready?.entry??"—"}</td>
          <td className={cell}>{v?.reason||String(r.reason??v?.direction??"—")}</td></tr>;})}</tbody></table></div>
    {onRecover&&(!counts||counts.provisional+counts.insufficient>0)&&<button className={link} disabled={busy} onClick={async()=>{
      setBusy(true);try{const next=await onRecover();setRecovered({from:result.id,data:next});setMessage(next.id===current.id?"No new verified evidence available.":`Showing recovered output #${next.id}.`);}catch(e){setMessage(String(e));}finally{setBusy(false);}
    }}>{busy?"Checking history…":"Recover missing evidence · no model call"}</button>}
    {onRetryCommentary&&counts&&counts.commentary<counts.expected&&<button className={link} disabled={busy} onClick={async()=>{
      setBusy(true);try{await onRetryCommentary();setMessage("Commentary retry queued.");}catch(e){setMessage(String(e));}finally{setBusy(false);}
    }}>Retry missing model commentary</button>}
    {message&&<p role="status">{message}</p>}
    {selection&&<dialog ref={dialog} onClose={()=>setSelection(null)} aria-label={"Technical calculation for "+selection.listing}
      className="fixed inset-0 m-auto max-h-[85vh] w-[min(90vw,58rem)] resize overflow-auto rounded-2xl border border-slate-200 bg-white p-5 text-slate-900 shadow-xl backdrop:bg-black/40">
      <div className="sticky top-0 flex items-center justify-between bg-white py-2"><h3 className="font-semibold">{selection.listing} · {fmt(selection.score)} /100</h3>
      <button type="button" className={link} onClick={()=>dialog.current?.close()}>Close calculation</button></div>
      <div className="space-y-3 p-3 text-sm"><p>Output #{current.id} · Stage 2 #{current.revision_id??revision} · {selection.coverage}</p>
      {data?<><p>{data.direction} · Cutoff {at(data.as_of)} · Decision session {data.session??"—"} · {data.vintage}</p>
        <div className="overflow-x-auto"><table className="w-full text-left"><thead><tr>{["Factor","Score /100","Weight","Points from 50","Inputs"].map(k=><th key={k} className={cell}>{k}</th>)}</tr></thead>
        <tbody>{Object.entries(data.factors).map(([name,f])=><tr key={name}><th className={cell}>{name}</th><td className={cell}>{fmt(f.value)}</td><td className={cell}>{fmt(100*f.weight,0)}%</td>
          <td className={cell}>{fmt(f.points,2)}</td><td className={cell}>{f.reason||Object.entries(f.inputs).map(([k,v])=>k.replaceAll("_"," ")+" = "+Number(v.toPrecision(6))).join(" · ")}</td></tr>)}</tbody></table></div>
        {selection.score!=null&&<p className="rounded-lg bg-sky-50 p-3 font-mono">50 {Object.values(data.factors).filter(f=>f.points!=null).map(f=>(f.points!<0?"− ":"+ ")+fmt(Math.abs(f.points!),3)).join(" ")} ≈ {fmt(selection.score)} /100</p>}
        <p>Factor coverage {data.coverage_pct}% · possible full score {data.range?.map(x=>fmt(x)).join("–")??"—"}</p>
        <p>{Object.entries(data.readiness).filter(([,v])=>v!=null).map(([k,v])=>k+" "+v).join(" · ")}</p>
        {data.reason&&<p>{data.reason}</p>}{data.flags.length>0&&<p>{data.flags.join(" · ")}</p>}
        <p>Legacy comparison {fmt(selection.legacy_score)} /100 · model annotation {selection.commentary_job?"job #"+selection.commentary_job:"unavailable"}{selection.model_disagreement?" · model value disagreed with the backend":""}</p>
        <Evidence name="Stock" source={data.sources.stock}/><Evidence name="Benchmark" source={data.sources.benchmark}/>
        <p className="break-all text-xs">Calculation input hash {data.input_hash}</p></>:
        <><p>Score = (mean accepted last-five-candle trend + 3) × 100 ÷ 6.</p><p>Mean trend {fmt((selection.signed_terms as {candles?:number}|undefined)?.candles,2)} · saved score {fmt(selection.score)}. Catalogue ratings have zero weight in this saved score.</p>
        {selection.reason!=null&&<p>{String(selection.reason)}</p>}</>}
      </div></dialog>}
  </div>;
}

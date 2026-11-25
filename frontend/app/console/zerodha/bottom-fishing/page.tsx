"use client";
import Link from "next/link";
import {useEffect,useMemo,useState,useSyncExternalStore} from "react";
import {useAuth} from "@/hooks/useAuth";
import {apiService} from "@/services/api";
import {URLs} from "@/lib/urls";
import {workflowOwnedApi} from "@/lib/workflowOwnedApi";
import {captureWorkflowOwner,onWorkflowOwnerInvalidated,type WorkflowOwner} from "@/lib/workflowOwnerLifetime";

type Settings = {inputs:string[];capital:number;weights:Record<string,number>};
type Row = {symbol:string;sources:string[];discovered?:string;score?:number;price?:number;breakout?:number;max_buy?:number;stop?:number;target?:number;rr?:number;qty?:number;reason:string;points?:Record<string,number>};
type Position = {qty:number;entry:string;price:number;stop:number;target:number};
type Scan = {at:string;universe:number;covered:number;patterns:number;current_candles:number};
type Snapshot = {version:number;settings:Settings;state:{sync?:{at:string};at?:string;error?:string;status?:string;scans?:Scan[];rows?:Row[];
  setups?:Record<string,{discovered:string;discovery:number;low:number;high:number;invalid?:boolean}>;
  positions?:Record<string,Position>;closed?:{symbol:string;qty:number;reason:string;pnl:number;end:string}[];realized?:number}};
const path=URLs.runs.list()+"/scorecards/india/bottom-fishing";
const labels:Record<string,string>={bounce:"Support bounce",proximity:"Floor proximity",strength:"Relative strength",recovery:"Recovery",roce:"ROCE",sales:"Sales growth",profit:"Profit growth",leverage:"Debt / equity"};
const num=(x?:number)=>x==null?"—":x.toLocaleString("en-IN",{maximumFractionDigits:2});
const date=(x?:string)=>x?new Date(x).toLocaleString("en-IN",{timeZone:"Asia/Kolkata",hour12:false}):"—";
const panel="space-y-3 rounded-xl border border-slate-200 bg-white p-4";
export default function Page(){
  const {user}=useAuth();
  const owner=useSyncExternalStore(onWorkflowOwnerInvalidated,captureWorkflowOwner,()=>null);
  return owner&&user?.id===owner.id?<Board key={owner.generation} owner={owner}/>:<p>Loading account…</p>;
}
function Board({owner}:{owner:WorkflowOwner}){
  const client=useMemo(()=>workflowOwnedApi(apiService,owner),[owner]);
  const [data,setData]=useState<Snapshot|null>(null);
  const [draft,setDraft]=useState<Settings|null>(null);
  const [version,setVersion]=useState(0);
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  useEffect(()=>{let active=true;async function read(){try{const result=await client.get<Snapshot>(path);
    if(active){setData(result);setError("");}}catch(e){if(active)setError(String(e));}}
    void read();const id=setInterval(read,30000);return()=>{active=false;clearInterval(id);};},[client]);
  async function save(){if(!draft)return;setBusy(true);try{setData(await client.post<Snapshot>(path+"/inputs",{...draft,version}));setDraft(null);setError("");}
    catch(e){setError(String(e));}finally{setBusy(false);}}
  const s=data?.state;
  return <main className="mx-auto max-w-6xl space-y-5 p-5 text-slate-900">
    <Link className="text-indigo-700 underline" href="/console/zerodha#india-workflow">Zerodha workflow</Link>
    <h1 className="text-3xl font-semibold">Bottom Fishing</h1>
    <p>Paper portfolio · NSE equities · All times IST</p>
    {error&&<p role="alert" className="text-red-700">{error}</p>}
    {!data?<p>Loading strategy…</p>:<>
    <section className={panel} id="sync"><h2 className="text-lg font-semibold">Stage 1 · Market data and capital</h2><p>Assigned paper capital ₹{num(data.settings.capital)} · 20 completed NSE sessions · Last sync {date(s?.sync?.at)}</p></section>
    <section className={panel} id="screen"><h2 className="text-lg font-semibold">Stage 2 · Bottom Fishing Screen</h2>
      <p>09:30 and 13:15 · Nifty 500 · Prior 20 trading sessions</p>
      {s?.scans?.length?s.scans.map(v=><p key={v.at}>{date(v.at)} · {v.covered}/{v.universe} histories · {v.current_candles}/{v.patterns} support patterns with current candles</p>):<p>Awaiting a completed screen.</p>}
      {Object.entries(s?.setups??{}).map(([k,v])=><p key={k}>{k} · ₹{num(v.discovery)} at {date(v.discovered)} · Range ₹{num(v.low)}–{num(v.high)}{v.invalid?" · Support broken":""}</p>)}
    </section>
    <section className={panel} id="score"><h2 className="text-lg font-semibold">Stage 3 · Bottom Fishing Scorecard</h2>
      <p>Every five minutes · Last scored {date(s?.at)} · {s?.status??"Awaiting first cycle"}</p>
      {s?.error&&<p role="alert">{s.error}</p>}
      <button className="rounded border px-3 py-2" onClick={()=>{setDraft(structuredClone(data.settings));setVersion(data.version);}}>Inputs and weights</button>
      {draft&&<form className="grid gap-3" onSubmit={e=>{e.preventDefault();void save();}}>
        <fieldset><legend>Stage 2 inputs</legend>{[["bottom","Bottom Fishing Screen"]].map(([id,label])=><label className="mr-4" key={id}><input type="checkbox" checked={draft.inputs.includes(id)} onChange={e=>setDraft({...draft,inputs:e.target.checked?[...draft.inputs,id]:draft.inputs.filter(i=>i!==id)})}/> {label}</label>)}</fieldset>
        <label>Assigned paper capital ₹ <input className="border p-1" required type="number" min="1" value={draft.capital} onChange={e=>setDraft({...draft,capital:Number(e.target.value)})}/></label>
        <fieldset className="grid gap-2 sm:grid-cols-4"><legend>Factor weights · total 100</legend>{Object.entries(draft.weights).map(([k,v])=><label key={k}>{labels[k]} <input className="w-16 border p-1" type="number" min="0" max="100" required value={v} onChange={e=>setDraft({...draft,weights:{...draft.weights,[k]:Number(e.target.value)}})}/></label>)}</fieldset>
        <div><button disabled={busy} className="rounded bg-indigo-700 px-3 py-2 text-white">Save</button> <button type="button" onClick={()=>setDraft(null)}>Cancel</button></div>
      </form>}
      <p>Selected inputs · {data.settings.inputs.map(()=>"Bottom Fishing Screen").join(", ")||"None · fresh entries paused"}</p>
      {!!s?.rows?.length&&<div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{["Stock / sources","Score","Price ₹","Breakout","Max buy","Stop","Target","Net R/R","Qty","Decision"].map(h=><th className="p-2" key={h}>{h}</th>)}</tr></thead><tbody>{s.rows.map(r=><tr className="border-t" key={r.symbol}><th className="p-2">{r.symbol}<small className="block">{r.sources.join(", ")}</small></th><td><details><summary>{num(r.score)}</summary>{Object.entries(r.points??{}).map(([k,v])=><p key={k}>{labels[k]} {num(v)}</p>)}</details></td>{[r.price,r.breakout,r.max_buy,r.stop,r.target,r.rr,r.qty].map((v,i)=><td className="p-2" key={i}>{num(v)}</td>)}<td>{r.reason}</td></tr>)}</tbody></table></div>}
    </section>
    <section className={panel} id="actionables"><h2 className="text-lg font-semibold">Stage 4 · Final Actionables</h2><p>Assigned ₹{num(data.settings.capital)} · Realised P&amp;L ₹{num(s?.realized??0)}</p>
      <h3 className="font-semibold">Entry decisions</h3>
      {s?.rows?.filter(r=>r.qty).length?s.rows.filter(r=>r.qty).map(r=><p key={r.symbol}>{r.symbol} · {r.reason} · {r.qty} shares · Limit ₹{num(r.price)} · Stop ₹{num(r.stop)} · Target ₹{num(r.target)}</p>):<p>No qualifying entry in the latest cycle.</p>}
      <h3 className="font-semibold">Paper portfolio</h3>
      {Object.entries(s?.positions??{}).map(([k,p])=><p key={k}>{k} · {p.qty} at ₹{num(p.price)} · Stop ₹{num(p.stop)} · Target ₹{num(p.target)} · {date(p.entry)}</p>)}
      {!Object.keys(s?.positions??{}).length&&<p>No open paper positions.</p>}
      {s?.closed?.slice().reverse().map(p=><p key={p.symbol+p.end}>{p.symbol} · {p.qty} shares · {p.reason} · ₹{num(p.pnl)} · {date(p.end)}</p>)}
    </section></>}
  </main>;
}

"use client";
import {useState} from "react";
import {labels, type Stage, type Snapshot} from "./model";
import type {Model} from "./useBottomFishing";

export function Inputs({stage,weights=false,data,save}:{stage:Stage;weights?:boolean;data:Snapshot;save:Model["save"]}) {
  const [draft,setDraft]=useState(()=>structuredClone(data.settings));
  const [version,setVersion]=useState(data.version);
  const [message,setMessage]=useState("");
  const [busy,setBusy]=useState(false);
  const total=Object.values(draft.weights).reduce((a,b)=>a+b,0);
  if(stage==="screen") return <p>Nifty 500 NSE equities · 20 prior sessions · Median daily turnover ≥ ₹1 crore · Two support touches at least five sessions apart · Discovery within the bottom 15% of the range.</p>;
  if(stage==="actionables") return <p>Bottom Fishing Scorecard · Minimum score 70/100 · Fresh breakout and net reward/risk ≥ 2 · Up to ₹10,000 per stock, 0.5% capital risk per entry and 1.5% total planned risk.</p>;
  return <form className="space-y-4" onSubmit={async e=>{
    e.preventDefault();if (busy || total!==100 || version!==data.version) return;setBusy(true);setMessage("");
    try {setVersion(await save(draft,version));setMessage("Settings saved.");} catch(err){setMessage(String(err));} finally {setBusy(false);}
  }}>
    {stage==="sync" ? <label>Assigned paper capital ₹ <input required type="number" min={1} max={100000000} className="rounded border p-2" value={draft.capital} onChange={e=>setDraft({...draft,capital:Number(e.target.value)})}/></label>
    : weights ? <fieldset className="grid gap-3 sm:grid-cols-2"><legend className="mb-3 font-semibold">Factor weights · {total} / 100</legend>{Object.entries(draft.weights).map(([k,v])=><label className="flex justify-between gap-3" key={k}>{labels[k]} <input className="w-20 rounded border p-1" required type="number" min={0} max={100} value={v} onChange={e=>setDraft({...draft,weights:{...draft.weights,[k]:Number(e.target.value)}})}/></label>)}</fieldset>
    : <label><input type="checkbox" checked={draft.inputs.includes("bottom")} onChange={e=>setDraft({...draft,inputs:e.target.checked?["bottom"]:[]})}/> Bottom Fishing Screen</label>}
    {!draft.inputs.length && stage==="score" && <p>No source selected · fresh entries paused.</p>}
    <div><button aria-disabled={busy||total!==100||version!==data.version} className="rounded-lg bg-indigo-700 px-4 py-2 font-semibold text-white aria-disabled:opacity-40">Save</button></div>
    {version!==data.version && <button type="button" className="underline" onClick={()=>{setVersion(data.version);setDraft(structuredClone(data.settings));setMessage("");}}>Load saved settings</button>}
    {message && <p role="status">{message}</p>}
  </form>;
}

"use client";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { apiService } from "@/services/api";
import { captureWorkflowOwner, onWorkflowOwnerInvalidated, type WorkflowOwner } from "@/lib/workflowOwnerLifetime";
import { workflowOwnedApi } from "@/lib/workflowOwnedApi";
import { screenerApi, type Strategy } from "@/lib/screenerLibrary";

type Run = {id:number; at:string; status:string; count?:number};
type Group = {id:string; name:string; automatic:boolean; latest:number[]; selected:number[]; runs:Run[]; pinned_older:Run[]};
type Inputs = {version:number; groups:Group[]};

export function ScorecardInputs({strategy, card}:{strategy:Strategy; card:string}) {
  const owner=useSyncExternalStore(onWorkflowOwnerInvalidated,captureWorkflowOwner,()=>null);
  return owner && <Editor key={owner.generation+"/"+strategy+"/"+card} owner={owner} strategy={strategy} card={card}/>;
}

function Editor({strategy,card,owner}:{strategy:Strategy;card:string;owner:WorkflowOwner}) {
  const client=useMemo(()=>workflowOwnedApi(apiService,owner),[owner]);
  const path=screenerApi()+"/inputs/"+strategy+"/"+card;
  const [data,setData]=useState<Inputs|null>(null);
  const [choices,setChoices]=useState<Record<string,number[]>>({});
  const [error,setError]=useState(""), [notice,setNotice]=useState("");
  const [retry,setRetry]=useState(0), [busy,setBusy]=useState(false);
  function apply(input:Inputs) {
    setData(input);
    setChoices(Object.fromEntries(input.groups.filter(g=>!g.automatic).map(g=>[g.id,g.selected])));
  }
  useEffect(()=>{
    let live=true;
    client.get<Inputs>(path).then(input=>{if(live){apply(input);setError("");}}).catch(e=>{if(live)setError(String(e));});
    return ()=>{live=false;};
  },[path,client,retry]);
  function change(id:string,selected?:number[]) {
    setNotice("");
    setChoices(old=>{const next={...old};if (selected===undefined) delete next[id]; else next[id]=selected;return next;});
  }
  return <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
    <h2 className="text-lg font-semibold">Stage 2 screener inputs</h2>
    <p className="text-sm text-slate-600">Each screener supplies its latest usable run by default. Choose specific runs to pin them for this scorecard’s next run.</p>
    {error && <p role="alert" className="text-rose-800">{error} <button className="underline" onClick={()=>setRetry(n=>n+1)}>Reload inputs</button></p>}
    {!data && !error && <p role="status">Loading screener runs…</p>}
    {data?.groups.map(g=>{
      const pinned=choices[g.id];
      const runs=[...g.runs,...g.pinned_older];
      const selected=pinned??g.latest;
      return <fieldset key={g.id} disabled={busy} className="space-y-2 rounded-lg border p-3">
        <legend className="px-1 font-semibold">{g.name}</legend>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={pinned===undefined}
          onChange={e=>change(g.id,e.target.checked?undefined:selected)}/>Use latest usable run automatically</label>
        {!runs.length && <p className="text-sm text-slate-600">No runs available.</p>}
        {runs.map(r=><label key={r.id} className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={selected.includes(r.id)} disabled={!["completed","partial"].includes(r.status)||(!selected.includes(r.id)&&selected.length>=5)}
            onChange={e=>change(g.id,e.target.checked?[...selected,r.id]:selected.filter(id=>id!==r.id))}/>
          Run #{r.id} · {new Date(r.at).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})} IST · {r.status}{r.count!=null?" · "+r.count+" matches":""}{g.pinned_older.includes(r)?" · earlier pinned run":""}
        </label>)}
      </fieldset>;
    })}
    {data && <button type="button" disabled={busy} className="rounded-lg bg-indigo-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" onClick={async()=>{
      setBusy(true);setError("");setNotice("");
      try {apply(await client.post<Inputs>(path,{version:data.version,selected:choices}));setNotice("Scorecard inputs saved.");}
      catch(e){setError(String(e));}finally{setBusy(false);}
    }}>{busy?"Saving…":"Save inputs"}</button>}
    {notice && <p role="status" className="text-sm text-emerald-800">{notice}</p>}
  </section>;
}

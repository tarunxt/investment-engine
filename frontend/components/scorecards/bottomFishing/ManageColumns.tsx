"use client";
import Link from "next/link";
import {useEffect,useState} from "react";
import {useRouter} from "next/navigation";
import {scorecardButton,scorecardPanel,scorecardTab} from "../ScorecardPresentation";
import {apiPath,route} from "./model";
import type {Model} from "./useBottomFishing";

type Catalog={catalog:[string,string,string,string][];names:string[];version:number;defaults:string[]};
const groups=[["most_used","Most Used"],["annual_pl","Annual P&L"],["quarter_pl","Quarter P&L"],["balance_sheet","Balance Sheet"],["cash_flow","Cash Flow"],["ratios","Ratios"],["price","Price"],["user_ratio","User Ratios"]];
export function ManageColumns({model}:{model:Model}){
  const {client}=model,router=useRouter();
  const [data,setData]=useState<Catalog|null>(null),[selected,setSelected]=useState<string[]>([]);
  const [group,setGroup]=useState("most_used"),[query,setQuery]=useState(""),[drag,setDrag]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false),[message,setMessage]=useState("");
  useEffect(()=>{let live=true;client.get<Catalog>(apiPath()+"/columns").then(r=>{if(live){setData(r);setSelected(r.names);}}).catch(e=>{if(live)setError(String(e));});return()=>{live=false;};},[client]);
  function move(from:string,to:string){
    setSelected(s=>{const i=s.indexOf(from),j=s.indexOf(to);if(i<0||j<0||i===j)return s;const next=[...s];next.splice(i,1);next.splice(j,0,from);return next;});
  }
  async function save(){
    if(!data||busy)return;setBusy(true);setError("");
    try{await client.post(apiPath()+"/columns",{names:selected,version:data.version});await model.refresh();router.push(route+"/screen");}
    catch(e){setError(String(e));}finally{setBusy(false);}
  }
  const matches=(data?.catalog??[]).filter(([name,tags,,short])=>query.trim()?(name+" "+short).toLowerCase().includes(query.trim().toLowerCase()):tags.split(" ").includes(group));
  return <div className={scorecardPanel+" space-y-5"}><h2 className="text-2xl font-semibold">Manage columns</h2>
    {error&&<p role="alert" className="text-rose-800">{error}</p>}
    {!data?<p>Loading columns…</p>:<>
      <p className="text-sm text-slate-600">Drag names to reorder them, or focus a name and use the left and right arrow keys.</p>
      <div className="flex flex-wrap gap-2" aria-label="Selected columns">{selected.map((name,i)=>
        <span key={name} draggable tabIndex={0} aria-label={name+", position "+(i+1)} onDragStart={e=>{e.dataTransfer.setData("text/plain",name);setDrag(name);}} onDragEnd={()=>setDrag("")}
          onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();move(drag||e.dataTransfer.getData("text/plain"),name);setDrag("");}}
          onKeyDown={e=>{if(e.target!==e.currentTarget)return;const step=e.key==="ArrowLeft"?-1:e.key==="ArrowRight"?1:0;if(step&&selected[i+step]){e.preventDefault();move(name,selected[i+step]);}}}
          className="inline-flex cursor-grab items-center gap-2 rounded border border-indigo-200 bg-indigo-50 px-3 py-1.5">{name}
          <button type="button" aria-label={"Remove "+name} onClick={()=>setSelected(s=>s.filter(n=>n!==name))}>×</button></span>)}</div>
      <div className="flex flex-wrap gap-2"><button disabled={busy} type="button" className={scorecardTab(true)} onClick={()=>void save()}>Save columns</button>
        <Link className={scorecardButton} href={route+"/screen"}>Cancel</Link>
        <button type="button" className={scorecardButton+" ml-auto"} onClick={()=>setSelected(data.defaults)}>Reset defaults</button></div>
      <div className="border-y py-4"><label className="font-semibold">Filter ratios<input type="search" value={query} placeholder="e.g. return on capital" onChange={e=>setQuery(e.target.value)} className="ml-3 rounded border px-3 py-2 font-normal"/></label>
        <div className="mt-3 flex flex-wrap gap-1">{groups.map(([id,label])=><button type="button" key={id} aria-pressed={!query&&group===id} className={scorecardTab(!query&&group===id)} onClick={()=>{setGroup(id);setQuery("");}}>{label}</button>)}</div></div>
      <div className="grid gap-4 md:grid-cols-3">{["Recent","Preceding","Historical"].map(period=><section key={period}><h3 className="mb-3 font-semibold text-slate-600">{period}</h3>
        {matches.filter(([, ,p])=>p===period).map(([name])=><label key={name} className="mb-2 flex items-start gap-2"><input className="mt-1" type="checkbox" checked={selected.includes(name)} onChange={e=>setSelected(s=>e.target.checked?[...s,name]:s.filter(n=>n!==name))}/>{name}</label>)}</section>)}</div>
      {!matches.length&&<p>No matching ratios.</p>}
      {model.data?.columns?.session && <details className="border-t pt-3"><summary>Import additional values from Screener</summary>
        <p className="my-2 text-sm">Choose a Screener CSV for {model.data.columns.session} with a company identifier and the selected ratios. Imported figures are shown for that market session.</p>
        <input aria-label="Screener CSV" type="file" accept=".csv,text/csv" onChange={async e=>{const f=e.target.files?.[0];if(!f)return;try{if(f.size>2000000)throw new Error("Choose a file under 2 MB.");const r=await client.post<{companies:number;cells:number}>(apiPath()+"/columns/import",{session:model.data?.columns?.session,text:await f.text()});setMessage(r.cells+" values imported for "+r.companies+" companies.");await model.refresh();}catch(err){setError(String(err));}}}/>
        {message&&<p role="status">{message}</p>}</details>}
    </>}</div>;
}

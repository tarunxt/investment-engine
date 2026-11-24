"use client";
import { useEffect, useState } from "react";
import { getCompatibleTargets } from "@/lib/workflowStageModels";
import { sourceLabels, type Definition, type SourceKey } from "@/lib/scorecardBoard";
import type { apiService } from "@/services/api";
import type { ProviderModelTarget } from "@/types/api";

const input="mt-1 block w-full rounded-lg border border-slate-300 bg-white p-2.5 font-normal";
export function CreateScorecard({client,onAssign}:{client:typeof apiService;onAssign:(d:Definition)=>void}) {
  const [sources,setSources]=useState<SourceKey[]>(["listings"]);
  const [models,setModels]=useState<ProviderModelTarget[]>([]);
  const [error,setError]=useState("");
  const [retry,setRetry]=useState(0);
  useEffect(()=>{let live=true; setError("");
    client.getProviders({}).then(p=>{if(live)setModels(getCompatibleTargets(p));}).catch(e=>live&&setError(String(e)));
    return ()=>{live=false;};},[client,retry]);
  return <form className="max-w-3xl space-y-5 rounded-xl border bg-white p-5" onSubmit={e=>{
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const field=(k:string)=>String(data.get(k)??"").trim();
    const columns=["Listing","Score /100",...field("columns").split("\n").map(c=>c.trim()).filter(Boolean)];
    const target=models[Number(field("model"))];
    if(!field("name")||!field("summary")||!field("inputs")||!field("prompt")||!sources.length||!target){
      setError("Complete each field and choose at least one input source.");return;
    }
    if(columns.length>16||new Set(columns.map(c=>c.toLowerCase())).size!==columns.length||columns.some(c=>c.length>80||c.includes("|"))){
      setError("Use up to 14 extra columns with unique names of up to 80 characters, without pipe characters.");return;
    }
    setError("");
    onAssign({id:"custom-"+crypto.randomUUID().replaceAll("-",""),name:field("name"),summary:field("summary"),
      sources,inputs:field("inputs"),prompt:field("prompt"),columns,target});
  }}>
    <div className="grid gap-4 sm:grid-cols-2"><label className="font-medium">Name<input name="name" maxLength={80} required className={input}/></label>
    <label className="font-medium">Model<select aria-label="Model" name="model" defaultValue="" required className={input}><option value="" disabled>Choose a configured model</option>
      {models.map((t,i)=><option key={t.provider+"::"+t.model} value={i}>{t.provider} · {t.model}</option>)}</select></label></div>
    <label className="block font-medium">Short description<input name="summary" maxLength={320} required className={input}/></label>
    <fieldset><legend className="font-medium">Inputs</legend><div className="my-2 flex flex-wrap gap-x-5 gap-y-2">
      {(Object.keys(sourceLabels) as SourceKey[]).map(s=><label key={s} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sources.includes(s)} onChange={e=>setSources(e.target.checked?[...sources,s]:sources.filter(v=>v!==s))}/>{sourceLabels[s]}</label>)}
    </div><label className="block text-sm">How should the scorecard use these inputs?<textarea name="inputs" maxLength={4000} rows={2} required className={input}/></label></fieldset>
    <label className="block font-medium">Prompt<textarea name="prompt" maxLength={4000} rows={4} required className={input} placeholder="Describe what the model should assess and how to score each listing."/></label>
    <fieldset><legend className="font-medium">Output table format</legend><p className="my-1 text-sm text-slate-600">Every row starts with Listing and Score /100. Higher scores are more favorable.</p>
    <label className="block text-sm">Additional columns, one per line<textarea name="columns" rows={3} defaultValue="Rationale" className={input}/></label></fieldset>
    {error&&<p role="alert" className="text-sm text-red-700">{error}</p>}
    {!models.length&&<p className="text-sm">A configured model is required. <button type="button" className="underline" onClick={()=>setRetry(r=>r+1)}>Refresh models</button></p>}
    <button className="rounded-lg bg-indigo-700 px-4 py-2 font-semibold text-white">Assign Weightages</button>
  </form>;
}

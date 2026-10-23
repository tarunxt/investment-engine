"use client";
import { useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { apiService } from "@/services/api";
import { URLs } from "@/lib/urls";

type Stage = { stage:string; status:string; attempts:number; error:string|null; checkpoint:{attempts?:{cost_usd:string|null}[]}; };
type Workflow = { id:number; portfolio:"india"|"indmoney_us"; status:string; stage:string; version:number; error:string|null; inputs:{source_hash:string; plan_hash:string; orders_authorized:false}; stages:Stage[]; };
const endpoint=()=>URLs.runs.list()+"/analysis-workflows";
export function ServerAnalysis() {
  const {data:session,status}=useSession();
  const lifetime=status==="authenticated"&&session?.user?.id?String(session.user.id)+":"+String(session.generation):null;
  return lifetime?<ServerAnalysisSession key={lifetime}/>:<p>Sign in to review server analysis.</p>;
}

export function ServerAnalysisSession() {
  const {data:session}=useSession();
  const owner=session?.user?.id;
  const epoch=useRef(0);
  const busy=useRef(false);
  const [enabled,setEnabled]=useState(false);
  const [items,setItems]=useState<Workflow[]>([]);
  const [error,setError]=useState<string|null>(null);
  const [pending,setPending]=useState(false);
  const [portfolio,setPortfolio]=useState<"india"|"indmoney_us">("indmoney_us");
  useEffect(()=>{
    const generation=++epoch.current;let timer:ReturnType<typeof setTimeout>;
    async function poll(){
      try {
        const config=await apiService.get<{enabled:boolean}>(endpoint()+"/config");
        if(epoch.current!==generation)return;
        setEnabled(config.enabled);
        if(config.enabled){const result=await apiService.get<{items:Workflow[]}>(endpoint());if(epoch.current!==generation)return;setItems(result.items);}
        setError(null);
      }catch(e){if(epoch.current===generation){setItems([]);setError(e instanceof Error?e.message:"Status unavailable");}}
      if(epoch.current===generation)timer=setTimeout(poll,2000);
    }
    if(owner)void poll();
    return()=>{epoch.current=generation+1;clearTimeout(timer);};
  },[owner]);
  async function prepare(row:Workflow){
    if(busy.current)return;busy.current=true;setPending(true);const generation=epoch.current;
    try{
      await apiService.post(`/backend-api/uat2/simulation/analysis/${row.id}/prepare-basket`,{});
      if(epoch.current===generation)setError('Synthetic review prepared. Open recorded order activity to inspect every leg and confirm separately. No approval was recorded by preparation.');
    }catch{if(epoch.current===generation)setError('Current analysis could not prepare a review. Refresh source, connection and module state before starting a new analysis.');}
    finally{busy.current=false;if(epoch.current===generation)setPending(false);}
  }
  async function submit(row?:Workflow,action?:string){
    if(busy.current)return;busy.current=true;setPending(true);const generation=epoch.current;
    try {
      const result=await apiService.post<Workflow>(endpoint()+(row?`/${row.id}/controls`:""),row?{portfolio:row.portfolio,version:row.version,action}:{portfolio,key:crypto.randomUUID()});
      if(epoch.current===generation){setItems(previous=>[result,...previous.filter(item=>item.id!==result.id)]);setError(null);}
    }catch(e){if(epoch.current===generation)setError(e instanceof Error?e.message:"Request failed; refresh status before retrying");}
    finally{busy.current=false;if(epoch.current===generation)setPending(false);}
  }
  return <section aria-label="Server analysis" className="rounded-lg border p-4 space-y-3">
    <h2 className="font-semibold">Server analysis</h2>
    <p className="text-sm text-muted-foreground">Analysis continues after you close this page. Orders require separate confirmation.</p>
    {error&&<p role="alert">{error}</p>}
    {!enabled?<p>Server analysis is unavailable until its approved runtime, model plan and calendar are configured.</p>:<>
      <label>Portfolio <select value={portfolio} onChange={e=>setPortfolio(e.target.value as typeof portfolio)}><option value="indmoney_us">US portfolio</option><option value="india">India portfolio</option></select></label>
      <button className="rounded border px-3 py-1" disabled={pending} onClick={()=>void submit()}>Start server analysis</button>
      {!items.length&&<p>No server workflows yet. A current eligible portfolio is required.</p>}
      {items.map(row=><article key={row.id} className="rounded border p-3 space-y-2">
        <h3>Workflow {row.id} · {row.portfolio} · {row.status}</h3>
        {row.error&&<p>{row.error}</p>}
        <ol>{row.stages.map(stage=><li key={stage.stage}>{stage.stage}: {stage.status}; attempts {stage.attempts}; cost USD {stage.checkpoint.attempts?.map(a=>a.cost_usd??"unavailable").join(" + ")||"not recorded"}{stage.error?`; ${stage.error}`:""}</li>)}</ol>
        {process.env.NEXT_PUBLIC_UAT2==='true'&&row.portfolio==='india'&&row.status==='completed'&&<button className="rounded border px-3 py-1" disabled={pending} onClick={()=>void prepare(row)}>Prepare exact fake basket review</button>}
        <details><summary>Input versions</summary><p className="break-all">Source {row.inputs.source_hash}<br/>Plan {row.inputs.plan_hash}<br/>Automatic orders: disabled</p></details>
        {(["queued","processing"].includes(row.status)?["pause","cancel"]:row.status==="paused"?["resume","cancel"]:["failed","partial"].includes(row.status)?["retry","cancel"]:[]).map(action=><button key={action} disabled={pending} className="rounded border px-3 py-1 mr-2" onClick={()=>void submit(row,action)}>{action}</button>)}
      </article>)}
    </>}
  </section>;
}

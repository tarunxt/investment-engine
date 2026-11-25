"use client";
import Link from "next/link";
import {useEffect,useState,useSyncExternalStore} from "react";
import {useAuth} from "@/hooks/useAuth";
import {captureWorkflowOwner,onWorkflowOwnerInvalidated,type WorkflowOwner} from "@/lib/workflowOwnerLifetime";
import {apiPath,date,latestOutput,route,stages,titles,type Output,type Stage} from "./model";
import {useBottomFishing} from "./useBottomFishing";
import {History} from "./History";
import {Inputs} from "./Inputs";
import {StageOutput,StockFlow} from "./StageOutput";

type Props={stage?:Stage;view?:string;record?:number};
export function StagePage(props:Props) {
  const {user}=useAuth();
  const owner=useSyncExternalStore(onWorkflowOwnerInvalidated,captureWorkflowOwner,()=>null);
  return owner&&owner.id===user?.id?<PageContent key={owner.generation} owner={owner} {...props}/>:<p>Loading account…</p>;
}
function PageContent({owner,stage,view,record}:{owner:WorkflowOwner}&Props) {
  const model=useBottomFishing(owner);
  const {data,client}=model;
  const [saved,setSaved]=useState<Output|null>(null);
  const [issue,setIssue]=useState("");
  useEffect(()=>{let current=true;setSaved(null);setIssue("");
    if(record) client.get<Output>(apiPath()+"/history/"+record).then(v=>{if(current)setSaved(v);}).catch(e=>{if(current)setIssue(String(e));});
    return ()=>{current=false;};
  },[client,record]);
  const output=record?saved:data?latestOutput(data):null;
  return <main className="mx-auto flex min-w-0 flex-col gap-6">
    <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div>
      <h1 className="text-lg font-semibold tracking-tight text-gray-950">{stage?titles[stage]:"Bottom Fishing"}</h1>
      <p className="text-sm text-gray-500">Bottom Fishing · NSE equities · All times IST</p></div>
      <Link href="/console/zerodha#india-workflow" className="text-sm text-indigo-700 underline">Zerodha workflow</Link></header>
    <nav className="flex flex-wrap gap-3">{stages.map((id,i)=><Link aria-current={stage===id?"page":undefined} className="rounded-lg border px-3 py-2 text-sm" key={id} href={route+"/"+id}>{i+1} · {titles[id]}</Link>)}</nav>
    {(model.error||issue)&&<p role="alert">{issue||model.error}</p>}
    {stage && <nav className="flex flex-wrap gap-4 text-sm text-indigo-700 underline">{[["","Saved output"],["inputs","Inputs"],...(stage==="score"?[["weights","Weights"],["scorecard-history","Scorecard history"]]:[]),["stock-flow","Stock Flow"],["history","History"]].map(([id,label])=><Link key={id} href={route+"/"+stage+(id?"?view="+id:"")}>{label}</Link>)}</nav>}
    {stage&&(view==="history"||view==="scorecard-history") ? <History stage={stage} client={client} scorecards={view==="scorecard-history"}/> :
     !data||!output ? (!issue&&<p>Loading saved output…</p>) : (stage?[stage]:stages).map(id=><section id={id} key={id} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
       <h2 className="font-semibold">{stage ? (view==="inputs"?"Inputs":view==="weights"?"Weights":view==="stock-flow"?"Stock Flow":record?"Saved run #"+record:"Latest saved output") : titles[id]}</h2>
       {view==="inputs"||view==="weights" ? <Inputs key={id+view} stage={id} weights={view==="weights"} data={data} save={model.save}/> :
        view==="stock-flow" ? <StockFlow output={output}/> : <><p className="text-xs text-slate-500">{output.mode} · {date(output.finished_at??output.state.at)} IST</p>
        {id!=="actionables" && output.state.error && <p role="alert">{output.state.error}</p>}<StageOutput stage={id} output={output}/></>}
     </section>)}
  </main>;
}

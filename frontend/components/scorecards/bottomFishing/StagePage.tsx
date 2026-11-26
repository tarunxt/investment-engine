"use client";
import Link from "next/link";
import {useEffect,useState,useSyncExternalStore} from "react";
import {useAuth} from "@/hooks/useAuth";
import {captureWorkflowOwner,onWorkflowOwnerInvalidated,type WorkflowOwner} from "@/lib/workflowOwnerLifetime";
import {apiPath,date,stageOutput,latestOutput,route,stages,titles,type Output,type Stage} from "./model";
import {useBottomFishing} from "./useBottomFishing";
import {History} from "./History";
import {Status, scorecardPanel, scorecardHeader, scorecardPage, scorecardBreadcrumbs, scorecardTab} from "../ScorecardPresentation";
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
  const output=record?saved:data?(stage?stageOutput(data,stage):latestOutput(data)):null;
  const captured = output?.state.screen_query;
  const recordedSettings = output?.settings ?? (stage==="screen" && captured && data
    ? {...data.settings,screen_query:captured.text,latest_results:captured.latest_results} : undefined);
  const tabs = [["inputs","Inputs"], ...(stage==="score" ? [["weights","Weights"]] : []), ["","Saved output"],
    ["stock-flow","Stock Flow"], ["history","History"], ...(stage==="score" ? [["scorecard-history","Scorecard history"]] : [])];
  const currentView = tabs.some(([id])=>id===view) ? view : "";
  const heading = stage ? titles[stage] + (record ? " · Saved run #"+record : "") : "Bottom Fishing";
  function tabHref(id:string) {
    const query = new URLSearchParams();
    if (id) query.set("view", id);
    if (record && !id.includes("history")) query.set("record", String(record));
    return route+"/"+stage+(query.size?"?"+query:"");
  }
  return <main className={scorecardPage}>
    <nav aria-label="Bottom Fishing breadcrumbs" className={scorecardBreadcrumbs}>
      <Link href="/console/zerodha#india-workflow" className="text-indigo-700 underline">Zerodha workflow</Link>
      <span aria-hidden="true">›</span>
      {stage ? <><Link href={route} className="text-indigo-700 underline">Bottom Fishing</Link><span aria-hidden="true">›</span></> : null}
      <span aria-current="page">{heading}</span>
    </nav>
    <header className={scorecardHeader+"border-indigo-200 bg-indigo-50 text-indigo-900"}>
      <Link className="text-sm underline" href="/console/zerodha">Zerodha India</Link>
      <h1 className="mt-1 text-2xl font-semibold">{heading}</h1>
    </header>
    {stage ? <nav aria-label="Bottom Fishing sections" className="flex flex-wrap gap-2">{tabs.map(([id,label])=>
      <Link key={id} scroll={false} aria-current={id===currentView?"page":undefined} className={scorecardTab(id===currentView)} href={tabHref(id)}>{label}</Link>)}</nav>
      : <nav aria-label="Bottom Fishing stages" className="flex flex-wrap gap-2">{stages.map((id,i)=><Link className={scorecardTab(false)} key={id} href={route+"/"+id}>{i+1} · {titles[id]}</Link>)}</nav>}
    {(model.error||issue)&&<p className="rounded-xl bg-rose-50 p-4 text-rose-900" role="alert">{issue||model.error}</p>}
    {stage&&(currentView==="history"||currentView==="scorecard-history") ? <History stage={stage} client={client} scorecards={currentView==="scorecard-history"}/> :
      !data||!output ? (!issue&&<p role="status" className="text-sm text-indigo-700">Loading saved output…</p>) :
      (stage?[stage]:stages).map(id=><section id={id} key={id} className="min-w-0 space-y-4">
        {!stage && <h2 className="text-lg font-semibold">{titles[id]}</h2>}
        {currentView==="inputs"||currentView==="weights" ? (record ? <div className={scorecardPanel}>
          <h2 className="mb-3 text-lg font-semibold">Saved {currentView}</h2>
          {recordedSettings ? <Inputs key={record+currentView} stage={id} weights={currentView==="weights"} data={{...data,state:output.state,settings:recordedSettings}} readOnly save={model.save}/> : <p>These inputs were not recorded for this run.</p>}
        </div> : <div className={scorecardPanel}><Inputs key={id+currentView} stage={id} weights={currentView==="weights"} data={data} save={model.save} run={model.run} active={model.active||model.sending}/></div>) :
          <><div className="flex flex-wrap items-center gap-3 text-sm">
            {id==="sync" && output.state.kite_sync ? <Status value="completed"/> : output.state.status && <Status value={output.state.status}/>}
            {output.finished_at||output.state.at ? <span>{date(id==="sync" && output.state.kite_sync ? output.state.kite_sync.captured_at : output.finished_at??output.state.at)} IST</span> : null}
            <span>{output.mode==="Paper cycle"?"Archived simulation":output.mode}</span></div>
            {id!=="actionables" && !(id==="sync" && output.state.kite_sync) && output.state.error && <p role="alert">{output.state.error}</p>}
            {currentView==="stock-flow"?<StockFlow output={output}/>:<StageOutput stage={id} output={output}/>}</>}
      </section>)}
  </main>;
}

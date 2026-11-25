"use client";
import {useState,useSyncExternalStore} from "react";
import {Maximize2,Minimize2,Play} from "lucide-react";
import {WorkflowTileMenu,type TileAction} from "@/components/shared/WorkflowTileMenu";
import {WorkflowBasketButton} from "@/components/shared/WorkflowBasketButton";
import {SavedOutputDialog} from "@/components/shared/SavedOutputDialog";
import {StageStatusIcon,getStageLedgerTone,stageTileBorder,type StageInfo} from "@/components/shared/WorkflowStageTile";
import {Button} from "@/components/ui/button";
import {useAuth} from "@/hooks/useAuth";
import {captureWorkflowOwner,onWorkflowOwnerInvalidated,type WorkflowOwner} from "@/lib/workflowOwnerLifetime";
import {date,latestOutput,route,stages,titles,type Stage} from "./bottomFishing/model";
import {useBottomFishing} from "./bottomFishing/useBottomFishing";
import {Inputs} from "./bottomFishing/Inputs";
import {StageOutput,StockFlow} from "./bottomFishing/StageOutput";
import {Basket} from "./bottomFishing/Basket";

type Section = "Inputs"|"Weights"|"Saved output"|"Stock Flow";
type Selection = {stage:Stage;section:Section};
const headings = ["Sync portfolio","Find New Promising Stocks","Scorecards","Final Actionables"];
const details = ["Nifty 500 market histories and assigned paper capital.","Screen against the prior 20 completed NSE sessions.","Eight technical and fundamental factors total 100 points.","Review entry decisions, quantities, stops and targets."];
const viewNames = {"Inputs":"inputs","Weights":"weights","Stock Flow":"stock-flow","Saved output":""};

export function BottomFishingBoard(){
  const {user}=useAuth();
  const owner=useSyncExternalStore(onWorkflowOwnerInvalidated,captureWorkflowOwner,()=>null);
  return owner&&owner.id===user?.id?<Board key={owner.generation} owner={owner}/>:null;
}
function Board({owner}:{owner:WorkflowOwner}){
  const model=useBottomFishing(owner);
  const {data,active,sending}=model;
  const manual=data?.manual;
  const output=data?latestOutput(data):{mode:"Manual review",state:{}};
  const state=output.state;
  const [expanded,setExpanded]=useState<Partial<Record<Stage,boolean>>>({});
  const [selection,setSelection]=useState<Selection|null>(null);
  const [basket,setBasket]=useState(false);
  const dates=[state.sync?.at,state.scans?.at(-1)?.at,state.at,state.at];
  const metrics=[
    ["Histories synced",state.sync?.covered],["Stocks discovered",Object.keys(state.setups??{}).length],
    ["Scored listings",state.rows?.filter(r=>r.score!=null).length],["Sized entries",state.rows?.filter(r=>r.qty).length]
  ];
  const currentStage=manual?.stage?stages.indexOf(manual.stage):-1;
  const sectionRoute=selection?route+"/"+selection.stage+(viewNames[selection.section]?"?view="+viewNames[selection.section]:""):"";
  return <section aria-label="Bottom fishing strategy" className="mt-6 min-w-0 rounded-2xl border border-indigo-200 bg-indigo-50/50 p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-xl font-medium text-slate-950">Bottom fishing</h2>
      <Button type="button" aria-label="Run Bottom fishing" disabled={!data||sending||active} onClick={()=>void model.run()}
        className="h-11 justify-center gap-3 rounded-full bg-slate-950 px-7 text-xs font-extrabold uppercase tracking-[0.18em] text-white shadow-lg shadow-slate-950/15 hover:bg-slate-900 disabled:opacity-50">
        <Play className="size-4"/>{sending?"Submitting…":active?(manual?.status==="running"?"Running":"Queued"):"Run"}
      </Button>
    </div>
    {manual&&<p role="status" className="mt-2 text-sm">{manual.status==="queued"?"Queued for immediate analysis using the latest completed NSE candle.":manual.status==="running"?"Running · "+(manual.stage?titles[manual.stage]:"Market data"):"Latest manual run · "+manual.status}{active&&data?.review?" · Showing the previous saved output.":""}</p>}
    {(model.error||state.error)&&<p role="alert" className="text-sm text-red-700">{model.error||state.error}</p>}
    <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{stages.map((stage,i)=>{
      const info:StageInfo=active?{state:manual?.status==="queued"||i>currentStage?"queued":i===currentStage?"running":"completed"}
        :manual?.status==="failed"&&currentStage>=0?{state:i===currentStage?"failed":i<currentStage?"completed":"idle"}
        :{state:dates[i]?"completed":"idle",runStatus:state.status==="partial"?"partial":undefined};
      const title=titles[stage];
      const Icon=expanded[stage]?Minimize2:Maximize2;
      const dialogAction=(section:Section):TileAction=>({label:section,onSelect:()=>setSelection({stage,section})});
      const actions:TileAction[]=[dialogAction("Inputs"),...(stage==="score"?[dialogAction("Weights")]:[]),dialogAction("Saved output"),dialogAction("Stock Flow"),
        {label:"History",href:route+"/"+stage+"?view=history"},...(stage==="score"?[{label:"Scorecard history",href:route+"/score?view=scorecard-history"}]:[]),
        {label:"Open stage",href:route+"/"+stage}];
      return <section key={stage} className="min-w-0 rounded-xl border border-slate-200 bg-white p-3">
        <h3 className="mb-3 font-semibold">{i+1} · {headings[i]}</h3>
        <article className={`rounded-lg p-3 ${stageTileBorder(info,"border border-slate-200")} ${getStageLedgerTone(info)}`}>
          <div className="flex items-start justify-between gap-2"><h4 className="min-w-0 font-semibold">{title}<StageStatusIcon info={info}/></h4>
            <div className="flex shrink-0 items-center"><button aria-label={`Toggle ${title} details`} aria-expanded={!!expanded[stage]}
              onClick={()=>setExpanded(v=>({...v,[stage]:!v[stage]}))} className="-my-1 inline-flex size-9 items-center justify-center rounded-lg text-slate-700 hover:bg-white/80"><Icon className="size-4"/></button>
              <WorkflowTileMenu title={title} actions={actions}/></div></div>
          <dl className="mt-2 text-xs"><div className="flex justify-between gap-2"><dt>Market data (IST)</dt><dd>{date(dates[i])}</dd></div>
            <div className="flex justify-between gap-2"><dt>{metrics[i][0]}</dt><dd>{dates[i]?metrics[i][1]??0:"—"}</dd></div></dl>
          {expanded[stage]&&<p className="mt-2 text-xs">{details[i]}</p>}
        </article>
        {stage==="actionables" && <WorkflowBasketButton ready={!!state.at&&!active&&state.status!=="failed"} onClick={()=>setBasket(true)}>View Final Basket</WorkflowBasketButton>}
      </section>;
    })}</div>
    {basket&&<Basket owner={owner.id} output={output} onClose={()=>setBasket(false)}/>}
    {selection&&<SavedOutputDialog title={titles[selection.stage]+" · "+selection.section} sectionLabel={selection.section}
      savedAt={selection.section==="Inputs"||selection.section==="Weights"?undefined:output.finished_at??state.at} provenance={selection.section==="Inputs"||selection.section==="Weights"?"Current strategy settings":output.mode}
      routeUrl={sectionRoute} onClose={()=>setSelection(null)} onRetry={()=>void model.refresh()} loading={!data}>
      <div className="space-y-3 p-5 text-sm">{!data?<p>Loading strategy…</p>:selection.section==="Inputs"||selection.section==="Weights"?
        <Inputs stage={selection.stage} weights={selection.section==="Weights"} data={data} save={model.save}/>:
        selection.section==="Stock Flow"?<StockFlow output={output}/>:<StageOutput stage={selection.stage} output={output}/>}</div>
    </SavedOutputDialog>}
  </section>;
}

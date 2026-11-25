"use client";
import {useEffect,useMemo,useState,useSyncExternalStore} from "react";
import {Maximize2,Minimize2,Play} from "lucide-react";
import {WorkflowTileMenu} from "@/components/shared/WorkflowTileMenu";
import {StageStatusIcon,getStageLedgerTone,stageTileBorder,type StageInfo} from "@/components/shared/WorkflowStageTile";
import {Button} from "@/components/ui/button";
import {apiService} from "@/services/api";
import {URLs} from "@/lib/urls";
import {useAuth} from "@/hooks/useAuth";
import {workflowOwnedApi} from "@/lib/workflowOwnedApi";
import {captureWorkflowOwner,onWorkflowOwnerInvalidated,type WorkflowOwner} from "@/lib/workflowOwnerLifetime";

type State={sync?:{at:string;covered:number;universe:number};scans?:{at:string}[];setups?:Record<string,unknown>;
  at?:string;rows?:{score?:number}[];positions?:Record<string,unknown>;realized?:number;error?:string;status?:string};
const href="/console/zerodha/bottom-fishing";
const time=(x?:string)=>x?new Date(x).toLocaleString("en-IN",{timeZone:"Asia/Kolkata",hour12:false}):"Awaiting session";
export function BottomFishingBoard(){
  const {user}=useAuth();
  const owner=useSyncExternalStore(onWorkflowOwnerInvalidated,captureWorkflowOwner,()=>null);
  return owner&&owner.id===user?.id?<Board key={owner.generation} owner={owner}/>:null;
}
function Board({owner}:{owner:WorkflowOwner}){
  const client=useMemo(()=>workflowOwnedApi(apiService,owner),[owner]);
  const [state,setState]=useState<State>({});
  const [error,setError]=useState("");
  const [manual,setManual]=useState("");
  const [sending,setSending]=useState(false);
  async function requestRun(){
    setSending(true);
    try{
      const result=await client.post<{status:string}>(URLs.runs.list()+"/scorecards/india/bottom-fishing/run",{});
      setManual(result.status);setError("");
    }catch(e){setError(String(e));}
    finally{setSending(false);}
  }
  const [expanded,setExpanded]=useState<Record<string,boolean>>({});
  useEffect(()=>{let active=true;
    async function read(){try{const data=await client.get<{state:State;manual?:{status:string}|null}>(URLs.runs.list()+"/scorecards/india/bottom-fishing");
      if(active){setState(data.state);if(data.manual)setManual(data.manual.status);}}catch(e){if(active)setError(String(e));}}
    void read();const timer=setInterval(read,30000);return()=>{active=false;clearInterval(timer);};
  },[client]);
  const lanes=[
    {id:"sync",heading:"Sync portfolio",title:"Sync market data and paper capital",date:state.sync?.at,metric:"Histories synced",value:state.sync?.covered,detail:"Nifty 500 constituents and 20 completed NSE sessions."},
    {id:"screen",heading:"Find New Promising Stocks",title:"Bottom Fishing Screen",date:state.scans?.at(-1)?.at,metric:"Stocks discovered",value:Object.keys(state.setups??{}).length,detail:"Screen at 09:30 and 13:15 IST. Valid morning setups remain eligible."},
    {id:"score",heading:"Scorecards",title:"Bottom Fishing Scorecard",date:state.at,metric:"Scored listings",value:state.rows?.filter(r=>r.score!=null).length,detail:"Every five minutes. Technical and fundamental factors total 100 points."},
    {id:"actionables",heading:"Final Actionables",title:"Bottom Fishing Actionables",date:state.at,metric:"Paper positions",value:Object.keys(state.positions??{}).length,detail:"Paper orders, exits, cash and risk belong to this strategy."}
  ];
  return <section aria-label="Bottom fishing strategy" className="mt-6 min-w-0 rounded-2xl border border-indigo-200 bg-indigo-50/50 p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-xl font-medium text-slate-950">Bottom fishing</h2>
      <Button type="button" aria-label="Run Bottom fishing" disabled={sending||manual==="queued"} onClick={()=>void requestRun()}
        className="h-11 justify-center gap-3 rounded-full bg-slate-950 px-7 text-xs font-extrabold uppercase tracking-[0.18em] text-white shadow-lg shadow-slate-950/15 hover:bg-slate-900 disabled:opacity-50">
        <Play className="size-4"/>{sending?"Submitting…":manual==="queued"?"Queued":"Run"}
      </Button>
    </div>
    {manual&&<p role="status" className="mt-2 text-sm">{manual==="queued"?"Paper run queued for the next five-minute cycle. Outside market hours it starts at 09:30 IST on the next trading day.":"Latest manual paper run: "+manual}</p>}
    {(error||state.error)&&<p role="alert" className="text-sm text-red-700">{error||state.error}</p>}
    <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{lanes.map((lane,i)=>{
      const info:StageInfo={state:state.status==="failed"?"failed":lane.date?"completed":"idle",
        runStatus:state.status==="partial"&&i>0?"partial":undefined};
      const Icon=expanded[lane.id]?Minimize2:Maximize2;
      const actions=[{label:lane.id==="score"?"Inputs and weights":"Saved output",href:href+"#"+lane.id}];
      return <section key={lane.id} className="min-w-0 rounded-xl border border-slate-200 bg-white p-3">
        <h3 className="mb-3 font-semibold">{i+1} · {lane.heading}</h3>
        <article className={`rounded-lg p-3 ${stageTileBorder(info,"border border-slate-200")} ${getStageLedgerTone(info)}`}>
          <div className="flex items-start justify-between gap-2"><h4 className="min-w-0 font-semibold">{lane.title}<StageStatusIcon info={info}/></h4>
            <div className="flex shrink-0 items-center"><button aria-label={`Toggle ${lane.title} details`} aria-expanded={!!expanded[lane.id]}
              onClick={()=>setExpanded(v=>({...v,[lane.id]:!v[lane.id]}))} className="-my-1 inline-flex size-9 items-center justify-center rounded-lg text-slate-700 hover:bg-white/80"><Icon className="size-4"/></button>
              <WorkflowTileMenu title={lane.title} actions={actions}/></div></div>
          <dl className="mt-2 text-xs"><div className="flex justify-between gap-2"><dt>Last update</dt><dd>{time(lane.date)}</dd></div>
            <div className="flex justify-between gap-2"><dt>{lane.metric}</dt><dd>{lane.date?lane.value??0:"—"}</dd></div></dl>
          {expanded[lane.id]&&<p className="mt-2 text-xs">{lane.detail}</p>}
        </article></section>;
    })}</div></section>;
}

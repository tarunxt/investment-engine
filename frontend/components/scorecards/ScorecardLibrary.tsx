"use client";
import Link from "next/link";
import {useRouter} from "next/navigation";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Check, Plus } from "lucide-react";
import { APIError, apiService } from "@/services/api";
import { useAuth } from "@/hooks/useAuth";
import { workflowOwnedApi } from "@/lib/workflowOwnedApi";
import { captureWorkflowOwner, onWorkflowOwnerInvalidated, type WorkflowOwner } from "@/lib/workflowOwnerLifetime";
import { boardApi, boardChanged, boardPath, libraryPath, sourceLabels, type Board, type Definition, type Intro, type Method } from "@/lib/scorecardBoard";
import { ScorecardInputs } from "@/components/screeners/ScorecardInputs";
import { WeightDialog } from "./WeightDialog";
import { CreateScorecard } from "./CreateScorecard";

const secondary="inline-flex min-h-9 items-center gap-1 rounded-lg border border-indigo-200 bg-white px-3 py-1.5 text-sm font-medium text-indigo-800 hover:bg-indigo-50";
export function ScorecardLibrary({screen}:{screen:string}) {
  const {user}=useAuth();
  const owner=useSyncExternalStore(onWorkflowOwnerInvalidated,captureWorkflowOwner,()=>null);
  if (!owner||owner.id!==user?.id) return <p role="status">Loading your scorecards…</p>;
  return <Library key={owner.generation} screen={screen} owner={owner}/>;
}
function Library({screen,owner}:{screen:string;owner:WorkflowOwner}) {
  const router=useRouter();
  const client=useMemo(()=>workflowOwnedApi(apiService,owner),[owner]);
  const api=useMemo(()=>boardApi(client),[client]);
  const [board,setBoard]=useState<Board|null>(null);
  const [method,setMethod]=useState<Method|null>(null);
  const [pending,setPending]=useState<{add?:Intro; definition?:Definition}|null>(null);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [retry,setRetry]=useState(0);
  const detail=screen!=="explore"&&screen!=="create";
  useEffect(()=>{let active=true;setMethod(null);setError("");setPending(null);
    Promise.all([api.read(), detail&&!screen.startsWith("custom-")?api.method(screen):Promise.resolve(null)])
      .then(([b,m])=>{if(!active)return;setBoard(b);
        const found=m??b.custom.find(c=>c.id===screen)??null; setMethod(found);
        if(detail&&!found)setError("This scorecard is unavailable on your board.");
      }).catch(e=>active&&setError(String(e)));
    return ()=>{active=false;};
  },[api,screen,detail,retry]);
  const added=(id:string)=>board?.enabled.includes(id);
  const action=(card:Intro)=>added(card.id)
    ? <span className="inline-flex items-center gap-1 text-sm font-medium text-emerald-800"><Check size={16}/>Scorecard added</span>
    : <button type="button" className={secondary+" relative z-10"} onClick={()=>{setNotice("");setPending({add:card});}}><Plus size={15}/>Add Scorecard</button>;
  return <main className="mx-auto max-w-5xl space-y-5 p-4 text-slate-900 sm:p-7">
    <Link href={boardPath} className="text-sm font-medium text-indigo-700 hover:underline">Back to Stage 3</Link>
    <h1 className="text-3xl font-semibold tracking-tight">{detail?method?.name??"Scorecard methodology":"Add Scorecard"}</h1>
    <nav className="flex flex-wrap gap-2 border-b pb-3" aria-label="Scorecard library">
      {([["explore","Explore Scorecards",libraryPath],["create","Create New Scorecard",libraryPath+"/create"]] as const).map(([id,label,href])=><Link key={id} href={href}
        aria-current={screen===id?"page":undefined} className={screen===id?"rounded-lg bg-indigo-700 px-3 py-2 text-sm font-semibold text-white":secondary}>{label}</Link>)}
    </nav>
    {error&&<p role="alert" className="text-red-700">{error} <button className="underline" onClick={()=>setRetry(r=>r+1)}>Reload</button></p>}
    {notice&&<p role="status" className="rounded-lg bg-emerald-50 p-3 text-emerald-900">{notice} <Link className="underline" href={boardPath}>View Stage 3 board</Link></p>}
    {!board&&!error&&<p role="status">Loading your board…</p>}
    {board&&screen==="explore"&&<>
      <div className="flex items-center justify-between gap-3"><h2 className="text-xl font-semibold">Explore Scorecards</h2>
        {!!board.enabled.length&&<button className={secondary} onClick={()=>setPending({})}>Edit weights</button>}</div>
      <div className="grid gap-4 sm:grid-cols-2">{[...board.catalog,...board.custom].map(card=><article key={card.id} className="relative flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-5 hover:border-indigo-300">
        <h3 className="text-lg font-semibold"><Link href={libraryPath+"/"+card.id} className="after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2">{card.name}</Link></h3>
        <p className="flex-1 text-sm leading-6 text-slate-600">{card.summary}</p><div className="flex items-center justify-between gap-2">{action(card)}{added(card.id)&&<span className="text-sm text-slate-600">{Number(board.weights[card.id]?.toFixed(2))}% weight</span>}</div>
      </article>)}</div>
    </>}
    {board&&screen==="create"&&<><h2 className="text-xl font-semibold">Create New Scorecard</h2><CreateScorecard client={client} onAssign={definition=>setPending({add:definition,definition})}/></>}
    {detail&&method&&board&&<><div className="flex flex-wrap items-center justify-between gap-3"><p className="text-slate-600">{method.summary}</p>{action(method)}</div>
      {board.custom.some(c=>c.id===method.id) && <div id="inputs"><ScorecardInputs strategy="og" card={method.id}/></div>}
      <section className="space-y-6 rounded-xl border bg-white p-5">
        <div><h2 className="mb-2 font-semibold">Inputs</h2>{board.custom.find(c=>c.id===method.id)?.sources.map(s=><p key={s} className="text-sm">{sourceLabels[s]}</p>)}<p className="whitespace-pre-wrap">{method.inputs}</p></div>
        <div><h2 className="mb-2 font-semibold">Prompt</h2><pre className="whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-4 text-sm leading-6">{method.prompt}</pre></div>
        <div><h2 className="mb-2 font-semibold">Output table format</h2><div className="overflow-x-auto" tabIndex={0} aria-label="Output columns in display order"><table className="border-collapse text-left text-sm"><thead><tr>{method.columns.map(c=><th key={c} scope="col" className="whitespace-nowrap border bg-slate-50 px-3 py-2">{c}</th>)}</tr></thead></table></div></div>
        {board.custom.find(c=>c.id===method.id)&&<p className="text-sm">Model · {board.custom.find(c=>c.id===method.id)?.target.model}</p>}
      </section></>}
    {pending&&board&&<WeightDialog board={board} addition={pending.add} onCancel={()=>setPending(null)} onSave={async weights=>{
      let updated:Board;
      try {
        updated=await api.save({version:board.version,add:pending.add?.id,definition:pending.definition,weights});
      } catch(e) {
        if(e instanceof APIError && e.status===409) {
          const latest=await api.read();
          setBoard(latest);setPending(null);setNotice("Your board changed. Review its current weights and try again.");
        }
        throw e;
      }
      setBoard(updated);setPending(null);setNotice(pending.add?pending.add.name+" added to Stage 3.":"Stage 3 weights saved.");
      window.dispatchEvent(new Event(boardChanged));
      if(pending.definition) router.replace(libraryPath+"/"+pending.definition.id);
    }}/>}
  </main>;
}

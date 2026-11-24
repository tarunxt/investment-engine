"use client";
import Link from "next/link";
import { useState } from "react";
import { libraryPath, type Board } from "@/lib/scorecardBoard";
import { scorecardApi, type CardResult } from "@/lib/independentScorecards";
import type { apiService } from "@/services/api";
import { Grid } from "@/app/console/dashboard/_components/ScorecardResultGrid";

export function CustomBoardTiles({board,issue,reload,client,status,selectable,selected,toggle}:{
  board:Board|null;issue:string;reload:()=>void;client:typeof apiService;status:Record<string,string>;
  selectable:boolean;selected:string[];toggle:(id:string)=>void;
}) {
  const [result,setResult]=useState<CardResult|null>(null);
  const [error,setError]=useState("");
  if (issue) return <p role="alert" className="mb-3 text-sm">Couldn’t load your board. <button className="underline" onClick={reload}>Retry</button></p>;
  if (!board) return <p role="status" className="mb-3 text-sm">Loading scorecards…</p>;
  if (!board.enabled.length) return <p className="mb-3 text-sm text-slate-600">Add your first scorecard to Stage 3.</p>;
  return <>{board.custom.map(d=>{
    const last=board.latest?.[d.id];
    return <article key={d.id} className="mb-3 space-y-2 rounded-lg border border-slate-200 p-3 text-sm">
      <h4 className="font-semibold"><Link className="hover:underline" href={libraryPath+"/"+d.id}>{d.name}</Link></h4>
      <p>{d.summary}</p><p>{board.weights[d.id]}% weight · {status[d.id] ?? last?.status ?? "Ready for first run"}</p>
      {selectable&&<label className="block"><input type="checkbox" checked={selected.includes(d.id)} onChange={()=>toggle(d.id)}/> Select for next run</label>}
      {last&&<button type="button" className="text-indigo-700 underline" onClick={async()=>{
        if(result?.id===last.id){setResult(null);return;}
        try{setError("");setResult(await scorecardApi(client,"india").result(last.id));}catch(e){setError(String(e));}
      }}>Saved output · workflow #{last.sequence}</button>}
      {last&&result?.id===last.id&&<Grid rows={result.rows.map(r=>Object.keys(r.output??{}).length?r.output as Record<string,unknown>:{"Listing":r.listing,"Score /100":r.score,"Coverage":r.coverage})}/>}
    </article>;
  })}{error&&<p role="alert">{error}</p>}</>;
}

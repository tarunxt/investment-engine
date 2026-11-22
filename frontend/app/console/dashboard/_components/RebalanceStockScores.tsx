"use client";

import { useRef, useState } from "react";
import type { CardResult, CardRow } from "@/lib/independentScorecards";

const labels:Record<string,string> = {cruxx:"Core thesis","technical-short":"Short-term technicals",
  "technical-medium":"Medium-term technicals","technical-long":"Long-term technicals",
  "fundamentals-short":"Short-term fundamentals","fundamentals-medium-long":"Medium/long-term fundamentals",action:"Consensus action"};

export function RebalanceStockScores({result}:{result:CardResult}) {
  const [current,setCurrent]=useState<CardRow|null>(null);
  const dialog=useRef<HTMLDialogElement>(null);
  const audit=result.rebalance_audit;
  if (!audit) return null;
  const terms=(current?.signed_terms ?? {}) as Record<string,number|null>;
  const totalWeight=Object.values(audit.weights).reduce((a,b)=>a+b,0);
  const available=Number(current?.available_weight ?? 0);
  const weighted=Object.entries(audit.weights).reduce((s,[k,w])=>s+(terms[k]??0)*w,0);
  const counts=audit.coverage;
  return <section className="space-y-3">
    <p>{counts.assessed} assessed · {counts.complete} complete · {counts.provisional} provisional · {counts.unassessed} unassessed</p>
    <table className="w-full text-left text-sm">
      <thead><tr>{["Listing","Score /100","Supported weight","Coverage","Action"].map(h=><th key={h} scope="col" className="p-2">{h}</th>)}</tr></thead>
      <tbody>{result.rows.map(row=><tr key={row.listing} className="border-t">
        <td className="p-2">{row.listing}</td><td><button type="button" className="text-blue-700 underline"
          aria-label={`Score calculation for ${row.listing}`} onClick={()=>{setCurrent(row);dialog.current?.showModal();}}>
          {row.score?.toFixed(1)??"Unavailable"}</button></td>
        <td>{String(row.available_weight??0)}/{totalWeight}</td><td>{row.coverage==="Partial"?"Provisional":row.coverage}</td>
        <td>{String(row.action??"—")}</td></tr>)}</tbody>
    </table>
    <details><summary className="cursor-pointer font-semibold">Field review by model job</summary>
      {audit.jobs.map(job=><details className="ml-3 mt-2" key={job.job_id}><summary className="cursor-pointer">
        Job #{job.job_id} · {job.model} · {job.listings} listings · {Object.entries(job.counts).map(([k,v])=>v+" "+k).join(" · ")||"All applicable fields present"}
      </summary><ul>{job.fields.map(([k,f,s])=><li key={k+f}>{k} · {labels[f]??f} · {s}</li>)}</ul></details>)}
    </details>
    <dialog ref={dialog} className="fixed inset-0 m-auto max-h-[85vh] w-[min(40rem,94vw)] overflow-auto rounded-xl bg-white p-5 shadow-xl backdrop:bg-black/40" aria-labelledby="rebalance-calc-title">
      <div className="flex justify-between gap-4"><h3 id="rebalance-calc-title" className="font-semibold">{current?.listing} · Rebalance calculation</h3>
        <button type="button" onClick={()=>dialog.current?.close()}>Close</button></div>
      <table className="my-3 w-full text-left text-sm"><thead><tr><th>Factor</th><th>Signed score</th><th>Weight</th><th>Contribution</th></tr></thead>
        <tbody>{Object.entries(audit.weights).map(([k,w])=><tr key={k}><td>{labels[k]??k}</td><td>{terms[k]??"Unavailable"}</td><td>{w}</td><td>{terms[k]==null?"Excluded":Number((terms[k]!*w).toFixed(3))}</td></tr>)}</tbody>
      </table>
      <p>Supported weight {available}/{totalWeight} ({(100*available/totalWeight).toFixed(1)}%)</p>
      <p>{available ? `Score = ((${Number(weighted.toFixed(3))} ÷ ${available}) + 3) × 100 ÷ 6 = ${current?.score?.toFixed(2)}` : "No supported factor weight."}</p>
    </dialog>
  </section>;
}

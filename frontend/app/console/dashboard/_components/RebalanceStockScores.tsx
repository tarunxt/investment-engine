"use client";

import { useRef, useState } from "react";
import { CanonicalRecommendationTable, REBALANCE_HEADER_ORDER } from "@/components/InvestmentRecommendationTable";
import type { CardResult, CardRow, RebalanceReadiness } from "@/lib/independentScorecards";

const labels:Record<string,string> = {cruxx:"Core thesis","technical-short":"Short-term technicals",
  "technical-medium":"Medium-term technicals","technical-long":"Long-term technicals",
  "fundamentals-short":"Short-term fundamentals","fundamentals-medium-long":"Medium/long-term fundamentals",action:"Consensus action"};

export function RebalanceSourceCheck({data}:{data:RebalanceReadiness}) {
  const blockers = new Map<string, {listing:string; reason:string}[]>();
  for (const row of data.rows) {
    for (const [factor, reason] of Object.entries(row.missing)) {
      const entries = blockers.get(factor) ?? [];
      entries.push({listing:row.listing, reason});
      blockers.set(factor, entries);
    }
  }
  return <section aria-label="Rebalance source readiness" className="space-y-2">
    <p><strong>Source readiness</strong> · {data.ready} ready for full scoring · {data.provisional} provisional inputs · {data.awaiting} awaiting evidence</p>
    {[...blockers].sort((a,b)=>b[1].length-a[1].length).map(([factor, entries])=>
      <details key={factor}><summary className="cursor-pointer">{labels[factor] ?? factor} · {entries.length} missing</summary>
        <ul>{entries.map(entry=><li key={entry.listing}>{entry.listing} · {entry.reason}</li>)}</ul>
      </details>)}
    <details><summary className="cursor-pointer">Evidence by listing ({data.rows.length})</summary>
      <table className="w-full text-left text-sm"><thead><tr><th>Listing</th><th>Verified listing</th><th>Price sessions (20 / 60 / 200)</th><th>Missing evidence</th></tr></thead>
        <tbody>{data.rows.map(row=><tr key={row.listing}><td>{row.listing}</td><td>{row.verified_listing}</td>
          <td>{["technical-short","technical-medium","technical-long"].map(f=>row.sessions[f]??"—").join(" / ")}</td>
          <td>{Object.entries(row.missing).map(([f,why])=><div key={f}>{labels[f]??f} · {why}</div>)}{row.state==="ready" && "Ready"}</td></tr>)}</tbody></table>
    </details></section>;
}

export function RebalanceStockScores({result:original,onRecover}:{result:CardResult;onRecover?:(id:number)=>Promise<CardResult>}) {
  const [updated,setUpdated]=useState<CardResult|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const result=updated??original;
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
    {result.rebalance_readiness && <RebalanceSourceCheck data={result.rebalance_readiness}/>}
    {result.evidence_only && <p>Evidence-only output #{result.id} · Scores retained from #{result.recovered_from} · 0 model calls</p>}
    {onRecover && counts.complete<result.rows.length && <button type="button" disabled={busy} className="rounded border px-3 py-1" onClick={async()=>{
      setBusy(true);setError("");try {setUpdated(await onRecover(result.id));} catch(e){setError(e instanceof Error?e.message:String(e));} finally {setBusy(false);}
    }}>{busy?"Checking sources…":"Refresh source evidence · no model charge"}</button>}
    {error && <p role="alert">{error}</p>}
    <p>{counts.assessed} assessed · {counts.complete} complete · {counts.provisional} provisional · {counts.unassessed} unassessed</p>
    {counts.unassessed > 0 && <details><summary className="cursor-pointer">Unassessed listings ({counts.unassessed})</summary>
      <ul>{result.rows.filter(row=>row.score == null).map(row=><li key={row.listing}>{row.listing}
        {result.unassessed_trace?.[row.listing]?.map(reason=><span key={reason}> · {reason}</span>)}
        {result.rebalance_readiness?.rows.find(item=>item.listing===row.listing)?.state==="awaiting" && " · Awaiting eligible source evidence"}
      </li>)}</ul></details>}
    <RebalanceOutputTables result={result}/>
    <details><summary className="cursor-pointer font-semibold">Score calculations by listing</summary>
    <table className="w-full text-left text-sm">
      <thead><tr>{["Listing","Score /100","Supported weight","Coverage","Action"].map(h=><th key={h} scope="col" className="p-2">{h}</th>)}</tr></thead>
      <tbody>{result.rows.map(row=><tr key={row.listing} className="border-t">
        <td className="p-2">{row.listing}</td><td><button type="button" className="text-blue-700 underline"
          aria-label={`Score calculation for ${row.listing}`} onClick={()=>{setCurrent(row);dialog.current?.showModal();}}>
          {row.score?.toFixed(1)??"Unavailable"}</button></td>
        <td>{String(row.available_weight??0)}/{totalWeight}</td><td>{row.coverage==="Partial"?"Provisional":row.coverage}</td>
        <td>{String(row.action??"—")}</td></tr>)}</tbody>
    </table>
    </details>
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

export function RebalanceOutputTables({result}: {result: CardResult}) {
  const tables = (result.model_tables ?? []).filter(table => table.rows.length);
  const renderRows = (rows: Record<string, unknown>[], title?: string) => (
    <CanonicalRecommendationTable canonicalTable={{
      title, headers: REBALANCE_HEADER_ORDER,
      rows: rows.map(row => Object.fromEntries(REBALANCE_HEADER_ORDER.map(header =>
        [header, String(row[header] ?? "—")]))),
    }} />
  );
  if (tables.length) return <>{tables.map(table =>
    <section key={table.job_id}>{renderRows(table.rows, `Slot ${table.slot} · ${table.model} · Job #${table.job_id}`)}</section>
  )}</>;
  const rows = result.rows.flatMap(row => {
    if (Array.isArray(row.raw_rows) && row.raw_rows.length) return row.raw_rows;
    const [exchange, symbol] = row.listing.split(":");
    return [{"Exchange Symbol": symbol ? exchange : "—", "Stock Symbol": symbol ?? exchange}];
  });
  return renderRows(rows);
}

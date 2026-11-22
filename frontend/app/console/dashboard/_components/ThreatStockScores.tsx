"use client";

import { useRef, useState } from "react";
import type { CardResult, CardRow } from "@/lib/independentScorecards";

const categories = ["Geopolitics/trade","Global financial conditions","Domestic economy","Domestic policy","Sector/technology","Company/governance","Physical/operational","Liquidity/positioning"];
const control = "rounded-md border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-50";
const value = (n:unknown) => typeof n === "number" ? Number(n.toFixed(2)).toString() : "—";

export function ThreatStockScores({ result, onRecover, onRetry }: {
  result:CardResult; onRecover:(id:number)=>Promise<CardResult>; onRetry?:(id:number)=>Promise<void>;
}) {
  const [saved,setSaved] = useState(result);
  const [active,setActive] = useState<CardRow|null>(null);
  const [busy,setBusy] = useState(false);
  const [message,setMessage] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const rawCount = saved.rows.filter(r=>Array.isArray(r.raw_rows) && r.raw_rows.length>0).length;
  const complete = saved.rows.filter(r=>r.coverage==="Complete").length;
  const scored = saved.rows.filter(r=>r.score!=null).length;
  const values = (active?.categories??{}) as Record<string,number|null>;
  const raw = (active?.raw_rows??[]) as Record<string,unknown>[];
  const evidence = (active?.evidence??[]) as Record<string,unknown>[];
  const candidates = (active?.source_ids??{}) as Record<string,string[]>;
  const ranked = Object.values(values).filter((v):v is number=>typeof v==="number").sort((a,b)=>b-a);
  async function act(retry:boolean) {
    setBusy(true); setMessage("");
    try {
      if(retry && onRetry) {await onRetry(saved.id); setMessage("Recovery job submitted.");}
      else {const next = await onRecover(saved.id); setSaved(next); setMessage("Saved evidence rechecked · Output #"+next.id);}
    } catch (err) {setMessage(err instanceof Error ? err.message : "Recovery failed");}
    finally {setBusy(false);}
  }
  return <div className="space-y-3">
    <p>Output #{saved.id} · {saved.threat_counts?.returned??rawCount}/{saved.rows.length} listings returned · {scored} scored · {complete} fully assessed</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" disabled={busy} className={control} onClick={()=>void act(false)}>Recheck saved evidence · no model call</button>
      {onRetry && complete<saved.rows.length && <button type="button" disabled={busy} className={control} onClick={()=>void act(true)}>Retry gaps with new evidence · uses selected model</button>}
    </div>
    {message && <p role="status">{message}</p>}
    <table className="w-full text-left text-sm"><thead><tr><th>Listing</th><th>Score /100</th><th>Verified categories</th><th>Assessment</th></tr></thead>
      <tbody>{saved.rows.map(row=><tr className="border-t" key={row.listing}><td>{row.listing}</td><td><button type="button" aria-label={"Explain Threats score for "+row.listing} className="rounded px-2 py-1 text-blue-700 underline" onClick={()=>{setActive(row);dialog.current?.showModal();}}>{value(row.score)}</button></td><td>{Number(row.assessed??0)}/8</td><td>{row.coverage}</td></tr>)}</tbody>
    </table>
    <dialog ref={dialog} aria-label="Threats score calculation" className="m-auto max-h-[85vh] w-[min(58rem,94vw)] overflow-auto rounded-xl border p-5 backdrop:bg-black/40">
      {active && <><button type="button" className={control+" float-right"} onClick={()=>dialog.current?.close()}>Close</button>
        <h3 className="text-lg font-semibold">{active.listing} · Threats score {value(active.score)}</h3>
        <p>Event risk = 4 × likelihood × impact. Each category uses its highest accepted event.</p>
        {ranked.length<3 ? <p>{3-ranked.length} more verified {3-ranked.length===1?"category":"categories"} needed to calculate a stock score.</p> :
          <p>Top three risks · {ranked.slice(0,3).map((v,i)=>[70,20,10][i]+"% × "+value(v)).join(" + ")}. Saved threat risk {value(active.stock_threat)}. Basket score = 100 − {value(active.stock_threat)} = {value(active.score)}.</p>}
        {categories.map((name,i)=>{
          const cat="C"+(i+1);
          const audit=evidence.filter(e=>String(e["Category ID"]??e.Category??"").replace(/^C/i,"")===String(i+1));
          const reported=raw.map(r=>r[cat]).filter(v=>v!=null && v!=="—");
          return <section className="mt-3 border-t pt-2" key={cat}><h4 className="font-semibold">{cat} · {name} · {value(values[name])}</h4>
            <p>Model reported {reported.map(String).join(", ")||"—"}. {values[name]==null ? (audit.length?"No accepted score.":(candidates[cat]?.length?"Source available, no verified assessment.":"No verified supporting evidence recorded.")) : "Verified category score."}</p>
            {audit.map((e,j)=><div className="mt-1 text-sm" key={j}><strong>{String(e.Disposition)}</strong> · {String(e.Scenario??"")} · {String(e["Publication timestamp"]??e["As of"]??"Date unavailable")} {e.Likelihood!=null && e.Impact!=null && <>· likelihood {String(e.Likelihood)}, impact {String(e.Impact)}</>}<p>{String(e.Rationale??"")}</p>{typeof e.excerpt==="string" && <details><summary>{String(e.source_title??"Source excerpt")}</summary><p>{e.excerpt}</p></details>}{typeof e.Source==="string" && /^https?:\/\//i.test(e.Source) && <a className="text-blue-700 underline" href={e.Source} target="_blank" rel="noreferrer">Source document</a>}</div>)}
          </section>;
        })}
      </>}
    </dialog>
  </div>;
}

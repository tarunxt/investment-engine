"use client";

import { useRef, useState } from "react";
import type { CardResult, CardRow } from "@/lib/independentScorecards";

const categories = ["Geopolitics/trade","Global financial conditions","Domestic economy","Domestic policy","Sector/technology","Company/governance","Physical/operational","Liquidity/positioning"];
const control = "rounded-md border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-50";
const value = (n:unknown) => typeof n === "number" ? Number(n.toFixed(2)).toString() : "—";

function assessment(row: CardRow) {
  if (row.score != null) return row.coverage;
  const verified = Number(row.assessed ?? 0);
  if (verified > 0 && verified < 3) return `${verified} verified · ${3 - verified} more needed for a consolidated score`;
  if (!Array.isArray(row.sourced_categories)) return row.coverage;
  const usable = row.sourced_categories.length;
  if (usable) return `${usable} supported · awaiting verified assessment`;
  const references = Object.values((row.source_ids ?? {}) as Record<string, string[]>);
  return references.some(ids => ids.length)
    ? "Source references found · missing usable issuer evidence"
    : "No source references assigned";
}

export function ThreatStockScores({ result, onRecover, onRefresh, onRetry }: {
  result:CardResult; onRecover:(id:number)=>Promise<CardResult>; onRefresh:(id:number)=>Promise<CardResult>; onRetry?:(id:number)=>Promise<void>;
}) {
  const [saved,setSaved] = useState(result);
  const [view, setView] = useState<"Consolidated scores" | "Sub-scores">("Consolidated scores");
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
  const trace = active?.issuer_trace as Record<string,string> | undefined;
  const candidates = (active?.source_ids??{}) as Record<string,string[]>;
  const ranked = Object.values(values).filter((v):v is number=>typeof v==="number").sort((a,b)=>b-a);
  async function act(action:"score"|"refresh"|"replay") {
    setBusy(true); setMessage("");
    try {
      if(action==="score" && onRetry) {await onRetry(saved.id); setMessage("Recovery job submitted.");}
      else {const next = await (action==="refresh" ? onRefresh : onRecover)(saved.id); setSaved(next); setMessage((action==="refresh"?"Missing sources checked":"Saved evidence rechecked")+" · Output #"+next.id);}
    } catch (err) {setMessage(err instanceof Error ? err.message : "Recovery failed");}
    finally {setBusy(false);}
  }
  return <div className="space-y-3">
    <p>Output #{saved.id} · {saved.threat_counts?.returned??rawCount}/{saved.rows.length} listings returned · {scored} scored · {complete} fully assessed</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" disabled={busy} className={control} onClick={()=>void act("replay")}>Recheck saved evidence · no model call</button>
      {complete<saved.rows.length && <button type="button" disabled={busy} className={control} onClick={()=>void act("refresh")}>Collect missing sources · no model call</button>}
      {onRetry && complete<saved.rows.length && <button type="button" disabled={busy} className={control} onClick={()=>void act("score")}>Score eligible gaps · uses selected model</button>}
    </div>
    {saved.threat_diagnostics && <p>{saved.threat_diagnostics.scoreable}/{saved.rows.length} listings have sources for at least three categories · {saved.threat_diagnostics.without_sources} without sources · {saved.threat_diagnostics.confidence_rejected} confidence rejections · {saved.threat_diagnostics.confidence_recovered} confidence conversions accepted</p>}
    {message && <p role="status">{message}</p>}
    <div role="group" aria-label="Threats score view" className="flex gap-2">
      {(["Consolidated scores", "Sub-scores"] as const).map(label => (
        <button key={label} type="button" aria-pressed={view === label} onClick={() => setView(label)}
          className={control + (view === label ? " bg-slate-900 text-white" : "")}>{label}</button>
      ))}
    </div>
    <div className="overflow-x-auto">
      <table aria-label={view} className="w-full border-collapse text-left text-sm">
        <caption className="pb-2 text-left">{view === "Sub-scores"
          ? "Category risk /100 · Higher means greater risk. A dash means the category has no verified score."
          : "Threat risk and safety /100 · Higher safety means lower risk. A dash means the score is unavailable."}</caption>
        <thead><tr>
          <th scope="col">Listing</th>
          {view === "Sub-scores" ? categories.map(name => <th scope="col" key={name} className="min-w-28 px-2">{name}</th>) :
            <><th scope="col">Threat risk /100</th><th scope="col">Safety /100</th></>}
          <th scope="col">Verified categories</th><th scope="col">Assessment</th>
        </tr></thead>
        <tbody>{saved.rows.map(row => {
          const categoryScores = (row.categories ?? {}) as Record<string, number | null>;
          return <tr key={row.listing} className="border-t">
            <th scope="row"><button type="button" aria-label={"Explain Threats score for "+row.listing}
              className="whitespace-nowrap py-1 text-blue-700 underline"
              onClick={() => {setActive(row); dialog.current?.showModal();}}>{row.listing}</button></th>
            {view === "Sub-scores" ? categories.map(name => <td key={name} className="px-2">{value(categoryScores[name])}</td>) :
              <><td>{value(row.stock_threat)}</td><td>{value(row.score)}</td></>}
            <td>{Number(row.assessed ?? 0)}/8</td><td>{assessment(row)}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    <dialog ref={dialog} aria-label="Threats score calculation" className="m-auto max-h-[85vh] w-[min(58rem,94vw)] overflow-auto rounded-xl border p-5 backdrop:bg-black/40">
      {active && <><button type="button" className={control+" float-right"} onClick={()=>dialog.current?.close()}>Close</button>
        <h3 className="text-lg font-semibold">{active.listing} · Threats score {value(active.score)}</h3>
        <p>Event risk = 4 × likelihood × impact. Each category uses its highest accepted event.</p>
        {ranked.length<3 ? <p>{3-ranked.length} more verified {3-ranked.length===1?"category":"categories"} needed to calculate a stock score.</p> :
          <p>Top three risks · {ranked.slice(0,3).map((v,i)=>[70,20,10][i]+"% × "+value(v)).join(" + ")}. Saved threat risk {value(active.stock_threat)}. Basket score = 100 − {value(active.stock_threat)} = {value(active.score)}.</p>}
        {trace && <section className="mt-3"><h4 className="font-semibold">Issuer filing recovery</h4>
          <dl>{[["Issuer identity","identity"],["Filing lookup","lookup"],["BSE lookup","bse_lookup"],["Technical session reuse","technical_history"],["Attachment","attachment"],["Excerpt","excerpt"]].map(([label,key]) => trace[key] && <div key={key}><dt className="inline font-medium">{label} · </dt><dd className="inline">{trace[key]}</dd></div>)}</dl>
          {trace.url && <details><summary>Filing dated {trace.as_of}</summary><p>{trace.text}</p><a className="text-blue-700 underline" href={trace.url} target="_blank" rel="noreferrer">Open issuer filing</a></details>}
        </section>}
        {Boolean(active.history_gap) && <p>Venue history · {String((active.history_gap as {reason?:string}).reason)} · {((active.history_gap as {missing_sessions?:string[]}).missing_sessions??[]).join(", ")}</p>}
        {categories.map((name,i)=>{
          const cat="C"+(i+1);
          const audit=evidence.filter(e=>String(e["Category ID"]??e.Category??"").replace(/^C/i,"")===String(i+1));
          const reported=raw.map(r=>r[cat]).filter(v=>v!=null && v!=="—");
          return <section className="mt-3 border-t pt-2" key={cat}><h4 className="font-semibold">{cat} · {name} · {value(values[name])}</h4>
            <p>Model reported {reported.map(String).join(", ")||"—"}. {values[name]==null ? (audit.length?"No accepted score.":(candidates[cat]?.length?(Array.isArray(active.sourced_categories) && !active.sourced_categories.includes(cat) ? "Source assigned but missing usable issuer evidence." : "Source assigned, no verified assessment."):"No verified supporting evidence recorded.")) : "Verified category score."}</p>
            {audit.map((e,j)=><div className="mt-1 text-sm" key={j}><strong>{String(e.Disposition)}</strong> · {String(e.Scenario??"")} · {String(e["Publication timestamp"]??e["As of"]??"Date unavailable")} {e.Likelihood!=null && e.Impact!=null && <>· likelihood {String(e.Likelihood)}, impact {String(e.Impact)}</>}<p>{String(e.Rationale??"")}</p>{Boolean(e["Confidence normalized"]) && <p>Reported confidence {String(e["Confidence reported"])} · accepted as {String(e.Confidence)}</p>}{typeof e.exposure_quote==="string" && <p>Issuer exposure · {e.exposure_quote} {typeof e.exposure_url==="string" && <a href={e.exposure_url} target="_blank" rel="noreferrer">Issuer filing</a>}</p>}{typeof e.excerpt==="string" && <details><summary>{String(e.source_title??"Source excerpt")}</summary><p>{e.excerpt}</p></details>}{typeof e.Source==="string" && /^https?:\/\//i.test(e.Source) && <a className="text-blue-700 underline" href={e.Source} target="_blank" rel="noreferrer">Source document</a>}</div>)}
          </section>;
        })}
      </>}
    </dialog>
  </div>;
}

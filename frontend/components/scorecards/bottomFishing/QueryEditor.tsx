"use client";
import {useId, useState} from "react";
import {scorecardButton} from "../ScorecardPresentation";
import type {Snapshot} from "./model";
import type {Model} from "./useBottomFishing";

type Props = { data:Snapshot; save:Model["save"]; run?:Model["run"]; readOnly?:boolean; active?:boolean };

function previousQuarter(at?:string) {
  const [month, year] = new Intl.DateTimeFormat("en-US",{month:"numeric",year:"numeric",timeZone:"Asia/Kolkata"})
    .format(at ? new Date(at) : new Date()).split("/").map(Number);
  const quarter = Math.floor((month-1)/3);
  return quarter===0 ? "Dec "+(year-1) : ["","Mar","Jun","Sep"][quarter]+" "+year;
}

export function QueryEditor({data,save,run,readOnly=false,active=false}:Props) {
  const id = useId();
  const [query,setQuery] = useState(data.settings.screen_query ?? "");
  const [latest,setLatest] = useState(data.settings.latest_results ?? false);
  const [version,setVersion] = useState(data.version);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  const [message,setMessage] = useState("");
  const changed = query!==(data.settings.screen_query??"") || latest!==Boolean(data.settings.latest_results);
  const conflict = version!==data.version;

  async function submit(startRun:boolean) {
    if(readOnly||busy||conflict||active||(!startRun&&!changed)) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const savedVersion = changed ? await save({...data.settings,screen_query:query,latest_results:latest},version) : version;
      setVersion(savedVersion);
      if(startRun && run) await run(savedVersion);
      setMessage(startRun ? "Query submitted for a manual review." : "Query saved.");
    } catch(e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  if(readOnly && data.settings.screen_query===undefined) return <p>The editable query was not recorded for this run.</p>;
  return <section className="min-w-0 space-y-4" aria-labelledby={id+"-title"}>
    <h2 id={id+"-title"} className="text-2xl font-semibold text-slate-950">Search Query</h2>
    <p className="text-base text-slate-700">{readOnly ? "Query recorded for this run." : "You can customize the query below:"}</p>
    <div><label htmlFor={id} className="mb-2 block font-semibold text-slate-900">Query</label>
      <textarea id={id} spellCheck={false} value={query} readOnly={readOnly} maxLength={4000}
        className="block min-h-64 w-full resize-y rounded-lg border border-slate-300 bg-white px-4 py-3 text-base leading-7 text-slate-950 focus:border-indigo-500 focus:outline-2 focus:outline-indigo-300"
        rows={Math.max(10,query.split("\n").length)} onChange={event=>{setQuery(event.target.value);setError("");setMessage("");}}/>
    </div>
    <label className="flex items-center gap-2"><input type="checkbox" checked={latest} disabled={readOnly}
      onChange={event=>{setLatest(event.target.checked);setMessage("");}}/>Only companies with {previousQuarter(readOnly?data.state.market_as_of??data.state.at:undefined)} results</label>
    <p className="text-sm text-slate-600">Cred-X applies this query to stocks that pass the Nifty 500 support screen. Low price and High price use the 52-week range. Edits are saved to this Cred-X account.</p>
    <details className="text-sm text-slate-600"><summary className="cursor-pointer text-indigo-700">Nifty 500 support screen</summary><p className="mt-2">20 prior sessions · Median daily turnover ≥ ₹1 crore · Two support touches at least five sessions apart · Bounce through 40% of the range · Discovery in the bottom 15%.</p></details>
    {!readOnly && <><details className="text-sm text-slate-600"><summary className="cursor-pointer text-indigo-700">Supported ratios and query syntax</summary>
      <p className="mt-2">{data.query_fields?.join(" · ")}</p>
      <p className="mt-2">Use numeric comparisons, parentheses, +, -, *, /, AND and OR. Enter percentages as whole numbers and market capitalization in ₹ crore.</p>
    </details>
    <div className="flex flex-wrap gap-2">
      <button type="button" className={scorecardButton+" aria-disabled:opacity-50"} aria-disabled={busy||conflict||active||!changed} onClick={()=>void submit(false)}>Save query</button>
      {run && <button type="button" className="rounded-full bg-indigo-700 px-4 py-2 text-sm font-semibold text-white aria-disabled:opacity-50"
        aria-disabled={busy||conflict||active} onClick={()=>void submit(true)}>{busy?"Working…":active?"Review running…":"Run this query"}</button>}
    </div>
    {conflict && <button type="button" className={scorecardButton} onClick={()=>{setQuery(data.settings.screen_query??"");setLatest(Boolean(data.settings.latest_results));setVersion(data.version);setError("");setMessage("");}}>Reload current query</button>}
    {message && <p role="status" className="text-sm text-indigo-700">{message}</p>}
    {error && <p role="alert" className="text-sm text-rose-800">{error}</p>}</>}
  </section>;
}

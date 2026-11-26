"use client";
import {useId, useState} from "react";
import {scorecardButton} from "../ScorecardPresentation";
import type {Snapshot} from "./model";
import type {CapturedResults, Model} from "./useBottomFishing";

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
  const [sourceUrl,setSourceUrl] = useState("");
  const [capture,setCapture] = useState<CapturedResults>();
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
      if(startRun && run) await run(savedVersion,capture);
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
    <section aria-labelledby={id+"-filters"} className="space-y-2 text-sm text-slate-700">
      <h3 id={id+"-filters"} className="font-semibold text-slate-950">Built-in discovery filters</h3>
      <p>L and H are the lowest low and highest high over the prior 20 completed NSE sessions, adjusted for corporate actions. R = H − L.</p>
      <ol className="list-decimal space-y-2 pl-6">
        <li><strong>Universe.</strong> Nifty 500 member with NSE series EQ and an ISIN matching the Upstox instrument master.</li>
        <li><strong>Liquidity.</strong> Median of daily (close × volume) ≥ ₹1 crore across those 20 sessions.</li>
        <li><strong>Support touches.</strong> At least two sessions with daily low ≤ L + 0.10 × R, at least five trading sessions apart.</li>
        <li><strong>Rebound.</strong> For at least one such pair, a session strictly between the touches has a high ≥ L + 0.40 × R.</li>
        <li><strong>Discovery price.</strong> For a new setup, L ≤ latest completed five-minute close ≤ L + 0.15 × R.</li>
      </ol>
    </section>
    <label className="flex items-center gap-2"><input type="checkbox" checked={latest} disabled={readOnly}
      onChange={event=>{setLatest(event.target.checked);setMessage("");}}/>Only companies with {previousQuarter(readOnly?data.state.market_as_of??data.state.at:undefined)} results</label>
    <div className="space-y-1 text-sm text-slate-700">
      <h3 className="font-semibold text-slate-950">Where the query runs</h3>
      <p>Manual reviews fetch the original query matches from Screener.in for the Saved output table. Cred-X marks the five discovery filters for each company and evaluates eligible new and carried setups for scoring. Nifty Indices supplies membership, NSE supplies daily prices, volume and corporate actions, and Upstox supplies the completed five-minute candle.</p>
      <p>Screener.in consolidated company pages supply the financial inputs and the 52-week High price and Low price used in your query. The built-in support filters above use the separate 20-session range. Only confirmed query matches progress.</p>
    </div>
    {!readOnly && <><details className="text-sm text-slate-600"><summary className="cursor-pointer text-indigo-700">Supported ratios and query syntax</summary>
      <p className="mt-2">{data.query_fields?.join(" · ")}</p>
      <p className="mt-2">Use numeric comparisons, parentheses, +, -, *, /, AND and OR. Enter percentages as whole numbers and market capitalization in ₹ crore.</p>
    </details>
    {run && <details className="space-y-2 text-sm">
      <summary>Use results from a signed-in Screener tab</summary>
      <label className="block">Screener query results URL
        <input className="block w-full rounded border p-2" value={sourceUrl} onChange={event=>{setSourceUrl(event.target.value);setCapture(undefined);}}/>
      </label>
      <label className="block">In the Screener results tab, select all and copy. Paste the page here.
        <textarea className="block w-full rounded border p-2" value="" onChange={()=>{}} onPaste={event=>{
          event.preventDefault();
          setCapture(undefined);
          try {
            const url = new URL(sourceUrl);
            if (!["www.screener.in","screener.in"].includes(url.hostname) || url.pathname!=="/screen/raw/") throw new Error("Enter the Screener query results URL.");
            const content = new DOMParser().parseFromString(event.clipboardData.getData("text/html"),"text/html");
            const rows = Array.from(content.querySelectorAll("table a[href]")).flatMap(link=>{
              const path = new URL(link.getAttribute("href")!,url).pathname.match(/^\/company\/([^/]+)\//);
              return path ? [{symbol:decodeURIComponent(path[1]),name:link.textContent?.trim()??""}] : [];
            });
            const total = Number(event.clipboardData.getData("text/plain").match(/([\d,]+)\s+results? found/i)?.[1].replaceAll(",",""));
            if (!total || rows.length!==total) throw new Error("Copy the full results page including its count and company links.");
            setCapture({query:url.searchParams.get("query")??"",latest:url.searchParams.has("latest"),rows,total});
            setError("");
          } catch(e) {setError(String(e));}
        }}/>
      </label>
      {capture && <p>{capture.total} Screener matches ready to include in this run. <button type="button" onClick={()=>setCapture(undefined)}>Clear</button></p>}
    </details>}
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

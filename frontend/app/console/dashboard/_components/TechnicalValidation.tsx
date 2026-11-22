"use client";
import {useState} from "react";
import type {scorecardApi} from "@/lib/independentScorecards";
import {Grid as ValidationTable} from "./ScorecardResultGrid";
type Read = ReturnType<typeof scorecardApi>["technicalValidation"];

export function TechnicalValidation({read,executions}:{read:Read;executions:ReturnType<typeof scorecardApi>["technicalExecutions"]}) {
  const [validation,setValidation]=useState<Awaited<ReturnType<Read>>|null>(null);
  const [busy,setBusy]=useState(false);
  const [review,setReview]=useState<Record<string,unknown>|null>(null);
  const [error,setError]=useState("");
  async function evaluate() {
    setBusy(true);setError("");
    try {setValidation(await read());} catch(e) {setError(String(e));} finally {setBusy(false);}
  }
  return <details><summary className="cursor-pointer font-semibold">20-session accuracy test</summary><button className="my-2 rounded border px-3 py-2" disabled={busy} onClick={()=>void evaluate()}>{busy?"Evaluating…":"Evaluate frozen Technical scores"}</button>
    {error&&<p role="alert">{error}</p>}
        {validation&&<><p>{validation.status} · {validation.monitoring.dates} decision dates · {validation.monitoring.qualifying_dates} qualified for rank comparison · {validation.monitoring.unknown_outcomes} missing outcomes.</p><p>Reserved test window {validation.holdout_start} to {validation.holdout_end_exclusive} (exclusive).</p><ValidationTable rows={[validation.monitoring]}/>{validation.holdout_open&&<ValidationTable rows={[validation.holdout]}/>}
        <details><summary>Factor and parameter sensitivity</summary><ValidationTable rows={Object.entries(validation.development_sensitivities).map(([variant,stats])=>({variant,...stats}))}/></details>
        <details><summary>Probability calibration</summary><p>{validation.calibration.status} · {validation.calibration.training_rows} training observations · {validation.calibration.test_rows} test observations.</p>
        {validation.calibration.brier!=null&&<p>Brier score {validation.calibration.brier.toFixed(4)} · prior up-rate benchmark {validation.calibration.baseline_brier?.toFixed(4)}. Lower values indicate smaller probability errors.</p>}
        {validation.calibration.bins.length>0&&<table className="w-full text-left"><caption>Held-out reliability by predicted probability</caption><thead><tr>{["Count","Predicted","Observed","Observed 95% interval"].map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>{validation.calibration.bins.map(b=><tr key={b.decile}><td>{b.n}</td><td><meter min={0} max={1} value={b.predicted}/> {(100*b.predicted).toFixed(1)}%</td><td><meter min={0} max={1} value={b.observed}/> {(100*b.observed).toFixed(1)}%</td><td>{b.wilson_95.map(v=>(100*v).toFixed(1)+"%").join(" – ")}</td></tr>)}</tbody></table>}</details></>}
      <details><summary>Realised trade economics</summary><p>Compare next-session entry fills and twentieth-session exits for bullish signals. Include per-share fees from each dated fill and its executable reference price. Missing records, skipped orders and unfilled orders are counted separately.</p>
      <details><summary>Execution file format (JSON)</summary><pre className="overflow-auto">{JSON.stringify([{decision:"YYYY-MM-DD",listing:"NSE:SYMBOL",status:"filled",entry_session:"YYYY-MM-DD",exit_session:"YYYY-MM-DD",entry_fill:100,exit_fill:105,entry_reference:99.9,exit_reference:105.1,entry_fees_per_share:0.1,exit_fees_per_share:0.1}],null,2)}</pre><p>A skipped or unfilled observation needs only the decision date, listing and status.</p></details>
      <label>Dated executions <input type="file" accept="application/json,.json" disabled={busy} onChange={async e=>{const f=e.target.files?.[0];if(!f)return;setBusy(true);setError("");setReview(null);
      try{if(f.size>2500000)throw Error("Maximum file size is 2.5 MB");const rows=JSON.parse(await f.text());if(!Array.isArray(rows))throw Error("Expected a JSON array");setReview(await executions(rows));}catch(err){setError(String(err));}finally{setBusy(false);}}}/></label>
      {review&&<ValidationTable rows={[review]}/>}</details></details>;
}

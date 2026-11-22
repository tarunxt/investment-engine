"use client";
import { PairwiseCoverage } from "./PairwiseCoverage";
import { RebalanceStockScores } from "./RebalanceStockScores";
import { Grid } from "./ScorecardResultGrid";
import { TechnicalValidation } from "./TechnicalValidation";
import { TechnicalStockScores } from "./TechnicalStockScores";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ScoreMatrixFormulaConfig } from "@/app/console/_components/FinalActionablesConsole";
import { apiService } from "@/services/api";
import { scorecardApi, cards, type CardKey, type CardPolicy, type CardResult, type CardFinal, type SourceDetail, type SourceRevision, type VerifiedListing } from "@/lib/independentScorecards";
import { getCompatibleTargets, usesSingleScorecardJob, resolveStageModelKeys, type StageModelPreferences } from "@/lib/workflowStageModels";
import { getAnalysisRunIdentity } from "@/lib/rebalanceRunIdentity";
import type { ProviderModelTarget, RunListItem } from "@/types/api";
import { captureWorkflowOwner, isCurrentWorkflowOwner } from "@/lib/workflowOwnerLifetime";
import { workflowOwnedApi } from "@/lib/workflowOwnedApi";

const titles = {rebalance:"Rebalance", technical:"Technical", threats:"Threats", pairwise:"Pairwise",source:"Merge contenders",actionables:"Final Actionables"};
const button="rounded-md border border-indigo-300 bg-white px-3 py-2 text-sm font-medium text-indigo-800 disabled:opacity-50";
const input="rounded-md border border-slate-300 bg-white p-2 text-sm";
const factors:Record<CardKey,string[]>={rebalance:["cruxx","technical-short","technical-medium","technical-long","fundamentals-short","fundamentals-medium-long","action"],technical:["candles","premarket","setup"],threats:["Geopolitics/trade","Global financial conditions","Domestic economy","Domestic policy","Sector/technology","Company/governance","Physical/operational","Liquidity/positioning"],pairwise:["pairwise"]};
const fmt=(n:number|null|undefined)=>n==null?"—":Number(n.toFixed(2)).toString();

export function ScorecardReview({portfolio,stage:initial,revisionId,initialAttempt,fallbackPolicy,previousFormula,onRevision,onPolicy,onClose}:{
  portfolio:"zerodha"|"indmoneyUs";stage:CardKey|"source"|"actionables";revisionId?:number;initialAttempt?:number;fallbackPolicy:CardPolicy;previousFormula:ScoreMatrixFormulaConfig;
  onRevision:(id:number)=>void;onPolicy:(p:CardPolicy)=>void;onClose:()=>void;
}) {
  const [pairMode,setPairMode]=useState<"full"|"balanced">("full");
  const [pairTrials,setPairTrials]=useState<Record<string,unknown>[]|null>(null);
  const [pairBudget,setPairBudget]=useState("");
  const broker=portfolio==="zerodha"?"india":"indmoney_us";
  const [owner]=useState(captureWorkflowOwner);
  const client=useMemo(()=>workflowOwnedApi(apiService,owner),[owner]);
  const api=useMemo(()=>scorecardApi(client,broker),[client,broker]);
  const dialog=useRef<HTMLDialogElement>(null);
  const [stage,setStage]=useState(initial),[revs,setRevs]=useState<SourceRevision[]>([]),[id,setId]=useState(revisionId??0);
  const [detail,setDetail]=useState<SourceDetail|null>(null),[version,setVersion]=useState(0),[attempt,setAttempt]=useState(0);
  const [result,setResult]=useState<CardResult|null>(null),[final,setFinal]=useState<CardFinal|null>(null),[finalId,setFinalId]=useState(0);
  const [comparison,setComparison]=useState<Record<string,unknown>[]>([]);
  const [chosen,setChosen]=useState<Partial<Record<CardKey,number>>>({});
  const [policy,setPolicy]=useState<CardPolicy>(fallbackPolicy),[models,setModels]=useState<StageModelPreferences>({});
  const [providers,setProviders]=useState<ProviderModelTarget[]>([]),[swings,setSwings]=useState<RunListItem[]>([]),[jobs,setJobs]=useState<number[]>([]);
  const [prompt,setPrompt]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const card=stage==="source"||stage==="actionables"?null:stage;
  const [confirmation,setConfirmation]=useState<VerifiedListing>({symbol:"",venue:"NASDAQ",security_id:"",share_class:"",source_url:""});

  const [performance,setPerformance]=useState<Awaited<ReturnType<typeof api.performance>>|null>(null);
  const singleJob = usesSingleScorecardJob(card ?? "", portfolio);
  const requestGuard=useRef(false);
  const pendingStarts=useRef(new Map<string,string>());
  const selectedOutput=useRef<number|null>(initialAttempt ?? null);
  useEffect(()=>{const el=dialog.current;el?.showModal();return()=>el?.close();},[]);
  useEffect(()=>{let active=true; void (async()=>{
    const values=await Promise.all([api.list(),client.getWorkflowModels(),client.getProviders({}),api.savedPolicy()]);
    if(!active)return;setRevs(values[0]);setModels(values[1]);setProviders(getCompatibleTargets(values[2]));if(values[3])setPolicy(values[3]);
    setId(prev=>prev||values[0]?.[0]?.id||0);
  })().catch(e=>active&&setError(String(e)));return()=>{active=false;};},[api,client,version]);
  useEffect(()=>{if(!id)return;let active=true;setDetail(null);setPrompt("");setResult(null);
    void api.read(id).then(d=>{if(active){setDetail(d);setChosen(Object.fromEntries(cards.map(c=>[c,d.attempts.find(a=>a.card===c)?.id??0])));setAttempt(card?(d.attempts.find(a=>a.id===selectedOutput.current&&a.card===card)??d.attempts.find(a=>a.card===card))?.id??0:0);selectedOutput.current=null;setFinalId(d.finals[0]?.id??0);}}).catch(e=>active&&setError(String(e)));
    return()=>{active=false;};},[api,id,card,version]);
  useEffect(()=>{setComparison([]);},[id,policy,chosen]);
  useEffect(()=>{if(!id||!card)return;let active=true;void api.prompt(id,card).then(x=>active&&setPrompt(x.prompt)).catch(e=>active&&setError(String(e)));return()=>{active=false;};},[api,id,card]);
  useEffect(()=>{if(!attempt){setResult(null);return;}let active=true;let timer:ReturnType<typeof setTimeout>;
    async function poll(){try{const r=await api.result(attempt);if(!active)return;setResult(r);if(r.status==="processing")timer=setTimeout(poll,3500);}catch(e){if(active)setError(String(e));}}
    void poll();return()=>{active=false;clearTimeout(timer);};},[api,attempt]);
  useEffect(()=>{if(!finalId){setFinal(null);return;}let active=true;void api.final(finalId).then(f=>active&&setFinal(f)).catch(e=>active&&setError(String(e)));return()=>{active=false;};},[api,finalId]);
  useEffect(()=>{if(stage!=="source")return;let active=true;void client.getRuns({limit:100,summary:true}).then(r=>active&&setSwings(r.items.filter(run=>{const i=getAnalysisRunIdentity(run);return i.stage==="swing"&&i.market===(broker==="india"?"india":"us");}))).catch(e=>active&&setError(String(e)));return()=>{active=false;};},[stage,client,broker]);
  async function perform(action:()=>Promise<void>){if(requestGuard.current||!isCurrentWorkflowOwner(owner))return;requestGuard.current=true;setBusy(true);setError("");try{await action();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{requestGuard.current=false;setBusy(false);}}
  async function publish(){
    const snapshot=(broker==="india"?await client.zerodhaPortfolioOverview():await client.indmoneyUsPortfolioOverview()).latest;
    if(!snapshot)throw Error("Sync the portfolio before publishing Stage 2.");
    const {sequence}=await client.reserveAutoRebalanceRunLabel(broker);
    const p=await api.publish({sequence,request_key:crypto.randomUUID(),captured_at:snapshot.captured_at,...("id" in snapshot?{snapshot_id:snapshot.id}:{}),swing_job_ids:jobs});
    setId(p.id);onRevision(p.id);setVersion(n=>n+1);
  }
  function keys(c:CardKey){return resolveStageModelKeys(c,models,portfolio);}
  async function launch(c:CardKey, retry?:number){
    if(!detail)throw Error("Select a Stage 2 revision first.");
    const targets=keys(c).map(key=>{const target=providers.find(t=>t.provider+"::"+t.model===key);if(!target)throw Error("Choose available models for "+titles[c]);return target;});
    if (!targets.length) throw Error("Choose a model for "+titles[c]);
    await client.saveWorkflowModels(c,keys(c));
    const pairOptions=c==="pairwise" && broker==="india" ? {pair_mode:retry ? result?.pair_counts?.mode ?? "full" : pairMode,
      ...(pairBudget ? {estimated_budget_inr:Number(pairBudget)} : {})} : {};
    const identity=JSON.stringify([detail.id,c,targets,retry,pairOptions]);
    const token=pendingStarts.current.get(identity)??crypto.randomUUID();
    pendingStarts.current.set(identity,token);
    const queued=await api.start(detail.id,c,{sequence:detail.manifest.sequence,request_key:token,targets,retry_attempt_id:retry,...pairOptions});
    selectedOutput.current=queued.id;
    pendingStarts.current.delete(identity);
    return queued.id;
  }
  async function compute(preview=false){
    if(!detail)return;
    const refs:Partial<Record<CardKey,number>>={};
    for(const c of cards){const ref=detail.attempts.find(a=>a.card===c && a.id===chosen[c]);if(!ref)continue;const output=await api.result(ref.id);if(output.status==="processing")throw Error(titles[c]+" is still running.");refs[c]=ref.id;}
    if(preview){setComparison((await api.compare(detail.id,detail.manifest.sequence,refs,policy,previousFormula)).comparison);return;}
    const f=await api.finalize(detail.id,detail.manifest.sequence,refs,policy);
    setFinal(f);setFinalId(f.id);onPolicy(policy);setVersion(n=>n+1);
  }
  const sourceChanged=(n:number)=>{setId(n);onRevision(n);};
  const resultRows=(result?.rows??[]).map((r):Record<string,unknown>=>{
    const raw=Array.isArray(r.raw_rows)?r.raw_rows as Record<string,unknown>[]:[];
    const [exchange,symbol]=r.listing.split(":");
    const identity={"Exchange Symbol":exchange,"Stock Symbol":symbol};
    const coverage={"Coverage":r.coverage,...(r.reason?{"Assessment reason":r.reason}:{})};
    if(card==="pairwise")return {...identity,"Pairwise score /100":r.score,"Wins":r.wins,"Ties":r.ties,"Losses":r.losses,
      "Valid comparisons":r.valid,"Expected comparisons":r.expected,"Coverage %":r.coverage_pct,...coverage,"Comparisons":r.comparisons};
    if(card==="threats")return {...identity,...(r.categories as Record<string,unknown>),"Stock threat /100":r.stock_threat,"Safety /100":r.score,
      "Assessed categories /8":r.assessed,...coverage,"Extreme impact":String(r.extreme??false),
      "Leading threat":raw.map(v=>v["Leading threat"]).filter(Boolean).join(" · "),"Trigger or event date":raw.map(v=>v["Trigger or event date"]).filter(Boolean).join(" · "),"Evidence":r.evidence};
    if(card==="technical")return {...identity,...Object.fromEntries(["Primary Setup","Secondary Setups","Bias","Premarket trend","Last 5 candles trend",
      "Confidence Score","Trigger Level","Invalidation Level","Evidence source and as-of","Technical rationale"].map(k=>[k,raw.length===1?raw[0][k]:raw.map(v=>v[k])])),
      "Technical score /100":r.score,...coverage,"Mean signed terms":r.signed_terms};
    return {...identity,"Rebalance score /100":r.score,...r.terms,"Consensus action":r.action,"Available weight":r.available_weight,"Models":r.model_count,...coverage};
  });
  return <dialog ref={dialog} onCancel={onClose} className="fixed inset-0 m-auto max-h-[94vh] w-[min(96vw,1320px)] max-w-none overflow-auto rounded-2xl border bg-white p-5 text-slate-900 shadow-xl backdrop:bg-slate-900/40" aria-label="Scorecards">
    <div className="flex items-center justify-between"><h2 className="text-xl font-semibold">{titles[stage]}</h2><button className={button} onClick={onClose}>Close</button></div>
    <nav className="my-3 flex flex-wrap gap-2">{(["source",...cards,"actionables"] as const).map(c=><button className={button} aria-pressed={c===stage} key={c} onClick={()=>{setStage(c);setError("");}}>{titles[c]}</button>)}</nav>
    <label>Stage 2 revision <select className={input} value={id} onChange={e=>sourceChanged(Number(e.target.value))}><option value={0}>Select a publication</option>{revs.map(r=><option key={r.id} value={r.id}>#{r.id} · Run {r.sequence} · {r.created_at}</option>)}</select></label> {id>0&&revisionId!==id&&<button className={button} onClick={()=>onRevision(id)}>Use this revision for the workflow</button>}
    {error&&<p role="alert" className="my-2 text-red-700">{error}</p>}
    {stage==="source"&&<section className="space-y-3 py-3"><details open={!id}><summary>Publish holdings and selected Swing jobs</summary>
      <div className="my-2 max-h-48 overflow-auto">{swings.flatMap(r=>r.run_jobs.filter(j=>["completed","partial"].includes(j.job?.status??"")).map(j=><label className="block" key={j.job_id}><input type="checkbox" checked={jobs.includes(j.job_id)} onChange={e=>setJobs(old=>e.target.checked?[...old,j.job_id]:old.filter(n=>n!==j.job_id))}/> Run {r.id} · Job {j.job_id} · {j.job?.model}</label>))}</div>
      <button disabled={busy} className={button} onClick={()=>void perform(publish)}>Publish Stage 2 revision</button></details>
      {detail&&<><p>{detail.manifest.stocks.length} listings · Decision time {detail.manifest.as_of}</p><Grid rows={detail.manifest.stocks}/>{detail.manifest.unresolved.length>0&&<><h3>Unresolved listings</h3><Grid rows={detail.manifest.unresolved}/>{broker==="indmoney_us"&&<fieldset className="flex flex-wrap items-end gap-2"><legend>Confirm a listing from a broker or exchange record</legend>
        {(["symbol","venue","security_id","share_class","source_url"] as const).map(k=><label key={k} className="grid text-xs">{k.replaceAll("_"," ")}{k==="venue"?<select className={input} value={confirmation.venue} onChange={e=>setConfirmation(f=>({...f,venue:e.target.value}))}>{["NASDAQ","NYSE","NYSEAMERICAN","NYSEARCA"].map(v=><option key={v}>{v}</option>)}</select>:<input className={input} value={confirmation[k]} onChange={e=>setConfirmation(f=>({...f,[k]:k==="symbol"?e.target.value.toUpperCase():e.target.value}))}/>}</label>)}
        <button disabled={busy||Object.values(confirmation).some(v=>!v.trim())} className={button} onClick={()=>void perform(async()=>{
          if(!detail.manifest.unresolved.some(r=>r.symbol===confirmation.symbol))throw Error("Choose a symbol listed as unresolved.");
          const f=detail.manifest;
          const next=await api.publish({sequence:f.sequence,request_key:crypto.randomUUID(),snapshot_id:f.snapshot_id,captured_at:f.snapshot_at,swing_job_ids:f.swing_job_ids,verified_listings:[...(f.verified_listings??[]),confirmation]});
          setId(next.id);onRevision(next.id);setVersion(v=>v+1);
        })}>Publish corrected revision</button></fieldset>}</>}
      <button className={button} disabled={busy} onClick={()=>void perform(async()=>{const outcomes=await Promise.allSettled(cards.map(c=>launch(c)));setVersion(n=>n+1);const failed=outcomes.flatMap((r,i)=>r.status==="rejected"?[titles[cards[i]]+" · "+String(r.reason)]:[]);if(failed.length)throw Error(failed.join("\n"));})}>Run all four scorecards</button></>}</section>}
    {card&&<section className="space-y-3 py-3"><div className="flex flex-wrap gap-2">{(singleJob ? [keys(card)[0] ?? ""] : keys(card)).map((key,i)=><label key={i}>Model {i+1} <select className={input} value={key} onChange={e=>setModels(old=>({...old,[card]:singleJob?[e.target.value]:keys(card).map((v,n)=>i===n?e.target.value:v)}))}>{[...new Set([key,...providers.map(t=>t.provider+"::"+t.model)])].map(k=><option key={k} value={k} disabled={!k}>{k || "Choose a model"}</option>)}</select></label>)}
      {!singleJob && <><button className={button} disabled={keys(card).length>=8} onClick={()=>setModels(old=>({...old,[card]:[...keys(card),keys(card)[0]??providers.map(t=>t.provider+"::"+t.model)[0]]}))}>Add model slot</button>
      <button className={button} disabled={keys(card).length<2} onClick={()=>setModels(old=>({...old,[card]:keys(card).slice(0,-1)}))}>Remove last slot</button></>}
      <button className={button} disabled={busy || (singleJob && !keys(card).length)} onClick={()=>void perform(async()=>{await client.saveWorkflowModels(card,keys(card));})}>Save models</button></div>
      {card==="pairwise"&&broker==="india"&&<div className="flex flex-wrap items-center gap-3"><label>Schedule <select className={input} value={pairMode} onChange={e=>setPairMode(e.target.value as "full"|"balanced")}><option value="full">Full round robin</option><option value="balanced">Balanced trial · up to 8 opponents per listing</option></select></label><label>Estimated spend limit (₹) <input className={input+" w-24"} type="number" min="0.01" step="0.01" value={pairBudget} onChange={e=>setPairBudget(e.target.value)} placeholder="Optional"/></label></div>}
      <div className="flex flex-wrap gap-2"><button disabled={busy||!detail} className={button} onClick={()=>void perform(async()=>{await launch(card);setVersion(n=>n+1);})}>Run {titles[card]}</button>
      {card==="pairwise"&&broker!=="india"&&result&&result.rows.some(r=>Number(r.valid)<Number(r.expected))&&<button className={button} disabled={busy} onClick={()=>void perform(async()=>{const replay=await api.recover(attempt);if(replay.rows.some(r=>Number(r.valid)<Number(r.expected)))await launch(card,replay.id);setVersion(n=>n+1);})}>Retry unresolved pairs</button>}
      <select aria-label="Scorecard output revision" className={input} value={attempt} onChange={e=>setAttempt(Number(e.target.value))}><option value={0}>Select output</option>{detail?.attempts.filter(a=>a.card===card).map(a=><option key={a.id} value={a.id}>Output #{a.id} · Run {a.run_id}</option>)}</select></div>
      {card==="pairwise"&&broker==="india"&&result&&<>
        <PairwiseCoverage result={result}/>
        <details><summary>Compare Balanced with Full on saved finals</summary><button className={button} disabled={busy} onClick={()=>void perform(async()=>setPairTrials(await api.pairTrials()))}>Compare top five and basket actions</button>
        {pairTrials && (pairTrials.length ? <Grid rows={pairTrials}/> : <p>No saved final has a complete full round robin for this comparison.</p>)}</details>
        <button className={button} disabled={busy} onClick={()=>void perform(async()=>{const repaired=await api.repairPairs(attempt);selectedOutput.current=repaired.id;setAttempt(repaired.id);setResult(repaired);setVersion(n=>n+1);})}>Repair missing evidence · no model charge</button>
        <button className={button} disabled={busy||!result.pair_counts||result.pair_counts.eligible<=result.pair_counts.judged} onClick={()=>void perform(async()=>{await launch("pairwise",attempt);setVersion(n=>n+1);})}>Judge eligible unresolved pairs</button>
      </>}
      {card==="pairwise"&&attempt>0&&<button className={button} disabled={busy} onClick={()=>void perform(async()=>{const r=await api.recover(attempt);selectedOutput.current=r.id;setVersion(n=>n+1);})}>Recheck saved responses · no model call</button>}
      {attempt>0&&<button className={button} disabled={busy} onClick={()=>void perform(async()=>{setResult(await api.result(attempt));})}>Refresh output</button>}
      {prompt&&<details><summary>LLM prompt · first batch</summary><pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs">{prompt}</pre></details>}
      {(card==="technical"||card==="pairwise")&&broker==="india"&&<details><summary>Historical performance</summary><button className={button} disabled={busy} onClick={()=>void perform(async()=>setPerformance(await api.performance()))}>Evaluate saved decisions</button>
      {performance&&<><p>Top {performance.top_n} · {performance.benchmark} · {performance.one_way_cost_bps} basis points per side · {performance.eligible_workflows} saved workflows with both outputs. Returns require complete forward prices.</p><Grid rows={performance.rows}/></>}</details>}
      {card==="technical"&&broker==="india"&&<TechnicalValidation key={id} read={api.technicalValidation} executions={api.technicalExecutions}/>}
      {result&&<><p>{result.status} · {result.completed}/{result.jobs} model jobs · {result.scored??0} stocks scored</p>{card==="technical"&&broker==="india"?<TechnicalStockScores key={result.id} revision={id} result={result}
          onRecover={async()=>{const updated=await api.recover(result.id);selectedOutput.current=updated.id;setVersion(n=>n+1);return updated;}}
          onRetryCommentary={async()=>{await launch("technical",result.id);setVersion(n=>n+1);}}/>:card!=="rebalance"&&<Grid rows={resultRows}/>}
        {card==="rebalance"&&<><h3>Rebalance output</h3>{result.model_tables?.map(t=><section key={t.job_id}><h4>Slot {t.slot} · {t.model} · Job {t.job_id}</h4><Grid rows={t.rows}/></section>)}<h3>Scores for Stage 4</h3>{result.rebalance_audit?<><RebalanceStockScores result={result}/>{((result.rebalance_audit.coverage.provisional+result.rebalance_audit.coverage.unassessed)>0 || result.rows.some(row=>Object.values((row.trade_gaps??{}) as Record<string,string[]>).some(fields=>fields.length))) && <button type="button" className={button} disabled={busy} onClick={()=>perform(async()=>{await launch("rebalance",result.id);})}>Refresh evidence and repair missing fields</button>}</>:<Grid rows={resultRows}/>}</>}
        {!!result.research_notices?.length&&<details><summary>Research source availability</summary><ul>{result.research_notices.map(n=><li key={n}>{n}</li>)}</ul></details>}
        {result.balanced_schedule&&<details><summary>Balanced schedule comparison</summary><Grid rows={[result.balanced_schedule]}/></details>}
        {result.cost_per_judgment_usd!=null&&<p>Estimated cost per judged pair: US${result.cost_per_judgment_usd.toFixed(5)}</p>}
        {!!result.order_checks?.length&&<details><summary>Reversed-order comparison results</summary><Grid rows={result.order_checks}/></details>}
        {!!result.recovered_pairs?.length&&<details><summary>Recovered comparisons</summary><Grid rows={result.recovered_pairs}/></details>}
        {!!result.errors?.length&&<details><summary>Job diagnostics</summary><Grid rows={result.errors}/></details>}</>}</section>}
    {stage==="actionables"&&<section className="space-y-3 py-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{cards.map(c=><fieldset key={c} className="rounded-lg border p-2"><legend>{titles[c]}</legend>
        <label className="block">Output <select className={input} value={chosen[c]??0} onChange={e=>setChosen(p=>({...p,[c]:Number(e.target.value)}))}><option value={0}>Unassessed</option>{detail?.attempts.filter(a=>a.card===c).map(a=><option key={a.id} value={a.id}>#{a.id} · Run {a.run_id}</option>)}</select></label>
        <label>Weight % <input className={input+" w-24"} type="number" step="any" min={0} max={100} value={policy.weights[c]} onChange={e=>setPolicy(p=>({...p,weights:{...p.weights,[c]:Number(e.target.value)}}))}/></label>
        <label className="block text-sm"><input type="checkbox" checked={!!policy.factors[c]} onChange={e=>setPolicy(p=>{const f={...p.factors};if(e.target.checked)f[c]=Object.fromEntries(factors[c].map(k=>[k,1]));else delete f[c];return {...p,factors:f};})}/> Weight subsections</label>
        {policy.factors[c]&&factors[c].map(k=><label className="flex justify-between gap-1 text-xs" key={k}>{k}<input className="w-14 border" type="number" min={0} step="any" value={policy.factors[c]?.[k]??0} onChange={e=>setPolicy(p=>({...p,factors:{...p.factors,[c]:{...p.factors[c],[k]:Number(e.target.value)}}}))}/></label>)}</fieldset>)}</div>
      <button className={button} disabled={busy||!detail} onClick={()=>void perform(()=>compute(true))}>Compare formulas on selected outputs</button>
      {comparison.length>0&&<details open><summary>Formula preview · same observed inputs</summary><Grid rows={comparison}/></details>}
      <button className={button} disabled={busy||!detail} onClick={()=>void perform(()=>compute())}>Recalculate and save</button>
      <select aria-label="Final revision" className={input} value={finalId} onChange={e=>setFinalId(Number(e.target.value))}><option value={0}>Select final</option>{detail?.finals.map(f=><option value={f.id} key={f.id}>Final #{f.id}</option>)}</select>
      {final&&<>{cards.some(c=>chosen[c] && final.attempts[c]!==chosen[c])&&<p>Selected scorecard outputs have changed. Recalculate to save a new final.</p>}<p>Final #{final.id} · Stage 2 #{final.revision_id} · {cards.map(c=>titles[c]+" "+fmt(final.policy.weights[c])+"%").join(" · ")}</p>
      <Grid rows={final.rows.map(r=>({"Rank":r.rank,"Listing":r.listing,"Name":r.name,"Origin":r.origin,"Current units":r.units,...r.scores,"Weighted contributions":r.contributions,"Available weight %":r.available_weight,"Final /100":r.final,"Coverage":r.status,"Action":r.action,"Suggested units":r.suggested_units,"Sizing / eligibility":r.sizing_reason}))}/>
      <div className="flex gap-2">{cards.filter(c=>final.attempts[c]).map(c=><button className={button} key={c} onClick={()=>{selectedOutput.current=final.attempts[c]!;setStage(c);}}>{titles[c]} #{final.attempts[c]}</button>)}</div></>}
    </section>}
  </dialog>;
}


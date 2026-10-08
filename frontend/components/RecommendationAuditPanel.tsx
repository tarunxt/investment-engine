"use client";
import { useEffect, useRef, useState } from "react";
import { recommendationAuditApi, recommendationAuditEnabled } from "@/services/recommendationAudit";
import type { AuditComparison, AuditFormula, AuditVerification, AuditVerifyRequest } from "@/types/recommendationAudit";

export function RecommendationAuditPanel({ runId, runIds, runCount, formula, technicalRunId, market, symbol, exchange, currentScore, currentAction }: { runId: number | null; runIds?: number[]; runCount: number; formula?: AuditFormula; technicalRunId?: number | null; market: string; symbol: string; exchange: string; currentScore: number | null; currentAction: string | null }) {
  const [comparison, setComparison] = useState<AuditComparison | null>(null);
  const [verification, setVerification] = useState<AuditVerification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [external, setExternal] = useState(false);
  const [budget, setBudget] = useState("0");
  const controller = useRef<AbortController | null>(null);
  const request = useRef<AuditVerifyRequest | null>(null);
  useEffect(() => {
    if (!recommendationAuditEnabled || !runId) return;
    const abort = new AbortController(); controller.current = abort;
    recommendationAuditApi.comparison({ run_id: runId, market, symbol, exchange }, abort.signal).then(setComparison).catch(e => { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : String(e)); });
    return () => abort.abort();
  }, [runId, market, symbol, exchange]);
  const bundleHash = comparison?.bundle_hash;
  useEffect(() => { request.current = null; }, [bundleHash, runId, market, symbol, exchange]);
  const verificationId = verification?.id, verificationStatus = verification?.status;
  useEffect(() => {
    if (!verificationId || !verificationStatus || !["queued", "processing"].includes(verificationStatus)) return;
    const abort = new AbortController(); let polls = 0; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await recommendationAuditApi.status(verificationId, abort.signal);
        if (abort.signal.aborted) return;
        setVerification(next);
        if (["queued", "processing"].includes(next.status) && ++polls < 60) timer = setTimeout(poll, 3000);
      } catch (e) { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : String(e)); }
    };
    timer = setTimeout(poll, 3000);
    return () => { abort.abort(); clearTimeout(timer); };
  }, [verificationId, verificationStatus]);
  if (!recommendationAuditEnabled) return null;
  async function materialize() {
    if (!runId) return;
    setBusy(true); setError(null);
    try { await recommendationAuditApi.materialize(runId, controller.current?.signal); setComparison(await recommendationAuditApi.comparison({ run_id: runId, market, symbol, exchange }, controller.current?.signal)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function capture() {
    if (!runId || !formula) return;
    setBusy(true); setError(null);
    try {
      await recommendationAuditApi.capture(runIds?.length ? runIds : [runId], technicalRunId ?? null, formula, controller.current?.signal);
      setComparison(await recommendationAuditApi.comparison({ run_id: runId, market, symbol, exchange }, controller.current?.signal));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function cancel() {
    if (!verification) return;
    setBusy(true); setError(null);
    try { setVerification(await recommendationAuditApi.cancel(verification.id)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function verify(fresh = false) {
    if (!comparison?.current || !comparison.bundle_hash) return;
    setBusy(true); setError(null);
    if (external && comparison.capabilities?.external_enabled && (!Number.isFinite(Number(budget)) || Number(budget) < 0 || Number(budget) > (comparison.capabilities?.daily_cap_usd ?? 0))) { setError("Enter a budget within the configured daily cap."); setBusy(false); return; }
    const useExternal = external && comparison.capabilities?.external_enabled === true;
    const mode = useExternal ? "external_data" : "stored_only";
    if (fresh || request.current?.bundle_hash !== comparison.bundle_hash || request.current?.mode !== mode || request.current?.budget_usd !== (useExternal ? Number(budget) : 0)) request.current = null;
    request.current ??= { current_id: comparison.current.id, previous_id: comparison.previous?.id ?? null, bundle_hash: comparison.bundle_hash, policy_version: "reversal-evidence-v1", mode, idempotency_key: crypto.randomUUID(), budget_usd: useExternal ? Number(budget) : 0, ...(fresh ? { refresh_key: crypto.randomUUID() } : {}) };
    try { setVerification(await recommendationAuditApi.verify(request.current, controller.current?.signal)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  const current = comparison?.current, previous = comparison?.previous;
  const present = comparison?.present_calculation;
  const show = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value) ?? "Unknown";
  return <section className="rounded-xl border border-slate-200 bg-white p-4" aria-label="Recommendation evidence comparison">
    <h3 className="font-semibold text-slate-950">What changed?</h3>
    <p className="mt-1 text-xs text-slate-600">Frozen source run {runId ? `#${runId}` : "unavailable"}. {runCount > 1 ? `Current popup combines ${runCount} runs; this comparison covers one source run.` : "Actions, evidence and holdings are compared separately."}</p>
    {error && <p role="alert" className="mt-2 text-amber-800">{error}</p>}
    {formula && <button disabled={busy || !runId || comparison?.capabilities?.recovery_read_only} className="mt-2 rounded border px-3 py-2" onClick={capture}>Capture current calculation</button>}
    {present && <p className="mt-2 rounded bg-blue-50 p-2 text-xs">Present calculation observed {present.captured_at}: {present.calculation.formula_action ?? "Unknown"} ({present.calculation.score ?? "—"}), sizing {present.sizing.action ?? "Unknown"} ({present.sizing.units ?? "—"}). This snapshot records the current settings and all selected source runs. It does not establish the original policy.</p>}
    {!comparison ? <p className="mt-2">{error ? "Comparison unavailable." : "Loading frozen comparison…"}</p> : !current ? <div className="mt-3"><p>No frozen decision. Original formula and publication times may be unavailable.</p><button disabled={busy || !runId || comparison?.capabilities?.recovery_read_only} className="mt-2 rounded border px-3 py-2" onClick={materialize}>Capture legacy response as observed now</button></div> : <>
      <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr><th className="p-2">Layer</th><th className="p-2">Previous {previous ? `#${previous.run_id}` : "unavailable"}</th><th className="p-2">Captured #{current.run_id}</th></tr></thead><tbody>
        <tr><td className="p-2">Provider action</td><td>{previous?.calculation.raw_action ?? "Unknown"}</td><td>{current.calculation.raw_action ?? "Unknown"}</td></tr>
        <tr><td className="p-2">Rationale mean</td><td>{previous?.calculation.rationale_mean ?? "Unknown"}</td><td>{current.calculation.rationale_mean ?? "Unknown"}</td></tr>
        <tr><td className="p-2">Recorded formula</td><td>{previous?.calculation.formula_action ?? "Unknown"} ({previous?.calculation.score ?? "—"})</td><td>{current.calculation.formula_action ?? "Unknown"} ({current.calculation.score ?? "—"})</td></tr>
        <tr><td className="p-2">Signed quantity</td><td>{previous?.calculation.formula_units ?? "Unknown"}</td><td>{current.calculation.formula_units ?? "Unknown"}</td></tr>
        <tr><td className="p-2">Held quantity</td><td>{previous?.calculation.current_units ?? "Unknown"}</td><td>{current.calculation.current_units ?? "Unknown"}</td></tr>
        <tr><td className="p-2">Existing basket sizing</td><td>{previous?.sizing.action ?? "Unknown"}</td><td>{current.sizing.action ?? "Unknown"} ({current.sizing.units ?? "—"})</td></tr>
      </tbody></table></div>
      <p className="mt-2 text-xs">Current UI recalculation: {currentAction ?? "Unknown"} ({currentScore ?? "—"}). Capture provenance: {current.provenance}. Models covered: {current.coverage.successful}/{current.coverage.attempted}.</p>
      <p className="mt-1 text-xs">Decision time {current.decision_at ?? "unknown"}; captured {current.captured_at ?? "unknown"}; original completion {current.original_completion_at ?? "unknown"}. Previous identity: {comparison.comparison?.comparable ? "comparable under captured mapping" : "unverified"}.</p>
      {!previous && <p className="mt-2 text-xs text-amber-900">No preceding frozen decision. Missing history does not mean Hold.</p>}
      {comparison.comparison && <div className="mt-3 text-xs"><h4 className="font-semibold">Changed inputs and components</h4><ul className="list-disc pl-5">{comparison.comparison.changes.map(change => <li key={change.field}>{change.field}: {show(change.before)} → {show(change.after)}</li>)}{Object.entries(comparison.comparison.score_component_changes ?? {}).map(([key,value]) => <li key={key}>{key} score change: {value}</li>)}</ul></div>}
      <p className="mt-2 text-xs">History coverage: {show(comparison.coverage)}</p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-amber-900">{(comparison.comparison?.findings ?? current.calculation.findings).map((f, i) => <li key={`${f.code}:${i}`}>{f.detail}</li>)}</ul>
      {comparison.capabilities?.external_enabled && <div className="mt-3 text-xs"><label><input type="checkbox" checked={external} onChange={e => setExternal(e.target.checked)} /> Include independent API data</label>{external && <label className="ml-3">Maximum spend USD <input aria-label="Verification spend cap in USD" type="number" min="0" max={comparison.capabilities.daily_cap_usd} step="0.01" value={budget} onChange={e => setBudget(e.target.value)} className="w-20 rounded border p-1" /></label>}<p>Daily cap ${comparison.capabilities.daily_cap_usd}. Kite: at most 2 requests, {comparison.capabilities.kite_request_cost_usd === null ? "tariff unknown; blocked" : `$${comparison.capabilities.kite_request_cost_usd} each`}. {comparison.capabilities.fundamentals_enabled ? "One public filing slot: captured NSE XBRL preferred, otherwise RBI." : "RBI: at most 1 free request."} Maximum 3 requests. No model calls.</p></div>}
      <button disabled={busy || comparison.capabilities?.recovery_read_only} className="mt-3 rounded bg-slate-900 px-3 py-2 text-white disabled:opacity-50" onClick={() => verify()}>{verification?.dispatch_pending ? "Retry queued verification" : "Verify reversal"}</button>
      {verification && ["completed", "failed"].includes(verification.status) && <button disabled={busy || comparison.capabilities?.recovery_read_only} className="ml-2 rounded border px-3 py-2" onClick={() => verify(true)}>Run a fresh check</button>}
      <span className="ml-2 text-xs text-slate-600">{external && comparison.capabilities?.external_enabled ? `Authorized cap $${budget}` : "Stored evidence only · $0 external spend"}{comparison.capabilities?.recovery_read_only ? " · recovery permits reads only" : comparison.capabilities?.recovery_stored_only ? " · stored-only recovery enabled" : ""}</span>
      {verification?.dispatch_pending && <p className="mt-2 text-xs">Delivery is pending. The enabled worker automatically recovers committed requests; explicit retry remains available.</p>}
      {verification && <div role="status" className="mt-3 rounded bg-slate-50 p-3"><strong>{verification.verdict?.replaceAll("_", " ") ?? verification.status}</strong><p className="text-xs">Checked {verification.result?.checked_at ?? "pending"}. Spent ${verification.spent_usd} · reserved ${verification.reserved_usd}</p>{verification.error && <p>{verification.error}</p>}<ul className="mt-2 list-disc pl-5 text-xs">{[...(verification.result?.findings ?? []), ...(verification.result?.limitations ?? [])].map((f, i) => <li key={i}>{f}</li>)}</ul>{verification.result?.claims.map(c => <div className="mt-1 text-xs" key={c.claim.id}>{c.state}: {c.claim.text}{c.observations?.map((o,i) => <p key={i}>{o.detail} Original availability: {o.available_at ?? "unknown"}.</p>)}</div>)}{verification.result?.sources?.map((source,i) => <p className="mt-1 text-xs" key={i}><a href={source.source_url} target="_blank" rel="noreferrer" className="underline">Source evidence</a> · observed {source.observed_at ?? "unknown"} · published {source.published_at ?? "unknown"} · available {source.available_at ?? "unknown"}</p>)}{["queued", "processing"].includes(verification.status) && <button disabled={busy || comparison.capabilities?.recovery_read_only} className="mt-2 underline" onClick={cancel}>Cancel verification</button>}</div>}
      {verification?.result?.sources?.filter(source => source.facts?.length).map((source,index) => <div className="mt-3 overflow-x-auto rounded border p-3 text-xs" key={`filing:${index}`}><h4 className="font-semibold">Structured filing evidence</h4><p>Entity mapping, concept semantics and original publication timing remain unverified. These facts do not certify the recommendation.</p><table className="mt-2 w-full text-left"><thead><tr><th>Reported concept</th><th>Value and unit</th><th>Period and scope</th></tr></thead><tbody>{source.facts?.slice(0,8).map((fact,i) => <tr key={i}><td title={fact.concept} className="p-1">{fact.concept.split("}").pop()}</td><td>{fact.value ?? "Unknown"} {fact.unit_measures.map(unit => unit.split("}").pop()).join(", ")}</td><td>{fact.instant ?? `${fact.period_start ?? "?"} → ${fact.period_end ?? "?"}`} {show(fact.dimensions)}</td></tr>)}</tbody></table><p>Showing up to 8 facts; the captured filing remains the source for detailed review.</p></div>)}
    </>}
  </section>;
}

"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { recommendationAuditApi, recommendationAuditEnabled } from "@/services/recommendationAudit";
import { RecommendationAuditEvidence, type RecommendationAuditEvidenceProps } from "@/components/RecommendationAuditEvidence";
import type { AuditComparison, AuditFormula, AuditVerification, AuditVerifyRequest } from "@/types/recommendationAudit";

type Props = Omit<RecommendationAuditEvidenceProps, "comparison" | "verification" | "children"> & {
  symbol: string; exchange: string; runIds?: number[]; formula?: AuditFormula;
};

export function RecommendationAuditPanel(props: Props) {
  const context = JSON.stringify([props.runId, [...(props.runIds ?? [])].sort((a, b) => a - b), props.technicalRunId, props.market, props.symbol, props.exchange, props.formula, props.currentUnits, props.currentFormulaUnits, props.currentScore, props.currentAction]);
  return <RecommendationAuditSession key={context} {...props} />;
}

function RecommendationAuditSession(props: Props) {
  const { runId, runIds, formula, technicalRunId, market, symbol, exchange } = props;
  const [comparison, setComparison] = useState<AuditComparison | null>(null);
  const [verification, setVerification] = useState<AuditVerification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [external, setExternal] = useState(false);
  const [budget, setBudget] = useState("0");
  const controller = useRef<AbortController | null>(null);
  const request = useRef<AuditVerifyRequest | null>(null);
  const latestBundle = useRef<string | undefined>(undefined);
  const acceptComparison = useCallback((next: AuditComparison) => {
    if (latestBundle.current !== next.bundle_hash) { request.current = null; setVerification(null); }
    latestBundle.current = next.bundle_hash;
    setComparison(next);
  }, []);

  useEffect(() => {
    if (!recommendationAuditEnabled || !runId) return;
    const abort = new AbortController(); controller.current = abort;
    recommendationAuditApi.comparison({ run_id: runId, market, symbol, exchange }, abort.signal)
      .then(next => { if (!abort.signal.aborted) acceptComparison(next); })
      .catch(error => { if (!abort.signal.aborted) setError(error instanceof Error ? error.message : String(error)); });
    return () => abort.abort();
  }, [acceptComparison, runId, market, symbol, exchange]);
  const verificationId = verification?.id, verificationStatus = verification?.status;
  useEffect(() => {
    if (!verificationId || !verificationStatus || !["queued", "processing"].includes(verificationStatus)) return;
    const abort = new AbortController(); let polls = 0; let timer: ReturnType<typeof setTimeout>;
    const checkedBundle = latestBundle.current;
    const poll = async () => {
      try {
        const next = await recommendationAuditApi.status(verificationId, abort.signal);
        if (abort.signal.aborted || latestBundle.current !== checkedBundle) return;
        setVerification(next);
        if (["queued", "processing"].includes(next.status) && ++polls < 60) timer = setTimeout(poll, 3000);
      } catch (error) { if (!abort.signal.aborted) setError(error instanceof Error ? error.message : String(error)); }
    };
    timer = setTimeout(poll, 3000);
    return () => { abort.abort(); clearTimeout(timer); };
  }, [verificationId, verificationStatus]);
  if (!recommendationAuditEnabled) return null;

  async function perform(action: (signal: AbortSignal | undefined) => Promise<void>) {
    const signal = controller.current?.signal;
    setBusy(true); setError(null);
    try { await action(signal); }
    catch (error) { if (!signal?.aborted) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (!signal?.aborted) setBusy(false); }
  }
  async function reload(signal?: AbortSignal) {
    if (!runId) return;
    const next = await recommendationAuditApi.comparison({ run_id: runId, market, symbol, exchange }, signal);
    if (!signal?.aborted) acceptComparison(next);
  }
  async function materialize() {
    if (!runId) return;
    await perform(async signal => { await recommendationAuditApi.materialize(runId, signal); if (!signal?.aborted) await reload(signal); });
  }
  async function capture() {
    if (!runId || !formula) return;
    await perform(async signal => { await recommendationAuditApi.capture(runIds?.length ? runIds : [runId], technicalRunId ?? null, formula, signal); if (!signal?.aborted) await reload(signal); });
  }
  async function cancel() {
    if (!verification) return;
    const id = verification.id;
    await perform(async signal => { const next = await recommendationAuditApi.cancel(id); if (!signal?.aborted) setVerification(next); });
  }
  async function verify(fresh = false) {
    if (!comparison?.current || !comparison.bundle_hash) return;
    const useExternal = external && comparison.capabilities?.external_enabled === true;
    if (useExternal && (!Number.isFinite(Number(budget)) || Number(budget) < 0 || Number(budget) > (comparison.capabilities?.daily_cap_usd ?? 0))) { setError("Enter a budget within the configured daily cap."); return; }
    const mode = useExternal ? "external_data" : "stored_only";
    if (fresh || request.current?.bundle_hash !== comparison.bundle_hash || request.current?.mode !== mode || request.current?.budget_usd !== (useExternal ? Number(budget) : 0)) request.current = null;
    request.current ??= { current_id: comparison.current.id, previous_id: comparison.previous?.id ?? null, bundle_hash: comparison.bundle_hash, policy_version: "reversal-evidence-v1", mode, idempotency_key: crypto.randomUUID(), budget_usd: useExternal ? Number(budget) : 0, ...(fresh ? { refresh_key: crypto.randomUUID() } : {}) };
    const body = request.current;
    await perform(async signal => { const next = await recommendationAuditApi.verify(body, signal); if (!signal?.aborted && latestBundle.current === body.bundle_hash) setVerification(next); });
  }
  const readOnly = comparison?.capabilities?.recovery_read_only ?? true;
  const useExternal = external && comparison?.capabilities?.external_enabled;
  return <section className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 [overflow-wrap:anywhere]" aria-label="Recommendation evidence comparison">
    <h3 className="text-lg font-semibold text-slate-950">Verify reversal</h3>
    <p className="mt-1 text-xs text-slate-600">Compare recorded recommendations, formula and sizing. The check seeks supporting and opposing evidence within its stated coverage.</p>
    {error && <p role="alert" className="mt-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">{error}</p>}
    {formula && <button type="button" disabled={busy || !runId || readOnly} className="my-3 rounded border border-slate-300 px-3 py-2 text-sm disabled:opacity-50" onClick={capture}>Capture current calculation</button>}
    {!comparison ? <p className="mt-2 text-sm">{error ? "Comparison unavailable." : !runId ? "Source run unavailable; verification cannot begin." : "Loading frozen comparison…"}</p> : <RecommendationAuditEvidence {...props} comparison={comparison} verification={verification}>
      {!comparison.current ? <button type="button" disabled={busy || !runId || readOnly} className="rounded border border-slate-300 px-3 py-2 text-sm disabled:opacity-50" onClick={materialize}>Capture legacy response as observed now</button> : <div className="min-w-0 space-y-2">
        {comparison.capabilities?.external_enabled && <div className="space-y-2 rounded border border-slate-200 p-3 text-sm"><label className="flex items-center gap-2"><input type="checkbox" checked={external} onChange={event => setExternal(event.target.checked)} /> Include independent API data</label>{external && <label className="block">Maximum spend USD <input aria-label="Verification spend cap in USD" type="number" min="0" max={comparison.capabilities.daily_cap_usd} step="0.01" value={budget} onChange={event => setBudget(event.target.value)} className="w-24 rounded border p-1" /></label>}<p>Daily cap USD {comparison.capabilities.daily_cap_usd}. At most two Kite requests and one public-source request. Unknown tariffs block paid requests. No model calls.</p></div>}
        <div className="flex flex-wrap gap-2"><button type="button" disabled={busy || readOnly} className="rounded bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50" onClick={() => verify()}>{verification?.dispatch_pending ? "Retry queued verification" : useExternal ? "Verify with independent API data" : "Verify stored evidence"}</button>
          {verification && ["completed", "failed"].includes(verification.status) && <button type="button" disabled={busy || readOnly} className="rounded border border-slate-300 px-3 py-2 text-sm disabled:opacity-50" onClick={() => verify(true)}>{useExternal ? "Run a fresh API check" : "Recheck stored evidence"}</button>}
          {verification && ["queued", "processing"].includes(verification.status) && <button type="button" disabled={busy || readOnly} className="rounded border border-slate-300 px-3 py-2 text-sm disabled:opacity-50" onClick={cancel}>Cancel verification</button>}
        </div>
        <p className="text-xs text-slate-600">{useExternal ? ["Authorized cap USD", budget].join(" ") : "Stored evidence only · $0 external spend. Rechecking does not fetch fresh market data."}{readOnly ? " · recovery permits reads only" : comparison.capabilities?.recovery_stored_only ? " · stored-only recovery enabled" : ""}</p>
        {verification?.dispatch_pending && <p className="text-xs text-amber-950">Delivery is pending. Retrying keeps the same request identity; it does not create a new paid check.</p>}
      </div>}
    </RecommendationAuditEvidence>}
  </section>;
}

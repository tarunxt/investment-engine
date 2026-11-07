"use client";
import { useEffect, useState } from 'react';
import type { AutoRebalancePortfolioKey, AutoRebalanceSpendReadiness } from '../../types/api';
import { readSpendRequest, spendStorageKey, type SpendChoice } from '../../lib/rebalanceSpendAuthorization';

export function RebalanceSpendConsent({ owner, market, load, onChoose, disabled = false }: {
  owner: number | null; market: AutoRebalancePortfolioKey;
  load: (market: AutoRebalancePortfolioKey) => Promise<AutoRebalanceSpendReadiness>;
  onChoose: (choice: SpendChoice | null) => void; disabled?: boolean;
}) {
  const [readiness, setReadiness] = useState<AutoRebalanceSpendReadiness | null>(null);
  const [error, setError] = useState('');
  const [selection, setSelection] = useState('');
  const [pending, setPending] = useState(false);
  const [observedRequestId, setObservedRequestId] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setReadiness(null); setSelection(''); setError('');
    if (!owner) { setError('Sign in to review workflow allowances.'); return; }
    try { const saved = readSpendRequest(localStorage, spendStorageKey(owner, market)); setPending(saved?.state === 'pending'); setObservedRequestId(saved?.authorization.spend_request_id); }
    catch { setError('Saved authorization cannot be read. No run can start.'); return; }
    void load(market).then(value => { if (active) setReadiness(value); }, () => { if (active) setError('Allowance readiness could not be verified. No run can start.'); });
    return () => { active = false; };
  }, [owner, market, load, refresh]);
  const unavailable = !readiness?.paid_execution_available;
  return <section aria-label={`${market === 'india' ? 'Zerodha' : 'INDmoney'} workflow allowance`} className="mt-3 space-y-2 rounded-xl border p-3 text-sm">
    <p>₹20 per complete {market === 'india' ? 'Zerodha' : 'INDmoney'} workflow. Retries and continuations share the original allowance. Both markets together: ₹40.</p>
    <p>A new allowance is only for a genuinely separate workflow. It does not renew a failed or interrupted run.</p>
    {error ? <p role="alert">{error}</p> : !readiness ? <p role="status">Checking allowance readiness…</p> : unavailable ? <p role="alert">{readiness.reason}</p> : null}
    <label>Workflow authorization <select aria-label="Workflow authorization" disabled={disabled || (unavailable && !pending)} value={selection} onChange={event => {
      const value = event.target.value; setSelection(value);
      const revision = readiness?.authorization_revision ?? -1;
      onChoose(value === 'new' ? { intent: 'new_workflow', observedRequestId, revision } : value === 'retry' ? { intent: 'retry_authorization', observedRequestId, revision } : value ? { intent: 'continue_workflow', scopeId: Number(value), observedRequestId, revision } : null);
    }}>
      <option value="">Choose explicitly before Run</option>
      {pending ? <option value="retry">Resolve pending start (same request ID; no renewed allowance)</option> : <>
        <option value="new">New separate workflow — authorize ₹20</option>
        {readiness?.scopes.map(scope => <option key={scope.id} value={scope.id}>Continue allowance #{scope.id} — ₹{scope.settled_inr} settled, ₹{scope.reserved_inr} reserved; {scope.status}</option>)}
      </>}
    </select></label>
    <button type="button" disabled={disabled} onClick={() => { onChoose(null); setRefresh(value => value + 1); }}>Refresh allowance readiness</button>
    <p>Reloads and navigation do not start stages. Resolve an uncertain start, review saved history, then Continue only the remaining stages.</p>
  </section>;
}

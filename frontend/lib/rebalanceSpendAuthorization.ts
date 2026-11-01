import type { AutoRebalancePortfolioKey, AutoRebalanceRunReservationResponse, AutoRebalanceSpendAuthorization } from '../types/api';

export type SpendChoice = ({ intent: 'new_workflow' } | { intent: 'continue_workflow'; scopeId: number } | { intent: 'retry_authorization' }) & { observedRequestId?: string; revision: number };
type SavedRequest = { authorization: AutoRebalanceSpendAuthorization; state: 'pending' | 'started'; scopeId?: number };
export function spendStorageKey(owner: number, market: AutoRebalancePortfolioKey) {
  if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error('Sign in before authorizing a workflow.');
  return `credx:rebalance-spend:v1:${owner}:${market}`;
}
export function readSpendRequest(storage: Storage, key: string): SavedRequest | null {
  const raw = storage.getItem(key);
  if (!raw) return null;
  const value = JSON.parse(raw) as SavedRequest;
  if (!['pending', 'started'].includes(value.state) || !value.authorization?.spend_request_id) {
    throw new Error('Saved workflow authorization is invalid. Review saved history before continuing.');
  }
  return value;
}

/** Web Lock protects tabs; durable pending UUID protects reload/network uncertainty.
 * A replay reconciles the allowance only. It never restarts the prior sequence.
 */
export async function authorizeAndClaimWorkflow({ owner, market, choice, reserve, analysisOnly = false, storage = window.localStorage, locks = navigator.locks }: {
  owner: number; market: AutoRebalancePortfolioKey; choice: SpendChoice;
  reserve: (authorization: AutoRebalanceSpendAuthorization) => Promise<AutoRebalanceRunReservationResponse>;
  storage?: Storage; locks?: LockManager; analysisOnly?: boolean;
}) {
  const key = spendStorageKey(owner, market);
  if (!locks) throw new Error('Safe workflow authorization requires browser Web Locks. No run was started.');
  return locks.request(key, async () => {
    const prior = readSpendRequest(storage, key);
    if (prior?.authorization.spend_request_id !== choice.observedRequestId) throw new Error('Workflow authorization changed in another tab. Refresh allowance readiness before choosing again.');
    let authorization: AutoRebalanceSpendAuthorization;
    if (choice.intent === 'retry_authorization') {
      if (!prior || prior.state !== 'pending') throw new Error('This start was already acknowledged. Review history and explicitly Continue its allowance.');
      authorization = prior.authorization;
    } else {
      if (prior?.state === 'pending') throw new Error('Resolve the pending authorization first. A retry must reuse its original request ID.');
      authorization = { spend_intent: choice.intent, spend_request_id: crypto.randomUUID(), spend_observed_revision: choice.revision,
        side_effect_policy: { version: 1, mode: analysisOnly ? "analysis_only" : "existing_preferences" },
        ...(choice.intent === 'continue_workflow' ? { spend_scope_id: choice.scopeId } : {}) };
    }
    // Storage failures abort BEFORE the server can grant or queue anything.
    storage.setItem(key, JSON.stringify({ authorization, state: 'pending' }));
    const result = await reserve(authorization);
    if (result.portfolio !== market || !Number.isSafeInteger(result.spend_scope_id) || result.spend_scope_id <= 0 || !Number.isSafeInteger(result.sequence) || result.sequence <= 0 || typeof result.reservation_created !== 'boolean') throw new Error('Authorization response could not be verified. Resolve this pending start before proceeding.');
    if (authorization.side_effect_policy && (result.side_effect_policy?.version !== authorization.side_effect_policy.version || result.side_effect_policy.mode !== authorization.side_effect_policy.mode)) throw new Error('The server did not confirm the frozen notification/export policy. No stages started; resolve the pending authorization.');
    storage.setItem(key, JSON.stringify({ authorization, state: 'started', scopeId: result.spend_scope_id }));
    if (choice.intent === 'retry_authorization' || !result.reservation_created) throw new Error(`Authorization recovered for allowance #${result.spend_scope_id}. No stages restarted. Review history, then explicitly Continue this allowance with remaining stages.`);
    return result;
  });
}

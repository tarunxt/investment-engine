'use client';
import { useEffect, useState } from 'react';
import { basketAttemptKey, UNCERTAIN_BASKET_MESSAGE, type BasketAttempt } from '@/lib/basketSubmissionSafety';

export function useBasketSubmissionSafety(owner: number | null) {
  const [version, setVersion] = useState(0);
  const [readyOwner, setReadyOwner] = useState<number | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  useEffect(() => {
    if (owner === null) return;
    const read = () => {
      try {
        const key = basketAttemptKey(owner), text = localStorage.getItem(key);
        if (text) {
          // Retain the lock while removing legacy trading details on hydration.
          try {
            const saved = JSON.parse(text);
            if (saved && typeof saved === 'object' && 'listings' in saved) {
              const minimal: BasketAttempt = {
                startedAt: typeof saved.startedAt === 'string' && Number.isFinite(Date.parse(saved.startedAt)) ? saved.startedAt : new Date().toISOString(),
                state: saved.state === 'in_flight' ? 'in_flight' : 'uncertain',
              };
              localStorage.setItem(key, JSON.stringify(minimal));
            }
          } catch { /* A malformed record still blocks submission. */ }
        }
        setReason(text ? UNCERTAIN_BASKET_MESSAGE : null);
      }
      catch { setReason('Order attempt storage is unavailable. Submission is blocked to preserve retry safety.'); }
      setReadyOwner(owner);
    };
    read();
    const changed = (event: StorageEvent) => { if (event.key === null || event.key === basketAttemptKey(owner)) read(); };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [owner, version]);
  const blockedReason = owner === null || readyOwner !== owner ? 'Loading order attempt safety state.' : reason;
  const begin = async () => {
    if (owner === null || readyOwner !== owner) throw new Error('Order attempt safety state is unavailable.');
    if (!navigator.locks) {
      setReason('Browser order attempt locking is unavailable. Submission is blocked.');
      throw new Error('Browser order attempt locking is unavailable. Submission is blocked.');
    }
    return navigator.locks.request(basketAttemptKey(owner), { ifAvailable: true }, lock => {
      try {
        if (!lock) throw new Error('Another tab is recording an order attempt.');
        if (localStorage.getItem(basketAttemptKey(owner))) throw new Error(UNCERTAIN_BASKET_MESSAGE);
        const attempt: BasketAttempt = { startedAt: new Date().toISOString(), state: 'in_flight' };
        localStorage.setItem(basketAttemptKey(owner), JSON.stringify(attempt));
        setReason(UNCERTAIN_BASKET_MESSAGE);
      } catch (error) { setReason(error instanceof Error ? error.message : UNCERTAIN_BASKET_MESSAGE); throw error; }
    });
  };
  const complete = () => {
    if (owner === null) return;
    localStorage.removeItem(basketAttemptKey(owner));
    setReason(null);setVersion(value => value + 1);
  };
  const uncertain = () => {
    if (owner === null) return;
    try {
      const text = localStorage.getItem(basketAttemptKey(owner));
      if (text) localStorage.setItem(basketAttemptKey(owner), JSON.stringify({ startedAt: JSON.parse(text).startedAt, state: 'uncertain' }));
    } catch { /* Preserve the existing lock even if its diagnostic update fails. */ }
    finally { setReason(UNCERTAIN_BASKET_MESSAGE); }
  };
  return { blockedReason, begin, complete, uncertain };
}

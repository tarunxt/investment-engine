'use client';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { emptyIexDisplaySession, readIexDisplaySession, subscribeIexDisplaySession, refreshBasketIexPrices } from '@/lib/alpacaIexDisplaySession';

import { captureWorkflowOwner, onWorkflowOwnerInvalidated } from '@/lib/workflowOwnerLifetime';

/** The clock ages cached source trades. It never refreshes provider data. */
export function useAlpacaIexDisplay(active = true, autoLoad = false) {
  const state = useSyncExternalStore(subscribeIexDisplaySession, readIexDisplaySession, emptyIexDisplaySession);
  const owner = useSyncExternalStore(onWorkflowOwnerInvalidated, captureWorkflowOwner, () => null);
  useEffect(() => {
    if (active && autoLoad && owner) void refreshBasketIexPrices();
  }, [active, autoLoad, owner]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const updateClock = () => setNow(Date.now());
    const clock = setInterval(updateClock, 1_000);
    window.addEventListener('focus', updateClock);
    document.addEventListener('visibilitychange', updateClock);
    return () => {
      clearInterval(clock);
      window.removeEventListener('focus', updateClock);
      document.removeEventListener('visibilitychange', updateClock);
    };
  }, [active]);
  return { ...state, now };
}

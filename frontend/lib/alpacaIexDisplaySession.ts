/** Owner-scoped, memory-only display data. No polling, persistence or execution inputs. */
import { apiService } from '@/services/api';
import { URLs } from '@/lib/urls';
import { parseIexDisplay, parseIexListings, type IexDisplayResult, type VerifiedIexListing } from './alpacaIexDisplay';
import { captureWorkflowOwner, isCurrentWorkflowOwner, onWorkflowOwnerInvalidated, type WorkflowOwner } from './workflowOwnerLifetime';

export type IexDisplayState = {
  listings: VerifiedIexListing[];
  listingsLoaded: boolean;
  result: IexDisplayResult | null;
  reason: string | null;
  error: string | null;
  loading: boolean;
};
const empty: IexDisplayState = Object.freeze({ listings: [], listingsLoaded: false, result: null, reason: null, error: null, loading: false });
let state = empty;
let owner: WorkflowOwner | null = null;
let request: AbortController | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
const update = (next: IexDisplayState) => { state = Object.freeze(next); emit(); };

onWorkflowOwnerInvalidated(() => {
  request?.abort();
  request = null;
  owner = null;
  state = empty;
  emit();
});

export function readIexDisplaySession() { return isCurrentWorkflowOwner(owner) ? state : empty; }
export function emptyIexDisplaySession() { return empty; }
export function subscribeIexDisplaySession(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function begin() {
  const captured = captureWorkflowOwner();
  if (!isCurrentWorkflowOwner(captured) || request) return null;
  owner = captured;
  const controller = new AbortController();
  request = controller;
  update({ ...state, loading: true, error: null, result: null });
  return {
    controller,
    current: () => request === controller && isCurrentWorkflowOwner(captured) && !controller.signal.aborted,
  };
}

// Reading and subscribing do not fetch. Both requests use the same owner guard.
export async function loadIexDisplayListings() {
  const pending = begin();
  if (!pending) return;
  update({ ...state, listings: [], listingsLoaded: false, reason: null });
  try {
    const value = await apiService.fetch<unknown>(URLs.indmoneyUs.displayListings(), { method: 'GET', cache: 'no-store', signal: pending.controller.signal });
    if (!pending.current()) return;
    const parsed = parseIexListings(value);
    parsed.listings.forEach(Object.freeze);
    Object.freeze(parsed.listings);
    update({ ...state, listings: parsed.listings, listingsLoaded: true, reason: parsed.reason });
  } catch {
    if (pending.current()) update({ ...state, error: 'Verified listings could not be loaded. No IEX estimates are available.' });
  } finally {
    if (pending.current()) { request = null; update({ ...state, loading: false }); }
  }
}

export async function loadIexDisplayEstimates() {
  const listings = readIexDisplaySession().listings;
  if (!listings.length || listings.length > 50) return;
  const pending = begin();
  if (!pending) return;
  try {
    const value = await apiService.fetch<unknown>(URLs.indmoneyUs.displayQuotes(listings.map(item => item.instrument)), { method: 'GET', cache: 'no-store', signal: pending.controller.signal });
    if (!pending.current()) return;
    const result = parseIexDisplay(value, listings, Date.now());
    result.quotes.forEach(Object.freeze);
    result.missing.forEach(Object.freeze);
    Object.freeze(result.quotes);
    Object.freeze(result.missing);
    update({ ...state, result: Object.freeze(result) });
  } catch {
    if (pending.current()) update({ ...state, error: 'IEX estimates could not be loaded or their source metadata was invalid. Previously displayed estimates have been cleared.' });
  } finally {
    if (pending.current()) { request = null; update({ ...state, loading: false }); }
  }
}

/** Fetch each verified instrument once per basket open, in one provider batch. */
export async function refreshBasketIexPrices() {
  const captured = captureWorkflowOwner();
  if (!isCurrentWorkflowOwner(captured) || request) return;
  if (!readIexDisplaySession().listings.length) await loadIexDisplayListings();
  if (isCurrentWorkflowOwner(captured) && readIexDisplaySession().listings.length) {
    await loadIexDisplayEstimates();
  }
}

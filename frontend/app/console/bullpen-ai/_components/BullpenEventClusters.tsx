"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { loadClusterOverrides, normalizeClusterId, parseClusterJson, type ClusterAssignment } from "@/lib/bullpen-event-clusters";
import publishedJson from "@/data/bullpen-event-clusters.json";

const publishedRows = parseClusterJson(JSON.stringify(publishedJson));
const publishedRevision = JSON.stringify(publishedRows);

export function useBullpenEventClusters() {
  const { user } = useAuth();
  const storageKey = user ? `bullpen-event-clusters-v2:${user.id}` : null;
  const [saved, setSaved] = useState<{ key: string; rows: ClusterAssignment[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!storageKey) return;
    const read = () => {
      try { setSaved({ key: storageKey, rows: loadClusterOverrides(publishedRows, localStorage.getItem(storageKey)) }); setError(null); }
      catch { setSaved({ key: storageKey, rows: publishedRows }); setError("Browser overrides could not be loaded. Showing the published cluster mapping."); }
    };
    const timer = window.setTimeout(read, 0);
    const sync = (event: StorageEvent) => { if (event.key === storageKey) read(); };
    window.addEventListener("storage", sync);
    return () => { window.clearTimeout(timer); window.removeEventListener("storage", sync); };
  }, [storageKey]);
  const rows = useMemo(() => saved?.key === storageKey ? saved?.rows ?? publishedRows : publishedRows, [saved, storageKey]);
  const clusters = useMemo(() => new Map(rows.map(row => [row.market_id, row.cluster_id])), [rows]);
  const save = (next: ClusterAssignment[]) => {
    if (!storageKey) throw new Error("Sign in before saving cluster assignments.");
    try { localStorage.setItem(storageKey, JSON.stringify({ revision: publishedRevision, rows: next })); }
    catch { throw new Error("Cluster IDs could not be saved in this browser. Check available browser storage and retry."); }
    setSaved({ key: storageKey, rows: next });
    setError(null);
  };
  const edit = (marketId: string, eventName: string, value: string) => {
    const next = rows.filter(row => row.market_id !== marketId);
    if (value.trim()) next.push({ ...rows.find(row => row.market_id === marketId), market_id: marketId, event_name: eventName, cluster_id: normalizeClusterId(value) });
    save(next);
  };
  return { rows, clusters, save, edit, error };
}

export function ClusterIdInput({ value, eventName, onSave }: { value: string; eventName: string; onSave: (value: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(value);
    setError(null);
    // Chrome can restore an old form value after React hydrates. When React state
    // already equals the published value, setState is a no-op and that stale DOM
    // value would remain visible even though the row has the correct cluster.
    if (input.current && document.activeElement !== input.current && input.current.value !== value) input.current.value = value;
  }, [value]);
  const commit = () => {
    try { const normalized = draft.trim() ? normalizeClusterId(draft) : ""; if (normalized !== value) onSave(normalized); setDraft(normalized); setError(null); }
    catch (reason) { setError((reason as Error).message); }
  };
  return <div><input ref={input} aria-label={`Cluster ID for ${eventName}`} aria-invalid={Boolean(error)} value={draft} placeholder={value || "—"} maxLength={7} autoComplete="off"
    className={`w-full rounded-md border bg-white px-2 py-1 text-xs font-bold uppercase text-sky-900 placeholder:text-sky-900 placeholder:opacity-100 focus:outline-none focus:ring-2 focus:ring-sky-400 ${error ? "border-red-500" : "border-slate-200"}`}
    onChange={event => setDraft(event.target.value)} onBlur={commit}
    onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { setDraft(value); setError(null); } }} />
    {error && <span role="alert" className="text-[10px] text-red-700">{error}</span>}</div>;
}

export function BullpenClusterJsonDialog({ rows, marketIds, onApply, onClose }: {
  rows: ClusterAssignment[]; marketIds: Set<string>; onApply: (rows: ClusterAssignment[]) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(() => JSON.stringify(rows, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  const apply = () => {
    try {
      const next = parseClusterJson(draft);
      onApply(next);
      setDraft(JSON.stringify(next, null, 2));
      const matched = next.filter(row => marketIds.has(row.market_id)).length;
      setStatus(`Applied ${matched} matching events. ${next.length - matched} entries are not in the currently loaded events. Saved in this browser.`);
      setError(null);
    } catch (reason) { setError((reason as Error).message); setStatus(null); }
  };
  return <dialog ref={dialog} aria-labelledby="cluster-json-title" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}
    className="m-auto max-h-[90vh] w-[min(44rem,95vw)] overflow-auto rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-2xl backdrop:bg-slate-950/55">
    <div className="flex items-center justify-between gap-3"><h2 id="cluster-json-title" className="text-lg font-bold">Add Cluster json</h2><div className="flex gap-2">
      <button type="button" aria-label="Refresh Cluster IDs" title="Apply edited JSON to the table" onClick={apply} className="rounded-lg border border-sky-200 p-2 text-sky-700 hover:bg-sky-50"><RefreshCw className="h-4 w-4" /></button>
      <button type="button" aria-label="Close Cluster JSON" onClick={onClose} className="rounded-lg border p-2"><X className="h-4 w-4" /></button>
    </div></div>
    <p className="my-3 text-sm text-slate-600">Paste the LLM cluster output below. Market ID identifies the event. Apply or refresh replaces the saved mapping; inline Cluster ID edits also appear here.</p>
    <p className="mb-3 text-xs text-slate-500">Published clusters load in every browser. Edits here apply only to this browser until the next published mapping update.</p>
    <p className="mb-3 text-xs text-slate-500">Cluster views include assigned events with valid Current Odds and Returns/day. Unassigned events remain in the default view.</p>
    <label htmlFor="cluster-json" className="text-xs font-semibold">Event name, market ID, Cluster ID and estimated claim date</label>
    <textarea id="cluster-json" autoFocus value={draft} onChange={event => { setDraft(event.target.value); setStatus(null); }} spellCheck={false}
      className="mt-2 h-72 w-full rounded-xl border border-slate-300 bg-slate-50 p-3 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-sky-400" />
    <p className="mt-2 text-xs text-slate-500">Example: {`[{"event_name":"Example event","market_id":"12345","cluster_id":"C01","claim_date":"2026-09-12T12:30:00Z"}]`}</p>
    {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    {status && <p role="status" className="mt-3 text-sm text-emerald-700">{status}</p>}
    <div className="mt-4 flex justify-end gap-2"><button type="button" onClick={onClose} className="rounded-lg border px-4 py-2 text-sm">Close</button><button type="button" onClick={apply} className="rounded-lg bg-sky-700 px-4 py-2 text-sm font-semibold text-white">Apply Cluster JSON</button></div>
  </dialog>;
}

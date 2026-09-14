"use client";

import { useEffect, useRef, useState } from "react";
import { FileSpreadsheet, Menu, X } from "lucide-react";
import type { BullpenScanSnapshot } from "@/lib/bullpen-ai";

function dateLabel(value: string) {
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "medium", timeZone: "Asia/Kolkata" }).format(new Date(value));
}

type UniversalScanSummary = {
  completedAt: string;
  durationMs: number;
  totalEvents: number;
  tables: Array<{
    key: string;
    title: string;
    description: string;
    rows: Array<{ label: string; count: number }>;
  }>;
};

type UniversalScanPageResponse = {
  error?: string;
  retryReason?: string;
  retryAfterMs?: number;
  scanExportId?: string;
  scanStartedAt?: string;
  cumulativeTotalCandidates?: number;
  nextCursor?: string;
};

function durationLabel(durationMs: number) {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", `${seconds}s`].filter(Boolean).join(" ");
}

async function fetchUniversalSnapshot(signal?: AbortSignal) {
  const response = await fetch("/api/bullpen-ai/stage-one-snapshot?universal=true", { cache: "no-store", signal });
  const body = await response.text();
  let payload: { snapshot?: BullpenScanSnapshot | null; universalSummary?: UniversalScanSummary | null; error?: string };
  try {
    payload = JSON.parse(body) as typeof payload;
  } catch {
    throw new Error(`Universal scan summary returned a non-JSON response (HTTP ${response.status}).`);
  }
  if (!response.ok) throw new Error(payload.error || "Could not load the universal scan.");
  return payload;
}

function waitForRetry(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(new DOMException("Stopped", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, milliseconds);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

async function scanResponseJson(response: Response): Promise<UniversalScanPageResponse> {
  const body = await response.text();
  try {
    return JSON.parse(body) as UniversalScanPageResponse;
  } catch {
    throw new Error(`Scan returned a non-JSON response (HTTP ${response.status}).`);
  }
}

export function UniversalPolymarketScan() {
  const [snapshot, setSnapshot] = useState<BullpenScanSnapshot | null>(null);
  const [summary, setSummary] = useState<UniversalScanSummary | null>(null);
  const [running, setRunning] = useState(false);
  const [count, setCount] = useState(0);
  const [pages, setPages] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [showSaved, setShowSaved] = useState(false);
  const controller = useRef<AbortController | null>(null);

  async function loadSnapshot(signal: AbortSignal) {
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      try {
        const payload = await fetchUniversalSnapshot(signal);
        setSnapshot(payload.snapshot ?? null);
        setSummary(payload.universalSummary ?? null);
        setError(null);
        return;
      } catch (snapshotError) {
        if (signal.aborted || attempt === 8) throw snapshotError;
        setError(`Scan saved. Finalizing breakdown tables (${attempt}/8)…`);
        await waitForRetry(Math.min(15_000, 2_000 * attempt), signal);
      }
    }
  }
  useEffect(() => {
    const abort = new AbortController();
    void fetchUniversalSnapshot(abort.signal).then(payload => {
      setSnapshot(payload.snapshot ?? null);
      setSummary(payload.universalSummary ?? null);
    }).catch(error => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setError(String(error.message));
    });
    return () => { abort.abort(); controller.current?.abort(); };
  }, []);

  async function scan() {
    if (controller.current) { controller.current.abort(); return; }
    const abort = new AbortController();
    controller.current = abort;
    setRunning(true); setError(null); setCount(0); setPages(0);
    const params = new URLSearchParams({ universal: "true" });
    let pageCount = 0;
    let consecutiveFailures = 0;
    const started = Date.now();
    try {
      while (true) {
        if (Date.now() - started > 45 * 60 * 1000) throw new Error("Scan reached its 45-minute limit. The last completed scan remains available.");
        let response: Response;
        let result: UniversalScanPageResponse;
        try {
          response = await fetch(`/api/bullpen-ai?${params}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: abort.signal });
          result = await scanResponseJson(response);
          if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : `Scan failed (HTTP ${response.status}).`);
          consecutiveFailures = 0;
        } catch (requestError) {
          if (abort.signal.aborted) throw requestError;
          consecutiveFailures += 1;
          if (consecutiveFailures > 8) throw requestError;
          const delay = Math.min(15_000, 1_500 * 2 ** (consecutiveFailures - 1));
          setError(`Temporary scan interruption. Retrying the current page (${consecutiveFailures}/8)…`);
          await waitForRetry(delay, abort.signal);
          continue;
        }
        if (result.retryReason) setError(result.retryReason);
        else { setError(null); pageCount += 1; setPages(pageCount); }
        if (result.scanExportId) params.set("scanExportId", result.scanExportId);
        if (result.scanStartedAt) params.set("scanStartedAt", result.scanStartedAt);
        if (typeof result.cumulativeTotalCandidates === "number") setCount(result.cumulativeTotalCandidates);
        if (response.status !== 202) break;
        if (result.nextCursor) params.set("scanCursor", result.nextCursor);
        await waitForRetry(typeof result.retryAfterMs === "number" ? result.retryAfterMs : 250, abort.signal);
      }
      await loadSnapshot(abort.signal);
    } catch (error) {
      setError(abort.signal.aborted ? "Scan stopped. Only completed scans are available to workflows." : error instanceof Error ? error.message : String(error));
    } finally { controller.current = null; setRunning(false); }
  }

  return (
    <section aria-label="Universal Polymarket Scan" className="rounded-3xl border border-emerald-200 bg-emerald-50 p-6 shadow-sm">
      <h2 className="text-xl font-semibold text-emerald-950">Universal Polymarket Scan</h2>
      <p className="mt-2 text-sm text-emerald-800">One Full Universe capture of Polymarket markets. Each workflow applies its own filters to this common scan.</p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" aria-pressed={!showSaved} onClick={() => setShowSaved(false)} className="rounded-lg bg-blue-700 px-3 py-2 text-sm font-semibold text-white">Original</button>
        <div className="inline-flex overflow-hidden rounded-lg bg-blue-600 text-white">
          <button type="button" onClick={() => void scan()} className="px-3 py-2 text-sm font-semibold">{running ? "Stop Scan" : "Scan Now"}</button>
          <button type="button" disabled={!snapshot} aria-label="Open latest saved Universal Polymarket Scan" onClick={() => setShowSaved(true)} className="border-l border-blue-400 px-2 disabled:opacity-40"><Menu className="h-4 w-4" /></button>
        </div>
      </div>
      {snapshot && <>
        <dl className="mt-5 grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-emerald-200 bg-white/80 p-4"><dt className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Last stage run</dt><dd className="mt-1 text-sm font-semibold text-emerald-950">{dateLabel(summary?.completedAt ?? snapshot.scannedAt)}</dd></div>
          <div className="rounded-xl border border-emerald-200 bg-white/80 p-4"><dt className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Time taken</dt><dd className="mt-1 text-sm font-semibold text-emerald-950">{summary ? durationLabel(summary.durationMs) : "Calculating…"}</dd></div>
          <div className="rounded-xl border border-emerald-200 bg-white/80 p-4"><dt className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Total Events Scanned</dt><dd className="mt-1 text-sm font-semibold text-emerald-950">{snapshot.totalCandidates.toLocaleString("en-IN")}</dd></div>
        </dl>
        <div className="mt-4 flex justify-end">
          <a href={`/api/bullpen-ai/stage-one.xlsx?exportId=${snapshot.scanExportId}&universal=true&scope=all-scanned`} className="inline-flex items-center gap-2 text-sm font-semibold text-emerald-800"><FileSpreadsheet className="h-4 w-4" />Download all scanned events</a>
        </div>
        {summary && <div className="mt-5 grid gap-4 lg:grid-cols-2">
          {summary.tables.map(table => <article key={table.key} className="overflow-hidden rounded-xl border border-emerald-200 bg-white/90">
            <div className="border-b border-emerald-100 px-4 py-3"><h3 className="font-semibold text-emerald-950">{table.title}</h3><p className="mt-0.5 text-xs text-emerald-700">{table.description}</p></div>
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead><tr className="bg-emerald-50 text-left text-xs uppercase tracking-wide text-emerald-700"><th className="px-4 py-2 font-semibold">Breakdown</th><th className="px-4 py-2 text-right font-semibold">Events</th><th className="px-4 py-2 text-right font-semibold">Share</th></tr></thead>
              <tbody className="divide-y divide-emerald-100">{table.rows.filter(row => row.count > 0).map(row => <tr key={row.label}><td className="px-4 py-2 text-slate-700">{row.label}</td><td className="px-4 py-2 text-right font-medium tabular-nums text-slate-900">{row.count.toLocaleString("en-IN")}</td><td className="px-4 py-2 text-right tabular-nums text-slate-500">{summary.totalEvents ? `${(row.count * 100 / summary.totalEvents).toFixed(1)}%` : "0.0%"}</td></tr>)}</tbody>
              <tfoot><tr className="bg-emerald-50 font-semibold text-emerald-950"><td className="px-4 py-2">Total</td><td className="px-4 py-2 text-right tabular-nums">{table.rows.reduce((total, row) => total + row.count, 0).toLocaleString("en-IN")}</td><td className="px-4 py-2 text-right">100%</td></tr></tfoot>
            </table></div>
          </article>)}
        </div>}
      </>}
      <p role="status" className="mt-4 text-sm font-semibold text-emerald-900">{running ? `${count.toLocaleString("en-IN")} events scanned · ${pages} pages` : snapshot ? "Latest Full Universe scan is complete." : "No completed universal scan yet. Select Scan Now to capture the Full Universe."}</p>
      {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
      {showSaved && snapshot && <div className="fixed inset-0 z-[140] flex items-center justify-center bg-slate-950/50 p-4">
        <div role="dialog" aria-modal="true" aria-label="Latest saved Universal Polymarket Scan" className="max-h-[80vh] w-full max-w-3xl overflow-auto rounded-2xl bg-white p-6">
          <div className="flex justify-between gap-4"><h3 className="font-semibold">Scan dated {dateLabel(snapshot.scannedAt)}</h3><button type="button" aria-label="Close saved scan" onClick={() => setShowSaved(false)}><X /></button></div>
          <p className="my-3 text-sm">{snapshot.totalCandidates.toLocaleString("en-IN")} events · {snapshot.pagesScanned} pages. Preview of up to 500 events; the Excel contains every captured row.</p>
          <ul className="divide-y">{snapshot.questions.map(q => <li key={q.id} className="py-2 text-sm">{q.question}</li>)}</ul>
        </div>
      </div>}
    </section>
  );
}

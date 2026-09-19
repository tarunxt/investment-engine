"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileSpreadsheet, Menu, X } from "lucide-react";
import type { BullpenScanSnapshot } from "@/lib/bullpen-ai";
import { UniversalScanAutoRunCard } from "./UniversalScanAutoRunCard";

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
  let payload: {
    snapshot?: BullpenScanSnapshot | null;
    universalSummary?: UniversalScanSummary | null;
    universalSummaryProgress?: { processedRows: number; totalRows: number } | null;
    error?: string;
  };
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

export function UniversalPolymarketScan() {
  const [snapshot, setSnapshot] = useState<BullpenScanSnapshot | null>(null);
  const [summary, setSummary] = useState<UniversalScanSummary | null>(null);
  const [summaryProgress, setSummaryProgress] = useState<{ processedRows: number; totalRows: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSaved, setShowSaved] = useState(false);
  const [autoRunRunning, setAutoRunRunning] = useState(false);
  const autoRunRefreshController = useRef<AbortController | null>(null);
  const lastAutoRunCompletion = useRef<string | null>(null);

  async function loadSnapshot(signal: AbortSignal) {
    for (let attempt = 1; attempt <= 64; attempt += 1) {
      try {
        const payload = await fetchUniversalSnapshot(signal);
        setSnapshot(payload.snapshot ?? null);
        setSummary(payload.universalSummary ?? null);
        setSummaryProgress(payload.universalSummaryProgress ?? null);
        setError(null);
        if (!payload.universalSummaryProgress) return;
        await waitForRetry(750, signal);
      } catch (snapshotError) {
        if (signal.aborted || attempt === 64) throw snapshotError;
        await waitForRetry(Math.min(10_000, 1_000 * attempt), signal);
      }
    }
  }

  const handleAutoRunStatus = useCallback((status: { running: boolean; last_completed_at: string | null }) => {
    setAutoRunRunning(status.running);
    if (!status.last_completed_at || status.last_completed_at === lastAutoRunCompletion.current) return;
    lastAutoRunCompletion.current = status.last_completed_at;
    autoRunRefreshController.current?.abort();
    const abort = new AbortController();
    autoRunRefreshController.current = abort;
    void loadSnapshot(abort.signal).catch(refreshError => {
      if (refreshError instanceof DOMException && refreshError.name === "AbortError") return;
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    }).finally(() => {
      if (autoRunRefreshController.current === abort) autoRunRefreshController.current = null;
    });
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    void loadSnapshot(abort.signal).catch(error => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setError(String(error.message));
    });
    return () => { abort.abort(); autoRunRefreshController.current?.abort(); };
  }, []);
  useEffect(() => {
    const interval = window.setInterval(() => {
      const abort = new AbortController();
      void fetchUniversalSnapshot(abort.signal).then(payload => {
        setSnapshot(payload.snapshot ?? null);
        setSummary(payload.universalSummary ?? null);
      }).catch(() => undefined);
    }, 60_000);
    return () => window.clearInterval(interval);
  }, []);

  async function queueScan() {
    if (running || autoRunRunning) return;
    setRunning(true);
    setError(null);
    try {
      const response = await fetch("/api/universal-polymarket-scan/auto-run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "run-now" }),
      });
      const payload = await response.json().catch(() => ({})) as {
        running?: boolean;
        last_completed_at?: string | null;
        error?: string;
        detail?: string;
      };
      if (!response.ok) {
        throw new Error(
          payload.error || payload.detail || `Could not queue Universal Scan (HTTP ${response.status}).`,
        );
      }
      handleAutoRunStatus({
        running: Boolean(payload.running),
        last_completed_at: payload.last_completed_at ?? null,
      });
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : String(scanError));
    } finally {
      setRunning(false);
    }
  }

  const scanActive = running || autoRunRunning;
  const sectionClass = scanActive
    ? "rounded-3xl border border-amber-200 bg-amber-50 p-6 shadow-sm"
    : "rounded-3xl border border-emerald-200 bg-emerald-50 p-6 shadow-sm";
  const headingClass = scanActive ? "text-xl font-semibold text-amber-950" : "text-xl font-semibold text-emerald-950";
  const tileClass = scanActive ? "rounded-xl border border-amber-200 bg-white/80 p-4" : "rounded-xl border border-emerald-200 bg-white/80 p-4";
  const labelClass = scanActive ? "text-xs font-semibold uppercase tracking-wide text-amber-700" : "text-xs font-semibold uppercase tracking-wide text-emerald-700";
  const valueClass = scanActive ? "mt-1 text-sm font-semibold text-amber-950" : "mt-1 text-sm font-semibold text-emerald-950";

  return (
    <section aria-label="Universal Polymarket Scan" className={sectionClass}>
      <h2 className={headingClass}>Universal Polymarket Scan</h2>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className={`inline-flex overflow-hidden rounded-lg text-white ${scanActive ? "bg-amber-600" : "bg-blue-600"}`}>
          <button type="button" disabled={scanActive} onClick={() => void queueScan()} className="px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60">{scanActive ? "Scan Running" : "Scan Now"}</button>
          <button type="button" disabled={!snapshot} aria-label="Open latest saved Universal Polymarket Scan" onClick={() => setShowSaved(true)} className={`border-l px-2 disabled:opacity-40 ${scanActive ? "border-amber-400" : "border-blue-400"}`}><Menu className="h-4 w-4" /></button>
        </div>
      </div>
      <UniversalScanAutoRunCard onStatusChange={handleAutoRunStatus} />
      {snapshot && <>
        <dl className="mt-5 grid gap-3 sm:grid-cols-3">
          <div className={tileClass}><dt className={labelClass}>Last Universal Scan</dt><dd className={`${valueClass} space-y-1`}><span className="block">Started: {dateLabel(snapshot.scannedAt)}</span><span className="block">Completed/Failed: {dateLabel(summary?.completedAt ?? snapshot.sourceScanCompletedAt ?? snapshot.scannedAt)}</span></dd></div>
          <div className={tileClass}><dt className={labelClass}>Time taken</dt><dd className={valueClass}>{summary ? durationLabel(summary.durationMs) : "Calculating…"}</dd></div>
          <div className={tileClass}><dt className={labelClass}>Total Events Scanned</dt><dd className={valueClass}>{snapshot.totalCandidates.toLocaleString("en-IN")}</dd></div>
        </dl>
        <div className="mt-4 flex justify-end">
          <a href={`/api/bullpen-ai/stage-one.xlsx?exportId=${snapshot.scanExportId}&universal=true&scope=all-scanned`} className={`inline-flex items-center gap-2 text-sm font-semibold ${scanActive ? "text-amber-800" : "text-emerald-800"}`}><FileSpreadsheet className="h-4 w-4" />Download all scanned events</a>
        </div>
        {summary && <div className="mt-5 grid gap-4 lg:grid-cols-2">
          {summary.tables.map(table => <article key={table.key} className={`overflow-hidden rounded-xl border bg-white/90 ${scanActive ? "border-amber-200" : "border-emerald-200"}`}>
            <div className={`border-b px-4 py-3 ${scanActive ? "border-amber-100" : "border-emerald-100"}`}><h3 className={`font-semibold ${scanActive ? "text-amber-950" : "text-emerald-950"}`}>{table.title}</h3><p className={`mt-0.5 text-xs ${scanActive ? "text-amber-700" : "text-emerald-700"}`}>{table.description}</p></div>
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead><tr className={`text-left text-xs uppercase tracking-wide ${scanActive ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"}`}><th className="px-4 py-2 font-semibold">Breakdown</th><th className="px-4 py-2 text-right font-semibold">Events</th><th className="px-4 py-2 text-right font-semibold">Share</th></tr></thead>
              <tbody className={`divide-y ${scanActive ? "divide-amber-100" : "divide-emerald-100"}`}>{table.rows.filter(row => row.count > 0).map(row => <tr key={row.label}><td className="px-4 py-2 text-slate-700">{row.label}</td><td className="px-4 py-2 text-right font-medium tabular-nums text-slate-900">{row.count.toLocaleString("en-IN")}</td><td className="px-4 py-2 text-right tabular-nums text-slate-500">{summary.totalEvents ? `${(row.count * 100 / summary.totalEvents).toFixed(1)}%` : "0.0%"}</td></tr>)}</tbody>
              <tfoot><tr className={`font-semibold ${scanActive ? "bg-amber-50 text-amber-950" : "bg-emerald-50 text-emerald-950"}`}><td className="px-4 py-2">Total</td><td className="px-4 py-2 text-right tabular-nums">{table.rows.reduce((total, row) => total + row.count, 0).toLocaleString("en-IN")}</td><td className="px-4 py-2 text-right">100%</td></tr></tfoot>
            </table></div>
          </article>)}
        </div>}
      </>}
      <p role="status" className={`mt-4 text-sm font-semibold ${scanActive ? "text-amber-900" : "text-emerald-900"}`}>{snapshot ? "Latest Full Universe scan is complete." : scanActive ? "Universal Scan is queued or running. Progress is shown below." : "No completed universal scan yet. Select Scan Now to queue the Full Universe worker."}</p>
      {summaryProgress && <p className="mt-2 text-sm text-slate-600">Saved scan details are available. Preparing breakdown tables: {summaryProgress.processedRows.toLocaleString("en-IN")} / {summaryProgress.totalRows.toLocaleString("en-IN")} rows.</p>}
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

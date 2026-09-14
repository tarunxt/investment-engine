"use client";

import { useEffect, useRef, useState } from "react";
import { FileSpreadsheet, Menu, X } from "lucide-react";
import type { BullpenScanSnapshot } from "@/lib/bullpen-ai";

function dateLabel(value: string) {
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "medium", timeZone: "Asia/Kolkata" }).format(new Date(value));
}

export function UniversalPolymarketScan() {
  const [snapshot, setSnapshot] = useState<BullpenScanSnapshot | null>(null);
  const [running, setRunning] = useState(false);
  const [count, setCount] = useState(0);
  const [pages, setPages] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [showSaved, setShowSaved] = useState(false);
  const controller = useRef<AbortController | null>(null);

  async function loadSnapshot() {
    const response = await fetch("/api/bullpen-ai/stage-one-snapshot?universal=true", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not load the universal scan.");
    setSnapshot(payload.snapshot ?? null);
  }
  useEffect(() => {
    void loadSnapshot().catch(error => setError(String(error.message)));
    return () => controller.current?.abort();
  }, []);

  async function scan() {
    if (controller.current) { controller.current.abort(); return; }
    const abort = new AbortController();
    controller.current = abort;
    setRunning(true); setError(null); setCount(0); setPages(0);
    const params = new URLSearchParams({ universal: "true" });
    let pageCount = 0;
    const started = Date.now();
    try {
      while (true) {
        if (Date.now() - started > 45 * 60 * 1000) throw new Error("Scan reached its 45-minute limit. The last completed scan remains available.");
        const response = await fetch(`/api/bullpen-ai?${params}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: abort.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `Scan failed (HTTP ${response.status}).`);
        if (result.retryReason) setError(result.retryReason);
        else { setError(null); pageCount += 1; setPages(pageCount); }
        if (result.scanExportId) params.set("scanExportId", result.scanExportId);
        if (result.scanStartedAt) params.set("scanStartedAt", result.scanStartedAt);
        if (typeof result.cumulativeTotalCandidates === "number") setCount(result.cumulativeTotalCandidates);
        if (response.status !== 202) break;
        if (result.nextCursor) params.set("scanCursor", result.nextCursor);
        await new Promise<void>((resolve, reject) => {
          const cancel = () => { clearTimeout(timer); reject(new DOMException("Stopped", "AbortError")); };
          const timer = setTimeout(() => { abort.signal.removeEventListener("abort", cancel); resolve(); }, result.retryAfterMs ?? 250);
          abort.signal.addEventListener("abort", cancel, { once: true });
        });
      }
      await loadSnapshot();
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
      {snapshot && <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => setShowSaved(true)} className="rounded-lg bg-emerald-600 px-4 py-2 text-left text-sm font-semibold text-white">Scan dated {dateLabel(snapshot.scannedAt)}<span className="block text-xs">{snapshot.totalCandidates.toLocaleString("en-IN")} markets · {snapshot.pagesScanned} pages · Complete</span></button>
        <a href={`/api/bullpen-ai/stage-one.xlsx?exportId=${snapshot.scanExportId}&universal=true&scope=all-scanned`} className="inline-flex items-center gap-2 text-sm font-semibold text-emerald-800"><FileSpreadsheet className="h-4 w-4" />Download all scanned events</a>
      </div>}
      <p role="status" className="mt-4 text-sm font-semibold text-emerald-900">{running ? `${count.toLocaleString("en-IN")} events scanned · ${pages} pages` : snapshot ? `Total Events Scanned: ${snapshot.totalCandidates.toLocaleString("en-IN")}` : "No completed universal scan yet. Select Scan Now to capture the Full Universe."}</p>
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

"use client";

import { useEffect, useState } from "react";
import { apiService } from "@/services/api";
import { URLs } from "@/lib/urls";
import { formatApiTimestamp } from "@/lib/datetime";

type Progress = {
  checked_at: string;
  job: { status: string; detail: string; updated_at?: string; stale: boolean };
  email: { status: string; error?: string | null; delivery_id?: number | null };
};
const labels: Record<string, string> = {
  not_reported: "No job start reported", collecting: "Collecting current events",
  researching: "Researching clusters and claim dates", validating: "Validating results",
  deploying: "Publishing / deploying", verifying: "Verifying production History",
  completed: "Job reported completion", blocked: "Blocked", failed: "Failed",
};
const time = (value?: string) => formatApiTimestamp(value, { emptyValue: "Not reported", timeZone: "Asia/Kolkata", timeZoneName: "short", second: "2-digit" });

export function BullpenClusteringProgress({ runId }: { runId: string | null }) {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!runId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    setProgress(null);
    const refresh = async () => {
      try {
        const result = await apiService.get<Progress>(URLs.bullpenAutoLive.clusteringProgress(runId), { cache: "no-store", timeoutMs: 10000 });
        if (!disposed) { setProgress(result); setError(null); }
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : "Job status could not be fetched");
      } finally {
        if (!disposed) timer = setTimeout(refresh, 15000);
      }
    };
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [runId]);
  return <section aria-label="Current clustering job status" aria-live="polite" className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm">
    <h4 className="font-bold text-slate-950">Current job status</h4>
    <p className="mt-1 font-semibold">{!runId ? "Waiting for scan identity" : error ? "Status unavailable" : progress ? labels[progress.job.status] ?? progress.job.status : "Checking job status…"}</p>
    {error && <p className="mt-2 text-red-800">{error} · Retrying automatically. Any last report below may be outdated.</p>}
    {progress && <>
      <p className="mt-2 break-words">{progress.job.detail}</p>
      {progress.job.stale && <p className="mt-2 font-semibold text-amber-900">No progress update for over 10 minutes. The job may be stalled; running status is unconfirmed.</p>}
      <dl className="mt-3 grid gap-1 text-xs">
        <div><dt className="inline font-semibold">Last job update: </dt><dd className="inline">{time(progress.job.updated_at)}</dd></div>
        <div><dt className="inline font-semibold">Stage 1 email: </dt><dd className="inline">{progress.email.status}{progress.email.error ? ` · ${progress.email.error}` : ""}</dd></div>
        <div><dt className="inline font-semibold">Status checked: </dt><dd className="inline">{time(progress.checked_at)}</dd></div>
      </dl>
    </>}
    <p className="mt-2 text-xs text-slate-600">Updates every 15 seconds while this popup is open. Published clustering time advances only when the matching results are deployed.</p>
  </section>;
}

// Authenticated browser handoff for the external job. No success timestamp or
// cluster mapping is modified by a progress report.
export function BullpenClusteringProgressHandoff() {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    const url = new URL(window.location.href);
    const status = url.searchParams.get("clusteringStatus");
    if (!status) return;
    const runId = url.searchParams.get("clusteringRun");
    const attempt = url.searchParams.get("clusteringAttempt");
    const sequence = url.searchParams.get("clusteringSequence");
    const detail = url.searchParams.get("clusteringDetail");
    if (!runId || !attempt || sequence == null || !detail) {
      setMessage("Clustering progress was not recorded: run, attempt, sequence and detail are required.");
      return;
    }
    void apiService.post(URLs.bullpenAutoLive.clusteringProgress(runId), {
      status, attempt_id: attempt, sequence: Number(sequence), detail,
    }).then(() => {
      for (const key of ["clusteringStatus", "clusteringRun", "clusteringAttempt", "clusteringSequence", "clusteringDetail"]) url.searchParams.delete(key);
      window.history.replaceState(window.history.state, "", url);
      setMessage(`Clustering progress recorded: ${status}`);
    }).catch(cause => setMessage(`Clustering progress was not recorded: ${cause instanceof Error ? cause.message : String(cause)}`));
  }, []);
  return message ? <p role="status" className="mb-3 rounded-xl border bg-white p-3 text-sm">{message}</p> : null;
}

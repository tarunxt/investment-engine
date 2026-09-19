"use client";

import { useCallback, useEffect, useState } from "react";
import { Clock3, History, Pause, Play, Power, RefreshCw, Square, X } from "lucide-react";

type HistoryItem = {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  triggered_by: "manual" | "scheduler";
  started_at: string | null;
  completed_at: string | null;
  total_events: number | null;
  error: string | null;
};

type AutoRunStatus = {
  enabled: boolean;
  running: boolean;
  paused: boolean;
  kill_requested: boolean;
  run_id: string | null;
  start_at: string;
  refresh_minutes: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_completed_at: string | null;
  last_completed_run_started_at: string | null;
  last_total_events: number | null;
  last_failed_at: string | null;
  last_error: string | null;
  progress_events: number;
  progress_pages: number;
  estimated_total_events: number | null;
  progress_message: string | null;
  history: HistoryItem[];
};

type AutoRunError = {
  message: string;
  details: string;
};

class AutoRunRequestError extends Error {
  constructor(
    message: string,
    public readonly details: string,
  ) {
    super(message);
    this.name = "AutoRunRequestError";
  }
}

const IST = "Asia/Kolkata";

function dateTime(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: IST,
  }).format(new Date(value));
}

function toIstInput(value: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    hourCycle: "h23", timeZone: IST,
  }).formatToParts(new Date(value));
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")}T${read("hour")}:${read("minute")}`;
}

function istInputToIso(value: string) {
  const [date, time] = value.split("T");
  if (!date || !time) return null;
  return new Date(`${date}T${time}:00+05:30`).toISOString();
}

async function requestStatus(body?: Record<string, unknown>) {
  const response = await fetch("/api/universal-polymarket-scan/auto-run", {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({})) as AutoRunStatus & {
    error?: string;
    detail?: string;
  };
  if (!response.ok) {
    const operation = typeof body?.action === "string" ? body.action : "load-status";
    const serverMessage = payload.detail || payload.error || "The server did not return an error message.";
    const recoverySteps = response.status === 401
      ? "Sign in again, then refresh this status card before retrying."
      : [502, 503, 504].includes(response.status)
        ? "The frontend could not reach a healthy backend. Verify the backend and reverse-proxy services, then retry after the status endpoint is healthy. If a run was submitted, check the worker and Redis queue before starting another run."
        : response.status === 409
          ? "Refresh the status first. If another run is active, pause or kill that run before starting a replacement."
          : "Refresh the status and retry once. If it fails again, inspect the backend response and the Universal Scan worker logs using the request details below.";
    throw new AutoRunRequestError(
      payload.error || payload.detail || "Universal Scan auto-run request failed.",
      `Operation: ${operation}\nHTTP: ${response.status} ${response.statusText || "Request failed"}\nServer response: ${serverMessage}\n\nHow to fix:\n${recoverySteps}`,
    );
  }
  return payload;
}

function normalizeAutoRunError(error: unknown): AutoRunError {
  if (error instanceof AutoRunRequestError) {
    return { message: error.message, details: error.details };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    message,
    details: `The browser could not complete the status request.\n\nHow to fix:\nCheck the network connection and backend availability, refresh this status card, and retry. If it fails again, inspect the Universal Scan API and worker logs.\n\nBrowser error: ${message}`,
  };
}

export function UniversalScanAutoRunCard({
  onStatusChange,
}: {
  onStatusChange?: (status: Pick<AutoRunStatus, "running" | "last_completed_at" | "last_completed_run_started_at" | "last_total_events">) => void;
}) {
  const [status, setStatus] = useState<AutoRunStatus | null>(null);
  const [startInput, setStartInput] = useState("");
  const [refreshMinutes, setRefreshMinutes] = useState(360);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<AutoRunError | null>(null);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showErrorDetails, setShowErrorDetails] = useState(false);

  const apply = useCallback((next: AutoRunStatus) => {
    setStatus(next);
    onStatusChange?.(next);
    setStartInput(toIstInput(next.start_at));
    setRefreshMinutes(next.refresh_minutes);
    setLastRefresh(new Date().toISOString());
    setError(null);
  }, [onStatusChange]);

  const load = useCallback(async () => {
    try { apply(await requestStatus()); }
    catch (loadError) { setError(normalizeAutoRunError(loadError)); }
  }, [apply]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => void load(), status?.running ? 2_000 : 60_000);
    return () => window.clearInterval(timer);
  }, [load, status?.running]);

  async function act(action: "run-now" | "enable" | "disable" | "pause" | "resume" | "kill") {
    const savesSchedule = action === "run-now" || action === "enable";
    const startAt = savesSchedule ? istInputToIso(startInput) : null;
    if (
      savesSchedule &&
      (!startAt || !Number.isInteger(refreshMinutes) || refreshMinutes < 1 || refreshMinutes > 10_080)
    ) {
      setError({
        message: "Select a valid schedule.",
        details: "Choose the intended IST date and time and a refresh duration from 1 to 10,080 minutes, then retry the action.",
      });
      return;
    }
    setBusy(action); setError(null);
    try {
      apply(await requestStatus({
        action,
        ...(savesSchedule ? { startAt, refreshMinutes } : {}),
      }));
    }
    catch (actionError) { setError(normalizeAutoRunError(actionError)); }
    finally { setBusy(null); }
  }

  const estimatedTotal = status?.estimated_total_events ?? 0;
  const progressPercent = status?.running && estimatedTotal > 0
    ? Math.min(99, Math.round(status.progress_events * 100 / estimatedTotal))
    : status?.running ? null : 0;

  async function saveSettings() {
    const startAt = istInputToIso(startInput);
    if (!startAt || !Number.isInteger(refreshMinutes) || refreshMinutes < 1 || refreshMinutes > 10_080) {
      setError({
        message: "Select a valid schedule.",
        details: "Choose the intended IST date and time and a refresh duration from 1 to 10,080 minutes, then retry the action.",
      });
      return;
    }
    setBusy("save"); setError(null);
    try { apply(await requestStatus({ action: "save", startAt, refreshMinutes })); }
    catch (saveError) { setError(normalizeAutoRunError(saveError)); }
    finally { setBusy(null); }
  }

  const autoRunEnabled = Boolean(status?.enabled || status?.running);

  return (
    <div className="mt-5 rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-fuchsia-50 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.2em] text-fuchsia-700">Auto Run Schedule</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setShowHistory(true)} className="inline-flex items-center gap-2 rounded-lg bg-amber-300 px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-900"><History className="h-4 w-4" />History</button>
          <button type="button" disabled={Boolean(busy) || status?.running} onClick={() => void act("run-now")} className="inline-flex items-center gap-2 rounded-lg border border-amber-400 bg-amber-100 px-4 py-2 text-xs font-bold uppercase tracking-wide text-amber-950 disabled:opacity-50"><Play className="h-4 w-4" />{status?.running ? "Running" : autoRunEnabled ? "Run Now" : "Start Auto Run Now"}</button>
          {status?.running && <button type="button" disabled={Boolean(busy) || status.kill_requested} onClick={() => void act(status.paused ? "resume" : "pause")} className="inline-flex items-center gap-2 rounded-lg border border-amber-400 bg-amber-50 px-4 py-2 text-xs font-bold uppercase tracking-wide text-amber-900 disabled:opacity-50">{status.paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}{status.paused ? "Resume" : "Pause"}</button>}
          {status?.running && <button type="button" disabled={Boolean(busy) || status.kill_requested} onClick={() => void act("kill")} className="inline-flex items-center gap-2 rounded-lg bg-red-700 px-4 py-2 text-xs font-bold uppercase tracking-wide text-white disabled:opacity-50"><Square className="h-4 w-4" />{status.kill_requested ? "Killing…" : "Kill"}</button>}
          <button type="button" disabled={Boolean(busy)} onClick={() => void act(autoRunEnabled ? "disable" : "enable")} className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-bold uppercase tracking-wide text-white disabled:opacity-50 ${autoRunEnabled ? "bg-red-700" : "bg-slate-950"}`}><Power className="h-4 w-4" />{autoRunEnabled ? "Disable Auto Run" : "Enable Auto Run"}</button>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
        <span title="This refresh only reloads saved schedule and run status. It does not start a market scan.">Status last checked {dateTime(lastRefresh)}</span>
        <button type="button" aria-label="Refresh auto-run status" title="Reload schedule and run status only" onClick={() => void load()}><RefreshCw className="h-3.5 w-3.5" /></button>
        <span>Refreshes status only; no scan is started.</span>
      </div>

      <div className="mt-4 grid gap-3 rounded-2xl bg-slate-50 p-3 md:grid-cols-2">
        <label className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">Auto-run start time (IST)
          <span className="mt-2 flex items-center rounded-xl border border-slate-200 bg-white px-3">
            <input type="datetime-local" value={startInput} onChange={event => setStartInput(event.target.value)} className="min-w-0 flex-1 bg-transparent py-2 text-sm text-slate-800 outline-none" />
            <Clock3 className="h-4 w-4 text-blue-600" />
          </span>
        </label>
        <label className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">Refresh duration
          <span className="mt-2 flex items-center rounded-xl border border-slate-200 bg-white px-3">
            <input type="number" min={1} max={10080} value={refreshMinutes} onChange={event => setRefreshMinutes(Number(event.target.value))} className="min-w-0 flex-1 bg-transparent py-2 text-sm text-slate-800 outline-none" />
            <span className="text-xs text-slate-500">min</span>
          </span>
        </label>
      </div>
      <div className="mt-2 flex justify-end">
        <button type="button" disabled={Boolean(busy)} onClick={() => void saveSettings()} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-bold uppercase tracking-wide text-slate-700 disabled:opacity-50">Save schedule</button>
      </div>

      {status?.running && <div className="mt-3 rounded-xl border border-amber-300 bg-amber-100 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm font-semibold text-amber-950">
          <span>{status.progress_events.toLocaleString("en-IN")} events scanned · {status.progress_pages.toLocaleString("en-IN")} pages</span>
          <span>{progressPercent === null ? "Scanning…" : `${progressPercent}%`}</span>
        </div>
        <div role="progressbar" aria-label="Universal Scan progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent ?? undefined} className="mt-3 h-2.5 overflow-hidden rounded-full bg-amber-200">
          <div className={`h-full rounded-full bg-amber-600 transition-all duration-500 ${progressPercent === null ? "w-1/3 animate-pulse" : ""}`} style={progressPercent === null ? undefined : { width: `${progressPercent}%` }} />
        </div>
        <p className="mt-2 text-xs text-amber-900">{status.progress_message || "Universal Scan is running."}</p>
      </div>}
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div className="rounded-xl border border-slate-100 bg-white p-4"><div className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">Next scheduled run</div><div className="mt-2 text-sm font-semibold text-slate-900">{dateTime(status?.next_run_at ?? null)}</div></div>
        <div className={`rounded-xl border p-4 ${status?.last_failed_at ? "border-red-200 bg-red-50" : "border-slate-100 bg-white"}`}><div className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">Last failed run</div><div className="mt-2 text-sm font-semibold text-slate-900">{dateTime(status?.last_failed_at ?? null)}</div><div className="mt-1 text-xs text-slate-600">{status?.last_error ?? "No failed Universal Scan auto-run."}</div></div>
      </div>
      {busy === "save" && <p className="mt-3 text-xs text-slate-500">Saving auto-run settings…</p>}
      {error && <div role="alert" className="mt-3"><button type="button" aria-haspopup="dialog" onClick={() => setShowErrorDetails(true)} className="block text-left text-sm font-semibold text-red-700 underline decoration-dotted underline-offset-4 hover:text-red-900">{error.message}</button></div>}

      {showErrorDetails && error && <div className="fixed inset-0 z-[170] flex items-center justify-center bg-slate-950/55 p-4">
        <div role="dialog" aria-modal="true" aria-label="Universal Scan auto-run error details" className="max-h-[80vh] w-full max-w-2xl overflow-auto rounded-2xl bg-white p-6 shadow-xl">
          <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[0.18em] text-red-700">Universal Scan error</p><h3 className="mt-1 text-lg font-semibold text-slate-950">{error.message}</h3></div><button type="button" aria-label="Close error details" onClick={() => setShowErrorDetails(false)}><X className="h-5 w-5" /></button></div>
          <pre className="mt-4 whitespace-pre-wrap rounded-xl bg-slate-950 p-4 text-xs leading-6 text-slate-100">{error.details}</pre>
          <div className="mt-4 flex justify-end"><button type="button" onClick={() => { setShowErrorDetails(false); void load(); }} className="rounded-lg bg-slate-950 px-4 py-2 text-xs font-bold uppercase tracking-wide text-white">Refresh status</button></div>
        </div>
      </div>}

      {showHistory && <div className="fixed inset-0 z-[160] flex items-center justify-center bg-slate-950/55 p-4">
        <div role="dialog" aria-modal="true" aria-label="Universal Scan auto-run history" className="max-h-[80vh] w-full max-w-3xl overflow-auto rounded-2xl bg-white p-6 shadow-xl">
          <div className="flex items-center justify-between"><h3 className="text-lg font-semibold text-slate-950">Universal Scan Auto-Run History</h3><button type="button" aria-label="Close history" onClick={() => setShowHistory(false)}><X className="h-5 w-5" /></button></div>
          <div className="mt-4 divide-y divide-slate-100">
            {status?.history.length ? status.history.map(item => <div key={item.id} className="grid gap-1 py-3 text-sm sm:grid-cols-[1fr_auto]">
              <div><span className="font-semibold capitalize text-slate-900">{item.status}</span> · {item.triggered_by}<div className="mt-1 text-xs text-slate-500">Started {dateTime(item.started_at)}</div>{item.error && <div className="mt-1 text-xs text-red-700">{item.error}</div>}</div>
              <div className="text-left text-xs text-slate-600 sm:text-right">{item.total_events === null ? "—" : `${item.total_events.toLocaleString("en-IN")} events`}<div className="mt-1">Finished {dateTime(item.completed_at)}</div></div>
            </div>) : <p className="py-8 text-center text-sm text-slate-500">No Universal Scan auto-runs yet.</p>}
          </div>
        </div>
      </div>}
    </div>
  );
}

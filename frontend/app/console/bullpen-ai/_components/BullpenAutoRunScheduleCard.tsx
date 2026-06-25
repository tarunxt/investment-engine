"use client";

import Link from "next/link";
import { useEffect, useEffectEvent, useState } from "react";
import {
  Activity,
  CalendarClock,
  CheckCircle2,
  Loader2,
  PlayCircle,
  ShieldAlert,
  Square,
  Zap,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatApiTimestamp } from "@/lib/datetime";
import { formatUnknownError, splitApiErrorSummary } from "@/lib/apiErrors";
import { URLs } from "@/lib/urls";
import { APIError, apiService } from "@/services/api";
import type { BullpenAutoLiveRun, BullpenAutoLiveSummaryResponse } from "@/types/api";

type BullpenAutoRunScheduleCardProps = {
  onRunCompleted?: () => void | Promise<void>;
  buildRunNowRequest?: () => Record<string, unknown> | null;
};

type ActionState = "enable" | "run-now" | "stop" | null;
type ErrorState = {
  message: string;
  details: string | null;
};

const CONSOLE_PROFILE_ID = "bullpen_console_top10";
const POLL_INTERVAL_MS = 4_000;
const RUN_TIMER_INTERVAL_MS = 1_000;
const AUTO_RUN_TIMINGS = [
  "6:00 AM IST",
  "12:00 PM IST",
  "6:00 PM IST",
  "12:00 AM IST",
];

function normalizeError(error: unknown) {
  if (error instanceof APIError) {
    const { statusText, message, details } = splitApiErrorSummary(error);
    return {
      message,
      details: [statusText, details].filter(Boolean).join(" • ") || null,
    } satisfies ErrorState;
  }

  return {
    message: formatUnknownError(error),
    details: null,
  } satisfies ErrorState;
}

function formatIstDateTime(value: string | null | undefined) {
  return formatApiTimestamp(value, {
    emptyValue: "—",
    timeZone: "Asia/Kolkata",
    timeZoneName: "short",
    second: undefined,
  });
}

function buildConsoleSettingsUpdate() {
  return {
    strategy_profile: "bullpen_console_top10" as const,
    auto_live_enabled: true,
    dry_run: false,
    allow_live_execution: true,
    require_manual_confirmation: false,
  };
}

function isConsoleProfileSelected(summary: BullpenAutoLiveSummaryResponse | null) {
  return summary?.settings.strategy_profile === CONSOLE_PROFILE_ID;
}

function isAutoRunActive(summary: BullpenAutoLiveSummaryResponse | null) {
  return Boolean(
    summary &&
      isConsoleProfileSelected(summary) &&
      summary.settings.auto_live_enabled &&
      summary.state.running &&
      !summary.state.paused,
  );
}

function statusLabel(summary: BullpenAutoLiveSummaryResponse | null) {
  if (!summary) return "Loading";
  if (!summary.settings.auto_live_enabled) return "Off";
  if (!isConsoleProfileSelected(summary)) return "Other profile active";
  if (summary.state.paused) return "Paused";
  if (summary.state.running) return "On";
  return "Ready";
}

function modeLabel(summary: BullpenAutoLiveSummaryResponse | null) {
  if (!summary) return "Checking";
  if (summary.state.mode === "live-trading") return "Live trading";
  if (summary.state.mode === "analysis-only") return "Analysis only";
  return "Dry run";
}

function formatElapsedRunTime(startedAt: string | null, nowMs: number) {
  if (!startedAt) return "0:00";

  const startedAtMs = Date.parse(startedAt);
  if (Number.isNaN(startedAtMs)) return "0:00";

  const elapsedSeconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;
  const paddedMinutes = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  const paddedSeconds = String(seconds).padStart(2, "0");

  return hours > 0
    ? `${hours}:${paddedMinutes}:${paddedSeconds}`
    : `${paddedMinutes}:${paddedSeconds}`;
}

function formatRunStatusLabel(status: BullpenAutoLiveRun["status"]) {
  if (status === "running") return "Running";
  if (status === "completed") return "Completed";
  if (status === "failed") return "Failed";
  return "Skipped";
}

function getVisibleRun(summary: BullpenAutoLiveSummaryResponse | null, pendingRunId: string | null) {
  if (!summary) return null;
  if (pendingRunId) {
    return (
      summary.recent_runs.find((run) => run.id === pendingRunId) ??
      (summary.latest_run?.id === pendingRunId ? summary.latest_run : null)
    );
  }
  if (summary.latest_run?.status === "running") return summary.latest_run;
  return summary.recent_runs.find((run) => run.status === "running") ?? null;
}

function getStageTone(status: BullpenAutoLiveRun["stage_results"][number]["status"]) {
  if (status === "pass") return "border-emerald-200 bg-emerald-50 text-emerald-900";
  if (status === "fail") return "border-rose-200 bg-rose-50 text-rose-900";
  if (status === "warning") return "border-amber-200 bg-amber-50 text-amber-900";
  return "border-slate-200 bg-white text-slate-700";
}

export function BullpenAutoRunScheduleCard({
  onRunCompleted,
  buildRunNowRequest,
}: BullpenAutoRunScheduleCardProps) {
  const [summary, setSummary] = useState<BullpenAutoLiveSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<ActionState>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);
  const [pendingRunId, setPendingRunId] = useState<string | null>(null);
  const [runNowStartedAt, setRunNowStartedAt] = useState<string | null>(null);
  const [timerNowMs, setTimerNowMs] = useState(() => Date.now());

  async function loadSummary(options?: { preserveLoading?: boolean }) {
    if (!options?.preserveLoading) {
      setLoading(true);
    }
    try {
      const nextSummary = await apiService.getBullpenAutoLiveSummary();
      setSummary(nextSummary);
      setError(null);
      return nextSummary;
    } catch (nextError) {
      setError(normalizeError(nextError));
      return null;
    } finally {
      if (!options?.preserveLoading) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadSummary();
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, []);

  const pollPendingRun = useEffectEvent(async () => {
    const nextSummary = await loadSummary({ preserveLoading: true });
    if (!nextSummary || !pendingRunId) {
      return;
    }

    const matchingRun =
      nextSummary.recent_runs.find((run) => run.id === pendingRunId) ??
      (nextSummary.latest_run?.id === pendingRunId ? nextSummary.latest_run : null);
    if (!matchingRun || matchingRun.status === "running") {
      return;
    }

    setPendingRunId(null);
    setRunNowStartedAt(null);
    setAction(null);
    setNotice(matchingRun.summary);
    if (onRunCompleted) {
      await onRunCompleted();
    }
  });

  useEffect(() => {
    if (!pendingRunId) return;

    const intervalId = window.setInterval(() => {
      void pollPendingRun();
    }, POLL_INTERVAL_MS);
    const timeoutId = window.setTimeout(() => {
      void pollPendingRun();
    }, 0);

    return () => {
      window.clearInterval(intervalId);
      window.clearTimeout(timeoutId);
    };
  }, [pendingRunId]);

  async function handleEnableAutoRuns() {
    setAction("enable");
    setNotice(null);
    setError(null);

    try {
      await apiService.updateBullpenAutoLiveSettings(buildConsoleSettingsUpdate());
      await apiService.startBullpenAutoLive();
      const nextSummary = await loadSummary({ preserveLoading: true });
      setNotice(
        nextSummary?.state.next_run_at
          ? `Auto runs enabled. Next scheduled run: ${formatIstDateTime(nextSummary.state.next_run_at)}.`
          : "Auto runs enabled.",
      );
    } catch (nextError) {
      setError(normalizeError(nextError));
    } finally {
      setAction(null);
    }
  }

  async function handleStopAutoRuns() {
    setAction("stop");
    setNotice(null);
    setError(null);

    try {
      await apiService.stopBullpenAutoLive();
      await loadSummary({ preserveLoading: true });
      setNotice("Auto runs stopped.");
    } catch (nextError) {
      setError(normalizeError(nextError));
    } finally {
      setAction(null);
    }
  }

  async function handleRunNow() {
    setAction("run-now");
    setRunNowStartedAt(new Date().toISOString());
    setTimerNowMs(Date.now());
    setNotice(null);
    setError(null);

    try {
      const runNowRequest = buildRunNowRequest?.() ?? undefined;
      await apiService.updateBullpenAutoLiveSettings(buildConsoleSettingsUpdate());
      const run = await apiService.runBullpenAutoLiveOnce(runNowRequest);
      setPendingRunId(run.id);
      setRunNowStartedAt(run.started_at ?? new Date().toISOString());
      setNotice(
        runNowRequest
          ? "Bullpen Scan + LLM + Invest flow queued with the current Bullpen x AI table rows. Waiting for completion..."
          : "Bullpen Scan + LLM + Invest flow queued. Waiting for completion...",
      );
      await loadSummary({ preserveLoading: true });
    } catch (nextError) {
      setError(normalizeError(nextError));
      setAction(null);
      setPendingRunId(null);
      setRunNowStartedAt(null);
    }
  }

  const autoRunActive = isAutoRunActive(summary);
  const consoleProfileSelected = isConsoleProfileSelected(summary);
  const mode = modeLabel(summary);
  const visibleRun = getVisibleRun(summary, pendingRunId);
  const visibleRunStages = visibleRun?.stage_results ?? [];
  const latestVisibleStage = visibleRunStages.at(-1);
  const visibleGuardrailChecks = visibleRun?.guardrail_checks ?? summary?.latest_guardrail_checks ?? [];
  const visibleGuardrailFailures = visibleGuardrailChecks.filter((check) => check.status === "fail").length;
  const runTimerStartedAt = visibleRun?.started_at ?? runNowStartedAt;
  const showRunTimer = action === "run-now" || pendingRunId !== null || visibleRun?.status === "running";
  const elapsedRunTime = formatElapsedRunTime(runTimerStartedAt, timerNowMs);

  useEffect(() => {
    if (!showRunTimer) return;

    const intervalId = window.setInterval(() => {
      setTimerNowMs(Date.now());
    }, RUN_TIMER_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [showRunTimer, runTimerStartedAt]);

  return (
    <Card className="border-fuchsia-200 bg-[linear-gradient(135deg,rgba(253,242,248,0.98),rgba(239,246,255,0.98))] shadow-sm">
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-white/80 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-fuchsia-700">
                Auto Run Schedule
              </span>
              <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700">
                Status: {statusLabel(summary)}
              </span>
              <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700">
                Mode: {mode}
              </span>
            </div>
            <div>
              <h2 className="text-xl font-semibold text-slate-950">
                Bullpen Scan + LLM + Invest runs every 6 hours in IST
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-700">
                Scheduled runs use the Bullpen console top-10 profile: scan upcoming
                markets, run LLM consensus, buy <span className="font-semibold">$5</span>{" "}
                of each new <span className="font-semibold">No</span>-side opportunity in
                the top 10 by returns/day, and exit active positions that fall out of
                that top 10 list.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {autoRunActive ? (
              <Button
                variant="outline"
                onClick={handleStopAutoRuns}
                disabled={action !== null}
              >
                {action === "stop" ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Stopping...
                  </>
                ) : (
                  <>
                    <Square className="mr-2 h-4 w-4" />
                    Stop Auto Runs
                  </>
                )}
              </Button>
            ) : (
              <Button onClick={handleEnableAutoRuns} disabled={action !== null}>
                {action === "enable" ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Enabling...
                  </>
                ) : (
                  <>
                    <PlayCircle className="mr-2 h-4 w-4" />
                    Enable Auto Runs
                  </>
                )}
              </Button>
            )}
            <div className="flex flex-col items-stretch gap-1">
              <Button
                variant="outline"
                onClick={handleRunNow}
                disabled={action !== null || pendingRunId !== null}
                className="border-sky-200 bg-sky-50 text-sky-900 hover:bg-sky-100"
              >
                {action === "run-now" || pendingRunId ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Running...
                  </>
                ) : (
                  <>
                    <Zap className="mr-2 h-4 w-4" />
                    Run Scans and Invest Now
                  </>
                )}
              </Button>
              {showRunTimer ? (
                <div className="text-center text-xs font-semibold tabular-nums text-sky-800" aria-live="polite">
                  {elapsedRunTime}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {AUTO_RUN_TIMINGS.map((timing) => (
            <span
              key={timing}
              className="rounded-full border border-fuchsia-200 bg-white px-3 py-1 text-sm font-medium text-slate-700"
            >
              {timing}
            </span>
          ))}
        </div>

        <div className="grid gap-3 lg:grid-cols-3">
          <div className="rounded-2xl border border-white/70 bg-white/80 p-4">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              <CalendarClock className="h-4 w-4" />
              Next scheduled run
            </div>
            <p className="mt-2 text-sm font-semibold text-slate-950">
              {formatIstDateTime(summary?.state.next_run_at)}
            </p>
            <p className="mt-1 text-xs text-slate-600">
              Fixed times: 6 AM, 12 PM, 6 PM, and 12 AM IST.
            </p>
          </div>

          <div className="rounded-2xl border border-white/70 bg-white/80 p-4">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Last completed run
            </div>
            <p className="mt-2 text-sm font-semibold text-slate-950">
              {formatIstDateTime(summary?.state.last_run_at)}
            </p>
            <p className="mt-1 text-xs text-slate-600">
              {summary?.latest_run?.summary || "No auto-run result yet."}
            </p>
          </div>

          <div className="rounded-2xl border border-white/70 bg-white/80 p-4">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Execution guardrails
            </div>
            <p className="mt-2 text-sm font-semibold text-slate-950">
              {consoleProfileSelected ? "Bullpen console top-10" : "Not active yet"}
            </p>
            <p className="mt-1 text-xs text-slate-600">
              Live orders still require Bullpen doctor, balance, and runtime safety
              checks to pass.
            </p>
          </div>
        </div>

        {!consoleProfileSelected && summary ? (
          <Alert className="border-amber-200 bg-amber-50 text-amber-950">
            <ShieldAlert className="h-4 w-4" />
            <AlertTitle>Another profile is currently selected</AlertTitle>
            <AlertDescription>
              Enabling this schedule will switch Auto-Live to the Bullpen console
              top-10 flow for this page.
            </AlertDescription>
          </Alert>
        ) : null}

        {summary && summary.state.mode !== "live-trading" ? (
          <Alert className="border-sky-200 bg-sky-50 text-sky-950">
            <ShieldAlert className="h-4 w-4" />
            <AlertTitle>Live execution is still gated</AlertTitle>
            <AlertDescription>
              Scheduled runs can still queue and analyze markets, but live orders only
              submit when the backend environment, Bullpen session unlock, and runtime
              health checks all allow trading. Review the full controls if you need to
              inspect the current gate.
            </AlertDescription>
          </Alert>
        ) : null}

        {visibleRun ? (
          <div className="rounded-2xl border border-sky-200 bg-white/85 p-4 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">
                  {visibleRun.status === "running" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Activity className="h-4 w-4" />
                  )}
                  Background execution monitor
                </div>
                <p className="mt-2 text-sm font-semibold text-slate-950">
                  {visibleRun.status === "running"
                    ? "Auto-Live worker is processing the queued scan, LLM, and invest flow."
                    : `Latest worker result: ${formatRunStatusLabel(visibleRun.status)}.`}
                </p>
                <p className="mt-1 text-xs text-slate-600">
                  Run {visibleRun.id} · started {formatIstDateTime(visibleRun.started_at)}
                </p>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center text-xs">
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                  <div className="font-semibold text-slate-950">{visibleRun.decisions_count}</div>
                  <div className="text-slate-500">Decisions</div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                  <div className="font-semibold text-slate-950">{visibleRun.orders_planned}</div>
                  <div className="text-slate-500">Orders planned</div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                  <div className="font-semibold text-slate-950">{visibleRun.orders_submitted}</div>
                  <div className="text-slate-500">Submitted</div>
                </div>
              </div>
            </div>

            <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_18rem]">
              <div className="space-y-2">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Worker stages
                </div>
                {visibleRunStages.length > 0 ? (
                  <div className="space-y-2">
                    {visibleRunStages.map((stage) => (
                      <div
                        key={`${visibleRun.id}-${stage.stage_number}-${stage.stage_name}`}
                        className={`rounded-xl border px-3 py-2 text-xs ${getStageTone(stage.status)}`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="font-semibold">
                            {stage.stage_number}. {stage.stage_name}
                          </span>
                          <span className="uppercase tracking-[0.14em]">{stage.status}</span>
                        </div>
                        <p className="mt-1 leading-5">{stage.reason}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                    Waiting for the worker to publish its first stage update. This panel refreshes every 4 seconds while the run is active.
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                <div className="flex items-center gap-2 font-semibold uppercase tracking-[0.18em] text-slate-500">
                  <CheckCircle2 className="h-4 w-4" />
                  Live health
                </div>
                <p className="mt-2">
                  Current stage: {latestVisibleStage?.stage_name ?? "Queue handoff"}
                </p>
                <p className="mt-1">
                  Guardrail checks: {visibleGuardrailChecks.length} total, {visibleGuardrailFailures} failing.
                </p>
                <p className="mt-1">
                  Live execution {visibleRun.live_execution_attempted ? "attempted" : "not attempted yet"}.
                </p>
                {visibleRun.error_message ? (
                  <p className="mt-2 font-semibold text-rose-700">{visibleRun.error_message}</p>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {notice ? (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
            {notice}
          </div>
        ) : null}

        {error ? (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
            <p className="font-medium">{error.message}</p>
            {error.details ? (
              <p className="mt-1 text-xs leading-5 text-rose-800">{error.details}</p>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-600">
          <span>
            Need deeper guardrail control? Open the dedicated Auto-Live dashboard for
            the same execution pipeline.
          </span>
          <Link
            href={URLs.routes.console.bullpenAiAutoLive()}
            className="font-semibold text-fuchsia-700 hover:text-fuchsia-900"
          >
            Open Auto-Live Controls
          </Link>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading auto-run status...
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

"use client";

import Link from "next/link";
import { useEffect, useEffectEvent, useState } from "react";
import {
  CalendarClock,
  Clock3,
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

import { buildBullpenAutoRunWorkflowView } from "./bullpenAutoRunProgress";

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

function formatStageElapsedTime(
  startedAt: string | null,
  completedAt: string | null,
  nowMs: number,
) {
  if (!startedAt) return "Not started";

  const startedAtMs = Date.parse(startedAt);
  if (Number.isNaN(startedAtMs)) return "Timer unavailable";

  const completedAtMs = completedAt ? Date.parse(completedAt) : null;
  const endMs = completedAtMs !== null && !Number.isNaN(completedAtMs) ? completedAtMs : nowMs;
  return formatElapsedRunTime(startedAt, Math.max(startedAtMs, endMs));
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

function getWorkflowToneClasses(tone: "yellow" | "green" | "blue") {
  if (tone === "yellow") {
    return {
      container: "border-amber-300 bg-amber-50/90",
      badge: "border-amber-300 bg-amber-100 text-amber-900",
      text: "text-amber-950",
      muted: "text-amber-900/80",
      progress: "bg-amber-500",
      progressTrack: "bg-amber-200/80",
    };
  }
  if (tone === "green") {
    return {
      container: "border-emerald-300 bg-emerald-50/90",
      badge: "border-emerald-300 bg-emerald-100 text-emerald-900",
      text: "text-emerald-950",
      muted: "text-emerald-900/80",
      progress: "bg-emerald-500",
      progressTrack: "bg-emerald-200/80",
    };
  }
  return {
    container: "border-sky-300 bg-sky-50/90",
    badge: "border-sky-300 bg-sky-100 text-sky-900",
    text: "text-sky-950",
    muted: "text-sky-900/80",
    progress: "bg-sky-500",
    progressTrack: "bg-sky-200/80",
  };
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

  const trackedRunId =
    pendingRunId ??
    (summary?.latest_run?.status === "running" ? summary.latest_run.id : null);

  const pollTrackedRun = useEffectEvent(async (runId: string) => {
    const nextSummary = await loadSummary({ preserveLoading: true });
    if (!nextSummary) {
      return;
    }

    const matchingRun =
      nextSummary.recent_runs.find((run) => run.id === runId) ??
      (nextSummary.latest_run?.id === runId ? nextSummary.latest_run : null);
    if (!matchingRun || matchingRun.status === "running") {
      return;
    }

    if (pendingRunId === runId) {
      setPendingRunId(null);
      setRunNowStartedAt(null);
      setAction(null);
      setNotice(matchingRun.summary);
      if (onRunCompleted) {
        await onRunCompleted();
      }
    }
  });

  useEffect(() => {
    if (!trackedRunId) return;

    const intervalId = window.setInterval(() => {
      void pollTrackedRun(trackedRunId);
    }, POLL_INTERVAL_MS);
    const timeoutId = window.setTimeout(() => {
      void pollTrackedRun(trackedRunId);
    }, 0);

    return () => {
      window.clearInterval(intervalId);
      window.clearTimeout(timeoutId);
    };
  }, [trackedRunId]);

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
  const latestRun = summary?.latest_run ?? null;
  const workflowRun =
    visibleRun ??
    (pendingRunId && latestRun?.id !== pendingRunId ? null : latestRun);
  const workflowView = buildBullpenAutoRunWorkflowView(workflowRun, pendingRunId);
  const runTimerStartedAt = visibleRun?.started_at ?? runNowStartedAt;
  const hasActiveWorkflowStage = workflowView.stages.some((stage) => stage.isCurrent);
  const showRunTimer = action === "run-now" || pendingRunId !== null || visibleRun?.status === "running";
  const shouldTickTimers = showRunTimer || hasActiveWorkflowStage;
  const elapsedRunTime = formatElapsedRunTime(runTimerStartedAt, timerNowMs);

  useEffect(() => {
    if (!shouldTickTimers) return;

    const intervalId = window.setInterval(() => {
      setTimerNowMs(Date.now());
    }, RUN_TIMER_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [shouldTickTimers, runTimerStartedAt]);

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

        <div className="rounded-3xl border border-slate-200/80 bg-white/70 p-4 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Background execution monitor
                </p>
                {workflowRun ? (
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold text-slate-700">
                    {formatRunStatusLabel(workflowRun.status)}
                  </span>
                ) : null}
              </div>
              <p className="text-sm font-semibold text-slate-950">
                {workflowView.statusCopy}
              </p>
              <p className="text-xs text-slate-600">
                {workflowRun
                  ? `Run ${workflowRun.id} · started ${formatIstDateTime(workflowRun.started_at)}`
                  : "The 3-stage monitor turns yellow while working, green when finished, and blue while queued."}
              </p>
              <p className="text-xs text-slate-500">
                Worker stages. This panel refreshes every 4 seconds while the run is active.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700">
                {workflowView.currentStageLabel}
              </span>
              {workflowRun ? (
                <>
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700">
                    {workflowRun.decisions_count} decisions
                  </span>
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700">
                    {workflowRun.orders_planned} planned
                  </span>
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700">
                    {workflowRun.orders_submitted} submitted
                  </span>
                </>
              ) : null}
            </div>
          </div>

          <div className="mt-4">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Worker stages
            </p>
          </div>

          <div className="mt-3 grid gap-3 lg:grid-cols-3">
            {workflowView.stages.map((stage) => {
              const toneClasses = getWorkflowToneClasses(stage.tone);

              return (
                <div
                  key={stage.key}
                  className={`rounded-2xl border p-4 shadow-sm transition ${toneClasses.container}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <p className={`text-sm font-semibold ${toneClasses.text}`}>
                        {stage.title}
                      </p>
                      <p className={`text-xs leading-5 ${toneClasses.muted}`}>
                        {stage.subtitle}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <span
                        className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] ${toneClasses.badge}`}
                      >
                        {stage.state === "current"
                          ? "Working"
                          : stage.state === "finished"
                            ? "Finished"
                            : "In Queue"}
                      </span>
                      <span
                        className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold tabular-nums ${toneClasses.badge}`}
                        aria-label={`${stage.title} timer`}
                      >
                        <Clock3 className="h-3 w-3" />
                        {formatStageElapsedTime(
                          stage.timerStartedAt,
                          stage.timerCompletedAt,
                          timerNowMs,
                        )}
                      </span>
                    </div>
                  </div>

                  <div className={`mt-4 h-2 overflow-hidden rounded-full ${toneClasses.progressTrack}`}>
                    <div
                      className={`h-full rounded-full ${toneClasses.progress}`}
                      style={{ width: `${stage.progressPercent}%` }}
                    />
                  </div>

                  <div className="mt-3 flex items-center justify-between gap-3">
                    <p className={`text-xs font-semibold ${toneClasses.text}`}>
                      {stage.progressLabel}
                    </p>
                    {stage.isCurrent ? (
                      <Loader2 className={`h-4 w-4 animate-spin ${toneClasses.text}`} />
                    ) : null}
                  </div>

                  <p className={`mt-2 text-xs leading-5 ${toneClasses.muted}`}>
                    {stage.detail}
                  </p>
                </div>
              );
            })}
          </div>
        </div>

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

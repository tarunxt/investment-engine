"use client";

import Link from "next/link";
import { useEffect, useEffectEvent, useState } from "react";
import {
  CalendarClock,
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
import { formatUnknownError } from "@/lib/apiErrors";
import { URLs } from "@/lib/urls";
import { APIError, apiService } from "@/services/api";
import type { BullpenAutoLiveSummaryResponse } from "@/types/api";

type BullpenAutoRunScheduleCardProps = {
  onRunCompleted?: () => void | Promise<void>;
};

type ActionState = "enable" | "run-now" | "stop" | null;

const CONSOLE_PROFILE_ID = "bullpen_console_top10";
const POLL_INTERVAL_MS = 4_000;
const AUTO_RUN_TIMINGS = [
  "6:00 AM IST",
  "12:00 PM IST",
  "6:00 PM IST",
  "12:00 AM IST",
];

function normalizeError(error: unknown) {
  if (error instanceof APIError) return error.message;
  return formatUnknownError(error);
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

export function BullpenAutoRunScheduleCard({
  onRunCompleted,
}: BullpenAutoRunScheduleCardProps) {
  const [summary, setSummary] = useState<BullpenAutoLiveSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<ActionState>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingRunId, setPendingRunId] = useState<string | null>(null);

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
    setNotice(null);
    setError(null);

    try {
      await apiService.updateBullpenAutoLiveSettings(buildConsoleSettingsUpdate());
      const run = await apiService.runBullpenAutoLiveOnce();
      setPendingRunId(run.id);
      setNotice("Bullpen Scan + LLM + Invest flow queued. Waiting for completion...");
      await loadSummary({ preserveLoading: true });
    } catch (nextError) {
      setError(normalizeError(nextError));
      setAction(null);
      setPendingRunId(null);
    }
  }

  const autoRunActive = isAutoRunActive(summary);
  const consoleProfileSelected = isConsoleProfileSelected(summary);
  const mode = modeLabel(summary);

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

        {notice ? (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
            {notice}
          </div>
        ) : null}

        {error ? (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
            {error}
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

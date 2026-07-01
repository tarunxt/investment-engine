"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Loader2,
  PauseCircle,
  PlayCircle,
  RefreshCcw,
  Settings2,
  ShieldAlert,
  Square,
  Zap,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatUnknownError } from "@/lib/apiErrors";
import { URLs } from "@/lib/urls";
import { cn } from "@/lib/utils";
import { APIError, apiService } from "@/services/api";
import type {
  BullpenAutoLiveSettings,
  BullpenAutoLiveState,
  BullpenAutoLiveGuardrailCheck,
  BullpenAutoLiveSummaryResponse,
} from "@/types/api";

import { BullpenAiAutoLiveDecisionsPanel } from "./BullpenAiAutoLiveDecisionsPanel";
import { deriveBullpenAiAutoLiveRunControlState } from "./bullpenAiAutoLiveConsoleState";
import { BullpenAiAutoLiveRiskGuardrailsDrawer } from "./BullpenAiAutoLiveRiskGuardrailsDrawer";
import { BULLPEN_AI_AUTO_LIVE_SAFE_DEFAULTS } from "./bullpenAiAutoLiveRiskGuardrails";

type ActionKey = "run-once" | "start" | "pause" | "resume" | "stop";
type EmergencyActionKey = "activate" | "clear";
type DashboardRequestResult = {
  summary: BullpenAutoLiveSummaryResponse | null;
  issues: string[];
  hasSettings: boolean;
};
const AUTO_LIVE_TOP_WARNING =
  "Live trading can lose money. This bot only executes when Auto-Live, live environment permission, Bullpen doctor, balance checks, and all guardrails pass. Keep Dry Run enabled until tested.";

const AUTO_LIVE_STRATEGY_SUMMARY =
  "Runs the separate auto-live execution pipeline that scans markets, evaluates evidence, applies portfolio guardrails, and only submits live limit orders when every hard block passes.";
const AUTO_LIVE_RISK_SUMMARY =
  "Live execution stays gated until runtime health, evidence quality, disagreement checks, and portfolio risk controls are all green.";
const EMPTY_AUTO_LIVE_STATE: BullpenAutoLiveState = {
  running: false,
  paused: false,
  dry_run: true,
  live_armed: false,
  live_execution_allowed: false,
  emergency_stopped: false,
  status: "not-configured",
  mode: "dry-run",
  server_now: null,
  started_at: null,
  stopped_at: null,
  last_run_at: null,
  last_execution_at: null,
  next_run_at: null,
  last_scan_at: null,
  last_llm_run_at: null,
  last_rebalance_at: null,
  next_scan_at: null,
  next_llm_run_at: null,
  next_rebalance_at: null,
  last_error: null,
  last_action: null,
  last_run_id: null,
  latest_guardrail_checks: [],
  invested_usd: 0,
  current_value_usd: 0,
  pnl_usd: 0,
  active_positions: 0,
  trades_today: 0,
  consecutive_failed_orders: 0,
  today_executed_orders: 0,
  today_skipped_orders: 0,
  doctor_status: "watch",
  balance_status: "watch",
};

function normalizeError(error: unknown) {
  if (error instanceof APIError) return error.message;
  return formatUnknownError(error);
}

function formatMoney(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function labelize(value: string) {
  return value.replace(/[_-]/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatDashboardIssue(label: string, error: unknown) {
  return `${label}: ${normalizeError(error)}`;
}

function mapGuardrailTone(
  status: BullpenAutoLiveGuardrailCheck["status"],
): "positive" | "warning" | "critical" {
  if (status === "pass") return "positive";
  if (status === "fail") return "critical";
  return "warning";
}

function inferModeFromSettings(
  settings?: BullpenAutoLiveSettings | null,
): BullpenAutoLiveState["mode"] {
  if (!settings) return "dry-run";
  if (settings.dry_run) return "dry-run";
  if (settings.allow_live_execution) return "live-trading";
  return "analysis-only";
}

function buildFallbackState(
  state?: BullpenAutoLiveState | null,
  settings?: BullpenAutoLiveSettings | null,
): BullpenAutoLiveState {
  if (state) {
    return state;
  }

  return {
    ...EMPTY_AUTO_LIVE_STATE,
    dry_run: settings?.dry_run ?? EMPTY_AUTO_LIVE_STATE.dry_run,
    live_execution_allowed:
      settings?.allow_live_execution ??
      EMPTY_AUTO_LIVE_STATE.live_execution_allowed,
    emergency_stopped:
      settings?.emergency_stop ?? EMPTY_AUTO_LIVE_STATE.emergency_stopped,
    mode: inferModeFromSettings(settings),
  };
}

function buildFallbackBotCard(
  state: BullpenAutoLiveState,
  checks: BullpenAutoLiveGuardrailCheck[],
): BullpenAutoLiveSummaryResponse["bot_card"] {
  const guardrails = checks.slice(0, 6).map((check) => ({
    label: check.label,
    value: check.value || labelize(check.status),
    tone: mapGuardrailTone(check.status),
  }));
  const returnPct =
    state.invested_usd > 0
      ? Number(((state.pnl_usd / state.invested_usd) * 100).toFixed(2))
      : null;

  return {
    id: "bullpen-ai-auto-live",
    name: "Bullpen AI Auto-Live",
    route: URLs.routes.console.bullpenAiAutoLive(),
    status: state.status,
    mode: state.mode,
    invested_usd: state.invested_usd || null,
    current_value_usd: state.current_value_usd || null,
    pnl_usd: state.pnl_usd || null,
    return_pct: returnPct,
    active_positions: state.active_positions || null,
    trades_today: state.trades_today || null,
    last_run_at: state.last_run_at,
    next_run_at: state.next_run_at,
    guardrails_summary:
      guardrails.length > 0
        ? guardrails
            .slice(0, 4)
            .map((guardrail) => `${guardrail.label}: ${guardrail.value}`)
            .join(" • ")
        : "Runtime guardrails will appear here once the auto-live service reports them.",
    strategy_summary: AUTO_LIVE_STRATEGY_SUMMARY,
    risk_summary: state.last_error || AUTO_LIVE_RISK_SUMMARY,
    guardrails,
  };
}

function buildPartialSummary(
  state?: BullpenAutoLiveState | null,
  settings?: BullpenAutoLiveSettings | null,
): BullpenAutoLiveSummaryResponse {
  const resolvedState = buildFallbackState(state, settings);
  const latestGuardrailChecks = resolvedState.latest_guardrail_checks ?? [];

  return {
    state: resolvedState,
    settings: settings ?? BULLPEN_AI_AUTO_LIVE_SAFE_DEFAULTS,
    bot_card: buildFallbackBotCard(resolvedState, latestGuardrailChecks),
    latest_run: null,
    recent_runs: [],
    recent_decisions: [],
    latest_guardrail_checks: latestGuardrailChecks,
  };
}

function getGuardrailClass(status: string) {
  switch (status) {
    case "pass":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "fail":
      return "border-rose-200 bg-rose-50 text-rose-700";
    case "warning":
    case "watch":
      return "border-amber-200 bg-amber-50 text-amber-800";
    default:
      return "border-slate-200 bg-slate-100 text-slate-700";
  }
}

function getModeClass(mode: string) {
  switch (mode) {
    case "live-trading":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "analysis-only":
      return "border-sky-200 bg-sky-50 text-sky-700";
    case "dry-run":
    default:
      return "border-slate-200 bg-slate-100 text-slate-700";
  }
}

function MetricCard({
  eyebrow,
  title,
  value,
  detail,
}: {
  eyebrow: string;
  title: string;
  value: string;
  detail: string;
}) {
  return (
    <Card className="border-slate-200 bg-white/90 shadow-sm">
      <CardHeader className="pb-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">
          {eyebrow}
        </p>
        <CardTitle className="text-base text-slate-950">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tracking-tight text-slate-950">
          {value}
        </div>
        <p className="mt-2 text-sm leading-6 text-slate-600">{detail}</p>
      </CardContent>
    </Card>
  );
}

function GuardrailPill({ check }: { check: BullpenAutoLiveGuardrailCheck }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-950">{check.label}</p>
          <p className="mt-1 text-sm leading-6 text-slate-600">{check.detail}</p>
        </div>
        <span
          className={cn(
            "rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]",
            getGuardrailClass(check.status),
          )}
        >
          {check.status}
        </span>
      </div>
      {check.value ? (
        <p className="mt-3 text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
          Value: {check.value}
        </p>
      ) : null}
    </div>
  );
}

async function requestDashboard(): Promise<DashboardRequestResult> {
  const issues: string[] = [];
  const [summaryResult, runsResult, decisionsResult] = await Promise.allSettled([
    apiService.getBullpenAutoLiveSummary(),
    apiService.getBullpenAutoLiveRuns(),
    apiService.getBullpenAutoLiveDecisions(),
  ]);
  let summary =
    summaryResult.status === "fulfilled" ? summaryResult.value : null;
  let hasSettings = summaryResult.status === "fulfilled";

  if (summaryResult.status === "rejected") {
    issues.push(formatDashboardIssue("Summary", summaryResult.reason));
  }
  if (runsResult.status === "rejected") {
    issues.push(formatDashboardIssue("Runs", runsResult.reason));
  }
  if (decisionsResult.status === "rejected") {
    issues.push(formatDashboardIssue("Decisions", decisionsResult.reason));
  }

  if (!summary) {
    const [stateResult, settingsResult] = await Promise.allSettled([
      apiService.getBullpenAutoLiveState(),
      apiService.getBullpenAutoLiveSettings(),
    ]);
    const state = stateResult.status === "fulfilled" ? stateResult.value : null;
    const settings =
      settingsResult.status === "fulfilled" ? settingsResult.value : null;

    if (stateResult.status === "rejected") {
      issues.push(formatDashboardIssue("State", stateResult.reason));
    }
    if (settingsResult.status === "rejected") {
      issues.push(formatDashboardIssue("Settings", settingsResult.reason));
    }

    hasSettings = settings != null;

    if (state || settings) {
      summary = buildPartialSummary(state, settings);
    }
  }

  if (!summary) {
    return {
      summary: null,
      issues,
      hasSettings,
    };
  }

  const recentRuns =
    runsResult.status === "fulfilled" ? runsResult.value : summary.recent_runs;
  const recentDecisions =
    decisionsResult.status === "fulfilled"
      ? decisionsResult.value
      : summary.recent_decisions;
  const latestGuardrails =
    summary.latest_guardrail_checks.length > 0
      ? summary.latest_guardrail_checks
      : summary.state.latest_guardrail_checks;

  return {
    summary: {
      ...summary,
      latest_run: summary.latest_run ?? recentRuns[0] ?? null,
      recent_runs: recentRuns,
      recent_decisions: recentDecisions,
      latest_guardrail_checks: latestGuardrails,
    },
    issues,
    hasSettings,
  };
}

export function BullpenAiAutoLiveConsole() {
  const [summary, setSummary] = useState<BullpenAutoLiveSummaryResponse | null>(null);
  const [settingsAvailable, setSettingsAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<ActionKey | null>(null);
  const [emergencyBusy, setEmergencyBusy] = useState<EmergencyActionKey | null>(null);
  const [guardrailsDrawerOpen, setGuardrailsDrawerOpen] = useState(false);

  async function reloadDashboard() {
    setRefreshing(true);
    try {
      const result = await requestDashboard();
      if (result.summary) {
        setSummary(result.summary);
      }
      setSettingsAvailable(result.hasSettings);
      setError(
        result.issues.length > 0
          ? result.issues.join(" • ")
          : result.summary
            ? null
            : "No Bullpen AI Auto-Live data is available yet.",
      );
      return result.summary;
    } catch (nextError) {
      setError(normalizeError(nextError));
      return null;
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function loadInitialDashboard() {
      setLoading(true);
      try {
        const result = await requestDashboard();
        if (cancelled) return;
        setSummary(result.summary);
        setSettingsAvailable(result.hasSettings);
        setError(
          result.issues.length > 0
            ? result.issues.join(" • ")
            : result.summary
              ? null
              : "No Bullpen AI Auto-Live data is available yet.",
        );
      } catch (nextError) {
        if (cancelled) return;
        setError(normalizeError(nextError));
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadInitialDashboard();

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleAction(action: ActionKey) {
    setActionBusy(action);
    try {
      if (action === "run-once") {
        await apiService.runBullpenAutoLiveOnce();
      } else if (action === "start") {
        await apiService.startBullpenAutoLive();
      } else if (action === "pause") {
        await apiService.pauseBullpenAutoLive();
      } else if (action === "resume") {
        await apiService.resumeBullpenAutoLive();
      } else if (action === "stop") {
        await apiService.stopBullpenAutoLive();
      }

      await reloadDashboard();
    } catch (nextError) {
      setError(normalizeError(nextError));
    } finally {
      setActionBusy(null);
    }
  }

  async function handleEmergencyStopToggle(emergencyStopped: boolean) {
    setEmergencyBusy(emergencyStopped ? "clear" : "activate");
    try {
      if (emergencyStopped) {
        await apiService.clearEmergencyStopBullpenAutoLive();
      } else {
        await apiService.emergencyStopBullpenAutoLive();
      }

      await reloadDashboard();
    } catch (nextError) {
      setError(normalizeError(nextError));
    } finally {
      setEmergencyBusy(null);
    }
  }

  if (loading && !summary) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center bg-[radial-gradient(circle_at_top,_rgba(251,191,36,0.10),_transparent_35%),linear-gradient(180deg,_#f8fafc_0%,_#eef2ff_100%)] px-6 dark:bg-[radial-gradient(circle_at_top,_rgba(245,158,11,0.08),_transparent_24%),linear-gradient(180deg,_rgba(15,23,42,0.96)_0%,_rgba(2,6,23,1)_100%)]">
        <div className="flex items-center gap-3 rounded-full border border-slate-200 bg-white px-5 py-3 text-sm text-slate-600 shadow-sm dark:border-slate-700/80 dark:bg-slate-950/85 dark:text-slate-300">
          <Loader2 className="size-4 animate-spin" />
          Loading Bullpen AI Auto-Live state...
        </div>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center bg-[radial-gradient(circle_at_top,_rgba(251,191,36,0.10),_transparent_35%),linear-gradient(180deg,_#f8fafc_0%,_#eef2ff_100%)] px-6 dark:bg-[radial-gradient(circle_at_top,_rgba(245,158,11,0.08),_transparent_24%),linear-gradient(180deg,_rgba(15,23,42,0.96)_0%,_rgba(2,6,23,1)_100%)]">
        <Card className="w-full max-w-2xl border-slate-200 bg-white/95 shadow-sm dark:border-slate-700/80 dark:bg-slate-950/85">
          <CardHeader>
            <CardTitle className="text-xl text-slate-950">
              Bullpen AI Auto-Live data is unavailable
            </CardTitle>
            <CardDescription>
              The console could not load enough state to render the dashboard yet.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert className="border-amber-300 bg-amber-50 text-amber-900">
              <AlertTriangle className="size-4" />
              <AlertTitle>Load failed</AlertTitle>
              <AlertDescription>{error || "Unknown load error."}</AlertDescription>
            </Alert>
            <div className="flex flex-wrap gap-3">
              <Button
                className="rounded-full"
                disabled={refreshing}
                onClick={() => {
                  void reloadDashboard();
                }}
              >
                {refreshing ? (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                ) : (
                  <RefreshCcw className="mr-2 size-4" />
                )}
                Retry load
              </Button>
              <Button asChild className="rounded-full" variant="outline">
                <Link href={URLs.routes.console.bullpenAi()}>
                  Open Bullpen x AI
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const state = summary.state;
  const latestGuardrails = summary.latest_guardrail_checks ?? [];
  const latestRun = summary.latest_run ?? summary.recent_runs?.[0] ?? null;
  const botCard = summary.bot_card;
  const runControl = deriveBullpenAiAutoLiveRunControlState({
    settings: summary.settings,
    state,
  });
  const liveSchedulerLocked = runControl.liveModeRequested && state.emergency_stopped;
  const guardrailsDrawerKey = settingsAvailable
    ? `${guardrailsDrawerOpen ? "open" : "closed"}:${JSON.stringify(summary.settings)}`
    : `${guardrailsDrawerOpen ? "open" : "closed"}:settings-unavailable`;

  return (
    <>
      <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(251,191,36,0.12),_transparent_28%),radial-gradient(circle_at_right,_rgba(16,185,129,0.10),_transparent_30%),linear-gradient(180deg,_#f8fafc_0%,_#eef2ff_100%)] dark:bg-[radial-gradient(circle_at_top,_rgba(245,158,11,0.08),_transparent_24%),radial-gradient(circle_at_right,_rgba(16,185,129,0.08),_transparent_28%),linear-gradient(180deg,_rgba(15,23,42,0.98)_0%,_rgba(2,6,23,1)_100%)]">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          <div className="space-y-6">
            <Card className="overflow-hidden border-slate-200 bg-white/90 shadow-sm backdrop-blur dark:border-slate-700/80 dark:bg-slate-950/72">
              <div className="border-b border-slate-200 bg-[linear-gradient(135deg,_rgba(15,23,42,0.03),_rgba(251,191,36,0.10))] px-6 py-6 dark:border-slate-700/80 dark:bg-[linear-gradient(135deg,_rgba(148,163,184,0.06),_rgba(245,158,11,0.08))]">
                <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
                  <div className="max-w-3xl">
                    <div className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-700">
                      Separate Auto-Live Service
                    </div>
                    <h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-950">
                      Bullpen AI Auto-Live
                    </h1>
                    <p className="mt-3 text-sm leading-7 text-slate-600 sm:text-base">
                      A standalone 7-stage decision engine that scans candidate
                      markets, parses rules, builds shared evidence, runs LLM
                      consensus, sizes positions, rebalances exposure, and only
                      executes limit orders when every hard guardrail passes.
                    </p>
                    <p className="mt-3 text-sm leading-6 text-slate-600">
                      Bullpen x AI remains the manual analysis surface.
                      Auto-Live uses its own persisted runs, decisions, and
                      stage-by-stage audit trail.
                    </p>
                    <div className="mt-4 grid gap-3 md:grid-cols-2">
                      <div className="rounded-3xl border border-sky-200 bg-sky-50/80 px-4 py-4">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-sky-700">
                          Bullpen x AI = analysis
                        </p>
                        <p className="mt-2 text-sm leading-6 text-sky-950">
                          Use the analysis console to scan ideas, compare LLM
                          odds, and review markets before any human-directed
                          trading decision.
                        </p>
                      </div>
                      <div className="rounded-3xl border border-emerald-200 bg-emerald-50/80 px-4 py-4">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-emerald-700">
                          Bullpen AI Auto-Live = automated execution
                        </p>
                        <p className="mt-2 text-sm leading-6 text-emerald-950">
                          Use this separate service to automate scans,
                          rebalances, and guarded live limit-order submission.
                        </p>
                      </div>
                    </div>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <span
                        className={cn(
                          "rounded-full border px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em]",
                          getGuardrailClass(state.status || "watch"),
                        )}
                      >
                        {labelize(state.status)}
                      </span>
                      <span
                        className={cn(
                          "rounded-full border px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em]",
                          getModeClass(state.mode || "dry-run"),
                        )}
                      >
                        {labelize(state.mode)}
                      </span>
                      <span className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-slate-700">
                        {state.live_armed ? "Live armed" : "Simulation only"}
                      </span>
                      <span className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-slate-700">
                        {state.dry_run ? "Dry run on" : "Dry run off"}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-3 xl:justify-end">
                    <Button
                      className="rounded-full"
                      disabled={refreshing || Boolean(actionBusy)}
                      onClick={() => {
                        void reloadDashboard();
                      }}
                      variant="outline"
                    >
                      {refreshing ? (
                        <Loader2 className="mr-2 size-4 animate-spin" />
                      ) : (
                        <RefreshCcw className="mr-2 size-4" />
                      )}
                      Refresh
                    </Button>
                    <Button
                      className="rounded-full bg-slate-950 text-white hover:bg-slate-800"
                      disabled={
                        refreshing || Boolean(actionBusy) || runControl.disabled
                      }
                      onClick={() => {
                        void handleAction("run-once");
                      }}
                      title={runControl.reason || undefined}
                    >
                      {actionBusy === "run-once" ? (
                        <Loader2 className="mr-2 size-4 animate-spin" />
                      ) : (
                        <Zap className="mr-2 size-4" />
                      )}
                      {runControl.label}
                    </Button>
                    {state.paused ? (
                      <Button
                        className="rounded-full"
                        disabled={
                          refreshing || Boolean(actionBusy) || liveSchedulerLocked
                        }
                        onClick={() => {
                          void handleAction("resume");
                        }}
                        variant="outline"
                      >
                        {actionBusy === "resume" ? (
                          <Loader2 className="mr-2 size-4 animate-spin" />
                        ) : (
                          <PlayCircle className="mr-2 size-4" />
                        )}
                        Resume
                      </Button>
                    ) : state.running ? (
                      <Button
                        className="rounded-full"
                        disabled={refreshing || Boolean(actionBusy)}
                        onClick={() => {
                          void handleAction("pause");
                        }}
                        variant="outline"
                      >
                        {actionBusy === "pause" ? (
                          <Loader2 className="mr-2 size-4 animate-spin" />
                        ) : (
                          <PauseCircle className="mr-2 size-4" />
                        )}
                        Pause
                      </Button>
                    ) : (
                      <Button
                        className="rounded-full"
                        disabled={
                          refreshing || Boolean(actionBusy) || liveSchedulerLocked
                        }
                        onClick={() => {
                          void handleAction("start");
                        }}
                        variant="outline"
                      >
                        {actionBusy === "start" ? (
                          <Loader2 className="mr-2 size-4 animate-spin" />
                        ) : (
                          <PlayCircle className="mr-2 size-4" />
                        )}
                        Start scheduler
                      </Button>
                    )}
                    {state.running || state.paused ? (
                      <Button
                        className="rounded-full"
                        disabled={refreshing || Boolean(actionBusy)}
                        onClick={() => {
                          void handleAction("stop");
                        }}
                        variant="outline"
                      >
                        {actionBusy === "stop" ? (
                          <Loader2 className="mr-2 size-4 animate-spin" />
                        ) : (
                          <Square className="mr-2 size-4" />
                        )}
                        Stop
                      </Button>
                    ) : null}
                    <Button
                      className={cn(
                        "rounded-full",
                        state.emergency_stopped
                          ? "border-rose-300 text-rose-700 hover:bg-rose-50"
                          : "bg-rose-600 text-white hover:bg-rose-500",
                      )}
                      disabled={
                        refreshing || Boolean(actionBusy) || Boolean(emergencyBusy)
                      }
                      onClick={() => {
                        void handleEmergencyStopToggle(state.emergency_stopped);
                      }}
                      variant={state.emergency_stopped ? "outline" : "default"}
                    >
                      {emergencyBusy ? (
                        <Loader2 className="mr-2 size-4 animate-spin" />
                      ) : (
                        <ShieldAlert className="mr-2 size-4" />
                      )}
                      {state.emergency_stopped
                        ? "Clear Emergency Stop"
                        : "Emergency Stop"}
                    </Button>
                    <Button
                      className="rounded-full"
                      onClick={() => setGuardrailsDrawerOpen(true)}
                      variant="outline"
                    >
                      <Settings2 className="mr-2 size-4" />
                      Risk guardrails
                    </Button>
                  </div>
                </div>

                <div className="mt-5 flex flex-wrap items-center gap-3 text-sm text-slate-600">
                  <span>
                    Last action: <span className="font-medium text-slate-900">{state.last_action || "-"}</span>
                  </span>
                  <span className="hidden text-slate-300 sm:inline">|</span>
                  <span>
                    Manual analysis page:{" "}
                    <Link
                      className="font-medium text-slate-900 underline decoration-amber-300 underline-offset-4"
                      href={URLs.routes.console.bullpenAi()}
                    >
                      Open Bullpen x AI
                    </Link>
                  </span>
                </div>
              </div>

              <CardContent className="space-y-5 px-6 py-6">
                <Alert className="border-amber-300 bg-amber-50 text-amber-950">
                  <AlertTriangle className="size-4" />
                  <AlertTitle>Live trading risk warning</AlertTitle>
                  <AlertDescription>{AUTO_LIVE_TOP_WARNING}</AlertDescription>
                </Alert>

                {state.emergency_stopped ? (
                  <Alert className="border-rose-300 bg-rose-50 text-rose-900">
                    <ShieldAlert className="size-4" />
                    <AlertTitle>Emergency stop is active</AlertTitle>
                    <AlertDescription>
                      New live actions are blocked until the emergency stop is
                      cleared from the emergency stop control or the risk
                      guardrails drawer.
                    </AlertDescription>
                  </Alert>
                ) : null}

                {error ? (
                  <Alert className="border-amber-300 bg-amber-50 text-amber-900">
                    <AlertTriangle className="size-4" />
                    <AlertTitle>Showing partial data</AlertTitle>
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                ) : null}

                <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
                  <MetricCard
                    detail={`Current value ${formatMoney(state.current_value_usd)}`}
                    eyebrow="Capital"
                    title="Invested"
                    value={formatMoney(state.invested_usd)}
                  />
                  <MetricCard
                    detail={`${state.active_positions ?? 0} active positions | ${state.today_executed_orders ?? state.trades_today ?? 0} executed today`}
                    eyebrow="PnL"
                    title="Net Profit / Loss"
                    value={formatMoney(state.pnl_usd)}
                  />
                  <MetricCard
                    detail={
                      latestRun
                        ? `${latestRun.decisions_count} decisions | ${latestRun.orders_planned} orders planned`
                        : "Run the engine once to create the first persisted decision set."
                    }
                    eyebrow="Latest Run"
                    title={latestRun ? labelize(latestRun.status) : "No runs yet"}
                    value={latestRun ? formatDateTime(latestRun.started_at) : "-"}
                  />
                  <MetricCard
                    detail={`Scan ${formatDateTime(state.next_scan_at)} | Rebalance ${formatDateTime(state.next_rebalance_at)}`}
                    eyebrow="Scheduler"
                    title={state.running ? "Active" : state.paused ? "Paused" : "Stopped"}
                    value={formatDateTime(state.next_run_at)}
                  />
                </div>

                <div className="grid gap-4 xl:grid-cols-[1.5fr,1fr]">
                  <Card className="border-slate-200 bg-slate-50/70">
                    <CardHeader>
                      <CardTitle className="text-lg text-slate-950">Strategy posture</CardTitle>
                      <CardDescription>
                        The bot card summarizes the standalone service status that also feeds the broader trading-bots overview.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="grid gap-4 md:grid-cols-2">
                      <div className="rounded-3xl border border-slate-200 bg-white p-4">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
                          Guardrails Summary
                        </p>
                        <p className="mt-3 text-sm leading-6 text-slate-700">
                          {botCard?.guardrails_summary || "No guardrail summary is available yet."}
                        </p>
                      </div>
                      <div className="rounded-3xl border border-slate-200 bg-white p-4">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
                          Strategy Summary
                        </p>
                        <p className="mt-3 text-sm leading-6 text-slate-700">
                          {botCard?.strategy_summary || "Strategy summary unavailable."}
                        </p>
                      </div>
                      <div className="rounded-3xl border border-slate-200 bg-white p-4 md:col-span-2">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
                          Risk Summary
                        </p>
                        <p className="mt-3 text-sm leading-6 text-slate-700">
                          {botCard?.risk_summary || "Risk summary unavailable."}
                        </p>
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="border-slate-200 bg-slate-50/70">
                    <CardHeader>
                      <CardTitle className="text-lg text-slate-950">Execution readiness</CardTitle>
                      <CardDescription>
                        Live execution still requires runtime, environment, and market guardrails to line up at stage 7.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3">
                        <span className="text-sm font-medium text-slate-700">Live armed</span>
                        <span className={cn("rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]", getGuardrailClass(state.live_armed ? "pass" : "watch"))}>
                          {state.live_armed ? "Armed" : "Simulation"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3">
                        <span className="text-sm font-medium text-slate-700">Live execution allowed</span>
                        <span className={cn("rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]", getGuardrailClass(state.live_execution_allowed ? "pass" : "watch"))}>
                          {state.live_execution_allowed ? "Ready" : "Blocked"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3">
                        <span className="text-sm font-medium text-slate-700">Dry run</span>
                        <span className={cn("rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]", getGuardrailClass(state.dry_run ? "warning" : "pass"))}>
                          {state.dry_run ? "On" : "Off"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3">
                        <span className="text-sm font-medium text-slate-700">Executed / skipped today</span>
                        <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-700">
                          {state.today_executed_orders ?? 0} / {state.today_skipped_orders ?? 0}
                        </span>
                      </div>
                      <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3">
                        <span className="text-sm font-medium text-slate-700">Consecutive failed orders</span>
                        <span className={cn("rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]", getGuardrailClass((state.consecutive_failed_orders ?? 0) > 0 ? "warning" : "pass"))}>
                          {state.consecutive_failed_orders ?? 0}
                        </span>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </CardContent>
            </Card>

            <Card className="border-slate-200 bg-white/90 shadow-sm">
              <CardHeader>
                <CardTitle className="text-xl text-slate-950">Latest guardrails</CardTitle>
                <CardDescription>
                  These are the most recent top-level runtime gates feeding the Auto-Live engine.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {latestGuardrails.length > 0 ? (
                  <div className="grid gap-3 xl:grid-cols-2">
                    {latestGuardrails.map((check) => (
                      <GuardrailPill check={check} key={check.id} />
                    ))}
                  </div>
                ) : (
                  <div className="rounded-3xl border border-dashed border-slate-200 bg-slate-50/80 px-5 py-8 text-sm text-slate-500">
                    No runtime guardrails have been persisted yet.
                  </div>
                )}
              </CardContent>
            </Card>

            <BullpenAiAutoLiveDecisionsPanel summary={summary} />
          </div>
        </div>
      </div>

      <BullpenAiAutoLiveRiskGuardrailsDrawer
        emergencyStopped={state.emergency_stopped}
        key={guardrailsDrawerKey}
        onClose={() => setGuardrailsDrawerOpen(false)}
        onSummaryReload={reloadDashboard}
        open={guardrailsDrawerOpen}
        settings={settingsAvailable ? summary.settings : null}
        settingsLoading={loading && !settingsAvailable}
      />
    </>
  );
}

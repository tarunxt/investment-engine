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
  BullpenAutoLiveGuardrailCheck,
  BullpenAutoLiveSummaryResponse,
} from "@/types/api";

import { BullpenAiAutoLiveDecisionsPanel } from "./BullpenAiAutoLiveDecisionsPanel";
import { BullpenAiAutoLiveRiskGuardrailsDrawer } from "./BullpenAiAutoLiveRiskGuardrailsDrawer";

type ActionKey = "run-once" | "start" | "pause" | "resume" | "stop";

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

async function requestDashboard(): Promise<BullpenAutoLiveSummaryResponse> {
  const [summary, runs, decisions] = await Promise.all([
    apiService.bullpenAiAutoLiveSummary(),
    apiService.bullpenAiAutoLiveRuns(),
    apiService.bullpenAiAutoLiveDecisions(),
  ]);

  return {
    ...summary,
    recent_runs: runs,
    recent_decisions: decisions,
  };
}

export function BullpenAiAutoLiveConsole() {
  const [summary, setSummary] = useState<BullpenAutoLiveSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<ActionKey | null>(null);
  const [guardrailsDrawerOpen, setGuardrailsDrawerOpen] = useState(false);

  async function reloadDashboard() {
    setRefreshing(true);
    try {
      const nextSummary = await requestDashboard();
      setSummary(nextSummary);
      setError(null);
      return nextSummary;
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
        const nextSummary = await requestDashboard();
        if (cancelled) return;
        setSummary(nextSummary);
        setError(null);
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
        await apiService.bullpenAiAutoLiveRunOnce();
      } else if (action === "start") {
        await apiService.bullpenAiAutoLiveStart();
      } else if (action === "pause") {
        await apiService.bullpenAiAutoLivePause();
      } else if (action === "resume") {
        await apiService.bullpenAiAutoLiveResume();
      } else if (action === "stop") {
        await apiService.bullpenAiAutoLiveStop();
      }

      await reloadDashboard();
    } catch (nextError) {
      setError(normalizeError(nextError));
    } finally {
      setActionBusy(null);
    }
  }

  const state = summary?.state;
  const latestGuardrails = summary?.latest_guardrail_checks ?? [];
  const latestRun = summary?.latest_run ?? summary?.recent_runs?.[0] ?? null;
  const botCard = summary?.bot_card;

  if (loading && !summary) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center bg-[radial-gradient(circle_at_top,_rgba(251,191,36,0.10),_transparent_35%),linear-gradient(180deg,_#f8fafc_0%,_#eef2ff_100%)] px-6">
        <div className="flex items-center gap-3 rounded-full border border-slate-200 bg-white px-5 py-3 text-sm text-slate-600 shadow-sm">
          <Loader2 className="size-4 animate-spin" />
          Loading Bullpen AI Auto-Live decisions...
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(251,191,36,0.12),_transparent_28%),radial-gradient(circle_at_right,_rgba(16,185,129,0.10),_transparent_30%),linear-gradient(180deg,_#f8fafc_0%,_#eef2ff_100%)]">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          <div className="space-y-6">
            <Card className="overflow-hidden border-slate-200 bg-white/90 shadow-sm backdrop-blur">
              <div className="border-b border-slate-200 bg-[linear-gradient(135deg,_rgba(15,23,42,0.03),_rgba(251,191,36,0.10))] px-6 py-6">
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
                    <div className="mt-4 flex flex-wrap gap-2">
                      <span
                        className={cn(
                          "rounded-full border px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em]",
                          getGuardrailClass(state?.status || "watch"),
                        )}
                      >
                        {state ? labelize(state.status) : "Unknown status"}
                      </span>
                      <span
                        className={cn(
                          "rounded-full border px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em]",
                          getModeClass(state?.mode || "dry-run"),
                        )}
                      >
                        {state ? labelize(state.mode) : "Dry run"}
                      </span>
                      <span className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-slate-700">
                        {state?.live_armed ? "Live armed" : "Simulation only"}
                      </span>
                      <span className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-slate-700">
                        {state?.dry_run ? "Dry run on" : "Dry run off"}
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
                      disabled={refreshing || Boolean(actionBusy)}
                      onClick={() => {
                        void handleAction("run-once");
                      }}
                    >
                      {actionBusy === "run-once" ? (
                        <Loader2 className="mr-2 size-4 animate-spin" />
                      ) : (
                        <Zap className="mr-2 size-4" />
                      )}
                      Run now
                    </Button>
                    {state?.paused ? (
                      <Button
                        className="rounded-full"
                        disabled={refreshing || Boolean(actionBusy)}
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
                    ) : state?.running ? (
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
                        disabled={refreshing || Boolean(actionBusy)}
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
                    {state?.running || state?.paused ? (
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
                    Last action: <span className="font-medium text-slate-900">{state?.last_action || "-"}</span>
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
                {state?.emergency_stopped ? (
                  <Alert className="border-rose-300 bg-rose-50 text-rose-900">
                    <ShieldAlert className="size-4" />
                    <AlertTitle>Emergency stop is active</AlertTitle>
                    <AlertDescription>
                      New live actions are blocked until the emergency stop is
                      cleared from the risk guardrails drawer.
                    </AlertDescription>
                  </Alert>
                ) : null}

                {error ? (
                  <Alert className="border-amber-300 bg-amber-50 text-amber-900">
                    <AlertTriangle className="size-4" />
                    <AlertTitle>Console refresh needs attention</AlertTitle>
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                ) : null}

                <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
                  <MetricCard
                    detail={`Current value ${formatMoney(state?.current_value_usd)}`}
                    eyebrow="Capital"
                    title="Invested"
                    value={formatMoney(state?.invested_usd)}
                  />
                  <MetricCard
                    detail={`${state?.active_positions ?? 0} active positions | ${state?.today_executed_orders ?? state?.trades_today ?? 0} executed today`}
                    eyebrow="PnL"
                    title="Net Profit / Loss"
                    value={formatMoney(state?.pnl_usd)}
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
                    detail={`Scan ${formatDateTime(state?.next_scan_at)} | Rebalance ${formatDateTime(state?.next_rebalance_at)}`}
                    eyebrow="Scheduler"
                    title={state?.running ? "Active" : state?.paused ? "Paused" : "Stopped"}
                    value={formatDateTime(state?.next_run_at)}
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
                        <span className={cn("rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]", getGuardrailClass(state?.live_armed ? "pass" : "watch"))}>
                          {state?.live_armed ? "Armed" : "Simulation"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3">
                        <span className="text-sm font-medium text-slate-700">Live execution allowed</span>
                        <span className={cn("rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]", getGuardrailClass(state?.live_execution_allowed ? "pass" : "watch"))}>
                          {state?.live_execution_allowed ? "Ready" : "Blocked"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3">
                        <span className="text-sm font-medium text-slate-700">Dry run</span>
                        <span className={cn("rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]", getGuardrailClass(state?.dry_run ? "warning" : "pass"))}>
                          {state?.dry_run ? "On" : "Off"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3">
                        <span className="text-sm font-medium text-slate-700">Executed / skipped today</span>
                        <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-700">
                          {state?.today_executed_orders ?? 0} / {state?.today_skipped_orders ?? 0}
                        </span>
                      </div>
                      <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3">
                        <span className="text-sm font-medium text-slate-700">Consecutive failed orders</span>
                        <span className={cn("rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]", getGuardrailClass((state?.consecutive_failed_orders ?? 0) > 0 ? "warning" : "pass"))}>
                          {state?.consecutive_failed_orders ?? 0}
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
        onClose={() => setGuardrailsDrawerOpen(false)}
        onSummaryReload={reloadDashboard}
        open={guardrailsDrawerOpen}
        settings={summary?.settings ?? null}
        settingsLoading={loading && !summary}
      />
    </>
  );
}

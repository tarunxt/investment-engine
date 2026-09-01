"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CirclePause,
  Clock3,
  History,
  Loader2,
  OctagonX,
  Play,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  WalletCards,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatUnknownError } from "@/lib/apiErrors";
import { formatApiTimestamp } from "@/lib/datetime";
import { URLs } from "@/lib/urls";
import { cn } from "@/lib/utils";
import { apiService } from "@/services/api";
import type {
  Bullpen008Bootstrap,
  Bullpen008Settings,
  Bullpen008SettingsUpdate,
  Bullpen008StageOutput,
  Bullpen008StageStatus,
} from "@/types/api";
import { BullpenAutoRunStageOutputDialog } from "../../bullpen-ai/_components/BullpenAutoRunStageOutputDialog";
import { BullpenScanFilterDetailsDialog } from "../../bullpen-ai/_components/BullpenScanFilterDetailsDialog";
import {
  BullpenReturnsPerDayFormulaDialog,
  BullpenReturnsPerDayHeaderInfo,
} from "../../bullpen-ai/_components/BullpenReturnsPerDayInfo";

const STAGES = [
  {
    number: 1,
    name: "Discover & Hard Filters",
    detail: "Builds a complete, clean market universe before any LLM request.",
    metricKeys: ["high_shock_rejected", "less_than_48_hour_rejected", "existing_high_shock_monitored", "timing_unresolved", "scanned", "accepted"],
  },
  {
    number: 2,
    name: "Probability & Structural Risk",
    detail: "Separates calibrated probability from structural contract risk.",
    metricKeys: ["evidence_complete", "evidence_stale", "conservative_edge_rejected", "high_disagreement_rejected", "reward_skew_rejected", "analysed"],
  },
  {
    number: 3,
    name: "Cluster & Dependency Map",
    detail: "Finds mechanically related contracts and broader common catalysts.",
    metricKeys: ["joint_loss_scenarios", "high_shock_scenarios", "unresolved_scenarios", "largest_current_scenario_loss", "strict_clusters", "common_catalyst_clusters"],
  },
  {
    number: 4,
    name: "Portfolio Optimizer & Stress Test",
    detail: "Deterministically selects targets, sizes them, and verifies every cap.",
    metricKeys: ["maximum_scenario_loss", "binding_risk_tier", "contingent_exits_certified", "mandatory_time_exits", "scenario_cap_result", "invested"],
  },
  {
    number: 5,
    name: "Exit & Rebalance Plan",
    detail: "Translates only the certified Stage 4 target into an immutable, dependency-ordered plan.",
    metricKeys: ["dormant_contingent_exits", "activated_reductions", "drawdown_mode", "exit_only_status", "plan_certificate_result", "claims", "cancellations", "sells", "trims", "buys", "holds", "blocked"],
  },
  {
    number: 6,
    name: "Execute & Reconcile",
    detail: "Revalidates every immutable action, then safely executes or shadow-validates and reconciles it.",
    metricKeys: ["planned", "risk_certified", "would_submit", "ready", "durable_intents", "submitted", "confirmed", "partially_filled", "blocked", "failed", "recoverable", "reconciled"],
  },
] as const;

type NumericRiskSetting = Exclude<keyof Bullpen008Settings, "workflow_profile">;

const P0_RISK_SETTINGS: Array<{ key: NumericRiskSetting; label: string; step?: string }> = [
  { key: "geopolitical_min_entry_hours", label: "Geopolitical minimum entry hours" },
  { key: "single_day_high_shock_cap_usd", label: "Single-day high-shock cap ($)" },
  { key: "high_shock_cluster_cap_usd", label: "High-shock cluster/scenario cap ($)" },
  { key: "standard_cluster_cap_usd", label: "Standard cluster/scenario cap ($)" },
  { key: "conservative_edge_min_pp", label: "Minimum conservative edge (pp)" },
  { key: "high_shock_conservative_edge_min_pp", label: "High-shock minimum edge (pp)" },
  { key: "entry_price_high_zone_pct", label: "High-price zone (%)" },
  { key: "entry_price_hard_ceiling_pct", label: "Hard price ceiling (%)" },
  { key: "high_zone_max_allocation_usd", label: "High-price maximum allocation ($)" },
  { key: "min_reward_to_loss_ratio", label: "Minimum reward-to-loss ratio", step: "0.01" },
  { key: "high_shock_evidence_max_age_minutes", label: "Evidence maximum age (minutes)" },
  { key: "high_shock_min_source_count", label: "Minimum independent sources" },
  { key: "single_day_time_exit_hours", label: "Single-day time exit (hours)" },
  { key: "high_shock_time_exit_hours", label: "High-shock time exit (hours)" },
  { key: "take_profit_odds_floor_pct", label: "Take-profit odds floor (%)" },
  { key: "contingent_exit_odds_floor_pct", label: "Contingent-exit odds floor (%)" },
  { key: "odds_drop_15m_pp", label: "15-minute drop threshold (pp)" },
  { key: "odds_drop_24h_pp", label: "24-hour drop threshold (pp)" },
  { key: "catastrophic_drop_15m_pp", label: "Catastrophic 15-minute drop (pp)" },
  { key: "quote_confirmation_count", label: "Quote confirmation count" },
  { key: "soft_drawdown_pct", label: "Soft drawdown (%)" },
  { key: "hard_drawdown_pct", label: "Hard drawdown (%)" },
  { key: "post_shock_cooldown_hours", label: "Post-shock cooldown (hours)" },
];

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (row): row is Record<string, unknown> =>
          Boolean(row) && typeof row === "object" && !Array.isArray(row),
      )
    : [];
}

function formatMoney(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? numeric.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      })
    : "—";
}

function formatMetric(key: string, value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  if (key.includes("exposure") || key === "invested" || key === "cash_retained") {
    return formatMoney(value);
  }
  if (typeof value === "boolean") return value ? "Pass" : "Fail";
  if (typeof value === "number") return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return String(value).replaceAll("_", " ");
}

function formatLabel(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace("Llm", "LLM");
}

function statusStyle(status: Bullpen008StageStatus | string) {
  switch (status) {
    case "finished":
    case "completed":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "running":
    case "queued":
      return "border-sky-200 bg-sky-50 text-sky-700";
    case "failed":
      return "border-rose-200 bg-rose-50 text-rose-700";
    case "blocked":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "partial":
      return "border-violet-200 bg-violet-50 text-violet-700";
    case "cancelled":
      return "border-slate-300 bg-slate-100 text-slate-700";
    default:
      return "border-slate-200 bg-slate-100 text-slate-600";
  }
}

function StatusIcon({ status }: { status: string }) {
  if (status === "finished" || status === "completed") return <CheckCircle2 className="h-4 w-4" />;
  if (status === "running" || status === "queued") return <Loader2 className="h-4 w-4 animate-spin" />;
  if (status === "failed") return <XCircle className="h-4 w-4" />;
  if (status === "blocked") return <AlertTriangle className="h-4 w-4" />;
  return <Clock3 className="h-4 w-4" />;
}

function metricSource(stage: Bullpen008StageOutput | undefined) {
  const metrics = {
    ...asRecord(stage?.outputs.metrics),
    ...asRecord(stage?.outputs.risk_metrics),
  };
  if (stage?.stage_number === 4 && Object.keys(metrics).length === 0) {
    return asRecord(stage.outputs.portfolio_metrics);
  }
  return metrics;
}

function StageCard({
  definition,
  stage,
  onOpen,
}: {
  definition: (typeof STAGES)[number];
  stage?: Bullpen008StageOutput;
  onOpen: () => void;
}) {
  const status = stage?.status ?? "pending";
  const metrics = metricSource(stage);
  const progressPercent = status === "finished" ? 100 : status === "partial" ? 75 : status === "running" ? 55 : 0;
  return (
    <button
      type="button"
      disabled={!stage}
      onClick={onOpen}
      className={cn(
        "group flex min-h-[30rem] flex-col rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-sky-300 hover:shadow-lg disabled:translate-y-0 disabled:cursor-default disabled:hover:border-slate-200 disabled:hover:shadow-sm",
      )}
      aria-label={`Stage ${definition.number}: ${definition.name}. ${status}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
            Stage {definition.number}
          </p>
          <h3 className="mt-2 text-base font-semibold text-slate-950">{definition.name}</h3>
        </div>
        <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold capitalize", statusStyle(status))}>
          <StatusIcon status={status} />
          {status}
        </span>
      </div>
      <p className="mt-3 text-sm leading-6 text-slate-600">{definition.detail}</p>
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-200" aria-label={`Stage ${definition.number} progress ${progressPercent}%`}>
        <div
          className={cn(
            "h-full rounded-full transition-all",
            status === "finished" ? "bg-emerald-500" : status === "failed" ? "bg-rose-500" : status === "blocked" ? "bg-amber-500" : "bg-sky-500",
          )}
          style={{ width: `${progressPercent}%` }}
        />
      </div>
      <div className="mt-5 grid grid-cols-2 gap-2">
        {definition.metricKeys.map((key) => (
          <div key={key} className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{formatLabel(key)}</p>
            <p className="mt-1 text-sm font-semibold text-slate-900">{formatMetric(key, metrics[key])}</p>
          </div>
        ))}
      </div>
      {stage ? (
        <div className="mt-auto flex items-center justify-between border-t border-slate-100 pt-3 text-xs text-slate-500">
          <span>{stage.duration_seconds.toFixed(2)}s · v{stage.stage_version}</span>
          <span className="font-semibold text-sky-700 group-hover:text-sky-900">Open details</span>
        </div>
      ) : null}
    </button>
  );
}

function SummaryMetric({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-slate-950">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{note}</p>
    </div>
  );
}

export function Bullpen008PageClient() {
  const [bootstrap, setBootstrap] = useState<Bullpen008Bootstrap | null>(null);
  const [selectedStage, setSelectedStage] = useState<Bullpen008StageOutput | null>(null);
  const [portfolioStage, setPortfolioStage] = useState<Bullpen008StageOutput | null>(null);
  const [isFormulaDialogOpen, setIsFormulaDialogOpen] = useState(false);
  const [isOthersFilterOpen, setIsOthersFilterOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [customPhrases, setCustomPhrases] = useState("");
  const [closingWindowDays, setClosingWindowDays] = useState("30");
  const [autoRefreshMinutes, setAutoRefreshMinutes] = useState("360");
  const [riskSettings, setRiskSettings] = useState<Record<string, string>>({});

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await apiService.getBullpen008Bootstrap({
        signal,
        timeoutMs: 15_000,
      });
      setBootstrap(data);
      setCustomPhrases(data.settings.custom_exclude_phrases.join(", "));
      setClosingWindowDays(String(data.settings.closing_window_days));
      setAutoRefreshMinutes(String(data.settings.auto_refresh_minutes));
      setRiskSettings(
        Object.fromEntries(
          P0_RISK_SETTINGS.map(({ key }) => [key, String(data.settings[key])]),
        ),
      );
      const hasStage4 = data.latest_run?.stages.some(
        (stage) => stage.stage_number === 4,
      );
      if (data.latest_run && hasStage4) {
        try {
          setPortfolioStage(
            await apiService.getBullpen008Stage(data.latest_run.id, 4),
          );
        } catch {
          setPortfolioStage(null);
        }
      } else {
        setPortfolioStage(null);
      }
      setError(null);
    } catch (loadError) {
      if (signal?.aborted) return;
      setError(`Bullpen 008 could not be loaded. ${formatUnknownError(loadError)}`);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [load]);

  const latestRun = bootstrap?.latest_run ?? null;
  const hasActiveRun = Boolean(
    latestRun && !TERMINAL_RUN_STATUSES.has(latestRun.status),
  );
  useEffect(() => {
    if (!latestRun || TERMINAL_RUN_STATUSES.has(latestRun.status)) return;
    const interval = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(interval);
  }, [latestRun, load]);

  const stagesByNumber = useMemo(
    () => new Map((latestRun?.stages ?? []).map((stage) => [stage.stage_number, stage])),
    [latestRun],
  );
  const stage4 = stagesByNumber.get(4);
  const stage4Metrics = asRecord(stage4?.outputs.metrics);
  const walletSnapshot = asRecord(latestRun?.wallet_snapshot);
  const balance = asRecord(walletSnapshot.balance);
  const positions = asRows(walletSnapshot.positions);
  const portfolioAllocations = asRows(portfolioStage?.outputs.allocations);
  const invested = positions.reduce(
    (total, row) => total + Number(row.current_value_usd ?? row.exposure_usd ?? 0),
    0,
  );
  const cash = Number(balance.available_balance_usd ?? 0);
  const portfolioValue = invested + cash;
  const riskState = asRecord(bootstrap?.risk_state);
  const jointLossScenarios = asRows(
    riskState.joint_loss_scenarios ?? portfolioStage?.outputs.joint_scenario_stress,
  );
  const contingentPolicies = asRows(portfolioStage?.outputs.contingent_exit_policies);
  const contingentActivations = asRows(riskState.contingent_activations);
  const regimeEpisodes = asRows(riskState.regime_change_episodes);
  const drawdown = asRecord(riskState.drawdown);
  const pnlAttribution = asRows(riskState.pnl_attribution);
  const lossPreventionAudit = asRows(
    riskState.loss_prevention_audit ?? portfolioStage?.outputs.loss_prevention_audit,
  );
  const scenarioCooldowns = asRows(riskState.scenario_cooldowns);

  const runOnce = async () => {
    setBusyAction("run");
    setError(null);
    try {
      await apiService.runBullpen008Once(`bullpen008-ui-${Date.now()}`);
      await load();
    } catch (actionError) {
      const detail = formatUnknownError(actionError);
      await load();
      setError(
        detail.includes("already queued or running")
          ? "A Bullpen 008 run already owns the queue. Use Pause to stop new scheduling or Kill to terminate the active run, then start again."
          : `The shadow run could not be queued. ${detail}`,
      );
    } finally {
      setBusyAction(null);
    }
  };

  const saveSettings = async () => {
    setBusyAction("settings");
    setError(null);
    try {
      await apiService.updateBullpen008Settings({
        custom_exclude_phrases: customPhrases
          .split(",")
          .map((phrase) => phrase.trim())
          .filter(Boolean),
        closing_window_days: Number(closingWindowDays),
        auto_refresh_minutes: Number(autoRefreshMinutes),
        ...Object.fromEntries(
          P0_RISK_SETTINGS.map(({ key }) => [key, Number(riskSettings[key])]),
        ),
      } as Bullpen008SettingsUpdate);
      await load();
    } catch (actionError) {
      setError(`Bullpen 008 settings were not saved. ${formatUnknownError(actionError)}`);
    } finally {
      setBusyAction(null);
    }
  };

  const toggleScheduler = async () => {
    setBusyAction("scheduler");
    setError(null);
    try {
      if (bootstrap?.state.running) await apiService.stopBullpen008Scheduler();
      else await apiService.startBullpen008Scheduler();
      await load();
    } catch (actionError) {
      setError(`The 008 scheduler state could not be changed. ${formatUnknownError(actionError)}`);
    } finally {
      setBusyAction(null);
    }
  };

  const togglePause = async () => {
    setBusyAction("pause");
    setError(null);
    try {
      if (bootstrap?.state.paused) await apiService.resumeBullpen008Scheduler();
      else await apiService.pauseBullpen008Scheduler();
      await load();
    } catch (actionError) {
      setError(`The 008 pause state could not be changed. ${formatUnknownError(actionError)}`);
    } finally {
      setBusyAction(null);
    }
  };

  const toggleEmergencyStop = async () => {
    setBusyAction("emergency");
    setError(null);
    try {
      if (bootstrap?.state.emergency_stop) await apiService.clearBullpen008EmergencyStop();
      else await apiService.emergencyStopBullpen008();
      await load();
    } catch (actionError) {
      setError(`The 008 emergency stop could not be changed. ${formatUnknownError(actionError)}`);
    } finally {
      setBusyAction(null);
    }
  };

  const killActiveRun = async () => {
    setBusyAction("kill");
    setError(null);
    try {
      await apiService.killBullpen008Run();
      await load();
    } catch (actionError) {
      setError(`The active Bullpen 008 run could not be killed. ${formatUnknownError(actionError)}`);
    } finally {
      setBusyAction(null);
    }
  };

  const loadReturnsFormula = useCallback(async () => {
    const settings = await apiService.getBullpen008Settings();
    return settings.returns_per_day_formula;
  }, []);

  const saveReturnsFormula = useCallback(async (formula: string) => {
    const settings = await apiService.updateBullpen008Settings({
      returns_per_day_formula: formula,
    });
    await load();
    return settings.returns_per_day_formula;
  }, [load]);

  const saveOtherPhrases = useCallback(async (phrases: string[]) => {
    setCustomPhrases(phrases.join(", "));
    setBusyAction("settings");
    setError(null);
    try {
      await apiService.updateBullpen008Settings({
        custom_exclude_phrases: phrases,
      });
      await load();
    } catch (actionError) {
      setError(`Bullpen 008 custom phrases were not saved. ${formatUnknownError(actionError)}`);
    } finally {
      setBusyAction(null);
    }
  }, [load]);

  const openStage = async (stageNumber: number) => {
    if (!latestRun) return;
    setBusyAction(`stage-${stageNumber}`);
    setError(null);
    try {
      setSelectedStage(
        await apiService.getBullpen008Stage(latestRun.id, stageNumber),
      );
    } catch (stageError) {
      setError(
        `The immutable Stage ${stageNumber} record could not be loaded. ${formatUnknownError(stageError)}`,
      );
    } finally {
      setBusyAction(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6" aria-label="Loading Bullpen 008 workspace">
        <div className="h-36 animate-pulse rounded-3xl bg-slate-100" />
        <div className="grid gap-4 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => <div key={index} className="h-64 animate-pulse rounded-3xl bg-slate-100" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-workflow-profile="bullpen008">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-start">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">Copy Trading Bots</p>
              <span className="rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-xs font-semibold text-sky-700">Bullpen 008</span>
              <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800">{bootstrap?.settings.execution_mode === "shadow" ? "Shadow mode · no orders" : bootstrap?.settings.execution_mode}</span>
            </div>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">Bullpen 008</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              Isolated six-stage evolution of Bullpen 007. Stage 4 owns the target, Stage 5 certifies an immutable action plan, and Stage 6 is production-locked in shadow mode until separately armed.
            </p>
            <div className="mt-4 flex flex-wrap gap-4 text-xs text-slate-500">
              <span>Profile: <strong className="text-slate-700">bullpen008</strong></span>
              <span>Wallet: <strong className="text-slate-700">{String(walletSnapshot.account_identity ?? "Same authenticated Bullpen wallet")}</strong></span>
              <span>Quotes: <strong className="text-slate-700">{formatApiTimestamp(String(walletSnapshot.fetched_at ?? ""), { emptyValue: "Not captured yet" })}</strong></span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void load()} disabled={Boolean(busyAction)}>
              <RefreshCw className="mr-2 h-4 w-4" /> Refresh
            </Button>
            <Button variant="outline" asChild>
              <Link href={URLs.routes.console.bullpen008History()}>
                <History className="mr-2 h-4 w-4" /> History
              </Link>
            </Button>
            {(hasActiveRun || bootstrap?.state.paused) ? (
              <Button
                onClick={() => void togglePause()}
                disabled={Boolean(busyAction)}
                className="border-orange-600 bg-orange-500 text-white hover:bg-orange-600"
              >
                {busyAction === "pause" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CirclePause className="mr-2 h-4 w-4" />}
                {bootstrap?.state.paused ? "Resume" : "Pause"}
              </Button>
            ) : null}
            {hasActiveRun ? (
              <Button
                onClick={() => void killActiveRun()}
                disabled={Boolean(busyAction)}
                className="border-rose-700 bg-rose-600 text-white hover:bg-rose-700"
              >
                {busyAction === "kill" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <OctagonX className="mr-2 h-4 w-4" />}
                Kill
              </Button>
            ) : null}
            <Button onClick={() => void runOnce()} disabled={Boolean(busyAction) || hasActiveRun}>
              {busyAction === "run" || hasActiveRun ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
              Run six stages
            </Button>
          </div>
        </div>
      </section>

      {error ? (
        <div role="alert" className="flex items-start gap-3 rounded-3xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div><strong>Bullpen 008 error.</strong> {error}</div>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryMetric label="Portfolio value" value={portfolioValue > 0 ? formatMoney(portfolioValue) : "—"} note="Same live wallet, isolated workflow" />
        <SummaryMetric label="Investments" value={invested > 0 ? formatMoney(invested) : "—"} note={`${positions.length} active/monitored positions`} />
        <SummaryMetric label="Cash" value={cash > 0 ? formatMoney(cash) : "—"} note="Cash retention is allowed" />
        <SummaryMetric label="Certified target" value={formatMoney(stage4Metrics.invested)} note={stage4?.status === "finished" ? "Portfolio certificate passed" : "Awaiting a certified run"} />
      </div>

      <Card className="rounded-3xl border-slate-200 shadow-sm">
        <CardHeader className="flex flex-col gap-4 border-b border-slate-100 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <CardTitle>Background worker monitor</CardTitle>
            <CardDescription className="mt-2">A stage is Finished only after its recorded pass condition succeeds. Current stage: {latestRun?.stages.find((stage) => stage.status === "running")?.stage_name ?? (latestRun?.status === "completed" ? "Reconciled outcome" : "Idle")}.</CardDescription>
          </div>
          {latestRun ? (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 font-semibold capitalize", statusStyle(latestRun.status))}>
                <StatusIcon status={latestRun.status} /> {latestRun.status}
              </span>
              <Link className="font-semibold text-sky-700 hover:text-sky-900" href={URLs.routes.console.bullpen008RunDetail(latestRun.id)}>
                Run {latestRun.id.slice(0, 16)}…
              </Link>
            </div>
          ) : null}
        </CardHeader>
        <CardContent className="pt-6">
          <div className="grid gap-4 lg:grid-cols-3">
            {STAGES.map((definition) => (
              <StageCard key={definition.number} definition={definition} stage={stagesByNumber.get(definition.number)} onOpen={() => {
                const stage = stagesByNumber.get(definition.number);
                if (stage) void openStage(definition.number);
              }} />
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[1.25fr_0.75fr]">
        <Card className="rounded-3xl border-slate-200 shadow-sm">
          <CardHeader>
            <div className="flex items-center gap-2"><WalletCards className="h-5 w-5 text-sky-600" /><CardTitle>Wallet positions</CardTitle></div>
            <CardDescription>Live shared-account data is read-only here and always included in monitoring and cluster exposure.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-2xl border border-slate-200">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <tr><th className="px-4 py-3">Market</th><th className="px-4 py-3">Side</th><th className="px-4 py-3 text-right">Cost basis</th><th className="px-4 py-3 text-right">Current value</th><th className="px-4 py-3">State</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {positions.slice(0, 12).map((position, index) => (
                    <tr key={String(position.market_id ?? index)}>
                      <td className="max-w-xs px-4 py-3 font-medium text-slate-900"><span className="line-clamp-2">{String(position.market_title ?? position.question ?? position.market_id ?? "Unknown market")}</span></td>
                      <td className="px-4 py-3 text-slate-600">{String(position.side ?? "—")}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-600">{formatMoney(position.exposure_usd)}</td>
                      <td className="px-4 py-3 capitalize text-slate-600">{String(position.classification ?? "active")}</td>
                    </tr>
                  ))}
                  {positions.length === 0 ? <tr><td colSpan={5} className="px-4 py-10 text-center text-slate-500">Run Stage 1 to capture the latest wallet positions.</td></tr> : null}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-3xl border-slate-200 shadow-sm">
          <CardHeader>
            <div className="flex items-center gap-2"><SlidersHorizontal className="h-5 w-5 text-sky-600" /><CardTitle>Scan & schedule settings</CardTitle></div>
            <CardDescription>Seeded once from 007. Every save is isolated to profile bullpen008.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2"><Label htmlFor="bullpen008-window">Closing window (days)</Label><Input id="bullpen008-window" inputMode="numeric" value={closingWindowDays} onChange={(event) => setClosingWindowDays(event.target.value)} /></div>
            <div className="space-y-2"><Label htmlFor="bullpen008-refresh">Refresh interval (minutes)</Label><Input id="bullpen008-refresh" inputMode="numeric" value={autoRefreshMinutes} onChange={(event) => setAutoRefreshMinutes(event.target.value)} /></div>
            <div className="space-y-2"><Label htmlFor="bullpen008-phrases">Custom exclusion phrases</Label><Input id="bullpen008-phrases" value={customPhrases} onChange={(event) => setCustomPhrases(event.target.value)} placeholder="comma-separated phrases" /></div>
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs leading-5 text-amber-900">
              Deterministic single-day geopolitical rejection is enabled and cannot be downgraded by the LLM. This profile remains shadowed and unarmed.
            </div>
            <div className="grid max-h-[28rem] gap-3 overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-2">
              {P0_RISK_SETTINGS.map(({ key, label, step }) => (
                <div className="space-y-1.5" key={key}>
                  <Label className="text-xs" htmlFor={`bullpen008-${key}`}>{label}</Label>
                  <Input
                    id={`bullpen008-${key}`}
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step={step ?? "1"}
                    value={riskSettings[key] ?? ""}
                    onChange={(event) => setRiskSettings((current) => ({ ...current, [key]: event.target.value }))}
                  />
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setIsOthersFilterOpen(true)}
              className="w-full rounded-2xl border border-indigo-200 bg-indigo-50/60 p-4 text-left transition hover:border-indigo-300 hover:bg-indigo-50"
            >
              <span className="text-sm font-semibold text-slate-950">Others</span>
              <span className="mt-1 block text-xs leading-5 text-slate-600">
                Open the same Bullpen 007 filter-details popup to add, remove, and inspect custom exclusion phrases.
              </span>
            </button>
            <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm">
              <div>
                <p className="font-semibold text-slate-950">Returns/day formula</p>
                <p className="mt-1 break-all font-mono text-xs text-slate-500">
                  {bootstrap?.settings.returns_per_day_formula}
                </p>
              </div>
              <BullpenReturnsPerDayHeaderInfo
                onOpen={() => setIsFormulaDialogOpen(true)}
                className="h-6 w-6 shrink-0"
              />
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-xs leading-5 text-slate-600">
              Tier caps: ${bootstrap?.settings.single_day_high_shock_cap_usd} single-day · ${bootstrap?.settings.high_shock_cluster_cap_usd} high-shock · ${bootstrap?.settings.standard_cluster_cap_usd} standard. High-shock evidence: {bootstrap?.settings.high_shock_min_source_count} independent sources, fresh within {bootstrap?.settings.high_shock_evidence_max_age_minutes} minutes.
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void saveSettings()} disabled={Boolean(busyAction)}>{busyAction === "settings" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}Save 008 settings</Button>
              <Button variant="outline" onClick={() => void toggleScheduler()} disabled={Boolean(busyAction)}>{busyAction === "scheduler" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Clock3 className="mr-2 h-4 w-4" />}{bootstrap?.state.running ? "Stop schedule" : "Start schedule"}</Button>
              <Button variant="outline" onClick={() => void togglePause()} disabled={Boolean(busyAction) || !bootstrap?.state.running}>{bootstrap?.state.paused ? "Resume" : "Pause"}</Button>
              <Button variant="destructive" onClick={() => void toggleEmergencyStop()} disabled={Boolean(busyAction)}>{bootstrap?.state.emergency_stop ? "Clear emergency stop" : "Emergency stop"}</Button>
            </div>
            <p className="text-xs text-slate-500">Next run: {formatApiTimestamp(bootstrap?.state.next_run_at, { emptyValue: "Not scheduled" })} · Mode: {bootstrap?.state.execution_mode} · Last run: {bootstrap?.state.last_run_id ?? "none"}</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card className="rounded-3xl border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle>Joint-loss scenarios & caps</CardTitle>
            <CardDescription>Cross-worded positions are grouped by the real-world development that can make their held sides lose.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {jointLossScenarios.slice(0, 8).map((scenario, index) => (
              <div className="rounded-2xl border border-slate-200 p-4" key={String(scenario.scenario_id ?? index)}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold text-slate-950">{String(scenario.driver ?? scenario.scenario_id ?? "Scenario")}</p>
                  <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-800">{formatLabel(String(scenario.risk_tier ?? "standard_objective"))}</span>
                </div>
                <p className="mt-2 text-xs leading-5 text-slate-600">{String(scenario.description ?? scenario.main_joint_loss_trigger ?? "No description recorded")}</p>
                <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                  <div><span className="text-slate-500">Existing</span><p className="font-semibold">{formatMoney(scenario.existing_loss_at_risk_usd)}</p></div>
                  <div><span className="text-slate-500">Target</span><p className="font-semibold">{formatMoney(scenario.target_loss_at_risk_usd)}</p></div>
                  <div><span className="text-slate-500">Cap</span><p className="font-semibold">{formatMoney(scenario.effective_scenario_cap_usd)}</p></div>
                </div>
                <p className="mt-2 text-xs text-slate-500">Markets: {asRows(scenario.affected_market_ids).length || (Array.isArray(scenario.affected_market_ids) ? scenario.affected_market_ids.length : 0)} · adjudication {String(scenario.adjudication_status ?? "unknown")}</p>
              </div>
            ))}
            {jointLossScenarios.length === 0 ? <p className="rounded-2xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">Run through Stage 3 to build the versioned joint-loss graph.</p> : null}
          </CardContent>
        </Card>

        <Card className="rounded-3xl border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle>Drawdown, regimes & cooldowns</CardTitle>
            <CardDescription>Daily UTC equity baseline with deposits and withdrawals neutralised; IST timestamps remain available in detailed records.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className={cn("rounded-2xl border p-4", drawdown.exit_only ? "border-rose-200 bg-rose-50" : drawdown.buy_freeze ? "border-amber-200 bg-amber-50" : "border-emerald-200 bg-emerald-50")}>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">Current breaker</p>
              <p className="mt-1 text-lg font-semibold text-slate-950">{formatLabel(String(drawdown.state ?? "NOT_YET_BASELINED"))}</p>
              <p className="mt-2 text-sm text-slate-700">Drawdown {formatMoney(drawdown.drawdown_usd)} · soft {formatMoney(drawdown.soft_threshold_usd)} · hard {formatMoney(drawdown.hard_threshold_usd)}</p>
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-950">Regime-change episodes</p>
              <div className="mt-2 space-y-2">
                {regimeEpisodes.slice(0, 6).map((episode, index) => (
                  <div className="rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs" key={String(episode.episode_hash ?? index)}>
                    <p className="font-semibold text-rose-950">{String(episode.status ?? "ACTIVE_BUY_FREEZE")} · {String(episode.scenario_id ?? "scenario")}</p>
                    <p className="mt-1 text-rose-800">{String(episode.regime_change_reason ?? "Verified thesis-invalidating development")}</p>
                    <p className="mt-1 text-rose-700">Activated {formatApiTimestamp(String(episode.activated_at ?? ""), { emptyValue: "unknown" })} · recovery {episode.recovered_at ? formatApiTimestamp(String(episode.recovered_at)) : "not evidenced"}</p>
                  </div>
                ))}
                {regimeEpisodes.length === 0 ? <p className="text-xs text-slate-500">No verified regime-change episode.</p> : null}
              </div>
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-950">Regime-triggered contingent actions</p>
              <div className="mt-2 space-y-2">
                {contingentActivations.slice(0, 6).map((activation, index) => (
                  <div className="rounded-2xl border border-slate-200 px-3 py-2 text-xs" key={String(activation.policy_hash ?? index)}>
                    <p className="font-semibold text-slate-900">{String(activation.activation_status ?? activation.status ?? "DORMANT")} · {String(activation.submission_status ?? "no submit")}</p>
                    <p className="mt-1 text-slate-600">{Array.isArray(activation.trigger_types) ? activation.trigger_types.join(", ") : "No trigger"} · blockers {Array.isArray(activation.blocker_codes) ? activation.blocker_codes.join(", ") || "none" : "none"}</p>
                  </div>
                ))}
                {contingentActivations.length === 0 ? <p className="text-xs text-slate-500">No active trigger episode.</p> : null}
              </div>
            </div>
            <p className="text-xs text-slate-500">Active/recent scenario cooldowns: {scenarioCooldowns.length}. Opposite-side auto-buys remain prohibited after information shocks.</p>
          </CardContent>
        </Card>

        <Card className="rounded-3xl border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle>Conservative edge, reward skew & evidence</CardTitle>
            <CardDescription>Raw probability is haircutted before comparison with market odds; missing or stale evidence fails closed.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-2xl border border-slate-200">
              <table className="min-w-[760px] text-xs">
                <thead className="bg-slate-50 text-left uppercase tracking-wide text-slate-500"><tr><th className="px-3 py-2">Market</th><th className="px-3 py-2">Tier</th><th className="px-3 py-2 text-right">Raw</th><th className="px-3 py-2 text-right">Haircut</th><th className="px-3 py-2 text-right">Conservative edge</th><th className="px-3 py-2 text-right">Reward/loss</th><th className="px-3 py-2">Evidence</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {portfolioAllocations.slice(0, 12).map((row, index) => <tr key={String(row.market_id ?? index)}><td className="max-w-xs px-3 py-2 font-medium"><span className="line-clamp-2">{String(row.question ?? row.market_id)}</span></td><td className="px-3 py-2">{formatLabel(String(row.risk_tier ?? "standard_objective"))}</td><td className="px-3 py-2 text-right">{row.raw_llm_probability == null ? "—" : `${Number(row.raw_llm_probability).toFixed(1)}%`}</td><td className="px-3 py-2 text-right">{row.uncertainty_haircut_pp == null ? "—" : `${Number(row.uncertainty_haircut_pp).toFixed(1)} pp`}</td><td className="px-3 py-2 text-right">{row.conservative_edge_pp == null ? "—" : `${Number(row.conservative_edge_pp).toFixed(1)} pp`}</td><td className="px-3 py-2 text-right">{row.reward_to_loss_ratio == null ? "—" : Number(row.reward_to_loss_ratio).toFixed(3)}</td><td className="px-3 py-2">{asRecord(row.evidence_validation).evidence_complete ? "Fresh / complete" : "Blocked"}</td></tr>)}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-3xl border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle>Certified time & contingent exits</CardTitle>
            <CardDescription>Stage 4 authors every policy, Stage 5 stores dormant actions, and the monitor can only activate exact matching hashes.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {contingentPolicies.slice(0, 10).map((policy, index) => (
              <div className="rounded-2xl border border-slate-200 p-3 text-xs" key={String(policy.policy_hash ?? index)}>
                <p className="font-semibold text-slate-900">{String(policy.affected_market_id ?? "Market")} · {String(policy.permitted_action ?? "exit")}</p>
                <p className="mt-1 text-slate-600">Exit by {formatApiTimestamp(String(policy.must_exit_by ?? ""), { emptyValue: "not set" })} · max {Number(policy.maximum_sell_quantity ?? 0).toFixed(4)} shares · min {String(policy.minimum_acceptable_price ?? "—")}¢</p>
                <p className="mt-1 break-all font-mono text-[10px] text-slate-500">{String(policy.policy_hash ?? "missing hash")}</p>
              </div>
            ))}
            {contingentPolicies.length === 0 ? <p className="rounded-2xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">No certified high-shock exit policy in the latest run.</p> : null}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card className="rounded-3xl border-slate-200 shadow-sm">
          <CardHeader><CardTitle>P&amp;L attribution</CardTitle><CardDescription>Run, decision, contract, cluster, scenario, intent, trigger and calendar-day provenance.</CardDescription></CardHeader>
          <CardContent className="space-y-2">
            {pnlAttribution.slice(0, 10).map((row, index) => <div className="rounded-2xl border border-slate-200 p-3 text-xs" key={String(row.stage5_action_id ?? row.market_id ?? index)}><p className="font-semibold text-slate-900">{String(row.market_id ?? "Market")} · {String(row.final_reconciliation_status ?? "unreconciled")}</p><p className="mt-1 text-slate-600">Current {formatMoney(row.current_value)} · realised {formatMoney(row.realized_pnl)} · unrealised {formatMoney(row.unrealized_pnl)} · fees {formatMoney(row.fees)}</p><p className="mt-1 text-slate-500">Scenario(s): {Array.isArray(row.associated_scenario_ids) ? row.associated_scenario_ids.join(", ") : "none"}</p></div>)}
            {pnlAttribution.length === 0 ? <p className="text-sm text-slate-500">P&amp;L projection appears after the next completed P0 run.</p> : null}
          </CardContent>
        </Card>
        <Card className="rounded-3xl border-slate-200 shadow-sm">
          <CardHeader><CardTitle>Loss-prevention audit</CardTitle><CardDescription>Counterfactual estimates only; they are never reported as realised or avoided P&amp;L.</CardDescription></CardHeader>
          <CardContent className="space-y-2">
            {lossPreventionAudit.slice(0, 10).map((row, index) => <div className="rounded-2xl border border-slate-200 p-3 text-xs" key={String(row.market_id ?? index)}><p className="font-semibold text-slate-900">{String(row.question ?? row.market_id ?? "Market")}</p><p className="mt-1 text-slate-600">Rejected {row.rejected_entry ? "yes" : "no"} · reduced {row.reduced_size ? "yes" : "no"} · top-up blocked {row.blocked_top_up ? "yes" : "no"} · early exit {row.required_early_exit ? "yes" : "no"}</p><p className="mt-1 font-medium text-amber-800">Counterfactual estimate — not an actual realised result.</p></div>)}
            {lossPreventionAudit.length === 0 ? <p className="text-sm text-slate-500">No loss-prevention audit rows yet.</p> : null}
          </CardContent>
        </Card>
      </div>

      <Card className="rounded-3xl border-slate-200 shadow-sm">
        <CardHeader>
          <CardTitle>Event Summary</CardTitle>
          <CardDescription>
            Read-only Stage 4 target rows using the familiar Bullpen event-table density. Every analysed row remains visible, including zero-allocation rejections.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-2xl border border-slate-200">
            <table className="min-w-[1120px] text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Event</th>
                  <th className="px-4 py-3">Side</th>
                  <th className="px-4 py-3 text-right">Current odds</th>
                  <th className="px-4 py-3 text-right">LLM odds</th>
                  <th className="px-4 py-3 text-right">Edge</th>
                  <th className="px-4 py-3 text-right">
                    <span className="inline-flex items-center justify-end gap-1">
                      Returns/day
                      <BullpenReturnsPerDayHeaderInfo onOpen={() => setIsFormulaDialogOpen(true)} />
                    </span>
                  </th>
                  <th className="px-4 py-3 text-right">Risk</th>
                  <th className="px-4 py-3 text-right">Current</th>
                  <th className="px-4 py-3 text-right">Proposed</th>
                  <th className="px-4 py-3 text-right">Target</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {portfolioAllocations.map((row, index) => (
                  <tr key={String(row.market_id ?? index)}>
                    <td className="max-w-md px-4 py-3 font-medium text-slate-900">
                      <span className="line-clamp-2">{String(row.question ?? row.market_id ?? "Unknown market")}</span>
                    </td>
                    <td className="px-4 py-3 font-semibold text-slate-700">{String(row.chosen_side ?? "—")}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{row.current_odds == null ? "—" : `${Number(row.current_odds).toFixed(2)}%`}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{row.llm_odds == null ? "—" : `${Number(row.llm_odds).toFixed(2)}%`}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{row.edge_pp == null ? "—" : `${Number(row.edge_pp).toFixed(2)} pp`}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{row.returns_per_day == null ? "—" : `${Number(row.returns_per_day).toFixed(2)}%`}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{row.risk_score == null ? "—" : Number(row.risk_score).toFixed(2)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatMoney(row.current_exposure_usd)}</td>
                    <td className="px-4 py-3 text-right tabular-nums font-semibold text-sky-700">{formatMoney(row.proposed_buy_usd)}</td>
                    <td className="px-4 py-3 text-right tabular-nums font-semibold text-slate-950">{formatMoney(row.target_exposure_usd)}</td>
                  </tr>
                ))}
                {portfolioAllocations.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-4 py-10 text-center text-slate-500">
                      Run Stages 1–4 to create the first immutable target portfolio.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-3xl border-slate-200 shadow-sm">
        <CardHeader>
          <CardTitle>Held-position alerts</CardTitle>
          <CardDescription>008-only LLM and actual-odds warning episodes. Refresh alerts never create orders.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-2xl border border-slate-200">
            <table className="min-w-[760px] text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3">Market</th><th className="px-4 py-3">Side</th><th className="px-4 py-3">Breach</th><th className="px-4 py-3 text-right">LLM odds</th><th className="px-4 py-3 text-right">Actual odds</th><th className="px-4 py-3">Source</th><th className="px-4 py-3">State</th></tr></thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {(bootstrap?.alerts ?? []).map((alert) => <tr key={alert.id}><td className="px-4 py-3 font-medium text-slate-900">{String(alert.payload.question ?? alert.market_id)}</td><td className="px-4 py-3 font-semibold">{alert.side}</td><td className="px-4 py-3 capitalize">{alert.breach_type}</td><td className="px-4 py-3 text-right tabular-nums">{alert.llm_odds == null ? "—" : `${alert.llm_odds.toFixed(2)}%`}</td><td className="px-4 py-3 text-right tabular-nums">{alert.actual_odds == null ? "—" : `${alert.actual_odds.toFixed(2)}%`}</td><td className="px-4 py-3">{alert.source.replaceAll("_", " ")}</td><td className="px-4 py-3">{alert.recovered_at ? "Recovered" : "Active"}</td></tr>)}
                {(bootstrap?.alerts.length ?? 0) === 0 ? <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-500">No Bullpen 008 warning episodes.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-3xl border-slate-200 shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div><div className="flex items-center gap-2"><History className="h-5 w-5 text-sky-600" /><CardTitle>Run history</CardTitle></div><CardDescription className="mt-2">008 runs are mutable only through 008 endpoints; inherited 007 records are read-only.</CardDescription></div>
          <Link href={URLs.routes.console.bullpen008History()} className="text-sm font-semibold text-sky-700 hover:text-sky-900">View all</Link>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-2xl border border-slate-200">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3">Run</th><th className="px-4 py-3">Source</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Started</th><th className="px-4 py-3">Summary</th></tr></thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {latestRun ? <tr><td className="px-4 py-3"><Link className="font-semibold text-sky-700 hover:text-sky-900" href={URLs.routes.console.bullpen008RunDetail(latestRun.id)}>{latestRun.id}</Link></td><td className="px-4 py-3">Bullpen 008</td><td className="px-4 py-3 capitalize">{latestRun.status}</td><td className="px-4 py-3 whitespace-nowrap">{formatApiTimestamp(latestRun.started_at)}</td><td className="max-w-lg px-4 py-3 text-slate-600">{latestRun.summary}</td></tr> : null}
                {(bootstrap?.inherited_runs ?? []).slice(0, 5).map((run) => <tr key={run.id} className="bg-slate-50/50"><td className="px-4 py-3 font-mono text-xs text-slate-600">{run.id}</td><td className="px-4 py-3"><span className="rounded-full border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-600">Inherited from Bullpen 007</span></td><td className="px-4 py-3 capitalize">{run.status}</td><td className="px-4 py-3 whitespace-nowrap">{formatApiTimestamp(run.started_at)}</td><td className="max-w-lg px-4 py-3 text-slate-600">{run.summary}</td></tr>)}
                {!latestRun && (bootstrap?.inherited_runs.length ?? 0) === 0 ? <tr><td colSpan={5} className="px-4 py-10 text-center text-slate-500">No Bullpen runs are available yet.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {selectedStage ? (
        <BullpenAutoRunStageOutputDialog
          stageTitle={`Stage ${selectedStage.stage_number}: ${selectedStage.stage_name}`}
          stageDetail={`${selectedStage.status.toUpperCase()} · ${formatApiTimestamp(selectedStage.started_at)} to ${formatApiTimestamp(selectedStage.completed_at)} · ${selectedStage.duration_seconds.toFixed(2)} seconds. Pass condition: ${selectedStage.pass_condition}${selectedStage.block_reason ? ` Blocker: ${selectedStage.block_reason}` : ""}`}
          eyebrow={`Bullpen 008 · ${selectedStage.stage_version}`}
          outputLabel="Stage record"
          recordPageSize={25}
          deferRawJson
          outputs={{
            status: selectedStage.status,
            start_time: selectedStage.started_at,
            end_time: selectedStage.completed_at,
            duration_seconds: selectedStage.duration_seconds,
            pass_condition: selectedStage.pass_condition,
            block_reason: selectedStage.block_reason,
            inputs: selectedStage.inputs,
            calculations: selectedStage.calculations,
            outputs: selectedStage.outputs,
            rejections: selectedStage.rejections,
            warnings: selectedStage.warnings,
            data_provenance: selectedStage.provenance,
            stage_version: selectedStage.stage_version,
            prompt_version: selectedStage.prompt_version,
            parser_version: selectedStage.parser_version,
            previous_stage_output_hash: selectedStage.previous_stage_output_hash,
            output_hash: selectedStage.output_hash,
          }}
          onClose={() => setSelectedStage(null)}
        />
      ) : null}
      {isOthersFilterOpen ? (
        <BullpenScanFilterDetailsDialog
          detailId="excludeOthers"
          customKeywords={customPhrases.split(",").map((phrase) => phrase.trim()).filter(Boolean)}
          onSaveCustomKeywords={(phrases) => void saveOtherPhrases(phrases)}
          onClose={() => setIsOthersFilterOpen(false)}
        />
      ) : null}
      {isFormulaDialogOpen ? (
        <BullpenReturnsPerDayFormulaDialog
          loadFormula={loadReturnsFormula}
          saveFormula={saveReturnsFormula}
          onClose={() => setIsFormulaDialogOpen(false)}
        />
      ) : null}
    </div>
  );
}

"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  History,
  Loader2,
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
  Bullpen008StageOutput,
  Bullpen008StageStatus,
} from "@/types/api";
import { BullpenAutoRunStageOutputDialog } from "../../bullpen-ai/_components/BullpenAutoRunStageOutputDialog";

const STAGES = [
  {
    number: 1,
    name: "Discover & Hard Filters",
    detail: "Builds a complete, clean market universe before any LLM request.",
    metricKeys: ["scanned", "accepted", "rejected", "active_positions", "stale_data_errors"],
  },
  {
    number: 2,
    name: "Probability & Structural Risk",
    detail: "Separates calibrated probability from structural contract risk.",
    metricKeys: ["analysed", "chosen_side_llm_odds_gte_80", "positive_edge", "high_risk_rejects", "llm_failures"],
  },
  {
    number: 3,
    name: "Cluster & Dependency Map",
    detail: "Finds mechanically related contracts and broader common catalysts.",
    metricKeys: ["strict_clusters", "common_catalyst_clusters", "duplicates_date_ladders", "largest_current_exposure", "unresolved_adjudications"],
  },
  {
    number: 4,
    name: "Portfolio Optimizer & Stress Test",
    detail: "Deterministically selects targets, sizes them, and verifies every cap.",
    metricKeys: ["selected_contracts", "invested", "cash_retained", "independent_clusters", "stress_test_result"],
  },
  {
    number: 5,
    name: "Execution Planning",
    detail: "Pending Phase 2. No order intents can be created in Phase 1.",
    metricKeys: [],
  },
  {
    number: 6,
    name: "Execution & Reconciliation",
    detail: "Pending Phase 2. No trades can be submitted in Phase 1.",
    metricKeys: [],
  },
] as const;

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
  const metrics = asRecord(stage?.outputs.metrics);
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
  const phase2 = definition.number > 4;
  const status = phase2 ? "disabled" : stage?.status ?? "pending";
  const metrics = metricSource(stage);
  return (
    <button
      type="button"
      disabled={phase2 || !stage}
      onClick={onOpen}
      className={cn(
        "group min-h-64 rounded-3xl border bg-white p-5 text-left shadow-sm transition",
        phase2
          ? "cursor-not-allowed border-dashed border-slate-300 bg-slate-50/70"
          : "border-slate-200 hover:-translate-y-0.5 hover:border-sky-300 hover:shadow-lg disabled:translate-y-0 disabled:cursor-default disabled:hover:border-slate-200 disabled:hover:shadow-sm",
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
          {phase2 ? "Pending Phase 2" : status}
        </span>
      </div>
      <p className="mt-3 text-sm leading-6 text-slate-600">{definition.detail}</p>
      <div className="mt-5 grid grid-cols-2 gap-2">
        {definition.metricKeys.map((key) => (
          <div key={key} className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{formatLabel(key)}</p>
            <p className="mt-1 text-sm font-semibold text-slate-900">{formatMetric(key, metrics[key])}</p>
          </div>
        ))}
        {phase2 ? (
          <div className="col-span-2 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-3 text-xs font-medium text-amber-900">
            Disabled in Phase 1 · orders permitted: no
          </div>
        ) : null}
      </div>
      {stage ? (
        <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3 text-xs text-slate-500">
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
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [customPhrases, setCustomPhrases] = useState("");
  const [closingWindowDays, setClosingWindowDays] = useState("30");
  const [autoRefreshMinutes, setAutoRefreshMinutes] = useState("360");

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await apiService.getBullpen008Bootstrap({ signal });
      setBootstrap(data);
      setCustomPhrases(data.settings.custom_exclude_phrases.join(", "));
      setClosingWindowDays(String(data.settings.closing_window_days));
      setAutoRefreshMinutes(String(data.settings.auto_refresh_minutes));
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
  const invested = positions.reduce(
    (total, row) => total + Number(row.current_value_usd ?? row.exposure_usd ?? 0),
    0,
  );
  const cash = Number(balance.available_balance_usd ?? 0);
  const portfolioValue = invested + cash;

  const runOnce = async () => {
    setBusyAction("run");
    setError(null);
    try {
      await apiService.runBullpen008Once(`bullpen008-ui-${Date.now()}`);
      await load();
    } catch (actionError) {
      setError(`The shadow run could not be queued. ${formatUnknownError(actionError)}`);
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
      });
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
              <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800">Shadow mode · no orders</span>
            </div>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">Bullpen 008</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              Isolated six-stage evolution of Bullpen 007. Phase 1 executes Stages 1–4 and can never create an order intent or submit a trade.
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
            <Button onClick={() => void runOnce()} disabled={Boolean(busyAction) || Boolean(latestRun && !TERMINAL_RUN_STATUSES.has(latestRun.status))}>
              {busyAction === "run" || (latestRun && !TERMINAL_RUN_STATUSES.has(latestRun.status)) ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
              Run Stages 1–4
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
            <CardDescription className="mt-2">A stage is Finished only after its recorded pass condition succeeds.</CardDescription>
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
                if (stage) setSelectedStage(stage);
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
                      <td className="px-4 py-3 text-right tabular-nums font-semibold text-slate-900">{formatMoney(position.current_value_usd)}</td>
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
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-xs leading-5 text-slate-600">
              Entry floor {bootstrap?.settings.entry_side_odds_floor_pct}% · LLM floor {bootstrap?.settings.min_llm_probability_pct}% · $5 increments · $20 contract and cluster caps.
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void saveSettings()} disabled={Boolean(busyAction)}>{busyAction === "settings" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}Save 008 settings</Button>
              <Button variant="outline" onClick={() => void toggleScheduler()} disabled={Boolean(busyAction)}>{busyAction === "scheduler" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Clock3 className="mr-2 h-4 w-4" />}{bootstrap?.state.running ? "Stop schedule" : "Start schedule"}</Button>
            </div>
            <p className="text-xs text-slate-500">Next run: {formatApiTimestamp(bootstrap?.state.next_run_at, { emptyValue: "Not scheduled" })}</p>
          </CardContent>
        </Card>
      </div>

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
    </div>
  );
}

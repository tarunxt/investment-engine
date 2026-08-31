"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Database, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { apiService } from "@/services/api";
import { cn } from "@/lib/utils";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asFiniteNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatCount(value: number | null) {
  return value === null ? "—" : value.toLocaleString("en-US");
}

type UniverseSnapshot = {
  upstreamEventsDiscovered: number | null;
  marketsMaterializedForStage1: number | null;
  dataUpstreamExcluded: number | null;
  stage1Accepted: number | null;
  universeComplete: boolean | null;
  warning: string | null;
  stageStatus: string | null;
};

const EMPTY_SNAPSHOT: UniverseSnapshot = {
  upstreamEventsDiscovered: null,
  marketsMaterializedForStage1: null,
  dataUpstreamExcluded: null,
  stage1Accepted: null,
  universeComplete: null,
  warning: null,
  stageStatus: null,
};

export function Bullpen008UniverseAccounting() {
  const [snapshot, setSnapshot] = useState<UniverseSnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const bootstrap = await apiService.getBullpen008Bootstrap();
      const latestRun = bootstrap.latest_run;
      if (!latestRun) {
        setSnapshot(EMPTY_SNAPSHOT);
        setError(null);
        return;
      }

      const stage1Summary = latestRun.stages.find((stage) => stage.stage_number === 1);
      if (!stage1Summary) {
        setSnapshot({ ...EMPTY_SNAPSHOT, stageStatus: "pending" });
        setError(null);
        return;
      }

      const stage1 = await apiService.getBullpen008Stage(latestRun.id, 1);
      const inputs = asRecord(stage1.inputs);
      const sourceScan = asRecord(inputs.source_scan);
      const outputs = asRecord(stage1.outputs);
      const metrics = asRecord(outputs.metrics);

      const upstreamEventsDiscovered = asFiniteNumber(sourceScan.total_candidates);
      const marketsMaterializedForStage1 = asFiniteNumber(metrics.scanned);
      const stage1Accepted = asFiniteNumber(metrics.accepted);
      const dataUpstreamExcluded =
        upstreamEventsDiscovered !== null && marketsMaterializedForStage1 !== null
          ? Math.max(0, upstreamEventsDiscovered - marketsMaterializedForStage1)
          : null;

      const outputComplete = outputs.universe_complete;
      const sourceComplete = sourceScan.complete_universe;
      const universeComplete =
        typeof outputComplete === "boolean"
          ? outputComplete
          : typeof sourceComplete === "boolean"
            ? sourceComplete
            : null;

      setSnapshot({
        upstreamEventsDiscovered,
        marketsMaterializedForStage1,
        dataUpstreamExcluded,
        stage1Accepted,
        universeComplete,
        warning:
          typeof sourceScan.warning === "string" && sourceScan.warning.trim()
            ? sourceScan.warning
            : null,
        stageStatus: stage1.status,
      });
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(interval);
  }, [load]);

  const incomplete = snapshot.universeComplete === false;
  const complete = snapshot.universeComplete === true;

  return (
    <section
      className={cn(
        "rounded-3xl border p-5 shadow-sm",
        incomplete
          ? "border-rose-300 bg-rose-50"
          : "border-slate-200 bg-white",
      )}
      aria-label="Bullpen 008 Stage 1 universe accounting"
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-3">
          <div
            className={cn(
              "mt-0.5 rounded-2xl p-2.5",
              incomplete ? "bg-rose-100 text-rose-700" : "bg-sky-50 text-sky-700",
            )}
          >
            {incomplete ? <AlertTriangle className="h-5 w-5" /> : <Database className="h-5 w-5" />}
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold text-slate-950">Stage 1 universe accounting</h2>
              {incomplete ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-rose-300 bg-rose-100 px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-rose-800">
                  <AlertTriangle className="h-3.5 w-3.5" /> Universe incomplete — Stage 1 cannot certify
                </span>
              ) : complete ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Universe complete
                </span>
              ) : (
                <span className="rounded-full border border-slate-200 bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">Awaiting certification</span>
              )}
            </div>
            <p className="mt-1 max-w-4xl text-sm leading-6 text-slate-600">
              Separates the broad upstream discovery count from the markets that were actually materialized into Bullpen 008 Stage 1, so the Stage 1 “scanned” number is no longer confused with total upstream discovery.
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
          Refresh accounting
        </Button>
      </div>

      {error ? (
        <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-100/70 px-4 py-3 text-sm text-rose-800" role="alert">
          Universe accounting could not be loaded: {error}
        </div>
      ) : null}

      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Upstream Events Discovered" value={formatCount(snapshot.upstreamEventsDiscovered)} />
        <MetricCard label="Markets Materialized for Stage 1" value={formatCount(snapshot.marketsMaterializedForStage1)} />
        <MetricCard label="Data / Upstream Excluded" value={formatCount(snapshot.dataUpstreamExcluded)} />
        <MetricCard label="Stage-1 Accepted" value={formatCount(snapshot.stage1Accepted)} />
      </div>

      <div className="mt-4 flex flex-col gap-1 text-xs leading-5 text-slate-600 sm:flex-row sm:flex-wrap sm:gap-x-5">
        <span>
          <strong className="text-slate-800">Upstream excluded</strong> = discovered candidates minus Stage-1 materialized markets. It is not the same as Bullpen 008 hard-filter rejections.
        </span>
        {snapshot.stageStatus ? (
          <span>
            Recorded Stage-1 status: <strong className={incomplete ? "text-rose-800" : "text-slate-800"}>{snapshot.stageStatus}</strong>
          </span>
        ) : null}
        {snapshot.warning ? <span className="font-semibold text-rose-800">Source warning: {snapshot.warning}</span> : null}
      </div>
    </section>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white/90 px-4 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">{label}</p>
      <p className="mt-1.5 text-xl font-semibold tabular-nums text-slate-950">{value}</p>
    </div>
  );
}

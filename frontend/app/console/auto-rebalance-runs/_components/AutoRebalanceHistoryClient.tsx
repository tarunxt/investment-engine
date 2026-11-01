"use client";

import Link from "next/link";
import { RunSideEffectPolicyNotice } from "@/components/shared/AnalysisOnlyRunControl";
import { RUN_HIERARCHY_HELP } from "@/lib/runHierarchy";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ChevronRight,
  Clock3,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";

import { getStageTileLabel } from "@/components/shared/WorkflowStageTile";
import { Button } from "@/components/ui/button";
import { URLs } from "@/lib/urls";
import { formatApiTimestamp, parseApiTimestamp } from "@/lib/datetime";
import { outputAttribution } from "@/lib/outputProvenance";
import { apiService } from "@/services/api";
import type {
  AutoRebalanceHistoryDetailResponse,
  AutoRebalanceHistoryItemResponse,
  AutoRebalanceJobDetailResponse,
  AutoRebalanceStageResponse,
} from "@/types/api";

export type AutoRebalanceHistoryPortfolio = "zerodha" | "indmoneyUs";

const STAGE_LABELS = {
  sync: getStageTileLabel("sync"),
  threats: getStageTileLabel("threats"),
  swing: getStageTileLabel("swing"),
  rebalance: getStageTileLabel("rebalance"),
  technical: getStageTileLabel("technical"),
  actionables: getStageTileLabel("actionables"),
} as const;

function apiPortfolio(portfolio: AutoRebalanceHistoryPortfolio) {
  return portfolio === "zerodha" ? "india" : "indmoney_us";
}

function portfolioLabel(portfolio: AutoRebalanceHistoryPortfolio) {
  return portfolio === "zerodha" ? "Zerodha" : "IndMoney";
}

function statusTone(status?: string | null) {
  const value = (status || "").toLowerCase();
  if (["failed", "cancelled", "interrupted"].includes(value))
    return "border-rose-200 bg-rose-50 text-rose-800";
  if (["partial", "skipped", "paused"].includes(value))
    return "border-amber-200 bg-amber-50 text-amber-800";
  if (["completed", "success"].includes(value))
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (["queued", "pending", "processing", "running"].includes(value))
    return "border-sky-200 bg-sky-50 text-sky-800";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function stageCardTone(status?: string | null) {
  const value = (status || "").toLowerCase();
  if (["failed", "cancelled", "interrupted"].includes(value))
    return "border-rose-200 bg-rose-50/70";
  if (["partial", "skipped", "paused"].includes(value))
    return "border-amber-200 bg-amber-50/70";
  if (["completed", "success"].includes(value)) return "border-emerald-200 bg-emerald-50/70";
  if (["queued", "pending", "processing", "running"].includes(value)) return "border-sky-200 bg-sky-50/70";
  return "border-slate-200 bg-white";
}

function formatTime(value?: string | null) {
  return formatApiTimestamp(value, {
    emptyValue: "Not available",
    locale: "en-IN",
    timeZone: "Asia/Kolkata",
    timeZoneName: "short",
  });
}

function formatCost(value?: number | null) {
  if (!value) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  }).format(value);
}

function StatusBadge({ status }: { status?: string | null }) {
  return (
    <span className={`inline-flex max-w-full rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.14em] ${statusTone(status)}`}>
      {status || "Unknown"}
    </span>
  );
}

function StageSummary({ stage }: { stage: AutoRebalanceStageResponse }) {
  const label = STAGE_LABELS[stage.stage];
  const started = parseApiTimestamp(stage.started_at);
  const finished = parseApiTimestamp(stage.completed_at);
  const invalidInterval = started !== null && finished !== null && finished.getTime() < started.getTime();
  return (
    <div className={`min-w-0 rounded-xl border p-4 [overflow-wrap:anywhere] ${stageCardTone(stage.status)}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-28">
          <p className="font-semibold text-slate-950">{label}</p>
          <p className="mt-1 text-xs text-slate-600">
            {stage.provider_count
              ? `${stage.completed_provider_count}/${stage.provider_count} LLMs completed`
              : "System stage"}
          </p>
        </div>
        <StatusBadge status={stage.status} />
      </div>
      <div className="mt-3 grid gap-2 text-xs text-slate-700 sm:grid-cols-2">
        <span>Started: {formatTime(stage.started_at)}</span>
        <span>Finished: {formatTime(stage.completed_at)}</span>
        <span>LLM cost: {formatCost(stage.estimated_cost)}</span>
        <span>Passed LLMs: {Math.max(0, stage.completed_provider_count - (stage.partial_provider_count ?? 0))}</span>
        <span>Partial LLMs: {stage.partial_provider_count ?? 0}</span>
        <span>Failed LLMs: {stage.failed_provider_count}</span>
      </div>
      {invalidInterval ? (
        <p role="note" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs font-semibold leading-5 text-amber-900">
          Invalid interval: recorded finish is before recorded start. Original timestamps are preserved; elapsed duration cannot be determined reliably.
        </p>
      ) : null}
      {typeof stage.summary?.partial_notice === "string" ? <p className="mt-3 text-xs text-amber-800">{stage.summary.partial_notice}</p> : null}
      {stage.error_message ? (
        <div className="mt-3 flex gap-2 rounded-lg border border-rose-200 bg-white/70 p-3 text-xs leading-5 text-rose-800">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0">{stage.error_message}</span>
        </div>
      ) : null}
    </div>
  );
}

export function AutoRebalanceHistoryListClient({
  portfolio,
}: {
  portfolio: AutoRebalanceHistoryPortfolio;
}) {
  const [items, setItems] = useState<AutoRebalanceHistoryItemResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiService.getAutoRebalanceHistory(apiPortfolio(portfolio), { limit: 100 });
      setItems(response.items);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load auto-rebalance history.");
    } finally {
      setLoading(false);
    }
  }, [portfolio]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <section className="mx-auto max-w-7xl space-y-6 pb-10">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-500">
            <Clock3 className="size-4" /> Run history
          </div>
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-slate-950">
            {portfolioLabel(portfolio)} Auto-Rebalance Runs
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            Each tile is one recorded auto-rebalance attempt. Saved statuses and stages do not verify current worker activity. Component completion does not establish that the full run finished. Open a tile for stage outputs, errors, prompts, and LLM-level diagnostics.
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline" className="rounded-full">
            <Link href={URLs.routes.console.dashboard()}><ArrowLeft className="mr-2 size-4" />Dashboard</Link>
          </Button>
          <Button type="button" onClick={() => void load()} className="rounded-full bg-slate-950 text-white hover:bg-slate-800">
            <RefreshCw className="mr-2 size-4" />Refresh
          </Button>
        </div>
      </div>

      {loading ? <div className="flex min-h-56 items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white text-sm text-slate-600"><Loader2 className="size-4 animate-spin" />Loading runs…</div> : null}
      {error ? <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</div> : null}
      {!loading && !error && items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-600">No {portfolioLabel(portfolio)} auto-rebalance runs have been recorded yet.</div>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        {items.map((item, index) => (
          <Link
            key={`${item.portfolio}-${item.sequence}`}
            href={URLs.routes.console.autoRebalanceRunDetail(portfolio, item.sequence)}
            className={`group min-w-0 rounded-2xl border p-5 [overflow-wrap:anywhere] shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${index === 0 ? "border-indigo-300 bg-indigo-50/60 ring-1 ring-indigo-100" : stageCardTone(item.status)}`}
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 flex-1 basis-48">
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">{index === 0 ? "Latest auto run" : "Auto run"}</p>
                <h2 className="mt-1 text-xl font-bold text-slate-950">{item.label}</h2>
                <RunSideEffectPolicyNotice policy={item.side_effect_policy} />
                <p className="mt-1 text-sm text-slate-600">Started {formatTime(item.created_at)}</p>
              </div>
              <div className="flex max-w-full items-center gap-2"><span className="text-xs text-slate-600">Saved status <StatusBadge status={item.status} /></span><ChevronRight className="size-5 text-slate-400 transition group-hover:translate-x-0.5" /></div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div><p className="text-xs text-slate-500">Last recorded stage</p><p className="mt-1 font-semibold text-slate-900">{item.current_stage ? STAGE_LABELS[item.current_stage] : "Not recorded"}</p></div>
              <div><p className="text-xs text-slate-500">Stages</p><p className="mt-1 font-semibold text-slate-900">{item.stages.filter((stage) => stage.status === "completed").length}/{item.stages.length || 6}</p></div>
              <div><p className="text-xs text-slate-500">LLM cost</p><p className="mt-1 font-semibold text-slate-900">{formatCost(item.total_estimated_cost)}</p></div>
              <div><p className="text-xs text-slate-500">Finished</p><p className="mt-1 font-semibold text-slate-900">{item.completed_at ? formatTime(item.completed_at) : "Not recorded"}</p></div>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-3">
              {item.stages.map((stage) => <StageSummary key={stage.stage} stage={stage} />)}
            </div>
            {item.error_message ? <p className="mt-4 line-clamp-2 text-sm text-rose-800">Stopped because: {item.error_message}</p> : null}
          </Link>
        ))}
      </div>
    </section>
  );
}

function JobDetails({ job }: { job: AutoRebalanceJobDetailResponse }) {
  const attribution = outputAttribution(job);
  return (
    <article className={`min-w-0 rounded-xl border p-4 [overflow-wrap:anywhere] ${stageCardTone(job.status)}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0"><p className="font-semibold text-slate-950">Requested: {job.provider} / {job.model}</p><p className="mt-1 text-xs text-slate-600">Provider job #{job.id} · Job updated: {formatTime(job.updated_at)} · {formatCost(job.estimated_cost)}</p></div>
        <StatusBadge status={job.status} />
      </div>
      <div className="mt-3 space-y-1 text-xs text-slate-700">
        <p>Job created: {formatTime(job.created_at)}</p>
        {attribution.identities.length ? <>
          <p>Provider-response telemetry: {attribution.identities.map(identity => `${identity.provider} / ${identity.model || "model not reported"}`).join("; ")}</p>
          <p>Successful calls observed: {formatTime(job.output_provenance?.observed_from)} to {formatTime(job.output_provenance?.observed_to)}. May include repair calls; telemetry coverage may be incomplete.</p>
        </> : <p>Execution identity unavailable: no successful provider-response telemetry is recorded for this job. Requested settings do not verify which model produced the output.</p>}
        <p>Original generated text is preserved below. Its model names and source dates are unverified content, distinct from job timestamps and telemetry observation times.</p>
        {attribution.conflict ? <p role="note" className="rounded border border-amber-200 bg-amber-50 p-2 text-amber-900">Attribution conflict: the generated model header differs from {attribution.comparison === "telemetry" ? "provider-response telemetry" : "requested job settings"}. Generated self-identification is untrusted; do not use it to attribute provider or cost.</p> : null}
      </div>
      {job.error_message ? <div className={`mt-3 rounded-lg border bg-white/70 p-3 text-sm ${job.status === "partial" ? "border-amber-200 text-amber-800" : "border-rose-200 text-rose-800"}`}>{job.error_message}</div> : null}
      <div className="mt-3 grid gap-2 text-xs text-slate-700 sm:grid-cols-3"><span>Input tokens: {job.tokens_in ?? "—"}</span><span>Output tokens: {job.tokens_out ?? "—"}</span><span>Web search: {job.web_search_used ? "used" : "not used"}</span></div>
      <details className="mt-3 rounded-lg border border-slate-200 bg-white"><summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-slate-800">Prompt and response</summary><div className="space-y-3 border-t border-slate-200 p-3"><pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-950 p-3 text-xs leading-5 text-slate-100">{job.prompt}</pre><pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded bg-slate-950 p-3 text-xs leading-5 text-slate-100">{job.response || "No model output was saved."}</pre></div></details>
      {job.runtime_metadata_json ? <details className="mt-2 rounded-lg border border-slate-200 bg-white"><summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-slate-800">Runtime metadata</summary><pre className="max-h-72 overflow-auto border-t border-slate-200 bg-slate-950 p-3 text-xs leading-5 text-slate-100">{JSON.stringify(job.runtime_metadata_json, null, 2)}</pre></details> : null}
    </article>
  );
}

export function AutoRebalanceHistoryDetailClient({
  portfolio,
  sequence,
}: {
  portfolio: AutoRebalanceHistoryPortfolio;
  sequence: number;
}) {
  const [run, setRun] = useState<AutoRebalanceHistoryDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRun(await apiService.getAutoRebalanceHistoryDetail(apiPortfolio(portfolio), sequence));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load auto-rebalance detail.");
    } finally {
      setLoading(false);
    }
  }, [portfolio, sequence]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  const jobs = useMemo(() => run ? [...run.standalone_jobs, ...run.runs.flatMap((item) => item.jobs)] : [], [run]);

  return (
    <section className="mx-auto max-w-7xl space-y-6 pb-10">
      <nav aria-label="Run hierarchy" className="flex flex-wrap gap-2 text-sm"><Link className="text-blue-700 underline" href={URLs.routes.console.runs()}>All runs</Link><span aria-hidden="true">/</span><span aria-current="page">Workflow · {run?.label || `Run #${sequence}`}</span></nav>
      <p className="text-xs text-slate-500">{RUN_HIERARCHY_HELP}</p>
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div><p className="text-sm font-semibold text-slate-500">{portfolioLabel(portfolio)} Auto-Rebalance · Detailed audit</p><h1 className="mt-1 text-3xl font-bold tracking-tight text-slate-950">{run?.label || `Run #${sequence}`}</h1><RunSideEffectPolicyNotice policy={run?.side_effect_policy} /><p className="mt-2 text-sm text-slate-600">Stage-by-stage saved status, the exact errors, and every saved LLM prompt/output. Saved statuses do not verify current worker activity.</p></div>
        <div className="flex gap-2"><Button asChild variant="outline" className="rounded-full"><Link href={URLs.routes.console.autoRebalanceRuns(portfolio)}><ArrowLeft className="mr-2 size-4" />All runs</Link></Button><Button type="button" onClick={() => void load()} className="rounded-full bg-slate-950 text-white hover:bg-slate-800"><RefreshCw className="mr-2 size-4" />Refresh</Button></div>
      </div>
      {loading ? <div className="flex min-h-56 items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white text-sm text-slate-600"><Loader2 className="size-4 animate-spin" />Loading run detail…</div> : null}
      {error ? <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</div> : null}
      {run ? <>
        <div className={`rounded-2xl border p-5 ${stageCardTone(run.status)}`}><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2 text-slate-900">{run.status === "failed" ? <XCircle className="size-5 text-rose-600" /> : <Clock3 className="size-5 text-slate-600" />}<span className="font-semibold">{run.status === "failed" ? "Run stopped" : "Run summary"}</span></div><span className="text-xs text-slate-600">Saved status <StatusBadge status={run.status} /></span></div><div className="mt-4 grid gap-3 text-sm sm:grid-cols-4"><span>Started: {formatTime(run.created_at)}</span><span>Finished: {formatTime(run.completed_at)}</span><span>Last recorded stage: {run.current_stage ? STAGE_LABELS[run.current_stage] : "—"}</span><span>Total LLM cost: {formatCost(run.total_estimated_cost)}</span></div>{run.error_message ? <div className="mt-4 rounded-lg border border-rose-200 bg-white/70 p-3 text-sm text-rose-800">{run.error_message}</div> : null}</div>
        {run.stages.filter(stage => stage.stage === "actionables" && stage.summary.frozen_final).map(stage => (
          <details key="frozen-final" className="rounded-xl border bg-white p-4">
            <summary className="cursor-pointer font-semibold">Saved final calculation — original formula and source evidence</summary>
            <p className="my-2 text-sm">Captured when this workflow completed. Current formula changes do not alter these rows.</p>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(stage.summary.frozen_final, null, 2)}</pre>
          </details>
        ))}
        <div><h2 className="text-xl font-bold text-slate-950">Stage timeline</h2><p className="mt-1 text-sm text-slate-600">Color indicates completion (green), active work (blue), warnings (amber), and the exact failure point (red).</p><div className="mt-4 grid gap-3 lg:grid-cols-2">{run.stages.map((stage) => <StageSummary key={stage.stage} stage={stage} />)}</div></div>
        <div><h2 className="text-xl font-bold text-slate-950">LLM diagnostics and saved output</h2><p className="mt-1 text-sm text-slate-600">Outputs are preserved per provider/model; failed work remains visible with its error rather than disappearing from the audit trail.</p><div className="mt-4 space-y-3">{jobs.length ? jobs.map((job) => <JobDetails key={job.id} job={job} />) : <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600">No LLM job was created for this run yet.</div>}</div></div>
      </> : null}
    </section>
  );
}

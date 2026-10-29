'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ElementType } from 'react';
import Link from 'next/link';
import { useParams, usePathname, useRouter } from 'next/navigation';
import {useSession} from 'next-auth/react';
import {useWorkspaceDisplay} from '@/components/workspace/WorkspaceDisplay';
import {ConceptFSavedText} from '@/components/workspace/ConceptFSavedText';
import {recordedTokenCount} from '@/lib/recordedTokenDisplay';
import {admitRecordedRun,recordedRunUsage} from '@/lib/recordedRun';
import {safeResearchData} from '@/lib/conceptFResearch';
import {
  AlertCircle,
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  Clock3,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiService, APIError } from '@/services/api';
import { WSClient } from '@/services/websocket';
import { URLs } from '@/lib/urls';
import { type RunResponse } from '@/types/api';
import { cn } from '@/lib/utils';
import { formatUsdAsVerifiedInr } from '@/lib/fxPresentation';
import InvestmentRecommendationTable from '@/components/InvestmentRecommendationTable';
import { OutputConsistencyNotice } from '@/components/OutputConsistencyNotice';
import {
  getAutoRebalanceRunDisplayLabel,
  getJobSheetsPresentation,
  getRunDetailPathFromPrompt,
  getRunLabelFromPrompt,
} from '@/lib/runPresentation';

const STATUS_STYLES: Record<string, string> = {
  scheduled: 'bg-violet-50 text-violet-700 ring-violet-200',
  pending: 'bg-amber-50 text-amber-700 ring-amber-200',
  processing: 'bg-blue-50 text-blue-700 ring-blue-200',
  completed: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  failed: 'bg-red-50 text-red-700 ring-red-200',
};

const STATUS_ICONS: Record<string, ElementType> = {
  scheduled: CalendarClock,
  pending: Clock3,
  processing: Loader2,
  completed: CheckCircle2,
  failed: AlertCircle,
};

const ACTIVE_STATUSES = new Set(['pending', 'processing']);
const TERMINAL_STATUSES = new Set(['completed', 'failed']);
const RUN_DETAIL_ROUTE_PREFIXES = [
  '/console/runs/',
  '/console/zerodha-swing-run/',
  '/console/indmoney-us-swing-run/',
];

const SHEETS_STATUS_STYLES: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700 ring-amber-200',
  queued: 'bg-blue-50 text-blue-700 ring-blue-200',
  processing: 'bg-blue-50 text-blue-700 ring-blue-200',
  completed: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  failed: 'bg-red-50 text-red-700 ring-red-200',
  partial: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
};

const parseApiTimestamp = (value: string) =>
  /[zZ]|[+-]\d{2}:\d{2}$/.test(value) ? new Date(value) : new Date(`${value}Z`);

function normalizeError(error: unknown) {
  if (error instanceof APIError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong';
}

function getCurrentHashTargetId() {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return null;
  try {
    return decodeURIComponent(hash);
  } catch {
    return hash;
  }
}

function scrollToHashTarget() {
  const targetId = getCurrentHashTargetId();
  if (!targetId) return;
  document.getElementById(targetId)?.scrollIntoView({
    behavior: 'smooth',
    block: 'start',
  });
}

function formatTokens(value?: number | null) {
  return value?.toLocaleString() ?? '0';
}

function formatCostInr(value?: number | null, usdInrRate = 0) {
  if (value == null || !Number.isFinite(value)) return 'Not captured';
  return formatUsdAsVerifiedInr(value, usdInrRate);
}

function hasKnownCost(value?: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRunDetailPath(pathname?: string | null) {
  return Boolean(pathname && RUN_DETAIL_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix)));
}

function formatDuration(createdAt: string, updatedAt?: string) {
  if (!updatedAt) return null;
  const start = parseApiTimestamp(createdAt).getTime();
  const end = parseApiTimestamp(updatedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;

  const totalSeconds = Math.floor((end - start) / 1000);
  if (totalSeconds < 60) return `${totalSeconds} sec`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes} min ${seconds} sec`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours} hr ${remMinutes} min ${seconds} sec`;
}

export default function RunDetailPage() {
  const params = useParams<{ id: string | string[] }>();
  const router = useRouter();
  const pathname = usePathname();
  const idParam = Array.isArray(params.id) ? params.id[0] : params.id;
  const runId = Number(idParam);
  const uat2=process.env.NEXT_PUBLIC_UAT2==='true';
  const {data:session,status:sessionStatus}=useSession();const display=useWorkspaceDisplay(),masked=display?.value.masked??true;
  const scope=uat2?`${sessionStatus}:${session?.user?.id}:${session?.generation}:${idParam}`:'legacy';
  const mayRead=!uat2||(sessionStatus==='authenticated'&&Boolean(session?.user?.id));
  const activeScope=useRef<string|null>(null),readController=useRef<AbortController|null>(null);
  const [readScope,setReadScope]=useState('');
  const hasValidRunId = uat2?/^[1-9][0-9]{0,12}$/.test(String(idParam)):Number.isInteger(runId) && runId > 0;
  const [run, setRun] = useState<RunResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [usdInrRate, setUsdInrRate] = useState(0);

  const generationRef = useRef(0);
  const wsClientRef = useRef<WSClient | null>(null);
  const lastHashScrollRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (!uat2) return;
    activeScope.current = scope;
    return () => {
      activeScope.current = null;
      generationRef.current += 1;
      readController.current?.abort();
    };
  }, [scope, uat2]);

  const loadRun = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (!hasValidRunId) {
        setLoading(false);
        setError('Invalid run id.');
        return;
      }

      if(uat2&&scope!==activeScope.current)return;
      const gen = ++generationRef.current,controller=uat2?new AbortController():null;
      if(uat2){readController.current?.abort();readController.current=controller;setRun(null);setError(null);}
      if (!silent||uat2) setLoading(true);
      try {
        const raw = uat2?await apiService.get<RunResponse>(URLs.runs.get(runId),{signal:controller!.signal,cache:'no-store',timeoutMs:8000}):await apiService.getRun(runId);
        if (gen !== generationRef.current||uat2&&scope!==activeScope.current) return;
        const data=uat2?admitRecordedRun(raw,runId):raw;
        setRun(data);setReadScope(scope);
        setError(null);

        const canonicalPath = getRunDetailPathFromPrompt(data.id, data.prompt);
        if (isRunDetailPath(pathname) && canonicalPath !== pathname) {
          const hash = typeof window !== 'undefined' ? window.location.hash : '';
          router.replace(`${canonicalPath}${hash}`);
        }
      } catch (err) {
        if (gen !== generationRef.current) return;
        if(uat2&&scope!==activeScope.current)return;setError(uat2?'Requested saved run could not be verified. No other run or successful empty outcome is inferred.':normalizeError(err));setReadScope(scope);
      } finally {
        if (gen === generationRef.current && !silent) setLoading(false);
      }
    },
    [hasValidRunId, pathname, router, runId, scope, uat2],
  );

  useEffect(() => {
    if (!hasValidRunId || !mayRead) return;

    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadRun();
    if(uat2)return()=>{generationRef.current++;readController.current?.abort();};
    apiService
      .getApiUsageSummary()
      .then((summary) => {
        if (summary.fx_status === 'valid' && summary.usd_inr_rate && summary.usd_inr_rate > 0) {
          setUsdInrRate(summary.usd_inr_rate);
        } else {
          setUsdInrRate(0);
        }
      })
      .catch(() => setUsdInrRate(0));

    const client = new WSClient({
      url: URLs.runs.wsRun(runId),
      onStatusChange: setWsConnected,
      onMessage: (data) => {
        if (data.type === 'job.updated') {
          const jobId = data.job_id as number;
          setRun((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              run_jobs: (prev.run_jobs ?? []).map((rj) =>
                rj.job.id === jobId
                  ? {
                    ...rj,
                    job: {
                      ...rj.job,
                      status: data.status as string,
                      response: (data.response as string | null) ?? rj.job.response,
                      error_message: (data.error_message as string | null) ?? rj.job.error_message,
                      tokens_in: (data.tokens_in as number | null) ?? rj.job.tokens_in,
                      tokens_out: (data.tokens_out as number | null) ?? rj.job.tokens_out,
                      estimated_cost: (data.estimated_cost as number | null) ?? rj.job.estimated_cost,
                      updated_at: (data.updated_at as string | undefined) ?? rj.job.updated_at,
                    },
                  }
                  : rj,
              ),
            };
          });
        } else if (data.type === 'run.updated') {
          setRun((prev) =>
            prev
              ? { ...prev, status: data.status as string, current_stage: data.current_stage as number }
              : prev,
          );
        }
      },
    });
    wsClientRef.current = client;
    client.connect();

    return () => {
      generationRef.current += 1;
      wsClientRef.current?.close();
      wsClientRef.current = null;
    };
  }, [hasValidRunId, loadRun, runId, mayRead, uat2]);

  useEffect(() => {
    if (loading || !run || typeof window === 'undefined') return;
    const hash = window.location.hash;
    if (!hash || lastHashScrollRef.current === hash) return;
    lastHashScrollRef.current = hash;
    scrollToHashTarget();
    const retryId = window.setTimeout(scrollToHashTarget, 150);
    return () => window.clearTimeout(retryId);
  }, [loading, run]);

  if (!hasValidRunId) {
    return (
      <div data-uat2-recorded-run={uat2?"true":undefined} className="mx-auto flex flex-col gap-6">
        <button
          onClick={() => router.back()}
          className="inline-flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft className="size-4" />
          Back
        </button>
        <div className="flex items-start gap-3 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>Invalid run id.</span>
        </div>
      </div>
    );
  }

  if (loading||uat2&&readScope!==scope) {
    return (
      <div data-uat2-recorded-run={uat2?"true":undefined} className="mx-auto flex flex-col gap-6">
        <div className="flex items-center gap-3 text-sm text-gray-500">
          <Loader2 className="size-4 animate-spin" />
          Loading run…
        </div>
      </div>
    );
  }

  if (error || !run) {
    return (
      <div data-uat2-recorded-run={uat2?"true":undefined} className="mx-auto flex flex-col gap-6">
        <button
          onClick={() => router.back()}
          className="inline-flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft className="size-4" />
          Back
        </button>
        <div className="flex items-start gap-3 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error ?? 'Run not found.'}</span>
        </div>
      </div>
    );
  }

  const StatusIcon = STATUS_ICONS[run.status] ?? Clock3;
  const isActive = ACTIVE_STATUSES.has(run.status);
  const runLabel = run.auto_rebalance_label
    ? getAutoRebalanceRunDisplayLabel(run)
    : getRunLabelFromPrompt(run.id, run.prompt);
  const runJobs = run.run_jobs ?? [];
  const knownCostJobs = runJobs.filter((rj) => hasKnownCost(rj.job.estimated_cost));
  const totalKnownCost = knownCostJobs.reduce((sum, rj) => sum + (rj.job.estimated_cost ?? 0), 0);
  const missingCostCount = runJobs.length - knownCostJobs.length;
  const hasAnyKnownCost = knownCostJobs.length > 0;
  const usage=uat2?recordedRunUsage(run):null;
  const formatCostWithInr = (value?: number | null) => uat2?typeof value==='number'&&Number.isFinite(value)&&value>=0?(masked?'USD •••':'USD '+String(value)):'Not captured':formatCostInr(value, usdInrRate);
  const totalTokensIn = runJobs.reduce((sum, rj) => sum + (rj.job.tokens_in ?? 0), 0);
  const totalTokensOut = runJobs.reduce((sum, rj) => sum + (rj.job.tokens_out ?? 0), 0);

  return (
    <div data-uat2-recorded-run={uat2?"true":undefined} className="mx-auto flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            onClick={() => router.back()}
            className="inline-flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900"
          >
            <ArrowLeft className="size-4" />
            Back
          </Button>
          <span className="text-gray-300">/</span>
          <h1 className="text-lg font-semibold tracking-tight text-gray-950">{runLabel}</h1>
          <span
            className={cn(
              'inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold capitalize ring-1',
              STATUS_STYLES[run.status] ?? 'bg-gray-50 text-gray-700 ring-gray-200',
            )}
          >
            <StatusIcon className={cn('size-3.5', run.status === 'processing' && 'animate-spin')} />
            {run.status}
          </span>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => loadRun()}
          disabled={loading}
        >
          <RefreshCw className={cn('mr-2 size-3.5', loading && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {uat2&&<p role="status" className="rounded border p-3 text-sm">Saved run record only. Refresh reads current recorded state; this view does not subscribe to a live stream, query platform billing, start providers or authorize orders. Recorded estimates remain USD; no verified INR conversion or settled bill is inferred.</p>}
      {uat2&&usage?.duplicate&&<p role="alert">Repeated saved job references make complete usage totals ambiguous. No duplicated cost or token count is inferred.</p>}
      {isActive && !uat2 && (
        <div className="flex items-center gap-2 border border-blue-200 bg-blue-50 px-4 py-2.5 text-xs font-medium text-blue-700">
          <span
            className={cn(
              'inline-block size-1.5 rounded-full',
              wsConnected ? 'bg-blue-500' : 'bg-blue-300',
            )}
          />
          {wsConnected ? 'Live — updates arrive automatically.' : 'Connecting…'}
        </div>
      )}

      {/* Summary cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="border border-gray-200 bg-white px-4 py-4 shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-wider text-gray-500">Stage</div>
          <div className="mt-2 font-medium text-gray-950">S{run.current_stage}</div>
          <div className="mt-0.5 text-xs text-gray-500">
            {runJobs.length} {uat2?'recorded job link':'model'}{runJobs.length !== 1 ? 's' : ''}
          </div>
        </div>
        <div className="border border-gray-200 bg-white px-4 py-4 shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-wider text-gray-500">Tokens</div>
          <div className="mt-2 font-medium text-gray-950">
            {uat2?usage?.tokensTotal??'Not captured':formatTokens(totalTokensIn + totalTokensOut)}
          </div>
          <div className="mt-0.5 text-xs text-gray-500">
            {uat2?usage?.tokensIn??'Unknown':formatTokens(totalTokensIn)} in / {uat2?usage?.tokensOut??'Unknown':formatTokens(totalTokensOut)} out
          </div>
        </div>
        <div className="border border-gray-200 bg-white px-4 py-4 shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-wider text-gray-500">
            Est. Cost
          </div>
          <div className="mt-2 font-medium text-gray-950">
            {uat2?usage?.subtotal===null?'Not captured':masked?'USD •••':'USD '+usage?.subtotal:missingCostCount > 0
              ? hasAnyKnownCost
                ? `At least ${formatCostWithInr(totalKnownCost)}`
                : 'Not captured'
              : formatCostWithInr(totalKnownCost)}
          </div>
          <div className="mt-0.5 text-xs text-gray-500">
            {uat2?usage?.incomplete?'Known estimate subtotal only; complete coverage unavailable. Not provider billing.':'Complete recorded estimate coverage; not provider billing.':missingCostCount > 0
              ? hasAnyKnownCost
                ? `${missingCostCount} model cost${missingCostCount === 1 ? '' : 's'} not captured`
                : `No model cost${missingCostCount === 1 ? '' : 's'} captured`
              : 'across all models'}
          </div>
        </div>
      </div>

      {/* Prompt */}
      <div className="border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-200 px-5 py-3">
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">
            Prompt
          </span>
        </div>
        <div className="p-5">
          {uat2?<ConceptFSavedText value={run.prompt} label={`Run ${run.id} prompt`} masked={masked}/>:<p className={`whitespace-pre-wrap text-sm leading-6 text-gray-800 ${!isExpanded ? 'line-clamp-3' : ''}`}>{run.prompt}</p>}
          {!uat2&&run.prompt?.split('\n').length > 3 && (
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="mt-3 text-sm text-blue-600 hover:text-blue-800 focus:outline-none"
            >
              {isExpanded ? 'Show less ↑' : 'Show more ↓'}
            </button>
          )}
        </div>
      </div>

      {/* Per-model responses */}
      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-500">
          {uat2?'Recorded model job responses':'Stage 1 — Model Responses'}
        </h2>
        <div className="grid gap-4">
          {runJobs.map((rj) => {
            const job = rj.job;
            const JobStatusIcon = STATUS_ICONS[job.status] ?? Clock3;
            const jobIsActive = ACTIVE_STATUSES.has(job.status);
            const hasResponse = Boolean(job.response?.trim());
            const showJobCost = hasKnownCost(job.estimated_cost) || TERMINAL_STATUSES.has((job.status || '').toLowerCase());
            const sheets = getJobSheetsPresentation({
              autoExportEnabled: run.auto_export_enabled,
              jobStatus: job.status,
              exportStatus: job.export_status,
              errorMessage: job.error_message,
              exportError: job.export_error,
            });
            return (
              <div
                key={rj.id}
                id={`llm-output-job-${job.id}`}
                className="scroll-mt-24 border border-gray-200 bg-white shadow-sm max-w-full overflow-auto"
              >
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-5 py-3">
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium capitalize text-gray-950">
                      {job.provider}
                    </span>
                    <span className="text-xs text-gray-400">{job.model}</span>
                    {uat2&&<span className="text-xs text-muted-foreground">Recorded stage {rj.stage} · job {job.id}</span>}
                  </div>
                  <div className="flex items-center gap-3">
                    {(uat2 || job.tokens_in || job.tokens_out) ? (
                      <span className="text-xs text-gray-400">
                        {uat2?recordedTokenCount(job.tokens_in):formatTokens(job.tokens_in)}↑ {uat2?recordedTokenCount(job.tokens_out):formatTokens(job.tokens_out)}↓
                      </span>
                    ) : null}
                    {showJobCost ? (
                      <span className={cn('text-xs', hasKnownCost(job.estimated_cost) ? 'text-gray-400' : 'text-gray-300')}>
                        {formatCostWithInr(job.estimated_cost)}
                      </span>
                    ) : null}
                    <div className="flex flex-col items-start">
                      <span
                        className={cn(
                          'inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-semibold capitalize ring-1',
                          STATUS_STYLES[job.status] ?? 'bg-gray-50 text-gray-700 ring-gray-200',
                        )}
                      >
                        <JobStatusIcon className={cn('size-3', jobIsActive && 'animate-spin')} />
                        {job.status}
                      </span>
                      {TERMINAL_STATUSES.has((job.status || '').toLowerCase()) ? (
                        <span className="mt-1 text-[11px] text-gray-500">
                          {formatDuration(job.created_at, job.updated_at) ?? '-'}
                        </span>
                      ) : null}
                    </div>
                    {sheets.state !== 'disabled' ? (
                      <div className="flex flex-col items-start">
                        <span
                          className={cn(
                            'inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-semibold ring-1',
                            SHEETS_STATUS_STYLES[sheets.state] ?? 'bg-gray-50 text-gray-700 ring-gray-200',
                          )}
                        >
                          {sheets.label}
                        </span>
                        {job.exported_sheet_url ? (
                          <Link
                            href={job.exported_sheet_url}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-1 text-[11px] font-medium text-indigo-600 hover:text-indigo-800 hover:underline"
                          >
                            Open tab
                          </Link>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
                <div className="max-w-full p-5">
                  {uat2&&<details><summary className="min-h-11 cursor-pointer">Exact saved job prompt</summary><ConceptFSavedText value={job.prompt} label={`Run ${run.id} job ${job.id} prompt`} masked={masked}/></details>}
                  {(!uat2||!masked)&&<OutputConsistencyNotice metadata={job.runtime_metadata_json} />}
                  {job.status === 'failed' && job.error_message ? (
                    <div className="mb-4 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                      <>{uat2?<ConceptFSavedText value={job.error_message} label={`Job ${job.id} saved error`} masked={masked}/>:<p className="whitespace-pre-wrap leading-6">{job.error_message}</p>}</>
                    </div>
                  ) : null}

                  {hasResponse ? (
                    <>{uat2&&masked?<p>Saved output is masked. Reveal deliberately in Profile before inspecting it.</p>:<><InvestmentRecommendationTable content={job.response ?? ''} provider={job.provider} model={job.model} runNumber={run.id} runCreatedAt={run.created_at}/>{uat2&&<details><summary className="min-h-11 cursor-pointer">Full saved job output · inert text</summary><ConceptFSavedText value={job.response} label={`Run ${run.id} job ${job.id} output`} masked={false}/></details>}</>}</>
                  ) : job.status === 'failed' && job.error_message ? null : (
                    <p className="text-sm italic text-gray-400">
                      {uat2?'No saved response supplied. No successful empty result or current provider state is inferred.':jobIsActive ? 'Waiting for response…' : 'No response.'}
                    </p>
                  )}
                  {uat2&&<details className="mt-4"><summary className="min-h-11 cursor-pointer">Recorded job metadata · bounded and sanitized</summary>{masked?<p>Private saved fields are masked. Reveal deliberately in Profile before inspecting this metadata.</p>:<pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(safeResearchData({...job,prompt:undefined,response:undefined,error_message:undefined}),null,2)}</pre>}</details>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {uat2&&<section className="space-y-4"><details><summary className="min-h-11 cursor-pointer">Saved synthesis response</summary><ConceptFSavedText value={run.synthesis_response} label={`Run ${run.id} synthesis`} masked={masked}/></details><details><summary className="min-h-11 cursor-pointer">Saved decision response</summary><ConceptFSavedText value={run.decision_response} label={`Run ${run.id} decision`} masked={masked}/></details></section>}
    </div>
  );
}

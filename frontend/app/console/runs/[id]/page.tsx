'use client';

import { use, useCallback, useEffect, useRef, useState, type ElementType } from 'react';
import { useRouter } from 'next/navigation';
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
import InvestmentRecommendationTable from '@/components/InvestmentRecommendationTable';

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

function normalizeError(error: unknown) {
  if (error instanceof APIError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong';
}

function formatTokens(value?: number | null) {
  return value?.toLocaleString() ?? '0';
}

function formatCost(value?: number | null) {
  if (!value) return '$0.0000';
  return `$${value.toFixed(4)}`;
}

export default function RunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [run, setRun] = useState<RunResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  const generationRef = useRef(0);
  const wsClientRef = useRef<WSClient | null>(null);

  const loadRun = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      const gen = ++generationRef.current;
      if (!silent) setLoading(true);
      try {
        const data = await apiService.getRun(Number(id));
        if (gen !== generationRef.current) return;
        setRun(data);
        setError(null);
      } catch (err) {
        if (gen !== generationRef.current) return;
        setError(normalizeError(err));
      } finally {
        if (gen === generationRef.current && !silent) setLoading(false);
      }
    },
    [id],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadRun();

    const client = new WSClient({
      url: URLs.runs.wsRun(Number(id)),
      onStatusChange: setWsConnected,
      onMessage: (data) => {
        if (data.type === 'job.updated') {
          const jobId = data.job_id as number;
          setRun((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              run_jobs: prev.run_jobs.map((rj) =>
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
  }, [id, loadRun]);

  if (loading) {
    return (
      <div className="mx-auto flex flex-col gap-6">
        <div className="flex items-center gap-3 text-sm text-gray-500">
          <Loader2 className="size-4 animate-spin" />
          Loading run…
        </div>
      </div>
    );
  }

  if (error || !run) {
    return (
      <div className="mx-auto flex flex-col gap-6">
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
  const totalCost = run.run_jobs.reduce((sum, rj) => sum + (rj.job.estimated_cost ?? 0), 0);
  const totalTokensIn = run.run_jobs.reduce((sum, rj) => sum + (rj.job.tokens_in ?? 0), 0);
  const totalTokensOut = run.run_jobs.reduce((sum, rj) => sum + (rj.job.tokens_out ?? 0), 0);

  return (
    <div className="mx-auto flex flex-col gap-6">
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
          <h1 className="text-lg font-semibold tracking-tight text-gray-950">Run #{run.id}</h1>
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

      {isActive && (
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
            {run.run_jobs.length} model{run.run_jobs.length !== 1 ? 's' : ''}
          </div>
        </div>
        <div className="border border-gray-200 bg-white px-4 py-4 shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-wider text-gray-500">Tokens</div>
          <div className="mt-2 font-medium text-gray-950">
            {formatTokens(totalTokensIn + totalTokensOut)}
          </div>
          <div className="mt-0.5 text-xs text-gray-500">
            {formatTokens(totalTokensIn)} in / {formatTokens(totalTokensOut)} out
          </div>
        </div>
        <div className="border border-gray-200 bg-white px-4 py-4 shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-wider text-gray-500">
            Est. Cost
          </div>
          <div className="mt-2 font-medium text-gray-950">{formatCost(totalCost)}</div>
          <div className="mt-0.5 text-xs text-gray-500">across all models</div>
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
          <p className={`whitespace-pre-wrap text-sm leading-6 text-gray-800 ${!isExpanded ? 'line-clamp-3' : ''}`}>
            {run.prompt}
          </p>
          {run.prompt?.split('\n').length > 3 && (
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
          Stage 1 — Model Responses
        </h2>
        <div className="grid gap-4">
          {run.run_jobs.map((rj) => {
            const job = rj.job;
            const JobStatusIcon = STATUS_ICONS[job.status] ?? Clock3;
            const jobIsActive = ACTIVE_STATUSES.has(job.status);
            return (
              <div key={rj.id} className="border border-gray-200 bg-white shadow-sm max-w-full overflow-auto">
                <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3">
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium capitalize text-gray-950">
                      {job.provider}
                    </span>
                    <span className="text-xs text-gray-400">{job.model}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    {job.tokens_in || job.tokens_out ? (
                      <span className="text-xs text-gray-400">
                        {formatTokens(job.tokens_in)}↑ {formatTokens(job.tokens_out)}↓
                      </span>
                    ) : null}
                    {job.estimated_cost ? (
                      <span className="text-xs text-gray-400">{formatCost(job.estimated_cost)}</span>
                    ) : null}
                    <span
                      className={cn(
                        'inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-semibold capitalize ring-1',
                        STATUS_STYLES[job.status] ?? 'bg-gray-50 text-gray-700 ring-gray-200',
                      )}
                    >
                      <JobStatusIcon className={cn('size-3', jobIsActive && 'animate-spin')} />
                      {job.status}
                    </span>
                  </div>
                </div>
                <div className="max-w-full p-5">
                  {job.status === 'failed' && job.error_message ? (
                    <p className="whitespace-pre-wrap text-sm leading-6 text-red-700">
                      {job.error_message}
                    </p>
                  ) : job.response ? (
                    <InvestmentRecommendationTable content={job.response} />
                  ) : (
                    <p className="text-sm italic text-gray-400">
                      {jobIsActive ? 'Waiting for response…' : 'No response.'}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

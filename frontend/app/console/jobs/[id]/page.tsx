'use client';

import { use, useEffect, useRef, useState, type ElementType } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Clock3,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiService, APIError } from '@/services/api';
import { JobResponse } from '@/types/api';
import { cn } from '@/lib/utils';
import { URLs } from '@/lib/urls';
import { WSClient } from '@/services/websocket';
import MarkdownRenderer from '@/components/shared/MarkdownRenderer';
import ExportToSheetsModal from './_components/ExportToSheetsModal';

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700 ring-amber-200',
  processing: 'bg-blue-50 text-blue-700 ring-blue-200',
  completed: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  failed: 'bg-red-50 text-red-700 ring-red-200',
};

const STATUS_ICONS: Record<string, ElementType> = {
  pending: Clock3,
  processing: Loader2,
  completed: CheckCircle2,
  failed: AlertCircle,
};

const TERMINAL_STATUSES = new Set(['completed', 'failed']);

function formatTokens(value?: number | null) {
  return value?.toLocaleString() ?? '0';
}

function normalizeError(error: unknown) {
  if (error instanceof APIError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong';
}

export default function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [job, setJob] = useState<JobResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isActive = job && !TERMINAL_STATUSES.has(job.status);

  const wsClientRef = useRef<WSClient | null>(null);

  async function loadJob({ silent = false }: { silent?: boolean } = {}) {
    if (!silent) setLoading(true);
    try {
      const data = await apiService.getJob(Number(id));
      setJob(data);
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    loadJob();

    const client = new WSClient({
      url: URLs.jobs.wsJob(Number(id)),
      onMessage: (data) => {
        if (data.type !== 'job.updated') return;
        const { type: _t, job_id: _jid, ...patch } = data as {
          type: string;
          job_id: number;
          [key: string]: unknown;
        };
        setJob((prev) => (prev ? { ...prev, ...patch } : prev));
        const newStatus = patch.status as string | undefined;
        if (newStatus && TERMINAL_STATUSES.has(newStatus)) {
          wsClientRef.current?.close();
        }
      },
    });
    wsClientRef.current = client;
    client.connect();

    return () => {
      wsClientRef.current?.close();
      wsClientRef.current = null;
    };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <div className="mx-auto flex flex-col gap-6">
        <div className="flex items-center gap-3 text-sm text-gray-500">
          <Loader2 className="size-4 animate-spin" />
          Loading job…
        </div>
      </div>
    );
  }

  if (error || !job) {
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
          <span>{error ?? 'Job not found.'}</span>
        </div>
      </div>
    );
  }

  const StatusIcon = STATUS_ICONS[job.status] ?? Clock3;

  return (
    <div className="mx-auto flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Button
            variant={'ghost'}
            onClick={() => router.back()}
            className="inline-flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900"
          >
            <ArrowLeft className="size-4" />
            Back
          </Button>
          <span className="text-gray-300">/</span>
          <h1 className="text-lg font-semibold tracking-tight text-gray-950">Job #{job.id}</h1>
          <span
            className={cn(
              'inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold capitalize ring-1',
              STATUS_STYLES[job.status] ?? 'bg-gray-50 text-gray-700 ring-gray-200',
            )}
          >
            <StatusIcon className={cn('size-3.5', job.status === 'processing' && 'animate-spin')} />
            {job.status}
          </span>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => loadJob()}
            disabled={loading}
          >
            <RefreshCw className={cn('mr-2 size-3.5', loading && 'animate-spin')} />
            Refresh
          </Button>
          {job.status === 'completed' && (
            <ExportToSheetsModal job={job} />
          )}
        </div>
      </div>

      {isActive && (
        <div className="flex items-center gap-2 border border-blue-200 bg-blue-50 px-4 py-2.5 text-xs font-medium text-blue-700">
          <span className="inline-block size-1.5 rounded-full bg-blue-500" />
          Live — updates will appear automatically.
        </div>
      )}

      <div className="grid gap-4">
        <div className="border border-gray-200 bg-white px-4 py-4 shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-wider text-gray-500">
            Provider
          </div>
          <div className="mt-2 font-medium capitalize text-gray-950">{job.provider}</div>
          <div className="mt-0.5 text-xs text-gray-500">{job.model}</div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-1">
        <div className="border border-gray-200 bg-white shadow-sm">
          <div className="border-b border-gray-200 px-5 py-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">
              Prompt
            </span>
          </div>
          <div className="p-5">
            <p className="whitespace-pre-wrap text-sm leading-6 text-gray-800">{job.prompt.slice(0, 100)}...</p>
          </div>
        </div>

        <div className="border border-gray-200 bg-white shadow-sm">
          <div className="border-b border-gray-200 px-5 py-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">
              Response
            </span>
          </div>

          <div className="p-5 max-w-full">
            {job.status === 'failed' && job.error_message ? (
              <p className="whitespace-pre-wrap text-sm leading-6 text-red-700">
                {job.error_message}
              </p>
            ) : job.response ? (
              <MarkdownRenderer content={job.response} />
            ) : (
              <p className="text-sm italic text-gray-400">
                {isActive ? 'Response pending…' : 'No response.'}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

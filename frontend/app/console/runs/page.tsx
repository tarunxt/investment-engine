'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ElementType } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Loader2,
  RefreshCw,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { apiService, APIError } from '@/services/api';
import { RunListItem } from '@/types/api';
import { formatApiTimestamp } from '@/lib/datetime';
import { cn } from '@/lib/utils';
import { URLs } from '@/lib/urls';
import { getAutoRebalanceRunDisplayLabel, getRunDetailPathFromPrompt } from '@/lib/runPresentation';
import { WSClient } from '@/services/websocket';
import { INDIA_TIMEZONE } from '../dashboard/_context';

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

type StatusFilter = 'all' | 'scheduled' | 'pending' | 'processing' | 'completed' | 'failed';

const PAGE_SIZE = 20;

function normalizeError(error: unknown) {
  if (error instanceof APIError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong';
}

function formatTimestamp(value?: string | null) {
  return formatApiTimestamp(value, {
    emptyValue: null,
    timeZone: INDIA_TIMEZONE,
    weekday: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export default function RunsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [page, setPage] = useState(
    () => Number(searchParams.get('page')) || 1
  );
  const [wsConnected, setWsConnected] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsClientRef = useRef<WSClient | null>(null);
  const loadRunsRef = useRef<typeof loadRuns>(loadRuns);

  const updateURLParams = useCallback((params: { status?: string; page?: number; search?: string }) => {
    const newParams = new URLSearchParams(searchParams);

    if (params.status !== undefined) {
      if (params.status === 'all') {
        newParams.delete('status');
      } else {
        newParams.set('status', params.status);
      }
    }

    if (params.page !== undefined) {
      if (params.page === 1) {
        newParams.delete('page');
      } else {
        newParams.set('page', params.page.toString());
      }
    }

    if (params.search !== undefined) {
      if (!params.search) {
        newParams.delete('search');
      } else {
        newParams.set('search', params.search);
      }
    }

    const queryString = newParams.toString();
    const newURL = queryString ? `/console/runs?${queryString}` : '/console/runs';
    router.replace(newURL, { scroll: false });
  }, [router, searchParams]);

  async function loadRuns({
    silent = false,
    p = page,
  }: { silent?: boolean; p?: number; s?: StatusFilter; q?: string } = {}) {
    if (!silent) setLoading(true);
    try {
      const data = await apiService.getRuns({
        page: p,
        limit: PAGE_SIZE,
        summary: true,
      });
      setRuns(data.items);
      setTotal(data.total);
      setPage(data.page);
      setPages(data.pages);
      setLastUpdated(new Date());
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useLayoutEffect(() => {
    loadRunsRef.current = loadRuns;
  });

  const initWS = useCallback(() => {
    const client = new WSClient({
      url: URLs.runs.ws(),
      onMessage: (data) => {
        if (data.type !== 'run.updated') return;
        const { run_id, ...patch } = data as {
          type: string;
          run_id: number;
          [key: string]: unknown;
        };
        setRuns((prev) => {
          if (!prev.some((j) => j.id === run_id)) {
            // Run created after initial fetch — reload silently to surface it
            setTimeout(() => loadRunsRef.current({ silent: true }), 0);
            return prev;
          }
          return prev.map((j) => (j.id === run_id ? { ...j, ...patch } : j));
        });
        setLastUpdated(new Date());
      },
      onStatusChange: setWsConnected,
    });
    wsClientRef.current = client;
    client.connect();
  }, []);

  // Initial load and setup
  useEffect(() => {
    const debounceTimer = debounceRef.current;

    loadRuns({ p: page });
    initWS();

    return () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      wsClientRef.current?.close();
      wsClientRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handlePageChange(next: number) {
    setPage(next);
    updateURLParams({ page: next });
    loadRuns({ p: next });
  }

  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-gray-950">All Runs</h1>
          <p className="mt-1 text-sm text-gray-600">
            {lastUpdated
              ? `Last updated ${lastUpdated.toLocaleTimeString('en-IN', { timeZone: INDIA_TIMEZONE })}`
              : 'Loading…'}
            {wsConnected && (
              <span className="ml-3 inline-flex items-center gap-1 text-emerald-600">
                <span className="inline-block size-1.5 rounded-full bg-emerald-500" />
                Live
              </span>
            )}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => loadRuns()}
          disabled={loading}
          className="w-full sm:w-auto"
        >
          <RefreshCw className={cn('mr-2 size-4', loading && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="flex items-start gap-3 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="border border-gray-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="w-[45%] px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                  Run
                </th>
                <th className="w-[15%] px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                  Status
                </th>
                <th className="w-[20%] px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                  Created At
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white">
              {loading ? (
                <tr>
                  <td colSpan={4} className="px-5 py-12 text-center text-sm text-gray-500">
                    <Loader2 className="mx-auto mb-2 size-5 animate-spin text-gray-400" />
                    Loading runs…
                  </td>
                </tr>
              ) : runs.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-5 py-12 text-center text-sm text-gray-500">
                    {total === 0 ? 'No runs yet.' : 'No runs match your filters.'}
                  </td>
                </tr>
              ) : (
                runs.map((run) => {
                  const StatusIcon = STATUS_ICONS[run.status] ?? Clock3;
                  return (
                    <tr
                      key={run.id}
                      onClick={() => router.push(getRunDetailPathFromPrompt(run.id, run.prompt_preview))}
                      className="cursor-pointer align-top hover:bg-gray-50"
                    >
                      <td className="max-w-90 px-5 py-4">
                        <div className="font-medium text-gray-950">{getAutoRebalanceRunDisplayLabel(run)}</div>
                        <div className="mt-1 line-clamp-2 text-xs leading-5 text-gray-600">
                          {run.prompt_preview}
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        <span
                          className={cn(
                            'inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold capitalize ring-1',
                            STATUS_STYLES[run.status] ?? 'bg-gray-50 text-gray-700 ring-gray-200',
                          )}
                        >
                          <StatusIcon
                            className={cn('size-3.5', run.status === 'processing' && 'animate-spin')}
                          />
                          {run.status}
                        </span>
                      </td>
                      <td className="px-5 py-4">
                        {formatTimestamp(run.created_at)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Footer: count + pagination */}
        <div className="flex items-center justify-between border-t border-gray-200 px-5 py-3">
          <span className="text-xs text-gray-500">
            {total === 0 ? 'No results' : `${from}–${to} of ${total} run${total !== 1 ? 's' : ''}`}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => handlePageChange(page - 1)}
              disabled={page <= 1 || loading}
              className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:pointer-events-none disabled:opacity-40"
            >
              <ChevronLeft className="size-4" />
            </button>
            <span className="min-w-16 text-center text-xs text-gray-600">
              {page} / {pages}
            </span>
            <button
              onClick={() => handlePageChange(page + 1)}
              disabled={page >= pages || loading}
              className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:pointer-events-none disabled:opacity-40"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

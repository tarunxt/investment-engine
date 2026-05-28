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
import { JobResponse } from '@/types/api';
import { cn } from '@/lib/utils';
import { URLs } from '@/lib/urls';
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

const ALL_STATUSES = ['all', 'scheduled', 'pending', 'processing', 'completed', 'failed'] as const;
type StatusFilter = (typeof ALL_STATUSES)[number];

const PAGE_SIZE = 20;

function normalizeError(error: unknown) {
  if (error instanceof APIError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong';
}

function formatTimestamp(value?: string | null) {
  if (!value) return null;
  return new Date(value).toLocaleString('en-IN', {
    timeZone: INDIA_TIMEZONE,
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export default function JobsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [jobs, setJobs] = useState<JobResponse[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(
    () => (searchParams.get('status') as StatusFilter) || 'all'
  );
  const [page, setPage] = useState(
    () => Number(searchParams.get('page')) || 1
  );
  const [search, setSearch] = useState(
    () => searchParams.get('search') || ''
  );
  const [wsConnected, setWsConnected] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsClientRef = useRef<WSClient | null>(null);
  const loadJobsRef = useRef<typeof loadJobs>(loadJobs);
  const statusFilterRef = useRef<StatusFilter>(statusFilter);

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
    const newURL = queryString ? `/console/jobs?${queryString}` : '/console/jobs';
    router.replace(newURL, { scroll: false });
  }, [router, searchParams]);

  async function loadJobs({
    silent = false,
    p = page,
    s = statusFilter,
    q = search,
  }: { silent?: boolean; p?: number; s?: StatusFilter; q?: string } = {}) {
    if (!silent) setLoading(true);
    try {
      const data = await apiService.getJobs({
        page: p,
        limit: PAGE_SIZE,
        status: s !== 'all' ? s : undefined,
        q: q.trim() || undefined,
      });
      setJobs(data.items);
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
    loadJobsRef.current = loadJobs;
    statusFilterRef.current = statusFilter;
  });

  const initWS = useCallback(() => {
    const client = new WSClient({
      url: URLs.jobs.ws(),
      onMessage: (data) => {
        if (data.type !== 'job.updated') return;
        const { job_id, ...patch } = data as {
          type: string;
          job_id: number;
          [key: string]: unknown;
        };
        setJobs((prev) => {
          const nextStatus = patch.status as string | undefined;
          const activeFilter = statusFilterRef.current;
          if (nextStatus && activeFilter !== 'all' && nextStatus !== activeFilter) {
            return prev.filter((j) => j.id !== job_id);
          }
          if (!prev.some((j) => j.id === job_id)) {
            // Job created after initial fetch — reload silently to surface it
            if (activeFilter === 'all' || !nextStatus || nextStatus === activeFilter) {
              setTimeout(() => loadJobsRef.current({ silent: true }), 0);
            }
            return prev;
          }
          return prev.map((j) => (j.id === job_id ? { ...j, ...patch } : j));
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
     
    loadJobs({ p: page, s: statusFilter, q: search });
    initWS();

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      wsClientRef.current?.close();
      wsClientRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handleStatusChange(s: StatusFilter) {
    setStatusFilter(s);
    setPage(1);
    updateURLParams({ status: s, page: 1 });
    loadJobs({ p: 1, s });
  }

  function handleSearchChange(q: string) {
    setSearch(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setPage(1);
      updateURLParams({ search: q, page: 1 });
      loadJobs({ p: 1, q });
    }, 300);
  }

  function handlePageChange(next: number) {
    setPage(next);
    updateURLParams({ page: next });
    loadJobs({ p: next });
  }

  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-gray-950">All Jobs</h1>
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
          onClick={() => loadJobs()}
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

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex flex-wrap gap-1">
          {ALL_STATUSES.map((s) => (
            <Button
              variant={'secondary'}
              key={s}
              onClick={() => handleStatusChange(s)}
              className={cn(
                'px-3 py-1.5 text-xs font-semibold capitalize transition-colors',
                statusFilter === s
                  ? 'bg-gray-950 text-white hover:bg-gray-950/90'
                  : 'border border-gray-200 bg-white text-gray-600 hover:border-gray-400',
              )}
            >
              {s}
            </Button>
          ))}
        </div>
        <input
          type="text"
          value={search}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder="Search by prompt or job ID…"
          className="flex-1 border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-950 outline-none transition focus:border-gray-950 focus:ring-2 focus:ring-gray-950/10 sm:max-w-sm"
        />
      </div>

      <div className="border border-gray-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="w-[34%] px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                  Job
                </th>
                <th className="w-[18%] px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                  Provider / Model
                </th>
                <th className="w-[16%] px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                  Status
                </th>
                <th className="w-[16%] px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                  Run At
                </th>
                <th className="w-[16%] px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                  Scheduled At
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white">
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-5 py-12 text-center text-sm text-gray-500">
                    <Loader2 className="mx-auto mb-2 size-5 animate-spin text-gray-400" />
                    Loading jobs…
                  </td>
                </tr>
              ) : jobs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-5 py-12 text-center text-sm text-gray-500">
                    {total === 0 ? 'No jobs yet.' : 'No jobs match your filters.'}
                  </td>
                </tr>
              ) : (
                jobs.map((job) => {
                  const StatusIcon = STATUS_ICONS[job.status] ?? Clock3;
                  const runAt = formatTimestamp(job.created_at);
                  const updatedAt = formatTimestamp(job.updated_at);
                  const scheduledAt = formatTimestamp(job.scheduled_at);
                  return (
                    <tr
                      key={job.id}
                      onClick={() => router.push(URLs.routes.console.jobDetail(job.id))}
                      className="cursor-pointer align-top hover:bg-gray-50"
                    >
                      <td className="max-w-90 px-5 py-4">
                        <div className="font-medium text-gray-950">#{job.id}</div>
                        <div className="mt-1 line-clamp-2 text-xs leading-5 text-gray-600">
                          {job.prompt}
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        <div className="font-medium capitalize text-gray-950">{job.provider}</div>
                        <div className="mt-1 text-xs text-gray-500">{job.model}</div>
                      </td>
                      <td className="px-5 py-4">
                        <span
                          className={cn(
                            'inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold capitalize ring-1',
                            STATUS_STYLES[job.status] ?? 'bg-gray-50 text-gray-700 ring-gray-200',
                          )}
                        >
                          <StatusIcon
                            className={cn('size-3.5', job.status === 'processing' && 'animate-spin')}
                          />
                          {job.status}
                        </span>
                        {updatedAt && (
                          <div className="mt-1 text-[11px] leading-4 text-gray-400">
                            Updated {updatedAt}
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-4 text-xs leading-5 text-gray-500">
                        {runAt ?? <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-5 py-4 text-xs leading-5 text-gray-500">
                        {scheduledAt ?? <span className="text-gray-300">—</span>}
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
            {total === 0 ? 'No results' : `${from}–${to} of ${total} job${total !== 1 ? 's' : ''}`}
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

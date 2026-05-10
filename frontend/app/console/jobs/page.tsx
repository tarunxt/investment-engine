'use client';

import { useEffect, useRef, useState, type ElementType } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
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

const ALL_STATUSES = ['all', 'pending', 'processing', 'completed', 'failed'] as const;
type StatusFilter = (typeof ALL_STATUSES)[number];

const PAGE_SIZE = 20;

function normalizeError(error: unknown) {
  if (error instanceof APIError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong';
}

export default function JobsPage() {
  const router = useRouter();
  const [jobs, setJobs] = useState<JobResponse[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasActiveJobs = jobs.some((j) => ['pending', 'processing'].includes(j.status));

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
        page_size: PAGE_SIZE,
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

  // Initial load
  useEffect(() => {
    loadJobs({ p: 1 });
  }, []);

  // Poll active jobs — stay on current page/filters
  useEffect(() => {
    if (!hasActiveJobs) return;
    const interval = window.setInterval(() => loadJobs({ silent: true }), 5000);
    return () => window.clearInterval(interval);
  }, [hasActiveJobs, page, statusFilter, search]);

  function handleStatusChange(s: StatusFilter) {
    setStatusFilter(s);
    setPage(1);
    loadJobs({ p: 1, s });
  }

  function handleSearchChange(q: string) {
    setSearch(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setPage(1);
      loadJobs({ p: 1, q });
    }, 300);
  }

  function handlePageChange(next: number) {
    setPage(next);
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
            {lastUpdated ? `Last updated ${lastUpdated.toLocaleTimeString()}` : 'Loading…'}
            {hasActiveJobs && (
              <span className="ml-3 inline-flex items-center gap-1 text-blue-600">
                <Loader2 className="size-3 animate-spin" />
                Polling active jobs
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
                <th className="w-[60%] px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                  Job
                </th>
                <th className="w-[20%] px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                  Provider / Model
                </th>
                <th className="w-[20%] px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white">
              {loading ? (
                <tr>
                  <td colSpan={3} className="px-5 py-12 text-center text-sm text-gray-500">
                    <Loader2 className="mx-auto mb-2 size-5 animate-spin text-gray-400" />
                    Loading jobs…
                  </td>
                </tr>
              ) : jobs.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-5 py-12 text-center text-sm text-gray-500">
                    {total === 0 ? 'No jobs yet.' : 'No jobs match your filters.'}
                  </td>
                </tr>
              ) : (
                jobs.map((job) => {
                  const StatusIcon = STATUS_ICONS[job.status] ?? Clock3;
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

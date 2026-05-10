'use client';

import { useEffect, useState, type ElementType } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
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

function formatTokens(value?: number | null) {
  return value?.toLocaleString() ?? '0';
}

function normalizeError(error: unknown) {
  if (error instanceof APIError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong';
}

export default function JobsPage() {
  const router = useRouter();
  const [jobs, setJobs] = useState<JobResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');

  const hasActiveJobs = jobs.some((j) => ['pending', 'processing'].includes(j.status));

  const filtered = jobs.filter((job) => {
    const matchesStatus = statusFilter === 'all' || job.status === statusFilter;
    const matchesSearch =
      search.trim() === '' ||
      job.prompt.toLowerCase().includes(search.toLowerCase()) ||
      String(job.id).includes(search.trim());
    return matchesStatus && matchesSearch;
  });

  async function loadJobs({ silent = false }: { silent?: boolean } = {}) {
    if (!silent) setLoading(true);
    try {
      const data = await apiService.getJobs();
      setJobs([...data].sort((a, b) => b.id - a.id));
      setLastUpdated(new Date());
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    loadJobs();
  }, []);

  useEffect(() => {
    if (!hasActiveJobs) return;
    const interval = window.setInterval(() => loadJobs({ silent: true }), 5000);
    return () => window.clearInterval(interval);
  }, [hasActiveJobs]);

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
        <div className="flex gap-1 flex-wrap">
          {ALL_STATUSES.map((s) => (
            <Button
              variant={'secondary'}
              key={s}
              onClick={() => setStatusFilter(s)}
              className={cn(
                'px-3 py-1.5 text-xs font-semibold capitalize transition-colors',
                statusFilter === s
                  ? 'bg-gray-950 text-white hover:bg-gray-800'
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
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by prompt or job ID…"
          className="flex-1 border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-950 outline-none transition focus:border-gray-950 focus:ring-2 focus:ring-gray-950/10 sm:max-w-sm"
        />
      </div>

      <div className="border border-gray-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                  Job
                </th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                  Provider / Model
                </th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white">
              {loading ? (
                <tr>
                  <td colSpan={4} className="px-5 py-12 text-center text-sm text-gray-500">
                    <Loader2 className="mx-auto mb-2 size-5 animate-spin text-gray-400" />
                    Loading jobs…
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-5 py-12 text-center text-sm text-gray-500">
                    {jobs.length === 0 ? 'No jobs yet.' : 'No jobs match your filters.'}
                  </td>
                </tr>
              ) : (
                filtered.map((job) => {
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
                            className={cn(
                              'size-3.5',
                              job.status === 'processing' && 'animate-spin',
                            )}
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
        {!loading && filtered.length > 0 && (
          <div className="border-t border-gray-200 px-5 py-3 text-xs text-gray-500">
            Showing {filtered.length} of {jobs.length} job{jobs.length !== 1 ? 's' : ''}
          </div>
        )}
      </div>
    </div>
  );
}

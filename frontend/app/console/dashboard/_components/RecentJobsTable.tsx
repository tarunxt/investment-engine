'use client';

import { Clock3, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { URLs } from '@/lib/urls';
import { INDIA_TIMEZONE, useDashboard, STATUS_ICONS, STATUS_STYLES } from '../_context';

const parseApiTimestamp = (value: string) =>
  /[zZ]|[+-]\d{2}:\d{2}$/.test(value) ? new Date(value) : new Date(`${value}Z`);

const formatTimestamp = (value: string) =>
  parseApiTimestamp(value).toLocaleString('en-IN', {
    timeZone: INDIA_TIMEZONE,
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

const formatModelName = (provider: string, model: string) =>
  `${provider} / ${model}`.replace(/\b\w/g, (char) => char.toUpperCase());

const EXPORT_STYLES: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700 ring-amber-200',
  queued: 'bg-blue-50 text-blue-700 ring-blue-200',
  completed: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  failed: 'bg-red-50 text-red-700 ring-red-200',
  disabled: 'bg-gray-50 text-gray-600 ring-gray-200',
};

export function RecentJobsTable() {
  const { runs, runsTotal, loadingRuns, lastUpdated } = useDashboard();
  const router = useRouter();

  return (
    <section className="min-w-0 border border-gray-200 bg-white shadow-sm">
      <div className="flex flex-col gap-1 border-b border-gray-200 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-950">
            Recent Jobs
          </h2>
          <p className="text-xs text-gray-500">
            {lastUpdated
              ? `Updated ${lastUpdated.toLocaleTimeString('en-IN', { timeZone: INDIA_TIMEZONE })}`
              : 'Waiting for data'}
          </p>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                Job
              </th>
              <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                Run At
              </th>
              <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                Model Statuses
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white">
            {loadingRuns ? (
              <tr>
                <td colSpan={3} className="px-5 py-10 text-center text-sm text-gray-500">
                  <Loader2 className="mx-auto mb-2 size-5 animate-spin text-gray-400" />
                  Loading jobs…
                </td>
              </tr>
            ) : runs.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-5 py-10 text-center text-sm text-gray-500">
                  No jobs yet
                </td>
              </tr>
            ) : (
              runs.map((run) => {
                const StatusIcon = STATUS_ICONS[run.status] ?? Clock3;
                const runJobs = [...(run.run_jobs ?? [])].sort((a, b) =>
                  a.job.provider.localeCompare(b.job.provider) ||
                  a.job.model.localeCompare(b.job.model)
                );
                const exportStatus = (run.export_status ?? (run.auto_export_enabled ? 'pending' : 'disabled')).toLowerCase();
                return (
                  <tr
                    key={run.id}
                    onClick={() => router.push(URLs.routes.console.runDetail(run.id))}
                    className="cursor-pointer align-top hover:bg-gray-50"
                  >
                    <td className="max-w-90 px-5 py-4">
                      <div className="font-medium text-gray-950">#{run.id}</div>
                      <div className="mt-1 line-clamp-2 text-xs leading-5 text-gray-600">
                        {run.prompt}
                      </div>
                    </td>
                    <td className="px-5 py-4">
                      <div className="font-medium text-gray-950">{formatTimestamp(run.created_at)}</div>
                      <div className="mt-1 text-xs text-gray-500">Stage S{run.current_stage}</div>
                    </td>
                    <td className="px-5 py-4">
                      <div className="space-y-2">
                        {runJobs.length > 0 ? (
                          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                            {runJobs.map((runJob) => {
                              const job = runJob.job;
                              const JobStatusIcon = STATUS_ICONS[job.status] ?? Clock3;
                              return (
                                <div
                                  key={runJob.id}
                                  className="min-w-0 rounded-md border border-gray-200 bg-white px-2.5 py-2"
                                >
                                  <div className="truncate text-xs font-medium capitalize text-gray-900">
                                    {formatModelName(job.provider, job.model)}
                                  </div>
                                  <div className="mt-1 flex flex-wrap items-center gap-2">
                                    <span
                                      className={cn(
                                        'inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-semibold capitalize ring-1',
                                        STATUS_STYLES[job.status] ?? 'bg-gray-50 text-gray-700 ring-gray-200',
                                      )}
                                    >
                                      <JobStatusIcon
                                        className={cn(
                                          'size-3',
                                          job.status === 'processing' && 'animate-spin',
                                        )}
                                      />
                                      {job.status}
                                    </span>
                                    <span className="text-[11px] text-gray-400">
                                      {formatTimestamp(job.created_at)}
                                    </span>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <span
                            className={cn(
                              'inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold capitalize ring-1',
                              STATUS_STYLES[run.status] ?? 'bg-gray-50 text-gray-700 ring-gray-200',
                            )}
                          >
                            <StatusIcon
                              className={cn(
                                'size-3.5',
                                run.status === 'processing' && 'animate-spin',
                              )}
                            />
                            {run.status}
                          </span>
                        )}

                        <div className="flex items-center gap-2 text-xs" onClick={(e) => e.stopPropagation()}>
                          <span className="text-gray-500">Sheets Export:</span>
                          <span
                            className={cn(
                              'inline-flex items-center gap-1.5 px-2 py-0.5 font-semibold capitalize ring-1',
                              EXPORT_STYLES[exportStatus] ?? 'bg-gray-50 text-gray-700 ring-gray-200',
                            )}
                          >
                            {exportStatus}
                          </span>
                          {run.exported_sheet_url ? (
                            <Link
                              href={run.exported_sheet_url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-indigo-600 hover:text-indigo-800 hover:underline"
                            >
                              Open tab
                            </Link>
                          ) : null}
                        </div>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between border-t border-gray-200 px-5 py-3">
        <span className="text-xs text-gray-500">
          {runsTotal === 0
            ? 'No jobs yet'
            : `Showing ${runs.length} of ${runsTotal} job${runsTotal !== 1 ? 's' : ''}`}
        </span>
        <Link
          href={URLs.routes.console.jobs()}
          className="text-xs font-medium text-indigo-600 hover:text-indigo-800"
        >
          View all →
        </Link>
      </div>
    </section>
  );
}

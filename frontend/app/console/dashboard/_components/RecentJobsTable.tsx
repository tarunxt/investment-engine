'use client';

import { Clock3, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { URLs } from '@/lib/urls';
import { useDashboard, STATUS_ICONS, STATUS_STYLES } from '../_context';

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
            {lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString()}` : 'Waiting for data'}
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
                Stage
              </th>
              <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                Status
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
                const modelCount = run.run_jobs?.length;
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
                      <div className="font-medium text-gray-950">S{run.current_stage}</div>
                      <div className="mt-1 text-xs text-gray-500">
                        {modelCount} model{modelCount !== 1 ? 's' : ''}
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
                          className={cn(
                            'size-3.5',
                            run.status === 'processing' && 'animate-spin',
                          )}
                        />
                        {run.status}
                      </span>
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

'use client';

import { useEffect, useRef, useState } from 'react';
import { Clock3, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { URLs } from '@/lib/urls';
import { INDIA_TIMEZONE, useDashboard, STATUS_ICONS, STATUS_STYLES } from '../_context';
import { apiService } from '@/services/api';

const parseApiTimestamp = (value?: string | null) => {
  if (!value || typeof value !== 'string') return null;
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const parsed = /[zZ]|[+-]\d{2}:\d{2}$/.test(normalized)
    ? new Date(normalized)
    : new Date(`${normalized}Z`);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
};

const formatTimestamp = (value?: string | null) => {
  const parsed = parseApiTimestamp(value);
  if (!parsed) return '-';
  return parsed.toLocaleString('en-IN', {
    timeZone: INDIA_TIMEZONE,
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
};

const formatModelName = (provider?: string | null, model?: string | null) =>
  `${provider || 'Unknown'} / ${model || 'Unknown'}`.replace(/\b\w/g, (char) => char.toUpperCase());

const TERMINAL_STATUSES = new Set(['completed', 'failed']);
const PROCESSING_STATUS = 'processing';
const ACTIVE_TIMER_STATUSES = new Set(['processing', 'completed', 'failed']);

type JobTimer = {
  startedAtMs: number | null;
  endedAtMs: number | null;
};

const toMs = (value?: string | null) => {
  const parsed = parseApiTimestamp(value);
  if (!parsed) return null;
  const ms = parsed.getTime();
  return Number.isFinite(ms) ? ms : null;
};

const formatHMS = (durationMs: number) => {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((v) => String(v).padStart(2, '0')).join(':');
};

const normalizeStatus = (value?: string | null) => (value || '').trim().toLowerCase();

const EXPORT_STYLES: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700 ring-amber-200',
  queued: 'bg-blue-50 text-blue-700 ring-blue-200',
  completed: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  failed: 'bg-red-50 text-red-700 ring-red-200',
  partial: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  disabled: 'bg-gray-50 text-gray-600 ring-gray-200',
};

const PROVIDER_CONSOLE_URL: Record<string, string> = {
  openai: 'https://platform.openai.com/usage',
  anthropic: 'https://console.anthropic.com/settings/usage',
  gemini: 'https://aistudio.google.com/usage',
  deepseek: 'https://platform.deepseek.com/usage',
};

export function RecentJobsTable() {
  const { runs, runsTotal, loadingRuns, lastUpdated } = useDashboard();
  const router = useRouter();
  const [usdInrRate, setUsdInrRate] = useState(83.5);
  const [tickNow, setTickNow] = useState(() => Date.now());
  const [jobTimers, setJobTimers] = useState<Record<number, JobTimer>>({});
  const previousStatusesRef = useRef<Record<number, string>>({});

  useEffect(() => {
    let mounted = true;
    void apiService
      .getApiUsageSummary()
      .then((res) => {
        if (mounted && Number(res.usd_inr_rate) > 0) {
          setUsdInrRate(Number(res.usd_inr_rate));
        }
      })
      .catch(() => {
        // keep fallback
      });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const interval = setInterval(() => setTickNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    setJobTimers((prev) => {
      const next = { ...prev };
      const currentStatuses: Record<number, string> = {};

      for (const run of runs) {
        for (const runJob of run.run_jobs ?? []) {
          const job = runJob.job;
          const jobId = job.id;
          const status = normalizeStatus(job.status);
          const prevStatus = previousStatusesRef.current[jobId];
          const existing = next[jobId] ?? { startedAtMs: null, endedAtMs: null };
          const updatedAtMs = toMs(job.updated_at);
          const createdAtMs = toMs(job.created_at);

          currentStatuses[jobId] = status;

          if (status === PROCESSING_STATUS) {
            // Start stopwatch when processing begins.
            if (prevStatus !== PROCESSING_STATUS || existing.startedAtMs === null) {
              existing.startedAtMs = updatedAtMs ?? Date.now();
              existing.endedAtMs = null;
            }
          } else if (TERMINAL_STATUSES.has(status)) {
            // Freeze stopwatch on terminal state.
            if (existing.startedAtMs === null) {
              // Fallback for older rows loaded after completion.
              existing.startedAtMs = createdAtMs;
            }
            if (existing.endedAtMs === null) {
              existing.endedAtMs = updatedAtMs ?? Date.now();
            }
          }

          next[jobId] = existing;
        }
      }

      previousStatusesRef.current = currentStatuses;
      return next;
    });
  }, [runs]);

  const copyError = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ignore
    }
  };

  const cancelRun = async (runId: number) => {
    try {
      await apiService.cancelRun(runId);
    } catch {
      // ignore here, websocket/poll will surface current state
    }
  };

  const getTimerLabel = (job: { id: number; status: string; created_at?: string }) => {
    const status = normalizeStatus(job.status);
    const timer = jobTimers[job.id];
    const fallbackStart = toMs(job.created_at) ?? tickNow;
    const startMs = timer?.startedAtMs ?? fallbackStart;
    const endMs =
      status === PROCESSING_STATUS ? tickNow : (timer?.endedAtMs ?? tickNow);
    if (!Number.isFinite(endMs) || endMs < startMs) return '00:00:00';
    return formatHMS(endMs - startMs);
  };

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
                const totalCost = runJobs.reduce((sum, rj) => sum + Number(rj.job.estimated_cost || 0), 0);
                const modelExportStates = runJobs.map((rj) => {
                  const j = rj.job;
                  const explicit = (j.export_status ?? '').toLowerCase();
                  if (explicit) return explicit;
                  if (!run.auto_export_enabled) return 'disabled';
                  if (j.status === 'failed') return 'failed';
                  if (j.status === 'completed') return 'processing';
                  return 'pending';
                });
                const doneExports = modelExportStates.filter((s) => s === 'completed').length;
                const eligibleExports = modelExportStates.filter((s) => s !== 'disabled').length;
                const failedExports = modelExportStates.filter((s) => s === 'failed').length;
                const isPartiallyExported = failedExports > 0 && doneExports > 0;
                const derivedOverallExportStatus = isPartiallyExported ? 'partial' : exportStatus;
                const derivedOverallExportLabel = isPartiallyExported
                  ? `Partially exported (${doneExports}/${eligibleExports})`
                  : exportStatus;
                const getModelExportStatus = (jobStatus: string, modelExportStatus?: string | null) => {
                  const explicit = (modelExportStatus ?? '').toLowerCase();
                  if (explicit) return explicit;
                  if (!run.auto_export_enabled) return 'disabled';
                  if (jobStatus === 'failed') return 'failed';
                  if (jobStatus === 'completed') return 'processing';
                  if (jobStatus === 'pending' || jobStatus === 'processing' || jobStatus === 'scheduled') return 'pending';
                  if (exportStatus === 'failed') return 'failed';
                  if (exportStatus === 'completed') return 'completed';
                  return 'pending';
                };
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
                      {['scheduled', 'pending', 'processing'].includes((run.status || '').toLowerCase()) ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void cancelRun(run.id);
                          }}
                          className="mt-2 text-xs text-red-600 hover:text-red-800 hover:underline"
                        >
                          Kill job
                        </button>
                      ) : null}
                    </td>
                    <td className="px-5 py-4">
                      <div className="space-y-2">
                        {runJobs.length > 0 ? (
                          <div className="overflow-x-auto rounded-md border border-gray-200">
                            <table className="min-w-full text-xs">
                              <thead className="bg-gray-50 text-left uppercase tracking-wide text-gray-500">
                                <tr>
                                  <th className="px-2 py-2 font-semibold">LLM</th>
                                  <th className="px-2 py-2 font-semibold">Status</th>
                                  <th className="px-2 py-2 font-semibold">Run At</th>
                                  <th className="px-2 py-2 font-semibold">Sheets</th>
                                  <th className="px-2 py-2 font-semibold">Cost (USD / INR)</th>
                                  <th className="px-2 py-2 font-semibold">Error</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-gray-100 bg-white">
                                {runJobs.map((runJob) => {
                                  const job = runJob.job;
                                  const normalizedJobStatus = normalizeStatus(job.status);
                                  const JobStatusIcon = STATUS_ICONS[normalizedJobStatus] ?? Clock3;
                                  const modelExportStatus = getModelExportStatus(
                                    normalizedJobStatus,
                                    job.export_status,
                                  );
                                  return (
                                    <tr key={runJob.id}>
                                      <td className="px-2 py-2 text-gray-900">
                                        {formatModelName(job.provider, job.model)}
                                      </td>
                                      <td className="px-2 py-2">
                                        <div className="flex flex-col items-start">
                                          <span
                                            className={cn(
                                              'inline-flex items-center gap-1.5 px-2 py-0.5 font-semibold capitalize ring-1',
                                              STATUS_STYLES[normalizedJobStatus] ??
                                                'bg-gray-50 text-gray-700 ring-gray-200',
                                            )}
                                          >
                                            <JobStatusIcon
                                              className={cn(
                                                'size-3',
                                                normalizedJobStatus === PROCESSING_STATUS && 'animate-spin',
                                              )}
                                            />
                                            {job.status}
                                          </span>
                                          <span className="mt-1 block text-[11px] font-medium text-gray-600">
                                            {ACTIVE_TIMER_STATUSES.has(normalizedJobStatus)
                                              ? getTimerLabel(job)
                                              : ''}
                                          </span>
                                        </div>
                                      </td>
                                      <td className="px-2 py-2 text-gray-500">
                                        {formatTimestamp(job.created_at)}
                                      </td>
                                      <td className="px-2 py-2">
                                        <span
                                          className={cn(
                                            'inline-flex items-center gap-1 px-1.5 py-0.5 font-semibold capitalize ring-1',
                                            EXPORT_STYLES[modelExportStatus] ??
                                              'bg-gray-50 text-gray-700 ring-gray-200',
                                          )}
                                        >
                                          {modelExportStatus}
                                        </span>
                                      </td>
                                      <td className="px-2 py-2 text-gray-700">
                                        ${Number(job.estimated_cost || 0).toFixed(4)} / ₹
                                        {(Number(job.estimated_cost || 0) * usdInrRate).toFixed(2)}
                                      </td>
                                      <td className="max-w-[340px] px-2 py-2 text-red-700">
                                        {job.status === 'failed' && job.error_message ? (
                                          <div>
                                            <div className="line-clamp-1" title={job.error_message}>
                                              Provider error: {job.error_message}
                                            </div>
                                            <button
                                              type="button"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                void copyError(job.error_message || '');
                                              }}
                                              className="mt-0.5 text-indigo-600 hover:text-indigo-800 hover:underline"
                                            >
                                              Copy error
                                            </button>
                                            <div>
                                              <Link
                                                href={PROVIDER_CONSOLE_URL[(job.provider || '').toLowerCase()] || '#'}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="mt-0.5 inline-block text-indigo-600 hover:text-indigo-800 hover:underline"
                                              >
                                                Open provider console
                                              </Link>
                                            </div>
                                          </div>
                                        ) : (
                                          <span className="text-gray-400">-</span>
                                        )}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
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
                              EXPORT_STYLES[derivedOverallExportStatus] ?? 'bg-gray-50 text-gray-700 ring-gray-200',
                            )}
                          >
                            {derivedOverallExportLabel}
                          </span>
                          <span className="text-gray-500">
                            Total cost: ${totalCost.toFixed(4)} / ₹{(totalCost * usdInrRate).toFixed(2)}
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
                        {exportStatus === 'failed' && run.export_error ? (
                          <div
                            className="max-w-[680px] truncate text-[11px] text-red-600"
                            title={run.export_error}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {run.export_error}
                          </div>
                        ) : null}
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

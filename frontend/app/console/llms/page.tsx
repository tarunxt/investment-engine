'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { apiService } from '@/services/api';
import type { LlmPerformanceGroup, LlmPerformanceResponse, LlmScanPerformanceItem } from '@/types/api';

function formatDateTime(value?: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function formatDuration(ms?: number | null) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function formatCost(value?: number | null) {
  if (value === null || value === undefined) return '—';
  if (value === 0) return '$0.00';
  if (value < 0.0001) return `$${value.toExponential(2)}`;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 6,
  }).format(value);
}

function passFailLabel(value?: boolean | null) {
  if (value === true) return { text: 'Pass', className: 'bg-emerald-50 text-emerald-700 ring-emerald-200' };
  if (value === false) return { text: 'Fail', className: 'bg-rose-50 text-rose-700 ring-rose-200' };
  return { text: '—', className: 'bg-slate-50 text-slate-500 ring-slate-200' };
}

function StatusPill({ value }: { value?: boolean | null }) {
  const label = passFailLabel(value);
  return (
    <span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ring-1 ${label.className}`}>
      {label.text}
    </span>
  );
}

function groupScansByType(scans: LlmScanPerformanceItem[]) {
  return scans.reduce<Record<string, LlmScanPerformanceItem[]>>((acc, scan) => {
    acc[scan.scan_type] = acc[scan.scan_type] || [];
    acc[scan.scan_type].push(scan);
    return acc;
  }, {});
}

function LlmGroupCard({ group }: { group: LlmPerformanceGroup }) {
  const scansByType = useMemo(() => groupScansByType(group.scans), [group.scans]);

  return (
    <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-500">LLM</p>
            <h2 className="mt-1 text-xl font-semibold text-slate-950">{group.provider} / {group.model}</h2>
            <p className="mt-1 text-sm text-slate-500">Scan-wise processing and Google Sheets export performance.</p>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Metric label="Scans" value={group.total_scans.toLocaleString('en-IN')} />
            <Metric label="Processing pass" value={group.processing_passed.toLocaleString('en-IN')} />
            <Metric label="Processing fail" value={group.processing_failed.toLocaleString('en-IN')} />
            <Metric label="Sheet fail" value={group.sheet_export_failed.toLocaleString('en-IN')} />
            <Metric label="Cost" value={formatCost(group.total_cost)} />
          </div>
        </div>
      </div>

      <div className="space-y-6 p-5">
        <div className="overflow-hidden rounded-xl border border-slate-200">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Scan type</th>
                <th className="px-4 py-3">Scans</th>
                <th className="px-4 py-3">Processing pass/fail</th>
                <th className="px-4 py-3">Sheet pass/fail</th>
                <th className="px-4 py-3">Avg time</th>
                <th className="px-4 py-3">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {group.scan_summaries.map((summary) => (
                <tr key={summary.scan_type}>
                  <td className="px-4 py-3 font-medium text-slate-900">{summary.scan_type}</td>
                  <td className="px-4 py-3 text-slate-600">{summary.total_scans}</td>
                  <td className="px-4 py-3 text-slate-600">{summary.processing_passed} / {summary.processing_failed}</td>
                  <td className="px-4 py-3 text-slate-600">{summary.sheet_export_passed} / {summary.sheet_export_failed}</td>
                  <td className="px-4 py-3 text-slate-600">{formatDuration(summary.avg_time_taken_ms)}</td>
                  <td className="px-4 py-3 text-slate-600">{formatCost(summary.total_cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {Object.entries(scansByType).map(([scanType, scans]) => (
          <div key={scanType} className="overflow-hidden rounded-xl border border-slate-200">
            <div className="bg-slate-50 px-4 py-3">
              <h3 className="font-semibold text-slate-900">{scanType}</h3>
              <p className="text-xs text-slate-500">Detailed scan rows for {group.provider} / {group.model}</p>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-[1100px] divide-y divide-slate-200 text-sm">
                <thead className="bg-white text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Job</th>
                    <th className="px-4 py-3">Run / stage</th>
                    <th className="px-4 py-3">Created</th>
                    <th className="px-4 py-3">Updated</th>
                    <th className="px-4 py-3">Time taken</th>
                    <th className="px-4 py-3">Processing</th>
                    <th className="px-4 py-3">Sheet export</th>
                    <th className="px-4 py-3">Cost</th>
                    <th className="px-4 py-3">Error</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {scans.map((scan) => (
                    <tr key={`${scan.job_id}-${scan.run_id ?? 'single'}`}>
                      <td className="px-4 py-3 font-medium text-slate-900">#{scan.job_id}</td>
                      <td className="px-4 py-3 text-slate-600">{scan.run_id ? `Run #${scan.run_id} · Stage ${scan.stage ?? '—'}` : 'Single job'}</td>
                      <td className="px-4 py-3 text-slate-600">{formatDateTime(scan.created_at)}</td>
                      <td className="px-4 py-3 text-slate-600">{formatDateTime(scan.updated_at)}</td>
                      <td className="px-4 py-3 text-slate-600">{formatDuration(scan.time_taken_ms)}</td>
                      <td className="px-4 py-3"><StatusPill value={scan.processing_passed} /></td>
                      <td className="px-4 py-3"><StatusPill value={scan.sheet_export_passed} /></td>
                      <td className="px-4 py-3 text-slate-600">{formatCost(scan.estimated_cost)}</td>
                      <td className="max-w-xs px-4 py-3 text-slate-600">
                        <span className="line-clamp-3">{scan.error_message || scan.export_error || '—'}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-sm font-semibold text-slate-950">{value}</div>
    </div>
  );
}

export default function LlmsPage() {
  const [data, setData] = useState<LlmPerformanceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiService.getLlmPerformance({ limit: 1000 });
      setData(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load LLM performance');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.24em] text-indigo-500">LLMs</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">LLM Performance</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-600">
            Summarised and listwise LLM performance by scan type, with timestamps, runtime, processing pass/fail,
            Google Sheets export pass/fail, cost, and captured errors.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={loading}
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <Metric label="LLMs used" value={(data?.total_llms ?? 0).toLocaleString('en-IN')} />
        <Metric label="Total scans" value={(data?.total_scans ?? 0).toLocaleString('en-IN')} />
        <Metric label="Generated" value={formatDateTime(data?.generated_at)} />
      </div>

      {loading && !data ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">Loading LLM performance…</div>
      ) : null}

      {!loading && data && data.groups.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          No LLM scans were found for your account yet.
        </div>
      ) : null}

      <div className="space-y-8">
        {data?.groups.map((group) => (
          <LlmGroupCard key={group.llm_key} group={group} />
        ))}
      </div>
    </div>
  );
}

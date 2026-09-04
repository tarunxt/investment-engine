'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';

type LlmUsageBreakdownItem = {
  provider: string;
  provider_name: string;
  model: string;
  source: string;
  source_label: string;
  workflow: string;
  requests: number;
  tokens_in: number;
  tokens_out: number;
  estimated_cost: number;
  estimated_cost_inr: number | null;
  measurement?: 'actual' | 'reconciled' | 'estimated';
  cache_hit_tokens?: number;
  cache_miss_tokens?: number;
  source_note?: string | null;
};

type LlmUsageRunItem = {
  provider: string;
  provider_name: string;
  model: string;
  source: string;
  source_label: string;
  workflow: string;
  run_number: number | string | null;
  run_label: string;
  app_run_id: number | null;
  job_id: number | null;
  stage: number | null;
  status: string;
  timestamp: string;
  requests: number;
  tokens_in: number;
  tokens_out: number;
  estimated_cost: number;
  estimated_cost_inr: number | null;
  measurement: 'actual' | 'reconciled' | 'estimated';
  source_note?: string | null;
};

type LlmUsageBreakdownResponse = {
  timezone: string;
  period_label: string;
  from_date: string;
  to_date: string;
  usd_inr_rate: number | null;
  fx_status: string;
  request_metric: string;
  coverage_note: string;
  items: LlmUsageBreakdownItem[];
  runs: LlmUsageRunItem[];
};

type UsageGroup = {
  key: string;
  provider: string;
  providerName: string;
  model: string;
  items: LlmUsageBreakdownItem[];
  runs: LlmUsageRunItem[];
  totals: {
    requests: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    costInr: number | null;
  };
};

type UsageAreaGroup = {
  key: string;
  label: string;
  items: LlmUsageBreakdownItem[];
  runs: LlmUsageRunItem[];
  totals: UsageGroup['totals'];
};

const API_TIMEZONE = 'Asia/Kolkata';

function todayUsageIso() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: API_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function shiftIsoDate(isoDate: string, days: number) {
  const [year, month, day] = isoDate.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function formatDate(isoDate: string) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: API_TIMEZONE,
  });
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('en-IN').format(value);
}

function formatUsd(value: number) {
  return `$${value.toFixed(value > 0 && value < 0.01 ? 6 : 4)}`;
}

function formatCost(inr: number | null, usd: number) {
  if (inr == null) return `${formatUsd(usd)} (FX unavailable)`;
  return `₹${inr.toFixed(4)}`;
}

function formatTimestamp(value: string) {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) return value;
  return timestamp.toLocaleString('en-IN', {
    timeZone: API_TIMEZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

function formatStatus(value: string) {
  const normalized = value.trim().replaceAll('_', ' ');
  return normalized ? normalized[0].toUpperCase() + normalized.slice(1) : 'Completed';
}

function addNullableCost(current: number | null, next: number | null) {
  if (current == null || next == null) return null;
  return current + next;
}

function buildGroups(
  items: LlmUsageBreakdownItem[],
  runs: LlmUsageRunItem[],
  usdInrRate: number | null,
): UsageGroup[] {
  const groups = new Map<string, UsageGroup>();
  for (const item of items) {
    const key = `${item.provider}:${item.model}`;
    const group = groups.get(key) ?? {
      key,
      provider: item.provider,
      providerName: item.provider_name,
      model: item.model,
      items: [],
      runs: [],
      totals: {
        requests: 0,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        costInr: 0,
      },
    };
    group.items.push(item);
    group.totals.requests += item.requests;
    group.totals.tokensIn += item.tokens_in;
    group.totals.tokensOut += item.tokens_out;
    group.totals.costUsd += item.estimated_cost;
    group.totals.costInr = addNullableCost(
      group.totals.costInr,
      item.estimated_cost_inr,
    );
    groups.set(key, group);
  }
  for (const run of runs) {
    groups.get(`${run.provider}:${run.model}`)?.runs.push(run);
  }
  for (const group of groups.values()) {
    group.runs.sort((left, right) => right.timestamp.localeCompare(left.timestamp));
    group.totals.costInr = usdInrRate == null
      ? null
      : group.totals.costUsd * usdInrRate;
  }
  return Array.from(groups.values()).sort((left, right) =>
    `${left.providerName}:${left.model}`.localeCompare(
      `${right.providerName}:${right.model}`,
    ),
  );
}

function buildUsageAreas(
  group: UsageGroup,
  usdInrRate: number | null,
): UsageAreaGroup[] {
  const areas = new Map<string, UsageAreaGroup>();
  for (const item of group.items) {
    const area = areas.get(item.source) ?? {
      key: item.source,
      label: item.source_label,
      items: [],
      runs: [],
      totals: {
        requests: 0,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        costInr: 0,
      },
    };
    area.items.push(item);
    area.totals.requests += item.requests;
    area.totals.tokensIn += item.tokens_in;
    area.totals.tokensOut += item.tokens_out;
    area.totals.costUsd += item.estimated_cost;
    area.totals.costInr = addNullableCost(
      area.totals.costInr,
      item.estimated_cost_inr,
    );
    areas.set(item.source, area);
  }
  for (const run of group.runs) {
    areas.get(run.source)?.runs.push(run);
  }
  for (const area of areas.values()) {
    area.totals.costInr = usdInrRate == null
      ? null
      : area.totals.costUsd * usdInrRate;
  }
  const order: Record<string, number> = { indmoney: 0, zerodha: 1, bullpen: 2 };
  return Array.from(areas.values()).sort((left, right) =>
    (order[left.key] ?? 99) - (order[right.key] ?? 99)
    || left.label.localeCompare(right.label),
  );
}

export default function LlmUsageBreakdown() {
  const [selectedDate, setSelectedDate] = useState(todayUsageIso);
  const [data, setData] = useState<LlmUsageBreakdownResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const today = todayUsageIso();

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    const query = new URLSearchParams({
      period: 'custom',
      custom_start: selectedDate,
      custom_end: selectedDate,
    });
    try {
      const response = await fetch(
        `/backend-api/api-usage/llms/breakdown?${query.toString()}`,
        {
          method: 'GET',
          cache: 'no-store',
          credentials: 'same-origin',
          signal,
        },
      );
      const payload = (await response.json()) as
        | LlmUsageBreakdownResponse
        | { detail?: string; message?: string };
      if (!response.ok) {
        const errorPayload = payload as { detail?: string; message?: string };
        throw new Error(
          errorPayload.detail
          || errorPayload.message
          || 'Failed to load LLM usage breakdown.',
        );
      }
      setData(payload as LlmUsageBreakdownResponse);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === 'AbortError') {
        return;
      }
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'Failed to load LLM usage breakdown.',
      );
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [selectedDate]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void load(controller.signal);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [load]);

  const groups = useMemo(
    () => buildGroups(
      data?.items ?? [],
      data?.runs ?? [],
      data?.usd_inr_rate ?? null,
    ),
    [data],
  );

  return (
    <section className="border border-gray-200 bg-white p-4">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-950">
            LLM API Usage Breakdown
          </h2>
          <p className="text-sm text-gray-600">
            Actual provider-ledger usage where available; older days fall back to
            reconstructed Cred-X job estimates.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex h-9 items-center border border-gray-200 bg-white px-3 text-sm font-medium text-gray-900 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <RefreshCw className={`mr-2 size-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="mb-1 block text-xs text-gray-600">Breakdown day</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSelectedDate((current) => shiftIsoDate(current, -1))}
              aria-label="Show previous breakdown day"
              className="inline-flex size-9 items-center justify-center border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
            >
              <ChevronLeft className="size-4" />
            </button>
            <input
              type="date"
              value={selectedDate}
              max={today}
              onChange={(event) => setSelectedDate(event.target.value)}
              className="h-9 min-w-44 border border-gray-300 bg-white px-2 text-sm text-gray-900"
            />
            <button
              type="button"
              onClick={() => setSelectedDate((current) => shiftIsoDate(current, 1))}
              disabled={selectedDate >= today}
              aria-label="Show next breakdown day"
              className="inline-flex size-9 items-center justify-center border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
        </label>
        <div className="pb-2 text-sm font-medium text-gray-700">
          {formatDate(selectedDate)} · {data?.timezone ?? API_TIMEZONE}
        </div>
      </div>

      {error ? (
        <div className="mb-4 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      {loading && !data ? (
        <div className="py-10 text-center text-sm text-gray-500">
          Loading LLM usage breakdown...
        </div>
      ) : groups.length === 0 ? (
        <div className="border border-dashed border-gray-200 px-4 py-10 text-center text-sm text-gray-500">
          No non-zero LLM token usage was recorded for {formatDate(selectedDate)}.
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <div key={group.key} className="overflow-hidden border border-gray-200">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 bg-gray-50 px-4 py-3">
                <div>
                  <div className="font-semibold text-gray-950">
                    {group.providerName} · {group.model}
                  </div>
                  <div className="text-xs text-gray-500">
                    {formatNumber(group.totals.requests)} provider calls ·{' '}
                    {formatNumber(group.totals.tokensIn + group.totals.tokensOut)} total tokens
                  </div>
                </div>
                <div className="font-semibold text-gray-950">
                  {formatCost(group.totals.costInr, group.totals.costUsd)}
                </div>
              </div>
              <div className="space-y-4 p-3">
                {buildUsageAreas(group, data?.usd_inr_rate ?? null).map((area) => (
                  <section key={area.key} className="overflow-hidden border border-gray-200">
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 bg-white px-4 py-3">
                      <div>
                        <h3 className="font-semibold text-gray-950">{area.label}</h3>
                        <p className="text-xs text-gray-500">
                          {formatNumber(area.runs.length)} runs ·{' '}
                          {formatNumber(area.totals.requests)} requests ·{' '}
                          {formatNumber(area.totals.tokensIn + area.totals.tokensOut)} tokens
                        </p>
                      </div>
                      <div className="text-right font-semibold text-gray-950">
                        {formatCost(area.totals.costInr, area.totals.costUsd)}
                      </div>
                    </div>
                    {area.runs.length ? (
                      <div className="overflow-x-auto">
                        <table className="min-w-full text-sm">
                          <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                            <tr>
                              <th className="px-4 py-3">Run</th>
                              <th className="px-4 py-3">Timestamp</th>
                              <th className="px-4 py-3">Workflow</th>
                              <th className="px-4 py-3">Status</th>
                              <th className="px-4 py-3 text-right">Requests</th>
                              <th className="px-4 py-3 text-right">Tokens In</th>
                              <th className="px-4 py-3 text-right">Tokens Out</th>
                              <th className="px-4 py-3 text-right">Cost</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100 bg-white">
                            {area.runs.map((run) => (
                              <tr key={`${run.source}:${run.job_id ?? run.run_label}:${run.model}`}>
                                <td className="px-4 py-3 font-medium text-gray-900">
                                  {run.app_run_id != null ? (
                                    <a
                                      href={`/console/runs/${run.app_run_id}`}
                                      className="text-indigo-700 hover:underline"
                                    >
                                      {run.run_label}
                                    </a>
                                  ) : run.run_label}
                                  {run.job_id != null ? (
                                    <div className="text-xs font-normal text-gray-500">
                                      Job #{run.job_id}
                                      {run.stage != null ? ` · Stage ${run.stage}` : ''}
                                    </div>
                                  ) : null}
                                </td>
                                <td className="whitespace-nowrap px-4 py-3 text-gray-600">
                                  {formatTimestamp(run.timestamp)}
                                </td>
                                <td className="px-4 py-3 text-gray-600">{run.workflow}</td>
                                <td className="px-4 py-3 text-gray-700">
                                  {formatStatus(run.status)}
                                </td>
                                <td className="px-4 py-3 text-right text-gray-800">
                                  {formatNumber(run.requests)}
                                </td>
                                <td className="px-4 py-3 text-right text-gray-800">
                                  {formatNumber(run.tokens_in)}
                                </td>
                                <td className="px-4 py-3 text-right text-gray-800">
                                  {formatNumber(run.tokens_out)}
                                </td>
                                <td className="whitespace-nowrap px-4 py-3 text-right font-medium text-gray-900">
                                  {formatCost(run.estimated_cost_inr, run.estimated_cost)}
                                  <div className="text-xs font-normal text-gray-500">
                                    {formatUsd(run.estimated_cost)}
                                  </div>
                                  {run.measurement === 'actual' ? (
                                    <div className="text-xs font-semibold text-emerald-700">Actual</div>
                                  ) : run.measurement === 'reconciled' ? (
                                    <div className="text-xs font-semibold text-amber-700">Reconciled</div>
                                  ) : (
                                    <div className="text-xs text-gray-500">Estimated</div>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="px-4 py-4 text-sm text-gray-500">
                        No individual run attribution is available for this provider total.
                      </div>
                    )}
                    {area.runs.some((run) => run.measurement === 'reconciled') ? (
                      <p className="border-t border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-800">
                        Reconciled rows preserve the provider&apos;s exact daily total and allocate it across runs using persisted run telemetry.
                      </p>
                    ) : null}
                  </section>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {data?.coverage_note ? (
        <p className="mt-3 text-xs text-gray-500">{data.coverage_note}</p>
      ) : null}
    </section>
  );
}

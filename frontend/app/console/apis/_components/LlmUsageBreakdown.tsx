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
};

type UsageGroup = {
  key: string;
  provider: string;
  providerName: string;
  model: string;
  items: LlmUsageBreakdownItem[];
  totals: {
    requests: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    costInr: number | null;
  };
};

function todayUtcIso() {
  return new Date().toISOString().slice(0, 10);
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
    timeZone: 'UTC',
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

function addNullableCost(current: number | null, next: number | null) {
  if (current == null || next == null) return null;
  return current + next;
}

function buildGroups(items: LlmUsageBreakdownItem[]): UsageGroup[] {
  const groups = new Map<string, UsageGroup>();
  for (const item of items) {
    const key = `${item.provider}:${item.model}`;
    const group = groups.get(key) ?? {
      key,
      provider: item.provider,
      providerName: item.provider_name,
      model: item.model,
      items: [],
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
  return Array.from(groups.values()).sort((left, right) =>
    `${left.providerName}:${left.model}`.localeCompare(
      `${right.providerName}:${right.model}`,
    ),
  );
}

export default function LlmUsageBreakdown() {
  const [selectedDate, setSelectedDate] = useState(todayUtcIso);
  const [data, setData] = useState<LlmUsageBreakdownResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const today = todayUtcIso();

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
        throw new Error(
          'detail' in payload
            ? payload.detail || 'Failed to load LLM usage breakdown.'
            : payload.message || 'Failed to load LLM usage breakdown.',
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
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const groups = useMemo(() => buildGroups(data?.items ?? []), [data]);

  return (
    <section className="border border-gray-200 bg-white p-4">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-950">
            LLM API Usage Breakdown
          </h2>
          <p className="text-sm text-gray-600">
            Recorded usage by model and Cred-X workflow for the selected UTC day.
            Bullpen requests expand individual batches, retries and recovery calls.
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
          {formatDate(selectedDate)} · UTC
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
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-white text-left text-xs uppercase tracking-wide text-gray-500">
                    <tr>
                      <th className="px-4 py-3">Usage Area</th>
                      <th className="px-4 py-3">Workflow</th>
                      <th className="px-4 py-3 text-right">Requests</th>
                      <th className="px-4 py-3 text-right">Tokens In</th>
                      <th className="px-4 py-3 text-right">Tokens Out</th>
                      <th className="px-4 py-3 text-right">Est. Cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {group.items.map((item) => (
                      <tr key={`${item.source}:${item.workflow}`}>
                        <td className="px-4 py-3 font-medium text-gray-900">
                          {item.source_label}
                        </td>
                        <td className="px-4 py-3 text-gray-600">{item.workflow}</td>
                        <td className="px-4 py-3 text-right text-gray-800">
                          {formatNumber(item.requests)}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-800">
                          {formatNumber(item.tokens_in)}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-800">
                          {formatNumber(item.tokens_out)}
                        </td>
                        <td className="px-4 py-3 text-right font-medium text-gray-900">
                          {formatCost(item.estimated_cost_inr, item.estimated_cost)}
                        </td>
                      </tr>
                    ))}
                    <tr className="bg-gray-50 font-semibold text-gray-950">
                      <td className="px-4 py-3" colSpan={2}>Model total</td>
                      <td className="px-4 py-3 text-right">
                        {formatNumber(group.totals.requests)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {formatNumber(group.totals.tokensIn)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {formatNumber(group.totals.tokensOut)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {formatCost(group.totals.costInr, group.totals.costUsd)}
                      </td>
                    </tr>
                  </tbody>
                </table>
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

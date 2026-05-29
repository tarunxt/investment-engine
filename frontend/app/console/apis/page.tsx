'use client';

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { apiService } from '@/services/api';
import { ApiUsageSummaryResponse } from '@/types/api';

type Period = 'today' | 'week' | 'month' | 'custom';

export default function ApisPage() {
  const [data, setData] = useState<ApiUsageSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>('today');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [showAllGeminiKeys, setShowAllGeminiKeys] = useState(false);

  const load = useCallback(async () => {
    if (period === 'custom' && (!customStart || !customEnd)) {
      setError('Select both start and end date for custom range.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await apiService.getApiUsageSummary({
        period,
        custom_start: period === 'custom' ? customStart || undefined : undefined,
        custom_end: period === 'custom' ? customEnd || undefined : undefined,
      });
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load API usage');
    } finally {
      setLoading(false);
    }
  }, [period, customStart, customEnd]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-950">APIs</h1>
          <p className="text-sm text-gray-600">
            Per-API usage summary: {data?.period_label ?? 'Today'} ({data?.date ?? 'today'}) in {data?.timezone ?? 'Asia/Kolkata'}.
          </p>
          {data?.usd_inr_rate ? (
            <p className="text-xs text-gray-500">
              USD/INR: {data.usd_inr_rate.toFixed(4)}
            </p>
          ) : null}
        </div>
        <button
          onClick={() => void load()}
          className="inline-flex items-center border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-900 hover:bg-gray-50"
        >
          <RefreshCw className={`mr-2 size-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="mb-1 block text-xs text-gray-600">Duration</span>
          <select
            className="h-9 border border-gray-300 bg-white px-2"
            value={period}
            onChange={(e) => setPeriod(e.target.value as Period)}
          >
            <option value="today">Today</option>
            <option value="week">This week</option>
            <option value="month">This month</option>
            <option value="custom">Custom range</option>
          </select>
        </label>
        {period === 'custom' ? (
          <>
            <label className="text-sm">
              <span className="mb-1 block text-xs text-gray-600">From</span>
              <input
                type="date"
                className="h-9 border border-gray-300 bg-white px-2"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-xs text-gray-600">To</span>
              <input
                type="date"
                className="h-9 border border-gray-300 bg-white px-2"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
              />
            </label>
          </>
        ) : null}
      </div>

      {error ? (
        <div className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      ) : null}

      <div className="overflow-x-auto border border-gray-200 bg-white">
        {data ? (
          <div className="flex items-center justify-end border-b border-gray-100 px-4 py-2">
            <button
              type="button"
              onClick={() => setShowAllGeminiKeys((v) => !v)}
              className="text-xs font-medium text-indigo-600 hover:text-indigo-800"
            >
              {showAllGeminiKeys ? 'Hide unused Gemini keys' : 'Show unused Gemini keys'}
            </button>
          </div>
        ) : null}
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-4 py-3">API</th>
              <th className="px-4 py-3">Category</th>
              <th className="px-4 py-3">Configured</th>
              <th className="px-4 py-3">Requests</th>
              <th className="px-4 py-3">Tokens In</th>
              <th className="px-4 py-3">Tokens Out</th>
              <th className="px-4 py-3">Est. Cost</th>
              <th className="px-4 py-3">Limit / Day</th>
              <th className="px-4 py-3">Notes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-gray-500">
                  Loading API usage...
                </td>
              </tr>
            ) : data && data.items.length > 0 ? (
              data.items
                .filter((item) => {
                  if (!item.gemini_key_index) return true;
                  if (showAllGeminiKeys) return true;
                  return !item.gemini_key_hidden_default || !!item.gemini_key_in_use || !!item.gemini_key_consumed;
                })
                .map((item) => (
                <tr key={item.name}>
                  <td className="px-4 py-3 font-medium text-gray-950">
                    {item.console_url ? (
                      <a
                        href={item.console_url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-indigo-600 hover:text-indigo-800 hover:underline"
                      >
                        {item.name}
                      </a>
                    ) : (
                      item.name
                    )}
                    {item.gemini_key_masked ? (
                      <div className="text-xs font-normal text-gray-500">{item.gemini_key_masked}</div>
                    ) : null}
                    {item.gemini_key_in_use ? (
                      <div className="text-xs font-semibold text-emerald-700">Currently in use</div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-gray-700">{item.category}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex px-2 py-0.5 text-xs font-semibold ${
                        item.configured ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'
                      }`}
                    >
                      {item.configured ? 'Yes' : 'No'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-800">{item.daily_requests}</td>
                  <td className="px-4 py-3 text-gray-800">{item.daily_tokens_in}</td>
                  <td className="px-4 py-3 text-gray-800">{item.daily_tokens_out}</td>
                  <td className="px-4 py-3 text-gray-800">
                    <div>${item.daily_estimated_cost.toFixed(6)}</div>
                    <div className="text-xs text-gray-500">₹{item.daily_estimated_cost_inr.toFixed(4)}</div>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{item.daily_limit_requests ?? 'Provider plan'}</td>
                  <td className="px-4 py-3 text-gray-600">{item.notes ?? '-'}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-gray-500">
                  No API usage data yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

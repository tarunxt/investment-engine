'use client';

import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { apiService } from '@/services/api';
import { ApiUsageSummaryResponse } from '@/types/api';

export default function ApisPage() {
  const [data, setData] = useState<ApiUsageSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiService.getApiUsageSummary();
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load API usage');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-950">APIs</h1>
          <p className="text-sm text-gray-600">
            Per-API daily usage summary ({data?.date ?? 'today'}) in {data?.timezone ?? 'Asia/Kolkata'}.
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="inline-flex items-center border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-900 hover:bg-gray-50"
        >
          <RefreshCw className={`mr-2 size-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error ? (
        <div className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      ) : null}

      <div className="overflow-x-auto border border-gray-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-4 py-3">API</th>
              <th className="px-4 py-3">Category</th>
              <th className="px-4 py-3">Configured</th>
              <th className="px-4 py-3">Requests (Today)</th>
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
              data.items.map((item) => (
                <tr key={item.name}>
                  <td className="px-4 py-3 font-medium text-gray-950">{item.name}</td>
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
                  <td className="px-4 py-3 text-gray-800">${item.daily_estimated_cost.toFixed(6)}</td>
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


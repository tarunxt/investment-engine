'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw, X } from 'lucide-react';
import { apiService } from '@/services/api';
import { ApiUsageItem, ApiUsageSummaryResponse, LlmCostHistoryResponse } from '@/types/api';

type Period = 'day' | 'week' | 'month' | 'custom';

const API_TIMEZONE = 'Asia/Kolkata';

function getDateParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const parts = formatter.formatToParts(date);
  const day = parts.find((part) => part.type === 'day')?.value ?? '01';
  const month = parts.find((part) => part.type === 'month')?.value ?? '01';
  const year = parts.find((part) => part.type === 'year')?.value ?? '1970';

  return { day, month, year };
}

function getTodayIso(timeZone: string) {
  const { day, month, year } = getDateParts(new Date(), timeZone);
  return `${year}-${month}-${day}`;
}

function shiftIsoDate(isoDate: string, days: number) {
  const [year, month, day] = isoDate.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day));
  shifted.setUTCDate(shifted.getUTCDate() + days);

  const nextYear = shifted.getUTCFullYear();
  const nextMonth = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const nextDay = String(shifted.getUTCDate()).padStart(2, '0');

  return `${nextYear}-${nextMonth}-${nextDay}`;
}

function formatCalendarDate(isoDate: string) {
  const [year, month, day] = isoDate.split('-').map(Number);
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  const monthLabel = utcDate.toLocaleString('en-GB', {
    month: 'short',
    timeZone: 'UTC',
  });

  return `${day} ${monthLabel}, ${year}`;
}

function formatSelectedDayLabel(isoDate: string, todayIso: string) {
  return `${formatCalendarDate(isoDate)}${isoDate === todayIso ? ' (Today)' : ''}`;
}


type CostHistoryTab = 'day-wise' | 'all-runs';

const LLM_PROVIDER_BY_NAME: Record<string, string> = {
  OpenAI: 'openai',
  Anthropic: 'anthropic',
  DeepSeek: 'deepseek',
};

function getLlmProviderKey(item: ApiUsageItem) {
  if (item.category !== 'LLM') return null;
  if (item.gemini_key_index) return 'gemini';
  return LLM_PROVIDER_BY_NAME[item.name] ?? null;
}

function formatInr(value: number) {
  return `₹${value.toFixed(4)}`;
}

function formatHistoryTimestamp(value: string, timeZone: string) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}

function LlmCostHistoryModal({
  history,
  loading,
  error,
  activeTab,
  onTabChange,
  onClose,
  onSeeMoreDays,
  onSeeMoreRuns,
}: {
  history: LlmCostHistoryResponse | null;
  loading: boolean;
  error: string | null;
  activeTab: CostHistoryTab;
  onTabChange: (tab: CostHistoryTab) => void;
  onClose: () => void;
  onSeeMoreDays: () => void;
  onSeeMoreRuns: () => void;
}) {
  const timezone = history?.timezone ?? API_TIMEZONE;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-6">
      <div className="max-h-[90vh] w-full max-w-4xl overflow-hidden border border-gray-200 bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-gray-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-950">LLM Cost History</h2>
            <p className="text-sm text-gray-600">
              {history?.name ?? 'LLM'} cost history across all recorded runs.
            </p>
            {history ? (
              <p className="text-xs text-gray-500">USD/INR: {history.usd_inr_rate.toFixed(4)}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close LLM cost history"
            className="inline-flex size-9 items-center justify-center text-gray-500 hover:bg-gray-50 hover:text-gray-900"
          >
            <X className="size-5" />
          </button>
        </div>

        <div className="border-b border-gray-200 px-5 pt-3">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onTabChange('day-wise')}
              className={`border-b-2 px-3 py-2 text-sm font-medium ${
                activeTab === 'day-wise'
                  ? 'border-indigo-600 text-indigo-700'
                  : 'border-transparent text-gray-500 hover:text-gray-900'
              }`}
            >
              Day-wise
            </button>
            <button
              type="button"
              onClick={() => onTabChange('all-runs')}
              className={`border-b-2 px-3 py-2 text-sm font-medium ${
                activeTab === 'all-runs'
                  ? 'border-indigo-600 text-indigo-700'
                  : 'border-transparent text-gray-500 hover:text-gray-900'
              }`}
            >
              All runs
            </button>
          </div>
        </div>

        <div className="max-h-[65vh] overflow-y-auto p-5">
          {error ? (
            <div className="mb-4 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
          ) : null}

          {loading && !history ? (
            <div className="py-10 text-center text-sm text-gray-500">Loading LLM cost history...</div>
          ) : activeTab === 'day-wise' ? (
            <>
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Requests</th>
                    <th className="px-4 py-3">Tokens In</th>
                    <th className="px-4 py-3">Tokens Out</th>
                    <th className="px-4 py-3">Incurred Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {history?.days.map((day) => (
                    <tr key={day.date}>
                      <td className="px-4 py-3 font-medium text-gray-900">
                        {formatCalendarDate(day.date)}
                        {day.date === getTodayIso(timezone) ? <span className="ml-1 text-xs text-indigo-600">Today</span> : null}
                      </td>
                      <td className="px-4 py-3 text-gray-700">{day.requests}</td>
                      <td className="px-4 py-3 text-gray-700">{day.tokens_in}</td>
                      <td className="px-4 py-3 text-gray-700">{day.tokens_out}</td>
                      <td className="px-4 py-3 font-semibold text-gray-900">{formatInr(day.estimated_cost_inr)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {history?.has_more_days ? (
                <div className="mt-4 flex justify-center">
                  <button
                    type="button"
                    onClick={onSeeMoreDays}
                    disabled={loading}
                    className="border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-900 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {loading ? 'Loading...' : 'See more'}
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <>
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-4 py-3">Timestamp</th>
                    <th className="px-4 py-3">Job</th>
                    <th className="px-4 py-3">Model</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Incurred Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {history && history.runs.length > 0 ? (
                    history.runs.map((run) => (
                      <tr key={run.job_id}>
                        <td className="px-4 py-3 text-gray-800">{formatHistoryTimestamp(run.timestamp, timezone)}</td>
                        <td className="px-4 py-3 font-medium text-gray-900">#{run.job_id}</td>
                        <td className="px-4 py-3 text-gray-700">{run.model}</td>
                        <td className="px-4 py-3 text-gray-700">{run.status}</td>
                        <td className="px-4 py-3 font-semibold text-gray-900">{formatInr(run.estimated_cost_inr)}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                        No runs recorded for this LLM yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              {history?.has_more_runs ? (
                <div className="mt-4 flex justify-center">
                  <button
                    type="button"
                    onClick={onSeeMoreRuns}
                    disabled={loading}
                    className="border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-900 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {loading ? 'Loading...' : 'See more'}
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ApisPage() {
  const [data, setData] = useState<ApiUsageSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>('day');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [showAllGeminiKeys, setShowAllGeminiKeys] = useState(false);
  const [selectedDate, setSelectedDate] = useState(() => getTodayIso(API_TIMEZONE));
  const [costHistoryProvider, setCostHistoryProvider] = useState<string | null>(null);
  const [costHistory, setCostHistory] = useState<LlmCostHistoryResponse | null>(null);
  const [costHistoryLoading, setCostHistoryLoading] = useState(false);
  const [costHistoryError, setCostHistoryError] = useState<string | null>(null);
  const [costHistoryTab, setCostHistoryTab] = useState<CostHistoryTab>('day-wise');
  const [costHistoryDayLimit, setCostHistoryDayLimit] = useState(10);
  const [costHistoryRunLimit, setCostHistoryRunLimit] = useState(10);

  const todayIso = getTodayIso(API_TIMEZONE);
  const isViewingToday = selectedDate >= todayIso;

  const load = useCallback(async () => {
    if (period === 'custom' && (!customStart || !customEnd)) {
      setError('Select both start and end date for custom range.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const request =
        period === 'day'
          ? {
              period: 'custom' as const,
              custom_start: selectedDate,
              custom_end: selectedDate,
            }
          : {
              period: period === 'custom' ? 'custom' as const : period,
              custom_start: period === 'custom' ? customStart || undefined : undefined,
              custom_end: period === 'custom' ? customEnd || undefined : undefined,
            };
      const res = await apiService.getApiUsageSummary({
        period: request.period,
        custom_start: request.custom_start,
        custom_end: request.custom_end,
      });
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load API usage');
    } finally {
      setLoading(false);
    }
  }, [customEnd, customStart, period, selectedDate]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);


  const loadCostHistory = useCallback(async (provider: string, dayLimit: number, runLimit: number) => {
    setCostHistoryLoading(true);
    setCostHistoryError(null);
    try {
      const res = await apiService.getLlmCostHistory({
        provider,
        day_limit: dayLimit,
        run_limit: runLimit,
      });
      setCostHistory(res);
    } catch (err) {
      setCostHistoryError(err instanceof Error ? err.message : 'Failed to load LLM cost history');
    } finally {
      setCostHistoryLoading(false);
    }
  }, []);

  const openCostHistory = useCallback((provider: string) => {
    const initialDayLimit = 10;
    const initialRunLimit = 10;
    setCostHistoryProvider(provider);
    setCostHistory(null);
    setCostHistoryTab('day-wise');
    setCostHistoryDayLimit(initialDayLimit);
    setCostHistoryRunLimit(initialRunLimit);
    void loadCostHistory(provider, initialDayLimit, initialRunLimit);
  }, [loadCostHistory]);

  const closeCostHistory = useCallback(() => {
    setCostHistoryProvider(null);
    setCostHistory(null);
    setCostHistoryError(null);
  }, []);

  const seeMoreDays = useCallback(() => {
    if (!costHistoryProvider) return;
    const nextLimit = costHistoryDayLimit + 10;
    setCostHistoryDayLimit(nextLimit);
    void loadCostHistory(costHistoryProvider, nextLimit, costHistoryRunLimit);
  }, [costHistoryDayLimit, costHistoryProvider, costHistoryRunLimit, loadCostHistory]);

  const seeMoreRuns = useCallback(() => {
    if (!costHistoryProvider) return;
    const nextLimit = costHistoryRunLimit + 10;
    setCostHistoryRunLimit(nextLimit);
    void loadCostHistory(costHistoryProvider, costHistoryDayLimit, nextLimit);
  }, [costHistoryDayLimit, costHistoryProvider, costHistoryRunLimit, loadCostHistory]);

  const summaryLabel =
    period === 'day'
      ? formatSelectedDayLabel(selectedDate, todayIso)
      : period === 'custom' && customStart && customEnd
        ? customStart === customEnd
          ? formatSelectedDayLabel(customStart, todayIso)
          : `${formatCalendarDate(customStart)} to ${formatCalendarDate(customEnd)}`
        : data?.period_label ?? formatSelectedDayLabel(todayIso, todayIso);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-950">APIs</h1>
          <p className="text-sm text-gray-600">
            Per-API usage summary: {summaryLabel} in {data?.timezone ?? API_TIMEZONE}.
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
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSelectedDate((current) => shiftIsoDate(current, -1))}
              disabled={period !== 'day'}
              aria-label="Show previous day"
              title="Show previous day"
              className="inline-flex size-9 items-center justify-center border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ChevronLeft className="size-4" />
            </button>
            <select
              className="h-9 min-w-[16rem] border border-gray-300 bg-white px-2"
              value={period}
              onChange={(e) => setPeriod(e.target.value as Period)}
            >
              <option value="day">{formatSelectedDayLabel(selectedDate, todayIso)}</option>
              <option value="week">This week</option>
              <option value="month">This month</option>
              <option value="custom">Custom range</option>
            </select>
            <button
              type="button"
              onClick={() => setSelectedDate((current) => shiftIsoDate(current, 1))}
              disabled={period !== 'day' || isViewingToday}
              aria-label="Show next day"
              title="Show next day"
              className="inline-flex size-9 items-center justify-center border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
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
                .map((item) => {
                  const llmProviderKey = getLlmProviderKey(item);
                  return (
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
                    {llmProviderKey ? (
                      <button
                        type="button"
                        onClick={() => openCostHistory(llmProviderKey)}
                        className="font-medium text-indigo-600 hover:text-indigo-800 hover:underline"
                        title="Show LLM cost history"
                      >
                        ₹{item.daily_estimated_cost_inr.toFixed(4)}
                      </button>
                    ) : (
                      <>₹{item.daily_estimated_cost_inr.toFixed(4)}</>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{item.daily_limit_requests ?? 'Provider plan'}</td>
                  <td className="px-4 py-3 text-gray-600">{item.notes ?? '-'}</td>
                </tr>
                  );
              })
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

      {costHistoryProvider ? (
        <LlmCostHistoryModal
          history={costHistory}
          loading={costHistoryLoading}
          error={costHistoryError}
          activeTab={costHistoryTab}
          onTabChange={setCostHistoryTab}
          onClose={closeCostHistory}
          onSeeMoreDays={seeMoreDays}
          onSeeMoreRuns={seeMoreRuns}
        />
      ) : null}
    </div>
  );
}

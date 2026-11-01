'use client';

import { useMemo, useState } from 'react';
import { LlmCostHistoryResponse } from '@/types/api';

export const COMBINED_LLM_PROVIDERS = [
  { key: 'openai', name: 'OpenAI', color: '#4f46e5' },
  { key: 'anthropic', name: 'Anthropic', color: '#ea580c' },
  { key: 'gemini', name: 'Gemini', color: '#16a34a' },
  { key: 'deepseek', name: 'DeepSeek', color: '#eab308' },
] as const;

export type CombinedLlmProviderKey = (typeof COMBINED_LLM_PROVIDERS)[number]['key'];
export type CombinedLlmVisibility = Record<CombinedLlmProviderKey, boolean>;

function formatChartDayLabel(isoDate: string) {
  const [year, month, day] = isoDate.split('-').map(Number);
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  return utcDate.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    timeZone: 'UTC',
  });
}

export function CombinedLlmCostChart({
  histories,
  loading,
  failures,
  onRetry,
  visibility,
  onVisibilityChange,
}: {
  histories: Partial<Record<CombinedLlmProviderKey, LlmCostHistoryResponse>>;
  loading: boolean;
  failures: CombinedLlmProviderKey[];
  onRetry: () => void;
  visibility: CombinedLlmVisibility;
  onVisibilityChange: (provider: CombinedLlmProviderKey, visible: boolean) => void;
}) {
  const [selectedPointKey, setSelectedPointKey] = useState<{ provider: CombinedLlmProviderKey; date: string } | null>(null);

  const chart = useMemo(() => {
    const availableProviders = COMBINED_LLM_PROVIDERS.filter((provider) => histories[provider.key]);
    const visibleHistories = availableProviders.filter((provider) => visibility[provider.key]).map((provider) => histories[provider.key]!);
    // Plot native USD consistently; source FX metadata remains available alongside the chart.
    const currency = 'USD' as const;
    const dates = Array.from(new Set(visibleHistories.flatMap((history) => history.days.map((day) => day.date)))).sort();
    const valuesByProvider = Object.fromEntries(COMBINED_LLM_PROVIDERS.map((provider) => [
      provider.key, new Map(histories[provider.key]?.days.map((day) => [
        day.date, day.estimated_cost,
      ]) ?? []),
    ])) as Record<CombinedLlmProviderKey, Map<string, number>>;

    const activeProviders = availableProviders.filter((provider) => visibility[provider.key]);
    const visibleValues = activeProviders.flatMap((provider) =>
      dates.map((date) => valuesByProvider[provider.key].get(date) ?? 0)
    );
    const maxCost = Math.max(...visibleValues, 0);
    const yMax = maxCost > 0 ? maxCost * 1.15 : 1;

    return { dates, valuesByProvider, activeProviders, yMax, currency };
  }, [histories, visibility]);

  const formatCost = (value: number) => `$${value.toFixed(6)}`;
  const failedNames = COMBINED_LLM_PROVIDERS.filter((provider) => failures.includes(provider.key)).map((provider) => provider.name).join(', ');
  const hasHistory = Object.keys(histories).length > 0;
  const width = 920;
  const height = 320;
  const padding = { top: 24, right: 28, bottom: 58, left: 82 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const xForIndex = (index: number) =>
    chart.dates.length <= 1 ? padding.left + plotWidth / 2 : padding.left + (index / (chart.dates.length - 1)) * plotWidth;
  const yForCost = (cost: number) => padding.top + plotHeight - (cost / chart.yMax) * plotHeight;
  const gridValues = [0, chart.yMax * 0.25, chart.yMax * 0.5, chart.yMax * 0.75, chart.yMax];
  const xTickInterval = Math.max(1, Math.ceil(chart.dates.length / 8));
  const selectedProvider = selectedPointKey
    ? chart.activeProviders.find((provider) => provider.key === selectedPointKey.provider)
    : null;
  const selectedDateIndex = selectedPointKey ? chart.dates.indexOf(selectedPointKey.date) : -1;
  const selectedCost = selectedProvider && selectedPointKey
    ? chart.valuesByProvider[selectedProvider.key].get(selectedPointKey.date)
    : undefined;
  const selectedPoint = selectedProvider && selectedPointKey && selectedDateIndex >= 0 && selectedCost != null
    ? {
        provider: selectedProvider,
        date: selectedPointKey.date,
        cost: selectedCost,
        x: xForIndex(selectedDateIndex),
        y: yForCost(selectedCost),
      }
    : null;

  return (
    <section aria-label="LLM cost trend" className="rounded-xl border border-indigo-200 bg-indigo-50/60 p-4 text-slate-900 [&_button]:focus-visible:outline-2 [&_button]:focus-visible:outline-offset-2 [&_button]:focus-visible:outline-indigo-600 [&_input]:focus-visible:outline-2 [&_input]:focus-visible:outline-indigo-600">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-950">Combined LLM API Cost Trend</h2>
          <p className="text-sm text-gray-600">Daily API cost by provider using Asia/Kolkata calendar days. Provider-ledger totals take precedence over reconstructed job estimates. Y-axis: {chart.currency}; X-axis: day.</p>
        </div>
      </div>

      {failures.length > 0 ? (
        <div role="alert" className="mb-4 border rounded-md border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Cost trend unavailable for {failedNames}. {hasHistory ? 'Available history is shown; previously loaded history for failed providers may be out of date.' : 'Cost history could not be loaded.'}
          <button type="button" disabled={loading} onClick={onRetry} className="ml-3 rounded-md bg-indigo-600 px-3 py-2 text-white hover:bg-indigo-700 disabled:opacity-50">
            {loading ? 'Retrying cost trend…' : 'Retry cost trend'}
          </button>
        </div>
      ) : null}
        <div className="mb-3 flex flex-wrap gap-3" aria-label="Toggle LLM API cost lines">
          {COMBINED_LLM_PROVIDERS.map((provider) => (
            <label key={provider.key} className="inline-flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={visibility[provider.key]}
                onChange={(event) => onVisibilityChange(provider.key, event.target.checked)}
                className="size-4 accent-indigo-600"
              />
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2.5 rounded-full" style={{ backgroundColor: provider.color }} />
                {provider.name}
              </span>
            </label>
          ))}
        </div>
      {hasHistory && chart.currency === 'USD' ? <p className="mb-3 text-xs text-amber-700">Native USD is used for all visible providers when INR conversion is incomplete, stale or unavailable. Stale FX is never applied.</p> : null}
      {hasHistory ? <details open className="mb-4 text-xs text-slate-600">
        <summary className="cursor-pointer font-medium">Cost source and FX details</summary>
        <ul className="mt-2 space-y-1" aria-label="Cost trend provenance">
        {COMBINED_LLM_PROVIDERS.map((provider) => {
          const history = histories[provider.key];
          if (!history) return null;
          return <li key={provider.key}>
            {provider.name}: {history.coverage_note ?? 'Provider-ledger totals take precedence over reconstructed job estimates.'}
            {' '}FX {history.fx_status ?? 'unavailable'}{history.fx_source ? ` · ${history.fx_source}` : ''}
            {history.fx_as_of ? ` · as of ${history.fx_as_of}` : ''}
            {history.fx_status === 'valid' && history.usd_inr_rate != null ? ` · USD/INR ${history.usd_inr_rate.toFixed(4)}` : ' · native USD retained; INR conversion unavailable'}
            {history.generated_at ? ` · history generated ${history.generated_at}` : ''}
            {failures.includes(provider.key) ? ' · previously loaded; retry failed' : ''}
          </li>;
        })}
      </ul></details> : null}
      {loading && hasHistory ? <p role="status" className="mb-3 text-sm text-gray-600">Refreshing cost trend; showing previously loaded history.</p> : null}

      {loading && chart.dates.length === 0 ? (
        <div role="status" className="py-12 text-center text-sm text-gray-500">Loading combined LLM cost chart...</div>
      ) : !Object.values(visibility).some(Boolean) ? (
        <div className="py-12 text-center text-sm text-gray-500">Select at least one LLM API to view the cost chart.</div>
      ) : chart.dates.length === 0 && failures.length > 0 ? null : chart.dates.length === 0 ? (
        <div className="py-12 text-center text-sm text-gray-500">No LLM cost history available yet.</div>
      ) : chart.activeProviders.length === 0 ? (
        <div className="py-12 text-center text-sm text-gray-500">Select at least one LLM API to view the cost chart.</div>
      ) : (
        <div className="overflow-x-auto">
          <svg
            role="img"
            aria-label="Combined LLM API cost line chart"
            viewBox={`0 0 ${width} ${height}`}
            className="min-w-[760px]"
            onClick={() => setSelectedPointKey(null)}
          >
            <line x1={padding.left} y1={padding.top} x2={padding.left} y2={padding.top + plotHeight} stroke="#d1d5db" />
            <line
              x1={padding.left}
              y1={padding.top + plotHeight}
              x2={padding.left + plotWidth}
              y2={padding.top + plotHeight}
              stroke="#d1d5db"
            />
            {gridValues.map((value) => {
              const y = yForCost(value);
              return (
                <g key={value}>
                  <line x1={padding.left} y1={y} x2={padding.left + plotWidth} y2={y} stroke="#eef2f7" />
                  <text x={padding.left - 12} y={y + 4} textAnchor="end" className="fill-gray-500 text-[11px]">
                    {`$${value.toFixed(6)}`}
                  </text>
                </g>
              );
            })}
            {chart.dates.map((date, index) => {
              if (index % xTickInterval !== 0 && index !== chart.dates.length - 1) return null;
              const x = xForIndex(index);
              return (
                <g key={date}>
                  <line x1={x} y1={padding.top + plotHeight} x2={x} y2={padding.top + plotHeight + 5} stroke="#9ca3af" />
                  <text x={x} y={padding.top + plotHeight + 24} textAnchor="middle" className="fill-gray-500 text-[11px]">
                    {formatChartDayLabel(date)}
                  </text>
                </g>
              );
            })}
            <text
              x={18}
              y={padding.top + plotHeight / 2}
              transform={`rotate(-90 18 ${padding.top + plotHeight / 2})`}
              textAnchor="middle"
              className="fill-gray-600 text-xs font-medium"
            >
              Cost ({chart.currency})
            </text>
            <text
              x={padding.left + plotWidth / 2}
              y={height - 12}
              textAnchor="middle"
              className="fill-gray-600 text-xs font-medium"
            >
              Day
            </text>
            {chart.activeProviders.map((provider) => {
              const points = chart.dates.map((date, index) => {
                const cost = chart.valuesByProvider[provider.key].get(date);
                return cost == null ? null : { date, cost, x: xForIndex(index), y: yForCost(cost) };
              });
              const path = points.map((point, index) => point ? `${index === 0 || !points[index - 1] ? 'M' : 'L'} ${point.x} ${point.y}` : '').join(' ');
              return (
                <g key={provider.key}>
                  <path d={path} fill="none" stroke={provider.color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
                  {points.map((point) => {
                    if (!point) return null;
                    const pointLabel = `${provider.name} ${formatChartDayLabel(point.date)}: ${formatCost(point.cost)}`;
                    return (
                      <g
                        key={`${provider.key}-${point.date}`}
                        role="button"
                        tabIndex={0}
                        aria-label={`Show exact value for ${pointLabel}`}
                        className="cursor-pointer focus-visible:outline-2 focus-visible:outline-indigo-600"
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedPointKey({ provider: provider.key, date: point.date });
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter' && event.key !== ' ') return;
                          event.preventDefault();
                          setSelectedPointKey({ provider: provider.key, date: point.date });
                        }}
                      >
                        <circle cx={point.x} cy={point.y} r={8} fill="transparent" />
                        <circle cx={point.x} cy={point.y} r={3.5} fill={provider.color}>
                          <title>{pointLabel}</title>
                        </circle>
                      </g>
                    );
                  })}
                </g>
              );
            })}
            {selectedPoint ? (
              <g pointerEvents="none">
                <line
                  x1={selectedPoint.x}
                  y1={selectedPoint.y - 9}
                  x2={selectedPoint.x}
                  y2={Math.max(padding.top, selectedPoint.y - 34)}
                  stroke={selectedPoint.provider.color}
                  strokeDasharray="3 3"
                />
                <rect
                  x={Math.min(Math.max(padding.left + 6, selectedPoint.x - 74), padding.left + plotWidth - 148)}
                  y={Math.max(padding.top + 4, selectedPoint.y - 72)}
                  width={148}
                  height={46}
                  rx={6}
                  fill="white"
                  stroke={selectedPoint.provider.color}
                  strokeWidth={1.5}
                />
                <text
                  x={Math.min(Math.max(padding.left + 80, selectedPoint.x), padding.left + plotWidth - 74)}
                  y={Math.max(padding.top + 23, selectedPoint.y - 52)}
                  textAnchor="middle"
                  className="fill-gray-900 text-[11px] font-semibold"
                >
                  {selectedPoint.provider.name} · {formatChartDayLabel(selectedPoint.date)}
                </text>
                <text
                  x={Math.min(Math.max(padding.left + 80, selectedPoint.x), padding.left + plotWidth - 74)}
                  y={Math.max(padding.top + 40, selectedPoint.y - 35)}
                  textAnchor="middle"
                  className="fill-gray-700 text-[11px]"
                >
                  Exact value: {formatCost(selectedPoint.cost)}
                </text>
              </g>
            ) : null}
          </svg>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs text-gray-600">
            {chart.activeProviders.map((provider) => {
              const latestDate = chart.dates[chart.dates.length - 1];
              const latestCost = chart.valuesByProvider[provider.key].get(latestDate);
              return (
                <div key={provider.key} className="inline-flex items-center gap-1.5">
                  <span className="size-2.5 rounded-full" style={{ backgroundColor: provider.color }} />
                  <span>{provider.name}: {latestCost == null ? 'Unavailable' : formatCost(latestCost)} latest day</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}


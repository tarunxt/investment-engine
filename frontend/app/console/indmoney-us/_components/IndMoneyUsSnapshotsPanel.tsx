'use client';

import {
  Activity,
  AlertTriangle,
  Database,
  Loader2,
  PiggyBank,
  Target,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { useState } from 'react';

import { SortableTableHeader } from '@/components/shared/SortableTableHeader';
import { TradingViewSymbolLink } from '@/components/shared/TradingViewSymbolLink';
import { sortItems, type SortState, toggleSortState } from '@/lib/tableSorting';
import { cn } from '@/lib/utils';
import type {
  IndMoneyUsHolding,
  IndMoneyUsMarketIndex,
  IndMoneyUsPortfolioOverviewResponse,
  IndMoneyUsPortfolioSnapshotDetail,
  IndMoneyUsPortfolioSnapshotSummary,
  IndMoneyUsReconciliationItem,
} from '@/types/api';

function formatCurrency(value: number | null | undefined) {
  if (value == null) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(value);
}

function formatCount(value: number | null | undefined) {
  if (value == null) return '—';
  return new Intl.NumberFormat('en-IN').format(value);
}

function formatPercent(value: number | null | undefined) {
  if (value == null) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

function formatSnapshotDate(value: string) {
  return new Date(`${value}T00:00:00`).toLocaleDateString('en-IN', {
    dateStyle: 'medium',
  });
}

function formatCapturedAt(value: string) {
  return new Date(value).toLocaleString('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function formatSnapshotTime(value: string) {
  return new Date(value).toLocaleTimeString('en-IN', {
    timeStyle: 'short',
  });
}

function formatShortSnapshotDate(value: string) {
  return new Date(`${value}T00:00:00`).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
  });
}

function toneClass(value: number | null | undefined) {
  if (value == null) return 'text-gray-500';
  if (value > 0) return 'text-emerald-600';
  if (value < 0) return 'text-red-600';
  return 'text-gray-500';
}

function statusClass(status: string) {
  if (status === 'parsed') return 'border border-emerald-700 bg-emerald-600 text-white ring-emerald-700';
  if (status === 'partial') return 'bg-amber-50 text-amber-700 ring-amber-200';
  return 'bg-gray-50 text-gray-700 ring-gray-200';
}

type SortDirection = 'asc' | 'desc';
type IndMoneyHoldingsSortColumn =
  | 'stock'
  | 'quantity'
  | 'average_price'
  | 'market_price'
  | 'invested_value'
  | 'current_value'
  | 'total_pnl'
  | 'total_pnl_percent'
  | 'portfolio_weight_percent'
  | 'market_change_percent';
type IndMoneyHoldingsSortState = {
  column: IndMoneyHoldingsSortColumn;
  direction: SortDirection;
} | null;

const HOLDINGS_SORT_ACCESSORS: Record<
  IndMoneyHoldingsSortColumn,
  {
    type: 'number' | 'text';
    getValue: (holding: IndMoneyUsHolding) => number | string | null | undefined;
  }
> = {
  stock: {
    type: 'text',
    getValue: (holding) => holding.company_name || holding.symbol,
  },
  quantity: {
    type: 'number',
    getValue: (holding) => holding.quantity,
  },
  average_price: {
    type: 'number',
    getValue: (holding) => holding.average_price,
  },
  market_price: {
    type: 'number',
    getValue: (holding) => holding.market_price,
  },
  invested_value: {
    type: 'number',
    getValue: (holding) => holding.invested_value,
  },
  current_value: {
    type: 'number',
    getValue: (holding) => holding.current_value,
  },
  total_pnl: {
    type: 'number',
    getValue: (holding) => holding.total_pnl,
  },
  total_pnl_percent: {
    type: 'number',
    getValue: (holding) => holding.total_pnl_percent,
  },
  portfolio_weight_percent: {
    type: 'number',
    getValue: (holding) => holding.portfolio_weight_percent,
  },
  market_change_percent: {
    type: 'number',
    getValue: (holding) => holding.market_change_percent,
  },
};

type CompactHoldingsSortColumn =
  | 'stock'
  | 'portfolio_weight_percent'
  | 'current_value'
  | 'total_pnl'
  | 'total_pnl_percent';
type ReconciliationSortColumn = 'label' | 'summary_value' | 'parsed_value' | 'delta';
type MarketIndexSortColumn = 'name' | 'value' | 'change_value' | 'change_percent';

const COMPACT_HOLDINGS_SORT_ACCESSORS = {
  stock: {
    type: 'text',
    getValue: (holding: IndMoneyUsHolding) => holding.company_name || holding.symbol,
  },
  portfolio_weight_percent: {
    type: 'number',
    getValue: (holding: IndMoneyUsHolding) => holding.portfolio_weight_percent,
  },
  current_value: {
    type: 'number',
    getValue: (holding: IndMoneyUsHolding) => holding.current_value,
  },
  total_pnl: {
    type: 'number',
    getValue: (holding: IndMoneyUsHolding) => holding.total_pnl,
  },
  total_pnl_percent: {
    type: 'number',
    getValue: (holding: IndMoneyUsHolding) => holding.total_pnl_percent,
  },
} satisfies Record<CompactHoldingsSortColumn, { type: 'number' | 'text'; getValue: (holding: IndMoneyUsHolding) => number | string | null | undefined }>;

const RECONCILIATION_SORT_ACCESSORS = {
  label: {
    type: 'text',
    getValue: (item: IndMoneyUsReconciliationItem) => item.label,
  },
  summary_value: {
    type: 'number',
    getValue: (item: IndMoneyUsReconciliationItem) => item.summary_value,
  },
  parsed_value: {
    type: 'number',
    getValue: (item: IndMoneyUsReconciliationItem) => item.parsed_value,
  },
  delta: {
    type: 'number',
    getValue: (item: IndMoneyUsReconciliationItem) => item.delta,
  },
} satisfies Record<ReconciliationSortColumn, { type: 'number' | 'text'; getValue: (item: IndMoneyUsReconciliationItem) => number | string | null | undefined }>;

const MARKET_INDEX_SORT_ACCESSORS = {
  name: {
    type: 'text',
    getValue: (index: IndMoneyUsMarketIndex) => index.name,
  },
  value: {
    type: 'number',
    getValue: (index: IndMoneyUsMarketIndex) => index.value,
  },
  change_value: {
    type: 'number',
    getValue: (index: IndMoneyUsMarketIndex) => index.change_value,
  },
  change_percent: {
    type: 'number',
    getValue: (index: IndMoneyUsMarketIndex) => index.change_percent,
  },
} satisfies Record<MarketIndexSortColumn, { type: 'number' | 'text'; getValue: (index: IndMoneyUsMarketIndex) => number | string | null | undefined }>;

function sortIndMoneyHoldings(holdings: IndMoneyUsHolding[], sortState: IndMoneyHoldingsSortState) {
  return sortItems(holdings, sortState, HOLDINGS_SORT_ACCESSORS, (holding) => holding.symbol);
}

function formatIndexNumber(value: number | null | undefined) {
  if (value == null) return '—';
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2,
  }).format(value);
}

function MetricCard({
  label,
  value,
  sublabel,
  tone = 'default',
  icon: Icon,
}: {
  label: string;
  value: string;
  sublabel?: string;
  tone?: 'default' | 'positive' | 'negative';
  icon: typeof Wallet;
}) {
  const toneStyles =
    tone === 'positive'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
      : tone === 'negative'
        ? 'border-red-200 bg-red-50 text-red-900'
        : 'border-gray-200 bg-white text-gray-900';

  return (
    <div className={cn('border px-4 py-3 shadow-sm', toneStyles)}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">{label}</span>
        <Icon className="size-4 text-gray-400" />
      </div>
      <p className="mt-3 text-lg font-semibold">{value}</p>
      {sublabel ? <p className="mt-1 text-xs text-gray-500">{sublabel}</p> : null}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="border border-dashed border-gray-300 bg-white px-6 py-10 text-center shadow-sm">
      <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-gray-100">
        <Database className="size-5 text-gray-500" />
      </div>
      <h3 className="mt-4 text-sm font-semibold text-gray-900">No INDmoney snapshots yet</h3>
      <p className="mt-2 text-sm text-gray-500">
        Paste your daily INDmoney US Stocks screen above to start building a manual portfolio history.
      </p>
    </div>
  );
}

function SnapshotHistoryChart({
  history,
  selectedSnapshotId,
  onSelect,
}: {
  history: IndMoneyUsPortfolioSnapshotSummary[];
  selectedSnapshotId: number | null;
  onSelect: (snapshotId: number) => void;
}) {
  const chartData = [...history]
    .sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date))
    .map((snapshot) => ({
      ...snapshot,
      value: snapshot.current_value || 0,
    }));

  if (chartData.length === 0) {
    return null;
  }

  const values = chartData.map((snapshot) => snapshot.value);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const valueRange = maxValue - minValue || 1;
  const width = 1000;
  const height = 300;
  const padding = { top: 18, right: 28, bottom: 44, left: 76 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const points = chartData.map((snapshot, index) => {
    const x = padding.left + (chartData.length === 1 ? plotWidth / 2 : (index / (chartData.length - 1)) * plotWidth);
    const y = padding.top + (1 - (snapshot.value - minValue) / valueRange) * plotHeight;

    return { ...snapshot, x, y };
  });
  const path = points.map((point) => `${point.x},${point.y}`).join(' ');
  const yTicks = [maxValue, minValue + valueRange / 2, minValue];
  const selectedPoint = points.find((point) => point.id === selectedSnapshotId) ?? points.at(-1);

  return (
    <div className="flex h-full flex-col border-t border-gray-200 px-5 py-5 xl:border-l xl:border-t-0">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">Daily History</span>
          <p className="mt-1 text-sm text-gray-500">Current value trend across saved INDmoney snapshots.</p>
        </div>
        {selectedPoint ? (
          <div className="text-sm sm:text-right">
            <p className="font-semibold text-gray-950">{formatCurrency(selectedPoint.value)}</p>
            <p className="text-xs text-gray-500">
              {formatSnapshotDate(selectedPoint.snapshot_date)} · Saved {formatSnapshotTime(selectedPoint.captured_at)}
            </p>
          </div>
        ) : null}
      </div>

      <div className="mt-4 min-h-[24rem] flex-1 overflow-x-auto">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Daily INDmoney portfolio current value history" className="h-full min-h-[24rem] min-w-[44rem]">
          <defs>
            <linearGradient id="indmoney-history-area" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#10b981" stopOpacity="0.22" />
              <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
            </linearGradient>
          </defs>
          {yTicks.map((tick, index) => {
            const y = padding.top + (1 - (tick - minValue) / valueRange) * plotHeight;

            return (
              <g key={`${tick}-${index}`}>
                <line x1={padding.left} x2={width - padding.right} y1={y} y2={y} stroke="#e5e7eb" strokeDasharray="4 4" />
                <text x={padding.left - 12} y={y + 4} textAnchor="end" className="fill-gray-400 text-[11px]">
                  {formatCurrency(tick)}
                </text>
              </g>
            );
          })}
          {points.length > 0 ? (
            <>
              <polygon
                points={`${padding.left},${padding.top + plotHeight} ${path} ${width - padding.right},${padding.top + plotHeight}`}
                fill="url(#indmoney-history-area)"
              />
              <polyline points={path} fill="none" stroke="#059669" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
            </>
          ) : null}
          {points.map((point) => {
            const isActive = selectedSnapshotId === point.id;

            return (
              <g key={point.id} className="cursor-pointer" onClick={() => onSelect(point.id)}>
                <title>{`${formatSnapshotDate(point.snapshot_date)} · ${formatCurrency(point.value)}`}</title>
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={isActive ? 8 : 5}
                  fill={isActive ? '#020617' : '#10b981'}
                  stroke="white"
                  strokeWidth="3"
                />
                <text
                  x={point.x}
                  y={height - 20}
                  textAnchor="middle"
                  className={cn('fill-gray-400 text-[11px]', isActive && 'fill-gray-950 font-semibold')}
                >
                  {formatShortSnapshotDate(point.snapshot_date)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}


function CompactHoldingsTable({
  title,
  holdings,
}: {
  title: string;
  holdings: IndMoneyUsHolding[];
}) {
  const [sortState, setSortState] = useState<SortState<CompactHoldingsSortColumn>>(null);
  const sortedHoldings = sortItems(holdings, sortState, COMPACT_HOLDINGS_SORT_ACCESSORS, (holding) => holding.symbol);

  return (
    <div className="border border-gray-200 bg-white shadow-sm">
      <div className="border-b border-gray-200 px-5 py-4">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500">{title}</h3>
      </div>
      <div className="overflow-x-auto p-5">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">
              <SortableTableHeader
                label="Stock"
                activeDirection={sortState?.column === 'stock' ? sortState.direction : null}
                onToggle={() => setSortState((currentSort) => toggleSortState(currentSort, 'stock'))}
                className="pb-2 pr-4"
              />
              <SortableTableHeader
                label="Weight"
                activeDirection={sortState?.column === 'portfolio_weight_percent' ? sortState.direction : null}
                onToggle={() =>
                  setSortState((currentSort) => toggleSortState(currentSort, 'portfolio_weight_percent'))
                }
                className="pb-2 pr-4"
              />
              <SortableTableHeader
                label="Current"
                activeDirection={sortState?.column === 'current_value' ? sortState.direction : null}
                onToggle={() => setSortState((currentSort) => toggleSortState(currentSort, 'current_value'))}
                className="pb-2 pr-4"
              />
              <SortableTableHeader
                label="P&L"
                activeDirection={sortState?.column === 'total_pnl' ? sortState.direction : null}
                onToggle={() => setSortState((currentSort) => toggleSortState(currentSort, 'total_pnl'))}
                className="pb-2 pr-4"
              />
              <SortableTableHeader
                label="P&L %"
                activeDirection={sortState?.column === 'total_pnl_percent' ? sortState.direction : null}
                onToggle={() =>
                  setSortState((currentSort) => toggleSortState(currentSort, 'total_pnl_percent'))
                }
                className="pb-2"
              />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {sortedHoldings.map((holding) => (
              <tr key={`${title}-${holding.symbol}`} className="hover:bg-gray-50">
                <td className="py-2.5 pr-4">
                  <TradingViewSymbolLink symbol={holding.symbol} market="us" className="group inline-flex flex-col">
                    <span className="font-medium text-gray-900 transition-colors group-hover:text-blue-700">
                      {holding.symbol}
                    </span>
                    <span className="text-xs text-gray-500 transition-colors group-hover:text-blue-600">
                      {holding.company_name}
                    </span>
                  </TradingViewSymbolLink>
                </td>
                <td className="py-2.5 pr-4 text-gray-700">{formatPercent(holding.portfolio_weight_percent)}</td>
                <td className="py-2.5 pr-4 text-gray-700">{formatCurrency(holding.current_value)}</td>
                <td className={cn('py-2.5 pr-4 font-medium', toneClass(holding.total_pnl))}>
                  {formatCurrency(holding.total_pnl)}
                </td>
                <td className={cn('py-2.5 font-medium', toneClass(holding.total_pnl_percent))}>
                  {formatPercent(holding.total_pnl_percent)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {holdings.length === 0 ? (
          <p className="py-6 text-center text-sm text-gray-400">No holdings were parsed for this table.</p>
        ) : null}
      </div>
    </div>
  );
}

function ReconciliationTable({ items }: { items: IndMoneyUsReconciliationItem[] }) {
  const [sortState, setSortState] = useState<SortState<ReconciliationSortColumn>>(null);
  const sortedItems = sortItems(items, sortState, RECONCILIATION_SORT_ACCESSORS, (item) => item.label);

  return (
    <div className="border border-gray-200 bg-white shadow-sm">
      <div className="border-b border-gray-200 px-5 py-4">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500">Reconciliation</h3>
      </div>
      <div className="overflow-x-auto p-5">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">
              <SortableTableHeader
                label="Metric"
                activeDirection={sortState?.column === 'label' ? sortState.direction : null}
                onToggle={() => setSortState((currentSort) => toggleSortState(currentSort, 'label'))}
                className="pb-2 pr-4"
              />
              <SortableTableHeader
                label="Snapshot"
                activeDirection={sortState?.column === 'summary_value' ? sortState.direction : null}
                onToggle={() => setSortState((currentSort) => toggleSortState(currentSort, 'summary_value'))}
                className="pb-2 pr-4"
              />
              <SortableTableHeader
                label="Parsed"
                activeDirection={sortState?.column === 'parsed_value' ? sortState.direction : null}
                onToggle={() => setSortState((currentSort) => toggleSortState(currentSort, 'parsed_value'))}
                className="pb-2 pr-4"
              />
              <SortableTableHeader
                label="Delta"
                activeDirection={sortState?.column === 'delta' ? sortState.direction : null}
                onToggle={() => setSortState((currentSort) => toggleSortState(currentSort, 'delta'))}
                className="pb-2"
              />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {sortedItems.map((item) => (
              <tr key={item.label} className="hover:bg-gray-50">
                <td className="py-2.5 pr-4 font-medium text-gray-900">{item.label}</td>
                <td className="py-2.5 pr-4 text-gray-700">
                  {item.label === 'Holdings Count' ? formatCount(item.summary_value) : formatCurrency(item.summary_value)}
                </td>
                <td className="py-2.5 pr-4 text-gray-700">
                  {item.label === 'Holdings Count' ? formatCount(item.parsed_value) : formatCurrency(item.parsed_value)}
                </td>
                <td className={cn('py-2.5 font-medium', toneClass(item.delta))}>
                  {item.label === 'Holdings Count' ? formatCount(item.delta) : formatCurrency(item.delta)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MarketIndicesTable({ indices }: { indices: IndMoneyUsMarketIndex[] }) {
  const [sortState, setSortState] = useState<SortState<MarketIndexSortColumn>>(null);
  const sortedIndices = sortItems(indices, sortState, MARKET_INDEX_SORT_ACCESSORS, (index) => index.name);

  return (
    <div className="border border-gray-200 bg-white shadow-sm">
      <div className="border-b border-gray-200 px-5 py-4">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500">Market Indices</h3>
      </div>
      <div className="overflow-x-auto p-5">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">
              <SortableTableHeader
                label="Index"
                activeDirection={sortState?.column === 'name' ? sortState.direction : null}
                onToggle={() => setSortState((currentSort) => toggleSortState(currentSort, 'name'))}
                className="pb-2 pr-4"
              />
              <SortableTableHeader
                label="Value"
                activeDirection={sortState?.column === 'value' ? sortState.direction : null}
                onToggle={() => setSortState((currentSort) => toggleSortState(currentSort, 'value'))}
                className="pb-2 pr-4"
              />
              <SortableTableHeader
                label="Change"
                activeDirection={sortState?.column === 'change_value' ? sortState.direction : null}
                onToggle={() => setSortState((currentSort) => toggleSortState(currentSort, 'change_value'))}
                className="pb-2 pr-4"
              />
              <SortableTableHeader
                label="Change %"
                activeDirection={sortState?.column === 'change_percent' ? sortState.direction : null}
                onToggle={() => setSortState((currentSort) => toggleSortState(currentSort, 'change_percent'))}
                className="pb-2"
              />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {sortedIndices.map((index) => (
              <tr key={index.name} className="hover:bg-gray-50">
                <td className="py-2.5 pr-4 font-medium text-gray-900">{index.name}</td>
                <td className="py-2.5 pr-4 text-gray-700">{formatIndexNumber(index.value)}</td>
                <td className={cn('py-2.5 pr-4 font-medium', toneClass(index.change_value))}>
                  {formatIndexNumber(index.change_value)}
                </td>
                <td className={cn('py-2.5 font-medium', toneClass(index.change_percent))}>
                  {formatPercent(index.change_percent)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {indices.length === 0 ? (
          <p className="py-8 text-center text-sm text-gray-400">
            No market indices were detected in this pasted snapshot.
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function IndMoneyUsSnapshotsPanel({
  overview,
  selectedSnapshot,
  selectedSnapshotId,
  loading,
  selecting,
  error,
  onSelectSnapshot,
}: {
  overview: IndMoneyUsPortfolioOverviewResponse | null;
  selectedSnapshot: IndMoneyUsPortfolioSnapshotDetail | null;
  selectedSnapshotId: number | null;
  loading: boolean;
  selecting: boolean;
  error: string | null;
  onSelectSnapshot: (snapshotId: number) => void;
}) {
  const [holdingsSort, setHoldingsSort] = useState<SortState<IndMoneyHoldingsSortColumn>>(null);

  if (loading) {
    return (
      <div className="flex items-center gap-2 border border-gray-200 bg-white px-5 py-4 text-sm text-gray-500 shadow-sm">
        <Loader2 className="size-4 animate-spin" />
        Loading INDmoney portfolio history…
      </div>
    );
  }

  const history = overview?.history ?? [];

  if (!selectedSnapshot && history.length === 0) {
    return <EmptyState />;
  }

  if (!selectedSnapshot) {
    return null;
  }

  const reportedHoldings = selectedSnapshot.reported_holdings_count ?? selectedSnapshot.holdings_count;
  const totalReturnTone =
    (selectedSnapshot.total_return_value ?? selectedSnapshot.derived.parsed_holdings_total_pnl) >= 0
      ? 'positive'
      : 'negative';
  const dayReturnTone = (selectedSnapshot.day_return_value ?? 0) >= 0 ? 'positive' : 'negative';
  const sortedHoldings = sortIndMoneyHoldings(selectedSnapshot.holdings, holdingsSort);

  return (
    <div className="flex flex-col gap-5">
      <div className="border border-gray-200 bg-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-gray-200 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-950">INDmoney US Portfolio Snapshot</h2>
            <p className="mt-1 text-sm text-gray-500">
              Manual daily snapshots parsed into holdings, allocation, returns, and market context.
            </p>
          </div>
          <div className="flex items-center gap-3 text-sm text-gray-500">
            <div>
              <p>Viewing snapshot</p>
              <p className="font-medium text-gray-700">{formatCapturedAt(selectedSnapshot.captured_at)}</p>
            </div>
            <span className={cn('inline-flex min-w-[6.5rem] items-center justify-center px-2.5 py-1 text-xs font-semibold uppercase tracking-wider ring-1', statusClass(selectedSnapshot.parse_status))}>
              {selectedSnapshot.parse_status}
            </span>
          </div>
        </div>

        {error ? (
          <div className="border-b border-red-200 bg-red-50 px-5 py-3 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        {selecting ? (
          <div className="flex items-center gap-2 border-b border-gray-200 bg-gray-50 px-5 py-3 text-sm text-gray-500">
            <Loader2 className="size-4 animate-spin" />
            Loading snapshot details…
          </div>
        ) : null}

        <div className="grid gap-5 px-5 py-5 xl:grid-cols-[20rem,minmax(0,1fr)]">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
            <MetricCard
              label="Current Value"
              value={formatCurrency(selectedSnapshot.current_value ?? selectedSnapshot.derived.parsed_holdings_current_value)}
              sublabel={`Saved ${formatSnapshotDate(selectedSnapshot.snapshot_date)}`}
              icon={Wallet}
            />
            <MetricCard
              label="Invested Value"
              value={formatCurrency(selectedSnapshot.invested_value ?? selectedSnapshot.derived.parsed_holdings_invested_value)}
              icon={PiggyBank}
            />
            <MetricCard
              label="Total Returns"
              value={formatCurrency(selectedSnapshot.total_return_value ?? selectedSnapshot.derived.parsed_holdings_total_pnl)}
              sublabel={formatPercent(selectedSnapshot.total_return_percent)}
              tone={totalReturnTone}
              icon={TrendingUp}
            />
            <MetricCard
              label="1D Returns"
              value={formatCurrency(selectedSnapshot.day_return_value)}
              sublabel={formatPercent(selectedSnapshot.day_return_percent)}
              tone={dayReturnTone}
              icon={Activity}
            />
            <MetricCard
              label="Wallet"
              value={formatCurrency(selectedSnapshot.wallet_balance)}
              icon={Wallet}
            />
            <MetricCard
              label="Holdings"
              value={`${formatCount(selectedSnapshot.holdings_count)} / ${formatCount(reportedHoldings)}`}
              sublabel={`${selectedSnapshot.derived.profitable_holdings_count} profitable, ${selectedSnapshot.derived.loss_making_holdings_count} losing`}
              icon={Target}
            />
          </div>
          <SnapshotHistoryChart
            history={history}
            selectedSnapshotId={selectedSnapshotId}
            onSelect={onSelectSnapshot}
          />
        </div>
      </div>

      {selectedSnapshot.parse_warnings.length > 0 ? (
        <div className="border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 shadow-sm">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div className="space-y-1">
              {selectedSnapshot.parse_warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-5">
          <div className="border border-gray-200 bg-white shadow-sm">
            <div className="flex flex-col gap-2 border-b border-gray-200 px-5 py-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500">Snapshot Detail</h3>
                <p className="mt-2 text-lg font-semibold text-gray-950">
                  {formatSnapshotDate(selectedSnapshot.snapshot_date)}
                </p>
              </div>
              <div className="text-sm text-gray-500">
                <p>Captured {formatCapturedAt(selectedSnapshot.captured_at)}</p>
                <p className="capitalize">Source: {selectedSnapshot.source.replace('_', ' ')}</p>
              </div>
            </div>

            <div className="overflow-x-auto p-5">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">
                    <SortableTableHeader
                      label="Stock"
                      activeDirection={holdingsSort?.column === 'stock' ? holdingsSort.direction : null}
                      onToggle={() => setHoldingsSort((currentSort) => toggleSortState(currentSort, 'stock'))}
                      className="pb-2 pr-4"
                    />
                    <SortableTableHeader
                      label="Qty"
                      activeDirection={holdingsSort?.column === 'quantity' ? holdingsSort.direction : null}
                      onToggle={() => setHoldingsSort((currentSort) => toggleSortState(currentSort, 'quantity'))}
                      className="pb-2 pr-4"
                    />
                    <SortableTableHeader
                      label="Avg"
                      activeDirection={holdingsSort?.column === 'average_price' ? holdingsSort.direction : null}
                      onToggle={() => setHoldingsSort((currentSort) => toggleSortState(currentSort, 'average_price'))}
                      className="pb-2 pr-4"
                    />
                    <SortableTableHeader
                      label="Market"
                      activeDirection={holdingsSort?.column === 'market_price' ? holdingsSort.direction : null}
                      onToggle={() => setHoldingsSort((currentSort) => toggleSortState(currentSort, 'market_price'))}
                      className="pb-2 pr-4"
                    />
                    <SortableTableHeader
                      label="Invested"
                      activeDirection={holdingsSort?.column === 'invested_value' ? holdingsSort.direction : null}
                      onToggle={() => setHoldingsSort((currentSort) => toggleSortState(currentSort, 'invested_value'))}
                      className="pb-2 pr-4"
                    />
                    <SortableTableHeader
                      label="Current"
                      activeDirection={holdingsSort?.column === 'current_value' ? holdingsSort.direction : null}
                      onToggle={() => setHoldingsSort((currentSort) => toggleSortState(currentSort, 'current_value'))}
                      className="pb-2 pr-4"
                    />
                    <SortableTableHeader
                      label="P&L"
                      activeDirection={holdingsSort?.column === 'total_pnl' ? holdingsSort.direction : null}
                      onToggle={() => setHoldingsSort((currentSort) => toggleSortState(currentSort, 'total_pnl'))}
                      className="pb-2 pr-4"
                    />
                    <SortableTableHeader
                      label="P&L %"
                      activeDirection={holdingsSort?.column === 'total_pnl_percent' ? holdingsSort.direction : null}
                      onToggle={() => setHoldingsSort((currentSort) => toggleSortState(currentSort, 'total_pnl_percent'))}
                      className="pb-2 pr-4"
                    />
                    <SortableTableHeader
                      label="Weight"
                      activeDirection={holdingsSort?.column === 'portfolio_weight_percent' ? holdingsSort.direction : null}
                      onToggle={() => setHoldingsSort((currentSort) => toggleSortState(currentSort, 'portfolio_weight_percent'))}
                      className="pb-2 pr-4"
                    />
                    <SortableTableHeader
                      label="1D %"
                      activeDirection={holdingsSort?.column === 'market_change_percent' ? holdingsSort.direction : null}
                      onToggle={() => setHoldingsSort((currentSort) => toggleSortState(currentSort, 'market_change_percent'))}
                      className="pb-2"
                    />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
	                  {sortedHoldings.map((holding) => (
	                    <tr key={holding.symbol} className="hover:bg-gray-50">
	                      <td className="py-2.5 pr-4">
	                        <TradingViewSymbolLink symbol={holding.symbol} market="us" className="group inline-flex flex-col">
	                          <span className="font-medium text-gray-900 transition-colors group-hover:text-blue-700">
	                            {holding.company_name}
	                          </span>
	                          <span className="text-xs text-gray-500 transition-colors group-hover:text-blue-600">
	                            {holding.symbol}
	                          </span>
	                        </TradingViewSymbolLink>
	                      </td>
                      <td className="py-2.5 pr-4 text-gray-700">{formatCount(holding.quantity)}</td>
                      <td className="py-2.5 pr-4 text-gray-700">{formatCurrency(holding.average_price)}</td>
                      <td className="py-2.5 pr-4 text-gray-700">{formatCurrency(holding.market_price)}</td>
                      <td className="py-2.5 pr-4 text-gray-700">{formatCurrency(holding.invested_value)}</td>
                      <td className="py-2.5 pr-4 text-gray-700">{formatCurrency(holding.current_value)}</td>
                      <td className={cn('py-2.5 pr-4 font-medium', toneClass(holding.total_pnl))}>
                        {formatCurrency(holding.total_pnl)}
                      </td>
                      <td className={cn('py-2.5 pr-4 font-medium', toneClass(holding.total_pnl_percent))}>
                        {formatPercent(holding.total_pnl_percent)}
                      </td>
                      <td className="py-2.5 pr-4 text-gray-700">{formatPercent(holding.portfolio_weight_percent)}</td>
                      <td className={cn('py-2.5 font-medium', toneClass(holding.market_change_percent))}>
                        {formatPercent(holding.market_change_percent)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {selectedSnapshot.holdings.length === 0 ? (
                <p className="py-8 text-center text-sm text-gray-400">No holdings were parsed for this snapshot.</p>
              ) : null}
            </div>
          </div>

          <div className="grid gap-5 xl:grid-cols-2">
            <ReconciliationTable items={selectedSnapshot.derived.reconciliation} />
            <MarketIndicesTable indices={selectedSnapshot.market_indices} />
          </div>

          <div className="grid gap-5 xl:grid-cols-3">
            <CompactHoldingsTable title="Top Allocation" holdings={selectedSnapshot.derived.top_allocations} />
            <CompactHoldingsTable title="Top Gainers" holdings={selectedSnapshot.derived.top_gainers} />
            <CompactHoldingsTable title="Laggards" holdings={selectedSnapshot.derived.top_laggards} />
          </div>

          <div className="border border-gray-200 bg-white shadow-sm">
            <div className="border-b border-gray-200 px-5 py-4">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500">Raw Pasted Snapshot</h3>
            </div>
            <div className="max-h-[28rem] overflow-auto bg-slate-950 p-5">
              <pre className="whitespace-pre-wrap text-xs leading-5 text-slate-200">
                {selectedSnapshot.raw_text}
              </pre>
            </div>
          </div>
        </div>
      </div>
  );
}

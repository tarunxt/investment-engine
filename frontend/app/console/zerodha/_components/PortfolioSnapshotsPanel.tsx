'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Briefcase,
  CalendarDays,
  Loader2,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  Wallet,
} from 'lucide-react';

import { SortableTableHeader } from '@/components/shared/SortableTableHeader';
import { TradingViewSymbolLink } from '@/components/shared/TradingViewSymbolLink';
import { Button } from '@/components/ui/button';
import { sortItems, type SortState, toggleSortState } from '@/lib/tableSorting';
import { cn } from '@/lib/utils';
import {
  type ZerodhaPortfolioHolding,
  type ZerodhaPortfolioOverviewResponse,
  type ZerodhaPortfolioPosition,
  type ZerodhaPortfolioSnapshotDetail,
  type ZerodhaPortfolioSnapshotSummary,
} from '@/types/api';

function formatCurrency(value: number) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(value || 0);
}

function formatCount(value: number) {
  return new Intl.NumberFormat('en-IN').format(value || 0);
}

function formatSnapshotDate(value: string) {
  return new Date(`${value}T00:00:00+05:30`).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
  });
}

function formatCapturedAt(value: string) {
  return new Date(value).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function formatSnapshotTime(value: string) {
  return new Date(value).toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    timeStyle: 'short',
  });
}

function formatShortSnapshotDate(value: string) {
  return new Date(`${value}T00:00:00+05:30`).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
  });
}

const INDIA_TIME_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const INDIA_MARKET_OPEN_MINUTES = 9 * 60 + 15;
const INDIA_MARKET_CLOSE_MINUTES = 15 * 60 + 30;

function getIndiaLocalDateParts(date: Date) {
  const indiaLocalDate = new Date(date.getTime() + INDIA_TIME_OFFSET_MS);

  return {
    year: indiaLocalDate.getUTCFullYear(),
    month: indiaLocalDate.getUTCMonth(),
    day: indiaLocalDate.getUTCDate(),
    weekday: indiaLocalDate.getUTCDay(),
    minutes: indiaLocalDate.getUTCHours() * 60 + indiaLocalDate.getUTCMinutes(),
  };
}

function isWeekday(weekday: number) {
  return weekday >= 1 && weekday <= 5;
}

function getIndiaInstant(year: number, month: number, day: number, hours: number, minutes: number) {
  return Date.UTC(year, month, day, hours, minutes) - INDIA_TIME_OFFSET_MS;
}

function getPreviousTradingDayClose(parts: ReturnType<typeof getIndiaLocalDateParts>) {
  let localMidnight = Date.UTC(parts.year, parts.month, parts.day);
  do {
    localMidnight -= 24 * 60 * 60 * 1000;
  } while (!isWeekday(new Date(localMidnight).getUTCDay()));

  const previousCloseDate = new Date(localMidnight);

  return getIndiaInstant(
    previousCloseDate.getUTCFullYear(),
    previousCloseDate.getUTCMonth(),
    previousCloseDate.getUTCDate(),
    15,
    30,
  );
}

function getMostRecentIndiaMarketClose(now: Date) {
  const parts = getIndiaLocalDateParts(now);

  if (isWeekday(parts.weekday) && parts.minutes >= INDIA_MARKET_CLOSE_MINUTES) {
    return getIndiaInstant(parts.year, parts.month, parts.day, 15, 30);
  }

  return getPreviousTradingDayClose(parts);
}

function isIndiaMarketOpen(now: Date) {
  const parts = getIndiaLocalDateParts(now);

  return (
    isWeekday(parts.weekday) &&
    parts.minutes >= INDIA_MARKET_OPEN_MINUTES &&
    parts.minutes < INDIA_MARKET_CLOSE_MINUTES
  );
}

function getSyncButtonTone(lastSyncAt: string | null | undefined, now: Date) {
  if (isIndiaMarketOpen(now)) {
    return {
      label: 'Market open — live prices are changing',
      className: 'border-amber-500 bg-amber-400 text-amber-950 hover:bg-amber-300',
    };
  }

  const lastSyncTime = lastSyncAt ? new Date(lastSyncAt).getTime() : Number.NaN;
  const latestCloseTime = getMostRecentIndiaMarketClose(now);

  if (Number.isFinite(lastSyncTime) && lastSyncTime >= latestCloseTime) {
    return {
      label: 'Latest — synced after the previous market close',
      className: 'border-emerald-700 bg-emerald-600 text-white hover:bg-emerald-500',
    };
  }

  return {
    label: 'Stale — sync after market close to update numbers',
    className: 'border-red-700 bg-red-600 text-white hover:bg-red-500',
  };
}

function toneClass(value: number) {
  if (value > 0) return 'text-emerald-600';
  if (value < 0) return 'text-red-600';
  return 'text-gray-500';
}

type ZerodhaHoldingsSortColumn =
  | 'holding'
  | 'quantity'
  | 'average_price'
  | 'last_price'
  | 'market_value'
  | 'pnl'
  | 'day_change_value';
type ZerodhaNetPositionsSortColumn = 'symbol' | 'product' | 'quantity' | 'average_price' | 'last_price' | 'pnl' | 'm2m';
type ZerodhaDayPositionsSortColumn =
  | 'symbol'
  | 'day_buy_quantity'
  | 'day_sell_quantity'
  | 'realised'
  | 'unrealised'
  | 'pnl';

const ZERODHA_HOLDINGS_SORT_ACCESSORS = {
  holding: {
    type: 'text',
    getValue: (holding: ZerodhaPortfolioHolding) => holding.tradingsymbol,
  },
  quantity: {
    type: 'number',
    getValue: (holding: ZerodhaPortfolioHolding) => holding.quantity,
  },
  average_price: {
    type: 'number',
    getValue: (holding: ZerodhaPortfolioHolding) => holding.average_price,
  },
  last_price: {
    type: 'number',
    getValue: (holding: ZerodhaPortfolioHolding) => holding.last_price,
  },
  market_value: {
    type: 'number',
    getValue: (holding: ZerodhaPortfolioHolding) => holding.market_value,
  },
  pnl: {
    type: 'number',
    getValue: (holding: ZerodhaPortfolioHolding) => holding.pnl,
  },
  day_change_value: {
    type: 'number',
    getValue: (holding: ZerodhaPortfolioHolding) => holding.day_change_value,
  },
} satisfies Record<
  ZerodhaHoldingsSortColumn,
  { type: 'number' | 'text'; getValue: (holding: ZerodhaPortfolioHolding) => number | string | null | undefined }
>;

const ZERODHA_NET_POSITIONS_SORT_ACCESSORS = {
  symbol: {
    type: 'text',
    getValue: (position: ZerodhaPortfolioPosition) => position.tradingsymbol,
  },
  product: {
    type: 'text',
    getValue: (position: ZerodhaPortfolioPosition) => position.product,
  },
  quantity: {
    type: 'number',
    getValue: (position: ZerodhaPortfolioPosition) => position.quantity,
  },
  average_price: {
    type: 'number',
    getValue: (position: ZerodhaPortfolioPosition) => position.average_price,
  },
  last_price: {
    type: 'number',
    getValue: (position: ZerodhaPortfolioPosition) => position.last_price,
  },
  pnl: {
    type: 'number',
    getValue: (position: ZerodhaPortfolioPosition) => position.pnl,
  },
  m2m: {
    type: 'number',
    getValue: (position: ZerodhaPortfolioPosition) => position.m2m,
  },
} satisfies Record<
  ZerodhaNetPositionsSortColumn,
  { type: 'number' | 'text'; getValue: (position: ZerodhaPortfolioPosition) => number | string | null | undefined }
>;

const ZERODHA_DAY_POSITIONS_SORT_ACCESSORS = {
  symbol: {
    type: 'text',
    getValue: (position: ZerodhaPortfolioPosition) => position.tradingsymbol,
  },
  day_buy_quantity: {
    type: 'number',
    getValue: (position: ZerodhaPortfolioPosition) => position.day_buy_quantity,
  },
  day_sell_quantity: {
    type: 'number',
    getValue: (position: ZerodhaPortfolioPosition) => position.day_sell_quantity,
  },
  realised: {
    type: 'number',
    getValue: (position: ZerodhaPortfolioPosition) => position.realised,
  },
  unrealised: {
    type: 'number',
    getValue: (position: ZerodhaPortfolioPosition) => position.unrealised,
  },
  pnl: {
    type: 'number',
    getValue: (position: ZerodhaPortfolioPosition) => position.pnl,
  },
} satisfies Record<
  ZerodhaDayPositionsSortColumn,
  { type: 'number' | 'text'; getValue: (position: ZerodhaPortfolioPosition) => number | string | null | undefined }
>;

function MetricCard({
  label,
  value,
  icon: Icon,
  tone = 'default',
}: {
  label: string;
  value: string;
  icon: typeof Wallet;
  tone?: 'default' | 'positive' | 'negative';
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
    </div>
  );
}

function EmptyState({
  connected,
  syncing,
  onSync,
}: {
  connected: boolean;
  syncing: boolean;
  onSync: () => void;
}) {
  return (
    <div className="border border-dashed border-gray-300 bg-white px-6 py-10 text-center shadow-sm">
      <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-gray-100">
        <CalendarDays className="size-5 text-gray-500" />
      </div>
      <h3 className="mt-4 text-sm font-semibold text-gray-900">No portfolio snapshots yet</h3>
      <p className="mt-2 text-sm text-gray-500">
        Connect Zerodha and run a sync to start saving daily holdings and positions history.
      </p>
      {connected && (
        <Button className="mt-4" onClick={onSync} disabled={syncing}>
          {syncing ? <Loader2 className="mr-2 size-4 animate-spin" /> : <RefreshCw className="mr-2 size-4" />}
          Sync Portfolio Now
        </Button>
      )}
    </div>
  );
}

function SnapshotHistoryChart({
  history,
  selectedSnapshotDate,
  onSelect,
}: {
  history: ZerodhaPortfolioSnapshotSummary[];
  selectedSnapshotDate: string | null;
  onSelect: (snapshotDate: string) => void;
}) {
  const chartData = [...history]
    .sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date))
    .map((snapshot) => ({
      ...snapshot,
      value: snapshot.holdings_market_value || 0,
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
  const selectedPoint = points.find((point) => point.snapshot_date === selectedSnapshotDate) ?? points.at(-1);

  return (
    <div className="flex h-full flex-col border-t border-gray-200 px-5 py-5 xl:border-l xl:border-t-0">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">Daily History</span>
          <p className="mt-1 text-sm text-gray-500">Holdings value trend across saved portfolio snapshots.</p>
        </div>
        {selectedPoint && (
          <div className="text-sm sm:text-right">
            <p className="font-semibold text-gray-950">{formatCurrency(selectedPoint.value)}</p>
            <p className="text-xs text-gray-500">
              {formatSnapshotDate(selectedPoint.snapshot_date)} · Saved {formatSnapshotTime(selectedPoint.captured_at)}
            </p>
          </div>
        )}
      </div>

      <div className="mt-4 min-h-[18rem] flex-1 overflow-x-auto">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Daily portfolio holdings value history" className="h-full min-h-[18rem] min-w-[44rem]">
          <defs>
            <linearGradient id="zerodha-history-area" x1="0" x2="0" y1="0" y2="1">
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
          {points.length > 0 && (
            <>
              <polygon
                points={`${padding.left},${padding.top + plotHeight} ${path} ${width - padding.right},${padding.top + plotHeight}`}
                fill="url(#zerodha-history-area)"
              />
              <polyline points={path} fill="none" stroke="#059669" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
            </>
          )}
          {points.map((point) => {
            const isActive = selectedSnapshotDate === point.snapshot_date;

            return (
              <g key={point.snapshot_date} className="cursor-pointer" onClick={() => onSelect(point.snapshot_date)}>
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

function PositionRow({
  position,
}: {
  position: ZerodhaPortfolioPosition;
}) {
	return (
	  <tr className="hover:bg-gray-50">
	    <td className="py-2.5 pr-4 font-medium text-gray-900">
	      <TradingViewSymbolLink
	        symbol={position.tradingsymbol}
	        market="india"
	        exchange={position.exchange}
	        className="hover:text-blue-700"
	      >
	        <span className="underline-offset-4 hover:underline">{position.tradingsymbol}</span>
	      </TradingViewSymbolLink>
	      <span className="ml-1 text-xs text-gray-400">{position.exchange}</span>
	    </td>
      <td className="py-2.5 pr-4 text-gray-700">{position.product ?? '—'}</td>
      <td className="py-2.5 pr-4 text-gray-700">{formatCount(position.quantity)}</td>
      <td className="py-2.5 pr-4 text-gray-700">{position.average_price ? position.average_price.toFixed(2) : '—'}</td>
      <td className="py-2.5 pr-4 text-gray-700">{position.last_price ? position.last_price.toFixed(2) : '—'}</td>
      <td className={cn('py-2.5 pr-4 font-medium', toneClass(position.pnl))}>{formatCurrency(position.pnl)}</td>
      <td className={cn('py-2.5 font-medium', toneClass(position.m2m))}>{formatCurrency(position.m2m)}</td>
    </tr>
  );
}

export function PortfolioSnapshotsPanel({
  connected,
  overview,
  selectedSnapshot,
  selectedSnapshotDate,
  loading,
  selecting,
  syncing,
  error,
  onSelectSnapshot,
  onSync,
}: {
  connected: boolean;
  overview: ZerodhaPortfolioOverviewResponse | null;
  selectedSnapshot: ZerodhaPortfolioSnapshotDetail | null;
  selectedSnapshotDate: string | null;
  loading: boolean;
  selecting: boolean;
  syncing: boolean;
  error: string | null;
  onSelectSnapshot: (snapshotDate: string) => void;
  onSync: () => void;
}) {
  const [holdingsSort, setHoldingsSort] = useState<SortState<ZerodhaHoldingsSortColumn>>(null);
  const [netPositionsSort, setNetPositionsSort] = useState<SortState<ZerodhaNetPositionsSortColumn>>(null);
  const [dayPositionsSort, setDayPositionsSort] = useState<SortState<ZerodhaDayPositionsSortColumn>>(null);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60 * 1000);

    return () => window.clearInterval(timer);
  }, []);

  const syncButtonTone = useMemo(
    () => getSyncButtonTone(overview?.latest?.captured_at ?? selectedSnapshot?.captured_at, now),
    [now, overview?.latest?.captured_at, selectedSnapshot?.captured_at],
  );

  if (loading) {
    return (
      <div className="flex items-center gap-2 border border-gray-200 bg-white px-5 py-4 text-sm text-gray-500 shadow-sm">
        <Loader2 className="size-4 animate-spin" />
        Loading portfolio history…
      </div>
    );
  }

  const history = overview?.history ?? [];

  if (!selectedSnapshot && history.length === 0) {
    return <EmptyState connected={connected} syncing={syncing} onSync={onSync} />;
  }

  if (!selectedSnapshot) {
    return null;
  }

  const sortedHoldings = sortItems(
    selectedSnapshot.holdings,
    holdingsSort,
    ZERODHA_HOLDINGS_SORT_ACCESSORS,
    (holding) => `${holding.exchange}:${holding.tradingsymbol}`,
  );
  const sortedNetPositions = sortItems(
    selectedSnapshot.positions.net,
    netPositionsSort,
    ZERODHA_NET_POSITIONS_SORT_ACCESSORS,
    (position) => `${position.exchange}:${position.tradingsymbol}`,
  );
  const sortedDayPositions = sortItems(
    selectedSnapshot.positions.day,
    dayPositionsSort,
    ZERODHA_DAY_POSITIONS_SORT_ACCESSORS,
    (position) => `${position.exchange}:${position.tradingsymbol}`,
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="border border-gray-200 bg-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-gray-200 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-950">Portfolio Snapshots</h2>
            <p className="mt-1 text-sm text-gray-500">
              Daywise holdings and positions saved from your Zerodha account.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="text-right text-xs text-gray-500">
              <p>Viewing snapshot</p>
              <p className="font-medium text-gray-700">{formatSnapshotDate(selectedSnapshot.snapshot_date)}</p>
              <p className="mt-1">Snapshot time</p>
              <p className="font-medium text-gray-700">{formatSnapshotTime(selectedSnapshot.captured_at)}</p>
            </div>
            <Button
              onClick={onSync}
              disabled={!connected || syncing}
              className={cn('min-w-[12rem]', syncButtonTone.className)}
              title={syncButtonTone.label}
            >
              {syncing ? <Loader2 className="mr-2 size-4 animate-spin" /> : <RefreshCw className="mr-2 size-4" />}
              Sync Portfolio
            </Button>
          </div>
        </div>
        {error && (
          <div className="border-b border-red-200 bg-red-50 px-5 py-3 text-sm text-red-700">
            {error}
          </div>
        )}
        <div className="grid gap-5 px-5 py-5 xl:grid-cols-2">
          <div className="grid gap-4 sm:grid-cols-2">
            <MetricCard
              label="Holdings Value"
              value={formatCurrency(selectedSnapshot.holdings_market_value)}
              icon={Wallet}
            />
            <MetricCard
              label="Holdings P&L"
              value={formatCurrency(selectedSnapshot.holdings_pnl)}
              icon={Briefcase}
              tone={selectedSnapshot.holdings_pnl >= 0 ? 'positive' : 'negative'}
            />
            <MetricCard
              label="Day Change"
              value={formatCurrency(selectedSnapshot.holdings_day_change_value)}
              icon={selectedSnapshot.holdings_day_change_value >= 0 ? TrendingUp : TrendingDown}
              tone={selectedSnapshot.holdings_day_change_value >= 0 ? 'positive' : 'negative'}
            />
            <MetricCard
              label="Net Position M2M"
              value={formatCurrency(selectedSnapshot.positions_m2m)}
              icon={Activity}
              tone={selectedSnapshot.positions_m2m >= 0 ? 'positive' : 'negative'}
            />
          </div>
          <SnapshotHistoryChart
            history={history}
            selectedSnapshotDate={selectedSnapshotDate}
            onSelect={onSelectSnapshot}
          />
        </div>
      </div>

      <div className="flex flex-col gap-5">
          <div className="border border-gray-200 bg-white shadow-sm">
            <div className="flex flex-col gap-2 border-b border-gray-200 px-5 py-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500">
                  Snapshot Detail
                </h3>
                <p className="mt-2 text-lg font-semibold text-gray-950">
                  {formatSnapshotDate(selectedSnapshot.snapshot_date)}
                </p>
              </div>
              <div className="text-sm text-gray-500">
                <p>Captured {formatCapturedAt(selectedSnapshot.captured_at)}</p>
                <p className="capitalize">Source: {selectedSnapshot.source}</p>
              </div>
            </div>

            {selecting && (
              <div className="flex items-center gap-2 border-b border-gray-200 bg-gray-50 px-5 py-3 text-sm text-gray-500">
                <Loader2 className="size-4 animate-spin" />
                Loading snapshot details…
              </div>
            )}

            <div className="p-5">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">
                      <SortableTableHeader
                        label="Holding"
                        activeDirection={holdingsSort?.column === 'holding' ? holdingsSort.direction : null}
                        onToggle={() => setHoldingsSort((currentSort) => toggleSortState(currentSort, 'holding'))}
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
                        onToggle={() =>
                          setHoldingsSort((currentSort) => toggleSortState(currentSort, 'average_price'))
                        }
                        className="pb-2 pr-4"
                      />
                      <SortableTableHeader
                        label="LTP"
                        activeDirection={holdingsSort?.column === 'last_price' ? holdingsSort.direction : null}
                        onToggle={() => setHoldingsSort((currentSort) => toggleSortState(currentSort, 'last_price'))}
                        className="pb-2 pr-4"
                      />
                      <SortableTableHeader
                        label="Value"
                        activeDirection={holdingsSort?.column === 'market_value' ? holdingsSort.direction : null}
                        onToggle={() =>
                          setHoldingsSort((currentSort) => toggleSortState(currentSort, 'market_value'))
                        }
                        className="pb-2 pr-4"
                      />
                      <SortableTableHeader
                        label="P&L"
                        activeDirection={holdingsSort?.column === 'pnl' ? holdingsSort.direction : null}
                        onToggle={() => setHoldingsSort((currentSort) => toggleSortState(currentSort, 'pnl'))}
                        className="pb-2 pr-4"
                      />
                      <SortableTableHeader
                        label="Day"
                        activeDirection={holdingsSort?.column === 'day_change_value' ? holdingsSort.direction : null}
                        onToggle={() =>
                          setHoldingsSort((currentSort) => toggleSortState(currentSort, 'day_change_value'))
                        }
                        className="pb-2"
                      />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {sortedHoldings.map((holding) => (
                      <tr key={`${holding.exchange}:${holding.tradingsymbol}`} className="hover:bg-gray-50">
                        <td className="py-2.5 pr-4 font-medium text-gray-900">
                          <TradingViewSymbolLink
                            symbol={holding.tradingsymbol}
                            market="india"
                            exchange={holding.exchange}
                            className="hover:text-blue-700"
                          >
                            <span className="underline-offset-4 hover:underline">{holding.tradingsymbol}</span>
                          </TradingViewSymbolLink>
                          <span className="ml-1 text-xs text-gray-400">{holding.exchange}</span>
                        </td>
                        <td className="py-2.5 pr-4 text-gray-700">{formatCount(holding.quantity)}</td>
                        <td className="py-2.5 pr-4 text-gray-700">{holding.average_price.toFixed(2)}</td>
                        <td className="py-2.5 pr-4 text-gray-700">{holding.last_price.toFixed(2)}</td>
                        <td className="py-2.5 pr-4 text-gray-700">{formatCurrency(holding.market_value)}</td>
                        <td className={cn('py-2.5 pr-4 font-medium', toneClass(holding.pnl))}>
                          {formatCurrency(holding.pnl)}
                        </td>
                        <td className={cn('py-2.5 font-medium', toneClass(holding.day_change_value))}>
                          {formatCurrency(holding.day_change_value)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {selectedSnapshot.holdings.length === 0 && (
                  <p className="py-8 text-center text-sm text-gray-400">No holdings were returned for this day.</p>
                )}
              </div>
            </div>
          </div>

          <div className="border border-gray-200 bg-white shadow-sm">
            <div className="border-b border-gray-200 px-5 py-4">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500">Net Positions</h3>
            </div>
            <div className="p-5">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">
                      <SortableTableHeader
                        label="Symbol"
                        activeDirection={netPositionsSort?.column === 'symbol' ? netPositionsSort.direction : null}
                        onToggle={() => setNetPositionsSort((currentSort) => toggleSortState(currentSort, 'symbol'))}
                        className="pb-2 pr-4"
                      />
                      <SortableTableHeader
                        label="Product"
                        activeDirection={netPositionsSort?.column === 'product' ? netPositionsSort.direction : null}
                        onToggle={() => setNetPositionsSort((currentSort) => toggleSortState(currentSort, 'product'))}
                        className="pb-2 pr-4"
                      />
                      <SortableTableHeader
                        label="Qty"
                        activeDirection={netPositionsSort?.column === 'quantity' ? netPositionsSort.direction : null}
                        onToggle={() => setNetPositionsSort((currentSort) => toggleSortState(currentSort, 'quantity'))}
                        className="pb-2 pr-4"
                      />
                      <SortableTableHeader
                        label="Avg"
                        activeDirection={netPositionsSort?.column === 'average_price' ? netPositionsSort.direction : null}
                        onToggle={() =>
                          setNetPositionsSort((currentSort) => toggleSortState(currentSort, 'average_price'))
                        }
                        className="pb-2 pr-4"
                      />
                      <SortableTableHeader
                        label="LTP"
                        activeDirection={netPositionsSort?.column === 'last_price' ? netPositionsSort.direction : null}
                        onToggle={() => setNetPositionsSort((currentSort) => toggleSortState(currentSort, 'last_price'))}
                        className="pb-2 pr-4"
                      />
                      <SortableTableHeader
                        label="P&L"
                        activeDirection={netPositionsSort?.column === 'pnl' ? netPositionsSort.direction : null}
                        onToggle={() => setNetPositionsSort((currentSort) => toggleSortState(currentSort, 'pnl'))}
                        className="pb-2 pr-4"
                      />
                      <SortableTableHeader
                        label="M2M"
                        activeDirection={netPositionsSort?.column === 'm2m' ? netPositionsSort.direction : null}
                        onToggle={() => setNetPositionsSort((currentSort) => toggleSortState(currentSort, 'm2m'))}
                        className="pb-2"
                      />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {sortedNetPositions.map((position) => (
                      <PositionRow key={`${position.exchange}:${position.tradingsymbol}`} position={position} />
                    ))}
                  </tbody>
                </table>
                {selectedSnapshot.positions.net.length === 0 && (
                  <p className="py-8 text-center text-sm text-gray-400">No net positions for this snapshot.</p>
                )}
              </div>
            </div>
          </div>

          <div className="border border-gray-200 bg-white shadow-sm">
            <div className="border-b border-gray-200 px-5 py-4">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500">Day Positions</h3>
            </div>
            <div className="p-5">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">
                      <SortableTableHeader
                        label="Symbol"
                        activeDirection={dayPositionsSort?.column === 'symbol' ? dayPositionsSort.direction : null}
                        onToggle={() => setDayPositionsSort((currentSort) => toggleSortState(currentSort, 'symbol'))}
                        className="pb-2 pr-4"
                      />
                      <SortableTableHeader
                        label="Buy Qty"
                        activeDirection={dayPositionsSort?.column === 'day_buy_quantity' ? dayPositionsSort.direction : null}
                        onToggle={() =>
                          setDayPositionsSort((currentSort) => toggleSortState(currentSort, 'day_buy_quantity'))
                        }
                        className="pb-2 pr-4"
                      />
                      <SortableTableHeader
                        label="Sell Qty"
                        activeDirection={dayPositionsSort?.column === 'day_sell_quantity' ? dayPositionsSort.direction : null}
                        onToggle={() =>
                          setDayPositionsSort((currentSort) => toggleSortState(currentSort, 'day_sell_quantity'))
                        }
                        className="pb-2 pr-4"
                      />
                      <SortableTableHeader
                        label="Realised"
                        activeDirection={dayPositionsSort?.column === 'realised' ? dayPositionsSort.direction : null}
                        onToggle={() => setDayPositionsSort((currentSort) => toggleSortState(currentSort, 'realised'))}
                        className="pb-2 pr-4"
                      />
                      <SortableTableHeader
                        label="Unrealised"
                        activeDirection={dayPositionsSort?.column === 'unrealised' ? dayPositionsSort.direction : null}
                        onToggle={() =>
                          setDayPositionsSort((currentSort) => toggleSortState(currentSort, 'unrealised'))
                        }
                        className="pb-2 pr-4"
                      />
                      <SortableTableHeader
                        label="P&L"
                        activeDirection={dayPositionsSort?.column === 'pnl' ? dayPositionsSort.direction : null}
                        onToggle={() => setDayPositionsSort((currentSort) => toggleSortState(currentSort, 'pnl'))}
                        className="pb-2"
                      />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {sortedDayPositions.map((position) => (
                      <tr key={`${position.exchange}:${position.tradingsymbol}`} className="hover:bg-gray-50">
                        <td className="py-2.5 pr-4 font-medium text-gray-900">
                          <TradingViewSymbolLink
                            symbol={position.tradingsymbol}
                            market="india"
                            exchange={position.exchange}
                            className="hover:text-blue-700"
                          >
                            <span className="underline-offset-4 hover:underline">{position.tradingsymbol}</span>
                          </TradingViewSymbolLink>
                          <span className="ml-1 text-xs text-gray-400">{position.exchange}</span>
                        </td>
                        <td className="py-2.5 pr-4 text-gray-700">{formatCount(position.day_buy_quantity)}</td>
                        <td className="py-2.5 pr-4 text-gray-700">{formatCount(position.day_sell_quantity)}</td>
                        <td className={cn('py-2.5 pr-4 font-medium', toneClass(position.realised))}>
                          {formatCurrency(position.realised)}
                        </td>
                        <td className={cn('py-2.5 pr-4 font-medium', toneClass(position.unrealised))}>
                          {formatCurrency(position.unrealised)}
                        </td>
                        <td className={cn('py-2.5 font-medium', toneClass(position.pnl))}>
                          {formatCurrency(position.pnl)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {selectedSnapshot.positions.day.length === 0 && (
                  <p className="py-8 text-center text-sm text-gray-400">No day positions for this snapshot.</p>
                )}
              </div>
            </div>
          </div>
      </div>
    </div>
  );
}

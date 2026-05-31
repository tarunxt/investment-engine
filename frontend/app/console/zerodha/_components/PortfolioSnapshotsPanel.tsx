'use client';

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

import { TradingViewSymbolLink } from '@/components/shared/TradingViewSymbolLink';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
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

function toneClass(value: number) {
  if (value > 0) return 'text-emerald-600';
  if (value < 0) return 'text-red-600';
  return 'text-gray-500';
}

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

function SnapshotHistory({
  history,
  selectedSnapshotDate,
  onSelect,
}: {
  history: ZerodhaPortfolioSnapshotSummary[];
  selectedSnapshotDate: string | null;
  onSelect: (snapshotDate: string) => void;
}) {
  return (
    <div className="border border-gray-200 bg-white shadow-sm">
      <div className="border-b border-gray-200 px-5 py-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">Daily History</span>
      </div>
      <div className="max-h-[28rem] overflow-y-auto">
        {history.map((snapshot) => {
          const isActive = selectedSnapshotDate === snapshot.snapshot_date;
          return (
            <button
              key={snapshot.snapshot_date}
              onClick={() => onSelect(snapshot.snapshot_date)}
              className={cn(
                'w-full border-b border-gray-100 px-5 py-4 text-left transition-colors last:border-b-0',
                isActive ? 'bg-gray-950 text-white' : 'hover:bg-gray-50',
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className={cn('text-sm font-semibold', isActive ? 'text-white' : 'text-gray-900')}>
                    {formatSnapshotDate(snapshot.snapshot_date)}
                  </p>
                  <p className={cn('mt-1 text-xs', isActive ? 'text-gray-300' : 'text-gray-500')}>
                    Saved {formatCapturedAt(snapshot.captured_at)}
                  </p>
                </div>
                <span
                  className={cn(
                    'text-xs font-semibold uppercase tracking-wider',
                    isActive ? 'text-gray-300' : 'text-gray-400',
                  )}
                >
                  {snapshot.source}
                </span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <div>
                  <p className={cn(isActive ? 'text-gray-400' : 'text-gray-500')}>Holdings</p>
                  <p className={cn('font-medium', isActive ? 'text-white' : 'text-gray-900')}>
                    {formatCount(snapshot.holdings_count)}
                  </p>
                </div>
                <div>
                  <p className={cn(isActive ? 'text-gray-400' : 'text-gray-500')}>Value</p>
                  <p className={cn('font-medium', isActive ? 'text-white' : 'text-gray-900')}>
                    {formatCurrency(snapshot.holdings_market_value)}
                  </p>
                </div>
              </div>
            </button>
          );
        })}
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
            </div>
            <Button onClick={onSync} disabled={!connected || syncing}>
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
        <div className="grid gap-4 px-5 py-5 md:grid-cols-2 xl:grid-cols-4">
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
      </div>

      <div className="grid gap-5 xl:grid-cols-[18rem,minmax(0,1fr)]">
        <SnapshotHistory
          history={history}
          selectedSnapshotDate={selectedSnapshotDate}
          onSelect={onSelectSnapshot}
        />

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
                      <th className="pb-2 pr-4">Holding</th>
                      <th className="pb-2 pr-4">Qty</th>
                      <th className="pb-2 pr-4">Avg</th>
                      <th className="pb-2 pr-4">LTP</th>
                      <th className="pb-2 pr-4">Value</th>
                      <th className="pb-2 pr-4">P&amp;L</th>
                      <th className="pb-2">Day</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
	                    {selectedSnapshot.holdings.map((holding) => (
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
                      <th className="pb-2 pr-4">Symbol</th>
                      <th className="pb-2 pr-4">Product</th>
                      <th className="pb-2 pr-4">Qty</th>
                      <th className="pb-2 pr-4">Avg</th>
                      <th className="pb-2 pr-4">LTP</th>
                      <th className="pb-2 pr-4">P&amp;L</th>
                      <th className="pb-2">M2M</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {selectedSnapshot.positions.net.map((position) => (
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
                      <th className="pb-2 pr-4">Symbol</th>
                      <th className="pb-2 pr-4">Buy Qty</th>
                      <th className="pb-2 pr-4">Sell Qty</th>
                      <th className="pb-2 pr-4">Realised</th>
                      <th className="pb-2 pr-4">Unrealised</th>
                      <th className="pb-2">P&amp;L</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
	                    {selectedSnapshot.positions.day.map((position) => (
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
    </div>
  );
}

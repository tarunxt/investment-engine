'use client';

import type { PolymarketTrader } from '@/types/api';

function formatTs(iso?: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function formatMoney(value: number, digits = 2) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: digits,
  }).format(value || 0);
}

function EmptyState({ colSpan, message }: { colSpan: number; message: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-8 text-center text-sm text-slate-500">
        {message}
      </td>
    </tr>
  );
}

export function TrackedTradersTable({ traders }: { traders: PolymarketTrader[] }) {
  return (
    <div className="overflow-x-auto rounded-[24px] border border-slate-200 bg-white shadow-sm">
      <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
        <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          <tr>
            <th className="px-4 py-3">Trader</th>
            <th className="px-4 py-3">Handle/Profile</th>
            <th className="px-4 py-3">Activity Source</th>
            <th className="px-4 py-3">Source Reason</th>
            <th className="px-4 py-3">Trades 1h</th>
            <th className="px-4 py-3">Trades 6h</th>
            <th className="px-4 py-3">Trades 24h</th>
            <th className="px-4 py-3">Last Trade Time</th>
            <th className="px-4 py-3">Last Trade Age</th>
            <th className="px-4 py-3">Volume 24h</th>
            <th className="px-4 py-3">Polymarket Profile</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {traders.length === 0 ? (
            <EmptyState colSpan={11} message="Start the bot to load tracked traders." />
          ) : (
            traders.map((trader) => (
              <tr key={trader.id} className="align-top">
                <td className="px-4 py-3">
                  <div className="font-medium text-slate-950">{trader.name}</div>
                  <div className="mt-1 text-xs text-slate-500">{trader.address || trader.id}</div>
                </td>
                <td className="px-4 py-3 text-slate-700">
                  {trader.handle ? `@${trader.handle}` : trader.profile_slug || '—'}
                </td>
                <td className="px-4 py-3 text-slate-700">{trader.activity_source || '—'}</td>
                <td className="px-4 py-3 text-xs leading-5 text-slate-600">{trader.source_reason}</td>
                <td className="px-4 py-3 text-slate-700">{trader.trades_1h}</td>
                <td className="px-4 py-3 text-slate-700">{trader.trades_6h}</td>
                <td className="px-4 py-3 text-slate-700">{trader.trades_24h}</td>
                <td className="px-4 py-3 text-slate-700">{formatTs(trader.last_trade_at)}</td>
                <td className="px-4 py-3 text-slate-700">{trader.last_trade_age || '—'}</td>
                <td className="px-4 py-3 text-slate-700">{formatMoney(trader.volume_24h)}</td>
                <td className="px-4 py-3">
                  {trader.polymarket_profile_url ? (
                    <a
                      href={trader.polymarket_profile_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs font-medium text-sky-700 underline underline-offset-4"
                    >
                      Open profile
                    </a>
                  ) : (
                    <span className="text-xs text-slate-400">—</span>
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function ManualWalletsTable({ wallets }: { wallets: PolymarketTrader[] }) {
  return (
    <div className="overflow-x-auto rounded-[24px] border border-slate-200 bg-white shadow-sm">
      <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
        <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          <tr>
            <th className="px-4 py-3">Wallet</th>
            <th className="px-4 py-3">Source</th>
            <th className="px-4 py-3">Last Trade Time</th>
            <th className="px-4 py-3">Trades 1h</th>
            <th className="px-4 py-3">Trades 6h</th>
            <th className="px-4 py-3">Trades 24h</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {wallets.length === 0 ? (
            <EmptyState colSpan={6} message="No manual tracked wallets configured." />
          ) : (
            wallets.map((wallet) => (
              <tr key={wallet.id} className="align-top">
                <td className="px-4 py-3">
                  <div className="font-medium text-slate-950">{wallet.address || wallet.id}</div>
                  <div className="mt-1 text-xs text-slate-500">{wallet.name}</div>
                </td>
                <td className="px-4 py-3 text-slate-700">{wallet.source_reason}</td>
                <td className="px-4 py-3 text-slate-700">{formatTs(wallet.last_trade_at)}</td>
                <td className="px-4 py-3 text-slate-700">{wallet.trades_1h}</td>
                <td className="px-4 py-3 text-slate-700">{wallet.trades_6h}</td>
                <td className="px-4 py-3 text-slate-700">{wallet.trades_24h}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

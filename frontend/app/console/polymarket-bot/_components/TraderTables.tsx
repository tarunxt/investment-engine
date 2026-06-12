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

function netWorthBreakdown(account: import('@/types/api').PolymarketTrackedAccount) {
  if (account.net_worth_error) {
    return `Auto fetch failed: ${account.net_worth_error}`;
  }

  if (!account.net_worth_source) {
    return 'Auto net worth fetch pending';
  }

  const parts = [
    `positions ${formatMoney(account.positions_value_usd || 0)}`,
    `pUSD ${formatMoney(account.cash_balance_usd || 0)}`,
  ];

  if ((account.redeemable_value_usd || 0) > 0) {
    parts.push(`redeemable ${formatMoney(account.redeemable_value_usd || 0)}`);
  }

  return `Auto: ${parts.join(' + ')}`;
}

function normalizePolymarketProfileUrl(trader: PolymarketTrader) {
  const handle = trader.handle || trader.profile_slug;
  if (handle) {
    return `https://polymarket.com/@${handle.replace(/^@/, '')}`;
  }

  return trader.polymarket_profile_url || trader.profile_url;
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
            <th className="px-4 py-3">Activity Source</th>
            <th className="px-4 py-3">Source Reason</th>
            <th className="px-4 py-3">Trades 1h</th>
            <th className="px-4 py-3">Trades 6h</th>
            <th className="px-4 py-3">Trades 24h</th>
            <th className="px-4 py-3">Last Trade Time</th>
            <th className="px-4 py-3">Last Trade Age</th>
            <th className="px-4 py-3">Volume 24h</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {traders.length === 0 ? (
            <EmptyState colSpan={9} message="Start the bot to load tracked traders." />
          ) : (
            traders.map((trader) => {
              const profileUrl = normalizePolymarketProfileUrl(trader);

              return (
                <tr key={trader.id} className="align-top">
                  <td className="px-4 py-3">
                    {profileUrl ? (
                      <a
                        href={profileUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium text-slate-950 underline decoration-slate-300 underline-offset-4 transition hover:text-sky-700 hover:decoration-sky-700"
                      >
                        {trader.name}
                      </a>
                    ) : (
                      <div className="font-medium text-slate-950">{trader.name}</div>
                    )}
                    <div className="mt-1 text-xs text-slate-500">{trader.address || trader.id}</div>
                  </td>
                  <td className="px-4 py-3 text-slate-700">{trader.activity_source || '—'}</td>
                  <td className="px-4 py-3 text-xs leading-5 text-slate-600">{trader.source_reason}</td>
                  <td className="px-4 py-3 text-slate-700">{trader.trades_1h}</td>
                  <td className="px-4 py-3 text-slate-700">{trader.trades_6h}</td>
                  <td className="px-4 py-3 text-slate-700">{trader.trades_24h}</td>
                  <td className="px-4 py-3 text-slate-700">{formatTs(trader.last_trade_at)}</td>
                  <td className="px-4 py-3 text-slate-700">{trader.last_trade_age || '—'}</td>
                  <td className="px-4 py-3 text-slate-700">{formatMoney(trader.volume_24h)}</td>
                </tr>
              );
            })
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

export type TrackedAccountDraft = {
  target: string;
  threshold_percent: number;
  net_worth_usd: number;
  copy_trade_usd: number;
  enabled: boolean;
};

export function TrackedAccountsTable({
  accounts,
  drafts,
  newDraft,
  busyId,
  onDraftChange,
  onNewDraftChange,
  onAdd,
  onSave,
  onDelete,
}: {
  accounts: import('@/types/api').PolymarketTrackedAccount[];
  drafts: Record<string, TrackedAccountDraft>;
  newDraft: TrackedAccountDraft;
  busyId: string | null;
  onDraftChange: (id: string, draft: TrackedAccountDraft) => void;
  onNewDraftChange: (draft: TrackedAccountDraft) => void;
  onAdd: () => void;
  onSave: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-[24px] border border-slate-200 bg-white shadow-sm">
      <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
        <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          <tr>
            <th className="px-4 py-3">Tracked account</th>
            <th className="px-4 py-3">Enabled</th>
            <th className="px-4 py-3">Net worth USD</th>
            <th className="px-4 py-3">Copy threshold</th>
            <th className="px-4 py-3">Copy size</th>
            <th className="px-4 py-3">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {accounts.map((account) => {
            const draft = drafts[account.id] || {
              target: account.target,
              threshold_percent: account.threshold_percent,
              net_worth_usd: account.net_worth_usd,
              copy_trade_usd: account.copy_trade_usd,
              enabled: account.enabled,
            };
            const thresholdUsd = draft.net_worth_usd * (draft.threshold_percent / 100);

            return (
              <tr key={account.id} className="align-top">
                <td className="px-4 py-3">
                  <input
                    value={draft.target}
                    onChange={(event) => onDraftChange(account.id, { ...draft, target: event.target.value })}
                    className="h-9 w-64 rounded-full border border-slate-300 px-3 text-sm outline-none focus:border-sky-400"
                  />
                  <div className="mt-1 text-xs text-slate-500">
                    {account.profile_url ? (
                      <a href={account.profile_url} target="_blank" rel="noreferrer" className="underline decoration-slate-300 underline-offset-4 hover:text-sky-700">
                        {account.profile_url}
                      </a>
                    ) : (
                      account.id
                    )}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(event) => onDraftChange(account.id, { ...draft, enabled: event.target.checked })}
                  />
                </td>
                <td className="px-4 py-3">
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={draft.net_worth_usd}
                    onChange={(event) => onDraftChange(account.id, { ...draft, net_worth_usd: Number(event.target.value) })}
                    className="h-9 w-28 rounded-full border border-slate-300 px-3 text-sm outline-none focus:border-sky-400"
                  />
                  <div className="mt-1 max-w-56 text-xs leading-5 text-slate-500">
                    {netWorthBreakdown(account)}
                    {account.net_worth_checked_at ? ` · ${formatTs(account.net_worth_checked_at)}` : ''}
                  </div>
                  {account.proxy_wallet ? (
                    <div className="mt-0.5 max-w-56 truncate text-[11px] text-slate-400" title={account.proxy_wallet}>
                      wallet {account.proxy_wallet}
                    </div>
                  ) : null}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="0.1"
                      value={draft.threshold_percent}
                      onChange={(event) => onDraftChange(account.id, { ...draft, threshold_percent: Number(event.target.value) })}
                      className="h-9 w-24 rounded-full border border-slate-300 px-3 text-sm outline-none focus:border-sky-400"
                    />
                    <span className="text-xs text-slate-500">% ≈ {formatMoney(thresholdUsd)}</span>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <input
                    type="number"
                    min="0.01"
                    max="1"
                    step="0.01"
                    value={draft.copy_trade_usd}
                    onChange={(event) => onDraftChange(account.id, { ...draft, copy_trade_usd: Number(event.target.value) })}
                    className="h-9 w-24 rounded-full border border-slate-300 px-3 text-sm outline-none focus:border-sky-400"
                  />
                </td>
                <td className="px-4 py-3">
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={busyId === account.id}
                      onClick={() => onSave(account.id)}
                      className="rounded-full border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      disabled={busyId === account.id}
                      onClick={() => onDelete(account.id)}
                      className="rounded-full border border-rose-200 px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
          <tr className="align-top bg-slate-50/60">
            <td className="px-4 py-3">
              <input
                value={newDraft.target}
                onChange={(event) => onNewDraftChange({ ...newDraft, target: event.target.value })}
                placeholder="https://polymarket.com/@handle or 0x..."
                className="h-9 w-64 rounded-full border border-slate-300 px-3 text-sm outline-none focus:border-sky-400"
              />
            </td>
            <td className="px-4 py-3">
              <input
                type="checkbox"
                checked={newDraft.enabled}
                onChange={(event) => onNewDraftChange({ ...newDraft, enabled: event.target.checked })}
              />
            </td>
            <td className="px-4 py-3">
              <input
                type="number"
                min="0"
                step="1"
                value={newDraft.net_worth_usd}
                onChange={(event) => onNewDraftChange({ ...newDraft, net_worth_usd: Number(event.target.value) })}
                className="h-9 w-28 rounded-full border border-slate-300 px-3 text-sm outline-none focus:border-sky-400"
              />
            </td>
            <td className="px-4 py-3">
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={newDraft.threshold_percent}
                onChange={(event) => onNewDraftChange({ ...newDraft, threshold_percent: Number(event.target.value) })}
                className="h-9 w-24 rounded-full border border-slate-300 px-3 text-sm outline-none focus:border-sky-400"
              />
            </td>
            <td className="px-4 py-3">
              <input
                type="number"
                min="0.01"
                max="1"
                step="0.01"
                value={newDraft.copy_trade_usd}
                onChange={(event) => onNewDraftChange({ ...newDraft, copy_trade_usd: Number(event.target.value) })}
                className="h-9 w-24 rounded-full border border-slate-300 px-3 text-sm outline-none focus:border-sky-400"
              />
            </td>
            <td className="px-4 py-3">
              <button
                type="button"
                disabled={!newDraft.target.trim() || busyId === 'new'}
                onClick={onAdd}
                className="rounded-full bg-sky-300 px-4 py-1.5 text-xs font-semibold text-slate-950 hover:bg-sky-200 disabled:bg-slate-200 disabled:text-slate-500"
              >
                Add account
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

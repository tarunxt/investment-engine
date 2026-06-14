"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

import type {
  PolymarketPaperTrade,
  PolymarketSourceTradeDecision,
  PolymarketTrader,
} from "@/types/api";

const TRACKED_TRADERS_PAGE_SIZE = 5;
const TRACKED_ACCOUNTS_PAGE_SIZE = 10;
type LeaderboardTab = "today" | "weekly";
type TraderCopyStats = { tradesCopied: number; tradesCopiedAmount: number };
type SortDirection = "asc" | "desc";
type TraderSortColumn =
  | "trader"
  | "tradesCopied"
  | "tradesCopiedAmount"
  | "trades1h"
  | "trades6h"
  | "trades24h"
  | "lastTradeTime"
  | "lastTradeAge"
  | "volume24h";
type TraderSortState = { column: TraderSortColumn; direction: SortDirection };

function traderIdentityValues(trader: PolymarketTrader) {
  return [trader.id, trader.address, trader.handle, trader.name]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());
}

function traderMatchesPeriod(trader: PolymarketTrader, period: LeaderboardTab) {
  const periods = trader.leaderboard_periods?.length
    ? trader.leaderboard_periods
    : trader.leaderboard_period
      ? [trader.leaderboard_period]
      : [];
  if (periods.map((item) => item.toLowerCase()).includes(period)) return true;
  return trader.source_reason
    .toLowerCase()
    .includes(`${period} profit leaderboard`);
}

function traderProfitForPeriod(
  trader: PolymarketTrader,
  period: LeaderboardTab,
) {
  const periodProfit = trader.leaderboard_profit_usd?.[period];
  return typeof periodProfit === "number"
    ? periodProfit
    : trader.profit_usd || 0;
}

function buildCopyStats(
  traders: PolymarketTrader[],
  decisions: PolymarketSourceTradeDecision[],
  paperTrades: PolymarketPaperTrade[],
) {
  const stats = new Map<string, TraderCopyStats>();

  for (const trader of traders) {
    stats.set(trader.id, { tradesCopied: 0, tradesCopiedAmount: 0 });
  }

  const addForTrader = (
    identity: string | undefined | null,
    amount: number,
  ) => {
    if (!identity) return;
    const normalized = identity.toLowerCase();
    const trader = traders.find((candidate) =>
      traderIdentityValues(candidate).includes(normalized),
    );
    if (!trader) return;
    const current = stats.get(trader.id) || {
      tradesCopied: 0,
      tradesCopiedAmount: 0,
    };
    stats.set(trader.id, {
      tradesCopied: current.tradesCopied + 1,
      tradesCopiedAmount: current.tradesCopiedAmount + amount,
    });
  };

  decisions
    .filter(
      (trade) => trade.status === "executed" || trade.status === "confirmed",
    )
    .forEach((trade) =>
      addForTrader(
        trade.trader_address ||
          trade.trader_handle ||
          trade.trader_id ||
          trade.trader_name,
        trade.amount,
      ),
    );

  paperTrades
    .filter((trade) => trade.status === "executed")
    .forEach((trade) =>
      addForTrader(trade.trader_id || trade.trader_name, trade.copied_usd),
    );

  return stats;
}

function formatTs(iso?: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatMoney(value: number, digits = 2) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: digits,
  }).format(value || 0);
}

function netWorthBreakdown(
  account: import("@/types/api").PolymarketTrackedAccount,
) {
  if (account.net_worth_error) {
    return `Auto fetch failed: ${account.net_worth_error}`;
  }

  if (!account.net_worth_source) {
    return "Auto net worth fetch pending";
  }

  const parts = [
    `positions ${formatMoney(account.positions_value_usd || 0)}`,
    `pUSD ${formatMoney(account.cash_balance_usd || 0)}`,
  ];

  if ((account.redeemable_value_usd || 0) > 0) {
    parts.push(`redeemable ${formatMoney(account.redeemable_value_usd || 0)}`);
  }

  return `Auto: ${parts.join(" + ")}`;
}

function normalizePolymarketProfileUrl(trader: PolymarketTrader) {
  const handle = trader.handle || trader.profile_slug;
  if (handle) {
    return `https://polymarket.com/@${handle.replace(/^@/, "")}`;
  }

  return trader.polymarket_profile_url || trader.profile_url;
}

function SortIcon({ direction }: { direction: SortDirection | null }) {
  if (direction === "asc") return <ArrowUp className="size-3.5 shrink-0" />;
  if (direction === "desc") return <ArrowDown className="size-3.5 shrink-0" />;
  return <ArrowUpDown className="size-3.5 shrink-0 opacity-60" />;
}

function compareValues(left: number | string, right: number | string) {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }

  return String(left).localeCompare(String(right), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function EmptyState({
  colSpan,
  message,
}: {
  colSpan: number;
  message: string;
}) {
  return (
    <tr>
      <td
        colSpan={colSpan}
        className="px-4 py-8 text-center text-sm text-slate-500"
      >
        {message}
      </td>
    </tr>
  );
}

export function TrackedTradersTable({
  traders,
  decisions = [],
  paperTrades = [],
}: {
  traders: PolymarketTrader[];
  decisions?: PolymarketSourceTradeDecision[];
  paperTrades?: PolymarketPaperTrade[];
}) {
  const [activeTab, setActiveTab] = useState<LeaderboardTab>("today");
  const [visibleLimitByTab, setVisibleLimitByTab] = useState<
    Record<LeaderboardTab, number>
  >({
    today: TRACKED_TRADERS_PAGE_SIZE,
    weekly: TRACKED_TRADERS_PAGE_SIZE,
  });
  const [sortState, setSortState] = useState<TraderSortState>({
    column: "tradesCopied",
    direction: "desc",
  });
  const copyStats = useMemo(
    () => buildCopyStats(traders, decisions, paperTrades),
    [traders, decisions, paperTrades],
  );
  const sortedTraders = useMemo(() => {
    const periodMatches = traders.filter((trader) =>
      traderMatchesPeriod(trader, activeTab),
    );
    const rows = periodMatches.length > 0 ? periodMatches : traders;
    const getSortValue = (trader: PolymarketTrader): number | string => {
      const stats = copyStats.get(trader.id) || {
        tradesCopied: 0,
        tradesCopiedAmount: 0,
      };

      switch (sortState.column) {
        case "trader":
          return trader.name || trader.handle || trader.address || trader.id;
        case "tradesCopied":
          return stats.tradesCopied;
        case "tradesCopiedAmount":
          return stats.tradesCopiedAmount;
        case "trades1h":
          return trader.trades_1h || 0;
        case "trades6h":
          return trader.trades_6h || 0;
        case "trades24h":
          return trader.trades_24h || 0;
        case "lastTradeTime":
          return trader.last_trade_at
            ? new Date(trader.last_trade_at).getTime()
            : 0;
        case "lastTradeAge":
          return trader.last_trade_age || "";
        case "volume24h":
          return trader.volume_24h || 0;
      }
    };

    return [...rows].sort((a, b) => {
      const comparison = compareValues(getSortValue(a), getSortValue(b));
      if (comparison !== 0) {
        return sortState.direction === "asc" ? comparison : -comparison;
      }
      return (
        traderProfitForPeriod(b, activeTab) -
        traderProfitForPeriod(a, activeTab)
      );
    });
  }, [activeTab, copyStats, sortState, traders]);
  const visibleLimit =
    visibleLimitByTab[activeTab] || TRACKED_TRADERS_PAGE_SIZE;
  const pagedTraders = sortedTraders.slice(0, visibleLimit);

  const selectTab = (tab: LeaderboardTab) => {
    setActiveTab(tab);
    setVisibleLimitByTab((current) => ({
      ...current,
      [tab]: current[tab] || TRACKED_TRADERS_PAGE_SIZE,
    }));
  };
  const showMore = () =>
    setVisibleLimitByTab((current) => ({
      ...current,
      [activeTab]:
        (current[activeTab] || TRACKED_TRADERS_PAGE_SIZE) +
        TRACKED_TRADERS_PAGE_SIZE,
    }));
  const showFirstPage = () =>
    setVisibleLimitByTab((current) => ({
      ...current,
      [activeTab]: TRACKED_TRADERS_PAGE_SIZE,
    }));
  const toggleSort = (column: TraderSortColumn) => {
    setSortState((current) => ({
      column,
      direction:
        current.column === column && current.direction === "desc"
          ? "asc"
          : "desc",
    }));
  };
  const sortHeader = (column: TraderSortColumn, label: string) => (
    <th
      className="px-4 py-3"
      aria-sort={
        sortState.column === column
          ? sortState.direction === "asc"
            ? "ascending"
            : "descending"
          : "none"
      }
    >
      <button
        type="button"
        onClick={() => toggleSort(column)}
        className="inline-flex items-center gap-1.5 text-left transition hover:text-slate-700"
      >
        <span>{label}</span>
        <SortIcon
          direction={sortState.column === column ? sortState.direction : null}
        />
      </button>
    </th>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-full border border-slate-200 bg-slate-50 p-1 text-sm font-medium text-slate-600">
          {(["today", "weekly"] as LeaderboardTab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => selectTab(tab)}
              className={`rounded-full px-4 py-2 capitalize transition ${
                activeTab === tab
                  ? "bg-white text-slate-950 shadow-sm"
                  : "hover:text-slate-950"
              }`}
            >
              {tab} profit
            </button>
          ))}
        </div>
        <div className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
          Showing {pagedTraders.length ? 1 : 0}-
          {Math.min(visibleLimit, sortedTraders.length)} of{" "}
          {sortedTraders.length}
        </div>
      </div>
      <div className="overflow-x-auto rounded-[24px] border border-slate-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
          <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            <tr>
              {sortHeader("trader", "Trader")}
              {sortHeader("tradesCopied", "Trades copied")}
              {sortHeader("tradesCopiedAmount", "Trades copied amount")}
              {sortHeader("trades1h", "Trader Trades 1h")}
              {sortHeader("trades6h", "Trader Trades 6h")}
              {sortHeader("trades24h", "Trader Trades 24h")}
              {sortHeader("lastTradeTime", "Trader Last Trade Time")}
              {sortHeader("lastTradeAge", "Trader Last Trade Age")}
              {sortHeader("volume24h", "Trader Volume 24h")}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {pagedTraders.length === 0 ? (
              <EmptyState
                colSpan={9}
                message="No tracked traders match this view yet. Check Settings if tracked accounts are configured."
              />
            ) : (
              pagedTraders.map((trader) => {
                const profileUrl = normalizePolymarketProfileUrl(trader);
                const stats = copyStats.get(trader.id) || {
                  tradesCopied: 0,
                  tradesCopiedAmount: 0,
                };

                return (
                  <tr key={`${activeTab}-${trader.id}`} className="align-top">
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
                        <div className="font-medium text-slate-950">
                          {trader.name}
                        </div>
                      )}
                      <div className="mt-1 text-xs text-slate-500">
                        {trader.address || trader.id}
                      </div>
                      <div className="mt-1 text-xs font-medium text-emerald-700">
                        Profit{" "}
                        {formatMoney(traderProfitForPeriod(trader, activeTab))}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {stats.tradesCopied}
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {formatMoney(stats.tradesCopiedAmount)}
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {trader.trades_1h}
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {trader.trades_6h}
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {trader.trades_24h}
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {formatTs(trader.last_trade_at)}
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {trader.last_trade_age || "—"}
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {formatMoney(trader.volume_24h)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {sortedTraders.length > TRACKED_TRADERS_PAGE_SIZE ? (
        <div className="flex items-center justify-end gap-3 text-sm text-slate-500">
          <span>
            Showing {pagedTraders.length} of {sortedTraders.length}
          </span>
          {pagedTraders.length < sortedTraders.length ? (
            <button
              type="button"
              onClick={showMore}
              className="rounded-full border border-slate-200 px-3 py-1.5 font-medium text-slate-600 hover:bg-slate-50"
            >
              See more
            </button>
          ) : (
            <button
              type="button"
              onClick={showFirstPage}
              className="rounded-full border border-slate-200 px-3 py-1.5 font-medium text-slate-600 hover:bg-slate-50"
            >
              Show first {TRACKED_TRADERS_PAGE_SIZE}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function ManualWalletsTable({
  wallets,
}: {
  wallets: PolymarketTrader[];
}) {
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
            <EmptyState
              colSpan={6}
              message="No manual tracked wallets configured."
            />
          ) : (
            wallets.map((wallet) => (
              <tr key={wallet.id} className="align-top">
                <td className="px-4 py-3">
                  <div className="font-medium text-slate-950">
                    {wallet.address || wallet.id}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    {wallet.name}
                  </div>
                </td>
                <td className="px-4 py-3 text-slate-700">
                  {wallet.source_reason}
                </td>
                <td className="px-4 py-3 text-slate-700">
                  {formatTs(wallet.last_trade_at)}
                </td>
                <td className="px-4 py-3 text-slate-700">{wallet.trades_1h}</td>
                <td className="px-4 py-3 text-slate-700">{wallet.trades_6h}</td>
                <td className="px-4 py-3 text-slate-700">
                  {wallet.trades_24h}
                </td>
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
  accounts: import("@/types/api").PolymarketTrackedAccount[];
  drafts: Record<string, TrackedAccountDraft>;
  newDraft: TrackedAccountDraft;
  busyId: string | null;
  onDraftChange: (id: string, draft: TrackedAccountDraft) => void;
  onNewDraftChange: (draft: TrackedAccountDraft) => void;
  onAdd: () => void;
  onSave: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [pageIndex, setPageIndex] = useState(0);
  const totalPages = Math.max(
    1,
    Math.ceil(accounts.length / TRACKED_ACCOUNTS_PAGE_SIZE),
  );
  const safePageIndex = Math.min(pageIndex, totalPages - 1);
  const pagedAccounts = accounts.slice(
    safePageIndex * TRACKED_ACCOUNTS_PAGE_SIZE,
    (safePageIndex + 1) * TRACKED_ACCOUNTS_PAGE_SIZE,
  );

  const goToPreviousPage = () =>
    setPageIndex((current) => Math.max(0, current - 1));
  const goToNextPage = () =>
    setPageIndex((current) => Math.min(totalPages - 1, current + 1));

  return (
    <div className="space-y-3">
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
            {pagedAccounts.map((account) => {
              const draft = drafts[account.id] || {
                target: account.target,
                threshold_percent: account.threshold_percent,
                net_worth_usd: account.net_worth_usd,
                copy_trade_usd: account.copy_trade_usd,
                enabled: account.enabled,
              };
              const thresholdUsd =
                draft.net_worth_usd * (draft.threshold_percent / 100);

              return (
                <tr key={account.id} className="align-top">
                  <td className="px-4 py-3">
                    <input
                      value={draft.target}
                      onChange={(event) =>
                        onDraftChange(account.id, {
                          ...draft,
                          target: event.target.value,
                        })
                      }
                      className="h-9 w-64 rounded-full border border-slate-300 px-3 text-sm outline-none focus:border-sky-400"
                    />
                    <div className="mt-1 text-xs text-slate-500">
                      {account.profile_url ? (
                        <a
                          href={account.profile_url}
                          target="_blank"
                          rel="noreferrer"
                          className="underline decoration-slate-300 underline-offset-4 hover:text-sky-700"
                        >
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
                      onChange={(event) =>
                        onDraftChange(account.id, {
                          ...draft,
                          enabled: event.target.checked,
                        })
                      }
                    />
                  </td>
                  <td className="px-4 py-3">
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={draft.net_worth_usd}
                      onChange={(event) =>
                        onDraftChange(account.id, {
                          ...draft,
                          net_worth_usd: Number(event.target.value),
                        })
                      }
                      className="h-9 w-28 rounded-full border border-slate-300 px-3 text-sm outline-none focus:border-sky-400"
                    />
                    <div className="mt-1 max-w-56 text-xs leading-5 text-slate-500">
                      {netWorthBreakdown(account)}
                      {account.net_worth_checked_at
                        ? ` · ${formatTs(account.net_worth_checked_at)}`
                        : ""}
                    </div>
                    {account.proxy_wallet ? (
                      <div
                        className="mt-0.5 max-w-56 truncate text-[11px] text-slate-400"
                        title={account.proxy_wallet}
                      >
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
                        onChange={(event) =>
                          onDraftChange(account.id, {
                            ...draft,
                            threshold_percent: Number(event.target.value),
                          })
                        }
                        className="h-9 w-24 rounded-full border border-slate-300 px-3 text-sm outline-none focus:border-sky-400"
                      />
                      <span className="text-xs text-slate-500">
                        % ≈ {formatMoney(thresholdUsd)}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <input
                      type="number"
                      min="0.01"
                      max="1"
                      step="0.01"
                      value={draft.copy_trade_usd}
                      onChange={(event) =>
                        onDraftChange(account.id, {
                          ...draft,
                          copy_trade_usd: Number(event.target.value),
                        })
                      }
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
                  onChange={(event) =>
                    onNewDraftChange({
                      ...newDraft,
                      target: event.target.value,
                    })
                  }
                  placeholder="https://polymarket.com/@handle or 0x..."
                  className="h-9 w-64 rounded-full border border-slate-300 px-3 text-sm outline-none focus:border-sky-400"
                />
              </td>
              <td className="px-4 py-3">
                <input
                  type="checkbox"
                  checked={newDraft.enabled}
                  onChange={(event) =>
                    onNewDraftChange({
                      ...newDraft,
                      enabled: event.target.checked,
                    })
                  }
                />
              </td>
              <td className="px-4 py-3">
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={newDraft.net_worth_usd}
                  onChange={(event) =>
                    onNewDraftChange({
                      ...newDraft,
                      net_worth_usd: Number(event.target.value),
                    })
                  }
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
                  onChange={(event) =>
                    onNewDraftChange({
                      ...newDraft,
                      threshold_percent: Number(event.target.value),
                    })
                  }
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
                  onChange={(event) =>
                    onNewDraftChange({
                      ...newDraft,
                      copy_trade_usd: Number(event.target.value),
                    })
                  }
                  className="h-9 w-24 rounded-full border border-slate-300 px-3 text-sm outline-none focus:border-sky-400"
                />
              </td>
              <td className="px-4 py-3">
                <button
                  type="button"
                  disabled={!newDraft.target.trim() || busyId === "new"}
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
      {accounts.length > TRACKED_ACCOUNTS_PAGE_SIZE ? (
        <div className="flex flex-wrap items-center justify-end gap-3 text-sm text-slate-500">
          <span>
            Showing {safePageIndex * TRACKED_ACCOUNTS_PAGE_SIZE + 1}-
            {Math.min(
              (safePageIndex + 1) * TRACKED_ACCOUNTS_PAGE_SIZE,
              accounts.length,
            )}{" "}
            of {accounts.length}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={goToPreviousPage}
              disabled={safePageIndex === 0}
              className="rounded-full border border-slate-200 px-3 py-1.5 font-medium text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Previous
            </button>
            <span className="text-xs font-medium text-slate-400">
              Page {safePageIndex + 1} of {totalPages}
            </span>
            <button
              type="button"
              onClick={goToNextPage}
              disabled={safePageIndex >= totalPages - 1}
              className="rounded-full border border-slate-200 px-3 py-1.5 font-medium text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

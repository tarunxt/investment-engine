"use client";

import { useEffect, useRef, useState } from "react";
import { Activity, AlertTriangle, ExternalLink, Info, Loader2, TrendingUp, Wallet, X } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { apiService, APIError } from "@/services/api";
import type { PolymarketBotState, PolymarketSourceTradeDecision } from "@/types/api";

import { MetricGrid, type MetricItem } from "./_components/MetricGrid";
import {
  ManualWalletsTable,
  TrackedAccountsTable,
  TrackedTradersTable,
  type TrackedAccountDraft,
} from "./_components/TraderTables";

function normalizeError(error: unknown) {
  if (error instanceof APIError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong";
}

function formatTs(iso?: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatEventEnd(iso?: string | null, fallbackText?: string | null) {
  const candidate = iso || fallbackText?.match(/20\d{2}-\d{2}-\d{2}/)?.[0];
  if (!candidate) return "Today";

  const endDate = new Date(candidate);
  if (Number.isNaN(endDate.getTime())) return "Today";

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endDay = new Date(
    endDate.getFullYear(),
    endDate.getMonth(),
    endDate.getDate(),
  );
  const daysAway = Math.round(
    (endDay.getTime() - today.getTime()) / (24 * 60 * 60 * 1000),
  );
  const dateLabel = endDate.toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
  });

  if (daysAway === 0) return `Today, ${dateLabel}`;
  if (daysAway === 1) return `Tomorrow, ${dateLabel}`;
  if (daysAway === -1) return `Yesterday, ${dateLabel}`;
  return dateLabel;
}

function formatCountdown(iso?: string | null) {
  if (!iso) return "0s";
  const diff = Math.max(
    0,
    Math.ceil((new Date(iso).getTime() - Date.now()) / 1000),
  );
  return `${diff}s`;
}

function formatRuntime(from?: string | null, to?: string | null) {
  if (!from) return "—";
  const endTime = to ? new Date(to).getTime() : Date.now();
  const diff = Math.max(
    0,
    Math.floor((endTime - new Date(from).getTime()) / 1000),
  );
  const hours = Math.floor(diff / 3600);
  const minutes = Math.floor((diff % 3600) / 60);
  const seconds = diff % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}


function parseUsdFromBalanceMessage(message?: string | null) {
  if (!message) return 0;
  const match = message.match(/(-?\d[\d,]*(?:\.\d+)?)/);
  if (!match) return 0;
  return Number.parseFloat(match[1].replace(/,/g, "")) || 0;
}

function isBullpenLoginRequired(message?: string | null, status?: string | null) {
  const normalized = `${message || ""} ${status || ""}`.toLowerCase();
  return (
    normalized.includes("bullpen login required") ||
    normalized.includes("login required") ||
    normalized.includes("run: bullpen login")
  );
}

function formatPercent(value: number) {
  return `${value.toFixed(2)}%`;
}

function formatMoney(value: number, digits = 2) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: digits,
  }).format(value || 0);
}

const BULLPEN_ACCOUNT_URL =
  "https://app.bullpen.fi/wallet/predictions?ref=intrepid-crane-3";


function formatRelativePollTime(iso?: string | null) {
  if (!iso) return "waiting for first poll";
  const diff = Math.max(
    0,
    Math.floor((Date.now() - new Date(iso).getTime()) / 1000),
  );
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  const minutes = Math.floor(diff / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function getActionStatusMessage(
  pendingAction: string | null,
  state: PolymarketBotState,
) {
  if (pendingAction === "start") {
    return "Starting bot… controls are disabled until the backend confirms it is running.";
  }
  if (pendingAction === "stop") {
    return "Stopping bot… waiting for the backend to shut down the poller.";
  }
  if (pendingAction === "pause") {
    return "Pausing proposals… existing reads may still finish.";
  }
  if (pendingAction === "resume") {
    return "Resuming proposals… new matches can be queued again.";
  }
  if (pendingAction === "update-live-limit") return "Saving live trade limit…";
  if (state.running) {
    return state.paused
      ? "Bot is running, but proposals are paused."
      : "Bot is running; the live poller checks for new trades automatically.";
  }
  return "Bot is stopped. Press Start to begin polling tracked traders.";
}

function getLiveParsingStatusMessage(state: PolymarketBotState) {
  const source = state.live.source_status;
  if (!state.running) return "Trade parsing is idle until the bot starts.";
  if (source.last_live_read_error) {
    return `Live-read error: ${source.last_live_read_error}`;
  }
  const lastPoll = formatRelativePollTime(
    source.last_poll_time || state.last_poll_at,
  );
  const afterFilters = source.source_trades_after_filters_last_poll;
  const found = source.source_trades_found_last_poll;
  const proposals = source.new_live_proposals_created_last_poll;
  const skipped =
    source.skipped_by_filters_last_poll +
    source.skipped_by_limits_last_poll +
    source.skipped_duplicates_last_poll;
  return `Reading trades continuously · last poll ${lastPoll} · found ${found}, processed ${afterFilters}, queued ${proposals}, skipped ${skipped}.`;
}


type MissedTradeGroup = {
  key: string;
  missedAt: string;
  marketId: string;
  marketTitle: string;
  side: PolymarketSourceTradeDecision["side"];
  outcome: string;
  status: string;
  reason: string;
  traders: PolymarketSourceTradeDecision[];
};

type CopiedHistoryFilter =
  | "all"
  | "executed"
  | "skipped"
  | "failed"
  | "buy"
  | "sell"
  | "redeem"
  | "rewards"
  | "deposits"
  | "withdrawals";

type CopiedEventGroup = {
  key: string;
  copiedAt: string;
  marketId: string;
  marketTitle: string;
  eventEndAt?: string | null;
  outcome: string;
  side: PolymarketSourceTradeDecision["side"];
  amount: number;
  averagePrice: number;
  status: string;
  traders: PolymarketSourceTradeDecision[];
  currentPrice: number;
  currentPnl: number;
};

function getTraderDisplayName(trade: PolymarketSourceTradeDecision) {
  return trade.trader_handle ? `@${trade.trader_handle}` : trade.trader_name;
}

function getTraderActivityUrl(trade: PolymarketSourceTradeDecision) {
  const handle = trade.trader_handle || trade.trader_name.replace(/^@/, "");
  if (!handle) return null;
  return `https://polymarket.com/@${encodeURIComponent(handle)}?tab=activity`;
}

function getCopiedEventKey(trade: PolymarketSourceTradeDecision) {
  return [trade.market_id, trade.market_title, trade.outcome, trade.side].join(
    "::",
  );
}

function getTradeStatusReason(trade: PolymarketSourceTradeDecision) {
  if (trade.failure_reason) return trade.failure_reason;
  if (trade.status === "failed" || trade.status === "skipped") {
    return trade.reason || "No reason provided";
  }
  return trade.status;
}

function getCopiedEventStatus(event: CopiedEventGroup) {
  const problemTrade = event.traders.find((trade) =>
    ["failed", "skipped", "rejected"].includes(trade.status),
  );
  if (!problemTrade) return event.status;
  return `${problemTrade.status}: ${getTradeStatusReason(problemTrade)}`;
}

function isInsufficientBalanceMiss(trade: PolymarketSourceTradeDecision) {
  const text = `${trade.failure_reason || ""} ${trade.reason || ""}`.toLowerCase();
  return (
    trade.status === "failed" &&
    (text.includes("insufficient") ||
      text.includes("not enough") ||
      text.includes("low balance") ||
      text.includes("balance"))
  );
}

function getMissedTradeKey(trade: PolymarketSourceTradeDecision) {
  return [trade.market_id, trade.market_title, trade.side, trade.outcome].join("::");
}

function buildMissedTradeGroups(trades: PolymarketSourceTradeDecision[]) {
  const groups = new Map<string, MissedTradeGroup>();

  for (const trade of trades.filter(isInsufficientBalanceMiss)) {
    const key = getMissedTradeKey(trade);
    const missedAt = trade.executed_at || trade.updated_at || trade.proposed_at;
    const reason = trade.failure_reason || trade.reason || "Insufficient balance";
    const existing = groups.get(key);

    if (!existing) {
      groups.set(key, {
        key,
        missedAt,
        marketId: trade.market_id,
        marketTitle: trade.market_title,
        side: trade.side,
        outcome: trade.outcome,
        status: trade.status,
        reason,
        traders: [trade],
      });
      continue;
    }

    existing.traders.push(trade);
    if (new Date(missedAt).getTime() > new Date(existing.missedAt).getTime()) {
      existing.missedAt = missedAt;
      existing.reason = reason;
      existing.status = trade.status;
    }
  }

  return Array.from(groups.values()).sort(
    (a, b) => new Date(b.missedAt).getTime() - new Date(a.missedAt).getTime(),
  );
}

function buildCopiedEventGroups(trades: PolymarketSourceTradeDecision[]) {
  const groups = new Map<string, CopiedEventGroup>();

  for (const trade of trades) {
    const key = getCopiedEventKey(trade);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        key,
        copiedAt: trade.executed_at || trade.updated_at || trade.proposed_at,
        marketId: trade.market_id,
        marketTitle: trade.market_title,
        eventEndAt: trade.event_end_at,
        outcome: trade.outcome,
        side: trade.side,
        amount: trade.amount,
        averagePrice: trade.price,
        status: trade.status,
        traders: [trade],
        currentPrice: trade.price,
        currentPnl:
          trade.side === "BUY"
            ? trade.shares * trade.price - trade.amount
            : trade.amount - trade.shares * trade.price,
      });
      continue;
    }

    existing.amount += trade.amount;
    existing.traders.push(trade);
    const tradeTimestamp = trade.executed_at || trade.updated_at || trade.proposed_at;
    if (new Date(tradeTimestamp).getTime() > new Date(existing.copiedAt).getTime()) {
      existing.copiedAt = tradeTimestamp;
      existing.currentPrice = trade.price;
    }
    existing.eventEndAt = existing.eventEndAt || trade.event_end_at;
    existing.status = existing.traders.some((item) => item.status === "executed")
      ? "executed"
      : existing.status;
    existing.averagePrice = existing.amount > 0
      ? existing.traders.reduce(
          (total, item) => total + item.amount * item.price,
          0,
        ) / existing.amount
      : existing.averagePrice;
    existing.currentPnl = existing.traders.reduce((total, item) => {
      const markValue = item.shares * existing.currentPrice;
      return total + (
        item.side === "BUY" ? markValue - item.amount : item.amount - markValue
      );
    }, 0);
  }

  return Array.from(groups.values()).sort(
    (a, b) => new Date(b.copiedAt).getTime() - new Date(a.copiedAt).getTime(),
  );
}

export default function PolymarketBotPage() {
  const [state, setState] = useState<PolymarketBotState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [activeScreen, setActiveScreen] = useState<"main" | "settings">("main");
  const [accountDrafts, setAccountDrafts] = useState<
    Record<string, TrackedAccountDraft>
  >({});
  const [newAccountDraft, setNewAccountDraft] = useState<TrackedAccountDraft>({
    target: "",
    threshold_percent: 5,
    net_worth_usd: 0,
    copy_trade_usd: 1,
    enabled: true,
  });
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null);
  const [selectedCopiedEvent, setSelectedCopiedEvent] =
    useState<CopiedEventGroup | null>(null);
  const [selectedMissedTrade, setSelectedMissedTrade] =
    useState<MissedTradeGroup | null>(null);
  const [copiedPositionsTab, setCopiedPositionsTab] = useState<
    "positions" | "history"
  >("positions");
  const [copiedPositionStatus, setCopiedPositionStatus] = useState<
    "active" | "closed"
  >("active");
  const [copiedHistoryFilter, setCopiedHistoryFilter] =
    useState<CopiedHistoryFilter>("all");
  const [liveTradeLimitDraft, setLiveTradeLimitDraft] = useState("");
  const lastMutationAt = useRef(0);
  const actionInFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const requestedAt = Date.now();
      try {
        const nextState = await apiService.polymarketState();
        if (
          cancelled ||
          actionInFlight.current ||
          requestedAt < lastMutationAt.current
        )
          return;
        setState(nextState);
        setAccountDrafts((current) => ({
          ...Object.fromEntries(
            nextState.tracked_accounts.map((account) => [
              account.id,
              current[account.id] || {
                target: account.target,
                threshold_percent: account.threshold_percent,
                net_worth_usd: account.net_worth_usd,
                copy_trade_usd: account.copy_trade_usd,
                enabled: account.enabled,
              },
            ]),
          ),
        }));
        setLiveTradeLimitDraft(String(nextState.config.max_live_trades_per_day));
        setError(null);
      } catch (loadError) {
        if (cancelled) return;
        setError(normalizeError(loadError));
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();

    const interval = window.setInterval(() => {
      void load();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  async function runAction(
    label: string,
    action: () => Promise<PolymarketBotState>,
  ) {
    actionInFlight.current = true;
    lastMutationAt.current = Date.now();
    setPendingAction(label);
    setActionError(null);
    try {
      const nextState = await action();
      lastMutationAt.current = Date.now();
      setState(nextState);
      setLiveTradeLimitDraft(String(nextState.config.max_live_trades_per_day));
    } catch (runError) {
      setActionError(normalizeError(runError));
    } finally {
      actionInFlight.current = false;
      setPendingAction(null);
    }
  }

  function applyTrackedAccountState(nextState: PolymarketBotState) {
    setState(nextState);
    setLiveTradeLimitDraft(String(nextState.config.max_live_trades_per_day));
    setAccountDrafts(
      Object.fromEntries(
        nextState.tracked_accounts.map((account) => [
          account.id,
          {
            target: account.target,
            threshold_percent: account.threshold_percent,
            net_worth_usd: account.net_worth_usd,
            copy_trade_usd: account.copy_trade_usd,
            enabled: account.enabled,
          },
        ]),
      ),
    );
  }

  async function saveLiveTradeLimit() {
    const nextLimit = Number.parseInt(liveTradeLimitDraft, 10);
    if (!Number.isFinite(nextLimit) || nextLimit < 1) {
      setActionError("Max live trades per day must be at least 1.");
      return;
    }
    await runAction("update-live-limit", () =>
      apiService.polymarketUpdateLiveLimits({
        max_live_trades_per_day: nextLimit,
      }),
    );
  }

  async function addTrackedAccount() {
    setBusyAccountId("new");
    setActionError(null);
    try {
      const nextState =
        await apiService.polymarketAddTrackedAccount(newAccountDraft);
      applyTrackedAccountState(nextState);
      setNewAccountDraft({
        target: "",
        threshold_percent: 5,
        net_worth_usd: 0,
        copy_trade_usd: 1,
        enabled: true,
      });
    } catch (accountError) {
      setActionError(normalizeError(accountError));
    } finally {
      setBusyAccountId(null);
    }
  }

  async function saveTrackedAccount(accountId: string) {
    const draft = accountDrafts[accountId];
    if (!draft) return;
    setBusyAccountId(accountId);
    setActionError(null);
    try {
      const nextState = await apiService.polymarketUpdateTrackedAccount(
        accountId,
        draft,
      );
      applyTrackedAccountState(nextState);
    } catch (accountError) {
      setActionError(normalizeError(accountError));
    } finally {
      setBusyAccountId(null);
    }
  }

  async function deleteTrackedAccount(accountId: string) {
    setBusyAccountId(accountId);
    setActionError(null);
    try {
      const nextState =
        await apiService.polymarketDeleteTrackedAccount(accountId);
      applyTrackedAccountState(nextState);
    } catch (accountError) {
      setActionError(normalizeError(accountError));
    } finally {
      setBusyAccountId(null);
    }
  }

  if (loading && !state) {
    return (
      <div className="flex items-center gap-3 text-sm text-slate-500">
        <Loader2 className="size-4 animate-spin" />
        Loading Polymarket Copy Bot…
      </div>
    );
  }

  if (!state) {
    return (
      <div className="rounded-[24px] border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-800">
        {error || "Unable to load Polymarket bot state."}
      </div>
    );
  }

  const subtitle = `${state.running ? "Running" : "Stopped"} | ${state.paused ? "Paused" : "Active"} | ${state.mode} | Bullpen real-money trading`;
  const manualInvalid = state.live.source_status.manual_wallets_invalid;
  const isActionPending = pendingAction !== null;
  const startDisabled = state.running || isActionPending;
  const stopDisabled = !state.running || isActionPending;
  const stoppedWarning = !state.running
    ? "Warning: Bot is Stopped. It will only stay active after Start succeeds; press Start now if you did not intentionally stop it. If it stops while showing Running, the backend watchdog automatically restarts the poller and logs a warning in Recent Bullpen Activity."
    : null;
  const actionStatusMessage = getActionStatusMessage(pendingAction, state);
  const liveParsingStatusMessage = getLiveParsingStatusMessage(state);

  const bullpenAccountValueUsd =
    state.live.balance.account_value_usd ??
    parseUsdFromBalanceMessage(state.live.balance.message);
  const bullpenLoginRequired = isBullpenLoginRequired(
    state.live.balance.message,
    state.live.balance.status,
  );
  const copiedActiveStatuses = new Set(["executed", "confirmed"]);
  const executedLiveTrades = state.live.recent_decisions.filter((trade) =>
    copiedActiveStatuses.has(trade.status),
  );
  const copiedPositionTrades = state.live.recent_decisions.filter((trade) =>
    copiedPositionStatus === "active"
      ? copiedActiveStatuses.has(trade.status)
      : !copiedActiveStatuses.has(trade.status),
  );
  const copiedHistoryTrades = state.live.recent_decisions;
  const copiedHistoryFilterOptions: {
    key: CopiedHistoryFilter;
    label: string;
  }[] = [
    { key: "all", label: "All" },
    { key: "executed", label: "Executed" },
    { key: "skipped", label: "Skipped" },
    { key: "failed", label: "Failed" },
    { key: "buy", label: "Buy" },
    { key: "sell", label: "Sell" },
    { key: "redeem", label: "Redeem" },
    { key: "rewards", label: "Rewards" },
    { key: "deposits", label: "Deposits" },
    { key: "withdrawals", label: "Withdrawals" },
  ];
  const copiedFilteredHistoryTrades = copiedHistoryTrades.filter((trade) => {
    if (copiedHistoryFilter === "all") return true;
    if (["executed", "skipped", "failed"].includes(copiedHistoryFilter)) {
      return trade.status === copiedHistoryFilter;
    }
    if (copiedHistoryFilter === "buy" || copiedHistoryFilter === "sell") {
      return trade.side.toLowerCase() === copiedHistoryFilter;
    }
    const searchable =
      `${trade.command || ""} ${trade.reason || ""} ${trade.status || ""}`.toLowerCase();
    return searchable.includes(copiedHistoryFilter);
  });
  const copiedVisibleTrades =
    copiedPositionsTab === "positions"
      ? copiedPositionTrades
      : copiedFilteredHistoryTrades;
  const copiedEventGroups = buildCopiedEventGroups(copiedVisibleTrades);
  const activeCopiedEventGroups = buildCopiedEventGroups(executedLiveTrades);
  const missedTradeGroups = buildMissedTradeGroups(state.live.recent_decisions);
  const copiedPositionsRefreshSeconds = 5;

  const trackedAccountByIdentity = new Map<string, (typeof state.tracked_accounts)[number]>();
  for (const account of state.tracked_accounts) {
    for (const key of [account.handle, account.target, account.address, account.proxy_wallet]) {
      if (key) trackedAccountByIdentity.set(key.toLowerCase().replace(/^@/, ""), account);
    }
  }

  const visibleTrackedTraders = state.tracked_traders.filter(
    (trader) => trader.activity_source !== "handle",
  );

  const botStatusItems: MetricItem[] = [
    {
      label: "Bot Status",
      value: state.running ? "RUNNING" : "STOPPED",
      tone: state.running ? "positive" : "negative",
    },
    { label: "Mode", value: state.mode },
    {
      label: "Execution Mode",
      value: state.config.paper_trading
        ? "Sandbox mode active"
        : "Real money via Bullpen",
      tone: state.config.paper_trading ? "warning" : "positive",
    },
    { label: "Last Poll Time", value: formatTs(state.last_poll_at) },
    {
      label: "Next Poll Countdown",
      value: `${state.seconds_until_next_poll}s`,
    },
    {
      label: "Session Runtime",
      value:
        state.running || state.started_at
          ? formatRuntime(
              state.session_started_at,
              state.running ? null : state.stopped_at,
            )
          : "—",
    },
    {
      label: "Bot Runtime",
      value: formatRuntime(
        state.started_at,
        state.running ? null : state.stopped_at,
      ),
    },
    {
      label: "Poll Interval",
      value: `${Math.round(state.config.poll_interval_ms / 1000)}s`,
    },
    { label: "Tracked Traders Count", value: visibleTrackedTraders.length },
  ];

  const liveControlItems: MetricItem[] = [
    {
      label: "Doctor Status",
      value: state.live.doctor.ok ? "Passed" : "Failed",
      helper: state.live.doctor.message,
      tone: state.live.doctor.ok ? "positive" : "negative",
    },
    {
      label: "Live Mode",
      value: state.live.unlocked
        ? `Unlocked (${state.live.unlock_mode})`
        : "Locked",
      helper: state.live.locked_reason || null,
      tone: state.live.unlocked ? "positive" : "negative",
    },
    {
      label: "Max Live Trade Size",
      value: formatMoney(state.live.max_live_trade_size),
    },
    { label: "Live Trades Today", value: state.live.live_trades_today },
    {
      label: "Last Doctor Refresh",
      value: formatTs(state.live.doctor.checked_at),
    },
    {
      label: "Bullpen Available Balance",
      value: state.live.balance.message,
      tone: state.live.balance.status === "ready" ? "positive" : "default",
    },
    {
      label: "Last Balance Refresh",
      value: formatTs(state.live.balance.checked_at),
    },
    {
      label: "Next Balance Refresh",
      value: formatCountdown(state.live.balance.next_refresh_at),
    },
    {
      label: "Balance Refresh Status",
      value: state.live.balance.status.toUpperCase(),
    },
    {
      label: "Live Locked Status",
      value: state.live.unlocked ? "UNLOCKED" : "LOCKED",
      helper: state.live.emergency_stopped
        ? "Emergency stop active."
        : state.live.locked_reason,
      tone: state.live.unlocked ? "positive" : "negative",
    },
  ];

  const discoveryItems: MetricItem[] = [
    { label: "Discovery Mode", value: state.live.source_status.discovery_mode },
    {
      label: "Candidate Rows Considered",
      value: state.live.source_status.candidate_rows_considered,
    },
    {
      label: "Candidate Wallets Extracted",
      value: state.live.source_status.candidate_wallets_extracted,
    },
    {
      label: "Active Traders Found",
      value: state.live.source_status.active_traders_found,
    },
    {
      label: "Fallback Traders Selected",
      value: state.live.source_status.fallback_traders_selected,
    },
    {
      label: "Activity Source Used",
      value: state.live.source_status.activity_source_used || "—",
    },
    {
      label: "Rows Rejected Last Discovery",
      value: state.live.source_status.rows_rejected_last_discovery,
    },
    {
      label: "Accepted Activity Trades",
      value: state.live.source_status.accepted_activity_trades_last_discovery,
    },
    {
      label: "Manual Wallets Configured",
      value: state.live.source_status.manual_wallets_configured,
    },
    {
      label: "Manual Wallets Valid",
      value: state.live.source_status.manual_wallets_valid,
    },
    { label: "Manual Wallets Invalid", value: manualInvalid.length },
    {
      label: "Last Discovery Time",
      value: formatTs(
        state.live.source_status.last_active_trader_discovery_time,
      ),
    },
    {
      label: "Last Discovery Error",
      value: state.live.source_status.last_discovery_error || "—",
    },
    { label: "Tracked Traders Selected", value: visibleTrackedTraders.length },
  ];

  const liveSourceItems: MetricItem[] = [
    { label: "Source Mode", value: state.live.source_status.source_mode },
    { label: "Discovery Mode", value: state.live.source_status.discovery_mode },
    {
      label: "Active Traders Found",
      value: state.live.source_status.active_traders_found,
    },
    {
      label: "Live-Read Traders Count",
      value: state.live.source_status.live_read_traders_count,
    },
    {
      label: "Manual Wallets Configured",
      value: state.live.source_status.manual_wallets_configured,
    },
    {
      label: "Manual Wallets Valid",
      value: state.live.source_status.manual_wallets_valid,
    },
    {
      label: "Manual Wallets Invalid",
      value: state.live.source_status.manual_wallets_invalid.length,
    },
    {
      label: "Last Poll Time",
      value: formatTs(state.live.source_status.last_poll_time),
    },
    {
      label: "Last Active Trader Discovery",
      value: formatTs(
        state.live.source_status.last_active_trader_discovery_time,
      ),
    },
    {
      label: "Live Baseline Completed At",
      value: formatTs(state.live.source_status.live_baseline_completed_at),
    },
    {
      label: "Seen Live Trades Baseline Count",
      value: state.live.source_status.seen_live_trades_baseline_count,
    },
    {
      label: "Source Trades Found Last Poll",
      value: state.live.source_status.source_trades_found_last_poll,
    },
    {
      label: "Source Trades After Filters",
      value: state.live.source_status.source_trades_after_filters_last_poll,
    },
    {
      label: "New Live Proposals Created",
      value: state.live.source_status.new_live_proposals_created_last_poll,
    },
    {
      label: "Skipped By Filters",
      value: state.live.source_status.skipped_by_filters_last_poll,
    },
    {
      label: "Skipped By Limits",
      value: state.live.source_status.skipped_by_limits_last_poll,
    },
    {
      label: "Skipped Duplicates",
      value: state.live.source_status.skipped_duplicates_last_poll,
    },
    {
      label: "Last Live-Read Error",
      value: state.live.source_status.last_live_read_error || "—",
    },
    {
      label: "Trending Market Activity",
      value: state.live.source_status.trending_market_activity_enabled
        ? "Enabled"
        : "Disabled",
      helper:
        state.live.source_status.trending_market_activity_unavailable || null,
    },
  ];

  return (
    <div className="mx-auto flex flex-col gap-6 pb-8">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-slate-950">
            Polymarket Copy Bot
          </h1>
          <p className="text-sm text-slate-500">{subtitle}</p>
        </div>
        <div className="flex flex-wrap gap-2 xl:justify-end">
          <Button
            asChild
            size="sm"
            variant="outline"
            className="rounded-full border-emerald-300 bg-emerald-50 px-5 text-emerald-800 hover:border-emerald-400 hover:bg-emerald-100 hover:text-emerald-900"
          >
            <a href={BULLPEN_ACCOUNT_URL} target="_blank" rel="noreferrer">
              Open Bullpen Account
              <ExternalLink className="ml-2 size-3.5" aria-hidden="true" />
            </a>
          </Button>
          <Button
            size="sm"
            variant={activeScreen === "main" ? "default" : "outline"}
            className={
              activeScreen === "main"
                ? "rounded-full bg-slate-950 px-5 text-white hover:bg-slate-800"
                : "rounded-full border-slate-300 px-5"
            }
            onClick={() => setActiveScreen("main")}
          >
            Main
          </Button>
          <Button
            size="sm"
            variant={activeScreen === "settings" ? "default" : "outline"}
            className={
              activeScreen === "settings"
                ? "rounded-full bg-slate-950 px-5 text-white hover:bg-slate-800"
                : "rounded-full border-slate-300 px-5"
            }
            onClick={() => setActiveScreen("settings")}
          >
            Settings
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-[20px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {error}
        </div>
      ) : null}
      {actionError ? (
        <div className="rounded-[20px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {actionError}
        </div>
      ) : null}

      {bullpenLoginRequired ? (
        <div
          className="rounded-[32px] border-2 border-amber-300 bg-amber-50 px-5 py-5 text-amber-950 shadow-lg shadow-amber-900/10 md:px-7 md:py-6"
          role="alert"
        >
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex gap-4">
              <div className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-amber-200 text-amber-900">
                <AlertTriangle className="size-8" aria-hidden="true" />
              </div>
              <div>
                <div className="text-[11px] font-black uppercase tracking-[0.24em] text-amber-700">
                  Action required
                </div>
                <h2 className="mt-1 text-3xl font-black tracking-tight md:text-4xl">
                  Bullpen login is required
                </h2>
                <p className="mt-2 max-w-3xl text-base font-semibold text-amber-900 md:text-lg">
                  The bot cannot refresh balance or place Bullpen-backed real-money
                  trades until the Bullpen session is restored. Current status: {state.live.balance.message}
                </p>
              </div>
            </div>
            <Button
              asChild
              size="sm"
              className="rounded-full bg-amber-950 px-5 text-white hover:bg-amber-900"
            >
              <a href={BULLPEN_ACCOUNT_URL} target="_blank" rel="noreferrer">
                Open Bullpen
                <ExternalLink className="ml-2 size-3.5" aria-hidden="true" />
              </a>
            </Button>
          </div>
          <ol className="mt-5 grid gap-3 text-sm font-semibold text-amber-950 md:grid-cols-3">
            <li className="rounded-2xl border border-amber-200 bg-white/70 px-4 py-3">
              <span className="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-amber-200 text-xs font-black">1</span>
              Open Bullpen and sign in to the trading account used by this bot.
            </li>
            <li className="rounded-2xl border border-amber-200 bg-white/70 px-4 py-3">
              <span className="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-amber-200 text-xs font-black">2</span>
              If operating the backend session, run <code className="rounded bg-amber-100 px-1.5 py-0.5">bullpen login</code> and complete the prompt.
            </li>
            <li className="rounded-2xl border border-amber-200 bg-white/70 px-4 py-3">
              <span className="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-amber-200 text-xs font-black">3</span>
              Return here, use Settings → Refresh balance, then restart or resume the bot if needed.
            </li>
          </ol>
        </div>
      ) : null}

      <Card className="overflow-hidden border border-slate-200 bg-gradient-to-br from-slate-950 via-slate-900 to-sky-950 py-0 text-white shadow-xl shadow-slate-950/10">
        <CardContent className="p-5 md:p-6">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-sky-100">
                <Wallet className="size-3.5" />
                Bullpen Summary
              </div>
              <h2 className="mt-3 text-2xl font-semibold tracking-tight">
                {formatMoney(bullpenAccountValueUsd)} account value
              </h2>
              <p className="mt-1 text-sm text-slate-300">
                {state.live.balance.message || "Bullpen balance has not refreshed yet."}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:min-w-[560px] lg:grid-cols-4">
              <div className="rounded-[20px] border border-white/10 bg-white/10 px-4 py-3">
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-300">PnL</div>
                <div className="mt-2 text-xl font-semibold">{formatMoney(state.metrics.total_pnl)}</div>
              </div>
              <div className="rounded-[20px] border border-white/10 bg-white/10 px-4 py-3">
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-300">Active Trades</div>
                <div className="mt-2 flex items-center gap-2 text-xl font-semibold">
                  <Activity className="size-4 text-sky-300" />
                  {activeCopiedEventGroups.length}
                </div>
              </div>
              <div className="rounded-[20px] border border-white/10 bg-white/10 px-4 py-3">
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-300">Live Trades Today</div>
                <div className="mt-2 text-xl font-semibold">{state.live.live_trades_today}</div>
              </div>
              <div className="rounded-[20px] border border-white/10 bg-white/10 px-4 py-3">
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-300">Copied Trades</div>
                <div className="mt-2 flex items-center gap-2 text-xl font-semibold">
                  <TrendingUp className="size-4 text-emerald-300" />
                  {executedLiveTrades.length}
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {activeScreen === "main" ? (
        <>
          <div className="flex flex-wrap items-center gap-3 rounded-[24px] border border-slate-200 bg-white px-4 py-4 shadow-sm">

            <div className="flex flex-wrap items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
              <span className="font-medium">Max live trades/day:</span>
              <span className="font-semibold text-slate-950">{state.config.max_live_trades_per_day}</span>
              <input
                className="h-8 w-20 rounded-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-sky-500"
                type="number"
                min={1}
                value={liveTradeLimitDraft}
                onChange={(event) => setLiveTradeLimitDraft(event.target.value)}
                aria-label="Max live trades per day"
              />
              <Button
                size="sm"
                variant="outline"
                className="rounded-full border-slate-300"
                disabled={pendingAction !== null}
                onClick={() => void saveLiveTradeLimit()}
              >
                Change limit
              </Button>
            </div>
            <Button
              size="sm"
              className="rounded-full bg-sky-300 px-5 text-slate-950 hover:bg-sky-200 disabled:border-slate-300 disabled:bg-slate-200 disabled:text-slate-500 disabled:opacity-100"
              disabled={startDisabled}
              aria-disabled={startDisabled}
              onClick={() =>
                runAction("start", () => apiService.polymarketStart())
              }
            >
              Start
            </Button>
            <Button
              size="sm"
              variant="outline"
              className={
                state.running
                  ? "rounded-full border-rose-600 bg-rose-600 px-5 text-white hover:border-rose-700 hover:bg-rose-700 hover:text-white disabled:border-slate-300 disabled:bg-slate-200 disabled:text-slate-500 disabled:opacity-100"
                  : "rounded-full border-slate-300 px-5 disabled:border-slate-300 disabled:bg-slate-200 disabled:text-slate-500 disabled:opacity-100"
              }
              disabled={stopDisabled}
              aria-disabled={stopDisabled}
              onClick={() =>
                runAction("stop", () => apiService.polymarketStop())
              }
            >
              Stop Bot
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="rounded-full border-slate-300 px-5"
              disabled={pendingAction !== null}
              onClick={() =>
                runAction(state.paused ? "resume" : "pause", () =>
                  state.paused
                    ? apiService.polymarketResume()
                    : apiService.polymarketPause(),
                )
              }
            >
              {state.paused ? "Resume proposals" : "Pause proposals"}
            </Button>
            <div
              className="flex min-w-[280px] flex-1 flex-col gap-2 text-sm text-slate-600 lg:ml-2"
              aria-live="polite"
            >
              <div className="inline-flex w-fit items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-2 font-medium text-slate-700">
                {isActionPending ? (
                  <Loader2
                    className="size-4 animate-spin text-sky-600"
                    aria-hidden="true"
                  />
                ) : (
                  <span
                    className={
                      state.running
                        ? "size-2 rounded-full bg-emerald-500"
                        : "size-2 rounded-full bg-slate-400"
                    }
                    aria-hidden="true"
                  />
                )}
                {actionStatusMessage}
              </div>
              <div className="inline-flex w-fit items-center gap-2 rounded-full border border-sky-200 bg-sky-50 px-3 py-2 font-medium text-sky-900">
                {state.running ? (
                  <Loader2
                    className="size-4 animate-spin text-sky-600"
                    aria-hidden="true"
                  />
                ) : (
                  <Activity
                    className="size-4 text-slate-500"
                    aria-hidden="true"
                  />
                )}
                <span>{liveParsingStatusMessage}</span>
              </div>
            </div>
          </div>



          {stoppedWarning ? (
            <div className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900">
              {stoppedWarning}
            </div>
          ) : null}


          <Card className="border border-slate-200 bg-white py-6">
            <CardHeader className="pb-0">
              <CardTitle className="text-base tracking-[0.18em] text-slate-950">
                Copied Bullpen Positions
              </CardTitle>
              <CardDescription>
                Aggregated by exact Event, outcome, and side so repeated $1
                copies from multiple traders display as one Bullpen exposure.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-4">
              <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="inline-flex w-full rounded-2xl border border-slate-200 bg-slate-50 p-1 sm:w-auto">
                  <button
                    type="button"
                    className={`flex-1 rounded-xl px-4 py-2 text-sm font-medium transition sm:flex-none ${
                      copiedPositionsTab === "positions"
                        ? "bg-white text-slate-950 shadow-sm ring-1 ring-slate-200"
                        : "text-slate-500 hover:text-slate-900"
                    }`}
                    onClick={() => setCopiedPositionsTab("positions")}
                  >
                    Positions ({copiedPositionTrades.length})
                  </button>
                  <button
                    type="button"
                    className={`flex-1 rounded-xl px-4 py-2 text-sm font-medium transition sm:flex-none ${
                      copiedPositionsTab === "history"
                        ? "bg-white text-slate-950 shadow-sm ring-1 ring-slate-200"
                        : "text-slate-500 hover:text-slate-900"
                    }`}
                    onClick={() => setCopiedPositionsTab("history")}
                  >
                    History ({copiedHistoryTrades.length})
                  </button>
                </div>

                {copiedPositionsTab === "positions" ? (
                  <div className="inline-flex w-full rounded-2xl border border-slate-200 bg-white p-1 sm:w-auto">
                    <button
                      type="button"
                      className={`flex-1 rounded-xl px-4 py-2 text-sm font-medium transition sm:flex-none ${
                        copiedPositionStatus === "active"
                          ? "bg-slate-950 text-white shadow-sm"
                          : "text-slate-500 hover:text-slate-900"
                      }`}
                      onClick={() => setCopiedPositionStatus("active")}
                    >
                      Active
                    </button>
                    <button
                      type="button"
                      className={`flex-1 rounded-xl px-4 py-2 text-sm font-medium transition sm:flex-none ${
                        copiedPositionStatus === "closed"
                          ? "bg-slate-950 text-white shadow-sm"
                          : "text-slate-500 hover:text-slate-900"
                      }`}
                      onClick={() => setCopiedPositionStatus("closed")}
                    >
                      Closed
                    </button>
                  </div>
                ) : null}
              </div>

              {copiedPositionsTab === "history" ? (
                <div className="mb-4 flex flex-wrap gap-2">
                  {copiedHistoryFilterOptions.map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      className={`rounded-xl border px-4 py-2 text-sm font-medium transition ${
                        copiedHistoryFilter === option.key
                          ? "border-slate-950 bg-slate-950 text-white shadow-sm"
                          : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-950"
                      }`}
                      onClick={() => setCopiedHistoryFilter(option.key)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              ) : null}

              <div className="overflow-x-auto rounded-[24px] border border-slate-200 bg-white shadow-sm">
                <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
                  <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                    <tr>
                      <th className="px-4 py-3">Copied At</th>
                      <th className="px-4 py-3">Trader</th>
                      <th className="px-4 py-3">Event</th>
                      <th className="px-4 py-3">Event Ends</th>
                      <th className="px-4 py-3">Side</th>
                      <th className="px-4 py-3">Outcome</th>
                      <th className="px-4 py-3">Amount</th>
                      {copiedPositionsTab === "positions" && copiedPositionStatus === "active" ? (
                        <th className="px-4 py-3">
                          Current PnL
                          <span className="mt-1 block text-[10px] normal-case tracking-normal text-slate-400">
                            refreshes every {copiedPositionsRefreshSeconds}s
                          </span>
                        </th>
                      ) : null}
                      <th className="px-4 py-3">Price</th>
                      <th className="px-4 py-3">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {copiedEventGroups.length === 0 ? (
                      <tr>
                        <td
                          className="px-4 py-6 text-sm text-slate-500"
                          colSpan={
                            copiedPositionsTab === "positions" &&
                            copiedPositionStatus === "active"
                              ? 10
                              : 9
                          }
                        >
                          No copied Bullpen rows for this tab yet.
                        </td>
                      </tr>
                    ) : copiedEventGroups.map((event) => {
                      const hasMultipleTraders = event.traders.length > 1;
                      return (
                        <tr key={event.key} className="align-top">
                          <td className="px-4 py-3 text-slate-700">{formatTs(event.copiedAt)}</td>
                          <td className="px-4 py-3 text-slate-700">
                            {hasMultipleTraders ? (
                              <button
                                className="font-medium text-sky-700 underline underline-offset-2"
                                onClick={() => setSelectedCopiedEvent(event)}
                              >
                                multiple
                              </button>
                            ) : (
                              <a
                                className="font-medium text-sky-700 underline underline-offset-2 hover:text-sky-900"
                                href={getTraderActivityUrl(event.traders[0]) || "#"}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {getTraderDisplayName(event.traders[0])}
                              </a>
                            )}
                          </td>
                          <td className="px-4 py-3 text-slate-700">
                            <div className="flex items-start gap-2">
                              <div>
                                <div className="font-medium text-slate-950">{event.marketTitle}</div>
                                <div className="mt-1 text-xs text-slate-500">{event.marketId}</div>
                              </div>
                              <button
                                className="mt-0.5 rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                                aria-label={`Show copied traders for ${event.marketTitle}`}
                                onClick={() => setSelectedCopiedEvent(event)}
                              >
                                <Info className="size-4" />
                              </button>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-slate-700">
                            {formatEventEnd(
                              event.eventEndAt,
                              `${event.marketId} ${event.marketTitle}`,
                            )}
                          </td>
                          <td className="px-4 py-3 font-semibold text-slate-800">{event.side}</td>
                          <td className="px-4 py-3 text-slate-700">{event.outcome}</td>
                          <td className="px-4 py-3 text-slate-700">{formatMoney(event.amount)}</td>
                          {copiedPositionsTab === "positions" && copiedPositionStatus === "active" ? (
                            <td
                              className={`px-4 py-3 font-semibold ${
                                event.currentPnl >= 0
                                  ? "text-emerald-600"
                                  : "text-rose-600"
                              }`}
                            >
                              {formatMoney(event.currentPnl)}
                            </td>
                          ) : null}
                          <td className="px-4 py-3 text-slate-700">{formatMoney(event.averagePrice, 4)}</td>
                          <td className="px-4 py-3 text-slate-700">{copiedPositionsTab === "positions" && copiedPositionStatus === "closed" ? getCopiedEventStatus(event) : event.status}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
          <Card className="border border-slate-200 bg-white py-6">
            <CardHeader className="pb-0">
              <CardTitle className="text-base tracking-[0.18em] text-slate-950">
                Missed Trades
              </CardTitle>
              <CardDescription>
                Trades shortlisted for live copy execution but missed because
                the Bullpen account did not have enough available balance.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-4">
              <div className="overflow-x-auto rounded-[24px] border border-slate-200 bg-white shadow-sm">
                <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
                  <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                    <tr>
                      <th className="px-4 py-3">Timestamp</th>
                      <th className="px-4 py-3">Event Name</th>
                      <th className="px-4 py-3">Side</th>
                      <th className="px-4 py-3">Trader</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {missedTradeGroups.length === 0 ? (
                      <tr>
                        <td className="px-4 py-6 text-sm text-slate-500" colSpan={4}>
                          No insufficient-balance missed trades found in recent decisions.
                        </td>
                      </tr>
                    ) : missedTradeGroups.map((trade) => {
                      const hasMultipleTraders = trade.traders.length > 1;
                      return (
                        <tr key={trade.key} className="align-top">
                          <td className="px-4 py-3 text-slate-700">{formatTs(trade.missedAt)}</td>
                          <td className="px-4 py-3 text-slate-700">
                            <button
                              className="text-left font-medium text-slate-950 hover:text-sky-700"
                              onClick={() => setSelectedMissedTrade(trade)}
                            >
                              {trade.marketTitle}
                            </button>
                            <div className="mt-1 text-xs text-slate-500">{trade.outcome}</div>
                          </td>
                          <td className="px-4 py-3 font-semibold text-slate-800">{trade.side}</td>
                          <td className="px-4 py-3 text-slate-700">
                            {hasMultipleTraders ? (
                              <button
                                className="font-medium text-sky-700 underline underline-offset-2"
                                onClick={() => setSelectedMissedTrade(trade)}
                              >
                                multiple ({trade.traders.length})
                              </button>
                            ) : getTraderDisplayName(trade.traders[0])}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <Card className="border border-slate-200 bg-white py-6">
            <CardHeader className="pb-0">
              <CardTitle className="text-base tracking-[0.18em] text-slate-950">
                Top Tracked Traders
              </CardTitle>
              <CardDescription>
                Tracked public trader identities selected for copy-read
                monitoring. Legacy manually added handle-only rows are hidden
                here; manage manual accounts from Settings.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-4">
              <TrackedTradersTable traders={visibleTrackedTraders} />
            </CardContent>
          </Card>

          <Card className="border border-slate-200 bg-white py-6">
            <CardHeader className="pb-0">
              <CardTitle className="text-base tracking-[0.18em] text-slate-950">
                Recent Bullpen Activity
              </CardTitle>
              <CardDescription>
                Live-read, guard, balance, and execution events from the
                Bullpen-backed bot.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-4">
              <div className="rounded-[24px] border border-slate-200 bg-slate-50 px-4 py-4 shadow-sm">
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Event Log
                </div>
                <div className="mt-3 space-y-3">
                  {state.recent_activity.length === 0 ? (
                    <div className="text-sm text-slate-500">
                      No Bullpen activity yet.
                    </div>
                  ) : (
                    state.recent_activity.map((entry) => (
                      <div
                        key={`${entry.timestamp}-${entry.message}`}
                        className="rounded-[18px] bg-white px-3 py-3 shadow-sm ring-1 ring-slate-200"
                      >
                        <div className="text-xs font-medium uppercase tracking-[0.16em] text-slate-400">
                          {formatTs(entry.timestamp)}
                        </div>
                        <div className="mt-1 text-sm text-slate-700">
                          {entry.message}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      ) : (
        <>
          <Card className="border border-slate-200 bg-white py-6">
            <CardHeader className="pb-0">
              <CardTitle className="text-base tracking-[0.18em] text-slate-950">
                Bot Status
              </CardTitle>
              <CardDescription>
                Current runtime and Bullpen polling state for the real-money
                copy bot.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-4">
              <MetricGrid
                items={botStatusItems}
                columns="md:grid-cols-2 xl:grid-cols-5"
              />
            </CardContent>
          </Card>
          <Card className="border border-slate-200 bg-white py-6">
            <CardHeader className="pb-0">
              <CardTitle className="text-base tracking-[0.18em] text-slate-950">
                Live Trading Control
              </CardTitle>
              <CardDescription>
                Sandbox execution is disabled. Real Polymarket orders route
                through Bullpen after live guards pass.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 pt-4">
              <MetricGrid
                items={liveControlItems}
                columns="md:grid-cols-2 xl:grid-cols-4"
              />

              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="rounded-full border-slate-300"
                  disabled={pendingAction !== null}
                  onClick={() =>
                    runAction("toggle-live", () =>
                      state.live.unlocked
                        ? apiService.polymarketLiveLock()
                        : apiService.polymarketLiveUnlock(),
                    )
                  }
                >
                  {state.live.unlocked ? "Lock live" : "Unlock live"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="rounded-full border-slate-300"
                  disabled={pendingAction !== null}
                  onClick={() =>
                    runAction("doctor", () => apiService.polymarketLiveDoctor())
                  }
                >
                  Refresh doctor
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="rounded-full border-slate-300"
                  disabled={pendingAction !== null}
                  onClick={() =>
                    runAction("balance", () =>
                      apiService.polymarketLiveBalanceRefresh(),
                    )
                  }
                >
                  Refresh balance
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="rounded-full border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                  disabled={pendingAction !== null}
                  onClick={() =>
                    runAction("redeem", () => apiService.polymarketLiveRedeem())
                  }
                >
                  Redeem resolved
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  className="rounded-full"
                  disabled={pendingAction !== null}
                  onClick={() =>
                    runAction("emergency-stop", () =>
                      apiService.polymarketLiveEmergencyStop(),
                    )
                  }
                >
                  Emergency stop
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="rounded-full border-slate-300"
                  disabled={pendingAction !== null}
                  onClick={() =>
                    runAction("emergency-reset", () =>
                      apiService.polymarketLiveResetEmergencyStop(),
                    )
                  }
                >
                  Reset emergency stop
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card className="border border-slate-200 bg-white py-6">
            <CardHeader className="pb-0">
              <CardTitle className="text-base tracking-[0.18em] text-slate-950">
                Trader Discovery Logic
              </CardTitle>
              <CardDescription>
                Detection can be broad, but proposal creation is selective.
                Tracked does not mean a trade will be copied.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 pt-4">
              <MetricGrid
                items={discoveryItems}
                columns="md:grid-cols-2 xl:grid-cols-4"
              />
              <div className="rounded-[20px] border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
                New proposals appear only after a live-read trade is detected
                after startup baseline. If manual wallets are configured, they
                are preferred over auto-discovered traders.
              </div>
              {manualInvalid.length > 0 ? (
                <div className="rounded-[20px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                  Invalid manual wallet entries were ignored:{" "}
                  {manualInvalid.join(", ")}
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card className="border border-slate-200 bg-white py-6">
            <CardHeader className="pb-0">
              <CardTitle className="text-base tracking-[0.18em] text-slate-950">
                Live Source Status
              </CardTitle>
              <CardDescription>
                Poll-level diagnostics for the live-read source, baseline
                tracking, and proposal-control filters.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-4">
              <MetricGrid
                items={liveSourceItems}
                columns="md:grid-cols-2 xl:grid-cols-4"
              />
            </CardContent>
          </Card>

          <Card className="border border-slate-200 bg-white py-6">
            <CardHeader className="pb-0">
              <CardTitle className="text-base tracking-[0.18em] text-slate-950">
                Manual Tracked Wallets
              </CardTitle>
              <CardDescription>
                Add, delete, enable, and tune manual Polymarket accounts.
                Environment-configured `MANUAL_TRACKED_WALLETS` entries remain
                tracked even if not discovered by the active-trader scan.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6 pt-4">
              <TrackedAccountsTable
                accounts={state.tracked_accounts}
                drafts={accountDrafts}
                newDraft={newAccountDraft}
                busyId={busyAccountId}
                onDraftChange={(id, draft) =>
                  setAccountDrafts((current) => ({ ...current, [id]: draft }))
                }
                onNewDraftChange={setNewAccountDraft}
                onAdd={() => void addTrackedAccount()}
                onSave={(accountId) => void saveTrackedAccount(accountId)}
                onDelete={(accountId) => void deleteTrackedAccount(accountId)}
              />
              <div>
                <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Environment wallets
                </div>
                <ManualWalletsTable
                  wallets={state.live.source_status.manual_tracked_wallets}
                />
              </div>
            </CardContent>
          </Card>
        </>
      )}



      {selectedMissedTrade ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 px-4"
          role="dialog"
          aria-modal="true"
          onClick={() => setSelectedMissedTrade(null)}
        >
          <div
            className="relative w-full max-w-3xl rounded-[28px] bg-white p-6 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="absolute right-4 top-4 rounded-full p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-400"
              aria-label="Close missed trade traders popup"
              onClick={() => setSelectedMissedTrade(null)}
            >
              <X className="size-5" />
            </button>
            <div className="flex items-start justify-between gap-4 pr-12">
              <div>
                <h2 className="text-lg font-semibold text-slate-950">Missed trade traders</h2>
                <p className="mt-1 text-sm text-slate-500">{selectedMissedTrade.marketTitle}</p>
              </div>
            </div>
            <div className="mt-5 overflow-hidden rounded-[20px] border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
                <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Trader</th>
                    <th className="px-4 py-3">Timestamp</th>
                    <th className="px-4 py-3">Side</th>
                    <th className="px-4 py-3">Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {selectedMissedTrade.traders.map((trade) => (
                    <tr key={trade.id}>
                      <td className="px-4 py-3 font-medium text-slate-950">{getTraderDisplayName(trade)}</td>
                      <td className="px-4 py-3 text-slate-700">
                        {formatTs(trade.executed_at || trade.updated_at || trade.proposed_at)}
                      </td>
                      <td className="px-4 py-3 font-semibold text-slate-800">{trade.side}</td>
                      <td className="px-4 py-3 text-slate-700">{trade.failure_reason || selectedMissedTrade.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}
      {selectedCopiedEvent ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 px-4"
          role="dialog"
          aria-modal="true"
          onClick={() => setSelectedCopiedEvent(null)}
        >
          <div
            className="relative w-full max-w-4xl rounded-[28px] bg-white p-6 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="absolute right-4 top-4 rounded-full p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-400"
              aria-label="Close copied traders popup"
              onClick={() => setSelectedCopiedEvent(null)}
            >
              <X className="size-5" />
            </button>
            <div className="flex items-start justify-between gap-4 pr-12">
              <div>
                <h2 className="text-lg font-semibold text-slate-950">Copied traders</h2>
                <p className="mt-1 text-sm text-slate-500">{selectedCopiedEvent.marketTitle}</p>
              </div>
            </div>
            <div className="mt-5 overflow-hidden rounded-[20px] border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
                <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Trader</th>
                    <th className="px-4 py-3">Timestamp</th>
                    <th className="px-4 py-3">Amount</th>
                    <th className="px-4 py-3">Trader invested</th>
                    <th className="px-4 py-3">% of Net Worth</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {selectedCopiedEvent.traders.map((trade) => {
                    const traderInvested = trade.trader_invested_usd || 0;
                    const traderAccount = trackedAccountByIdentity.get(
                      (trade.trader_handle || trade.trader_name || trade.trader_address)
                        .toLowerCase()
                        .replace(/^@/, ""),
                    );
                    const netWorth = traderAccount?.net_worth_usd || 0;
                    const netWorthPercent =
                      netWorth > 0 ? (traderInvested / netWorth) * 100 : null;
                    const activityUrl = getTraderActivityUrl(trade);
                    return (
                      <tr key={trade.id}>
                        <td className="px-4 py-3 font-medium text-slate-950">
                          {activityUrl ? (
                            <a
                              className="text-sky-700 underline underline-offset-2 hover:text-sky-900"
                              href={activityUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {getTraderDisplayName(trade)}
                            </a>
                          ) : getTraderDisplayName(trade)}
                        </td>
                        <td className="px-4 py-3 text-slate-700">
                          {formatTs(trade.executed_at || trade.updated_at || trade.proposed_at)}
                        </td>
                        <td className="px-4 py-3 text-slate-700">{formatMoney(trade.amount)}</td>
                        <td className="px-4 py-3 text-slate-700">{formatMoney(traderInvested)}</td>
                        <td className="px-4 py-3 text-slate-700">
                          {netWorthPercent === null ? "—" : formatPercent(netWorthPercent)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}
      {pendingAction ? (
        <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-slate-500">
          <Loader2 className="size-3.5 animate-spin" />
          Processing {pendingAction}
        </div>
      ) : null}
    </div>
  );
}

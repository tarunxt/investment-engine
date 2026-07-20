"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  Copy,
  Edit3,
  ExternalLink,
  Info,
  Loader2,
  Menu,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  TrendingUp,
  Wallet,
  X,
} from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { apiService, APIError } from "@/services/api";
import { parseApiTimestamp } from "@/lib/datetime";
import type {
  PolymarketBalanceState,
  PolymarketBotState,
  PolymarketDoctorStatus,
  PolymarketPaperTrade,
  PolymarketPosition,
  PolymarketTrackedAccount,
  PolymarketSourceTradeDecision,
  PolymarketBullpenRedeemedTrade,
} from "@/types/api";

import type { MetricItem } from "./_components/MetricGrid";
import {
  PolymarketBotMetricGridSkeleton,
  PolymarketBotPageSkeleton,
  PolymarketBotTableSkeleton,
} from "./_components/PolymarketBotPageSkeleton";
import type { TrackedAccountDraft } from "./_components/TraderTables";

const MetricGrid = dynamic(
  () => import("./_components/MetricGrid").then((mod) => mod.MetricGrid),
  {
    loading: () => <PolymarketBotMetricGridSkeleton />,
  },
);
const ManualWalletsTable = dynamic(
  () =>
    import("./_components/TraderTables").then((mod) => mod.ManualWalletsTable),
  {
    ssr: false,
    loading: () => <PolymarketBotTableSkeleton rows={4} columns={3} />,
  },
);
const TrackedAccountsTable = dynamic(
  () =>
    import("./_components/TraderTables").then((mod) => mod.TrackedAccountsTable),
  {
    ssr: false,
    loading: () => <PolymarketBotTableSkeleton rows={6} columns={5} />,
  },
);
const TrackedTradersTable = dynamic(
  () =>
    import("./_components/TraderTables").then((mod) => mod.TrackedTradersTable),
  {
    ssr: false,
    loading: () => <PolymarketBotTableSkeleton rows={5} columns={6} />,
  },
);

const COPIED_ACTIVE_STATUSES = new Set(["executed", "confirmed"]);
const COPIED_HISTORY_FILTER_OPTIONS: {
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
const COPIED_POSITION_PNL_FILTER_OPTIONS: {
  key: CopiedPositionPnlFilter;
  label: string;
}[] = [
  { key: "all", label: "All" },
  { key: "winning", label: "Winning" },
  { key: "losing", label: "Losing" },
];
const DEFERRED_CARD_STYLE = {
  contentVisibility: "auto" as const,
  containIntrinsicSize: "640px",
};

function stringifyErrorDetail(detail: unknown): string | null {
  if (!detail) return null;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const parts = detail
      .map((item) => stringifyErrorDetail(item))
      .filter(Boolean);
    return parts.length > 0 ? parts.join("; ") : null;
  }
  if (typeof detail === "object") {
    const record = detail as Record<string, unknown>;
    const message =
      stringifyErrorDetail(record.detail) ||
      stringifyErrorDetail(record.message) ||
      stringifyErrorDetail(record.error);
    if (message) return message;

    const entries = Object.entries(record)
      .map(([key, value]) => {
        const valueText = stringifyErrorDetail(value);
        return valueText ? `${key}: ${valueText}` : null;
      })
      .filter(Boolean);
    return entries.length > 0 ? entries.join("; ") : null;
  }
  return String(detail);
}

function normalizeError(error: unknown) {
  if (error instanceof APIError) {
    const details = stringifyErrorDetail(error.details);
    const statusText = `HTTP ${error.status}`;
    const baseMessage = error.message || "API request failed";
    return details && details !== baseMessage
      ? `${statusText}: ${baseMessage}. Details: ${details}`
      : `${statusText}: ${baseMessage}`;
  }
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return `Unexpected error: ${String(error)}`;
}

function formatTs(iso?: string | null) {
  const date = parseApiTimestamp(iso);
  if (!date) return iso || "—";

  return date.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function getIstDateKey(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function getApiTimestampIstDateKey(iso?: string | null) {
  const date = parseApiTimestamp(iso);
  return date ? getIstDateKey(date) : null;
}

function isApiTimestampTodayIst(iso?: string | null) {
  return getApiTimestampIstDateKey(iso) === getIstDateKey(new Date());
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
  return formatDuration(diff);
}

function formatDuration(totalSeconds: number) {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
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

function parseAccountValueUsdFromBalanceMessage(message?: string | null) {
  if (!message || !/account\s+value/i.test(message)) return null;
  const match = message.match(/(-?\d[\d,]*(?:\.\d+)?)/);
  if (!match) return null;
  const value = Number.parseFloat(match[1].replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

function mergeBullpenBalanceSnapshot(
  previous: PolymarketBalanceState | null,
  next: PolymarketBalanceState,
) {
  if (next.account_value_usd !== null && next.account_value_usd !== undefined) {
    return next;
  }

  const previousAccountValueUsd = previous?.account_value_usd;
  if (
    previousAccountValueUsd === null ||
    previousAccountValueUsd === undefined
  ) {
    return next;
  }

  return {
    ...next,
    account_value_usd: previousAccountValueUsd,
  };
}

function isUsableBullpenBalance(balance?: PolymarketBalanceState | null) {
  return balance?.status === "ready";
}

function isBullpenBalanceUnrefreshed(
  message?: string | null,
  status?: string | null,
) {
  const normalized = `${message || ""} ${status || ""}`.toLowerCase();
  return (
    normalized.includes("balance has not been refreshed") ||
    normalized.includes("balance has not refreshed") ||
    normalized.includes("not refreshed yet")
  );
}

function isBullpenLoginRequired(
  message?: string | null,
  status?: string | null,
) {
  const normalized = `${message || ""} ${status || ""}`.toLowerCase();
  return (
    normalized.includes("bullpen login required") ||
    normalized.includes("login required") ||
    normalized.includes("run: bullpen login")
  );
}

const DOCTOR_PASS_STICKY_MS = 2 * 60 * 1000;

function hasActiveBullpenDoctorSession(
  doctor?: PolymarketDoctorStatus | null,
  secondsRemaining?: number | null,
) {
  return Boolean(
    doctor?.ok && (secondsRemaining == null || secondsRemaining > 0),
  );
}

function getLiveCriticalBanner(
  state: PolymarketBotState,
  options?: { suppressStaleDoctorLogin?: boolean },
) {
  const issues: string[] = [];
  const doctorMessage =
    state.live.doctor.message || "No doctor details returned.";
  const doctorNeedsLogin = isBullpenLoginRequired(doctorMessage, null);

  if (!state.live.doctor.ok && !options?.suppressStaleDoctorLogin) {
    issues.push(
      doctorNeedsLogin
        ? "Doctor failed: Bullpen session expired. Run bullpen login."
        : `Doctor failed: ${doctorMessage}`,
    );
  }

  if (!state.live.unlocked) {
    const lockedReason = state.live.locked_reason || "unlock required";
    const isStaleDoctorLock =
      options?.suppressStaleDoctorLogin &&
      lockedReason.toLowerCase().includes("doctor must pass");
    if (!isStaleDoctorLock) {
      issues.push(`Live mode locked: ${lockedReason}`);
    }
  }

  if (state.live.emergency_stopped) {
    issues.push("Emergency stop is active.");
  }

  if (issues.length === 0) return null;

  return issues.join(" ");
}

function trackedAccountKey(value?: string | null) {
  return normalizeTrackedAccountTarget(value).toLowerCase();
}

const COPIED_TRADER_DEFAULT_NET_WORTH_USD: Record<string, number> = {
  rn1: 400_000,
  "0x29b52d98ac9ef9414b04164246c95bc63d7": 60_000,
  "0x6db5...e279": 1_000_000,
  swisstony: 2_700_000,
  zzzz87: 500_000,
  uptheblues: 20_000,
  tradecraft: 30_000,
  rainbowlilies: 50_000,
  mooseborzoi: 150_000,
};

function getCopiedTraderDefaultNetWorth(
  ...values: Array<string | null | undefined>
) {
  for (const value of values) {
    const key = trackedAccountKey(value);
    if (key && COPIED_TRADER_DEFAULT_NET_WORTH_USD[key] !== undefined) {
      return COPIED_TRADER_DEFAULT_NET_WORTH_USD[key];
    }
  }

  return 0;
}

function normalizeTrackedAccountTarget(value?: string | null) {
  const raw = (value || "").trim().replace(/\?+$/, "");
  if (!raw) return "";

  try {
    const parsed = new URL(raw);
    const segment = parsed.pathname.replace(/\/+$/, "").split("/").pop();
    if (segment) {
      return segment.replace(/^@/, "").replace(/\/+$/, "").trim();
    }
  } catch {
    // Not a URL; continue with plain Polymarket handle/address cleanup.
  }

  return raw.replace(/^@/, "").replace(/\/+$/, "").split("?", 1)[0].trim();
}

function findTrackedAccountForCopiedTrader(
  trader: CopiedTraderAnalysisRow,
  accounts: PolymarketTrackedAccount[],
) {
  if (trader.accountId) {
    const account = accounts.find((item) => item.id === trader.accountId);
    if (account) return account;
  }

  const traderKeys = [trader.traderName, trader.key].map(trackedAccountKey);
  return accounts.find((account) =>
    [account.handle, account.target, account.address, account.proxy_wallet]
      .map(trackedAccountKey)
      .some((key) => key && traderKeys.includes(key)),
  );
}

function isPersistedNetWorthValue(
  account: PolymarketTrackedAccount | undefined,
  netWorth: number,
) {
  return (
    Boolean(account) &&
    Number.isFinite(netWorth) &&
    Math.abs((account?.net_worth_usd ?? Number.NaN) - netWorth) < 0.005
  );
}

function getTradeIdentityKeys(trade: PolymarketSourceTradeDecision) {
  return [
    trade.trader_handle,
    trade.trader_name,
    trade.trader_address,
    trade.trader_id,
  ]
    .map(trackedAccountKey)
    .filter(Boolean);
}

function getTrackedAccountForTrade(
  trade: PolymarketSourceTradeDecision,
  accounts: PolymarketBotState["tracked_accounts"],
) {
  const tradeKeys = new Set(getTradeIdentityKeys(trade));
  return accounts.find((account) =>
    [account.handle, account.target, account.address, account.proxy_wallet]
      .map(trackedAccountKey)
      .some((key) => key && tradeKeys.has(key)),
  );
}

function getTradeNetWorth(
  trade: PolymarketSourceTradeDecision,
  account?: PolymarketBotState["tracked_accounts"][number],
  copiedTrader?: CopiedTraderAnalysisRow,
) {
  return (
    account?.net_worth_usd ||
    copiedTrader?.netWorth ||
    trade.trader_net_worth_usd ||
    0
  );
}

function getNetWorthMissingReason(
  trade: PolymarketSourceTradeDecision,
  account?: PolymarketBotState["tracked_accounts"][number],
  copiedTrader?: CopiedTraderAnalysisRow,
) {
  if (!account && !copiedTrader) return "No matching tracked account found";
  if (copiedTrader?.netWorth) return "—";
  if (
    account?.net_worth_source === "pending_refresh" ||
    (account && !account.net_worth_checked_at)
  ) {
    return "Net worth refresh pending";
  }
  return account?.net_worth_usd || trade.trader_net_worth_usd
    ? "—"
    : "Net worth unavailable from provider";
}

function getCopiedTraderAnalysisForTrade(
  trade: PolymarketSourceTradeDecision,
  copiedTraders: CopiedTraderAnalysisRow[],
) {
  const tradeKeys = new Set(getTradeIdentityKeys(trade));
  return copiedTraders.find((trader) =>
    [trader.traderName, trader.key]
      .map(trackedAccountKey)
      .some((key) => key && tradeKeys.has(key)),
  );
}

function getPositionsValueMissingReason(
  account?: PolymarketBotState["tracked_accounts"][number],
) {
  if (!account) return "No matching tracked account found";
  if (
    account?.net_worth_source === "pending_refresh" ||
    (account && !account.net_worth_checked_at)
  ) {
    return "Positions refresh pending";
  }
  return account.positions_value_usd == null
    ? "Positions value unavailable from Bullpen"
    : "—";
}

function isBelowTrackedNetWorthThreshold(
  trade: PolymarketSourceTradeDecision,
  accounts: PolymarketBotState["tracked_accounts"],
) {
  const account = getTrackedAccountForTrade(trade, accounts);
  if (!account) return false;
  const netWorth = getTradeNetWorth(trade, account);
  if (netWorth <= 0) return true;
  return (
    (trade.trader_invested_usd || 0) <
    netWorth * (account.threshold_percent / 100)
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

function formatOptionalMoney(value?: number | null, digits = 2) {
  return typeof value === "number" && Number.isFinite(value)
    ? formatMoney(value, digits)
    : "—";
}

function formatCompactMoney(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value || 0);
}

function copiedTraderNetWorthBreakdown(trader: CopiedTraderAnalysisRow) {
  if (trader.netWorthError) return `Auto fetch failed: ${trader.netWorthError}`;
  if (!trader.netWorthSource || trader.netWorthSource === "pending_refresh") {
    return "Auto refresh pending; $100 is the safe default until Polymarket balances are fetched.";
  }
  return `Active positions ${formatMoney(trader.positionsValueUsd || 0)} + Cash balance ${formatMoney(
    trader.cashBalanceUsd || 0,
  )} + Claimable/redeemable ${formatMoney(trader.redeemableValueUsd || 0)}`;
}

const BULLPEN_ACCOUNT_URL =
  "https://app.bullpen.fi/wallet/predictions?ref=intrepid-crane-3";
const AWS_EC2_TERMINAL_URL =
  "https://ap-south-1.console.aws.amazon.com/ec2-instance-connect/ssh/home?addressFamily=ipv4&connType=standard&instanceId=i-0b8ad0aebce8510cb&osUser=ubuntu&region=ap-south-1&sshPort=22";
const DEFAULT_SYSTEMD_BULLPEN_LOGIN_COMMAND =
  "sudo -u investor -H /usr/local/bin/bullpen login --no-browser";
const DEFAULT_SYSTEMD_BULLPEN_VERIFY_COMMAND =
  "sudo -u investor -H /usr/local/bin/bullpen polymarket positions --output json";
const DEFAULT_EC2_COMMANDS = [
  DEFAULT_SYSTEMD_BULLPEN_LOGIN_COMMAND,
  DEFAULT_SYSTEMD_BULLPEN_VERIFY_COMMAND,
  "sudo systemctl status investor-celery-worker --no-pager",
];
const EC2_COMMANDS_STORAGE_KEY = "polymarketBot.ec2Commands";

function normalizeEc2Commands(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .filter((command): command is string => typeof command === "string")
    .map((command) => command.trim())
    .filter(Boolean);
}

function getInitialEc2Commands() {
  if (typeof window === "undefined") return DEFAULT_EC2_COMMANDS;

  try {
    const savedCommands = window.localStorage.getItem(EC2_COMMANDS_STORAGE_KEY);
    if (!savedCommands) return DEFAULT_EC2_COMMANDS;

    const parsedCommands = JSON.parse(savedCommands);
    return normalizeEc2Commands(parsedCommands) ?? DEFAULT_EC2_COMMANDS;
  } catch (error) {
    console.warn("Unable to load saved EC2 commands", error);
    return DEFAULT_EC2_COMMANDS;
  }
}

const TABLE_PAGE_SIZE = 10;
const STATE_REFRESH_INTERVAL_MS = 60_000;
const COPIED_TRADERS_ANALYSIS_PAGE_SIZE = 10;
const PAST_TRADES_PAGE_SIZE = 10;

function formatRefreshInterval(ms: number) {
  const seconds = Math.round(ms / 1000);
  if (seconds >= 60 && seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} min`;
  }
  return `${seconds}s`;
}

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

function getActionLabel(pendingAction: string | null) {
  const labels: Record<string, string> = {
    "toggle-live": "live lock change",
    doctor: "doctor refresh",
    balance: "balance refresh",
    redeem: "redeem resolved",
    "emergency-stop": "emergency stop",
    "emergency-reset": "emergency stop reset",
    start: "bot start",
    stop: "bot stop",
    pause: "bot pause",
    resume: "bot resume",
    "update-live-limit": "live trade limit update",
  };
  return pendingAction ? labels[pendingAction] || pendingAction : null;
}

function getPendingActionDetail(pendingAction: string | null) {
  if (pendingAction === "redeem") {
    return "Submitting the claim to Bullpen, waiting for resolved positions to close, then refreshing this table with the latest redeemed trades.";
  }
  if (pendingAction === "balance") {
    return "Requesting a fresh Bullpen balance snapshot from the backend.";
  }
  if (pendingAction === "doctor") {
    return "Running backend health checks for the live Bullpen integration.";
  }
  if (pendingAction) {
    return "Waiting for the backend action to finish before re-enabling controls.";
  }
  return null;
}

function getRedeemStatusMessage(
  elapsedSeconds: number,
  claimableRedeemedCount: number,
) {
  const elapsedLabel =
    elapsedSeconds > 0 ? ` Claim has been running for ${elapsedSeconds}s.` : "";
  const claimableLabel =
    claimableRedeemedCount > 0
      ? `${claimableRedeemedCount} resolved winning ${
          claimableRedeemedCount === 1 ? "position is" : "positions are"
        } being claimed.`
      : "Checking for resolved winning positions to claim.";

  return `${claimableLabel}${elapsedLabel}`;
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

function getSkippedBreakup(state: PolymarketBotState) {
  const source = state.live.source_status;
  const filters = source.skipped_by_filters_last_poll;
  const limits = source.skipped_by_limits_last_poll;
  const duplicates = source.skipped_duplicates_last_poll;
  const knownSkipped = filters + limits + duplicates;
  const found = source.source_trades_found_last_poll;
  const processed = source.source_trades_after_filters_last_poll;
  const impliedSkipped = Math.max(0, found - processed);
  const others = Math.max(0, impliedSkipped - knownSkipped);

  return {
    filters,
    limits,
    duplicates,
    others,
    total: knownSkipped + others,
  };
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
  const skipped = getSkippedBreakup(state).total;
  return `Reading trades continuously · last poll ${lastPoll} · found ${found}, processed ${afterFilters}, queued ${proposals}, skipped ${skipped}.`;
}

type CopiedSortColumn =
  | "copiedAt"
  | "trader"
  | "event"
  | "eventEnd"
  | "side"
  | "outcome"
  | "amount"
  | "currentPnl"
  | "price"
  | "latestPrice"
  | "pnl"
  | "status";

type CopiedSortState = {
  column: CopiedSortColumn;
  direction: "asc" | "desc";
};

type CopiedPositionPnlFilter = "all" | "winning" | "losing";

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

type RedeemedTradeRow = {
  key: string;
  timestamp: string;
  marketId: string;
  marketTitle: string;
  outcome: string;
  side:
    | PolymarketPaperTrade["side"]
    | PolymarketSourceTradeDecision["side"]
    | PolymarketBullpenRedeemedTrade["side"];
  amount: number;
  shares: number;
  price: number;
  profitLoss: number;
  status: string;
  source: string;
  detail: string;
};

type AnalysisTradeRow = {
  id: string;
  timestamp: string;
  traderKey: string;
  traderName: string;
  traderHandle?: string | null;
  traderAddress?: string | null;
  marketId: string;
  marketTitle: string;
  outcome: string;
  side: PolymarketSourceTradeDecision["side"];
  amount: number;
  price: number;
  shares: number;
  status: PolymarketSourceTradeDecision["status"];
  pnl: number;
  reason: string;
  traderNetWorth: number;
};

type CopiedTraderAnalysisRow = {
  key: string;
  traderName: string;
  accountId?: string;
  netWorthCheckedAt?: string | null;
  positionsValueUsd?: number | null;
  cashBalanceUsd?: number | null;
  redeemableValueUsd?: number | null;
  netWorthSource?: string | null;
  netWorthError?: string | null;
  copiedTrades: number;
  tradesWon: number;
  totalWinnings: number;
  tradesLost: number;
  totalLosses: number;
  totalPnl: number;
  netWorth: number;
  trades: AnalysisTradeRow[];
};

function getAnalysisTradePnl(trade: PolymarketSourceTradeDecision) {
  if (typeof trade.realized_pnl === "number") return trade.realized_pnl;
  if (trade.side === "SELL" && typeof trade.cost_basis_usd === "number") {
    return trade.amount - trade.cost_basis_usd;
  }
  if (trade.side === "SELL") return trade.amount;
  return 0;
}

function getLiveAnalysisTraderKey(trade: PolymarketSourceTradeDecision) {
  return trackedAccountKey(
    trade.trader_handle ||
      trade.trader_address ||
      trade.trader_name ||
      trade.trader_id,
  );
}

function getPaperAnalysisTraderKey(trade: PolymarketPaperTrade) {
  return trackedAccountKey(trade.trader_name || trade.trader_id);
}

function buildAnalysisTradeRows(state: PolymarketBotState): AnalysisTradeRow[] {
  const liveRows: AnalysisTradeRow[] = state.live.recent_decisions
    .filter((trade) => trade.status === "executed")
    .map((trade) => {
      const traderName = getTraderDisplayName(trade);
      return {
        id: `live-${trade.id}`,
        timestamp: trade.executed_at || trade.updated_at || trade.proposed_at,
        traderKey: getLiveAnalysisTraderKey(trade),
        traderName,
        traderHandle: trade.trader_handle,
        traderAddress: trade.trader_address,
        marketId: trade.market_id,
        marketTitle: trade.market_title,
        outcome: trade.outcome,
        side: trade.side,
        amount: trade.amount,
        price: trade.price,
        shares: trade.shares,
        status: trade.status,
        pnl: getAnalysisTradePnl(trade),
        reason: trade.reason || trade.command || "Copied live trade",
        traderNetWorth: trade.trader_net_worth_usd || 0,
      };
    });

  const paperRows: AnalysisTradeRow[] = state.trade_history
    .filter((trade) => trade.status === "executed")
    .map((trade) => ({
      id: `paper-${trade.id}`,
      timestamp: trade.timestamp,
      traderKey: getPaperAnalysisTraderKey(trade),
      traderName: trade.trader_name,
      marketId: trade.market_id,
      marketTitle: trade.market_title,
      outcome: trade.outcome,
      side: trade.side,
      amount: trade.copied_usd,
      price: trade.price,
      shares: trade.shares,
      status: trade.status,
      pnl: trade.realized_pnl,
      reason: trade.reason || "Copied paper trade",
      traderNetWorth: 0,
    }));

  return [...liveRows, ...paperRows].sort(
    (a, b) =>
      (parseApiTimestamp(b.timestamp)?.getTime() ?? 0) -
      (parseApiTimestamp(a.timestamp)?.getTime() ?? 0),
  );
}

function getTrackedAccountForAnalysisRow(
  trade: AnalysisTradeRow,
  accounts: PolymarketTrackedAccount[],
) {
  const tradeKeys = [
    trade.traderKey,
    trade.traderName,
    trade.traderHandle,
    trade.traderAddress,
  ].map(trackedAccountKey);
  return accounts.find((account) =>
    [account.handle, account.target, account.address, account.proxy_wallet]
      .map(trackedAccountKey)
      .some((key) => key && tradeKeys.includes(key)),
  );
}

function buildCopiedTraderAnalysisRows(
  trades: AnalysisTradeRow[],
  accounts: PolymarketTrackedAccount[],
): CopiedTraderAnalysisRow[] {
  const rows = new Map<string, CopiedTraderAnalysisRow>();

  for (const trade of trades) {
    const existing =
      rows.get(trade.traderKey) ||
      ({
        key: trade.traderKey,
        traderName: trade.traderName,
        copiedTrades: 0,
        tradesWon: 0,
        totalWinnings: 0,
        tradesLost: 0,
        totalLosses: 0,
        totalPnl: 0,
        netWorth: 0,
        trades: [],
      } satisfies CopiedTraderAnalysisRow);

    const account = getTrackedAccountForAnalysisRow(trade, accounts);
    if (account) {
      existing.accountId = account.id;
      existing.netWorthCheckedAt = account.net_worth_checked_at;
      existing.positionsValueUsd = account.positions_value_usd;
      existing.cashBalanceUsd = account.cash_balance_usd;
      existing.redeemableValueUsd = account.redeemable_value_usd;
      existing.netWorthSource = account.net_worth_source;
      existing.netWorthError = account.net_worth_error;
    }
    existing.netWorth =
      account?.net_worth_usd ||
      trade.traderNetWorth ||
      existing.netWorth ||
      getCopiedTraderDefaultNetWorth(trade.traderName, trade.traderKey);
    existing.copiedTrades += 1;
    existing.trades.push(trade);
    if (trade.pnl >= 0) {
      existing.tradesWon += 1;
      existing.totalWinnings += trade.pnl;
    } else {
      existing.tradesLost += 1;
      existing.totalLosses += Math.abs(trade.pnl);
    }
    existing.totalPnl = existing.totalWinnings - existing.totalLosses;
    rows.set(trade.traderKey, existing);
  }

  return Array.from(rows.values()).sort((a, b) => {
    if (b.copiedTrades !== a.copiedTrades)
      return b.copiedTrades - a.copiedTrades;
    return b.totalPnl - a.totalPnl;
  });
}

function isRedeemedPaperTrade(trade: PolymarketPaperTrade) {
  const searchable =
    `${trade.reason || ""} ${trade.status || ""}`.toLowerCase();
  return (
    trade.status === "executed" &&
    (trade.side === "SELL" ||
      trade.realized_pnl !== 0 ||
      searchable.includes("redeem") ||
      searchable.includes("resolved"))
  );
}

function isRedeemedLiveDecision(trade: PolymarketSourceTradeDecision) {
  const searchable =
    `${trade.command || ""} ${trade.reason || ""} ${trade.status || ""}`.toLowerCase();
  return (
    trade.status === "executed" &&
    (trade.command === "sell" ||
      trade.side === "SELL" ||
      searchable.includes("redeem") ||
      searchable.includes("resolved") ||
      searchable.includes("auto-exit"))
  );
}

function getLiveDecisionTimeMs(trade: PolymarketSourceTradeDecision) {
  return (
    parseApiTimestamp(
      trade.executed_at || trade.updated_at || trade.proposed_at,
    )?.getTime() ?? 0
  );
}

function getEventEndTimeMs(trade: PolymarketSourceTradeDecision) {
  const explicitEnd = parseApiTimestamp(trade.event_end_at)?.getTime();
  if (explicitEnd) return explicitEnd;

  const titleDate = trade.market_title.match(/20\d{2}-\d{2}-\d{2}/)?.[0];
  return parseApiTimestamp(titleDate)?.getTime() ?? null;
}

function buildClaimableLiveRows(
  state: PolymarketBotState,
  redeemedKeys: Set<string>,
): RedeemedTradeRow[] {
  const nowMs = parseApiTimestamp(state.server_now)?.getTime() ?? Date.now();
  const openPositionKeys = new Set(
    state.open_positions
      .filter((position) => position.shares > 0)
      .map((position) => `${position.market_id}::${position.outcome}`),
  );
  const latestByPosition = new Map<string, PolymarketSourceTradeDecision>();

  for (const trade of state.live.recent_decisions) {
    if (trade.status !== "executed") continue;

    const key = `${trade.market_id}::${trade.outcome}`;
    const existing = latestByPosition.get(key);
    if (
      !existing ||
      getLiveDecisionTimeMs(trade) > getLiveDecisionTimeMs(existing)
    ) {
      latestByPosition.set(key, trade);
    }
  }

  return Array.from(latestByPosition.values())
    .filter((trade) => {
      const positionKey = `${trade.market_id}::${trade.outcome}`;
      if (
        trade.side !== "BUY" ||
        redeemedKeys.has(positionKey) ||
        !openPositionKeys.has(positionKey)
      ) {
        return false;
      }
      const eventEndMs = getEventEndTimeMs(trade);
      return eventEndMs !== null && eventEndMs <= nowMs;
    })
    .map((trade) => ({
      key: `claimable-${trade.id}`,
      timestamp: trade.executed_at || trade.updated_at || trade.proposed_at,
      marketId: trade.market_id,
      marketTitle: trade.market_title,
      outcome: trade.outcome,
      side: trade.side,
      amount: trade.shares,
      shares: Math.abs(trade.shares),
      price: 1,
      profitLoss: trade.shares - trade.amount,
      status: "claimable",
      source: "Available to claim",
      detail:
        "Resolved winning position still held in Bullpen; redeem/claim has not posted as a sell decision yet.",
    }));
}

function buildRedeemedTradeRows(state: PolymarketBotState): RedeemedTradeRow[] {
  const paperRows: RedeemedTradeRow[] = state.trade_history
    .filter(isRedeemedPaperTrade)
    .map((trade) => ({
      key: `paper-${trade.id}`,
      timestamp: trade.timestamp,
      marketId: trade.market_id,
      marketTitle: trade.market_title,
      outcome: trade.outcome,
      side: trade.side,
      amount: trade.copied_usd,
      shares: Math.abs(trade.shares),
      price: trade.price,
      profitLoss: trade.realized_pnl,
      status: trade.status,
      source: "Trade history",
      detail: trade.reason || "Closed or redeemed trade",
    }));

  const liveRows: RedeemedTradeRow[] = state.live.recent_decisions
    .filter(isRedeemedLiveDecision)
    .map((trade) => ({
      key: `live-${trade.id}`,
      timestamp: trade.executed_at || trade.updated_at || trade.proposed_at,
      marketId: trade.market_id,
      marketTitle: trade.market_title,
      outcome: trade.outcome,
      side: trade.side,
      amount: trade.amount,
      shares: Math.abs(trade.shares),
      price: trade.price,
      profitLoss:
        trade.side === "SELL"
          ? trade.amount
          : trade.shares * trade.price - trade.amount,
      status: trade.status,
      source: trade.command === "sell" ? "Live sell/redeem" : "Live execution",
      detail: trade.reason || trade.command || "Redeemed live trade",
    }));

  const bullpenRows: RedeemedTradeRow[] = state.live.redeemed_trades.map(
    (trade) => ({
      key: `bullpen-${trade.id}`,
      timestamp: trade.timestamp,
      marketId: trade.market_id,
      marketTitle: trade.market_title,
      outcome: trade.outcome,
      side: trade.side,
      amount: trade.amount,
      shares: Math.abs(trade.shares),
      price: trade.price,
      profitLoss: trade.profit_loss,
      status: trade.status,
      source: "Bullpen wallet history",
      detail: trade.detail,
    }),
  );

  const redeemedKeys = new Set(
    [...bullpenRows, ...liveRows, ...paperRows].map(
      (row) => `${row.marketId}::${row.outcome}`,
    ),
  );
  const claimableRows = buildClaimableLiveRows(state, redeemedKeys);
  const rows = [...claimableRows, ...bullpenRows, ...liveRows, ...paperRows];

  return rows
    .filter((row) => isApiTimestampTodayIst(row.timestamp))
    .sort(
      (a, b) =>
        (parseApiTimestamp(b.timestamp)?.getTime() ?? 0) -
        (parseApiTimestamp(a.timestamp)?.getTime() ?? 0),
    );
}

function getTraderDisplayName(trade: PolymarketSourceTradeDecision) {
  return trade.trader_handle ? `@${trade.trader_handle}` : trade.trader_name;
}

function getPolymarketProfileUrlFromHandle(handle: string) {
  const normalizedHandle = handle.replace(/^@/, "").trim().toLowerCase();
  if (!normalizedHandle) return null;
  return `https://polymarket.com/@${encodeURIComponent(normalizedHandle)}`;
}

function getTraderActivityUrl(trade: PolymarketSourceTradeDecision) {
  const handle = trade.trader_handle || trade.trader_name.replace(/^@/, "");
  const profileUrl = getPolymarketProfileUrlFromHandle(handle);
  return profileUrl ? `${profileUrl}?tab=activity` : null;
}

function getCopiedTraderProfileUrl(trader: CopiedTraderAnalysisRow) {
  return getPolymarketProfileUrlFromHandle(trader.traderName);
}

function PolymarketIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M14 14L50 6V58L14 50V14Z"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinejoin="round"
      />
      <path
        d="M16 16L50 32L16 48"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinejoin="round"
      />
      <path
        d="M18 32H50"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function getCopiedEventKey(trade: PolymarketSourceTradeDecision) {
  return [trade.market_id, trade.market_title, trade.outcome, trade.side].join(
    "::",
  );
}

function getBullpenPositionKey(position: PolymarketPosition) {
  return [position.market_id, position.outcome].join("::");
}

function getCopiedTradePositionKey(trade: PolymarketSourceTradeDecision) {
  return [trade.market_id, trade.outcome].join("::");
}

function getTradeStatusReason(trade: PolymarketSourceTradeDecision) {
  if (trade.failure_reason) return trade.failure_reason;
  if (trade.status === "failed" || trade.status === "skipped") {
    return trade.reason || "No reason provided";
  }
  return trade.status;
}

function summarizeFailureReason(reason: string, maxLength = 72) {
  const cleaned = reason.replace(/\s+/g, " ").trim();
  if (!cleaned) return "No reason provided";
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1).trimEnd()}…`;
}

function getCopiedEventFailureTrades(event: CopiedEventGroup) {
  return event.traders.filter((trade) => trade.status === "failed");
}

function getCopiedEventFailureSummary(event: CopiedEventGroup) {
  const failedTrade = getCopiedEventFailureTrades(event)[0];
  if (!failedTrade) return null;
  return summarizeFailureReason(getTradeStatusReason(failedTrade));
}

function getCopiedEventStatus(event: CopiedEventGroup) {
  const problemTrade = event.traders.find((trade) =>
    ["failed", "skipped", "rejected"].includes(trade.status),
  );
  if (!problemTrade) return event.status;
  return `${problemTrade.status}: ${getTradeStatusReason(problemTrade)}`;
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
    const tradeTimestamp =
      trade.executed_at || trade.updated_at || trade.proposed_at;
    if (
      new Date(tradeTimestamp).getTime() > new Date(existing.copiedAt).getTime()
    ) {
      existing.copiedAt = tradeTimestamp;
      existing.currentPrice = trade.price;
    }
    existing.eventEndAt = existing.eventEndAt || trade.event_end_at;
    existing.status = existing.traders.some(
      (item) => item.status === "executed",
    )
      ? "executed"
      : existing.status;
    existing.averagePrice =
      existing.amount > 0
        ? existing.traders.reduce(
            (total, item) => total + item.amount * item.price,
            0,
          ) / existing.amount
        : existing.averagePrice;
    existing.currentPnl = existing.traders.reduce((total, item) => {
      const markValue = item.shares * existing.currentPrice;
      return (
        total +
        (item.side === "BUY"
          ? markValue - item.amount
          : item.amount - markValue)
      );
    }, 0);
  }

  return Array.from(groups.values()).sort(
    (a, b) => new Date(b.copiedAt).getTime() - new Date(a.copiedAt).getTime(),
  );
}

function getCopiedEventSortValue(
  event: CopiedEventGroup,
  column: CopiedSortColumn,
) {
  switch (column) {
    case "copiedAt":
      return parseApiTimestamp(event.copiedAt)?.getTime() ?? 0;
    case "trader":
      return event.traders.length > 1
        ? `multiple (${event.traders.length})`
        : getTraderDisplayName(event.traders[0]);
    case "event":
      return event.marketTitle;
    case "eventEnd":
      return event.eventEndAt ? new Date(event.eventEndAt).getTime() : 0;
    case "side":
      return event.side;
    case "outcome":
      return event.outcome;
    case "amount":
      return event.amount;
    case "currentPnl":
      return event.currentPnl;
    case "price":
      return event.averagePrice;
    case "latestPrice":
      return event.currentPrice;
    case "pnl":
      return event.currentPrice - event.averagePrice;
    case "status":
      return getCopiedEventStatus(event);
  }
}

function compareCopiedEventTieBreakers(
  left: CopiedEventGroup,
  right: CopiedEventGroup,
) {
  const copiedAtComparison =
    (parseApiTimestamp(right.copiedAt)?.getTime() ?? 0) -
    (parseApiTimestamp(left.copiedAt)?.getTime() ?? 0);
  if (copiedAtComparison !== 0) return copiedAtComparison;

  return (
    [
      left.marketTitle.localeCompare(right.marketTitle, undefined, {
        numeric: true,
        sensitivity: "base",
      }),
      left.outcome.localeCompare(right.outcome, undefined, {
        numeric: true,
        sensitivity: "base",
      }),
      left.side.localeCompare(right.side),
      left.key.localeCompare(right.key),
    ].find((comparison) => comparison !== 0) ?? 0
  );
}

function compareCopiedEventGroups(
  left: CopiedEventGroup,
  right: CopiedEventGroup,
  sortState: CopiedSortState,
) {
  const leftValue = getCopiedEventSortValue(left, sortState.column);
  const rightValue = getCopiedEventSortValue(right, sortState.column);
  const comparison =
    typeof leftValue === "number" && typeof rightValue === "number"
      ? leftValue - rightValue
      : String(leftValue).localeCompare(String(rightValue), undefined, {
          numeric: true,
          sensitivity: "base",
        });

  if (comparison !== 0) {
    return sortState.direction === "asc" ? comparison : -comparison;
  }

  return compareCopiedEventTieBreakers(left, right);
}

function SortIcon({ direction }: { direction: "asc" | "desc" | null }) {
  if (direction === "asc") return <ArrowUp className="size-3.5 shrink-0" />;
  if (direction === "desc") return <ArrowDown className="size-3.5 shrink-0" />;
  return <ArrowUpDown className="size-3.5 shrink-0 opacity-60" />;
}

function TablePaginationControl({
  total,
  page,
  pageSize = TABLE_PAGE_SIZE,
  onPageChange,
}: {
  total: number;
  page: number;
  pageSize?: number;
  onPageChange: (page: number) => void;
}) {
  if (total <= pageSize) return null;

  const pageCount = Math.ceil(total / pageSize);
  const safePage = Math.min(Math.max(page, 1), pageCount);
  const startRow = (safePage - 1) * pageSize + 1;
  const endRow = Math.min(safePage * pageSize, total);

  return (
    <div className="mt-4 flex flex-wrap items-center justify-end gap-3 text-sm text-slate-500">
      <span>
        Showing {startRow}-{endRow} of {total}
      </span>
      <div className="inline-flex items-center gap-2">
        <button
          type="button"
          className="rounded-full border border-slate-200 px-4 py-2 font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={safePage === 1}
          onClick={() => onPageChange(safePage - 1)}
        >
          Previous
        </button>
        <span className="rounded-full border border-slate-200 px-3 py-2 font-medium text-slate-600">
          Page {safePage} of {pageCount}
        </span>
        <button
          type="button"
          className="rounded-full border border-slate-200 px-4 py-2 font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={safePage === pageCount}
          onClick={() => onPageChange(safePage + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}

function PaginationRowsControl({
  total,
  page,
  pageSize,
  onPageChange,
}: {
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}) {
  if (total <= pageSize) return null;

  const pageCount = Math.ceil(total / pageSize);
  const currentPage = Math.min(Math.max(page, 1), pageCount);
  const firstVisible = (currentPage - 1) * pageSize + 1;
  const lastVisible = Math.min(currentPage * pageSize, total);

  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-500">
      <span>
        Showing {firstVisible}-{lastVisible} of {total}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="rounded-full border border-slate-200 px-4 py-2 font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage === 1}
        >
          Previous
        </button>
        <span className="font-medium text-slate-600">
          Page {currentPage} of {pageCount}
        </span>
        <button
          type="button"
          className="rounded-full border border-slate-200 px-4 py-2 font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage === pageCount}
        >
          Next
        </button>
      </div>
    </div>
  );
}

export default function PolymarketBotPage() {
  const [state, setState] = useState<PolymarketBotState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [autoDoctorRefreshing, setAutoDoctorRefreshing] = useState(false);
  const [activeCopyTradingTab, setActiveCopyTradingTab] = useState<
    "bullpen" | "polymarket"
  >("bullpen");
  const [activeScreen, setActiveScreen] = useState<
    "main" | "analysis" | "settings"
  >("main");
  const [ec2CommandMenuOpen, setEc2CommandMenuOpen] = useState(false);
  const [ec2Commands, setEc2Commands] = useState(getInitialEc2Commands);
  const [newEc2Command, setNewEc2Command] = useState("");
  const [editingEc2CommandIndex, setEditingEc2CommandIndex] = useState<
    number | null
  >(null);
  const [editingEc2Command, setEditingEc2Command] = useState("");
  const [lastSettledBalance, setLastSettledBalance] =
    useState<PolymarketBalanceState | null>(null);
  const [lastDoctorPassAt, setLastDoctorPassAt] = useState<number | null>(null);
  const [lastStateRefreshAt, setLastStateRefreshAt] = useState<number>(() =>
    Date.now(),
  );
  useEffect(() => {
    try {
      window.localStorage.setItem(
        EC2_COMMANDS_STORAGE_KEY,
        JSON.stringify(ec2Commands),
      );
    } catch (error) {
      console.warn("Unable to save EC2 commands", error);
    }
  }, [ec2Commands]);

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
  const [manualNetWorthDrafts, setManualNetWorthDrafts] = useState<
    Record<string, string>
  >({});
  const [selectedCopiedEvent, setSelectedCopiedEvent] =
    useState<CopiedEventGroup | null>(null);
  const [selectedFailedCopiedEvent, setSelectedFailedCopiedEvent] =
    useState<CopiedEventGroup | null>(null);
  const [selectedAnalyzedTrader, setSelectedAnalyzedTrader] =
    useState<CopiedTraderAnalysisRow | null>(null);
  const [selectedNetWorthTrader, setSelectedNetWorthTrader] =
    useState<CopiedTraderAnalysisRow | null>(null);
  const [pastTradesTab, setPastTradesTab] = useState<"won" | "lost">("won");
  const [wonPastTradesPage, setWonPastTradesPage] = useState(1);
  const [lostPastTradesPage, setLostPastTradesPage] = useState(1);
  const [copiedPositionsTab, setCopiedPositionsTab] = useState<
    "positions" | "history"
  >("positions");
  const [copiedPositionStatus, setCopiedPositionStatus] = useState<
    "active" | "closed"
  >("active");
  const [copiedPositionPnlFilter, setCopiedPositionPnlFilter] =
    useState<CopiedPositionPnlFilter>("all");
  const [copiedHistoryFilter, setCopiedHistoryFilter] =
    useState<CopiedHistoryFilter>("all");
  const [redeemedTradesTab, setRedeemedTradesTab] = useState<
    "claim-pending" | "redeemed"
  >("claim-pending");
  const [copiedSort, setCopiedSort] = useState<CopiedSortState>({
    column: "copiedAt",
    direction: "desc",
  });
  const [liveTradeLimitDraft, setLiveTradeLimitDraft] = useState("");
  const [traderInvestedThresholdDraft, setTraderInvestedThresholdDraft] =
    useState("");
  const [maxLiveExposureDraft, setMaxLiveExposureDraft] = useState("");
  const [copiedPage, setCopiedPage] = useState(1);
  const [copiedTraderAnalysisPage, setCopiedTraderAnalysisPage] = useState(1);
  const [copiedSearchQuery, setCopiedSearchQuery] = useState("");
  const [skippedBreakupOpen, setSkippedBreakupOpen] = useState(false);
  const [pendingActionElapsedSeconds, setPendingActionElapsedSeconds] =
    useState(0);
  const lastMutationAt = useRef(0);
  const actionInFlight = useRef(false);
  const doctorAutoRefreshInFlight = useRef(false);
  const lastDoctorAutoRefreshAt = useRef(0);
  const balanceAutoRefreshInFlight = useRef(false);
  const lastBalanceAutoRefreshAt = useRef(0);
  const deferredCopiedSearchQuery = useDeferredValue(copiedSearchQuery);

  useEffect(() => {
    if (!pendingAction) return;

    const startedAt = Date.now();
    const interval = window.setInterval(() => {
      setPendingActionElapsedSeconds(
        Math.floor((Date.now() - startedAt) / 1000),
      );
    }, 1000);

    return () => window.clearInterval(interval);
  }, [pendingAction]);

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
        const receivedAt = Date.now();
        setState(nextState);
        setLastStateRefreshAt(receivedAt);
        if (nextState.live.doctor.ok) {
          setLastDoctorPassAt(receivedAt);
        }
        if (isUsableBullpenBalance(nextState.live.balance)) {
          setLastSettledBalance((previous) =>
            mergeBullpenBalanceSnapshot(previous, nextState.live.balance),
          );
        }
        setAccountDrafts((current) => {
          let changed = false;
          const next = { ...current };
          for (const account of nextState.tracked_accounts) {
            if (next[account.id]) continue;
            changed = true;
            next[account.id] = {
              target: account.target,
              threshold_percent: account.threshold_percent,
              net_worth_usd: account.net_worth_usd,
              copy_trade_usd: account.copy_trade_usd,
              enabled: account.enabled,
            };
          }
          return changed ? next : current;
        });
        setManualNetWorthDrafts((current) => {
          let changed = false;
          const next = { ...current };
          for (const account of nextState.tracked_accounts) {
            if (next[account.id] !== undefined) continue;
            changed = true;
            next[account.id] =
              account.net_worth_usd > 0 ? String(account.net_worth_usd) : "";
          }
          return changed ? next : current;
        });
        setLiveTradeLimitDraft(
          String(nextState.config.max_live_trades_per_day),
        );
        setTraderInvestedThresholdDraft(
          String(nextState.config.trader_invested_threshold_usd),
        );
        setMaxLiveExposureDraft(
          String(nextState.config.max_live_exposure_per_market),
        );
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
      if (document.visibilityState === "hidden") return;
      void load();
    }, STATE_REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!state) return;
    if (pendingAction !== null || actionInFlight.current) return;
    if (state.live.doctor.ok) return;
    if (!isBullpenLoginRequired(state.live.doctor.message, null)) return;

    const now = Date.now();
    if (doctorAutoRefreshInFlight.current) return;
    if (now - lastDoctorAutoRefreshAt.current < STATE_REFRESH_INTERVAL_MS) return;

    doctorAutoRefreshInFlight.current = true;
    lastDoctorAutoRefreshAt.current = now;
    setAutoDoctorRefreshing(true);

    apiService
      .polymarketLiveDoctor()
      .then((nextState) => {
        lastMutationAt.current = Date.now();
        const receivedAt = Date.now();
        setState(nextState);
        setLastStateRefreshAt(receivedAt);
        if (nextState.live.doctor.ok) {
          setLastDoctorPassAt(receivedAt);
        }
        if (isUsableBullpenBalance(nextState.live.balance)) {
          setLastSettledBalance((previous) =>
            mergeBullpenBalanceSnapshot(previous, nextState.live.balance),
          );
        }
      })
      .catch((doctorError) => {
        setActionError(normalizeError(doctorError));
      })
      .finally(() => {
        doctorAutoRefreshInFlight.current = false;
        setAutoDoctorRefreshing(false);
      });
  }, [pendingAction, state]);

  useEffect(() => {
    if (!state) return;
    if (pendingAction !== null || actionInFlight.current) return;
    if (isUsableBullpenBalance(state.live.balance)) return;
    if (
      !isBullpenBalanceUnrefreshed(
        state.live.balance.message,
        state.live.balance.status,
      )
    ) {
      return;
    }
    if (
      isBullpenLoginRequired(
        state.live.balance.message,
        state.live.balance.status,
      ) &&
      !hasActiveBullpenDoctorSession(
        state.live.doctor,
        state.live.doctor.bullpen_jwt_seconds_remaining,
      )
    ) {
      return;
    }

    const now = Date.now();
    if (balanceAutoRefreshInFlight.current) return;
    if (now - lastBalanceAutoRefreshAt.current < STATE_REFRESH_INTERVAL_MS) return;

    balanceAutoRefreshInFlight.current = true;
    actionInFlight.current = true;
    lastBalanceAutoRefreshAt.current = now;
    lastMutationAt.current = now;

    apiService
      .polymarketLiveBalanceRefresh()
      .then((nextState) => {
        lastMutationAt.current = Date.now();
        const receivedAt = Date.now();
        setState(nextState);
        setLastStateRefreshAt(receivedAt);
        if (nextState.live.doctor.ok) {
          setLastDoctorPassAt(receivedAt);
        }
        if (isUsableBullpenBalance(nextState.live.balance)) {
          setLastSettledBalance((previous) =>
            mergeBullpenBalanceSnapshot(previous, nextState.live.balance),
          );
        }
      })
      .catch((balanceError) => {
        setActionError(normalizeError(balanceError));
      })
      .finally(() => {
        balanceAutoRefreshInFlight.current = false;
        actionInFlight.current = false;
      });
  }, [pendingAction, state]);

  async function runAction(
    label: string,
    action: () => Promise<PolymarketBotState>,
  ) {
    actionInFlight.current = true;
    lastMutationAt.current = Date.now();
    setPendingAction(label);
    setPendingActionElapsedSeconds(0);
    setActionError(null);
    try {
      let nextState = await action();

      if (label === "redeem") {
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
        nextState = await apiService.polymarketState();
      }

      lastMutationAt.current = Date.now();
      const receivedAt = Date.now();
      setState(nextState);
      setLastStateRefreshAt(receivedAt);
      if (nextState.live.doctor.ok) {
        setLastDoctorPassAt(receivedAt);
      }
      if (isUsableBullpenBalance(nextState.live.balance)) {
        setLastSettledBalance((previous) =>
          mergeBullpenBalanceSnapshot(previous, nextState.live.balance),
        );
      }
      setLiveTradeLimitDraft(String(nextState.config.max_live_trades_per_day));
      setTraderInvestedThresholdDraft(
        String(nextState.config.trader_invested_threshold_usd),
      );
      setMaxLiveExposureDraft(String(nextState.config.max_live_exposure_per_market));
    } catch (runError) {
      setActionError(normalizeError(runError));
    } finally {
      actionInFlight.current = false;
      setPendingAction(null);
      setPendingActionElapsedSeconds(0);
    }
  }

  function handleNetWorthRefresh(trader: CopiedTraderAnalysisRow) {
    if (!trader.accountId) return;
    void runAction(`net-worth-${trader.accountId}`, () =>
      apiService.polymarketRefreshTrackedAccountNetWorth(trader.accountId!),
    ).then(() => setSelectedNetWorthTrader(null));
  }

  function handleDeleteEc2Command(index: number) {
    setEc2Commands((commands) =>
      commands.filter((_, itemIndex) => itemIndex !== index),
    );
    setEditingEc2CommandIndex((current) => {
      if (current == null) return null;
      if (current === index) {
        setEditingEc2Command("");
        return null;
      }
      return current > index ? current - 1 : current;
    });
  }

  const balanceRefreshDisabled = pendingAction !== null;

  function handleBalanceRefresh() {
    void runAction("balance", () => apiService.polymarketLiveBalanceRefresh());
  }

  function handleRedeemedTradesRefresh() {
    void runAction("redeem-refresh", () =>
      apiService.polymarketLiveBalanceRefresh(),
    );
  }

  function applyTrackedAccountState(nextState: PolymarketBotState) {
    // eslint-disable-next-line react-hooks/purity -- event callback records when the API mutation completed.
    const receivedAt = Date.now();
    setState(nextState);
    setLastStateRefreshAt(receivedAt);
    if (nextState.live.doctor.ok) {
      setLastDoctorPassAt(receivedAt);
    }
    if (isUsableBullpenBalance(nextState.live.balance)) {
      setLastSettledBalance((previous) =>
        mergeBullpenBalanceSnapshot(previous, nextState.live.balance),
      );
    }
    setLiveTradeLimitDraft(String(nextState.config.max_live_trades_per_day));
    setTraderInvestedThresholdDraft(
      String(nextState.config.trader_invested_threshold_usd),
    );
    setMaxLiveExposureDraft(String(nextState.config.max_live_exposure_per_market));
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
    setManualNetWorthDrafts(
      Object.fromEntries(
        nextState.tracked_accounts.map((account) => [
          account.id,
          account.net_worth_usd > 0 ? String(account.net_worth_usd) : "",
        ]),
      ),
    );
  }

  async function saveLiveTradeLimit() {
    const nextLimit = Number.parseInt(liveTradeLimitDraft, 10);
    const nextTraderInvestedThreshold = Number.parseFloat(
      traderInvestedThresholdDraft,
    );
    const nextMaxLiveExposure = Number.parseFloat(maxLiveExposureDraft);
    if (!Number.isFinite(nextLimit) || nextLimit < 1) {
      setActionError("Max live trades per day must be at least 1.");
      return;
    }
    if (
      !Number.isFinite(nextTraderInvestedThreshold) ||
      nextTraderInvestedThreshold < 0
    ) {
      setActionError("Trader invested threshold must be at least $0.");
      return;
    }
    if (!Number.isFinite(nextMaxLiveExposure) || nextMaxLiveExposure <= 0) {
      setActionError("Maximum exposure per event must be greater than $0.");
      return;
    }
    await runAction("update-live-limit", () =>
      apiService.polymarketUpdateLiveLimits({
        max_live_trades_per_day: nextLimit,
        trader_invested_threshold_usd: nextTraderInvestedThreshold,
        max_live_exposure_per_market: nextMaxLiveExposure,
      }),
    );
  }

  function toggleCopiedSort(column: CopiedSortColumn) {
    setCopiedSort((current) =>
      current.column === column
        ? {
            column,
            direction: current.direction === "asc" ? "desc" : "asc",
          }
        : {
            column,
            direction: column === "copiedAt" ? "desc" : "asc",
          },
    );
    setCopiedPage(1);
  }

  async function saveManualNetWorth(trader: CopiedTraderAnalysisRow) {
    const matchingAccount = state
      ? findTrackedAccountForCopiedTrader(trader, state.tracked_accounts)
      : null;
    const draftKey = matchingAccount?.id ?? trader.accountId ?? trader.key;
    const fallbackDraftKey = trader.accountId ?? trader.key;
    const draft =
      manualNetWorthDrafts[draftKey] ??
      manualNetWorthDrafts[fallbackDraftKey] ??
      "";
    const netWorth = Number.parseFloat(draft);
    if (!Number.isFinite(netWorth) || netWorth < 0) {
      setActionError("Manual net worth must be a valid amount of at least $0.");
      return;
    }
    const target = normalizeTrackedAccountTarget(
      trader.traderName || trader.key,
    );
    if (!target) {
      setActionError(
        "Manual net worth needs a trader handle or wallet address.",
      );
      return;
    }
    const busyKey = `net-worth-${draftKey}`;
    setManualNetWorthDrafts((current) => ({
      ...current,
      [draftKey]: String(netWorth),
      [fallbackDraftKey]: String(netWorth),
    }));
    setBusyAccountId(busyKey);
    setActionError(null);
    try {
      const nextState = matchingAccount
        ? await apiService.polymarketUpdateTrackedAccount(matchingAccount.id, {
            net_worth_usd: netWorth,
          })
        : await apiService.polymarketAddTrackedAccount({
            target,
            threshold_percent: 5,
            net_worth_usd: netWorth,
            copy_trade_usd: 1,
            enabled: true,
          });
      applyTrackedAccountState(nextState);
      setManualNetWorthDrafts((current) => ({
        ...current,
        [draftKey]: String(netWorth),
        [fallbackDraftKey]: String(netWorth),
      }));
    } catch (accountError) {
      setActionError(normalizeError(accountError));
    } finally {
      setBusyAccountId(null);
    }
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
    const previousState = state;
    const previousDrafts = accountDrafts;
    setBusyAccountId(accountId);
    setActionError(null);
    setState((current) =>
      current
        ? {
            ...current,
            tracked_accounts: current.tracked_accounts.filter(
              (account) => account.id !== accountId,
            ),
          }
        : current,
    );
    setAccountDrafts((current) => {
      const next = { ...current };
      delete next[accountId];
      return next;
    });
    try {
      const nextState =
        await apiService.polymarketDeleteTrackedAccount(accountId);
      applyTrackedAccountState(nextState);
    } catch (accountError) {
      if (previousState) setState(previousState);
      setAccountDrafts(previousDrafts);
      setActionError(normalizeError(accountError));
    } finally {
      setBusyAccountId(null);
    }
  }

  const thresholdEligibleRecentDecisions = useMemo(
    () =>
      state
        ? state.live.recent_decisions.filter(
            (trade) =>
              !isBelowTrackedNetWorthThreshold(trade, state.tracked_accounts),
          )
        : [],
    [state],
  );
  const bullpenOpenPositionKeys = useMemo(
    () =>
      state
        ? new Set(state.open_positions.map(getBullpenPositionKey))
        : new Set<string>(),
    [state],
  );
  const executedLiveTrades = useMemo(
    () =>
      thresholdEligibleRecentDecisions.filter(
        (trade) =>
          COPIED_ACTIVE_STATUSES.has(trade.status) &&
          bullpenOpenPositionKeys.has(getCopiedTradePositionKey(trade)),
      ),
    [thresholdEligibleRecentDecisions, bullpenOpenPositionKeys],
  );
  const copiedPositionTrades = useMemo(
    () =>
      thresholdEligibleRecentDecisions.filter((trade) =>
        copiedPositionStatus === "active"
          ? COPIED_ACTIVE_STATUSES.has(trade.status) &&
            bullpenOpenPositionKeys.has(getCopiedTradePositionKey(trade))
          : !COPIED_ACTIVE_STATUSES.has(trade.status),
      ),
    [
      thresholdEligibleRecentDecisions,
      copiedPositionStatus,
      bullpenOpenPositionKeys,
    ],
  );
  const copiedHistoryTrades = thresholdEligibleRecentDecisions;
  const copiedFilteredHistoryTrades = useMemo(
    () =>
      copiedHistoryTrades.filter((trade) => {
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
      }),
    [copiedHistoryFilter, copiedHistoryTrades],
  );
  const copiedVisibleTrades =
    copiedPositionsTab === "positions"
      ? copiedPositionTrades
      : copiedFilteredHistoryTrades;
  const normalizedCopiedSearchQuery = useMemo(
    () => deferredCopiedSearchQuery.trim().toLowerCase(),
    [deferredCopiedSearchQuery],
  );
  const copiedEventGroups = useMemo(
    () =>
      buildCopiedEventGroups(copiedVisibleTrades)
        .filter((event) => {
          if (!normalizedCopiedSearchQuery) return true;
          return `${event.marketTitle} ${event.outcome}`
            .toLowerCase()
            .includes(normalizedCopiedSearchQuery);
        })
        .filter((event) => {
          if (
            copiedPositionsTab !== "positions" ||
            copiedPositionStatus !== "active" ||
            copiedPositionPnlFilter === "all"
          ) {
            return true;
          }
          return copiedPositionPnlFilter === "winning"
            ? event.currentPnl > 0
            : event.currentPnl < 0;
        })
        .sort((left, right) =>
          compareCopiedEventGroups(left, right, copiedSort),
        ),
    [
      copiedPositionPnlFilter,
      copiedPositionStatus,
      copiedPositionsTab,
      copiedSort,
      copiedVisibleTrades,
      normalizedCopiedSearchQuery,
    ],
  );
  const activeCopiedEventGroups = useMemo(
    () => buildCopiedEventGroups(executedLiveTrades),
    [executedLiveTrades],
  );
  const copiedPositionEventCount = useMemo(
    () => buildCopiedEventGroups(copiedPositionTrades).length,
    [copiedPositionTrades],
  );
  const redeemedTradeRows = useMemo(
    () => (state ? buildRedeemedTradeRows(state) : []),
    [state],
  );
  const claimPendingTradeRows = useMemo(
    () => redeemedTradeRows.filter((row) => row.status === "claimable"),
    [redeemedTradeRows],
  );
  const previouslyRedeemedTradeRows = useMemo(
    () => redeemedTradeRows.filter((row) => row.status !== "claimable"),
    [redeemedTradeRows],
  );
  const analysisTradeRows = useMemo(
    () =>
      state && activeScreen === "analysis" ? buildAnalysisTradeRows(state) : [],
    [activeScreen, state],
  );
  const wonAnalysisTrades = useMemo(
    () => analysisTradeRows.filter((trade) => trade.pnl >= 0),
    [analysisTradeRows],
  );
  const lostAnalysisTrades = useMemo(
    () => analysisTradeRows.filter((trade) => trade.pnl < 0),
    [analysisTradeRows],
  );
  const copiedTraderAnalysisRows = useMemo(
    () =>
      state && activeScreen === "analysis"
        ? buildCopiedTraderAnalysisRows(
            analysisTradeRows,
            state.tracked_accounts,
          )
        : [],
    [activeScreen, analysisTradeRows, state],
  );

  if (loading && !state) {
    return <PolymarketBotPageSkeleton />;
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
  const pendingActionDetail = getPendingActionDetail(pendingAction);
  const liveParsingStatusMessage = getLiveParsingStatusMessage(state);
  const skippedBreakup = getSkippedBreakup(state);
  const hasRecentDoctorPass =
    lastDoctorPassAt !== null &&
    lastStateRefreshAt - lastDoctorPassAt < DOCTOR_PASS_STICKY_MS;
  const rawDoctorLoginRequired = isBullpenLoginRequired(
    state.live.doctor.message,
    null,
  );
  const bullpenSessionExpiresAt = state.live.doctor.bullpen_jwt_expires_at;
  const bullpenSessionSecondsRemaining = bullpenSessionExpiresAt
    ? Math.max(
        0,
        Math.ceil(
          (new Date(bullpenSessionExpiresAt).getTime() - lastStateRefreshAt) /
            1000,
        ),
      )
    : state.live.doctor.bullpen_jwt_seconds_remaining;
  const bullpenSessionObservedAt = state.live.doctor.bullpen_login_observed_at;
  const suppressStaleDoctorLogin =
    hasRecentDoctorPass && rawDoctorLoginRequired;
  const liveCriticalBanner = getLiveCriticalBanner(state, {
    suppressStaleDoctorLogin,
  });
  const doctorLoginRequired =
    rawDoctorLoginRequired && !suppressStaleDoctorLogin;
  const bullpenDoctorSessionActive = hasActiveBullpenDoctorSession(
    state.live.doctor,
    bullpenSessionSecondsRemaining,
  );
  const pendingActionLabel = getActionLabel(pendingAction);

  const visibleBalance =
    state.live.balance.status === "loading" && lastSettledBalance
      ? lastSettledBalance
      : mergeBullpenBalanceSnapshot(lastSettledBalance, state.live.balance);
  const hasUsableVisibleBalance = isUsableBullpenBalance(visibleBalance);
  const balanceStatusDetail = [
    `Status: ${state.live.balance.status}`,
    state.live.balance.checked_at
      ? `Last checked: ${formatTs(state.live.balance.checked_at)}`
      : null,
    state.live.balance.next_refresh_at
      ? `Next refresh: ${formatTs(state.live.balance.next_refresh_at)}`
      : null,
    state.live.balance.status === "loading" && lastSettledBalance
      ? "Showing last settled Bullpen values while the backend refresh is in progress."
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const bullpenAccountValueUsd = hasUsableVisibleBalance
    ? (visibleBalance.account_value_usd ??
      parseAccountValueUsdFromBalanceMessage(visibleBalance.message))
    : null;
  const bullpenCashUsd = hasUsableVisibleBalance
    ? (visibleBalance.available_balance_usd ?? null)
    : null;
  const bullpenPnlUsd = hasUsableVisibleBalance
    ? (visibleBalance.pnl_usd ?? null)
    : null;
  const bullpenUpnlUsd = hasUsableVisibleBalance
    ? (visibleBalance.upnl_usd ?? null)
    : null;
  const bullpenValuesUpdatedAt = formatTs(visibleBalance.checked_at);
  const bullpenBalanceUnrefreshed = isBullpenBalanceUnrefreshed(
    visibleBalance.message,
    visibleBalance.status,
  );
  const balanceLoginRequired = isBullpenLoginRequired(
    visibleBalance.message,
    visibleBalance.status,
  );
  const bullpenLoginRequired =
    doctorLoginRequired ||
    (balanceLoginRequired && !bullpenDoctorSessionActive);
  const balanceLoginMessageSuperseded =
    balanceLoginRequired && bullpenDoctorSessionActive;
  const copiedPageCount = Math.max(
    1,
    Math.ceil(copiedEventGroups.length / TABLE_PAGE_SIZE),
  );
  const safeCopiedPage = Math.min(copiedPage, copiedPageCount);
  const visibleCopiedEventGroups = copiedEventGroups.slice(
    (safeCopiedPage - 1) * TABLE_PAGE_SIZE,
    safeCopiedPage * TABLE_PAGE_SIZE,
  );
  const visibleRedeemedTradeRows =
    redeemedTradesTab === "claim-pending"
      ? claimPendingTradeRows
      : previouslyRedeemedTradeRows;
  const pastAnalysisTrades =
    pastTradesTab === "won" ? wonAnalysisTrades : lostAnalysisTrades;
  const pastTradesPage =
    pastTradesTab === "won" ? wonPastTradesPage : lostPastTradesPage;
  const pastTradesPageCount = Math.max(
    1,
    Math.ceil(pastAnalysisTrades.length / PAST_TRADES_PAGE_SIZE),
  );
  const normalizedPastTradesPage = Math.min(
    pastTradesPage,
    pastTradesPageCount,
  );
  const pastTradesPageStart =
    (normalizedPastTradesPage - 1) * PAST_TRADES_PAGE_SIZE;
  const visiblePastAnalysisTrades = pastAnalysisTrades.slice(
    pastTradesPageStart,
    pastTradesPageStart + PAST_TRADES_PAGE_SIZE,
  );
  const setPastTradesPage =
    pastTradesTab === "won" ? setWonPastTradesPage : setLostPastTradesPage;
  const copiedTraderAnalysisPageCount = Math.max(
    1,
    Math.ceil(
      copiedTraderAnalysisRows.length / COPIED_TRADERS_ANALYSIS_PAGE_SIZE,
    ),
  );
  const safeCopiedTraderAnalysisPage = Math.min(
    copiedTraderAnalysisPage,
    copiedTraderAnalysisPageCount,
  );
  const visibleCopiedTraderAnalysisRows = copiedTraderAnalysisRows.slice(
    (safeCopiedTraderAnalysisPage - 1) * COPIED_TRADERS_ANALYSIS_PAGE_SIZE,
    safeCopiedTraderAnalysisPage * COPIED_TRADERS_ANALYSIS_PAGE_SIZE,
  );
  const claimableRedeemedCount = claimPendingTradeRows.length;
  const redeemStatusMessage =
    pendingAction === "redeem"
      ? getRedeemStatusMessage(
          pendingActionElapsedSeconds,
          claimableRedeemedCount,
        )
      : pendingAction === "redeem-refresh"
        ? `Refreshing Bullpen balance, open positions, and claim/redeem history (${pendingActionElapsedSeconds}s elapsed). The list updates after Bullpen returns the latest wallet data.`
        : claimableRedeemedCount > 0
          ? `${claimableRedeemedCount} resolved winning ${
              claimableRedeemedCount === 1 ? "position is" : "positions are"
            } ready to claim. If you expected fewer, click refresh to fetch Bullpen balance and open positions; closed positions are hidden once the latest fetch is visible.`
          : "No resolved winning positions are currently waiting to be claimed. If the latest fetch is not visible, refresh will show whether Bullpen balance, positions, or history are still loading or unavailable.";
  const copiedPositionsRefreshLabel = formatRefreshInterval(
    STATE_REFRESH_INTERVAL_MS,
  );
  const visibleTrackedTraders = state.tracked_traders;
  const copiedSortHeader = (
    column: CopiedSortColumn,
    label: string,
    description?: string,
  ) => (
    <button
      type="button"
      className="inline-flex items-start gap-1.5 text-left transition hover:text-slate-800"
      onClick={() => toggleCopiedSort(column)}
      aria-label={`Sort copied Bullpen rows by ${label}`}
    >
      <span>
        {label}
        {description ? (
          <span className="mt-1 block text-[10px] normal-case tracking-normal text-slate-400">
            {description}
          </span>
        ) : null}
      </span>
      <SortIcon
        direction={copiedSort.column === column ? copiedSort.direction : null}
      />
    </button>
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
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-lg font-semibold tracking-tight text-slate-950">
              Copy trading Bots
            </h1>
            {liveCriticalBanner ? (
              <div
                className="inline-flex max-w-full items-center gap-2 rounded-full border border-rose-300 bg-rose-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-rose-700 shadow-sm"
                title={liveCriticalBanner}
                role="alert"
              >
                <AlertTriangle
                  className="size-3.5 shrink-0"
                  aria-hidden="true"
                />
                <span className="truncate">{liveCriticalBanner}</span>
              </div>
            ) : null}
          </div>
          <p className="text-sm text-slate-500">{subtitle}</p>
        </div>
        {activeCopyTradingTab === "bullpen" ? (
          <div className="flex flex-wrap gap-2 xl:justify-end">
            <div className="relative inline-flex rounded-full border border-amber-300 bg-amber-50 text-amber-900 shadow-sm transition hover:border-amber-400 hover:bg-amber-100">
              <a
                href={AWS_EC2_TERMINAL_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center rounded-l-full px-5 py-2 text-sm font-semibold"
              >
                Open AWS EC2
                <ExternalLink className="ml-2 size-3.5" aria-hidden="true" />
              </a>
              <button
                type="button"
                className="inline-flex items-center rounded-r-full border-l border-amber-300 px-3 py-2 transition hover:bg-amber-200/60"
                aria-label="Show AWS EC2 commands"
                aria-expanded={ec2CommandMenuOpen}
                onClick={() => setEc2CommandMenuOpen((open) => !open)}
              >
                <Menu className="size-4" aria-hidden="true" />
              </button>
              {ec2CommandMenuOpen ? (
                <div className="absolute right-0 top-full z-30 mt-2 w-80 rounded-2xl border border-slate-200 bg-white p-4 text-left text-slate-950 shadow-xl">
                  <div className="mb-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                      EC2 commands
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      Most-used commands to run after opening the EC2 shell.
                    </p>
                  </div>
                  <div className="space-y-2">
                    {ec2Commands.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-xs text-slate-500">
                        No saved commands yet. Add one below.
                      </div>
                    ) : null}
                    {ec2Commands.map((command, index) => {
                      const isEditing = editingEc2CommandIndex === index;

                      return (
                        <div
                          key={`${command}-${index}`}
                          className="rounded-xl border border-slate-200 bg-slate-50 p-2"
                        >
                          {isEditing ? (
                            <form
                              className="flex gap-2"
                              onSubmit={(event) => {
                                event.preventDefault();
                                const updatedCommand = editingEc2Command.trim();
                                if (!updatedCommand) return;
                                setEc2Commands((commands) =>
                                  commands.map((item, itemIndex) =>
                                    itemIndex === index ? updatedCommand : item,
                                  ),
                                );
                                setEditingEc2CommandIndex(null);
                                setEditingEc2Command("");
                              }}
                            >
                              <input
                                type="text"
                                value={editingEc2Command}
                                onChange={(event) =>
                                  setEditingEc2Command(event.target.value)
                                }
                                aria-label="Edit EC2 command"
                                className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs font-semibold text-slate-900 outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100"
                              />
                              <button
                                type="submit"
                                className="rounded-lg bg-slate-950 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-500 hover:bg-slate-200 hover:text-slate-900"
                                onClick={() => {
                                  setEditingEc2CommandIndex(null);
                                  setEditingEc2Command("");
                                }}
                              >
                                Cancel
                              </button>
                            </form>
                          ) : (
                            <div className="flex items-center gap-2">
                              <code className="min-w-0 flex-1 break-words text-xs font-semibold text-slate-800">
                                {command}
                              </code>
                              <div className="flex shrink-0 items-center gap-1">
                                <button
                                  type="button"
                                  className="rounded-lg p-1.5 text-slate-500 transition hover:bg-white hover:text-slate-950"
                                  aria-label={`Copy command: ${command}`}
                                  title="Copy command"
                                  onClick={() =>
                                    void navigator.clipboard.writeText(command)
                                  }
                                >
                                  <Copy
                                    className="size-3.5"
                                    aria-hidden="true"
                                  />
                                </button>
                                <button
                                  type="button"
                                  className="rounded-lg p-1.5 text-slate-500 transition hover:bg-white hover:text-slate-950"
                                  aria-label={`Edit command: ${command}`}
                                  title="Edit command"
                                  onClick={() => {
                                    setEditingEc2CommandIndex(index);
                                    setEditingEc2Command(command);
                                  }}
                                >
                                  <Edit3
                                    className="size-3.5"
                                    aria-hidden="true"
                                  />
                                </button>
                                <button
                                  type="button"
                                  className="rounded-lg p-1.5 text-slate-500 transition hover:bg-rose-50 hover:text-rose-600"
                                  aria-label={`Delete command: ${command}`}
                                  title="Delete command"
                                  onClick={() => handleDeleteEc2Command(index)}
                                >
                                  <Trash2
                                    className="size-3.5"
                                    aria-hidden="true"
                                  />
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <form
                    className="mt-3 flex gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const command = newEc2Command.trim();
                      if (!command) return;
                      setEc2Commands((commands) => [...commands, command]);
                      setNewEc2Command("");
                    }}
                  >
                    <input
                      type="text"
                      value={newEc2Command}
                      onChange={(event) => setNewEc2Command(event.target.value)}
                      placeholder="Add another command"
                      className="min-w-0 flex-1 rounded-full border border-slate-200 px-3 py-2 text-xs text-slate-900 outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100"
                    />
                    <button
                      type="submit"
                      className="inline-flex items-center gap-1 rounded-full bg-slate-950 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800"
                    >
                      <Plus className="size-3.5" aria-hidden="true" />
                      Add
                    </button>
                  </form>
                </div>
              ) : null}
            </div>
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
              variant={activeScreen === "analysis" ? "default" : "outline"}
              className={
                activeScreen === "analysis"
                  ? "rounded-full bg-slate-950 px-5 text-white hover:bg-slate-800"
                  : "rounded-full border-slate-300 px-5"
              }
              onClick={() => setActiveScreen("analysis")}
            >
              Analysis
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
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2 rounded-[24px] border border-slate-200 bg-white p-1 shadow-sm">
        {[
          { id: "bullpen", label: "Bullpen" },
          { id: "polymarket", label: "Polymarket" },
        ].map((tab) => {
          const isActive = activeCopyTradingTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              className={
                isActive
                  ? "rounded-[18px] bg-slate-950 px-5 py-2 text-sm font-semibold text-white shadow-sm"
                  : "rounded-[18px] px-5 py-2 text-sm font-semibold text-slate-500 transition hover:bg-slate-100 hover:text-slate-950"
              }
              onClick={() =>
                setActiveCopyTradingTab(tab.id as "bullpen" | "polymarket")
              }
              aria-pressed={isActive}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {activeCopyTradingTab === "polymarket" ? (
        <div className="rounded-[28px] border border-dashed border-slate-300 bg-white px-6 py-12 text-center shadow-sm">
          <h2 className="text-xl font-semibold text-slate-950">Polymarket</h2>
          <p className="mt-2 text-sm text-slate-500">
            This tab is intentionally empty and ready for a future Polymarket
            copy-trading workflow.
          </p>
        </div>
      ) : (
        <>
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

          {state.live.doctor.ok && bullpenSessionSecondsRemaining != null ? (
            <div
              className={
                bullpenSessionSecondsRemaining <= 0
                  ? "rounded-[24px] border border-rose-200 bg-rose-50 px-5 py-4 text-sm font-semibold text-rose-950 shadow-sm"
                  : "rounded-[24px] border border-emerald-200 bg-emerald-50 px-5 py-4 text-sm font-semibold text-emerald-950 shadow-sm"
              }
            >
              Bullpen session time remaining:{" "}
              {formatDuration(bullpenSessionSecondsRemaining)}
              {bullpenSessionObservedAt ? (
                <>
                  {" "}
                  since the last login observed at{" "}
                  {new Date(bullpenSessionObservedAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                  .
                </>
              ) : (
                "."
              )}{" "}
              Re-login is expected when the 15-minute JWT window expires.
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
                      The bot cannot refresh balance or place Bullpen-backed
                      real-money trades until the Bullpen session is restored.
                      Current status:{" "}
                      {state.live.doctor.message || visibleBalance.message}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    asChild
                    size="sm"
                    className="rounded-full bg-amber-950 px-5 text-white hover:bg-amber-900"
                  >
                    <a
                      href={AWS_EC2_TERMINAL_URL}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open AWS EC2 Terminal
                      <ExternalLink
                        className="ml-2 size-3.5"
                        aria-hidden="true"
                      />
                    </a>
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="rounded-full border-amber-400 bg-white px-5 text-amber-950 hover:bg-amber-100"
                    disabled={pendingAction !== null || autoDoctorRefreshing}
                    onClick={() =>
                      runAction("doctor", () =>
                        apiService.polymarketLiveDoctor(),
                      )
                    }
                  >
                    {pendingAction === "doctor" || autoDoctorRefreshing ? (
                      <Loader2
                        className="mr-2 size-3.5 animate-spin"
                        aria-hidden="true"
                      />
                    ) : null}
                    Refresh Doctor
                  </Button>
                </div>
              </div>
              <ol className="mt-5 grid gap-3 text-sm font-semibold text-amber-950 md:grid-cols-2 xl:grid-cols-5">
                <li className="rounded-2xl border border-amber-200 bg-white/70 px-4 py-3">
                  <span className="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-amber-200 text-xs font-black">
                    1
                  </span>
                  Open the AWS EC2 terminal for the bot server.
                </li>
                <li className="rounded-2xl border border-amber-200 bg-white/70 px-4 py-3">
                  <span className="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-amber-200 text-xs font-black">
                    2
                  </span>
                  Run{" "}
                  <code className="rounded bg-amber-100 px-1.5 py-0.5">
                    {DEFAULT_SYSTEMD_BULLPEN_LOGIN_COMMAND}
                  </code>
                  {" "}so Bullpen writes the session into the same credential HOME
                  the app reads.
                </li>
                <li className="rounded-2xl border border-amber-200 bg-white/70 px-4 py-3">
                  <span className="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-amber-200 text-xs font-black">
                    3
                  </span>
                  Scan the QR code from your mobile device.
                </li>
                <li className="rounded-2xl border border-amber-200 bg-white/70 px-4 py-3">
                  <span className="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-amber-200 text-xs font-black">
                    4
                  </span>
                  Sign in using{" "}
                  <span className="break-all">tarunindian007@gmail.com</span>.
                </li>
                <li className="rounded-2xl border border-amber-200 bg-white/70 px-4 py-3">
                  <span className="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-amber-200 text-xs font-black">
                    5
                  </span>
                  After login succeeds, wait for auto-refresh or click Refresh
                  Doctor to update the Bullpen login status.
                </li>
              </ol>
            </div>
          ) : null}

          <Card className="overflow-hidden border border-slate-200 bg-gradient-to-br from-slate-950 via-slate-900 to-sky-950 py-0 text-white shadow-xl shadow-slate-950/10">
            <CardContent className="p-5 md:p-6">
              <div className="mb-3 flex justify-end text-xs font-medium text-slate-300">
                Last values update: {bullpenValuesUpdatedAt}
              </div>
              <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-sky-100">
                    <Wallet className="size-3.5" />
                    Bullpen Summary
                  </div>
                  <h2 className="mt-3 text-2xl font-semibold tracking-tight">
                    {formatOptionalMoney(bullpenAccountValueUsd)} account value
                  </h2>
                  <p className="mt-1 text-sm text-slate-300">
                    Cash {formatOptionalMoney(bullpenCashUsd)} · PnL{" "}
                    {formatOptionalMoney(bullpenPnlUsd)}
                    {bullpenUpnlUsd == null
                      ? ""
                      : ` · uPnL ${formatMoney(bullpenUpnlUsd)}`}
                  </p>
                  <p className="mt-1 text-xs text-slate-400">
                    {balanceStatusDetail}
                  </p>
                  {bullpenBalanceUnrefreshed ? (
                    <div className="mt-3 rounded-2xl border border-amber-300/40 bg-amber-400/10 px-4 py-3 text-xs leading-5 text-amber-100">
                      <p className="font-semibold text-amber-50">
                        Balance has not been refreshed because the backend has
                        not completed a successful Bullpen balance check for the
                        current session.
                      </p>
                      <p className="mt-1 text-amber-100/90">
                        {balanceLoginMessageSuperseded
                          ? "Balance refresh is pending or stale, but the latest Bullpen doctor check shows an active login session. Click Refresh Balance to retry without re-login."
                          : `Backend reason: ${
                              visibleBalance.message ||
                              "No balance check result has been returned yet."
                            }`}
                      </p>
                      <p className="mt-1 text-amber-100/90">
                        Click Refresh Balance to ask the backend to refresh now.
                        {balanceLoginMessageSuperseded
                          ? " Re-login is only needed if the doctor check also reports that the Bullpen session expired."
                          : " If the refresh still reports login required, open Bullpen/AWS EC2, run the Bullpen login, then refresh again."}
                      </p>
                    </div>
                  ) : (
                    <p className="mt-1 text-xs text-slate-400">
                      {visibleBalance.message ||
                        "Bullpen balance has not refreshed yet."}
                    </p>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-4 rounded-full border-sky-300/50 bg-sky-300/10 px-5 text-sky-100 hover:border-sky-200 hover:bg-sky-300/20 hover:text-white disabled:border-slate-500 disabled:bg-slate-700 disabled:text-slate-400"
                    disabled={balanceRefreshDisabled}
                    onClick={handleBalanceRefresh}
                  >
                    {pendingAction === "balance" ? (
                      <Loader2
                        className="mr-2 size-3.5 animate-spin"
                        aria-hidden="true"
                      />
                    ) : null}
                    Refresh Balance
                  </Button>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:min-w-[700px] lg:grid-cols-4 xl:grid-cols-5">
                  <div className="rounded-[20px] border border-white/10 bg-white/10 px-4 py-3">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-slate-300">
                      Cash
                    </div>
                    <div className="mt-2 text-xl font-semibold">
                      {formatOptionalMoney(bullpenCashUsd)}
                    </div>
                  </div>
                  <div className="rounded-[20px] border border-white/10 bg-white/10 px-4 py-3">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-slate-300">
                      PnL
                    </div>
                    <div className="mt-2 text-xl font-semibold">
                      {formatOptionalMoney(bullpenPnlUsd)}
                    </div>
                  </div>
                  <div className="rounded-[20px] border border-white/10 bg-white/10 px-4 py-3">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-slate-300">
                      uPnL
                    </div>
                    <div className="mt-2 text-xl font-semibold">
                      {formatOptionalMoney(bullpenUpnlUsd)}
                    </div>
                  </div>
                  <div className="rounded-[20px] border border-white/10 bg-white/10 px-4 py-3">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-slate-300">
                      Active Trades
                    </div>
                    <div className="mt-2 flex items-center gap-2 text-xl font-semibold">
                      <Activity className="size-4 text-sky-300" />
                      {activeCopiedEventGroups.length}
                    </div>
                  </div>
                  <div className="rounded-[20px] border border-white/10 bg-white/10 px-4 py-3">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-slate-300">
                      Live Trades Today
                    </div>
                    <div className="mt-2 text-xl font-semibold">
                      {state.live.live_trades_today}
                    </div>
                  </div>
                  <div className="rounded-[20px] border border-white/10 bg-white/10 px-4 py-3">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-slate-300">
                      Copied Trades
                    </div>
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
              <div className="flex flex-wrap items-start gap-3 rounded-[24px] border border-slate-200 bg-white px-4 py-4 shadow-sm">
                <div className="w-full max-w-md rounded-[22px] border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700 shadow-sm">
                  <div className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Risk guardrails
                  </div>
                  <div className="space-y-3">
                    <label className="grid gap-1 sm:grid-cols-[1fr_8rem] sm:items-center sm:gap-3">
                      <span>
                        <span className="font-medium">Max live trades/day:</span>{" "}
                        <span className="font-semibold text-slate-950">
                          {state.config.max_live_trades_per_day}
                        </span>
                      </span>
                      <input
                        className="h-9 rounded-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-sky-500"
                        type="number"
                        min={1}
                        value={liveTradeLimitDraft}
                        onChange={(event) =>
                          setLiveTradeLimitDraft(event.target.value)
                        }
                        aria-label="Max live trades per day"
                      />
                    </label>
                    <label className="grid gap-1 sm:grid-cols-[1fr_8rem] sm:items-center sm:gap-3">
                      <span>
                        <span className="font-medium">Trader Invested Threshold:</span>{" "}
                        <span className="font-semibold text-slate-950">
                          {formatMoney(state.config.trader_invested_threshold_usd)}
                        </span>
                      </span>
                      <input
                        className="h-9 rounded-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-sky-500"
                        type="number"
                        min={0}
                        step="0.01"
                        value={traderInvestedThresholdDraft}
                        onChange={(event) =>
                          setTraderInvestedThresholdDraft(event.target.value)
                        }
                        aria-label="Trader invested threshold"
                      />
                    </label>
                    <label className="grid gap-1 sm:grid-cols-[1fr_8rem] sm:items-center sm:gap-3">
                      <span>
                        <span className="font-medium">Maximum exposure per Event:</span>{" "}
                        <span className="font-semibold text-slate-950">
                          {formatMoney(state.config.max_live_exposure_per_market)}
                        </span>
                      </span>
                      <input
                        className="h-9 rounded-full border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none focus:border-sky-500"
                        type="number"
                        min={0.01}
                        step="0.01"
                        value={maxLiveExposureDraft}
                        onChange={(event) =>
                          setMaxLiveExposureDraft(event.target.value)
                        }
                        aria-label="Maximum exposure per event"
                      />
                    </label>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-4 rounded-full border-slate-300"
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
                    <button
                      type="button"
                      className="inline-flex size-5 items-center justify-center rounded-full border border-sky-300 bg-white text-sky-700 transition hover:border-sky-500 hover:bg-sky-100 focus:outline-none focus:ring-2 focus:ring-sky-400"
                      aria-label="Open skipped detail breakup"
                      title="Skipped detail breakup"
                      onClick={() => setSkippedBreakupOpen(true)}
                    >
                      <Info className="size-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              </div>

              {stoppedWarning ? (
                <div className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900">
                  {stoppedWarning}
                </div>
              ) : null}

              <Card
                className="border border-slate-200 bg-white py-6"
                style={DEFERRED_CARD_STYLE}
              >
                <CardHeader className="pb-0">
                  <CardTitle className="text-base tracking-[0.18em] text-slate-950">
                    Copied Bullpen Positions
                  </CardTitle>
                  <CardDescription>
                    Aggregated by exact Event, outcome, and side so repeated $1
                    copies from multiple traders display as one Bullpen
                    exposure.
                  </CardDescription>
                  <p className="text-xs text-slate-500">
                    This table only shows positions created from Bullpen x
                    Polymarket decisions saved by this bot. Positions opened
                    elsewhere in the shared Bullpen wallet do not appear here.
                  </p>
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
                        onClick={() => {
                          setCopiedPositionsTab("positions");
                          setCopiedPage(1);
                        }}
                      >
                        Positions ({copiedPositionEventCount})
                      </button>
                      <button
                        type="button"
                        className={`flex-1 rounded-xl px-4 py-2 text-sm font-medium transition sm:flex-none ${
                          copiedPositionsTab === "history"
                            ? "bg-white text-slate-950 shadow-sm ring-1 ring-slate-200"
                            : "text-slate-500 hover:text-slate-900"
                        }`}
                        onClick={() => {
                          setCopiedPositionsTab("history");
                          setCopiedPage(1);
                        }}
                      >
                        History ({copiedHistoryTrades.length})
                      </button>
                    </div>

                    <label className="relative w-full sm:max-w-sm lg:ml-auto">
                      <span className="sr-only">
                        Search copied positions by event or outcome
                      </span>
                      <Search
                        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400"
                        aria-hidden="true"
                      />
                      <input
                        type="search"
                        value={copiedSearchQuery}
                        onChange={(event) => {
                          setCopiedSearchQuery(event.target.value);
                          setCopiedPage(1);
                        }}
                        placeholder="Search event or outcome"
                        className="h-11 w-full rounded-2xl border border-slate-200 bg-white pl-10 pr-3 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
                      />
                    </label>

                    {copiedPositionsTab === "positions" ? (
                      <div className="inline-flex w-full rounded-2xl border border-slate-200 bg-white p-1 sm:w-auto">
                        <button
                          type="button"
                          className={`flex-1 rounded-xl px-4 py-2 text-sm font-medium transition sm:flex-none ${
                            copiedPositionStatus === "active"
                              ? "bg-slate-950 text-white shadow-sm"
                              : "text-slate-500 hover:text-slate-900"
                          }`}
                          onClick={() => {
                            setCopiedPositionStatus("active");
                            setCopiedPage(1);
                          }}
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
                          onClick={() => {
                            setCopiedPositionStatus("closed");
                            setCopiedPage(1);
                          }}
                        >
                          Closed
                        </button>
                      </div>
                    ) : null}
                  </div>

                  {copiedPositionsTab === "positions" &&
                  copiedPositionStatus === "active" ? (
                    <div
                      className="mb-4 flex flex-wrap gap-2"
                      role="tablist"
                      aria-label="Active copied positions profit and loss filters"
                    >
                      {COPIED_POSITION_PNL_FILTER_OPTIONS.map((option) => (
                        <button
                          key={option.key}
                          type="button"
                          role="tab"
                          aria-selected={copiedPositionPnlFilter === option.key}
                          className={`rounded-xl border px-4 py-2 text-sm font-medium transition ${
                            copiedPositionPnlFilter === option.key
                              ? "border-slate-950 bg-slate-950 text-white shadow-sm"
                              : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-950"
                          }`}
                          onClick={() => {
                            setCopiedPositionPnlFilter(option.key);
                            setCopiedPage(1);
                          }}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  ) : null}

                  {copiedPositionsTab === "history" ? (
                    <div className="mb-4 flex flex-wrap gap-2">
                      {COPIED_HISTORY_FILTER_OPTIONS.map((option) => (
                        <button
                          key={option.key}
                          type="button"
                          className={`rounded-xl border px-4 py-2 text-sm font-medium transition ${
                            copiedHistoryFilter === option.key
                              ? "border-slate-950 bg-slate-950 text-white shadow-sm"
                              : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-950"
                          }`}
                          onClick={() => {
                            setCopiedHistoryFilter(option.key);
                            setCopiedPage(1);
                          }}
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
                          <th className="px-4 py-3">
                            {copiedSortHeader("copiedAt", "Copied At")}
                          </th>
                          <th className="px-4 py-3">
                            {copiedSortHeader("trader", "Trader")}
                          </th>
                          <th className="px-4 py-3">
                            {copiedSortHeader("event", "Event")}
                          </th>
                          <th className="px-4 py-3">
                            {copiedSortHeader("eventEnd", "Event Ends")}
                          </th>
                          <th className="px-4 py-3">
                            {copiedSortHeader("side", "Side")}
                          </th>
                          <th className="px-4 py-3">
                            {copiedSortHeader("outcome", "Outcome")}
                          </th>
                          <th className="px-4 py-3">
                            {copiedSortHeader("amount", "Amount")}
                          </th>
                          {copiedPositionsTab === "positions" &&
                          copiedPositionStatus === "active" ? (
                            <th className="px-4 py-3">
                              {copiedSortHeader(
                                "currentPnl",
                                "Current PnL",
                                `refreshes every ${copiedPositionsRefreshLabel}`,
                              )}
                            </th>
                          ) : null}
                          <th className="px-4 py-3">
                            {copiedSortHeader("price", "Price bought")}
                          </th>
                          <th className="px-4 py-3">
                            {copiedSortHeader("latestPrice", "Latest price")}
                          </th>
                          <th className="px-4 py-3">
                            {copiedSortHeader("pnl", "PnL")}
                          </th>
                          <th className="px-4 py-3">
                            {copiedSortHeader("status", "Status")}
                          </th>
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
                                  ? 12
                                  : 11
                              }
                            >
                              {normalizedCopiedSearchQuery
                                ? "No copied Bullpen rows match this search."
                                : "No copied Bullpen rows for this tab yet."}
                            </td>
                          </tr>
                        ) : (
                          visibleCopiedEventGroups.map((event) => {
                            const hasMultipleTraders = event.traders.length > 1;
                            const failedTrades =
                              getCopiedEventFailureTrades(event);
                            const failureSummary =
                              getCopiedEventFailureSummary(event);
                            return (
                              <tr key={event.key} className="align-top">
                                <td className="px-4 py-3 text-slate-700">
                                  {formatTs(event.copiedAt)}
                                </td>
                                <td className="px-4 py-3 text-slate-700">
                                  {hasMultipleTraders ? (
                                    <button
                                      className="font-medium text-sky-700 underline underline-offset-2"
                                      onClick={() =>
                                        setSelectedCopiedEvent(event)
                                      }
                                    >
                                      multiple ({event.traders.length})
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      className="font-medium text-sky-700 underline underline-offset-2 hover:text-sky-900"
                                      onClick={() =>
                                        setSelectedCopiedEvent(event)
                                      }
                                    >
                                      {getTraderDisplayName(event.traders[0])}
                                    </button>
                                  )}
                                </td>
                                <td className="px-4 py-3 text-slate-700">
                                  <div className="flex items-start gap-2">
                                    <div>
                                      <div className="font-medium text-slate-950">
                                        {event.marketTitle}
                                      </div>
                                      <div className="mt-1 text-xs text-slate-500">
                                        {event.marketId}
                                      </div>
                                    </div>
                                    <button
                                      className="mt-0.5 rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                                      aria-label={`Show copied traders for ${event.marketTitle}`}
                                      onClick={() =>
                                        setSelectedCopiedEvent(event)
                                      }
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
                                <td className="px-4 py-3 font-semibold text-slate-800">
                                  {event.side}
                                </td>
                                <td className="px-4 py-3 text-slate-700">
                                  {event.outcome}
                                </td>
                                <td className="px-4 py-3 text-slate-700">
                                  {formatMoney(event.amount)}
                                </td>
                                {copiedPositionsTab === "positions" &&
                                copiedPositionStatus === "active" ? (
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
                                <td className="px-4 py-3 text-slate-700">
                                  {formatMoney(event.averagePrice, 4)}
                                </td>
                                <td className="px-4 py-3 text-slate-700">
                                  {formatMoney(event.currentPrice, 4)}
                                </td>
                                <td
                                  className={`px-4 py-3 font-semibold ${
                                    event.currentPrice - event.averagePrice >= 0
                                      ? "text-emerald-600"
                                      : "text-rose-600"
                                  }`}
                                >
                                  {formatMoney(
                                    event.currentPrice - event.averagePrice,
                                    4,
                                  )}
                                </td>
                                <td className="px-4 py-3 text-slate-700">
                                  {failureSummary ? (
                                    <div className="flex max-w-[18rem] items-start gap-2">
                                      <span className="leading-5 text-rose-700">
                                        failed ({failureSummary})
                                      </span>
                                      <button
                                        type="button"
                                        className="mt-0.5 rounded-full p-1 text-rose-500 transition hover:bg-rose-50 hover:text-rose-700 focus:outline-none focus:ring-2 focus:ring-rose-300"
                                        aria-label={`Show failure details for ${event.marketTitle}`}
                                        onClick={() =>
                                          setSelectedFailedCopiedEvent(event)
                                        }
                                      >
                                        <Info className="size-4" />
                                      </button>
                                      {failedTrades.length > 1 ? (
                                        <span className="mt-0.5 rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700">
                                          {failedTrades.length}
                                        </span>
                                      ) : null}
                                    </div>
                                  ) : copiedPositionsTab === "positions" &&
                                    copiedPositionStatus === "closed" ? (
                                    getCopiedEventStatus(event)
                                  ) : (
                                    event.status
                                  )}
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                  <TablePaginationControl
                    total={copiedEventGroups.length}
                    page={safeCopiedPage}
                    onPageChange={setCopiedPage}
                  />
                </CardContent>
              </Card>

              <Card
                className="border border-slate-200 bg-white py-6"
                style={DEFERRED_CARD_STYLE}
              >
                <CardHeader className="pb-0">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <CardTitle className="text-base tracking-[0.18em] text-slate-950">
                        Redeemed Trades
                      </CardTitle>
                      <CardDescription className="mt-2">
                        Bullpen trades completed through redeem today plus
                        resolved winning positions still available to claim,
                        with timestamp, profit and loss, execution price, and
                        market details.
                      </CardDescription>
                    </div>
                    <div className="flex max-w-sm flex-col items-start gap-2 sm:items-end">
                      <div className="flex items-center gap-2 self-start sm:self-end">
                        <Button
                          size="sm"
                          className="rounded-full bg-emerald-600 px-4 text-white hover:bg-emerald-700"
                          disabled={pendingAction !== null}
                          aria-label="Claim all available Bullpen positions now"
                          onClick={() =>
                            runAction("redeem", () =>
                              apiService.polymarketLiveRedeem(),
                            )
                          }
                        >
                          {pendingAction === "redeem"
                            ? "Claiming…"
                            : "Claim Now"}
                        </Button>
                        <Button
                          type="button"
                          size="icon"
                          variant="outline"
                          className="size-9 rounded-full border-emerald-200 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800"
                          disabled={pendingAction !== null}
                          aria-label="Refresh current Bullpen claim and redeem status"
                          title="Refresh claim/redeem status"
                          onClick={handleRedeemedTradesRefresh}
                        >
                          <RefreshCw
                            className={`size-4 ${
                              pendingAction === "redeem-refresh"
                                ? "animate-spin"
                                : ""
                            }`}
                            aria-hidden="true"
                          />
                        </Button>
                      </div>
                      <div
                        className="flex items-start gap-2 text-left text-xs leading-5 text-slate-500 sm:text-right"
                        aria-live="polite"
                      >
                        {pendingAction === "redeem" ? (
                          <>
                            <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-emerald-600 sm:hidden" />
                            <span>
                              {redeemStatusMessage} The Redeemed Trades table
                              will refresh automatically when the claim
                              finishes.
                            </span>
                          </>
                        ) : pendingAction === "redeem-refresh" ? (
                          <>
                            <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-emerald-600 sm:hidden" />
                            <span>{redeemStatusMessage}</span>
                          </>
                        ) : (
                          <span>{redeemStatusMessage}</span>
                        )}
                      </div>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-4">
                  <div
                    className="mb-4 flex flex-wrap gap-2"
                    role="tablist"
                    aria-label="Redeemed trades views"
                  >
                    {[
                      {
                        key: "claim-pending" as const,
                        label: "Claim Pending",
                        count: claimPendingTradeRows.length,
                      },
                      {
                        key: "redeemed" as const,
                        label: "Redeemed",
                        count: previouslyRedeemedTradeRows.length,
                      },
                    ].map((tab) => {
                      const isActive = redeemedTradesTab === tab.key;
                      return (
                        <button
                          key={tab.key}
                          type="button"
                          role="tab"
                          aria-selected={isActive}
                          className={`rounded-full border px-4 py-2 text-sm font-semibold transition ${
                            isActive
                              ? "border-emerald-600 bg-emerald-600 text-white shadow-sm"
                              : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50"
                          }`}
                          onClick={() => setRedeemedTradesTab(tab.key)}
                        >
                          {tab.label}
                          <span
                            className={`ml-2 rounded-full px-2 py-0.5 text-xs ${
                              isActive
                                ? "bg-white/20 text-white"
                                : "bg-slate-100 text-slate-500"
                            }`}
                          >
                            {tab.count}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="overflow-x-auto rounded-[24px] border border-slate-200 bg-white shadow-sm">
                    <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
                      <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                        <tr>
                          <th className="px-4 py-3">
                            {redeemedTradesTab === "claim-pending"
                              ? "Claimable At"
                              : "Redeemed At"}
                          </th>
                          <th className="px-4 py-3">Event</th>
                          <th className="px-4 py-3">Outcome</th>
                          <th className="px-4 py-3">Side</th>
                          <th className="px-4 py-3">Amount</th>
                          <th className="px-4 py-3">Shares</th>
                          <th className="px-4 py-3">Price</th>
                          <th className="px-4 py-3">Profit / Loss</th>
                          <th className="px-4 py-3">Status</th>
                          <th className="px-4 py-3">Details</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {visibleRedeemedTradeRows.length === 0 ? (
                          <tr>
                            <td
                              className="px-4 py-6 text-sm text-slate-500"
                              colSpan={10}
                            >
                              {redeemedTradesTab === "claim-pending"
                                ? "No resolved winning positions are currently available to claim."
                                : "No previously redeemed trades are visible yet."}
                            </td>
                          </tr>
                        ) : (
                          visibleRedeemedTradeRows.map((trade) => (
                            <tr key={trade.key} className="align-top">
                              <td className="px-4 py-3 text-slate-700">
                                {formatTs(trade.timestamp)}
                              </td>
                              <td className="px-4 py-3 text-slate-700">
                                <div className="font-medium text-slate-950">
                                  {trade.marketTitle}
                                </div>
                                <div className="mt-1 text-xs text-slate-500">
                                  {trade.marketId}
                                </div>
                              </td>
                              <td className="px-4 py-3 text-slate-700">
                                {trade.outcome}
                              </td>
                              <td className="px-4 py-3 font-semibold text-slate-800">
                                {trade.side}
                              </td>
                              <td className="px-4 py-3 text-slate-700">
                                {formatMoney(trade.amount)}
                              </td>
                              <td className="px-4 py-3 text-slate-700">
                                {trade.shares.toFixed(4)}
                              </td>
                              <td className="px-4 py-3 text-slate-700">
                                {formatMoney(trade.price, 4)}
                              </td>
                              <td
                                className={`px-4 py-3 font-semibold ${
                                  trade.profitLoss >= 0
                                    ? "text-emerald-600"
                                    : "text-rose-600"
                                }`}
                              >
                                {formatMoney(trade.profitLoss)}
                              </td>
                              <td className="px-4 py-3 text-slate-700">
                                <span className="rounded-full bg-emerald-50 px-2 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-emerald-700">
                                  {trade.status}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-slate-700">
                                <div className="max-w-[18rem]">
                                  <div>{trade.source}</div>
                                  <div className="mt-1 text-xs text-slate-500">
                                    {trade.detail}
                                  </div>
                                </div>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>

              <Card
                className="border border-slate-200 bg-white py-6"
                style={DEFERRED_CARD_STYLE}
              >
                <CardHeader className="pb-0">
                  <CardTitle className="text-base tracking-[0.18em] text-slate-950">
                    Top Tracked Traders
                  </CardTitle>
                  <CardDescription>
                    Tracked public trader identities selected for copy-read
                    monitoring. Legacy manually added handle-only rows are
                    hidden here; manage manual accounts from Settings.
                  </CardDescription>
                </CardHeader>
                <CardContent className="pt-4">
                  <TrackedTradersTable
                    traders={visibleTrackedTraders}
                    decisions={state.live.recent_decisions}
                    paperTrades={state.trade_history}
                  />
                </CardContent>
              </Card>

              <Card
                className="border border-slate-200 bg-white py-6"
                style={DEFERRED_CARD_STYLE}
              >
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
                        state.recent_activity.map((entry, index) => (
                          <div
                            key={`${entry.timestamp}-${index}-${entry.message}`}
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
          ) : activeScreen === "analysis" ? (
            <>
              <Card
                className="border border-slate-200 bg-white py-6"
                style={DEFERRED_CARD_STYLE}
              >
                <CardHeader className="pb-0">
                  <CardTitle className="text-base tracking-[0.18em] text-slate-950">
                    Past Trades
                  </CardTitle>
                  <CardDescription>
                    Closed copied trades split by winning and losing outcomes.
                  </CardDescription>
                </CardHeader>
                <CardContent className="pt-4">
                  <div className="mb-4 inline-flex w-full rounded-2xl border border-slate-200 bg-slate-50 p-1 sm:w-auto">
                    <button
                      type="button"
                      className={`flex-1 rounded-xl px-4 py-2 text-sm font-medium transition sm:flex-none ${
                        pastTradesTab === "won"
                          ? "bg-white text-slate-950 shadow-sm ring-1 ring-slate-200"
                          : "text-slate-500 hover:text-slate-900"
                      }`}
                      onClick={() => {
                        setPastTradesTab("won");
                        setWonPastTradesPage(1);
                      }}
                    >
                      Won ({wonAnalysisTrades.length})
                    </button>
                    <button
                      type="button"
                      className={`flex-1 rounded-xl px-4 py-2 text-sm font-medium transition sm:flex-none ${
                        pastTradesTab === "lost"
                          ? "bg-white text-slate-950 shadow-sm ring-1 ring-slate-200"
                          : "text-slate-500 hover:text-slate-900"
                      }`}
                      onClick={() => {
                        setPastTradesTab("lost");
                        setLostPastTradesPage(1);
                      }}
                    >
                      Lost ({lostAnalysisTrades.length})
                    </button>
                  </div>
                  <div className="overflow-x-auto rounded-[24px] border border-slate-200 bg-white shadow-sm">
                    <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
                      <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                        <tr>
                          <th className="px-4 py-3">Timestamp</th>
                          <th className="px-4 py-3">Trader</th>
                          <th className="px-4 py-3">Event</th>
                          <th className="px-4 py-3">Outcome</th>
                          <th className="px-4 py-3">Side</th>
                          <th className="px-4 py-3">Amount</th>
                          <th className="px-4 py-3">Price</th>
                          <th className="px-4 py-3">PnL</th>
                          <th className="px-4 py-3">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {visiblePastAnalysisTrades.length === 0 ? (
                          <tr>
                            <td
                              className="px-4 py-6 text-sm text-slate-500"
                              colSpan={9}
                            >
                              No {pastTradesTab} copied trades are available
                              yet.
                            </td>
                          </tr>
                        ) : (
                          visiblePastAnalysisTrades.map((trade) => (
                            <tr key={trade.id} className="align-top">
                              <td className="px-4 py-3 text-slate-700">
                                {formatTs(trade.timestamp)}
                              </td>
                              <td className="px-4 py-3 font-medium text-slate-950">
                                {trade.traderName}
                              </td>
                              <td className="px-4 py-3 text-slate-700">
                                <div className="font-medium text-slate-950">
                                  {trade.marketTitle}
                                </div>
                                <div className="mt-1 text-xs text-slate-500">
                                  {trade.marketId}
                                </div>
                              </td>
                              <td className="px-4 py-3 text-slate-700">
                                {trade.outcome}
                              </td>
                              <td className="px-4 py-3 font-semibold text-slate-800">
                                {trade.side}
                              </td>
                              <td className="px-4 py-3 text-slate-700">
                                {formatMoney(trade.amount)}
                              </td>
                              <td className="px-4 py-3 text-slate-700">
                                {formatMoney(trade.price, 4)}
                              </td>
                              <td
                                className={`px-4 py-3 font-semibold ${trade.pnl >= 0 ? "text-emerald-600" : "text-rose-600"}`}
                              >
                                {formatMoney(trade.pnl)}
                              </td>
                              <td className="px-4 py-3 text-slate-700">
                                {trade.status}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                  <PaginationRowsControl
                    total={pastAnalysisTrades.length}
                    page={normalizedPastTradesPage}
                    pageSize={PAST_TRADES_PAGE_SIZE}
                    onPageChange={setPastTradesPage}
                  />
                </CardContent>
              </Card>

              <Card
                className="border border-slate-200 bg-white py-6"
                style={DEFERRED_CARD_STYLE}
              >
                <CardHeader className="pb-0">
                  <CardTitle className="text-base tracking-[0.18em] text-slate-950">
                    Copied Traders
                  </CardTitle>
                  <CardDescription>
                    Traders successfully copied so far, sorted by copied trades
                    in decreasing order. Click any row for a full trade breakup.
                  </CardDescription>
                </CardHeader>
                <CardContent className="pt-4">
                  <div className="overflow-x-auto rounded-[24px] border border-slate-200 bg-white shadow-sm">
                    <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
                      <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                        <tr>
                          <th className="px-4 py-3">Trader Name</th>
                          <th className="px-4 py-3">Net worth</th>
                          <th className="px-4 py-3">Copied Trades</th>
                          <th className="px-4 py-3">Trades Won</th>
                          <th className="px-4 py-3">Total Winnings</th>
                          <th className="px-4 py-3">Trades Lost</th>
                          <th className="px-4 py-3">Total Losses</th>
                          <th className="px-4 py-3">Total PnL</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {copiedTraderAnalysisRows.length === 0 ? (
                          <tr>
                            <td
                              className="px-4 py-6 text-sm text-slate-500"
                              colSpan={8}
                            >
                              No copied trader analysis is available yet.
                            </td>
                          </tr>
                        ) : (
                          visibleCopiedTraderAnalysisRows.map((trader) => (
                            <tr
                              key={trader.key}
                              className="cursor-pointer align-top transition hover:bg-slate-50"
                              onClick={() => setSelectedAnalyzedTrader(trader)}
                            >
                              <td className="px-4 py-3 font-medium text-sky-700 underline underline-offset-2">
                                {trader.traderName}
                              </td>
                              <td className="px-4 py-3 font-semibold text-slate-700">
                                <div
                                  className="flex min-w-56 flex-col gap-2"
                                  onClick={(event) => event.stopPropagation()}
                                >
                                  {(() => {
                                    const manualDraftKey =
                                      trader.accountId ?? trader.key;
                                    const rawManualDraft =
                                      manualNetWorthDrafts[manualDraftKey];
                                    const manualDraftNetWorth =
                                      rawManualDraft === undefined ||
                                      rawManualDraft.trim() === ""
                                        ? Number.NaN
                                        : Number.parseFloat(rawManualDraft);
                                    const displayedNetWorth = Number.isFinite(
                                      manualDraftNetWorth,
                                    )
                                      ? manualDraftNetWorth
                                      : trader.netWorth;
                                    const matchingNetWorthAccount = state
                                      ? findTrackedAccountForCopiedTrader(
                                          trader,
                                          state.tracked_accounts,
                                        )
                                      : undefined;
                                    const hasPersistedNetWorth =
                                      isPersistedNetWorthValue(
                                        matchingNetWorthAccount,
                                        displayedNetWorth,
                                      );
                                    const manualBusyKey = `net-worth-${manualDraftKey}`;
                                    return (
                                      <>
                                        <button
                                          type="button"
                                          className="rounded-full px-2 py-1 text-left font-semibold text-slate-700 transition hover:bg-sky-50 hover:text-sky-700 focus:outline-none focus:ring-2 focus:ring-sky-400"
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            setSelectedNetWorthTrader(trader);
                                          }}
                                          title={copiedTraderNetWorthBreakdown(
                                            trader,
                                          )}
                                        >
                                          <span className="inline-flex items-center gap-1.5">
                                            <span>
                                              {displayedNetWorth > 0
                                                ? formatMoney(displayedNetWorth)
                                                : "—"}
                                            </span>
                                            {hasPersistedNetWorth ? (
                                              <Check
                                                className="size-4 text-emerald-500"
                                                aria-label="Net worth saved in memory"
                                              />
                                            ) : null}
                                          </span>
                                        </button>
                                        <div className="flex items-center gap-2">
                                          <input
                                            type="number"
                                            min="0"
                                            step="0.01"
                                            className="w-28 rounded-full border border-slate-200 px-3 py-1 text-xs font-medium text-slate-700 shadow-sm focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-100"
                                            aria-label={`Manual net worth for ${trader.traderName}`}
                                            placeholder="Net worth"
                                            value={
                                              manualNetWorthDrafts[
                                                manualDraftKey
                                              ] ??
                                              (trader.netWorth > 0
                                                ? String(trader.netWorth)
                                                : "")
                                            }
                                            disabled={
                                              busyAccountId === manualBusyKey
                                            }
                                            onChange={(event) =>
                                              setManualNetWorthDrafts(
                                                (current) => ({
                                                  ...current,
                                                  [manualDraftKey]:
                                                    event.target.value,
                                                }),
                                              )
                                            }
                                          />
                                          <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            className="h-7 rounded-full px-3 text-[11px]"
                                            disabled={
                                              busyAccountId === manualBusyKey
                                            }
                                            onClick={() =>
                                              void saveManualNetWorth(trader)
                                            }
                                          >
                                            {busyAccountId === manualBusyKey ? (
                                              <Loader2 className="mr-1 size-3 animate-spin" />
                                            ) : null}
                                            Save
                                          </Button>
                                        </div>
                                      </>
                                    );
                                  })()}
                                </div>
                              </td>
                              <td className="px-4 py-3 text-slate-700">
                                {trader.copiedTrades}
                              </td>
                              <td className="px-4 py-3 text-emerald-700">
                                {trader.tradesWon}
                              </td>
                              <td className="px-4 py-3 font-semibold text-emerald-700">
                                {formatMoney(trader.totalWinnings)}
                              </td>
                              <td className="px-4 py-3 text-rose-700">
                                {trader.tradesLost}
                              </td>
                              <td className="px-4 py-3 font-semibold text-rose-700">
                                {formatMoney(trader.totalLosses)}
                              </td>
                              <td
                                className={`px-4 py-3 font-semibold ${trader.totalPnl >= 0 ? "text-emerald-700" : "text-rose-700"}`}
                              >
                                {formatMoney(trader.totalPnl)}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                    <PaginationRowsControl
                      total={copiedTraderAnalysisRows.length}
                      page={safeCopiedTraderAnalysisPage}
                      pageSize={COPIED_TRADERS_ANALYSIS_PAGE_SIZE}
                      onPageChange={setCopiedTraderAnalysisPage}
                    />
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
                        runAction("doctor", () =>
                          apiService.polymarketLiveDoctor(),
                        )
                      }
                    >
                      {pendingAction === "doctor" ? (
                        <Loader2
                          className="mr-2 size-3.5 animate-spin"
                          aria-hidden="true"
                        />
                      ) : null}
                      {pendingAction === "doctor"
                        ? "Refreshing doctor…"
                        : "Refresh doctor"}
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
                        runAction("redeem", () =>
                          apiService.polymarketLiveRedeem(),
                        )
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

                  <div className="rounded-[20px] border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                    {pendingAction ? (
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2 font-semibold text-slate-950">
                          <Loader2
                            className="size-4 animate-spin text-sky-600"
                            aria-hidden="true"
                          />
                          Processing {pendingActionLabel}…
                        </div>
                        <p>{pendingActionDetail}</p>
                        <p className="text-xs text-slate-500">
                          Controls are temporarily disabled to prevent duplicate
                          live-trading actions. They will re-enable when the
                          backend responds.
                        </p>
                      </div>
                    ) : autoDoctorRefreshing ? (
                      <div className="flex items-center gap-2 font-semibold text-slate-950">
                        <Loader2
                          className="size-4 animate-spin text-sky-600"
                          aria-hidden="true"
                        />
                        Auto-refreshing Bullpen doctor after login-required
                        status…
                      </div>
                    ) : (
                      <p>
                        No control action is running. If you just completed
                        Bullpen login, the page now automatically retries the
                        doctor check; you can also click Refresh Doctor
                        manually.
                      </p>
                    )}
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
                    New proposals appear only after a live-read trade is
                    detected after startup baseline. If manual wallets are
                    configured, they are preferred over auto-discovered traders.
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
                    Environment-configured `MANUAL_TRACKED_WALLETS` entries
                    remain tracked even if not discovered by the active-trader
                    scan.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6 pt-4">
                  <TrackedAccountsTable
                    accounts={state.tracked_accounts}
                    drafts={accountDrafts}
                    newDraft={newAccountDraft}
                    busyId={busyAccountId}
                    onDraftChange={(id, draft) =>
                      setAccountDrafts((current) => ({
                        ...current,
                        [id]: draft,
                      }))
                    }
                    onNewDraftChange={setNewAccountDraft}
                    onAdd={() => void addTrackedAccount()}
                    onSave={(accountId) => void saveTrackedAccount(accountId)}
                    onDelete={(accountId) =>
                      void deleteTrackedAccount(accountId)
                    }
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

          {selectedFailedCopiedEvent ? (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 px-4"
              role="dialog"
              aria-modal="true"
              onClick={() => setSelectedFailedCopiedEvent(null)}
            >
              <div
                className="relative w-full max-w-3xl rounded-[28px] bg-white p-6 shadow-2xl"
                onClick={(event) => event.stopPropagation()}
              >
                <button
                  type="button"
                  className="absolute right-4 top-4 rounded-full p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-400"
                  aria-label="Close failure details popup"
                  onClick={() => setSelectedFailedCopiedEvent(null)}
                >
                  <X className="size-5" />
                </button>
                <div className="pr-12">
                  <h2 className="text-lg font-semibold text-slate-950">
                    Failed copy details
                  </h2>
                  <p className="mt-1 text-sm text-slate-500">
                    {selectedFailedCopiedEvent.marketTitle}
                  </p>
                </div>
                <div className="mt-5 space-y-3">
                  {getCopiedEventFailureTrades(selectedFailedCopiedEvent).map(
                    (trade) => (
                      <div
                        key={trade.id}
                        className="rounded-[20px] border border-rose-100 bg-rose-50/60 p-4"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                          <span className="font-semibold text-slate-950">
                            {getTraderDisplayName(trade)}
                          </span>
                          <span className="text-xs font-medium uppercase tracking-[0.14em] text-slate-500">
                            {formatTs(
                              trade.executed_at ||
                                trade.updated_at ||
                                trade.proposed_at,
                            )}
                          </span>
                        </div>
                        <div className="mt-3 text-sm font-medium text-rose-800">
                          {getTradeStatusReason(trade)}
                        </div>
                        <dl className="mt-3 grid gap-2 text-xs text-slate-600 sm:grid-cols-3">
                          <div>
                            <dt className="font-semibold uppercase tracking-[0.12em] text-slate-400">
                              Outcome
                            </dt>
                            <dd>{trade.outcome}</dd>
                          </div>
                          <div>
                            <dt className="font-semibold uppercase tracking-[0.12em] text-slate-400">
                              Side
                            </dt>
                            <dd>{trade.side}</dd>
                          </div>
                          <div>
                            <dt className="font-semibold uppercase tracking-[0.12em] text-slate-400">
                              Amount
                            </dt>
                            <dd>{formatMoney(trade.amount)}</dd>
                          </div>
                        </dl>
                      </div>
                    ),
                  )}
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
                className="relative w-full max-w-6xl rounded-[28px] bg-white p-6 shadow-2xl"
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
                    <h2 className="text-lg font-semibold text-slate-950">
                      Copied traders
                    </h2>
                    <p className="mt-1 text-sm text-slate-500">
                      {selectedCopiedEvent.marketTitle}
                    </p>
                  </div>
                </div>
                <div className="mt-5 overflow-x-auto rounded-[20px] border border-slate-200">
                  <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
                    <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                      <tr>
                        <th className="px-4 py-3">Trader</th>
                        <th className="px-4 py-3">Timestamp</th>
                        <th className="px-4 py-3">Amount</th>
                        <th className="px-4 py-3">Trader invested</th>
                        <th className="px-4 py-3">Positions Value</th>
                        <th className="px-4 py-3">Net worth</th>
                        <th className="px-4 py-3">% of net worth</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {selectedCopiedEvent.traders
                        .filter(
                          (trade) =>
                            (trade.trader_invested_usd || 0) >=
                            state.config.trader_invested_threshold_usd,
                        )
                        .map((trade) => {
                          const traderInvested = trade.trader_invested_usd || 0;
                          const traderAccount = getTrackedAccountForTrade(
                            trade,
                            state.tracked_accounts,
                          );
                          const copiedTrader = getCopiedTraderAnalysisForTrade(
                            trade,
                            copiedTraderAnalysisRows,
                          );
                          const netWorth = getTradeNetWorth(
                            trade,
                            traderAccount,
                            copiedTrader,
                          );
                          const positionsValue =
                            traderAccount?.positions_value_usd ??
                            copiedTrader?.positionsValueUsd;
                          const positionsValueMissingReason =
                            getPositionsValueMissingReason(traderAccount);
                          const missingReason = getNetWorthMissingReason(
                            trade,
                            traderAccount,
                            copiedTrader,
                          );
                          const netWorthPercent =
                            netWorth > 0
                              ? (traderInvested / netWorth) * 100
                              : null;
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
                                ) : (
                                  getTraderDisplayName(trade)
                                )}
                              </td>
                              <td className="px-4 py-3 text-slate-700">
                                {formatTs(
                                  trade.executed_at ||
                                    trade.updated_at ||
                                    trade.proposed_at,
                                )}
                              </td>
                              <td className="px-4 py-3 text-slate-700">
                                {formatMoney(trade.amount)}
                              </td>
                              <td className="px-4 py-3 text-slate-700">
                                {formatMoney(traderInvested)}
                              </td>
                              <td className="px-4 py-3 text-slate-700">
                                {positionsValue == null
                                  ? positionsValueMissingReason
                                  : formatCompactMoney(positionsValue)}
                              </td>
                              <td className="px-4 py-3 text-slate-700">
                                {netWorth > 0
                                  ? formatMoney(netWorth)
                                  : missingReason}
                              </td>
                              <td className="px-4 py-3 text-slate-700">
                                {netWorthPercent === null
                                  ? missingReason
                                  : formatPercent(netWorthPercent)}
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

          {selectedNetWorthTrader ? (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 px-4"
              role="dialog"
              aria-modal="true"
              onClick={() => setSelectedNetWorthTrader(null)}
            >
              <div
                className="relative w-full max-w-xl rounded-[28px] bg-white p-6 shadow-2xl"
                onClick={(event) => event.stopPropagation()}
              >
                <button
                  type="button"
                  className="absolute right-4 top-4 rounded-full p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-400"
                  aria-label="Close net worth popup"
                  onClick={() => setSelectedNetWorthTrader(null)}
                >
                  <X className="size-5" />
                </button>
                <div className="pr-10">
                  <h2 className="text-lg font-semibold text-slate-950">
                    {selectedNetWorthTrader.traderName} net worth
                  </h2>
                  <p className="mt-1 text-sm text-slate-500">
                    Polymarket net worth ≈ Active positions value + Cash balance
                    + Claimable/redeemable winnings.
                  </p>
                </div>
                <div className="mt-5 space-y-3 text-sm">
                  <div className="flex justify-between gap-4 rounded-2xl bg-slate-50 px-4 py-3">
                    <span className="text-slate-500">Last refreshed</span>
                    <span className="font-medium text-slate-900">
                      {formatTs(selectedNetWorthTrader.netWorthCheckedAt)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-4 rounded-2xl bg-slate-50 px-4 py-3">
                    <span className="text-slate-500">
                      Active positions value
                    </span>
                    <span className="font-semibold text-slate-900">
                      {formatOptionalMoney(
                        selectedNetWorthTrader.positionsValueUsd,
                      )}
                    </span>
                  </div>
                  <div className="flex justify-between gap-4 rounded-2xl bg-slate-50 px-4 py-3">
                    <span className="text-slate-500">Cash balance</span>
                    <span className="font-semibold text-slate-900">
                      {formatOptionalMoney(
                        selectedNetWorthTrader.cashBalanceUsd,
                      )}
                    </span>
                  </div>
                  <div className="flex justify-between gap-4 rounded-2xl bg-slate-50 px-4 py-3">
                    <span className="text-slate-500">
                      Claimable/redeemable winnings
                    </span>
                    <span className="font-semibold text-slate-900">
                      {formatOptionalMoney(
                        selectedNetWorthTrader.redeemableValueUsd,
                      )}
                    </span>
                  </div>
                  <div className="flex justify-between gap-4 rounded-2xl border border-slate-200 px-4 py-3">
                    <span className="font-semibold text-slate-700">
                      Displayed net worth
                    </span>
                    <span className="font-bold text-slate-950">
                      {formatMoney(selectedNetWorthTrader.netWorth)}
                    </span>
                  </div>
                </div>
                <p className="mt-4 text-xs leading-5 text-slate-500">
                  {copiedTraderNetWorthBreakdown(selectedNetWorthTrader)}
                </p>
                {selectedNetWorthTrader.accountId ? (
                  <Button
                    type="button"
                    className="mt-5 rounded-full"
                    disabled={pendingAction !== null}
                    onClick={() =>
                      handleNetWorthRefresh(selectedNetWorthTrader)
                    }
                  >
                    {pendingAction ===
                    `net-worth-${selectedNetWorthTrader.accountId}` ? (
                      <Loader2 className="mr-2 size-4 animate-spin" />
                    ) : null}
                    Refresh & recalculate
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
          {selectedAnalyzedTrader ? (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 px-4"
              role="dialog"
              aria-modal="true"
              onClick={() => setSelectedAnalyzedTrader(null)}
            >
              <div
                className="relative max-h-[85vh] w-full max-w-6xl overflow-y-auto rounded-[28px] bg-white p-6 shadow-2xl"
                onClick={(event) => event.stopPropagation()}
              >
                <button
                  type="button"
                  className="absolute right-4 top-4 rounded-full p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-400"
                  aria-label="Close copied trader analysis popup"
                  onClick={() => setSelectedAnalyzedTrader(null)}
                >
                  <X className="size-5" />
                </button>
                <div className="flex flex-col gap-4 pr-12">
                  <div>
                    <h2 className="text-lg font-semibold text-slate-950">
                      {(() => {
                        const profileUrl = getCopiedTraderProfileUrl(
                          selectedAnalyzedTrader,
                        );
                        if (!profileUrl) {
                          return (
                            <span className="inline-flex items-center gap-2">
                              <PolymarketIcon className="size-5 text-blue-600" />
                              <span>
                                {selectedAnalyzedTrader.traderName} trade
                                breakup
                              </span>
                            </span>
                          );
                        }
                        return (
                          <a
                            href={profileUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-2 rounded-md text-slate-950 transition hover:text-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                            aria-label={`Open ${selectedAnalyzedTrader.traderName} Polymarket profile`}
                          >
                            <PolymarketIcon className="size-5 text-blue-600" />
                            <span>
                              {selectedAnalyzedTrader.traderName} trade breakup
                            </span>
                          </a>
                        );
                      })()}
                    </h2>
                    <p className="mt-1 text-sm text-slate-500">
                      {selectedAnalyzedTrader.copiedTrades} copied trades ·{" "}
                      {selectedAnalyzedTrader.tradesWon} won ·{" "}
                      {selectedAnalyzedTrader.tradesLost} lost · Total PnL{" "}
                      {formatMoney(selectedAnalyzedTrader.totalPnl)}
                    </p>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                        Total Winnings
                      </div>
                      <div className="mt-2 text-lg font-semibold text-emerald-700">
                        {formatMoney(selectedAnalyzedTrader.totalWinnings)}
                      </div>
                    </div>
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                        Total Losses
                      </div>
                      <div className="mt-2 text-lg font-semibold text-rose-700">
                        {formatMoney(selectedAnalyzedTrader.totalLosses)}
                      </div>
                    </div>
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                        Trades Won
                      </div>
                      <div className="mt-2 text-lg font-semibold text-slate-950">
                        {selectedAnalyzedTrader.tradesWon}
                      </div>
                    </div>
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                        Trades Lost
                      </div>
                      <div className="mt-2 text-lg font-semibold text-slate-950">
                        {selectedAnalyzedTrader.tradesLost}
                      </div>
                    </div>
                  </div>
                </div>
                <div className="mt-5 overflow-x-auto rounded-[20px] border border-slate-200">
                  <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
                    <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                      <tr>
                        <th className="px-4 py-3">Timestamp</th>
                        <th className="px-4 py-3">Event</th>
                        <th className="px-4 py-3">Outcome</th>
                        <th className="px-4 py-3">Side</th>
                        <th className="px-4 py-3">Amount</th>
                        <th className="px-4 py-3">Shares</th>
                        <th className="px-4 py-3">Price</th>
                        <th className="px-4 py-3">PnL</th>
                        <th className="px-4 py-3">Reason</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {selectedAnalyzedTrader.trades.map((trade) => (
                        <tr key={trade.id} className="align-top">
                          <td className="px-4 py-3 text-slate-700">
                            {formatTs(trade.timestamp)}
                          </td>
                          <td className="px-4 py-3 text-slate-700">
                            <div className="font-medium text-slate-950">
                              {trade.marketTitle}
                            </div>
                            <div className="mt-1 text-xs text-slate-500">
                              {trade.marketId}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-slate-700">
                            {trade.outcome}
                          </td>
                          <td className="px-4 py-3 font-semibold text-slate-800">
                            {trade.side}
                          </td>
                          <td className="px-4 py-3 text-slate-700">
                            {formatMoney(trade.amount)}
                          </td>
                          <td className="px-4 py-3 text-slate-700">
                            {trade.shares.toFixed(4)}
                          </td>
                          <td className="px-4 py-3 text-slate-700">
                            {formatMoney(trade.price, 4)}
                          </td>
                          <td
                            className={`px-4 py-3 font-semibold ${
                              trade.pnl >= 0
                                ? "text-emerald-600"
                                : "text-rose-600"
                            }`}
                          >
                            {formatMoney(trade.pnl)}
                          </td>
                          <td className="px-4 py-3 text-slate-700">
                            {trade.reason}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : null}
          {skippedBreakupOpen ? (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 px-4"
              role="dialog"
              aria-modal="true"
              aria-labelledby="skipped-breakup-title"
              onClick={() => setSkippedBreakupOpen(false)}
            >
              <div
                className="relative w-full max-w-xl rounded-[28px] bg-white p-6 shadow-2xl"
                onClick={(event) => event.stopPropagation()}
              >
                <button
                  type="button"
                  className="absolute right-4 top-4 rounded-full p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-400"
                  aria-label="Close skipped detail breakup popup"
                  onClick={() => setSkippedBreakupOpen(false)}
                >
                  <X className="size-5" />
                </button>
                <div className="pr-12">
                  <h2
                    id="skipped-breakup-title"
                    className="text-lg font-semibold text-slate-950"
                  >
                    Skipped detail breakup
                  </h2>
                  <p className="mt-1 text-sm text-slate-500">
                    Last poll skipped {skippedBreakup.total} source trades
                    across filter, limit, duplicate, and uncategorized buckets.
                  </p>
                </div>
                <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  {[
                    {
                      label: "Skipped By Filters",
                      value: skippedBreakup.filters,
                    },
                    {
                      label: "Skipped By Limits",
                      value: skippedBreakup.limits,
                    },
                    {
                      label: "Skipped Duplicates",
                      value: skippedBreakup.duplicates,
                    },
                    { label: "Others", value: skippedBreakup.others },
                  ].map((item) => (
                    <div
                      key={item.label}
                      className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3"
                    >
                      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                        {item.label}
                      </div>
                      <div className="mt-2 text-2xl font-semibold tabular-nums text-slate-950">
                        {item.value}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-5 rounded-2xl border border-sky-100 bg-sky-50 px-4 py-3 text-sm text-sky-900">
                  Others captures any skipped source trades implied by the last
                  poll total that are not classified as filter, limit, or
                  duplicate skips.
                </div>
              </div>
            </div>
          ) : null}
          {pendingAction ? (
            <div className="flex flex-col gap-1 text-xs text-slate-500">
              <div className="flex items-center gap-2 uppercase tracking-[0.18em]">
                <Loader2 className="size-3.5 animate-spin" />
                Processing {pendingActionLabel}
              </div>
              {pendingActionDetail ? (
                <div className="pl-5 normal-case tracking-normal">
                  {pendingActionDetail}
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

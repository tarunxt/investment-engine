"use client";

import { useEffect, useRef, useState } from "react";
import { Activity, ExternalLink, Info, Loader2, TrendingUp, Wallet } from "lucide-react";

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

function formatMoney(value: number, digits = 2) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: digits,
  }).format(value || 0);
}

const BULLPEN_ACCOUNT_URL =
  "https://app.bullpen.fi/wallet/predictions?ref=intrepid-crane-3";

type CopiedEventGroup = {
  key: string;
  copiedAt: string;
  marketId: string;
  marketTitle: string;
  outcome: string;
  side: PolymarketSourceTradeDecision["side"];
  amount: number;
  averagePrice: number;
  status: string;
  traders: PolymarketSourceTradeDecision[];
};

function getTraderDisplayName(trade: PolymarketSourceTradeDecision) {
  return trade.trader_handle ? `@${trade.trader_handle}` : trade.trader_name;
}

function getCopiedEventKey(trade: PolymarketSourceTradeDecision) {
  return [trade.market_id, trade.market_title, trade.outcome, trade.side].join(
    "::",
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
        outcome: trade.outcome,
        side: trade.side,
        amount: trade.amount,
        averagePrice: trade.price,
        status: trade.status,
        traders: [trade],
      });
      continue;
    }

    existing.amount += trade.amount;
    existing.traders.push(trade);
    existing.copiedAt =
      new Date(trade.executed_at || trade.updated_at || trade.proposed_at).getTime() >
      new Date(existing.copiedAt).getTime()
        ? trade.executed_at || trade.updated_at || trade.proposed_at
        : existing.copiedAt;
    existing.status = existing.traders.some((item) => item.status === "executed")
      ? "executed"
      : existing.status;
    existing.averagePrice = existing.amount > 0
      ? existing.traders.reduce(
          (total, item) => total + item.amount * item.price,
          0,
        ) / existing.amount
      : existing.averagePrice;
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
  const [copiedPositionsTab, setCopiedPositionsTab] = useState<
    "positions" | "history"
  >("positions");
  const [copiedPositionStatus, setCopiedPositionStatus] = useState<
    "active" | "closed"
  >("active");
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
    } catch (runError) {
      setActionError(normalizeError(runError));
    } finally {
      actionInFlight.current = false;
      setPendingAction(null);
    }
  }

  function applyTrackedAccountState(nextState: PolymarketBotState) {
    setState(nextState);
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

  const bullpenAccountValueUsd = parseUsdFromBalanceMessage(
    state.live.balance.message,
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
  const copiedVisibleTrades =
    copiedPositionsTab === "positions"
      ? copiedPositionTrades
      : copiedHistoryTrades;
  const copiedEventGroups = buildCopiedEventGroups(copiedVisibleTrades);
  const activeCopiedEventGroups = buildCopiedEventGroups(executedLiveTrades);

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
          <div className="flex flex-wrap gap-2 rounded-[24px] border border-slate-200 bg-white px-4 py-4 shadow-sm">
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
          </div>



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

              <div className="overflow-x-auto rounded-[24px] border border-slate-200 bg-white shadow-sm">
                <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
                  <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                    <tr>
                      <th className="px-4 py-3">Copied At</th>
                      <th className="px-4 py-3">Trader</th>
                      <th className="px-4 py-3">Event</th>
                      <th className="px-4 py-3">Side</th>
                      <th className="px-4 py-3">Outcome</th>
                      <th className="px-4 py-3">Amount</th>
                      <th className="px-4 py-3">Price</th>
                      <th className="px-4 py-3">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {copiedEventGroups.length === 0 ? (
                      <tr>
                        <td className="px-4 py-6 text-sm text-slate-500" colSpan={8}>
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
                            ) : getTraderDisplayName(event.traders[0])}
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
                          <td className="px-4 py-3 font-semibold text-slate-800">{event.side}</td>
                          <td className="px-4 py-3 text-slate-700">{event.outcome}</td>
                          <td className="px-4 py-3 text-slate-700">{formatMoney(event.amount)}</td>
                          <td className="px-4 py-3 text-slate-700">{formatMoney(event.averagePrice, 4)}</td>
                          <td className="px-4 py-3 text-slate-700">{event.status}</td>
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


      {selectedCopiedEvent ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 px-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-2xl rounded-[28px] bg-white p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-slate-950">Copied traders</h2>
                <p className="mt-1 text-sm text-slate-500">{selectedCopiedEvent.marketTitle}</p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="rounded-full border-slate-300"
                onClick={() => setSelectedCopiedEvent(null)}
              >
                Close
              </Button>
            </div>
            <div className="mt-5 overflow-hidden rounded-[20px] border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
                <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Trader</th>
                    <th className="px-4 py-3">Timestamp</th>
                    <th className="px-4 py-3">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {selectedCopiedEvent.traders.map((trade) => (
                    <tr key={trade.id}>
                      <td className="px-4 py-3 font-medium text-slate-950">{getTraderDisplayName(trade)}</td>
                      <td className="px-4 py-3 text-slate-700">
                        {formatTs(trade.executed_at || trade.updated_at || trade.proposed_at)}
                      </td>
                      <td className="px-4 py-3 text-slate-700">{formatMoney(trade.amount)}</td>
                    </tr>
                  ))}
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

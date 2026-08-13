"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Wallet } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatApiTimestamp } from "@/lib/datetime";
import {
  isBullpenHistoryActivePosition,
  isBullpenHistoryClaimablePosition,
} from "@/lib/bullpenHistoryPositions";
import {
  isUsableBullpenPositionsSnapshot,
  resolveBullpenPreferredPortfolioValue,
  resolveBullpenTotalPortfolioValue,
  sumCurrentPositionValue,
  type BullpenPositionsResponse,
  type BullpenPositionsSnapshotLineage,
  type BullpenPositionsSource,
  type BullpenPositionsSummary,
} from "@/lib/bullpenPositions";
import {
  resolveLatestVerifiedStage1Portfolio,
  resolveVerifiedStage1PortfolioSnapshot,
  selectLatestVerifiedStage1Portfolio,
  shouldUseVerifiedStage1PortfolioFallback,
} from "@/lib/bullpenVerifiedPortfolio";
import { apiService } from "@/services/api";
import type {
  BullpenAutoLiveSummaryResponse,
  PolymarketBotState,
} from "@/types/api";

function formatMoney(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? `$${value.toLocaleString("en-US", {
        maximumFractionDigits: 2,
        minimumFractionDigits: 2,
      })}`
    : "—";
}

function formatIstDateTime(value: string | null | undefined) {
  return formatApiTimestamp(value, {
    emptyValue: "—",
    timeZone: "Asia/Kolkata",
    timeZoneName: "short",
    second: "2-digit",
  });
}

async function fetchPositions(forceFresh: boolean) {
  const params = new URLSearchParams({
    caller_source: forceFresh ? "ui-portfolio-refresh" : "ui-passive-refresh",
    max_age_seconds: forceFresh ? "0" : "20",
    request_id: crypto.randomUUID(),
  });
  params.set(forceFresh ? "force_fresh" : "passive", "true");
  const response = await fetch(`/api/bullpen-ai/positions?${params}`, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { "Cache-Control": "no-cache" },
  });
  const payload = (await response.json()) as BullpenPositionsResponse;
  if (!response.ok && !payload.positions?.length) {
    throw new Error(
      payload.error || `Bullpen positions request failed (${response.status}).`,
    );
  }
  return payload;
}

export function BullpenHistoryPortfolio() {
  const [positions, setPositions] = useState<BullpenPositionsResponse | null>(null);
  const [summary, setSummary] = useState<BullpenAutoLiveSummaryResponse | null>(null);
  const [botState, setBotState] = useState<PolymarketBotState | null>(null);
  const [lastUsableBalance, setLastUsableBalance] = useState<
    PolymarketBotState["live"]["balance"] | null
  >(null);
  const [refreshing, setRefreshing] = useState(true);
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);

  const load = useCallback(async (forceFresh: boolean) => {
    setRefreshing(true);
    setRefreshNotice(null);
    try {
      const [summaryResult, stateResult, positionsResult] =
        await Promise.allSettled([
          apiService.getBullpenAutoLiveSummary({ timeoutMs: 5_000 }),
          forceFresh
            ? apiService.polymarketLiveBalanceRefresh({ timeoutMs: 5_000 })
            : apiService.polymarketState({ timeoutMs: 5_000 }),
          fetchPositions(forceFresh),
        ]);

      const nextSummary =
        summaryResult.status === "fulfilled" ? summaryResult.value : null;
      const nextState =
        stateResult.status === "fulfilled" ? stateResult.value : null;
      const nextPositions =
        positionsResult.status === "fulfilled" ? positionsResult.value : null;

      if (nextSummary) setSummary(nextSummary);
      if (nextState) {
        setBotState(nextState);
        if (nextState.live.balance.status === "ready") {
          setLastUsableBalance(nextState.live.balance);
        }
      }
      if (nextPositions) setPositions(nextPositions);

      const verifiedStage1 = selectLatestVerifiedStage1Portfolio([
        resolveVerifiedStage1PortfolioSnapshot(
          nextSummary?.state.verified_portfolio_snapshot,
        ),
        resolveLatestVerifiedStage1Portfolio(
          nextSummary
            ? [nextSummary.latest_run, ...nextSummary.recent_runs]
            : [],
        ),
      ]);
      const hasUsableLiveSnapshot = Boolean(
        nextPositions &&
          isUsableBullpenPositionsSnapshot({
            positionsSource: nextPositions.positionsSource,
            liveAvailable: nextPositions.liveAvailable,
          }),
      );

      if (!hasUsableLiveSnapshot && !verifiedStage1) {
        const errors = [summaryResult, stateResult, positionsResult]
          .filter(
            (result): result is PromiseRejectedResult =>
              result.status === "rejected",
          )
          .map((result) =>
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
          );
        setRefreshNotice(
          nextPositions?.fallback?.message ||
            nextPositions?.error ||
            errors[0] ||
            "Bullpen portfolio data is temporarily unavailable.",
        );
      }
    } catch (error) {
      setRefreshNotice(
        error instanceof Error
          ? error.message
          : "Bullpen portfolio refresh failed.",
      );
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    window.queueMicrotask(() => void load(false));
  }, [load]);

  const view = useMemo(() => {
    const verifiedStage1Portfolio = selectLatestVerifiedStage1Portfolio([
      resolveVerifiedStage1PortfolioSnapshot(
        summary?.state.verified_portfolio_snapshot,
      ),
      resolveLatestVerifiedStage1Portfolio(
        summary ? [summary.latest_run, ...summary.recent_runs] : [],
      ),
    ]);
    const liveSnapshotUsable = Boolean(
      positions &&
        isUsableBullpenPositionsSnapshot({
          positionsSource: positions.positionsSource,
          liveAvailable: positions.liveAvailable,
        }),
    );
    const useVerifiedStage1Fallback =
      shouldUseVerifiedStage1PortfolioFallback({
        hasActivePositionsSnapshot: liveSnapshotUsable,
        verifiedPortfolio: verifiedStage1Portfolio,
      });
    const activePositions =
      useVerifiedStage1Fallback && verifiedStage1Portfolio
        ? [
            ...verifiedStage1Portfolio.activePositions,
            ...verifiedStage1Portfolio.claimablePositions,
          ]
        : (positions?.positions ?? []);
    const activePositionsSummary: BullpenPositionsSummary | null =
      liveSnapshotUsable ? (positions?.summary ?? null) : null;
    const hasActivePositionsSnapshot =
      liveSnapshotUsable ||
      useVerifiedStage1Fallback ||
      (!verifiedStage1Portfolio && activePositions.length > 0);
    const verifiedActivePositions =
      useVerifiedStage1Fallback && verifiedStage1Portfolio
        ? verifiedStage1Portfolio.activePositions
        : activePositions.filter(isBullpenHistoryActivePosition);
    const verifiedClaimablePositions =
      useVerifiedStage1Fallback && verifiedStage1Portfolio
        ? verifiedStage1Portfolio.claimablePositions
        : activePositions.filter(isBullpenHistoryClaimablePosition);
    const liveBalance = botState?.live.balance ?? null;
    const balance =
      liveBalance?.status === "ready" ? liveBalance : lastUsableBalance;
    const usableBalance = balance?.status === "ready";
    const accountValue = resolveBullpenPreferredPortfolioValue([
      useVerifiedStage1Fallback ? null : activePositionsSummary?.walletValue,
      useVerifiedStage1Fallback || !usableBalance
        ? null
        : balance.account_value_usd,
      useVerifiedStage1Fallback ? null : activePositionsSummary?.totalValue,
    ]);
    const positionsSnapshotCash =
      typeof activePositionsSummary?.cashBalance === "number" &&
      Number.isFinite(activePositionsSummary.cashBalance)
        ? activePositionsSummary.cashBalance
        : null;
    const cash = useVerifiedStage1Fallback
      ? resolveBullpenPreferredPortfolioValue([
          verifiedStage1Portfolio?.cashInHandUsd ?? null,
        ])
      : resolveBullpenPreferredPortfolioValue([
          positionsSnapshotCash,
          usableBalance ? balance.available_balance_usd : null,
        ]);
    const cashUsesSeparateBalanceSnapshot =
      !useVerifiedStage1Fallback &&
      positionsSnapshotCash === null &&
      usableBalance;
    const pnl = useVerifiedStage1Fallback
      ? null
      : usableBalance
        ? (balance.pnl_usd ?? null)
        : null;
    const verifiedPositionsUpnl = verifiedActivePositions.reduce(
      (total, position) => total + (position.unrealizedPnl ?? 0),
      0,
    );
    const upnl = useVerifiedStage1Fallback
      ? verifiedPositionsUpnl
      : activePositionsSummary?.unrealizedPnl ??
        (usableBalance ? (balance.upnl_usd ?? null) : null);
    const openPositions = botState?.open_positions ?? [];
    const activePositionCount = hasActivePositionsSnapshot
      ? useVerifiedStage1Fallback && verifiedStage1Portfolio
        ? verifiedStage1Portfolio.activePositionsTotal
        : verifiedActivePositions.length
      : openPositions.filter((position) => position.shares > 0).length;
    const activeInvested = hasActivePositionsSnapshot
      ? verifiedActivePositions.reduce(
          (total, position) => total + (position.costBasis || 0),
          0,
        )
      : openPositions.reduce(
          (total, position) => total + (position.cost_basis || 0),
          0,
        );
    const claimableRows = (botState?.live.redeemed_trades ?? []).filter(
      (trade) => {
        const text = `${trade.status ?? ""} ${trade.detail ?? ""}`.toLowerCase();
        return (
          text.includes("claim") ||
          text.includes("redeem") ||
          text.includes("pending")
        );
      },
    );
    const claimableEventCount = hasActivePositionsSnapshot
      ? verifiedClaimablePositions.length
      : claimableRows.length;
    const claimableAmount = hasActivePositionsSnapshot
      ? verifiedClaimablePositions.reduce(
          (total, position) =>
            total +
            Math.max(
              0,
              position.claimableValue ??
                position.expectedPayoutUsd ??
                position.currentValue ??
                0,
            ),
          0,
        )
      : claimableRows.reduce(
          (total, trade) => total + Math.max(0, trade.amount || 0),
          0,
        );
    const currentInvestmentsValue = hasActivePositionsSnapshot
      ? sumCurrentPositionValue(verifiedActivePositions)
      : accountValue;
    const currentPortfolioPositionsValue = hasActivePositionsSnapshot
      ? (currentInvestmentsValue ?? 0) + claimableAmount
      : currentInvestmentsValue;
    const displayedTotalPortfolioValue = resolveBullpenTotalPortfolioValue({
      walletValue: activePositionsSummary?.walletValue,
      accountValue,
      summaryTotalValue: activePositionsSummary?.totalValue,
      cashBalance: cash,
      positionsValue: currentPortfolioPositionsValue,
      hasPositionsSnapshot: hasActivePositionsSnapshot,
      preferVerifiedComponents: useVerifiedStage1Fallback,
    });
    const positionsRefresh = useVerifiedStage1Fallback
      ? (verifiedStage1Portfolio?.verifiedAt ?? null)
      : (positions?.fetchedAt ?? null);
    const balanceRefresh = balance?.checked_at ?? null;
    const positionVerification = useVerifiedStage1Fallback
      ? `Positions verified by Stage 1: ${formatIstDateTime(
          verifiedStage1Portfolio?.verifiedAt,
        )}`
      : positions?.positionsSource === "redis-cache"
        ? "Positions verified by a fresh shared Bullpen refresh"
        : positions?.positionsSource === "tracked-positions"
          ? "Tracked-position fallback: stale, read-only wallet rows"
          : null;
    const positionsSource: BullpenPositionsSource | null =
      useVerifiedStage1Fallback
        ? ((verifiedStage1Portfolio?.lineage?.source as BullpenPositionsSource | null) ??
          null)
        : (positions?.positionsSource ?? null);
    const positionsLineage: BullpenPositionsSnapshotLineage | null =
      useVerifiedStage1Fallback
        ? (verifiedStage1Portfolio?.lineage ?? null)
        : (positions?.lineage ?? null);
    const lineageAccount = positionsLineage?.accountIdentity?.trim() || null;
    const displayedLineageAccount =
      lineageAccount && lineageAccount.length > 14
        ? `${lineageAccount.slice(0, 7)}…${lineageAccount.slice(-5)}`
        : lineageAccount;
    const displayedLineageSource =
      positionsLineage?.source?.trim() || positionsSource;
    const displayedClassifierVersion =
      typeof positionsLineage?.positionClassifierVersion === "number" &&
      Number.isFinite(positionsLineage.positionClassifierVersion)
        ? positionsLineage.positionClassifierVersion
        : null;
    const pendingConfirmationsCount =
      botState?.live.pending_confirmations.length ?? 0;
    const balanceStatus = liveBalance?.status ?? balance?.status ?? "not loaded";

    return {
      activeInvested,
      activePositionCount,
      balanceRefresh,
      balanceStatus,
      cash,
      cashUsesSeparateBalanceSnapshot,
      claimableAmount,
      claimableEventCount,
      currentInvestmentsValue,
      displayedClassifierVersion,
      displayedLineageAccount,
      displayedLineageSource,
      displayedTotalPortfolioValue,
      pendingConfirmationsCount,
      pnl,
      positionVerification,
      positionsRefresh,
      positionsVerifiedByStage1: useVerifiedStage1Fallback,
      upnl,
      usableBalance,
    };
  }, [botState, lastUsableBalance, positions, summary]);

  const metricCards = [
    {
      label: "Investment Value",
      value: formatMoney(view.currentInvestmentsValue),
      detail: "Current Investments Value",
    },
    {
      label: "Cash in hand",
      value: formatMoney(view.cash),
      detail: view.positionsVerifiedByStage1
        ? "Available pUSD · Stage 1 snapshot"
        : view.cashUsesSeparateBalanceSnapshot
          ? `Available pUSD · balance snapshot ${formatIstDateTime(
              view.balanceRefresh,
            )}`
          : "Available pUSD · wallet positions snapshot",
    },
    {
      label: "Events available for claim",
      value: view.claimableEventCount.toLocaleString("en-IN"),
      detail: formatMoney(view.claimableAmount),
    },
    {
      label: "Active positions",
      value: view.activePositionCount.toLocaleString("en-IN"),
      detail: `${formatMoney(view.activeInvested)} invested`,
    },
    {
      label: "PnL",
      value: formatMoney(view.pnl),
      detail: view.positionsVerifiedByStage1
        ? "Unavailable in Stage 1 snapshot"
        : `Realized PnL · balance snapshot ${formatIstDateTime(
            view.balanceRefresh,
          )}`,
    },
    {
      label: "uPnL",
      value: formatMoney(view.upnl),
      detail: "Unrealized PnL",
    },
    {
      label: "Live trades today",
      value: (botState?.live.live_trades_today ?? 0).toLocaleString("en-IN"),
      detail: `Mode: ${botState?.mode ?? "—"}`,
    },
    {
      label: "Pending confirmations",
      value: view.pendingConfirmationsCount.toLocaleString("en-IN"),
      detail: view.balanceStatus,
    },
  ];

  return (
    <div className="rounded-3xl border border-slate-200 bg-gradient-to-br from-slate-950 via-slate-900 to-sky-950 p-5 text-white shadow-xl shadow-slate-950/10">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-sky-100">
            <Wallet className="size-3.5" /> Bullpen Portfolio
          </div>
          <h3 className="mt-3 text-2xl font-semibold tracking-tight">
            {formatMoney(view.displayedTotalPortfolioValue)} Total Portfolio Value
          </h3>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void load(true)}
            disabled={refreshing}
            className="rounded-full border-sky-300/50 bg-sky-300/10 text-sky-100 hover:border-sky-200 hover:bg-sky-300/20 hover:text-white disabled:border-slate-500 disabled:bg-slate-700 disabled:text-slate-400"
          >
            <RefreshCw
              className={`mr-2 size-3.5 ${refreshing ? "animate-spin" : ""}`}
            />{" "}
            Refresh
          </Button>
          <span className="text-right text-[11px] text-slate-400">
            Wallet positions refresh: {formatIstDateTime(view.positionsRefresh)}
          </span>
          {view.usableBalance && !view.positionsVerifiedByStage1 ? (
            <span className="text-right text-[11px] text-slate-400">
              Balance refresh: {formatIstDateTime(view.balanceRefresh)}
            </span>
          ) : null}
          {view.positionVerification ? (
            <span className="text-right text-[11px] font-semibold text-emerald-300">
              {view.positionVerification}
            </span>
          ) : null}
          {refreshNotice ? (
            <span
              className="max-w-sm text-right text-[11px] font-medium text-amber-200"
              role="status"
            >
              {refreshNotice}
            </span>
          ) : null}
          {view.displayedLineageAccount ||
          view.displayedLineageSource ||
          view.displayedClassifierVersion !== null ? (
            <span className="text-right text-[11px] text-sky-200">
              {[
                view.displayedLineageAccount
                  ? `Wallet ${view.displayedLineageAccount}`
                  : null,
                view.displayedLineageSource
                  ? `source ${view.displayedLineageSource}`
                  : null,
                view.displayedClassifierVersion !== null
                  ? `classifier v${view.displayedClassifierVersion}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          ) : null}
        </div>
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {metricCards.map((metric) => (
          <div
            key={metric.label}
            className="rounded-[20px] border border-white/10 bg-white/10 px-4 py-3 text-left"
          >
            <div className="text-[11px] uppercase tracking-[0.16em] text-slate-300">
              {metric.label}
            </div>
            <div className="mt-2 text-xl font-semibold">{metric.value}</div>
            <div className="mt-1 text-xs text-slate-400">{metric.detail}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

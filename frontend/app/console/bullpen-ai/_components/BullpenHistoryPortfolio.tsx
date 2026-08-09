"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Wallet } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatApiTimestamp } from "@/lib/datetime";
import {
  isActiveBullpenPosition,
  isClaimableBullpenPosition,
  sumBullpenPortfolioPositionValue,
  sumCurrentPositionValue,
  type BullpenPositionsResponse,
} from "@/lib/bullpenPositions";
import { apiService } from "@/services/api";
import type { PolymarketBotState } from "@/types/api";

const money = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value)
    ? `$${value.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`
    : "—";

const refreshedAt = (value?: string | null) =>
  formatApiTimestamp(value, {
    emptyValue: "—",
    timeZone: "Asia/Kolkata",
    timeZoneName: "short",
    second: "2-digit",
  });

async function fetchPositions(forceFresh: boolean) {
  const params = new URLSearchParams({
    // Keep the history view on the exact same backend refresh lanes as the
    // main Bullpen x AI console. Both surfaces must resolve one shared wallet
    // snapshot rather than maintaining route-specific portfolio state.
    caller_source: forceFresh ? "ui-manual-refresh" : "ui-passive-refresh",
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
    throw new Error(payload.error || `Bullpen positions request failed (${response.status}).`);
  }
  return payload;
}

export function BullpenHistoryPortfolio() {
  const [positions, setPositions] = useState<BullpenPositionsResponse | null>(null);
  const [botState, setBotState] = useState<PolymarketBotState | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (forceFresh: boolean) => {
    setRefreshing(true);
    setNotice(null);
    try {
      // Start independent upstream reads together, but never let a failed or
      // slow balance refresh prevent the forced wallet-position refresh.
      const [balanceResult, positionsResult] = await Promise.allSettled([
        forceFresh
          ? apiService.polymarketLiveBalanceRefresh({ timeoutMs: 5_000 })
          : apiService.polymarketState({ timeoutMs: 5_000 }),
        fetchPositions(forceFresh),
      ]);
      if (positionsResult.status === "rejected") throw positionsResult.reason;
      const freshPositions = positionsResult.value;
      const latestStateResult = forceFresh
        ? await Promise.allSettled([apiService.polymarketState({ timeoutMs: 5_000 })])
        : null;
      const latestState = latestStateResult
        ? latestStateResult[0].status === "fulfilled"
          ? latestStateResult[0].value
          : balanceResult.status === "fulfilled"
            ? balanceResult.value
            : null
        : balanceResult.status === "fulfilled"
          ? balanceResult.value
          : null;
      setPositions(freshPositions);
      setBotState(latestState);
      if (freshPositions.liveAvailable !== true) {
        setNotice(
          freshPositions.fallback?.message ||
            freshPositions.error ||
            "Showing the latest verified wallet snapshot.",
        );
      } else if (balanceResult.status === "rejected") {
        setNotice(
          "Wallet positions are fresh, but the separate balance refresh is temporarily unavailable.",
        );
      }
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Bullpen portfolio refresh failed.",
      );
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    window.queueMicrotask(() => void load(false));
  }, [load]);

  const metrics = useMemo(() => {
    const rows = positions?.positions ?? [];
    const active = rows.filter(isActiveBullpenPosition);
    const claimable = rows.filter(isClaimableBullpenPosition);
    const cash =
      positions?.summary?.cashBalance ??
      botState?.live.balance.available_balance_usd ??
      null;
    const investments = sumCurrentPositionValue(active);
    return [
      ["Investment Value", money(investments), "Current investments value"],
      ["Cash in Hand", money(cash), "Available pUSD · wallet snapshot"],
      [
        "Events Available for Claim",
        claimable.length.toLocaleString("en-IN"),
        money(
          claimable.reduce(
            (sum, row) =>
              sum +
              Math.max(
                0,
                row.claimableValue ??
                  row.expectedPayoutUsd ??
                  row.currentValue ??
                  0,
              ),
            0,
          ),
        ),
      ],
      [
        "Active Positions",
        active.length.toLocaleString("en-IN"),
        `${money(active.reduce((sum, row) => sum + row.costBasis, 0))} invested`,
      ],
      ["PnL", money(botState?.live.balance.pnl_usd), "Realized PnL"],
      [
        "uPnL",
        money(
          positions?.summary?.unrealizedPnl ?? botState?.live.balance.upnl_usd,
        ),
        "Unrealized PnL",
      ],
      [
        "Live Trades Today",
        (botState?.live.live_trades_today ?? 0).toLocaleString("en-IN"),
        `Mode: ${botState?.mode ?? "—"}`,
      ],
      [
        "Pending Confirmations",
        (botState?.live.pending_confirmations.length ?? 0).toLocaleString("en-IN"),
        botState?.live.balance.status ?? "loading",
      ],
    ] as const;
  }, [botState, positions]);

  const rows = positions?.positions ?? [];
  const cash =
    positions?.summary?.cashBalance ??
    botState?.live.balance.available_balance_usd ??
    null;
  const total = positions
    ? sumBullpenPortfolioPositionValue(rows) + (cash ?? 0)
    : null;
  return (
    <section
      aria-labelledby="bullpen-portfolio-title"
      className="rounded-3xl border border-slate-800 bg-gradient-to-br from-slate-950 via-slate-900 to-sky-950 p-5 text-white shadow-xl shadow-slate-950/10"
    >
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[.2em] text-sky-100">
            <Wallet className="size-3.5" /> Bullpen Portfolio
          </div>
          <h2
            id="bullpen-portfolio-title"
            className="mt-3 text-2xl font-semibold tracking-tight"
          >
            {money(total)} Total Portfolio Value
          </h2>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void load(true)}
            disabled={refreshing}
            className="rounded-full border-sky-300/50 bg-sky-300/10 text-sky-100 hover:bg-sky-300/20 hover:text-white disabled:text-slate-400"
          >
            <RefreshCw
              className={`mr-2 size-3.5 ${refreshing ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
          <span className="text-right text-[11px] text-slate-400">
            Wallet positions refresh: {refreshedAt(positions?.fetchedAt)}
          </span>
          {positions?.positionsSource ? (
            <span className="text-right text-[11px] text-sky-200">
              source {positions.positionsSource}
              {positions.lineage?.positionClassifierVersion
                ? ` · classifier v${positions.lineage.positionClassifierVersion}`
                : ""}
            </span>
          ) : null}
          {notice ? (
            <span
              role="status"
              className="max-w-md text-right text-[11px] text-amber-200"
            >
              {notice}
            </span>
          ) : null}
        </div>
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map(([label, value, detail]) => (
          <div
            key={label}
            className="rounded-3xl border border-white/10 bg-white/10 px-5 py-4"
          >
            <p className="text-xs uppercase tracking-[.2em] text-slate-300">
              {label}
            </p>
            <p className="mt-3 text-2xl font-semibold">{value}</p>
            <p className="mt-2 text-sm text-slate-400">{detail}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

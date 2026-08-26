"use client";

import { useEffect, useState } from "react";

import type { BullpenPositionsResponse } from "@/lib/bullpenPositions";
import { apiService } from "@/services/api";
import type { DashboardSummaryResponse } from "@/types/api";

import { BullpenInteractiveIsland } from "./BullpenInteractiveIsland";
import { BullpenScanFiltersPopupBridge } from "./BullpenScanFiltersPopupBridge";

export function BullpenAiPageShell({
  summary,
}: {
  summary: DashboardSummaryResponse["bullpen"] | null;
}) {
  const [liveSummary, setLiveSummary] = useState(summary);

  useEffect(() => {
    let active = true;

    async function refreshSummary() {
      const positionsParams = new URLSearchParams({
        caller_source: "ui-passive-refresh",
        max_age_seconds: "20",
        passive: "true",
      });
      const [dashboardResult, positionsResult] = await Promise.allSettled([
        apiService.getDashboardSummary(),
        fetch(`/api/bullpen-ai/positions?${positionsParams.toString()}`, {
          cache: "no-store",
        }).then(async (response) => {
          if (!response.ok) {
            throw new Error(`Bullpen positions request failed with ${response.status}`);
          }
          return (await response.json()) as BullpenPositionsResponse;
        }),
      ]);
      if (!active) return;

      if (positionsResult.status === "fulfilled") {
        const payload = positionsResult.value;
        const positionsSummary =
          payload.summary ?? payload.lastSuccessfulLiveSnapshot?.summary;
        const fetchedAt =
          payload.fetchedAt ?? payload.lastSuccessfulLiveSnapshot?.fetchedAt;
        if (positionsSummary && fetchedAt) {
          setLiveSummary({
            active_count: positionsSummary.activeCount,
            claimable_count: positionsSummary.claimableCount,
            claimable_value: positionsSummary.claimableValue,
            cash_balance: positionsSummary.cashBalance,
            total_value: positionsSummary.totalValue,
            unrealized_pnl: positionsSummary.unrealizedPnl,
            wallet_value: positionsSummary.walletValue,
            fetched_at: fetchedAt,
            source: "redis-cache",
          });
          return;
        }
      }

      if (
        dashboardResult.status === "fulfilled" &&
        dashboardResult.value.bullpen
      ) {
        setLiveSummary(dashboardResult.value.bullpen);
        return;
      }

      const failure =
        dashboardResult.status === "rejected"
          ? dashboardResult.reason
          : positionsResult.status === "rejected"
            ? positionsResult.reason
            : null;
      console.warn("Bullpen passive summary refresh was unavailable.", {
        error_type: failure instanceof Error ? failure.name : "UnknownError",
      });
    }

    void refreshSummary();

    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6">
      <header
        className="rounded-3xl border border-purple-100 bg-white p-6 shadow-sm"
        data-performance-usable="bullpen-passive-summary"
      >
        <p className="text-sm font-semibold uppercase tracking-[0.22em] text-purple-600">
          Copy Trading Bots
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">
          Bullpen x AI
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
          Review the latest stored wallet state immediately. Interactive scans,
          histories, audits, prompts, and execution controls load below.
        </p>
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Active positions
            </p>
            <p className="mt-2 text-2xl font-semibold text-slate-950">
              {liveSummary?.active_count ?? "Loading…"}
            </p>
          </div>
          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Claimable
            </p>
            <p className="mt-2 text-2xl font-semibold text-slate-950">
              {liveSummary?.claimable_count ?? "Loading…"}
            </p>
          </div>
          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Stored snapshot
            </p>
            <p className="mt-2 text-sm font-semibold text-slate-950">
              {liveSummary?.fetched_at
                ? new Date(liveSummary.fetched_at).toLocaleString("en-IN", {
                    timeZone: "Asia/Kolkata",
                  })
                : "Loading…"}
            </p>
          </div>
        </div>
      </header>
      <BullpenInteractiveIsland />
      <BullpenScanFiltersPopupBridge />
    </div>
  );
}

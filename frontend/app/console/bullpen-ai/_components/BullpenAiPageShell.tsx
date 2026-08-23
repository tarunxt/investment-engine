"use client";

import { useEffect, useState } from "react";

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

    apiService
      .getDashboardSummary()
      .then((dashboardSummary) => {
        if (active && dashboardSummary.bullpen) {
          setLiveSummary(dashboardSummary.bullpen);
        }
      })
      .catch((error: unknown) => {
        console.warn("Bullpen passive summary refresh was unavailable.", {
          error_type: error instanceof Error ? error.name : "UnknownError",
        });
      });

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

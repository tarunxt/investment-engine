"use client";

import dynamic from "next/dynamic";

import type { DashboardSummaryResponse } from "@/types/api";

const DashboardPageClient = dynamic(
  () =>
    import("./DashboardPageClient").then((module) => module.DashboardPageClient),
  {
    ssr: false,
    loading: () => (
      <div
        className="h-48 animate-pulse rounded-3xl bg-slate-100"
        aria-label="Loading dashboard analytics"
      />
    ),
  },
);

export function DashboardInteractiveIsland({
  initialSummary,
}: {
  initialSummary: DashboardSummaryResponse | null;
}) {
  return (
    <div data-dashboard-analytics="mounted">
      <DashboardPageClient initialSummary={initialSummary} />
    </div>
  );
}

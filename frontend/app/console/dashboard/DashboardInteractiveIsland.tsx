"use client";

import dynamic from "next/dynamic";

import type { DashboardSummaryResponse } from "@/types/api";
import type {InitialDashboardScope} from '@/lib/dashboardScope';

const DashboardPageClient = dynamic(
  () =>
    import("./PersonalDashboard").then((module) => module.PersonalDashboard),
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
  initialScope,
}: {
  initialSummary: DashboardSummaryResponse | null;
  initialScope: InitialDashboardScope|null;
}) {
  return (
    <div data-dashboard-analytics="mounted">
      <DashboardPageClient initialSummary={initialSummary} initialScope={initialScope} />
    </div>
  );
}

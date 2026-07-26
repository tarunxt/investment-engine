"use client";

import dynamic from "next/dynamic";
import { useState } from "react";

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
  const [mounted, setMounted] = useState(false);

  if (!mounted) {
    return (
      <section
        className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm"
        data-dashboard-analytics="unmounted"
      >
        <h2 className="text-lg font-semibold text-slate-950">
          Charts and portfolio tools
        </h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
          Load interactive charts, refresh controls, threats, and workflow
          panels when you need them.
        </p>
        <button
          type="button"
          className="mt-4 rounded-full bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          onClick={() => setMounted(true)}
        >
          Open dashboard analytics
        </button>
      </section>
    );
  }

  return (
    <div data-dashboard-analytics="mounted">
      <DashboardPageClient initialSummary={initialSummary} />
    </div>
  );
}

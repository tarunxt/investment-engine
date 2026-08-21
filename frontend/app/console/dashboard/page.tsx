import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { BackendRuntimeHttpError } from "@/app/api/bullpen-ai/_lib/backendBullpenRuntime";
import {
  createBackendSessionContext,
  fetchBackendJsonWithSession,
} from "@/app/api/bullpen-ai/_lib/serverBackendSession";
import type { DashboardSummaryResponse } from "@/types/api";

import { DashboardInteractiveIsland } from "./DashboardInteractiveIsland";

function formatNativeMoney(value: number | null | undefined, currency: "INR" | "USD") {
  if (value == null || !Number.isFinite(value)) return "Unavailable";
  return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: currency === "INR" ? 0 : 2,
  }).format(value);
}

function DashboardServerOverview({
  summary,
}: {
  summary: DashboardSummaryResponse | null;
}) {
  const india = summary?.zerodha?.snapshot;
  const us = summary?.indmoney_us?.snapshot;
  const fxUsable = summary?.fx.status === "valid" && summary.fx.value != null;
  const convertedUs = fxUsable && us?.current_value != null
    ? us.current_value * summary.fx.value!
    : null;
  const combined =
    india && convertedUs != null
      ? india.holdings_market_value + convertedUs
      : null;

  return (
    <section
      className="rounded-3xl border border-indigo-100 bg-white p-6 shadow-sm"
      data-performance-usable="dashboard-server-summary"
      data-dashboard-source={summary ? "live-server-summary" : "unavailable"}
    >
      <p className="text-sm font-semibold uppercase tracking-[0.22em] text-indigo-600">
        Portfolio overview
      </p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">
        Dashboard
      </h1>
      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl bg-slate-50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            India portfolio
          </p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">
            {formatNativeMoney(india?.holdings_market_value, "INR")}
          </p>
        </div>
        <div className="rounded-2xl bg-slate-50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            US portfolio
          </p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">
            {formatNativeMoney(us?.current_value, "USD")}
          </p>
        </div>
        <div className="rounded-2xl bg-slate-50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Combined INR
          </p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">
            {formatNativeMoney(combined, "INR")}
          </p>
        </div>
      </div>
      <p className="mt-4 text-xs text-slate-500">
        {fxUsable
          ? `USD/INR ${summary!.fx.value} from ${summary!.fx.source}; as of ${new Date(
              summary!.fx.as_of!,
            ).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}.`
          : "USD/INR conversion unavailable or stale. Native USD values remain visible; combined INR is omitted."}
      </p>
    </section>
  );
}

export default async function DashboardPage() {
  let initialSummary: DashboardSummaryResponse | null = null;
  try {
    const requestHeaders = await headers();
    const session = await createBackendSessionContext({
      headers: requestHeaders,
    });
    initialSummary = await fetchBackendJsonWithSession<DashboardSummaryResponse>(
      session,
      "/dashboard/summary",
    );
  } catch (error) {
    if (error instanceof BackendRuntimeHttpError && error.status === 401) {
      redirect("/login?reason=session-expired");
    }
    console.warn("Initial dashboard summary was unavailable.", {
      error_type: error instanceof Error ? error.name : "UnknownError",
    });
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6">
      <DashboardServerOverview summary={initialSummary} />
      <DashboardInteractiveIsland initialSummary={initialSummary} />
    </div>
  );
}

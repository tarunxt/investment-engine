import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { BackendRuntimeHttpError } from "@/app/api/bullpen-ai/_lib/backendBullpenRuntime";
import {
  createBackendSessionContext,
  fetchBackendJsonWithSession,
} from "@/app/api/bullpen-ai/_lib/serverBackendSession";
import type { DashboardSummaryResponse } from "@/types/api";

import { BullpenAiPageShell } from "./_components/BullpenAiPageShell";

// Render on demand so protected Bullpen console requests cannot be served from a stale prerendered route artifact.
export const dynamic = "force-dynamic";

export default async function BullpenAiPage() {
  let bullpenSummary: DashboardSummaryResponse["bullpen"] | null = null;
  try {
    const requestHeaders = await headers();
    const session = await createBackendSessionContext({
      headers: requestHeaders,
    });
    const summary = await fetchBackendJsonWithSession<DashboardSummaryResponse>(
      session,
      "/dashboard/summary",
    );
    bullpenSummary = summary.bullpen;
  } catch (error) {
    if (error instanceof BackendRuntimeHttpError && error.status === 401) {
      redirect("/login?reason=session-expired");
    }
    console.warn("Initial Bullpen passive summary was unavailable.", {
      error_type: error instanceof Error ? error.name : "UnknownError",
    });
  }
  return <BullpenAiPageShell summary={bullpenSummary} />;
}

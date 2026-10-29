import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {auth} from '@/auth';
import {moduleScopeKey} from '@/lib/modulePolicy';
import type {InitialDashboardScope} from '@/lib/dashboardScope';

import { BackendRuntimeHttpError } from "@/app/api/bullpen-ai/_lib/backendBullpenRuntime";
import {
  createBackendSessionContext,
  fetchBackendJsonWithSession,
} from "@/app/api/bullpen-ai/_lib/serverBackendSession";
import type { DashboardSummaryResponse } from "@/types/api";

import { DashboardInteractiveIsland } from "./DashboardInteractiveIsland";

export default async function DashboardPage() {
  let initialSummary: DashboardSummaryResponse | null = null;
  let initialScope: InitialDashboardScope|null = null;
  try {
    const identity=await auth();
    const requestHeaders = await headers();
    const session = await createBackendSessionContext({
      headers: requestHeaders,
    });
    // Read only the owner policy before deciding whether portfolio data may load.
    const policy=await fetchBackendJsonWithSession<import('@/lib/modulePolicy').ModuleCollection>(session,'/me/modules');
    if(policy.owner_id===Number(identity?.user?.id)&&identity?.generation&&policy.modules.some(m=>m.selection.enabled&&m.availability.available&&m.capabilities.view?.allowed)){
      initialSummary = await fetchBackendJsonWithSession<DashboardSummaryResponse>(session,"/dashboard/summary");
      initialScope={owner:policy.owner_id,generation:identity.generation,policy:moduleScopeKey(policy)};
    }
  } catch (error) {
    if (error instanceof BackendRuntimeHttpError && error.status === 401) {
      redirect("/login?reason=session-expired");
    }
    console.warn("Initial dashboard summary was unavailable.", {
      error_type: error instanceof Error ? error.name : "UnknownError",
    });
  }

  return (
    <div className={process.env.NEXT_PUBLIC_UAT2==='true'?'mx-auto flex w-full max-w-7xl flex-col gap-6':'mx-auto flex w-full max-w-7xl flex-col gap-6 p-6'}>
      <DashboardInteractiveIsland initialSummary={initialSummary} initialScope={initialScope} />
    </div>
  );
}

import { requireBullpenOperator } from "@/app/api/bullpen-ai/_lib/operatorAdmission";
import { NextRequest, NextResponse } from "next/server";

import {
  createBackendSessionContext,
  fetchBackendJsonWithSession,
} from "../_lib/serverBackendSession";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const admission = await requireBullpenOperator(request);
  if (admission.response) return admission.response;
  const session = admission.session;
  const payload = await fetchBackendJsonWithSession(
    session,
    "/polymarket/runtime/health",
  );

  return NextResponse.json(payload, {
    status:
      payload && typeof payload === "object" && "ok" in payload && payload.ok
        ? 200
        : 503,
  });
}

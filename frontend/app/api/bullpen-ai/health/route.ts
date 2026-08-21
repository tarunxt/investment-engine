import { NextRequest, NextResponse } from "next/server";

import {
  createBackendSessionContext,
  fetchBackendJsonWithSession,
} from "../_lib/serverBackendSession";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const session = await createBackendSessionContext(request);
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

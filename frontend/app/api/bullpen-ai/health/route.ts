import { NextRequest, NextResponse } from "next/server";

import { fetchBackendRuntimeJson } from "../_lib/backendBullpenRuntime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const accessToken = request.cookies.get("app_access_token")?.value || null;
  const payload = await fetchBackendRuntimeJson("/polymarket/runtime/health", {
    accessToken,
  });

  return NextResponse.json(payload, {
    status:
      payload && typeof payload === "object" && "ok" in payload && payload.ok
        ? 200
        : 503,
  });
}

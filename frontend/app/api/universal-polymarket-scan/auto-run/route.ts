import { NextRequest, NextResponse } from "next/server";

import {
  backendSessionJson,
  createBackendSessionContext,
  fetchBackendJsonWithSession,
} from "@/app/api/bullpen-ai/_lib/serverBackendSession";
import { BackendRuntimeHttpError } from "@/app/api/bullpen-ai/_lib/backendBullpenRuntime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ActionBody = {
  action?: "save" | "enable" | "disable" | "run-now" | "pause" | "resume" | "kill";
  startAt?: string;
  refreshMinutes?: number;
};

function autoRunErrorResponse(error: unknown, fallback: string) {
  if (error instanceof BackendRuntimeHttpError) {
    return NextResponse.json(
      { error: error.message || fallback, detail: `Backend returned HTTP ${error.status}.` },
      { status: error.status },
    );
  }
  return NextResponse.json(
    {
      error: fallback,
      detail: error instanceof Error ? error.message : "The backend connection failed without further detail.",
    },
    { status: 502 },
  );
}

export async function GET(request: NextRequest) {
  const session = await createBackendSessionContext(request);
  if (!session.hasAuthJsSession || !session.accessToken) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  try {
    const result = await fetchBackendJsonWithSession(
      session,
      "/trading-bots/universal-scan/auto-run",
    );
    return backendSessionJson(session, result, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return autoRunErrorResponse(error, "Could not load Universal Scan auto-run status.");
  }
}

export async function POST(request: NextRequest) {
  const session = await createBackendSessionContext(request);
  if (!session.hasAuthJsSession || !session.accessToken) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  try {
    const body = await request.json() as ActionBody;
    const action = body.action ?? "save";
    const path = action === "save"
      ? "/trading-bots/universal-scan/auto-run/settings"
      : `/trading-bots/universal-scan/auto-run/${action}`;
    const result = await fetchBackendJsonWithSession(session, path, {
      method: "POST",
      body: action === "save" ? {
        start_at: body.startAt,
        refresh_minutes: body.refreshMinutes,
      } : {},
    });
    return backendSessionJson(session, result, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return autoRunErrorResponse(error, "Could not update Universal Scan auto-run.");
  }
}

import { NextRequest, NextResponse } from "next/server";

import {
  createBackendSessionContext,
  fetchBackendJsonWithSession,
} from "../_lib/serverBackendSession";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const session = await createBackendSessionContext(request);
    const payload = await fetchBackendJsonWithSession(
      session,
      "/api/sports-rankings/event-comparisons",
      { method: "POST", body },
    );
    return NextResponse.json(payload);
  } catch (error) {
    console.warn("Unable to load Sports event comparisons", error);
    return NextResponse.json(
      { comparisons: {}, error: "Sports ranking comparisons are temporarily unavailable." },
      { status: 503 },
    );
  }
}

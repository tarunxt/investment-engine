import { NextResponse } from "next/server";

import {
  buildBullpenHealthReport,
  readLastSuccessfulBullpenLiveSnapshot,
  syncBullpenLiveSnapshot,
} from "../_lib/bullpenHealth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const liveResult = await syncBullpenLiveSnapshot();
  const snapshot =
    liveResult.snapshot || (await readLastSuccessfulBullpenLiveSnapshot());
  const report = buildBullpenHealthReport({
    health: liveResult.health,
    snapshot,
  });

  return NextResponse.json(report, {
    status: liveResult.ok ? 200 : 503,
  });
}

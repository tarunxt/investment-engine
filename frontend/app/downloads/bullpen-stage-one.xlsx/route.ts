import { NextRequest } from "next/server";

import { GET as downloadStageOneExcel } from "@/app/api/bullpen-ai/stage-one.xlsx/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  return downloadStageOneExcel(request);
}

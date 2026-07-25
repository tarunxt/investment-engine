import { NextResponse } from "next/server";

import {
  GENERATED_BUILD_SHA,
  GENERATED_BUILD_TIMESTAMP,
} from "@/lib/generatedBuildInfo";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    {
      build_sha: GENERATED_BUILD_SHA,
      build_timestamp: GENERATED_BUILD_TIMESTAMP,
    },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    },
  );
}

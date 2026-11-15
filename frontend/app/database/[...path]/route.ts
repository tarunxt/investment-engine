import { protectedDatabaseDestination } from "@/lib/databaseViewerRoute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function forward(request: Request) {
  return protectedDatabaseDestination(request);
}

export const GET = forward;
export const HEAD = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
export const OPTIONS = forward;

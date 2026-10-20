import { NextResponse } from "next/server";
import { BackendRuntimeHttpError } from "./backendBullpenRuntime";
import { createBackendSessionContext, fetchBackendJsonWithSession } from "./serverBackendSession";

// Authorize from the current backend row before filesystem caches, exports or
// adapters. Auth.js/token claims alone cannot prove a non-revoked operator role.
export async function requireBullpenOperator(request: Request) {
  const session = await createBackendSessionContext(request);
  const deny = (status: number, error: string) => ({ session,
    response: NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } }) });
  if (!session.hasAuthJsSession || !session.accessToken) return deny(401, "Not authenticated");
  try {
    const user = await fetchBackendJsonWithSession<{ role?: string; is_active?: boolean }>(
      session, "/auth/me", { signal: AbortSignal.timeout(4_000) });
    if (user?.role !== "admin" || user?.is_active !== true) return deny(403, "Active administrator role required");
    return { session, response: null };
  } catch (error) {
    const status = error instanceof BackendRuntimeHttpError && [401, 403].includes(error.status)
      ? error.status : 503;
    return deny(status, status === 503 ? "Operator authorization unavailable" : "Not authorized");
  }
}

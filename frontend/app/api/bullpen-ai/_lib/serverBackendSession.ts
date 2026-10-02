import { createHash } from "node:crypto";

import { getToken } from "@auth/core/jwt";
import { NextResponse } from "next/server";

import { resolveNextAuthSecret, unstable_update } from "@/auth";
import {
  readCookieNames,
  resolveSessionCookieSecurity,
} from "@/lib/authSessionCookie";
import { ApiTransportDeadlineError } from "@/lib/boundedApiTransport";
import { SingleFlightByKey } from "@/lib/singleFlight";

import {
  BackendRuntimeHttpError,
  fetchBackendRuntimeJson,
} from "./backendBullpenRuntime";

type RotatedBackendTokens = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
};

type BackendRefreshResponse = {
  access_token?: string | null;
  refresh_token?: string | null;
  expires_in?: number | null;
};

export type BackendSessionContext = {
  accessToken: string | null;
  refreshToken: string | null;
  accessTokenExpiresAt: number | null;
  hasAuthJsSession: boolean;
  sessionGeneration: string;
  sessionSubject: string | null;
  rotatedTokens: RotatedBackendTokens | null;
};

const refreshFlights = new SingleFlightByKey<RotatedBackendTokens>();
// Leave time for the authenticated retry inside the standard four-second BFF
// budget. The shared flight owns this deadline, independently of its waiters.
const BACKEND_REFRESH_TIMEOUT_MS = 3_000;

function refreshFlightKey(refreshToken: string) {
  return createHash("sha256").update(refreshToken).digest("hex");
}

function waitIndependently<T>(promise: Promise<T>, signal?: AbortSignal) {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new DOMException("Request aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(new DOMException("Request aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function createBackendSessionContext(
  request: Request | { headers: Headers | Record<string, string> },
): Promise<BackendSessionContext> {
  const requestHeaders =
    request.headers instanceof Headers
      ? request.headers
      : new Headers(request.headers);
  const requestProtocol =
    request instanceof Request ? new URL(request.url).protocol : "http:";
  const secureCookie = resolveSessionCookieSecurity({
    cookieNames: readCookieNames(requestHeaders.get("cookie")),
    forwardedProtocol: requestHeaders.get("x-forwarded-proto"),
    requestProtocol,
    configuredAuthUrl:
      process.env.NEXTAUTH_URL ||
      process.env.AUTH_URL ||
      process.env.NEXT_PUBLIC_FRONTEND_URL,
  });

  let token = null;
  try {
    token = await getToken({
      req: request,
      secret: resolveNextAuthSecret(),
      secureCookie,
    });
  } catch (error) {
    // Treat malformed, expired, or undecryptable Auth.js cookies as
    // unauthenticated. Browser-readable bearer-cookie fallbacks are forbidden.
    console.warn("Unable to read Auth.js server session.", error);
  }

  const accessToken =
    typeof token?.accessToken === "string" ? token.accessToken.trim() : "";
  const refreshToken =
    typeof token?.refreshToken === "string" ? token.refreshToken.trim() : "";
  const expiresAt =
    typeof token?.accessTokenExpiresAt === "number" &&
    Number.isFinite(token.accessTokenExpiresAt)
      ? token.accessTokenExpiresAt
      : null;
  const generationParts = [
    typeof token?.sub === "string" ? token.sub : "",
    typeof token?.iat === "number" ? token.iat : "",
  ];
  const sessionSubject =
    typeof token?.sub === "string" && token.sub.trim() ? token.sub.trim() : null;

  return {
    accessToken: accessToken || null,
    refreshToken: refreshToken || null,
    accessTokenExpiresAt: expiresAt,
    hasAuthJsSession: Boolean(token),
    sessionGeneration: generationParts.join(":"),
    sessionSubject,
    rotatedTokens: null,
  };
}

export async function rotateBackendTokens(
  context: BackendSessionContext,
  signal?: AbortSignal,
) {
  if (signal?.aborted) {
    throw new DOMException("Request aborted", "AbortError");
  }
  if (!context.refreshToken) {
    throw new BackendRuntimeHttpError(
      401,
      { detail: "Not authenticated" },
      "Not authenticated",
    );
  }

  const currentRefreshToken = context.refreshToken;
  const key = refreshFlightKey(currentRefreshToken);
  const flight = refreshFlights.run(key, async () => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      BACKEND_REFRESH_TIMEOUT_MS,
    );
    try {
      // Abort the upstream fetch and retire the flight even if a stalled body
      // or transport does not settle on abort. Otherwise every later request
      // for this session can rejoin the same hung promise after its own 504.
      const refreshed = await waitIndependently(
        fetchBackendRuntimeJson<BackendRefreshResponse>("/auth/refresh", {
          method: "POST",
          body: { refresh_token: currentRefreshToken },
          signal: controller.signal,
        }),
        controller.signal,
      );
      const accessToken = refreshed.access_token?.trim() || null;
      const refreshToken = refreshed.refresh_token?.trim() || null;
      const expiresIn =
        typeof refreshed.expires_in === "number" &&
        Number.isFinite(refreshed.expires_in) &&
        refreshed.expires_in > 0
          ? refreshed.expires_in
          : 15 * 60;

      if (!accessToken || !refreshToken) {
        throw new Error("Backend token refresh returned incomplete credentials.");
      }
      return { accessToken, refreshToken, expiresIn };
    } catch (error) {
      if (controller.signal.aborted) throw new ApiTransportDeadlineError();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  });

  const rotated = await waitIndependently(flight, signal);
  context.accessToken = rotated.accessToken;
  context.refreshToken = rotated.refreshToken;
  context.accessTokenExpiresAt = Date.now() + rotated.expiresIn * 1_000;
  context.rotatedTokens = rotated;

  if (context.hasAuthJsSession) {
    // Persist only in the encrypted, HttpOnly Auth.js JWT.
    await unstable_update(rotated as never);
  }
}

export async function fetchBackendJsonWithSession<T = unknown>(
  context: BackendSessionContext,
  path: string,
  {
    body,
    method = "GET",
  }: {
    body?: unknown;
    method?: "GET" | "POST";
  } = {},
): Promise<T> {
  if (
    context.accessTokenExpiresAt !== null &&
    context.accessTokenExpiresAt <= Date.now()
  ) {
    await rotateBackendTokens(context);
  }

  try {
    return await fetchBackendRuntimeJson<T>(path, {
      accessToken: context.accessToken,
      body,
      method,
    });
  } catch (error) {
    if (!(error instanceof BackendRuntimeHttpError) || error.status !== 401) {
      throw error;
    }

    await rotateBackendTokens(context);
    return fetchBackendRuntimeJson<T>(path, {
      accessToken: context.accessToken,
      body,
      method,
    });
  }
}

export function backendSessionJson<T>(
  _context: BackendSessionContext,
  body: T,
  init?: ResponseInit,
) {
  return NextResponse.json(body, init);
}

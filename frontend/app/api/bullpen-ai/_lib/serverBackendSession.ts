import type { Session } from "next-auth";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { auth, unstable_update } from "@/auth";

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
  hasAuthJsSession: boolean;
  rotatedTokens: RotatedBackendTokens | null;
};

export async function createBackendSessionContext(
  request: NextRequest,
): Promise<BackendSessionContext> {
  let session: Session | null = null;
  try {
    session = await auth();
  } catch (error) {
    // A malformed/stale Auth.js cookie must not prevent the legacy cookie from
    // serving as a compatibility fallback while the user re-authenticates.
    console.warn("Unable to read Auth.js server session.", error);
  }

  const sessionAccessToken = session?.accessToken?.trim() || null;
  const sessionRefreshToken = session?.refreshToken?.trim() || null;
  const legacyAccessToken =
    request.cookies.get("app_access_token")?.value?.trim() || null;
  const legacyRefreshToken =
    request.cookies.get("app_refresh_token")?.value?.trim() || null;

  return {
    // Auth.js is authoritative. Client-created cookies remain supported only
    // for older sessions and staged deployments.
    accessToken: sessionAccessToken || legacyAccessToken,
    refreshToken: sessionRefreshToken || legacyRefreshToken,
    hasAuthJsSession: Boolean(session),
    rotatedTokens: null,
  };
}

async function rotateBackendTokens(context: BackendSessionContext) {
  if (!context.refreshToken) {
    throw new BackendRuntimeHttpError(
      401,
      { detail: "Not authenticated" },
      "Not authenticated",
    );
  }

  const refreshed = await fetchBackendRuntimeJson<BackendRefreshResponse>(
    "/auth/refresh",
    {
      method: "POST",
      body: { refresh_token: context.refreshToken },
    },
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

  context.accessToken = accessToken;
  context.refreshToken = refreshToken;
  context.rotatedTokens = { accessToken, refreshToken, expiresIn };

  if (context.hasAuthJsSession) {
    // Persist the rotated pair in the encrypted Auth.js JWT. Without this,
    // the next hard navigation can restore the access token that just failed.
    await unstable_update({ accessToken, refreshToken, expiresIn });
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
  context: BackendSessionContext,
  body: T,
  init?: ResponseInit,
) {
  const response = NextResponse.json(body, init);
  const rotated = context.rotatedTokens;
  if (!rotated) {
    return response;
  }

  const secure = process.env.NODE_ENV === "production";
  response.cookies.set("app_access_token", rotated.accessToken, {
    maxAge: rotated.expiresIn,
    path: "/",
    sameSite: "lax",
    secure,
  });
  response.cookies.set("app_refresh_token", rotated.refreshToken, {
    maxAge: 30 * 24 * 60 * 60,
    path: "/",
    sameSite: "lax",
    secure,
  });
  return response;
}

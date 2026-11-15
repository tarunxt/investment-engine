import { getToken } from "next-auth/jwt";
import {
  buildLoginRedirectHref,
  resolveAuthRedirectTarget,
  stripRedirectToFromCurrentUrl,
} from "@/lib/authRedirect";
import { resolveSessionCookieSecurity } from "@/lib/authSessionCookie";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type { JWT } from "next-auth/jwt";

const protectedRoutePrefixes = ["/console", "/dashboard", "/profile"] as const;
const authRoutePrefixes = [
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
] as const;

function resolveNextAuthSecret(): string {
  const configuredSecret = process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET;
  if (configuredSecret) {
    return configuredSecret;
  }

  return "local-auth-disabled-fallback-secret";
}

function pathMatchesPrefix(path: string, prefix: string) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function isProtectedAppPath(path: string) {
  return protectedRoutePrefixes.some((prefix) => pathMatchesPrefix(path, prefix));
}

function isAuthPath(path: string) {
  return authRoutePrefixes.some((prefix) => pathMatchesPrefix(path, prefix));
}

function isAuthBypassed() {
  return (
    process.env.NEXT_PUBLIC_DISABLE_AUTH === "true" ||
    process.env.NODE_ENV === "development"
  );
}

async function readSessionToken(req: NextRequest): Promise<JWT | null> {
  const secureCookie = resolveSessionCookieSecurity({
    cookieNames: req.cookies.getAll().map(({ name }) => name),
    forwardedProtocol: req.headers.get("x-forwarded-proto"),
    requestProtocol: req.nextUrl.protocol,
    configuredAuthUrl:
      process.env.NEXTAUTH_URL ||
      process.env.AUTH_URL ||
      process.env.NEXT_PUBLIC_FRONTEND_URL,
  });

  return getToken({
    req,
    secret: resolveNextAuthSecret(),
    secureCookie,
  });
}

function attachAuthTiming(response: NextResponse, durationMs: number) {
  response.headers.append(
    "Server-Timing",
    `authjs;dur=${durationMs.toFixed(1)};desc="Auth.js session resolution"`,
  );
  return response;
}

export async function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const isAuthRoute = isAuthPath(path);
  const isProtectedAppRoute = isProtectedAppPath(path);

  if (isProtectedAppRoute && req.nextUrl.searchParams.has("redirectTo")) {
    const cleanedPath = stripRedirectToFromCurrentUrl(
      req.nextUrl.pathname,
      req.nextUrl.searchParams.toString(),
    );
    const currentPath = req.nextUrl.search
      ? `${req.nextUrl.pathname}${req.nextUrl.search}`
      : req.nextUrl.pathname;

    if (cleanedPath !== currentPath) {
      return NextResponse.redirect(new URL(cleanedPath, req.url));
    }
  }

  if (isAuthBypassed()) {
    if (isAuthRoute) {
      const redirectTo = resolveAuthRedirectTarget(
        req.nextUrl.searchParams.get("redirectTo"),
      );
      return NextResponse.redirect(new URL(redirectTo, req.url));
    }
    return NextResponse.next();
  }

  const authStartedAt = performance.now();
  let token: JWT | null = null;
  try {
    token = await readSessionToken(req);
  } catch (error) {
    console.error("Authentication proxy failed to decode session token:", error);
  }
  const authDurationMs = performance.now() - authStartedAt;

  if (!token) {
    if (isAuthRoute) {
      return attachAuthTiming(NextResponse.next(), authDurationMs);
    }

    const loginHref = buildLoginRedirectHref(
      req.nextUrl.pathname,
      req.nextUrl.searchParams.toString(),
    );
    const response = NextResponse.redirect(new URL(loginHref, req.url));
    response.cookies.delete("authjs.session-token");
    response.cookies.delete("__Secure-authjs.session-token");
    return attachAuthTiming(response, authDurationMs);
  }

  if (isAuthRoute) {
    const redirectTo = resolveAuthRedirectTarget(
      req.nextUrl.searchParams.get("redirectTo"),
    );
    return attachAuthTiming(
      NextResponse.redirect(new URL(redirectTo, req.url)),
      authDurationMs,
    );
  }

  if (path.startsWith("/console/admin") && token.role !== "admin") {
    return attachAuthTiming(
      NextResponse.redirect(new URL("/console/dashboard", req.url)),
      authDurationMs,
    );
  }

  return attachAuthTiming(NextResponse.next(), authDurationMs);
}

export const config = {
  matcher: [
    "/login",
    "/register",
    "/forgot-password",
    "/reset-password/:path*",
    "/console/:path*",
    "/dashboard/:path*",
    "/profile/:path*",
  ],
};

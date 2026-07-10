import { getToken } from "next-auth/jwt";
import {
  buildLoginRedirectHref,
  resolveAuthRedirectTarget,
  stripRedirectToFromCurrentUrl,
} from "@/lib/authRedirect";
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
  return getToken({
    req,
    secret: resolveNextAuthSecret(),
    secureCookie: req.nextUrl.protocol === "https:",
  });
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

  let token: JWT | null = null;
  try {
    token = await readSessionToken(req);
  } catch (error) {
    console.error("Authentication proxy failed to decode session token:", error);
  }

  if (!token) {
    if (isAuthRoute) {
      return NextResponse.next();
    }

    const loginHref = buildLoginRedirectHref(
      req.nextUrl.pathname,
      req.nextUrl.searchParams.toString(),
    );
    const response = NextResponse.redirect(new URL(loginHref, req.url));
    response.cookies.delete("authjs.session-token");
    response.cookies.delete("__Secure-authjs.session-token");
    return response;
  }

  if (isAuthRoute) {
    const redirectTo = resolveAuthRedirectTarget(
      req.nextUrl.searchParams.get("redirectTo"),
    );
    return NextResponse.redirect(new URL(redirectTo, req.url));
  }

  if (path.startsWith("/console/admin") && token.role !== "admin") {
    return NextResponse.redirect(new URL("/console/dashboard", req.url));
  }

  return NextResponse.next();
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

import { auth } from "@/app/api/auth/[...nextauth]/route";
import {
  buildLoginRedirectHref,
  resolveAuthRedirectTarget,
  stripRedirectToFromCurrentUrl,
} from "@/lib/authRedirect";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type { Session } from "next-auth";

const protectedRoutePrefixes = ["/console", "/dashboard", "/profile"] as const;
const authRoutePrefixes = [
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
] as const;

function pathMatchesPrefix(path: string, prefix: string) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function isProtectedAppPath(path: string) {
  return protectedRoutePrefixes.some((prefix) => pathMatchesPrefix(path, prefix));
}

function isAuthPath(path: string) {
  return authRoutePrefixes.some((prefix) => pathMatchesPrefix(path, prefix));
}

type AuthenticatedProxyHandler = (
  request: NextRequest,
) => ReturnType<typeof authenticatedProxy>;

const authenticatedProxy = auth((req: NextRequest & { auth: Session | null }) => {
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

  if (
    process.env.NEXT_PUBLIC_DISABLE_AUTH === "true" ||
    process.env.NODE_ENV === "development"
  ) {
    if (
      path === "/login" ||
      path === "/register" ||
      path === "/forgot-password" ||
      path.startsWith("/reset-password")
    ) {
      const redirectTo = resolveAuthRedirectTarget(
        req.nextUrl.searchParams.get("redirectTo"),
      );
      return NextResponse.redirect(new URL(redirectTo, req.url));
    }
    return NextResponse.next();
  }

  const token = req.auth;

  // Not logged in
  if (!token) {
    if (isAuthRoute) {
      return NextResponse.next();
    }

    const loginHref = buildLoginRedirectHref(
      req.nextUrl.pathname,
      req.nextUrl.searchParams.toString(),
    );
    return NextResponse.redirect(new URL(loginHref, req.url));
  }

  if (isAuthRoute) {
    const redirectTo = resolveAuthRedirectTarget(
      req.nextUrl.searchParams.get("redirectTo"),
    );
    return NextResponse.redirect(new URL(redirectTo, req.url));
  }

  // Admin route protection
  if (
    path.startsWith("/console/admin") &&
    (token.user as Record<string, unknown>)?.role !== "admin"
  ) {
    return NextResponse.redirect(
      new URL("/console/dashboard", req.url)
    );
  }

  return NextResponse.next();
});

export async function proxy(req: NextRequest) {
  try {
    const runAuthenticatedProxy =
      authenticatedProxy as AuthenticatedProxyHandler;
    return await runAuthenticatedProxy(req);
  } catch (error) {
    console.error("Authentication proxy failed:", error);

    if (isProtectedAppPath(req.nextUrl.pathname)) {
      const loginHref = buildLoginRedirectHref(
        req.nextUrl.pathname,
        req.nextUrl.searchParams.toString(),
      );
      const response = NextResponse.redirect(new URL(loginHref, req.url));
      response.cookies.delete("authjs.session-token");
      response.cookies.delete("__Secure-authjs.session-token");
      return response;
    }

    return NextResponse.next();
  }
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

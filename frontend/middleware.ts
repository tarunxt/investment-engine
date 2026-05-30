import { auth } from "@/app/api/auth/[...nextauth]/route";
import {
  buildLoginRedirectHref,
  resolveAuthRedirectTarget,
  stripRedirectToFromCurrentUrl,
} from "@/lib/authRedirect";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type { Session } from "next-auth";

export default auth((req: NextRequest & { auth: Session | null }) => {
  const path = req.nextUrl.pathname;
  const isProtectedAppRoute =
    path.startsWith("/console") ||
    path.startsWith("/dashboard") ||
    path.startsWith("/profile");

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
    const loginHref = buildLoginRedirectHref(
      req.nextUrl.pathname,
      req.nextUrl.searchParams.toString(),
    );
    return NextResponse.redirect(new URL(loginHref, req.url));
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

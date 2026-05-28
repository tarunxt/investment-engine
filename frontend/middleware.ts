import { auth } from "@/app/api/auth/[...nextauth]/route";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type { Session } from "next-auth";

export default auth((req: NextRequest & { auth: Session | null }) => {
  const path = req.nextUrl.pathname;

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
      return NextResponse.redirect(new URL("/console/dashboard", req.url));
    }
    return NextResponse.next();
  }

  const token = req.auth;

  // Not logged in
  if (!token) {
    return NextResponse.redirect(
      new URL("/login", req.url)
    );
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

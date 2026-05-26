import { auth } from "@/app/api/auth/[...nextauth]/route";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type { Session } from "next-auth";

export default auth((req: NextRequest & { auth: Session | null }) => {
  const token = req.auth;
  const path = req.nextUrl.pathname;

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
    "/console/:path*",
    "/dashboard/:path*",
    "/profile/:path*",
  ],
};
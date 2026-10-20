"use client";

import { SessionProvider } from "next-auth/react";
import type { Session } from "next-auth";
import type { UserResponse } from "@/types/api";
import { AuthProvider } from "@/providers/AuthProvider";
import dynamic from "next/dynamic";
const ModuleProvider = dynamic(() => import("@/providers/ModuleProvider").then(m => m.ModuleProvider), {ssr:false, loading:()=> <p role="status">Loading workspace policy…</p>});
import { ThemeProvider } from "@/providers/ThemeProvider";

export function ConsoleProviders({
  children,
  initialUser,
  initialSession,
}: {
  children: React.ReactNode;
  initialUser: UserResponse;
  initialSession: Session;
}) {
  return (
    <SessionProvider
      session={initialSession}
      refetchOnWindowFocus={true}
      refetchInterval={30}
    >
      <AuthProvider initialUser={initialUser}>
        <ThemeProvider><ModuleProvider>{children}</ModuleProvider></ThemeProvider>
      </AuthProvider>
    </SessionProvider>
  );
}

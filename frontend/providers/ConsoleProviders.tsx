"use client";

import { SessionProvider } from "next-auth/react";
import type { Session } from "next-auth";
import type { UserResponse } from "@/types/api";
import { AuthProvider } from "@/providers/AuthProvider";
import { ModuleProvider } from "@/providers/ModuleProvider";
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

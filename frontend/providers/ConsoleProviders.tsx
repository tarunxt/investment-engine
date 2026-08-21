"use client";

import { SessionProvider } from "next-auth/react";
import type { Session } from "next-auth";
import type { UserResponse } from "@/types/api";
import { AuthProvider } from "@/providers/AuthProvider";
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
      refetchOnWindowFocus={false}
    >
      <AuthProvider initialUser={initialUser}>
        <ThemeProvider>{children}</ThemeProvider>
      </AuthProvider>
    </SessionProvider>
  );
}

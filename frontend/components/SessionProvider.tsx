"use client";

import { SessionProvider as NextAuthSessionProvider } from "next-auth/react";

// Simple wrapper that doesn't use useAuth
export function SessionProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextAuthSessionProvider>
      {children}
    </NextAuthSessionProvider>
  );
}
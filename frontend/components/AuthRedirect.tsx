"use client";

import { useAuth } from "@/hooks/useAuth";
import { URLs } from "@/lib/urls";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function AuthRedirect({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { isAuthenticated, loading } = useAuth();

  useEffect(() => {
    if (!loading && isAuthenticated) {
      router.push(URLs.routes.console.dashboard());
    }
  }, [isAuthenticated, loading, router]);

  if (isAuthenticated) {
    return null;
  }

  return <>{children}</>;
}

"use client";

import { useAuth } from "@/hooks/useAuth";
import { URLs } from "@/lib/urls";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

const devAuthEnabled = process.env.NEXT_PUBLIC_DISABLE_AUTH === "true";

export function AuthRedirect({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { isAuthenticated, loading } = useAuth();

  useEffect(() => {
    if (devAuthEnabled || (!loading && isAuthenticated)) {
      router.push(URLs.routes.console.dashboard());
    }
  }, [isAuthenticated, loading, router]);

  if (devAuthEnabled || isAuthenticated) {
    return null;
  }

  return <>{children}</>;
}

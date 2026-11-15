"use client";

import { useAuth } from "@/hooks/useAuth";
import { isClientAuthBypassed, resolveAuthRedirectTarget } from "@/lib/authRedirect";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

export function AuthRedirect({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isAuthenticated, loading } = useAuth();
  const redirectTo = resolveAuthRedirectTarget(searchParams.get("redirectTo"));

  useEffect(() => {
    if (isClientAuthBypassed || (!loading && isAuthenticated)) {
      router.replace(redirectTo || "/console/dashboard");
    }
  }, [isAuthenticated, loading, redirectTo, router]);

  if (isClientAuthBypassed || isAuthenticated) {
    return null;
  }

  return <>{children}</>;
}

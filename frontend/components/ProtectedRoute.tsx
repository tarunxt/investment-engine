"use client";

import { useAuth } from "@/hooks/useAuth";
import { buildLoginRedirectHref, isClientAuthBypassed } from "@/lib/authRedirect";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { isAuthenticated, loading } = useAuth();

  useEffect(() => {
    if (isClientAuthBypassed) return;
    if (!loading && !isAuthenticated) {
      router.replace(buildLoginRedirectHref(pathname, searchParams.toString()));
    }
  }, [isAuthenticated, loading, pathname, router, searchParams]);

  if (!isClientAuthBypassed && loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600"></div>
      </div>
    );
  }

  if (!isClientAuthBypassed && !isAuthenticated) {
    return null;
  }

  return <>{children}</>;
}

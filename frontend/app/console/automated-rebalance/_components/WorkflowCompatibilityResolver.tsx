"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import { WORKFLOW_STATE_KEY, WORKFLOW_CACHE_OWNER_KEY, workflowCompatibilityDestination } from "@/lib/workflowCompatibility";
export function WorkflowCompatibilityResolver() {
  const { user, loading } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (loading || !user?.is_active) return;
    const timer = window.setTimeout(() => {
      let destination = "/console/zerodha#india-workflow";
      try { destination = workflowCompatibilityDestination(localStorage.getItem(WORKFLOW_STATE_KEY), localStorage.getItem(WORKFLOW_CACHE_OWNER_KEY), user.id); } catch { /* Storage denial uses the fixed safe default. */ }
      router.replace(destination);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loading, user?.id, user?.is_active, router]);
  return <p role="status">Opening portfolio workflow…</p>;
}

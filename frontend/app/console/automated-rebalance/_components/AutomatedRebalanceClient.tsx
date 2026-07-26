"use client";

import { useCallback } from "react";

import { RebalanceWorkflowSections } from "@/app/console/dashboard/_components/RebalanceWorkflowSections";
import { apiService } from "@/services/api";

export function AutomatedRebalanceClient() {
  const refreshSummary = useCallback(async () => {
    // The workflow historically refreshed the embedded dashboard after sync
    // and completion. On the dedicated route, retain that consistency check
    // without remounting the dashboard or loading its detailed panels.
    await apiService.getDashboardSummary();
  }, []);

  return <RebalanceWorkflowSections onDashboardRefresh={refreshSummary} />;
}

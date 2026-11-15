"use client";

import type { WorkflowSurface } from "@/app/console/_components/WorkflowSurfaceHost";
import { RebalanceWorkflowSections } from "@/app/console/dashboard/_components/RebalanceWorkflowSections";
import { installAutomatedRebalanceStartRecovery } from "./automatedRebalanceStartRecovery";

installAutomatedRebalanceStartRecovery();

export function AutomatedRebalanceClient({ surface }: { surface?: WorkflowSurface | null }) {
  return (
    <RebalanceWorkflowSections stageLedger surface={surface} />
  );
}

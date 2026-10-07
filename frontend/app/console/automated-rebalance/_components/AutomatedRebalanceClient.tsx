"use client";

import { RebalanceWorkflowSections } from "@/app/console/dashboard/_components/RebalanceWorkflowSections";
import { installAutomatedRebalanceStartRecovery } from "./automatedRebalanceStartRecovery";
import { AutomatedRebalanceReliabilityBridge } from "./AutomatedRebalanceReliabilityBridge";

installAutomatedRebalanceStartRecovery();

export function AutomatedRebalanceClient() {
  return (
    <AutomatedRebalanceReliabilityBridge>
      <RebalanceWorkflowSections />
    </AutomatedRebalanceReliabilityBridge>
  );
}

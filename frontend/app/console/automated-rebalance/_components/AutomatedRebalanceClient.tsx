"use client";

import { RebalanceWorkflowSections } from "@/app/console/dashboard/_components/RebalanceWorkflowSections";
import { installAutomatedRebalanceStartRecovery } from "./automatedRebalanceStartRecovery";
import { AutomatedRebalanceReliabilityBridge } from "./AutomatedRebalanceReliabilityBridge";

import { ServerAnalysis } from "./ServerAnalysis";

installAutomatedRebalanceStartRecovery();

export function AutomatedRebalanceClient() {
  return (
    <AutomatedRebalanceReliabilityBridge>
      <ServerAnalysis />
      <RebalanceWorkflowSections />
    </AutomatedRebalanceReliabilityBridge>
  );
}

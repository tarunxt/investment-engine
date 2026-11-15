import type { BullpenWorkspaceProfile } from "@/lib/bullpenStageOneSettings";

export function bullpenWorkspacePath(profile: BullpenWorkspaceProfile) {
  return profile === "bullpen-sports"
    ? "/console/bullpen-sports"
    : "/console/bullpen-ai";
}

export function bullpenWorkspaceHistoryPath(profile: BullpenWorkspaceProfile) {
  return `${bullpenWorkspacePath(profile)}/history`;
}

export function bullpenWorkspaceRunPath(
  profile: BullpenWorkspaceProfile,
  runId: string,
) {
  return `${bullpenWorkspacePath(profile)}/runs/${encodeURIComponent(runId)}`;
}

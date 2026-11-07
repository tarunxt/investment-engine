"use client";

import { useParams } from "next/navigation";

import { BullpenRunDetailScreen } from "../../_components/BullpenAutoRunScheduleCard";
import type { BullpenWorkspaceProfile } from "@/lib/bullpenStageOneSettings";

export function RunDetailClient({
  workspaceProfile = "bullpen007",
}: {
  workspaceProfile?: BullpenWorkspaceProfile;
}) {
  const params = useParams<{ runId: string | string[] }>();
  const runId = Array.isArray(params.runId) ? params.runId[0] : params.runId;

  return (
    <BullpenRunDetailScreen
      runId={runId ?? ""}
      workspaceProfile={workspaceProfile}
    />
  );
}

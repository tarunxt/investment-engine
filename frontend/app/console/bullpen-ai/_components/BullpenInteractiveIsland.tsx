"use client";

import dynamic from "next/dynamic";
import type { BullpenWorkspaceProfile } from "@/lib/bullpenStageOneSettings";

const BullpenAiPageClient = dynamic(() => import("./BullpenAiPageClient"), {
  ssr: false,
  loading: () => (
    <div
      className="h-48 animate-pulse rounded-3xl bg-slate-100"
      aria-label="Loading Bullpen workspace"
    />
  ),
});

export function BullpenInteractiveIsland({
  workspaceProfile = "bullpen007",
}: {
  workspaceProfile?: BullpenWorkspaceProfile;
}) {
  return (
    <div data-bullpen-workspace="mounted" data-workspace-profile={workspaceProfile}>
      <BullpenAiPageClient workspaceProfile={workspaceProfile} />
    </div>
  );
}

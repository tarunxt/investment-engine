"use client";

import { BullpenInteractiveIsland } from "./BullpenInteractiveIsland";
import { BullpenScanFiltersPopupBridge } from "./BullpenScanFiltersPopupBridge";
import type { BullpenWorkspaceProfile } from "@/lib/bullpenStageOneSettings";

export function BullpenAiPageShell({
  workspaceProfile = "bullpen007",
}: {
  workspaceProfile?: BullpenWorkspaceProfile;
}) {
  return (
    <div
      className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6"
      data-bullpen-workspace-profile={workspaceProfile}
    >
      {workspaceProfile === "bullpen007" ? (
        <>
          <BullpenInteractiveIsland />
          <BullpenScanFiltersPopupBridge />
        </>
      ) : (
        <>
          <BullpenInteractiveIsland workspaceProfile={workspaceProfile} />
          <BullpenScanFiltersPopupBridge workspaceProfile={workspaceProfile} />
        </>
      )}
    </div>
  );
}

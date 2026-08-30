"use client";

import { BullpenInteractiveIsland } from "./BullpenInteractiveIsland";
import { BullpenScanFiltersPopupBridge } from "./BullpenScanFiltersPopupBridge";

export function BullpenAiPageShell() {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6">
      <BullpenInteractiveIsland />
      <BullpenScanFiltersPopupBridge />
    </div>
  );
}

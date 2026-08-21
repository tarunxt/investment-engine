"use client";

import dynamic from "next/dynamic";

const BullpenAiPageClient = dynamic(() => import("./BullpenAiPageClient"), {
  ssr: false,
  loading: () => (
    <div
      className="h-48 animate-pulse rounded-3xl bg-slate-100"
      aria-label="Loading Bullpen workspace"
    />
  ),
});

export function BullpenInteractiveIsland() {
  return (
    <div data-bullpen-workspace="mounted">
      <BullpenAiPageClient />
    </div>
  );
}

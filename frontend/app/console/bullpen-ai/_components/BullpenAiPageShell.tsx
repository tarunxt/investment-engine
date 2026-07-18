"use client";

import dynamic from "next/dynamic";

function BullpenAiPageFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600" />
    </div>
  );
}

const BullpenAiPageClient = dynamic(() => import("./BullpenAiPageClient"), {
  loading: BullpenAiPageFallback,
  ssr: false,
});

export function BullpenAiPageShell() {
  return <BullpenAiPageClient />;
}

"use client";

import dynamic from "next/dynamic";

import { usePersistentInteractiveIsland } from "@/app/console/_components/usePersistentInteractiveIsland";

const BULLPEN_WORKSPACE_STORAGE_KEY = "investor:bullpen-workspace:open";

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
  const { isOpen, open } = usePersistentInteractiveIsland(
    BULLPEN_WORKSPACE_STORAGE_KEY,
  );

  if (!isOpen) {
    return (
      <section
        className="rounded-3xl border border-fuchsia-100 bg-white p-5 shadow-sm"
        data-bullpen-workspace="unmounted"
      >
        <h2 className="text-lg font-semibold text-slate-950">
          Interactive workspace
        </h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
          Active positions, scans, histories, audits, prompts, and automated
          controls load only when you open the workspace.
        </p>
        <button
          type="button"
          className="mt-4 rounded-full bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          onClick={open}
        >
          Open live workspace
        </button>
      </section>
    );
  }

  return (
    <div data-bullpen-workspace="mounted">
      <BullpenAiPageClient />
    </div>
  );
}

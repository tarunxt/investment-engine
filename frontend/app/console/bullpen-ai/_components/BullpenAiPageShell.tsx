"use client";

import dynamic from "next/dynamic";

function BullpenAiPageFallback() {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6" aria-busy="true">
      <div className="space-y-3">
        <div className="h-4 w-36 animate-pulse rounded bg-purple-100" />
        <div className="h-9 w-64 animate-pulse rounded bg-slate-200" />
      </div>
      <section className="rounded-3xl border border-fuchsia-100 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap gap-2">
          <span className="h-7 w-36 animate-pulse rounded-full bg-fuchsia-100" />
          <span className="h-7 w-28 animate-pulse rounded-full bg-slate-100" />
          <span className="h-7 w-28 animate-pulse rounded-full bg-slate-100" />
        </div>
        <div className="mt-5 grid gap-3 lg:grid-cols-3">
          <div className="h-24 animate-pulse rounded-2xl bg-slate-100" />
          <div className="h-24 animate-pulse rounded-2xl bg-slate-100" />
          <div className="h-24 animate-pulse rounded-2xl bg-slate-100" />
        </div>
      </section>
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

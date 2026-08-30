"use client";

import dynamic from "next/dynamic";

const Bullpen008PageClient = dynamic(
  () => import("./Bullpen008PageClient").then((module) => module.Bullpen008PageClient),
  {
    ssr: false,
    loading: () => (
      <div className="h-48 animate-pulse rounded-3xl bg-slate-100" aria-label="Loading Bullpen 008 workspace" />
    ),
  },
);

export function Bullpen008PageShell() {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6">
      <Bullpen008PageClient />
    </div>
  );
}

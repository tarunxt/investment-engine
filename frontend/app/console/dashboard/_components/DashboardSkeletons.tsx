import type { ReactNode } from "react";

import { SkeletonLoader } from "@/components/shared/Loader";

function DashboardSurface({
  children,
  className = "",
  label,
  deferred = false,
}: {
  label: string;
  deferred?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      role="status"
      aria-busy={!deferred}
      className={`overflow-hidden rounded-[32px] border border-slate-200 bg-white shadow-sm ${className}`}
    >
      <p className="px-6 pt-5 text-sm font-semibold text-slate-700">{label}</p>
      <div aria-hidden="true">{children}</div>
    </section>
  );
}

export function DashboardHeroSkeleton() {
  return (
    <DashboardSurface label="Loading portfolio summary…">
      <div className="p-6">
        <SkeletonLoader width={160} height={28} className="bg-slate-200" />
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <div
              key={index}
              className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
            >
              <SkeletonLoader
                width={100}
                height={14}
                className="bg-slate-200"
              />
              <SkeletonLoader
                width={130}
                height={28}
                className="mt-3 bg-slate-200"
              />
              <SkeletonLoader
                width="90%"
                height={14}
                className="mt-3 bg-slate-200"
              />
            </div>
          ))}
        </div>
      </div>
    </DashboardSurface>
  );
}

export function DashboardWorkflowSkeleton() {
  return (
    <DashboardSurface label="Loading workflow panel…">
      <div className="space-y-5 p-6">
        <div className="space-y-3">
          <SkeletonLoader width={192} height={16} className="bg-slate-200" />
          <SkeletonLoader width="56%" height={14} className="bg-slate-100" />
        </div>
        <div className="grid gap-4 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <div
              key={index}
              className="rounded-[24px] border border-slate-200 bg-slate-50/80 px-5 py-5"
            >
              <SkeletonLoader width={132} height={14} className="bg-slate-200" />
              <SkeletonLoader
                variant="rectangular"
                width="100%"
                height={120}
                className="mt-4 bg-slate-200/70"
              />
            </div>
          ))}
        </div>
      </div>
    </DashboardSurface>
  );
}

export function DashboardMarketCardSkeleton({ label = "Loading saved portfolio snapshot…" }: { label?: string }) {
  return (
    <DashboardSurface label={label}>
      <div className="space-y-6 p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-3">
            <SkeletonLoader width={144} height={24} className="bg-slate-200" />
            <SkeletonLoader width={220} height={34} className="bg-slate-200" />
            <SkeletonLoader width="88%" height={16} className="bg-slate-100" />
          </div>
          <div className="flex flex-wrap gap-2 lg:max-w-[16rem] lg:justify-end">
            {Array.from({ length: 2 }).map((_, index) => (
              <SkeletonLoader
                key={index}
                variant="rectangular"
                width={110}
                height={54}
                className="bg-slate-100"
              />
            ))}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div
              key={index}
              className="rounded-[22px] border border-slate-200 bg-slate-50/70 px-4 py-4"
            >
              <SkeletonLoader width={88} height={11} className="bg-slate-200" />
              <SkeletonLoader width={108} height={22} className="mt-3 bg-slate-200" />
              <SkeletonLoader
                width="80%"
                height={12}
                className="mt-4 bg-slate-100"
              />
            </div>
          ))}
        </div>

        <div className="rounded-[28px] border border-slate-200/80 bg-white/80 px-5 py-5">
          <SkeletonLoader width={156} height={11} className="bg-slate-200" />
          <SkeletonLoader width={220} height={14} className="mt-3 bg-slate-100" />
          <div className="mt-4 grid gap-3">
            {Array.from({ length: 4 }).map((_, index) => (
              <SkeletonLoader
                key={index}
                variant="rectangular"
                width="100%"
                height={64}
                className="bg-slate-100"
              />
            ))}
          </div>
        </div>
      </div>
    </DashboardSurface>
  );
}

export function DashboardFinalActionablesSkeleton() {
  return (
    <DashboardSurface label="Loading saved actionables…" className="border-slate-200/90">
      <div className="space-y-5 p-6">
        <div className="space-y-3">
          <SkeletonLoader width={196} height={16} className="bg-slate-200" />
          <SkeletonLoader width="48%" height={14} className="bg-slate-100" />
        </div>
        <div className="grid gap-4 xl:grid-cols-2">
          {Array.from({ length: 2 }).map((_, index) => (
            <div
              key={index}
              className="rounded-[24px] border border-slate-200 bg-slate-50/80 px-5 py-5"
            >
              <SkeletonLoader width={132} height={14} className="bg-slate-200" />
              <div className="mt-4 space-y-3">
                {Array.from({ length: 5 }).map((__, rowIndex) => (
                  <SkeletonLoader
                    key={rowIndex}
                    variant="rectangular"
                    width="100%"
                    height={44}
                    className="bg-slate-100"
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </DashboardSurface>
  );
}

export function DashboardThreatCardSkeleton({ title = "Threat report", deferred = false }: { title?: string; deferred?: boolean }) {
  return (
    <DashboardSurface deferred={deferred} label={deferred ? `Not loaded yet · ${title}. Scroll to this panel to load the saved report.` : `Loading saved ${title}…`}>
      <div className="space-y-6 p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-3">
            <SkeletonLoader width={156} height={24} className="bg-slate-200" />
            <SkeletonLoader width={228} height={34} className="bg-slate-200" />
            <SkeletonLoader width="90%" height={16} className="bg-slate-100" />
          </div>
          <SkeletonLoader
            variant="rectangular"
            width={164}
            height={86}
            className="bg-slate-100"
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <SkeletonLoader
              key={index}
              variant="rectangular"
              width="100%"
              height={72}
              className="bg-slate-100"
            />
          ))}
        </div>

        <div className="grid gap-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <SkeletonLoader
              key={index}
              variant="rectangular"
              width="100%"
              height={72}
              className="bg-slate-100"
            />
          ))}
        </div>
      </div>
    </DashboardSurface>
  );
}

export function DashboardPageSkeleton() {
  return (
    <div className="mx-auto flex flex-col gap-6">
      <DashboardHeroSkeleton />
      <DashboardWorkflowSkeleton />

      <section className="grid gap-6 xl:grid-cols-2">
        <DashboardMarketCardSkeleton />
        <DashboardMarketCardSkeleton />
      </section>

      <DashboardFinalActionablesSkeleton />

      <section className="grid gap-6 xl:grid-cols-2">
        <DashboardThreatCardSkeleton />
        <DashboardThreatCardSkeleton />
      </section>
    </div>
  );
}

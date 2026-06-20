import type { ReactNode } from "react";

import { SkeletonLoader } from "@/components/shared/Loader";

function DashboardSurface({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`overflow-hidden rounded-[32px] border border-slate-200 bg-white shadow-sm ${className}`}
    >
      {children}
    </section>
  );
}

export function DashboardHeroSkeleton() {
  return (
    <section className="overflow-hidden rounded-[36px] border border-slate-200 bg-slate-950 shadow-lg">
      <div className="grid gap-6 px-6 py-7 lg:grid-cols-[minmax(0,1fr)_minmax(420px,0.85fr)] lg:items-center lg:px-8 2xl:grid-cols-[minmax(0,1fr)_minmax(420px,0.75fr)_minmax(430px,0.9fr)]">
        <div className="space-y-4">
          <SkeletonLoader width={176} height={28} className="bg-white/12" />
          <SkeletonLoader width="72%" height={44} className="bg-white/14" />
          <SkeletonLoader width="58%" height={16} className="bg-white/10" />
          <SkeletonLoader
            variant="rectangular"
            width={148}
            height={42}
            className="bg-white/14"
          />
        </div>

        <div className="rounded-[28px] border border-white/10 bg-white/8 p-5">
          <SkeletonLoader width={128} height={12} className="bg-white/12" />
          <SkeletonLoader width={188} height={42} className="mt-4 bg-white/14" />
          <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <div
                key={index}
                className="rounded-[18px] border border-white/10 bg-white/8 px-4 py-4"
              >
                <SkeletonLoader width={72} height={11} className="bg-white/12" />
                <SkeletonLoader
                  width={96}
                  height={18}
                  className="mt-3 bg-white/14"
                />
                <SkeletonLoader
                  width="90%"
                  height={12}
                  className="mt-4 bg-white/10"
                />
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-[28px] border border-white/10 bg-white/8 p-5 2xl:block">
          <SkeletonLoader width={112} height={12} className="bg-white/12" />
          <SkeletonLoader width={164} height={24} className="mt-4 bg-white/14" />
          <SkeletonLoader
            variant="rectangular"
            width="100%"
            height={140}
            className="mt-6 bg-white/10"
          />
        </div>
      </div>
    </section>
  );
}

export function DashboardWorkflowSkeleton() {
  return (
    <DashboardSurface>
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

export function DashboardMarketCardSkeleton() {
  return (
    <DashboardSurface>
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
    <DashboardSurface className="border-slate-200/90">
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

export function DashboardThreatCardSkeleton() {
  return (
    <DashboardSurface>
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

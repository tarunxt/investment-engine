import type { ReactNode } from "react";

import { FullLoader, SkeletonLoader } from "@/components/shared/Loader";

function DefaultConsoleContentSkeleton() {
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      <div className="rounded-[28px] border border-border bg-card px-6 py-6 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-3">
            <SkeletonLoader width={168} height={14} className="bg-muted/70" />
            <SkeletonLoader width={320} height={40} className="bg-muted/70" />
            <SkeletonLoader width={420} height={16} className="bg-muted/60" />
          </div>
          <div className="flex gap-3">
            <SkeletonLoader
              variant="rectangular"
              width={132}
              height={40}
              className="bg-muted/70"
            />
            <SkeletonLoader
              variant="rectangular"
              width={132}
              height={40}
              className="bg-muted/70"
            />
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <div
            key={index}
            className="rounded-[24px] border border-border bg-card px-5 py-5 shadow-sm"
          >
            <SkeletonLoader width={104} height={12} className="bg-muted/60" />
            <SkeletonLoader
              width={132}
              height={28}
              className="mt-4 bg-muted/70"
            />
            <SkeletonLoader
              width="85%"
              height={14}
              className="mt-5 bg-muted/60"
            />
          </div>
        ))}
      </div>

      <div className="rounded-[28px] border border-border bg-card px-6 py-6 shadow-sm">
        <div className="space-y-3">
          <SkeletonLoader width={156} height={14} className="bg-muted/60" />
          <SkeletonLoader width="55%" height={16} className="bg-muted/60" />
        </div>
        <div className="mt-6 space-y-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <SkeletonLoader
              key={index}
              variant="rectangular"
              width="100%"
              height={52}
              className="bg-muted/55"
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export function ConsoleShellSkeleton({
  children,
  showDefaultContent = true,
}: {
  children?: ReactNode;
  showDefaultContent?: boolean;
}) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-border bg-sidebar text-sidebar-foreground lg:block">
        <div className="flex h-full flex-col">
          <div className="flex min-h-28 flex-col items-center justify-center gap-3 border-b border-sidebar-border px-5 py-5">
            <SkeletonLoader
              variant="rectangular"
              width={84}
              height={44}
              className="bg-sidebar-accent/70"
            />
            <SkeletonLoader
              width={132}
              height={14}
              className="bg-sidebar-accent/70"
            />
            <SkeletonLoader
              width={96}
              height={11}
              className="bg-sidebar-accent/60"
            />
          </div>

          <div className="space-y-3 px-4 py-4">
            {Array.from({ length: 9 }).map((_, index) => (
              <SkeletonLoader
                key={index}
                variant="rectangular"
                width="100%"
                height={40}
                className="bg-sidebar-accent/55"
              />
            ))}
          </div>
        </div>
      </div>

      <div className="lg:pl-64">
        <div className="fixed left-4 top-4 z-10 rounded-full border border-border bg-background p-2 shadow-sm lg:hidden">
          <SkeletonLoader
            variant="circular"
            width={24}
            height={24}
            className="bg-muted/70"
          />
        </div>

        <main className="px-4 py-6 sm:px-6 lg:py-6">
          <div className="mx-auto flex max-w-7xl flex-col gap-6">
            {children}
            {showDefaultContent ? <DefaultConsoleContentSkeleton /> : null}
          </div>
        </main>
      </div>
    </div>
  );
}

export function ConsoleLoadingBanner({
  timedOut = false,
}: {
  timedOut?: boolean;
}) {
  return (
    <div className="rounded-[28px] border border-border bg-card px-6 py-5 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-2">
          <FullLoader text="Loading console..." size="lg" textPosition="left" />
          <p className="text-sm text-muted-foreground">
            We&apos;re restoring your workspace and latest data.
          </p>
        </div>

        {timedOut ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
            Authentication is taking longer than expected. Refresh the page or
            open the login page if this does not clear.
          </div>
        ) : null}
      </div>
    </div>
  );
}

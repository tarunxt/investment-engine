import { ConsoleShellSkeleton } from "@/app/console/_components/ConsoleShellSkeleton";
import { SkeletonLoader } from "@/components/shared/Loader";

export function PolymarketBotMetricGridSkeleton({
  items = 4,
}: {
  items?: number;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: items }).map((_, index) => (
        <div
          key={index}
          className="rounded-[24px] border border-slate-200 bg-slate-50/80 px-4 py-4 shadow-sm"
        >
          <SkeletonLoader width={96} height={12} className="bg-slate-200" />
          <SkeletonLoader
            width={132}
            height={26}
            className="mt-3 bg-slate-200"
          />
          <SkeletonLoader
            width="80%"
            height={14}
            className="mt-3 bg-slate-100"
          />
        </div>
      ))}
    </div>
  );
}

export function PolymarketBotTableSkeleton({
  rows = 5,
  columns = 5,
}: {
  rows?: number;
  columns?: number;
}) {
  return (
    <div className="overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
        <div className="grid gap-3 md:grid-cols-4 xl:grid-cols-6">
          {Array.from({ length: columns }).map((_, index) => (
            <SkeletonLoader
              key={index}
              width="100%"
              height={12}
              className="bg-slate-200"
            />
          ))}
        </div>
      </div>
      <div className="space-y-3 px-4 py-4">
        {Array.from({ length: rows }).map((_, rowIndex) => (
          <div
            key={rowIndex}
            className="grid gap-3 md:grid-cols-4 xl:grid-cols-6"
          >
            {Array.from({ length: columns }).map((_, columnIndex) => (
              <SkeletonLoader
                key={columnIndex}
                width="100%"
                height={18}
                className="bg-slate-100"
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function PolymarketBotPageSkeleton() {
  return (
    <ConsoleShellSkeleton showDefaultContent={false}>
      <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div className="space-y-3">
          <SkeletonLoader width={188} height={16} className="bg-slate-200" />
          <SkeletonLoader width={320} height={34} className="bg-slate-200" />
          <SkeletonLoader width={420} height={16} className="bg-slate-100" />
        </div>
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 5 }).map((_, index) => (
            <SkeletonLoader
              key={index}
              variant="rectangular"
              width={112}
              height={36}
              className="rounded-full bg-slate-200"
            />
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-2 rounded-[24px] border border-slate-200 bg-white p-1 shadow-sm">
        {Array.from({ length: 2 }).map((_, index) => (
          <SkeletonLoader
            key={index}
            variant="rectangular"
            width={118}
            height={36}
            className="rounded-[18px] bg-slate-200"
          />
        ))}
      </div>

      <div className="rounded-[28px] border border-slate-200 bg-gradient-to-br from-slate-950 via-slate-900 to-sky-950 px-6 py-6 shadow-xl shadow-slate-950/10">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-3">
            <SkeletonLoader width={132} height={24} className="bg-white/15" />
            <SkeletonLoader width={248} height={34} className="bg-white/15" />
            <SkeletonLoader width={288} height={16} className="bg-white/10" />
            <SkeletonLoader width={220} height={16} className="bg-white/10" />
            <SkeletonLoader
              variant="rectangular"
              width={144}
              height={38}
              className="rounded-full bg-sky-300/20"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:min-w-[700px] lg:grid-cols-4 xl:grid-cols-5">
            {Array.from({ length: 6 }).map((_, index) => (
              <div
                key={index}
                className="rounded-[20px] border border-white/10 bg-white/10 px-4 py-3"
              >
                <SkeletonLoader
                  width={88}
                  height={12}
                  className="bg-white/15"
                />
                <SkeletonLoader
                  width={112}
                  height={24}
                  className="mt-3 bg-white/15"
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 rounded-[24px] border border-slate-200 bg-white px-4 py-4 shadow-sm">
        <div className="w-full max-w-md rounded-[22px] border border-slate-200 bg-slate-50 p-4 shadow-sm">
          <SkeletonLoader width={124} height={12} className="bg-slate-200" />
          <div className="mt-4 space-y-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <SkeletonLoader
                key={index}
                width="100%"
                height={36}
                className="bg-white"
              />
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 3 }).map((_, index) => (
            <SkeletonLoader
              key={index}
              variant="rectangular"
              width={120}
              height={36}
              className="rounded-full bg-slate-200"
            />
          ))}
        </div>
      </div>

      <div className="rounded-[28px] border border-slate-200 bg-white px-6 py-6 shadow-sm">
        <div className="space-y-3">
          <SkeletonLoader width={196} height={16} className="bg-slate-200" />
          <SkeletonLoader width="56%" height={14} className="bg-slate-100" />
        </div>
        <div className="mt-5">
          <PolymarketBotTableSkeleton rows={6} columns={6} />
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <div className="rounded-[28px] border border-slate-200 bg-white px-6 py-6 shadow-sm">
          <div className="space-y-3">
            <SkeletonLoader width={172} height={16} className="bg-slate-200" />
            <SkeletonLoader width="62%" height={14} className="bg-slate-100" />
          </div>
          <div className="mt-5">
            <PolymarketBotTableSkeleton rows={4} columns={5} />
          </div>
        </div>
        <div className="rounded-[28px] border border-slate-200 bg-white px-6 py-6 shadow-sm">
          <div className="space-y-3">
            <SkeletonLoader width={188} height={16} className="bg-slate-200" />
            <SkeletonLoader width="58%" height={14} className="bg-slate-100" />
          </div>
          <div className="mt-5">
            <PolymarketBotMetricGridSkeleton items={4} />
          </div>
        </div>
      </div>
    </ConsoleShellSkeleton>
  );
}

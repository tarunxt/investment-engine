'use client';

import { cn } from '@/lib/utils';

export type MetricItem = {
  label: string;
  value: string | number;
  helper?: string | null;
  tone?: 'default' | 'positive' | 'negative' | 'warning';
  onClick?: () => void;
};

const TONE_STYLES: Record<NonNullable<MetricItem['tone']>, string> = {
  default: 'text-slate-950',
  positive: 'text-emerald-700',
  negative: 'text-rose-700',
  warning: 'text-amber-700',
};

export function MetricGrid({
  items,
  columns = 'md:grid-cols-2 xl:grid-cols-4',
}: {
  items: MetricItem[];
  columns?: string;
}) {
  const renderContent = (item: MetricItem) => (
    <>
      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
        {item.label}
      </div>
      <div className={cn('mt-2 text-sm font-semibold', TONE_STYLES[item.tone ?? 'default'])}>
        {item.value}
      </div>
      {item.helper ? (
        <div className="mt-1 text-xs leading-5 text-slate-500">{item.helper}</div>
      ) : null}
    </>
  );

  return (
    <div className={cn('grid gap-3', columns)}>
      {items.map((item) =>
        item.onClick ? (
          <button
            key={item.label}
            type="button"
            onClick={item.onClick}
            className="cursor-pointer rounded-[24px] border border-slate-200 bg-slate-50/80 px-4 py-3 text-left shadow-sm transition hover:border-sky-300 hover:bg-sky-50 focus:outline-none focus:ring-2 focus:ring-sky-200"
          >
            {renderContent(item)}
          </button>
        ) : (
          <div
            key={item.label}
            className="rounded-[24px] border border-slate-200 bg-slate-50/80 px-4 py-3 text-left shadow-sm"
          >
            {renderContent(item)}
          </div>
        ),
      )}
    </div>
  );
}

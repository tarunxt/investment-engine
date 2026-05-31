'use client';

import { cn } from '@/lib/utils';

export type MetricItem = {
  label: string;
  value: string | number;
  helper?: string | null;
  tone?: 'default' | 'positive' | 'negative' | 'warning';
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
  return (
    <div className={cn('grid gap-3', columns)}>
      {items.map((item) => (
        <div
          key={item.label}
          className="rounded-[24px] border border-slate-200 bg-slate-50/80 px-4 py-3 shadow-sm"
        >
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            {item.label}
          </div>
          <div className={cn('mt-2 text-sm font-semibold', TONE_STYLES[item.tone ?? 'default'])}>
            {item.value}
          </div>
          {item.helper ? (
            <div className="mt-1 text-xs leading-5 text-slate-500">{item.helper}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

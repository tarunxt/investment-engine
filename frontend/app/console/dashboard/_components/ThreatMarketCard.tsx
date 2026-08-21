'use client';

import Link from 'next/link';
import { ArrowRight, ShieldAlert, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import type { DashboardMarket, DashboardSeverityCounts } from './dashboardOverviewUtils';

export type ThreatSummaryPoint = {
  label: string;
  value: string;
};

const ACCENT_STYLES = {
  india: {
    badge: 'border-rose-200/80 bg-rose-50 text-rose-900',
    gradient: 'from-rose-100 via-amber-50 to-white',
    glow: 'bg-rose-300/25',
  },
  us: {
    badge: 'border-sky-200/80 bg-sky-50 text-sky-900',
    gradient: 'from-sky-100 via-indigo-50 to-white',
    glow: 'bg-sky-300/25',
  },
} as const;

function severityCardClass(level: keyof DashboardSeverityCounts) {
  if (level === 'veryHigh') return 'bg-rose-50 text-rose-900';
  if (level === 'high') return 'bg-orange-50 text-orange-900';
  if (level === 'medium') return 'bg-amber-50 text-amber-900';
  return 'bg-emerald-50 text-emerald-900';
}

function severityLabel(level: keyof DashboardSeverityCounts) {
  if (level === 'veryHigh') return 'Very High';
  if (level === 'high') return 'High';
  if (level === 'medium') return 'Medium';
  return 'Low';
}

export function ThreatMarketCard({
  market,
  title,
  description,
  summaryPoints,
  severityCounts,
  urgentActionCount,
  lastUpdated,
  href,
  emptyMessage,
}: {
  market: DashboardMarket;
  title: string;
  description: string;
  summaryPoints: ThreatSummaryPoint[];
  severityCounts: DashboardSeverityCounts;
  urgentActionCount: number;
  lastUpdated: string;
  href: string;
  emptyMessage?: string | null;
}) {
  const accent = ACCENT_STYLES[market];

  return (
    <section className="relative overflow-hidden rounded-[32px] border border-slate-200 bg-white shadow-sm">
      <div className={cn('absolute inset-x-0 top-0 h-32 bg-linear-to-br', accent.gradient)} />
      <div className={cn('absolute -left-10 top-10 size-28 rounded-full blur-3xl', accent.glow)} />

      <div className="relative p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div
              className={cn(
                'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]',
                accent.badge,
              )}
            >
              <ShieldAlert className="size-3.5" />
              {market === 'india' ? 'India Threat Radar' : 'US Threat Radar'}
            </div>
            <h2 className="mt-4 font-serif text-2xl tracking-tight text-slate-950">{title}</h2>
            <p className="mt-2 max-w-xl text-sm leading-7 text-slate-600">{description}</p>
          </div>

          <div className="rounded-[24px] border border-slate-200 bg-white/85 px-4 py-3 shadow-sm">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Actionable Names
            </div>
            <div className="mt-2 text-2xl font-semibold text-slate-950">{urgentActionCount}</div>
            <div className="mt-1 text-xs text-slate-500">Latest scan: {lastUpdated}</div>
          </div>
        </div>

        {emptyMessage ? (
          <div className="mt-6 rounded-[26px] border border-dashed border-slate-300 bg-white/80 px-5 py-6 text-sm leading-7 text-slate-600">
            <div className="flex items-start gap-3">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-slate-500" />
              <span>{emptyMessage}</span>
            </div>
          </div>
        ) : (
          <>
            <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {(Object.keys(severityCounts) as Array<keyof DashboardSeverityCounts>).map((level) => (
                <div
                  key={level}
                  className={cn(
                    'rounded-[22px] px-4 py-4 shadow-sm',
                    severityCardClass(level),
                  )}
                >
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em]">
                    {severityLabel(level)}
                  </div>
                  <div className="mt-2 text-xl font-semibold">{severityCounts[level]}</div>
                </div>
              ))}
            </div>

            <div className="mt-6 grid gap-3">
              {summaryPoints.map((point) => (
                <div
                  key={point.label}
                  className="rounded-[22px] border border-slate-200 bg-white/85 px-4 py-4 shadow-sm"
                >
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                    {point.label}
                  </div>
                  <div className="mt-2 text-sm leading-7 text-slate-700">{point.value}</div>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="mt-6 flex flex-wrap gap-3">
          <Button asChild className="rounded-full bg-slate-950 text-white hover:bg-slate-900">
            <Link href={href}>
              Open Full Threats Page
              <ArrowRight className="ml-2 size-4" />
            </Link>
          </Button>
        </div>
      </div>
    </section>
  );
}

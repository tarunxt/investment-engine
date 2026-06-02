'use client';

import Link from 'next/link';
import { ArrowRight, Wallet } from 'lucide-react';

import { TradingViewSymbolLink } from '@/components/shared/TradingViewSymbolLink';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import type { DashboardMarket } from './dashboardOverviewUtils';

export type PortfolioCardMetric = {
  label: string;
  value: string;
  detail?: string;
  tone?: 'default' | 'positive' | 'negative';
};

export type PortfolioCardStatusPillTone = 'default' | 'success' | 'warning' | 'danger';

export type PortfolioCardTopHolding = {
  id: string;
  symbol: string;
  exchange?: string | null;
  name?: string | null;
  value: string;
  secondaryValue?: string;
  secondaryToneClass?: string;
};

const ACCENT_STYLES = {
  india: {
    badge: 'border-amber-200/80 bg-amber-50 text-amber-900',
    gradient: 'from-amber-200/70 via-orange-100/50 to-white',
    glow: 'bg-amber-300/30',
    metric: {
      default: 'border-slate-200/80 bg-white/80 text-slate-900',
      positive: 'border-emerald-200 bg-emerald-50/90 text-emerald-900',
      negative: 'border-rose-200 bg-rose-50/90 text-rose-900',
    },
  },
  us: {
    badge: 'border-sky-200/80 bg-sky-50 text-sky-900',
    gradient: 'from-sky-200/70 via-indigo-100/50 to-white',
    glow: 'bg-sky-300/30',
    metric: {
      default: 'border-slate-200/80 bg-white/80 text-slate-900',
      positive: 'border-emerald-200 bg-emerald-50/90 text-emerald-900',
      negative: 'border-rose-200 bg-rose-50/90 text-rose-900',
    },
  },
} as const;

function statusPillToneClass(tone: PortfolioCardStatusPillTone | undefined) {
  if (tone === 'success') return 'border-emerald-200 bg-emerald-50 text-emerald-900';
  if (tone === 'warning') return 'border-yellow-200 bg-yellow-50 text-yellow-900';
  if (tone === 'danger') return 'border-red-200 bg-red-50 text-red-900';
  return 'border-slate-200 bg-white/85 text-slate-700';
}

function statusPillLabelClass(tone: PortfolioCardStatusPillTone | undefined) {
  if (tone === 'success') return 'text-emerald-600';
  if (tone === 'warning') return 'text-yellow-700';
  if (tone === 'danger') return 'text-red-600';
  return 'text-slate-400';
}

function statusPillValueClass(tone: PortfolioCardStatusPillTone | undefined) {
  if (tone === 'success') return 'text-emerald-950';
  if (tone === 'warning') return 'text-yellow-950';
  if (tone === 'danger') return 'text-red-950';
  return 'text-slate-900';
}

function metricToneClass(market: DashboardMarket, tone: PortfolioCardMetric['tone']) {
  const palette = ACCENT_STYLES[market].metric;
  if (tone === 'positive') return palette.positive;
  if (tone === 'negative') return palette.negative;
  return palette.default;
}

export function MarketPortfolioCard({
  market,
  title,
  description,
  statusPills,
  metrics,
  topHoldings,
  portfolioHref,
  threatsHref,
  emptyMessage,
}: {
  market: DashboardMarket;
  title: string;
  description: string;
  statusPills: Array<{ label: string; value: string; detail?: string; tone?: PortfolioCardStatusPillTone }>;
  metrics: PortfolioCardMetric[];
  topHoldings: PortfolioCardTopHolding[];
  portfolioHref: string;
  threatsHref: string;
  emptyMessage?: string | null;
}) {
  const accent = ACCENT_STYLES[market];

  return (
    <section className="relative overflow-hidden rounded-[32px] border border-slate-200 bg-white shadow-sm">
      <div className={cn('absolute inset-x-0 top-0 h-36 bg-linear-to-br', accent.gradient)} />
      <div className={cn('absolute -right-10 top-8 size-32 rounded-full blur-3xl', accent.glow)} />

      <div className="relative flex h-full flex-col p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div
              className={cn(
                'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]',
                accent.badge,
              )}
            >
              <Wallet className="size-3.5" />
              {market === 'india' ? 'India Portfolio' : 'US Portfolio'}
            </div>
            <h2 className="mt-4 font-serif text-2xl tracking-tight text-slate-950">{title}</h2>
            <p className="mt-2 max-w-xl text-sm leading-7 text-slate-600">{description}</p>
          </div>

          <div className="flex flex-wrap gap-2 lg:max-w-[16rem] lg:justify-end">
            {statusPills.map((pill) => (
              <div
                key={`${pill.label}-${pill.value}`}
                className={cn(
                  'rounded-full border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] shadow-sm',
                  statusPillToneClass(pill.tone),
                )}
              >
                <div className="flex items-start justify-center gap-1.5">
                  <span className={statusPillLabelClass(pill.tone)}>{pill.label}</span>
                  <span className={cn('flex flex-col items-center', statusPillValueClass(pill.tone))}>
                    <span>{pill.value}</span>
                    {pill.detail ? (
                      <span className="mt-1 text-[10px] font-medium normal-case tracking-[0.06em] opacity-75">
                        {pill.detail}
                      </span>
                    ) : null}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {emptyMessage ? (
          <div className="mt-6 rounded-[26px] border border-dashed border-slate-300 bg-white/75 px-5 py-6 text-sm leading-7 text-slate-600">
            {emptyMessage}
          </div>
        ) : (
          <>
            <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {metrics.map((metric) => (
                <div
                  key={metric.label}
                  className={cn(
                    'rounded-[22px] border px-4 py-4 shadow-sm backdrop-blur',
                    metricToneClass(market, metric.tone),
                  )}
                >
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                    {metric.label}
                  </div>
                  <div className="mt-2 text-lg font-semibold">{metric.value}</div>
                  {metric.detail ? (
                    <div className="mt-1 text-xs text-slate-500">{metric.detail}</div>
                  ) : null}
                </div>
              ))}
            </div>

            <div className="mt-6 rounded-[28px] border border-slate-200/80 bg-white/80 px-5 py-5 shadow-sm">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Highest-Weight Positions
              </div>
              <div className="mt-1 text-sm text-slate-600">
                Quick scan of the largest holdings shaping portfolio risk.
              </div>

              {topHoldings.length > 0 ? (
                <div className="mt-4 grid gap-3">
                  {topHoldings.map((holding) => (
                    <div
                      key={holding.id}
                      className="flex items-start justify-between gap-4 rounded-[22px] border border-slate-100 bg-white px-4 py-3"
                    >
                      <div className="min-w-0">
                        <TradingViewSymbolLink
                          symbol={holding.symbol}
                          market={market}
                          exchange={holding.exchange}
                          className="group inline-flex flex-col"
                        >
                          <span className="text-sm font-semibold text-slate-900 transition-colors group-hover:text-slate-700">
                            {holding.symbol}
                          </span>
                          {holding.name ? (
                            <span className="truncate text-xs text-slate-500 transition-colors group-hover:text-slate-600">
                              {holding.name}
                            </span>
                          ) : null}
                        </TradingViewSymbolLink>
                      </div>

                      <div className="text-right">
                        <div className="text-sm font-semibold text-slate-900">{holding.value}</div>
                        {holding.secondaryValue ? (
                          <div className={cn('text-xs', holding.secondaryToneClass ?? 'text-slate-500')}>
                            {holding.secondaryValue}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-4 rounded-[22px] border border-dashed border-slate-200 bg-slate-50/80 px-4 py-5 text-sm text-slate-500">
                  No holdings are available yet for this market snapshot.
                </div>
              )}
            </div>
          </>
        )}

        <div className="mt-6 flex flex-wrap gap-3">
          <Button asChild className="rounded-full bg-slate-950 text-white hover:bg-slate-900">
            <Link href={portfolioHref}>
              Open Portfolio
              <ArrowRight className="ml-2 size-4" />
            </Link>
          </Button>
          <Button asChild variant="outline" className="rounded-full border-slate-300 bg-white/80">
            <Link href={threatsHref}>Open Threat Radar</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}

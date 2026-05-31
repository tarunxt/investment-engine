'use client';

import Link from 'next/link';

import { TradingViewSymbolLink } from '@/components/shared/TradingViewSymbolLink';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import type { DashboardUrgentActionRow } from './dashboardOverviewUtils';

function marketBadgeClass(market: DashboardUrgentActionRow['market']) {
  return market === 'india'
    ? 'border-amber-200 bg-amber-50 text-amber-900'
    : 'border-sky-200 bg-sky-50 text-sky-900';
}

function priorityBadgeClass(priority: string) {
  const normalized = priority.toLowerCase();
  if (normalized === 'very high') return 'border-rose-200 bg-rose-50 text-rose-900';
  if (normalized === 'high') return 'border-orange-200 bg-orange-50 text-orange-900';
  if (normalized === 'medium') return 'border-amber-200 bg-amber-50 text-amber-900';
  return 'border-emerald-200 bg-emerald-50 text-emerald-900';
}

export function ThreatActionTable({
  rows,
  totalRows,
}: {
  rows: DashboardUrgentActionRow[];
  totalRows: number;
}) {
  return (
    <section className="rounded-[32px] border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-col gap-4 border-b border-slate-200 px-6 py-6 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Threats Table 10
          </div>
          <h2 className="mt-2 font-serif text-2xl tracking-tight text-slate-950">
            Top 10 Urgent Actionables
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-7 text-slate-600">
            Cross-market Table 10 rollup from Zerodha India and INDmoney US. This keeps the most actionable
            risk-control calls in one place.
          </p>
        </div>

        <div className="rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-700">
          {totalRows > rows.length ? `Showing ${rows.length} of ${totalRows}` : `${rows.length} actionables`}
        </div>
      </div>

      {rows.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              <tr>
                <th className="px-6 py-4">Market</th>
                <th className="px-6 py-4">Stock</th>
                <th className="px-6 py-4">Action</th>
                <th className="px-6 py-4">Why Now</th>
                <th className="px-6 py-4">Trigger</th>
                <th className="px-6 py-4">Deadline</th>
                <th className="px-6 py-4">Priority</th>
                <th className="px-6 py-4">Timing</th>
                <th className="px-6 py-4 text-right">Review</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <tr key={row.id} className="align-top hover:bg-slate-50/80">
                  <td className="px-6 py-4">
                    <span
                      className={cn(
                        'inline-flex rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]',
                        marketBadgeClass(row.market),
                      )}
                    >
                      {row.marketLabel}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <TradingViewSymbolLink
                      symbol={row.symbol}
                      market={row.market}
                      exchange={row.exchange}
                      className="group inline-flex flex-col"
                    >
                      <span className="font-semibold text-slate-900 transition-colors group-hover:text-slate-700">
                        {row.symbol}
                      </span>
                      <span className="text-xs text-slate-500 transition-colors group-hover:text-slate-600">
                        {row.stockName}
                      </span>
                    </TradingViewSymbolLink>
                    <div className="mt-1 text-xs uppercase tracking-[0.14em] text-slate-400">{row.exchange}</div>
                  </td>
                  <td className="px-6 py-4 font-semibold text-slate-900">{row.action}</td>
                  <td className="px-6 py-4 text-slate-600">{row.reason}</td>
                  <td className="px-6 py-4 text-slate-600">{row.trigger}</td>
                  <td className="px-6 py-4 text-slate-600">{row.deadline}</td>
                  <td className="px-6 py-4">
                    <span
                      className={cn(
                        'inline-flex rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]',
                        priorityBadgeClass(row.priority),
                      )}
                    >
                      {row.priority}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-slate-600">{row.timeSensitivity}</td>
                  <td className="px-6 py-4 text-right">
                    <Button asChild variant="outline" size="xs" className="rounded-full border-slate-300">
                      <Link href={row.threatHref}>Open</Link>
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="px-6 py-8 text-sm leading-7 text-slate-600">
          No Table 10 urgent actionables are available yet. Run the India or US threat radar to populate this board.
        </div>
      )}
    </section>
  );
}

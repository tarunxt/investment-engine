'use client';

import { AlertTriangle, Clock3, LineChart, ShieldAlert, Target, TriangleAlert } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { type ZerodhaThreatSummary } from '@/types/api';

const SUMMARY_CARD_CONFIG: Array<{
  key: keyof ZerodhaThreatSummary;
  label: string;
  icon: typeof AlertTriangle;
  accent: string;
}> = [
  {
    key: 'main_portfolio_risk',
    label: 'Main Portfolio Risk',
    icon: ShieldAlert,
    accent: 'from-rose-500/15 to-amber-500/15 ring-rose-200/70',
  },
  {
    key: 'biggest_weakness',
    label: 'Biggest Weakness',
    icon: AlertTriangle,
    accent: 'from-orange-500/15 to-amber-400/15 ring-orange-200/70',
  },
  {
    key: 'biggest_near_term_threat',
    label: 'Near-Term Threat',
    icon: TriangleAlert,
    accent: 'from-red-500/15 to-rose-500/15 ring-red-200/70',
  },
  {
    key: 'biggest_position_size_risk',
    label: 'Position-Size Risk',
    icon: LineChart,
    accent: 'from-indigo-500/15 to-sky-500/15 ring-indigo-200/70',
  },
  {
    key: 'biggest_profit_protection_candidate',
    label: 'Protect Gains In',
    icon: Target,
    accent: 'from-emerald-500/15 to-teal-500/15 ring-emerald-200/70',
  },
  {
    key: 'biggest_weak_drag_position',
    label: 'Weak Drag Position',
    icon: Clock3,
    accent: 'from-slate-400/15 to-slate-300/15 ring-slate-200/70',
  },
];

export function ThreatsSummaryCards({ summary }: { summary: ZerodhaThreatSummary | null | undefined }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {SUMMARY_CARD_CONFIG.map((card) => {
        const Icon = card.icon;
        const value = summary?.[card.key] || 'Waiting for the threat scan to generate this insight.';

        return (
          <Card
            key={card.key}
            size="sm"
            className={`gap-0 rounded-[28px] border-0 bg-linear-to-br ${card.accent}`}
          >
            <CardHeader className="border-b border-white/70 pb-4">
              <div className="flex items-center justify-between gap-4">
                <CardTitle className="text-xs tracking-[0.18em] text-slate-700">{card.label}</CardTitle>
                <div className="rounded-full bg-white/80 p-2 text-slate-700 shadow-sm">
                  <Icon className="size-4" />
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-4 text-sm leading-6 text-slate-700">
              {value}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

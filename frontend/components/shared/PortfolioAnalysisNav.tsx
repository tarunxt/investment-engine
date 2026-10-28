"use client";
import {useModules} from "@/providers/ModuleContext";
import {surfaceVisible} from "@/lib/modulePolicy";
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { URLs } from '@/lib/urls';
import { cn } from '@/lib/utils';

type PortfolioKey = 'zerodha' | 'indmoneyUs';
type ActiveTab = 'swingTrade' | 'portfolio' | 'events' | 'threats' | 'rebalance' | 'finalActionables' | null;

const ROUTES = {
  zerodha: {
    swingTrade: URLs.routes.console.zerodhaSwingTrade(),
    portfolio: '/console/zerodha/portfolio',
    events: URLs.routes.console.zerodhaEvents(),
    threats: URLs.routes.console.zerodhaThreats(),
    rebalance: URLs.routes.console.zerodhaRebalance(),
    finalActionables: URLs.routes.console.zerodhaFinalActionables(),
  },
  indmoneyUs: {
    swingTrade: URLs.routes.console.indmoneyUsSwingTrade(),
    portfolio: '/console/indmoney-us/portfolio',
    events: URLs.routes.console.indmoneyUsEvents(),
    threats: URLs.routes.console.indmoneyUsThreats(),
    rebalance: URLs.routes.console.indmoneyUsRebalance(),
    finalActionables: URLs.routes.console.indmoneyUsFinalActionables(),
  },
} satisfies Record<PortfolioKey, Record<Exclude<ActiveTab, null>, string>>;

const TABS = [
  { key: 'swingTrade', label: 'Swing Trade' },
  { key: 'threats', label: 'Threats' },
  { key: 'events', label: 'Events' },
] as const;

export function PortfolioAnalysisNav({
  portfolio,
  active = null,
  className,
}: {
  portfolio: PortfolioKey;
  active?: ActiveTab;
  className?: string;
}) {
  const {manifest}=useModules();
  return (
    <details className={className}><summary className="min-h-11 cursor-pointer text-sm">Additional research views</summary><div className={cn('flex flex-wrap items-start gap-3')}>
      {TABS.map((item) => (
        <div key={item.key} className="flex min-w-[112px] flex-col items-stretch gap-1.5">
          <Button
            asChild
            variant="outline"
            size="sm"
            className={cn(
              'w-full justify-center',
              active === item.key
                ? 'bg-gray-950 text-white hover:bg-gray-900 hover:text-white'
                : '',
            )}
          >
            <Link href={ROUTES[portfolio][item.key]}>
              {item.label}
            </Link>
          </Button>

          <div className="flex items-center justify-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em]">
            {(['zerodha','indmoneyUs'] as const).filter(p=>surfaceVisible(manifest,ROUTES[p].portfolio)).map(p=><Link key={p} href={ROUTES[p][item.key]} prefetch={false} aria-current={portfolio===p?'page':undefined} className={cn('border-b border-transparent pb-0.5 text-gray-400 transition-colors hover:text-gray-700',portfolio===p?'border-gray-950 text-gray-950':'')}>{p==='zerodha'?'Ind':'US'}</Link>)}
          </div>
        </div>
      ))}
    </div></details>
  );
}

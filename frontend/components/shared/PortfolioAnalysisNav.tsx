import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { URLs } from '@/lib/urls';
import { cn } from '@/lib/utils';

type PortfolioKey = 'zerodha' | 'indmoneyUs';
type ActiveTab = 'swingTrade' | 'portfolio' | 'events' | 'threats' | null;

const ROUTES = {
  zerodha: {
    swingTrade: URLs.routes.console.zerodhaSwingTrade(),
    portfolio: URLs.routes.console.zerodha(),
    events: URLs.routes.console.zerodhaEvents(),
    threats: URLs.routes.console.zerodhaThreats(),
  },
  indmoneyUs: {
    swingTrade: URLs.routes.console.indmoneyUsSwingTrade(),
    portfolio: URLs.routes.console.indmoneyUs(),
    events: URLs.routes.console.indmoneyUsEvents(),
    threats: URLs.routes.console.indmoneyUsThreats(),
  },
} satisfies Record<PortfolioKey, Record<Exclude<ActiveTab, null>, string>>;

const TABS = [
  { key: 'portfolio', label: 'Portfolio' },
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
  return (
    <div className={cn('flex flex-wrap items-start gap-3', className)}>
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
            <Link
              href={ROUTES.zerodha[item.key]}
              aria-current={portfolio === 'zerodha' ? 'page' : undefined}
              className={cn(
                'border-b border-transparent pb-0.5 text-gray-400 transition-colors hover:text-gray-700',
                portfolio === 'zerodha' ? 'border-gray-950 text-gray-950' : '',
              )}
            >
              Ind
            </Link>
            <span className="text-gray-300">|</span>
            <Link
              href={ROUTES.indmoneyUs[item.key]}
              aria-current={portfolio === 'indmoneyUs' ? 'page' : undefined}
              className={cn(
                'border-b border-transparent pb-0.5 text-gray-400 transition-colors hover:text-gray-700',
                portfolio === 'indmoneyUs' ? 'border-gray-950 text-gray-950' : '',
              )}
            >
              US
            </Link>
          </div>
        </div>
      ))}
    </div>
  );
}

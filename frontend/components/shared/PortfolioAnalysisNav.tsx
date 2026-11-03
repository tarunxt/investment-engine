import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { URLs } from '@/lib/urls';
import { cn } from '@/lib/utils';

type PortfolioKey = 'zerodha' | 'indmoneyUs';
type ActiveTab = 'swingTrade' | 'portfolio' | 'events' | 'threats' | 'rebalance' | 'finalActionables' | null;

const ROUTES = {
  zerodha: {
    swingTrade: URLs.routes.console.zerodhaSwingTrade(),
    portfolio: URLs.routes.console.zerodha(),
    events: URLs.routes.console.zerodhaEvents(),
    threats: URLs.routes.console.zerodhaThreats(),
    rebalance: URLs.routes.console.zerodhaRebalance(),
    finalActionables: URLs.routes.console.zerodhaFinalActionables(),
  },
  indmoneyUs: {
    swingTrade: URLs.routes.console.indmoneyUsSwingTrade(),
    portfolio: URLs.routes.console.indmoneyUs(),
    events: URLs.routes.console.indmoneyUsEvents(),
    threats: URLs.routes.console.indmoneyUsThreats(),
    rebalance: URLs.routes.console.indmoneyUsRebalance(),
    finalActionables: URLs.routes.console.indmoneyUsFinalActionables(),
  },
} satisfies Record<PortfolioKey, Record<Exclude<ActiveTab, null>, string>>;

const TABS = [
  { key: 'portfolio', label: 'Portfolio' },
  { key: 'swingTrade', label: 'Swing Trade' },
  { key: 'threats', label: 'Threats' },
  { key: 'events', label: 'Events' },
  { key: 'rebalance', label: 'Rebalance' },
  { key: 'finalActionables', label: 'Final Actionables' },
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
  const market = portfolio === 'zerodha' ? 'India' : 'US';
  const currentFunction = TABS.find((item) => item.key === active)?.label;

  return (
    <div>
      <p className="mb-2 text-sm text-gray-600">
        Current market: <strong>{market}</strong>{currentFunction ? <> · Current function: <strong>{currentFunction}</strong></> : null}
      </p>
      <div role="group" aria-label="Portfolio market" className="mb-3 flex flex-wrap gap-2">
        {(['zerodha', 'indmoneyUs'] as const).map((target) => (
          <Button
            key={target}
            asChild
            variant="outline"
            size="sm"
            className={cn(portfolio === target && 'bg-gray-950 text-white hover:bg-gray-900 hover:text-white')}
          >
            <Link
              href={ROUTES[target][active ?? 'portfolio']}
              aria-label={`Open ${target === 'zerodha' ? 'India' : 'US'} ${currentFunction ?? 'Portfolio'}`}
              aria-current={portfolio === target ? 'true' : undefined}
            >
              {target === 'zerodha' ? 'India' : 'US'}
            </Link>
          </Button>
        ))}
      </div>
      <div role="group" aria-label="Portfolio function" className={cn('flex flex-wrap items-start gap-3', className)}>
        {TABS.map((item) => (
          <Button
            key={item.key}
            asChild
            variant="outline"
            size="sm"
            className={cn(
              'min-w-[112px] justify-center',
              active === item.key ? 'bg-gray-950 text-white hover:bg-gray-900 hover:text-white' : '',
            )}
          >
            <Link href={ROUTES[portfolio][item.key]} aria-label={`${market} ${item.label}`} aria-current={active === item.key ? 'page' : undefined}>
              {item.label}
            </Link>
          </Button>
        ))}
      </div>
      <p className="mt-2 text-xs text-gray-500">
        Market links open the selected view. Final Actionables brings portfolio recommendations together for review.
      </p>
    </div>
  );
}

import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { URLs } from '@/lib/urls';
import { cn } from '@/lib/utils';

type PortfolioKey = 'zerodha' | 'indmoneyUs';
type ActiveTab = 'events' | 'threats' | null;

const ROUTES = {
  zerodha: {
    events: URLs.routes.console.zerodhaEvents(),
    threats: URLs.routes.console.zerodhaThreats(),
  },
  indmoneyUs: {
    events: URLs.routes.console.indmoneyUsEvents(),
    threats: URLs.routes.console.indmoneyUsThreats(),
  },
} satisfies Record<PortfolioKey, Record<Exclude<ActiveTab, null>, string>>;

export function PortfolioAnalysisNav({
  portfolio,
  active = null,
  className,
}: {
  portfolio: PortfolioKey;
  active?: ActiveTab;
  className?: string;
}) {
  const routes = ROUTES[portfolio];

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {([
        { key: 'events', label: 'Events' },
        { key: 'threats', label: 'Threats' },
      ] as const).map((item) => (
        <Button
          key={item.key}
          asChild
          variant="outline"
          size="sm"
          className={cn(
            active === item.key
              ? 'bg-gray-950 text-white hover:bg-gray-900 hover:text-white'
              : '',
          )}
        >
          <Link href={routes[item.key]}>
            {item.label}
          </Link>
        </Button>
      ))}
    </div>
  );
}

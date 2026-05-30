import type { ReactNode } from 'react';

import { buildTradingViewChartUrl, type TradingViewMarket } from '@/lib/tradingview';
import { cn } from '@/lib/utils';

export function TradingViewSymbolLink({
  symbol,
  market,
  exchange,
  className,
  title,
  children,
}: {
  symbol: string;
  market: TradingViewMarket;
  exchange?: string | null;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  const href = buildTradingViewChartUrl({ symbol, market, exchange });

  if (!href) {
    return <span className={className}>{children}</span>;
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title ?? `Open ${symbol} on TradingView`}
      className={cn('transition-colors', className)}
    >
      {children}
    </a>
  );
}

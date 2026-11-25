import type { ReactNode } from 'react';

import { buildTradingViewChartUrl, chartSymbolForCell, tradingViewMentions, type TradingViewMarket } from '@/lib/tradingview';
import { cn } from '@/lib/utils';

export function TradingViewSymbolLink({
  symbol,
  market = 'us',
  exchange,
  className,
  title,
  children = symbol,
}: {
  symbol: string;
  market?: TradingViewMarket;
  exchange?: string | null;
  className?: string;
  title?: string;
  children?: ReactNode;
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
      className={cn('cursor-pointer text-blue-700 underline decoration-current underline-offset-2 transition-colors hover:text-blue-800 focus-visible:outline-2', className)}
    >
      {children}
    </a>
  );
}

/** Link only explicit listings in narrative text; preserve all surrounding text. */
export function tradingViewText(text: string): ReactNode {
  const mentions = tradingViewMentions(text);
  if (!mentions.length) return text;
  const content: ReactNode[] = [];
  let start = 0;
  for (const mention of mentions) {
    content.push(text.slice(start, mention.start), <TradingViewSymbolLink key={mention.start} symbol={mention.symbol} />);
    start = mention.end;
  }
  return [...content, text.slice(start)];
}

export function stockTableCell(column: string, value: string, identity: {symbol: string; exchange: string}): ReactNode {
  const symbol = chartSymbolForCell(column, value, identity);
  return symbol ? <TradingViewSymbolLink symbol={symbol} exchange={identity.exchange}>{value}</TradingViewSymbolLink> : tradingViewText(value);
}

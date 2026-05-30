export type TradingViewMarket = 'india' | 'us';

const INDIA_EXCHANGES = new Set(['NSE', 'BSE']);
const US_EXCHANGES = new Set(['NASDAQ', 'NYSE', 'AMEX']);
const QUALIFIED_SYMBOL_PATTERN = /^[A-Z]+:[A-Z0-9.&_-]{1,24}$/;
const TICKER_SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9.&_-]{0,24}$/;

const DISPLAY_COLUMN_KEYS = new Set([
  'stock',
  'stock / ticker',
  'stock / symbol',
  'stock name',
  'stock name / ticker',
  'stock name / symbol',
  'stock symbol',
  'ticker',
  'ticker / symbol',
  'symbol',
  'symbol / ticker',
  'holding',
  'holding / ticker',
  'holding / symbol',
  'holding name',
  'holding ticker',
  'holding symbol',
  'company',
  'company / ticker',
  'company / symbol',
  'company name',
]);

const SYMBOL_COLUMN_KEYS = new Set([
  'tradingsymbol',
  'stock symbol',
  'ticker',
  'ticker / symbol',
  'symbol',
  'symbol / ticker',
  'holding ticker',
  'holding symbol',
]);

const EXCHANGE_COLUMN_KEYS = new Set([
  'exchange',
  'exchange symbol',
]);

function normalizeValue(value: string) {
  return value.trim().toUpperCase();
}

function normalizeColumnLabel(value: string) {
  return value
    .toLowerCase()
    .replace(/[–—]/g, '-')
    .replace(/[()]/g, '')
    .replace(/_/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\//g, ' / ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function looksLikeTradingViewSymbol(value: string) {
  const normalized = normalizeValue(value);
  return QUALIFIED_SYMBOL_PATTERN.test(normalized) || TICKER_SYMBOL_PATTERN.test(normalized);
}

export function buildTradingViewChartUrl({
  symbol,
  market,
  exchange,
}: {
  symbol: string;
  market: TradingViewMarket;
  exchange?: string | null;
}) {
  const normalizedSymbol = normalizeValue(symbol);
  if (!normalizedSymbol || !looksLikeTradingViewSymbol(normalizedSymbol)) {
    return null;
  }

  if (QUALIFIED_SYMBOL_PATTERN.test(normalizedSymbol)) {
    return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(normalizedSymbol)}`;
  }

  const normalizedExchange = normalizeValue(exchange ?? '');

  if (market === 'india') {
    const resolvedExchange = INDIA_EXCHANGES.has(normalizedExchange) ? normalizedExchange : 'NSE';
    return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(`${resolvedExchange}:${normalizedSymbol}`)}`;
  }

  if (US_EXCHANGES.has(normalizedExchange)) {
    return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(`${normalizedExchange}:${normalizedSymbol}`)}`;
  }

  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(normalizedSymbol)}`;
}

export function isTradingViewDisplayColumn(column: string) {
  return DISPLAY_COLUMN_KEYS.has(normalizeColumnLabel(column));
}

export function resolveTradingViewRowSymbol(row: Record<string, string>, currentColumn: string) {
  for (const [key, value] of Object.entries(row)) {
    if (SYMBOL_COLUMN_KEYS.has(normalizeColumnLabel(key)) && value.trim()) {
      return value;
    }
  }

  const currentValue = row[currentColumn] ?? '';
  return currentValue.trim() ? currentValue : null;
}

export function resolveTradingViewRowExchange(row: Record<string, string>) {
  for (const [key, value] of Object.entries(row)) {
    if (EXCHANGE_COLUMN_KEYS.has(normalizeColumnLabel(key)) && value.trim()) {
      return value;
    }
  }

  return null;
}

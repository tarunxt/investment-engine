export type TradingViewMarket = 'india' | 'us';

const INDIA_EXCHANGES = new Set(['NSE', 'BSE']);
const US_EXCHANGES = new Set(['NASDAQ', 'NYSE', 'AMEX']);
const US_EXCHANGE_ALIASES: Record<string, string> = {
  NASDAQGS: 'NASDAQ',
  NASDAQGM: 'NASDAQ',
  NASDAQCM: 'NASDAQ',
  NASDAQGLOBALSELECT: 'NASDAQ',
  NASDAQGLOBALMARKET: 'NASDAQ',
  NASDAQCAPITALMARKET: 'NASDAQ',
  NASDAQSTOCKMARKET: 'NASDAQ',
  NEWYORKSTOCKEXCHANGE: 'NYSE',
  NYSEARCA: 'AMEX',
  ARCA: 'AMEX',
  AMERICANSTOCKEXCHANGE: 'AMEX',
};
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

const ALWAYS_HIDDEN_STRUCTURED_STOCK_COLUMN_KEYS = new Set([
  'exchange',
]);

const SYMBOL_BACKED_HIDDEN_STOCK_COLUMN_KEYS = new Set([
  'stock name',
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

function normalizeExchange(value: string) {
  const normalized = normalizeValue(value).replace(/[^A-Z]/g, '');
  if (normalized in US_EXCHANGE_ALIASES) {
    return US_EXCHANGE_ALIASES[normalized];
  }
  return normalized;
}

function getRowValueByNormalizedColumn(row: Record<string, string>, columnKey: string) {
  for (const [key, value] of Object.entries(row)) {
    if (normalizeColumnLabel(key) === columnKey) {
      return value;
    }
  }

  return '';
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

  const normalizedExchange = normalizeExchange(exchange ?? '');

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

export function getVisibleTradingViewColumns(columns: string[], rows: Record<string, string>[]) {
  const hasStructuredStockSymbolColumn = columns.some((column) => normalizeColumnLabel(column) === 'stock symbol');
  if (!hasStructuredStockSymbolColumn) {
    return columns;
  }

  const hasStructuredStockSymbolValue = rows.some((row) => getRowValueByNormalizedColumn(row, 'stock symbol').trim());
  return columns.filter((column) => {
    const normalized = normalizeColumnLabel(column);
    if (ALWAYS_HIDDEN_STRUCTURED_STOCK_COLUMN_KEYS.has(normalized)) {
      return false;
    }
    if (hasStructuredStockSymbolValue && SYMBOL_BACKED_HIDDEN_STOCK_COLUMN_KEYS.has(normalized)) {
      return false;
    }
    return true;
  });
}

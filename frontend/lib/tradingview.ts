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
  NYSEAMERICAN: 'AMEX',
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
    const [venue, ticker] = normalizedSymbol.split(':');
    const chartSymbol = ['US', 'UNKNOWN', 'UNRESOLVED'].includes(venue) ? ticker : `${normalizeExchange(venue)}:${ticker}`;
    return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(chartSymbol)}`;
  }

  const normalizedExchange = normalizeExchange(exchange ?? '');

  if (market === 'india' || INDIA_EXCHANGES.has(normalizedExchange)) {
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

// Recognize listed equity venues in prose. Other uppercase words, source IDs,
// URLs and fragments of longer identifiers are not stock mentions.
const mentionPattern = /https?:\/\/[^\s<>]+|(?<![\w/:@.-])(?:NSE|BSE|NASDAQ(?:GS|GM|CM)?|NYSE(?:ARCA|AMERICAN)?|AMEX|ARCA|BATS|OTC(?:QX|QB)?|CBOE|LSE|TSX|TSXV|ASX|HKEX):[A-Z0-9](?:[A-Z0-9._&-]{0,22}[A-Z0-9])?(?![\w&-]|\.[\w])/gi;

export function tradingViewMentions(text: string) {
  if (!text.includes(':')) return [];
  return Array.from(text.matchAll(mentionPattern))
    .filter(match => !/^https?:/i.test(match[0]))
    .map(match => ({ symbol: match[0], start: match.index, end: match.index + match[0].length }));
}

const identityKeys = new Set([...SYMBOL_COLUMN_KEYS, 'listing', 'canonical listing', 'stock ticker', 'trading symbol']);
export function stockIdentityForColumns(columns: string[], values: readonly unknown[]) {
  let symbol = '', exchange = '';
  columns.forEach((column, index) => {
    const key = normalizeColumnLabel(column);
    const value = values[index];
    if (typeof value !== 'string' && typeof value !== 'number') return;
    const label = String(value).trim();
    if (identityKeys.has(key) && looksLikeTradingViewSymbol(label) && (!symbol || label.includes(':'))) symbol = label;
    if (EXCHANGE_COLUMN_KEYS.has(key) || key === 'venue' || key === 'stock exchange') exchange = label;
  });
  return { symbol, exchange };
}

export function chartSymbolForCell(column: string, text: string, identity: {symbol: string}) {
  const key = normalizeColumnLabel(column);
  const ownListing = identityKeys.has(key) || key === 'paper holding' || key === 'stock';
  if (ownListing && QUALIFIED_SYMBOL_PATTERN.test(normalizeValue(text))) return text;
  if (identity.symbol && (ownListing || key === 'name' || isTradingViewDisplayColumn(column))) return identity.symbol;
  if ((ownListing || ['first listing', 'second listing', 'opponent'].includes(key)) && looksLikeTradingViewSymbol(text)) return text;
  return null;
}

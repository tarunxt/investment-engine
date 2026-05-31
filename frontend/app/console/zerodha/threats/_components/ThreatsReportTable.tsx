'use client';

import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { useState } from 'react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TradingViewSymbolLink } from '@/components/shared/TradingViewSymbolLink';
import {
  getVisibleTradingViewColumns,
  isTradingViewDisplayColumn,
  resolveTradingViewRowExchange,
  resolveTradingViewRowSymbol,
  type TradingViewMarket,
} from '@/lib/tradingview';
import { cn } from '@/lib/utils';
import { type ZerodhaThreatTableSection } from '@/types/api';

const SEVERITY_STYLES: Record<string, string> = {
  'very high': 'bg-rose-100 text-rose-800 ring-rose-200',
  high: 'bg-orange-100 text-orange-800 ring-orange-200',
  medium: 'bg-amber-100 text-amber-800 ring-amber-200',
  low: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
};

const ACTION_STYLES: Record<string, string> = {
  'urgent sell': 'bg-rose-100 text-rose-800 ring-rose-200',
  'sell all': 'bg-red-100 text-red-800 ring-red-200',
  trim: 'bg-orange-100 text-orange-800 ring-orange-200',
  'partial profit booking': 'bg-amber-100 text-amber-900 ring-amber-200',
  'tighten stop-loss': 'bg-sky-100 text-sky-800 ring-sky-200',
  'avoid fresh buying': 'bg-slate-100 text-slate-800 ring-slate-200',
  'watch for exit': 'bg-violet-100 text-violet-800 ring-violet-200',
  'reduce before earnings/event': 'bg-fuchsia-100 text-fuchsia-800 ring-fuchsia-200',
  'shift to trailing stop': 'bg-emerald-100 text-emerald-800 ring-emerald-200',
  hold: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
};

const PRIORITY_RANKS: Record<string, number> = {
  'very high': 4,
  high: 3,
  medium: 2,
  low: 1,
};

const URGENT_GROUP_TONES = ['bg-rose-50/60', 'bg-sky-50/55', 'bg-amber-50/50'];
const URGENT_GROUP_LABEL_COLUMN_KEYS = new Set([
  'stock symbol',
  'ticker',
  'symbol',
  'stock name',
  'holding',
  'company',
  'company name',
]);
const STOCK_SYMBOL_COLUMN_KEYS = new Set([
  'stock symbol',
  'ticker',
  'symbol',
  'ticker / symbol',
  'symbol / ticker',
  'holding ticker',
  'holding symbol',
]);

type SortDirection = 'asc' | 'desc';
type SortState = { column: string; direction: SortDirection } | null;
type ThreatRow = Record<string, string>;
type UrgentRowIdentity = {
  exchange: string;
  symbol: string;
  name: string;
};
type HoldingMetricLookupEntry = {
  amountInvested: number | null;
  portfolioPercentage: number | null;
};
type CurrentPriceLookupEntry = {
  currentPrice: number | null;
  currency: string | null;
};

export type ThreatHoldingMetric = {
  exchange?: string | null;
  stockSymbol: string;
  amountInvested: number | null;
  portfolioPercentage: number | null;
};
export type ThreatCurrentPriceMetric = {
  exchange?: string | null;
  stockSymbol: string;
  currentPrice: number | null;
  currency?: string | null;
};

function resolveTone(header: string, value: string) {
  const normalizedHeader = header.trim().toLowerCase();
  const normalizedValue = value.trim().toLowerCase();

  if (
    normalizedHeader.includes('severity')
    || normalizedHeader.includes('risk')
    || normalizedHeader.includes('priority')
  ) {
    return SEVERITY_STYLES[normalizedValue];
  }

  if (
    normalizedHeader.includes('action')
    || normalizedHeader.includes('bias')
    || normalizedHeader.includes('time sensitivity')
  ) {
    return ACTION_STYLES[normalizedValue];
  }

  return undefined;
}

function splitCellLines(value: string) {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
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

function normalizeLookupToken(value: string | null | undefined) {
  return value
    ? value.trim().toLowerCase().replace(/\s+/g, ' ')
    : '';
}

function normalizeUrgentIdentityValue(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function priorityRank(value: string) {
  return PRIORITY_RANKS[value.trim().toLowerCase()] ?? 0;
}

function hasPriorityValue(value: string) {
  return priorityRank(value) > 0;
}

function parseNumericValue(value: string) {
  const normalized = value.replace(/,/g, '').replace(/[^0-9.-]/g, '');
  if (!normalized || normalized === '-' || normalized === '.' || normalized === '-.') {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDateValue(value: string) {
  if (!value || value === '-' || value.toLowerCase() === 'not found') {
    return null;
  }

  const normalized = value
    .replace(/\bIST\b/g, 'GMT+0530')
    .replace(/\bUTC\b/g, 'GMT')
    .trim();
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function columnHasPriorityValues(rows: ThreatRow[], column: string) {
  const values = rows
    .flatMap((row) => getRowLines(row, column))
    .map((value) => value.trim())
    .filter(Boolean);

  if (values.length === 0) {
    return false;
  }

  return values.some(hasPriorityValue) && values.every((value) => value === '-' || hasPriorityValue(value));
}

function resolveSortKind(rows: ThreatRow[], column: string) {
  const normalized = normalizeColumnLabel(column);
  if (normalized === 'priority' || columnHasPriorityValues(rows, column)) return 'priority';
  if (normalized === 'tagged at') return 'timestamp';
  if (normalized.includes('date') || normalized.includes('deadline')) return 'date';
  if (
    normalized.includes('amount')
    || normalized.includes('percentage')
    || normalized.includes('weight')
    || normalized.includes('value')
    || normalized.includes('price')
    || normalized.includes('cost')
    || normalized.includes('rank')
  ) {
    return 'number';
  }
  return 'text';
}

function resolveDefaultDirection(rows: ThreatRow[], column: string): SortDirection {
  return resolveSortKind(rows, column) === 'text' ? 'asc' : 'desc';
}

function getRowLines(row: Record<string, string>, column: string) {
  const lines = splitCellLines(row[column] ?? '');
  return lines.length > 0 ? lines : [''];
}

function getPrioritySortValue(row: Record<string, string>, column: string) {
  return Math.max(...getRowLines(row, column).map(priorityRank), 0);
}

function getNumberSortValue(row: Record<string, string>, column: string) {
  for (const line of getRowLines(row, column)) {
    const parsed = parseNumericValue(line);
    if (parsed !== null) return parsed;
  }
  return null;
}

function getTimestampSortValue(row: Record<string, string>, column: string) {
  const parsedValues = getRowLines(row, column)
    .map(parseDateValue)
    .filter((value): value is number => value !== null);
  if (parsedValues.length === 0) {
    return null;
  }
  return Math.max(...parsedValues);
}

function getTextSortValue(row: Record<string, string>, column: string) {
  return getRowLines(row, column)[0]?.toLowerCase() ?? '';
}

function getPrimaryStockSortValue(row: Record<string, string>) {
  return getTextSortValue(row, 'Stock Symbol') || getTextSortValue(row, 'Stock Name');
}

function getRowValueByNormalizedColumn(row: ThreatRow, targetColumn: string) {
  for (const [key, value] of Object.entries(row)) {
    if (normalizeColumnLabel(key) === targetColumn) {
      return value;
    }
  }

  return '';
}

function findColumn(columns: string[], targetColumn: string) {
  return columns.find((column) => normalizeColumnLabel(column) === targetColumn) ?? null;
}

function hasColumn(columns: string[], targetColumn: string) {
  return findColumn(columns, targetColumn) !== null;
}

function hasPercentageColumn(columns: string[]) {
  return columns.some((column) => {
    const normalized = normalizeColumnLabel(column);
    return normalized.includes('percentage') || normalized.includes('weight');
  });
}

function findStockSymbolColumn(columns: string[]) {
  return columns.find((column) => STOCK_SYMBOL_COLUMN_KEYS.has(normalizeColumnLabel(column))) ?? null;
}

function buildHoldingMetricLookup(holdingMetrics: ThreatHoldingMetric[]) {
  const lookup = new Map<string, HoldingMetricLookupEntry>();

  for (const holdingMetric of holdingMetrics) {
    const normalizedSymbol = normalizeLookupToken(holdingMetric.stockSymbol);
    if (!normalizedSymbol) {
      continue;
    }

    const entry = {
      amountInvested: holdingMetric.amountInvested ?? null,
      portfolioPercentage: holdingMetric.portfolioPercentage ?? null,
    };
    const normalizedExchange = normalizeLookupToken(holdingMetric.exchange ?? '');

    if (normalizedExchange) {
      lookup.set(`exchange_symbol:${normalizedExchange}:${normalizedSymbol}`, entry);
    }
    lookup.set(`symbol:${normalizedSymbol}`, entry);
  }

  return lookup;
}

function buildCurrentPriceLookup(currentPrices: ThreatCurrentPriceMetric[]) {
  const lookup = new Map<string, CurrentPriceLookupEntry>();

  for (const currentPrice of currentPrices) {
    const normalizedSymbol = normalizeLookupToken(currentPrice.stockSymbol);
    if (!normalizedSymbol) {
      continue;
    }

    const entry = {
      currentPrice: currentPrice.currentPrice ?? null,
      currency: currentPrice.currency ?? null,
    };
    const normalizedExchange = normalizeLookupToken(currentPrice.exchange ?? '');

    if (normalizedExchange) {
      lookup.set(`exchange_symbol:${normalizedExchange}:${normalizedSymbol}`, entry);
    }
    lookup.set(`symbol:${normalizedSymbol}`, entry);
  }

  return lookup;
}

function resolveHoldingMetric(
  row: ThreatRow,
  holdingMetricLookup: Map<string, HoldingMetricLookupEntry>,
) {
  const symbol = normalizeLookupToken(
    splitCellLines(
      getRowValueByNormalizedColumn(row, 'stock symbol')
        || getRowValueByNormalizedColumn(row, 'ticker')
        || getRowValueByNormalizedColumn(row, 'symbol'),
    )[0] ?? '',
  );
  if (!symbol) {
    return null;
  }

  const exchange = normalizeLookupToken(resolveTradingViewRowExchange(row) ?? '');
  if (exchange) {
    const exchangeMatch = holdingMetricLookup.get(`exchange_symbol:${exchange}:${symbol}`);
    if (exchangeMatch) {
      return exchangeMatch;
    }
  }

  return holdingMetricLookup.get(`symbol:${symbol}`) ?? null;
}

function resolveCurrentPrice(
  row: ThreatRow,
  currentPriceLookup: Map<string, CurrentPriceLookupEntry>,
) {
  const symbol = normalizeLookupToken(
    splitCellLines(
      getRowValueByNormalizedColumn(row, 'stock symbol')
        || getRowValueByNormalizedColumn(row, 'ticker')
        || getRowValueByNormalizedColumn(row, 'symbol'),
    )[0] ?? '',
  );
  if (!symbol) {
    return null;
  }

  const exchange = normalizeLookupToken(resolveTradingViewRowExchange(row) ?? '');
  if (exchange) {
    const exchangeMatch = currentPriceLookup.get(`exchange_symbol:${exchange}:${symbol}`);
    if (exchangeMatch) {
      return exchangeMatch;
    }
  }

  return currentPriceLookup.get(`symbol:${symbol}`) ?? null;
}

function formatAmountInvested(value: number | null, market: TradingViewMarket) {
  if (value === null || !Number.isFinite(value)) {
    return '-';
  }

  const currencyCode = market === 'india' ? 'INR' : 'USD';
  return `${currencyCode} ${value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatPortfolioPercentage(value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return '-';
  }

  return `${value.toFixed(2)}%`;
}

function formatCurrentPrice(value: number | null, currency: string | null, loading: boolean) {
  if (value === null || !Number.isFinite(value)) {
    return loading ? 'Loading...' : '-';
  }

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: (currency ?? 'USD').toUpperCase(),
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function resolveUrgentRowIdentity(row: ThreatRow): UrgentRowIdentity {
  return {
    exchange: normalizeUrgentIdentityValue(resolveTradingViewRowExchange(row) ?? ''),
    symbol: normalizeUrgentIdentityValue(
      getRowValueByNormalizedColumn(row, 'stock symbol')
        || getRowValueByNormalizedColumn(row, 'ticker')
        || getRowValueByNormalizedColumn(row, 'symbol'),
    ),
    name: normalizeUrgentIdentityValue(
      getRowValueByNormalizedColumn(row, 'stock name')
        || getRowValueByNormalizedColumn(row, 'company name')
        || getRowValueByNormalizedColumn(row, 'company')
        || getRowValueByNormalizedColumn(row, 'holding'),
    ),
  };
}

function urgentIdentityNamesMatch(left: string, right: string) {
  if (!left || !right) return false;
  if (left === right) return true;
  return Math.min(left.length, right.length) >= 5 && (left.includes(right) || right.includes(left));
}

function urgentRowIdentitiesMatch(left: UrgentRowIdentity, right: UrgentRowIdentity) {
  if (left.exchange && right.exchange && left.exchange !== right.exchange) {
    return false;
  }

  if (left.symbol && right.symbol && left.symbol === right.symbol) {
    return true;
  }

  return urgentIdentityNamesMatch(left.name, right.name);
}

function buildUrgentRowGroups(rows: ThreatRow[]) {
  const groups: Array<{ identity: UrgentRowIdentity; rows: ThreatRow[] }> = [];

  for (const row of rows) {
    const identity = resolveUrgentRowIdentity(row);
    const existingGroup = groups.find((group) => urgentRowIdentitiesMatch(identity, group.identity));
    if (existingGroup) {
      existingGroup.rows.push(row);
      continue;
    }

    groups.push({ identity, rows: [row] });
  }

  return groups.map((group, index) => ({
    key: `${group.identity.exchange}:${group.identity.symbol || group.identity.name || index}`,
    rows: group.rows,
  }));
}

function resolveUrgentGroupLabelColumn(columns: string[]) {
  return columns.find((column) => normalizeColumnLabel(column) === 'stock symbol')
    ?? columns.find((column) => URGENT_GROUP_LABEL_COLUMN_KEYS.has(normalizeColumnLabel(column)))
    ?? null;
}

function compareNullableNumbers(left: number | null, right: number | null, direction: SortDirection) {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return direction === 'asc' ? left - right : right - left;
}

function compareText(left: string, right: string, direction: SortDirection) {
  const comparison = left.localeCompare(right, undefined, { sensitivity: 'base' });
  return direction === 'asc' ? comparison : -comparison;
}

function compareRowsByDefault(left: Record<string, string>, right: Record<string, string>) {
  const priorityComparison = compareNullableNumbers(
    getPrioritySortValue(left, 'Priority'),
    getPrioritySortValue(right, 'Priority'),
    'desc',
  );
  if (priorityComparison !== 0) {
    return priorityComparison;
  }

  const timestampComparison = compareNullableNumbers(
    getTimestampSortValue(left, 'Tagged At'),
    getTimestampSortValue(right, 'Tagged At'),
    'desc',
  );
  if (timestampComparison !== 0) {
    return timestampComparison;
  }

  return compareText(
    getPrimaryStockSortValue(left),
    getPrimaryStockSortValue(right),
    'asc',
  );
}

function compareRowsByColumn(
  left: Record<string, string>,
  right: Record<string, string>,
  rows: ThreatRow[],
  sortState: NonNullable<SortState>,
) {
  const { column, direction } = sortState;
  const kind = resolveSortKind(rows, column);

  if (kind === 'priority') {
    return compareNullableNumbers(
      getPrioritySortValue(left, column),
      getPrioritySortValue(right, column),
      direction,
    );
  }

  if (kind === 'number') {
    return compareNullableNumbers(
      getNumberSortValue(left, column),
      getNumberSortValue(right, column),
      direction,
    );
  }

  if (kind === 'timestamp' || kind === 'date') {
    return compareNullableNumbers(
      getTimestampSortValue(left, column),
      getTimestampSortValue(right, column),
      direction,
    );
  }

  return compareText(
    getTextSortValue(left, column),
    getTextSortValue(right, column),
    direction,
  );
}

function compareRowsByFallback(
  left: ThreatRow,
  right: ThreatRow,
  columns: string[],
) {
  const stockComparison = compareText(
    getPrimaryStockSortValue(left),
    getPrimaryStockSortValue(right),
    'asc',
  );
  if (stockComparison !== 0) {
    return stockComparison;
  }

  for (const column of columns) {
    const comparison = compareText(
      getTextSortValue(left, column),
      getTextSortValue(right, column),
      'asc',
    );
    if (comparison !== 0) {
      return comparison;
    }
  }

  return 0;
}

function resolveDefaultSortState(
  sectionKey: string,
  columns: string[],
  rows: ThreatRow[],
): SortState {
  if (sectionKey === 'urgent_actionables') {
    const priorityColumn = findColumn(columns, 'priority');
    if (priorityColumn) {
      return {
        column: priorityColumn,
        direction: 'desc',
      };
    }
  }

  const exposureColumn = columns.find((column) => normalizeColumnLabel(column).includes('weight / exposure'));
  if (exposureColumn) {
    return {
      column: exposureColumn,
      direction: 'desc',
    };
  }

  const severityColumn = columns.find((column) => columnHasPriorityValues(rows, column));
  if (severityColumn) {
    return {
      column: severityColumn,
      direction: 'desc',
    };
  }

  return null;
}

export function ThreatsReportTable({
  section,
  market,
  className,
  holdingMetrics = [],
  currentPrices = [],
  currentPricesLoading = false,
}: {
  section: ZerodhaThreatTableSection;
  market: TradingViewMarket;
  className?: string;
  holdingMetrics?: ThreatHoldingMetric[];
  currentPrices?: ThreatCurrentPriceMetric[];
  currentPricesLoading?: boolean;
}) {
  const isUrgentTable = section.key === 'urgent_actionables';
  const [sortState, setSortState] = useState<SortState>(null);

  if (section.rows.length === 0) {
    return null;
  }

  const baseVisibleColumns = getVisibleTradingViewColumns(section.columns, section.rows);
  const holdingMetricLookup = buildHoldingMetricLookup(holdingMetrics);
  const currentPriceLookup = buildCurrentPriceLookup(currentPrices);
  const stockSymbolColumn = findStockSymbolColumn(baseVisibleColumns);
  const trendColumn = findColumn(baseVisibleColumns, 'trend');
  const shouldInjectHoldingMetrics = holdingMetricLookup.size > 0 && Boolean(stockSymbolColumn);
  const shouldInjectCurrentPrice = section.key === 'technical_risk_map'
    && market === 'us'
    && Boolean(trendColumn)
    && !hasColumn(baseVisibleColumns, 'current price');
  const needsAmountInvestedColumn = shouldInjectHoldingMetrics
    && !hasColumn(baseVisibleColumns, 'amount invested');
  const needsPercentageColumn = shouldInjectHoldingMetrics
    && !hasPercentageColumn(baseVisibleColumns);
  const visibleColumns = baseVisibleColumns.flatMap((column) => {
    if (column !== stockSymbolColumn) {
      return [column];
    }

    const derivedColumns = [];
    if (needsAmountInvestedColumn) {
      derivedColumns.push('Amount Invested');
    }
    if (needsPercentageColumn) {
      derivedColumns.push('Portfolio Weight');
    }

    return [column, ...derivedColumns];
  }).flatMap((column) => {
    if (!shouldInjectCurrentPrice || column !== trendColumn) {
      return [column];
    }

    return [column, 'Current Price'];
  });
  const rowsWithHoldingMetrics = section.rows.map((row) => {
    if (
      (!shouldInjectHoldingMetrics || (!needsAmountInvestedColumn && !needsPercentageColumn))
      && !shouldInjectCurrentPrice
    ) {
      return row;
    }

    const holdingMetric = resolveHoldingMetric(row, holdingMetricLookup);
    const currentPrice = resolveCurrentPrice(row, currentPriceLookup);
    return {
      ...row,
      ...(needsAmountInvestedColumn ? {
        'Amount Invested': formatAmountInvested(holdingMetric?.amountInvested ?? null, market),
      } : {}),
      ...(needsPercentageColumn ? {
        'Portfolio Weight': formatPortfolioPercentage(holdingMetric?.portfolioPercentage ?? null),
      } : {}),
      ...(shouldInjectCurrentPrice ? {
        'Current Price': formatCurrentPrice(
          currentPrice?.currentPrice ?? null,
          currentPrice?.currency ?? null,
          currentPricesLoading,
        ),
      } : {}),
    };
  });
  const defaultSortState = resolveDefaultSortState(section.key, visibleColumns, rowsWithHoldingMetrics);
  const activeSortState = sortState && visibleColumns.includes(sortState.column)
    ? sortState
    : defaultSortState;
  const rows = activeSortState
    ? [...rowsWithHoldingMetrics].sort((left, right) => {
      const comparison = compareRowsByColumn(left, right, rowsWithHoldingMetrics, activeSortState);
      const fallbackComparison = isUrgentTable
        ? compareRowsByDefault(left, right)
        : compareRowsByFallback(left, right, visibleColumns);

      return comparison !== 0 ? comparison : fallbackComparison;
    })
    : rowsWithHoldingMetrics;
  const urgentRowGroups = isUrgentTable ? buildUrgentRowGroups(rows) : [];
  const urgentGroupLabelColumn = isUrgentTable ? resolveUrgentGroupLabelColumn(visibleColumns) : null;

  function handleSort(column: string) {
    setSortState((current) => {
      const currentValue = current?.column === column ? current : activeSortState;
      if (currentValue?.column === column) {
        return {
          column,
          direction: currentValue.direction === 'desc' ? 'asc' : 'desc',
        };
      }
      return {
        column,
        direction: resolveDefaultDirection(rowsWithHoldingMetrics, column),
      };
    });
  }

  function renderCellLine(
    column: string,
    value: string,
    rowSymbol: string | null,
    rowExchange: string | null,
  ) {
    const tone = resolveTone(column, value);
    if (tone) {
      return (
        <span className={cn('inline-flex w-fit rounded-full px-2.5 py-1 text-xs font-semibold ring-1', tone)}>
          {value || '-'}
        </span>
      );
    }

    return (
      <div className="min-w-[10rem] max-w-[18rem] whitespace-pre-wrap leading-6">
        {isTradingViewDisplayColumn(column) && value ? (
          <TradingViewSymbolLink
            symbol={rowSymbol ?? value}
            market={market}
            exchange={rowExchange}
            className="font-medium hover:text-blue-700"
          >
            <span className="underline-offset-4 hover:underline">{value}</span>
          </TradingViewSymbolLink>
        ) : (
          value || '-'
        )}
      </div>
    );
  }

  return (
    <Card className={cn('rounded-[30px] border-0 bg-white shadow-sm ring-1 ring-slate-200/80', className)}>
      <CardHeader className="border-b border-slate-200/80 pb-5">
        <CardTitle className="text-sm tracking-[0.18em] text-slate-700">{section.title}</CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-50/80">
              <tr>
                {visibleColumns.map((column) => (
                  <th
                    key={column}
                    className="px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500"
                  >
                    <button
                      type="button"
                      onClick={() => handleSort(column)}
                      className="inline-flex min-w-[10rem] max-w-[16rem] items-start gap-2 whitespace-normal text-left transition-colors hover:text-slate-700"
                    >
                      <span>{column}</span>
                      {activeSortState?.column === column ? (
                        activeSortState.direction === 'asc' ? (
                          <ArrowUp className="mt-0.5 size-3.5 shrink-0" />
                        ) : (
                          <ArrowDown className="mt-0.5 size-3.5 shrink-0" />
                        )
                      ) : (
                        <ArrowUpDown className="mt-0.5 size-3.5 shrink-0 opacity-70" />
                      )}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {isUrgentTable
                ? urgentRowGroups.flatMap((group, groupIndex) => {
                  const groupTone = URGENT_GROUP_TONES[groupIndex % URGENT_GROUP_TONES.length];

                  return group.rows.map((row, rowIndex) => (
                    <tr key={`${section.key}-${group.key}-${rowIndex}`} className="align-top">
                      {visibleColumns.map((column) => {
                        const shouldMergeGroupLabelCell = column === urgentGroupLabelColumn;
                        if (shouldMergeGroupLabelCell && rowIndex > 0) {
                          return null;
                        }

                        const value = row[column] ?? '';
                        const cellLines = getRowLines(row, column);
                        const rowSymbol = resolveTradingViewRowSymbol(row, column);
                        const rowExchange = resolveTradingViewRowExchange(row);

                        return (
                          <td
                            key={`${column}-${group.key}-${rowIndex}`}
                            rowSpan={shouldMergeGroupLabelCell ? group.rows.length : undefined}
                            className={cn(
                              'px-5 py-4 text-slate-700',
                              groupTone,
                              shouldMergeGroupLabelCell && 'align-top font-semibold text-slate-900',
                            )}
                          >
                            {cellLines.length > 1 ? (
                              <div className="min-w-[10rem] max-w-[18rem] divide-y divide-slate-200/80">
                                {cellLines.map((line, lineIndex) => (
                                  <div
                                    key={`${column}-${group.key}-${rowIndex}-${lineIndex}`}
                                    className="py-3 first:pt-0 last:pb-0"
                                  >
                                    {renderCellLine(column, line, rowSymbol, rowExchange)}
                                  </div>
                                ))}
                              </div>
                            ) : (
                              renderCellLine(column, value, rowSymbol, rowExchange)
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ));
                })
                : rows.map((row, index) => (
                  <tr key={`${section.key}-${index}`} className="align-top">
                    {visibleColumns.map((column) => {
                      const value = row[column] ?? '';
                      const rowSymbol = resolveTradingViewRowSymbol(row, column);
                      const rowExchange = resolveTradingViewRowExchange(row);

                      return (
                        <td key={`${column}-${index}`} className="px-5 py-4 text-slate-700">
                          {renderCellLine(column, value, rowSymbol, rowExchange)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

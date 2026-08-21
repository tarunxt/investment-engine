'use client';

import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import React, { useState } from 'react';

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
import type { PortfolioEventTable } from '@/types/api';

const OUTCOME_STYLES: Record<string, string> = {
  Bullish: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
  Bearish: 'bg-rose-100 text-rose-800 ring-rose-200',
  Neutral: 'bg-amber-100 text-amber-900 ring-amber-200',
};
const OUTCOME_RANKS: Record<string, number> = {
  bearish: 3,
  bullish: 2,
  neutral: 1,
};
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
type EventRow = Record<string, string>;
type HoldingMetricLookupEntry = {
  amountInvested: number | null;
  portfolioPercentage: number | null;
};

export type EventHoldingMetric = {
  exchange?: string | null;
  stockSymbol: string;
  amountInvested: number | null;
  portfolioPercentage: number | null;
};

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

function getRowValueByNormalizedColumn(row: EventRow, targetColumn: string) {
  for (const [key, value] of Object.entries(row)) {
    if (normalizeColumnLabel(key) === targetColumn) {
      return value;
    }
  }

  return '';
}

function buildHoldingMetricLookup(holdingMetrics: EventHoldingMetric[]) {
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

function resolveHoldingMetric(
  row: EventRow,
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

  const parsed = Date.parse(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function outcomeRank(value: string) {
  return OUTCOME_RANKS[value.trim().toLowerCase()] ?? 0;
}

function isOutcomeColumn(column: string) {
  const normalized = normalizeColumnLabel(column);
  return normalized === 'expected outcome' || normalized === 'outcome';
}

function getRowLines(row: EventRow, column: string) {
  const lines = splitCellLines(row[column] ?? '');
  return lines.length > 0 ? lines : [''];
}

function getNumberSortValue(row: EventRow, column: string) {
  for (const line of getRowLines(row, column)) {
    const parsed = parseNumericValue(line);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

function getDateSortValue(row: EventRow, column: string) {
  const parsedValues = getRowLines(row, column)
    .map(parseDateValue)
    .filter((value): value is number => value !== null);
  if (parsedValues.length === 0) {
    return null;
  }

  return Math.min(...parsedValues);
}

function getOutcomeSortValue(row: EventRow, column: string) {
  return Math.max(...getRowLines(row, column).map(outcomeRank), 0);
}

function getTextSortValue(row: EventRow, column: string) {
  return getRowLines(row, column)[0]?.toLowerCase() ?? '';
}

function resolveSortKind(column: string) {
  const normalized = normalizeColumnLabel(column);
  if (isOutcomeColumn(column)) return 'outcome';
  if (normalized === 'date' || normalized.includes('date')) return 'date';
  if (
    normalized.includes('amount')
    || normalized.includes('percentage')
    || normalized.includes('weight')
    || normalized.includes('value')
    || normalized.includes('price')
  ) {
    return 'number';
  }

  return 'text';
}

function resolveDefaultDirection(column: string): SortDirection {
  const sortKind = resolveSortKind(column);
  if (sortKind === 'date') return 'asc';
  if (sortKind === 'text') return 'asc';
  return 'desc';
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

function compareRowsByColumn(
  left: EventRow,
  right: EventRow,
  sortState: NonNullable<SortState>,
) {
  const { column, direction } = sortState;
  const sortKind = resolveSortKind(column);

  if (sortKind === 'outcome') {
    return compareNullableNumbers(
      getOutcomeSortValue(left, column),
      getOutcomeSortValue(right, column),
      direction,
    );
  }

  if (sortKind === 'number') {
    return compareNullableNumbers(
      getNumberSortValue(left, column),
      getNumberSortValue(right, column),
      direction,
    );
  }

  if (sortKind === 'date') {
    return compareNullableNumbers(
      getDateSortValue(left, column),
      getDateSortValue(right, column),
      direction,
    );
  }

  return compareText(
    getTextSortValue(left, column),
    getTextSortValue(right, column),
    direction,
  );
}

function compareRowsByFallback(left: EventRow, right: EventRow) {
  const outcomeComparison = compareNullableNumbers(
    getOutcomeSortValue(left, 'Expected Outcome'),
    getOutcomeSortValue(right, 'Expected Outcome'),
    'desc',
  );
  if (outcomeComparison !== 0) {
    return outcomeComparison;
  }

  const dateComparison = compareNullableNumbers(
    getDateSortValue(left, 'Date'),
    getDateSortValue(right, 'Date'),
    'asc',
  );
  if (dateComparison !== 0) {
    return dateComparison;
  }

  return compareText(
    getTextSortValue(left, 'Stock Symbol'),
    getTextSortValue(right, 'Stock Symbol'),
    'asc',
  );
}

function resolveDefaultSortState(columns: string[]): SortState {
  const outcomeColumn = columns.find((column) => isOutcomeColumn(column));
  if (outcomeColumn) {
    return {
      column: outcomeColumn,
      direction: 'desc',
    };
  }

  return null;
}

function renderSourceContent(value: string) {
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  const matches = [...value.matchAll(pattern)];
  if (matches.length === 0) {
    return value || '-';
  }

  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;

  matches.forEach((match, index) => {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      nodes.push(
        <span key={`text-${index}`}>
          {value.slice(lastIndex, start)}
        </span>,
      );
    }

    nodes.push(
      <a
        key={`link-${index}`}
        href={match[2]}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-600 underline transition-colors hover:text-blue-800"
      >
        {match[1]}
      </a>,
    );
    lastIndex = start + match[0].length;
  });

  if (lastIndex < value.length) {
    nodes.push(
      <span key="tail">
        {value.slice(lastIndex)}
      </span>,
    );
  }

  return nodes;
}

export function EventCalendarTable({
  table,
  market,
  title = 'Upcoming Events',
  className,
  holdingMetrics = [],
}: {
  table: PortfolioEventTable;
  market: TradingViewMarket;
  title?: string;
  className?: string;
  holdingMetrics?: EventHoldingMetric[];
}) {
  const [sortState, setSortState] = useState<SortState>(null);

  if (table.rows.length === 0) {
    return null;
  }

  const baseVisibleColumns = getVisibleTradingViewColumns(table.columns, table.rows);
  const holdingMetricLookup = buildHoldingMetricLookup(holdingMetrics);
  const stockSymbolColumn = findStockSymbolColumn(baseVisibleColumns);
  const shouldInjectHoldingMetrics = holdingMetricLookup.size > 0 && Boolean(stockSymbolColumn);
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
  });
  const rowsWithHoldingMetrics = table.rows.map((row) => {
    if (!shouldInjectHoldingMetrics || (!needsAmountInvestedColumn && !needsPercentageColumn)) {
      return row;
    }

    const holdingMetric = resolveHoldingMetric(row, holdingMetricLookup);
    return {
      ...row,
      ...(needsAmountInvestedColumn ? {
        'Amount Invested': formatAmountInvested(holdingMetric?.amountInvested ?? null, market),
      } : {}),
      ...(needsPercentageColumn ? {
        'Portfolio Weight': formatPortfolioPercentage(holdingMetric?.portfolioPercentage ?? null),
      } : {}),
    };
  });
  const defaultSortState = resolveDefaultSortState(visibleColumns);
  const activeSortState = sortState && visibleColumns.includes(sortState.column)
    ? sortState
    : defaultSortState;
  const rows = activeSortState
    ? [...rowsWithHoldingMetrics].sort((left, right) => {
      const comparison = compareRowsByColumn(left, right, activeSortState);
      return comparison !== 0 ? comparison : compareRowsByFallback(left, right);
    })
    : rowsWithHoldingMetrics;

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
        direction: resolveDefaultDirection(column),
      };
    });
  }

  return (
    <Card className={cn('rounded-[30px] border-0 bg-white shadow-sm ring-1 ring-slate-200/80', className)}>
      <CardHeader className="border-b border-slate-200/80 pb-5">
        <CardTitle className="text-sm tracking-[0.18em] text-slate-700">{title}</CardTitle>
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
                      className="inline-flex min-w-[10rem] max-w-[18rem] items-start gap-2 whitespace-normal text-left transition-colors hover:text-slate-700"
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
              {rows.map((row, index) => (
                <tr key={`event-row-${index}`} className="align-top">
                  {visibleColumns.map((column) => {
                    const value = row[column] ?? '';
                    const rowSymbol = resolveTradingViewRowSymbol(row, column);
                    const rowExchange = resolveTradingViewRowExchange(row);

                    if (isOutcomeColumn(column)) {
                      const normalizedValue = value.trim().toLowerCase();
                      const tone = OUTCOME_STYLES[
                        normalizedValue === 'bearish'
                          ? 'Bearish'
                          : normalizedValue === 'bullish'
                            ? 'Bullish'
                            : 'Neutral'
                      ] ?? OUTCOME_STYLES.Neutral;
                      return (
                        <td key={`${column}-${index}`} className="px-5 py-4 text-slate-700">
                          <span className={cn('inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ring-1', tone)}>
                            {value || 'Neutral'}
                          </span>
                        </td>
                      );
                    }

                    return (
                      <td key={`${column}-${index}`} className="px-5 py-4 text-slate-700">
                        <div className="min-w-[10rem] max-w-[20rem] whitespace-pre-wrap leading-6">
                          {column === 'Status / Source'
                            ? renderSourceContent(value)
                            : isTradingViewDisplayColumn(column) && value
                              ? (
                                  <TradingViewSymbolLink
                                    symbol={rowSymbol ?? value}
                                    market={market}
                                    exchange={rowExchange}
                                    className="font-medium hover:text-blue-700"
                                  >
                                    <span className="underline-offset-4 hover:underline">{value}</span>
                                  </TradingViewSymbolLink>
                                )
                              : (value || '-')}
                        </div>
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

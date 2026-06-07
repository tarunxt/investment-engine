'use client';

import { useMemo } from 'react';
import MarkdownRenderer from '@/components/shared/MarkdownRenderer';
import { TradingViewSymbolLink } from '@/components/shared/TradingViewSymbolLink';
import { getStandardActionTextClass, type StandardActionCategory } from '@/lib/actionColorScheme';
import { cn } from '@/lib/utils';

interface JsonRecommendationRow {
  [key: string]: unknown;
}

interface JsonRecommendationPayload {
  title?: string;
  stocks: JsonRecommendationRow[];
}


function normalizeActionCell(value: string): StandardActionCategory | null {
  const normalized = value.toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  if (!normalized) return null;
  if (normalized.includes('sell all') || normalized === 'sell') return 'Sell All';
  if (normalized.includes('trim')) return 'Trim';
  if (normalized.includes('hold')) return 'Hold';
  if (normalized.includes('buy new')) return 'Buy New';
  if (normalized.includes('add more') || normalized === 'add') return 'Add more';
  return null;
}

interface Props {
  content: string;
  provider?: string;
  model?: string;
  runNumber?: number;
  runCreatedAt?: string;
}

interface ParsedMarkdownTable {
  headers: string[];
  rows: string[][];
}

export interface CanonicalTable {
  title?: string;
  headers: readonly CanonicalHeader[];
  rows: CanonicalRow[];
}

const SWING_HEADER_ORDER = [
  'LLM Name + Model',
  'Exchange Symbol',
  'Stock Symbol',
  'Stock Name',
  'Technical Setup',
  'Entry Range',
  'Stop Loss',
  'Target',
  'Analyst Source',
  'Units to Buy',
  'Price per Unit',
  'Total Buy Amount',
  'Upside Horizon (%)',
  'Weeks',
  'Confidence Score (0-100)',
  'Rationale Cruxx',
  'Score Rationale Cruxx',
  'Rationale - Technical Setup (Medium Term)',
  'Score Rationale - Technical Setup (Medium Term)',
  'Rationale - Technical Setup (Long Term)',
  'Score Rationale - Technical Setup (Long Term)',
  'Rationale - Fundamentals Short Term',
  'Score Rationale - Fundamentals Short Term',
  'Rationale - Fundamentals Medium/Long Term',
  'Score Rationale - Fundamentals Medium/Long Term',
  'Rationale Technical Setup Short Term 1–3 Months',
  'Score Rationale Technical Setup Short Term 1–3 Months',
  'Run #',
  'Run Date',
  'Run Time',
  'LLM',
] as const;

export const REBALANCE_HEADER_ORDER = [
  'Exchange Symbol',
  'Stock Symbol',
  'Current Units',
  'Action (Buy/Add/Sell All/Trim/Hold/Buy New)',
  'Units Change',
  'Final Units',
  'Technical Setup',
  'Entry Range',
  'Stop Loss',
  'Target',
  'Analyst/Source',
  'Units to Buy',
  'Price Per Unit',
  'Total Buy Amount',
  'Upside Horizon (% return)',
  'Weeks',
  'Confidence Score (0-100)',
  'Rationale Cruxx',
  'Score Rationale Cruxx',
  'Rationale Technical Setup Short Term 1–3 Months',
  'Score Rationale Technical Setup Short Term 1–3 Months',
  'Rationale - Technical Setup (Medium Term)',
  'Score Rationale - Technical Setup (Medium Term)',
  'Rationale - Technical Setup (Long Term)',
  'Score Rationale - Technical Setup (Long Term)',
  'Rationale - Fundamentals Short Term',
  'Score Rationale - Fundamentals Short Term',
  'Rationale - Fundamentals Medium/Long Term',
  'Score Rationale - Fundamentals Medium/Long Term',
] as const;

export type SwingHeader = (typeof SWING_HEADER_ORDER)[number];
export type RebalanceHeader = (typeof REBALANCE_HEADER_ORDER)[number];
export type CanonicalHeader = SwingHeader | RebalanceHeader;
export type CanonicalRow = Record<string, string>;

const HEADERLESS_CANONICAL_HEADER_ORDERS: SwingHeader[][] = [
  [...SWING_HEADER_ORDER],
  [...SWING_HEADER_ORDER.slice(0, -1)],
  SWING_HEADER_ORDER.filter(
    (header) => header !== 'Rationale - Technical Setup (Long Term)',
  ) as SwingHeader[],
  SWING_HEADER_ORDER.filter(
    (header) => header !== 'Rationale - Technical Setup (Long Term)' && header !== 'LLM',
  ) as SwingHeader[],
];
const HEADERLESS_CANONICAL_MIN_COLUMN_COUNT =
  HEADERLESS_CANONICAL_HEADER_ORDERS[HEADERLESS_CANONICAL_HEADER_ORDERS.length - 1].length;
const HEADERLESS_CANONICAL_NUMERIC_HEADERS: SwingHeader[] = [
  'Units to Buy',
  'Price per Unit',
  'Total Buy Amount',
  'Upside Horizon (%)',
  'Weeks',
  'Confidence Score (0-100)',
  'Score Rationale Cruxx',
  'Score Rationale - Technical Setup (Medium Term)',
  'Score Rationale - Technical Setup (Long Term)',
  'Score Rationale - Fundamentals Short Term',
  'Score Rationale - Fundamentals Medium/Long Term',
  'Score Rationale Technical Setup Short Term 1–3 Months',
];

const HEADER_ALIAS_TO_EXACT: Record<string, CanonicalHeader> = {
  'llm name model': 'LLM Name + Model',
  'llm name plus model': 'LLM Name + Model',
  'exchange symbol': 'Exchange Symbol',
  'stock symbol': 'Stock Symbol',
  'stock name': 'Stock Name',
  'current units': 'Current Units',
  'action': 'Action (Buy/Add/Sell All/Trim/Hold/Buy New)',
  'action buy add sell all trim hold buy new': 'Action (Buy/Add/Sell All/Trim/Hold/Buy New)',
  'units change': 'Units Change',
  'final units': 'Final Units',
  'technical setup': 'Technical Setup',
  'entry range': 'Entry Range',
  'stop loss': 'Stop Loss',
  'target': 'Target',
  'analyst source': 'Analyst Source',
  'analyst/source': 'Analyst/Source',
  'units to buy': 'Units to Buy',
  'price per unit': 'Price per Unit',
  'price per unit inr': 'Price Per Unit',
  'total buy amount': 'Total Buy Amount',
  'upside horizon': 'Upside Horizon (%)',
  'upside horizon percent': 'Upside Horizon (%)',
  'upside horizon percent return in weeks': 'Upside Horizon (% return)',
  'upside horizon percent return': 'Upside Horizon (% return)',
  'upside horizon return in weeks': 'Upside Horizon (% return)',
  'upside horizon return': 'Upside Horizon (% return)',
  'weeks': 'Weeks',
  'confidence score': 'Confidence Score (0-100)',
  'confidence score 0 100': 'Confidence Score (0-100)',
  'rationale remarks': 'Rationale Cruxx',
  'rationale cruxx': 'Rationale Cruxx',
  'score rationale remarks': 'Score Rationale Cruxx',
  'score rationale cruxx': 'Score Rationale Cruxx',
  'rationale technical setup medium term': 'Rationale - Technical Setup (Medium Term)',
  'score rationale technical setup medium term': 'Score Rationale - Technical Setup (Medium Term)',
  'rationale technical setup long term': 'Rationale - Technical Setup (Long Term)',
  'score rationale technical setup long term': 'Score Rationale - Technical Setup (Long Term)',
  'rationale technical setup long term term': 'Rationale - Technical Setup (Long Term)',
  'rationale fundamentals short term': 'Rationale - Fundamentals Short Term',
  'score rationale fundamentals short term': 'Score Rationale - Fundamentals Short Term',
  'rationale fundamentals medium long term': 'Rationale - Fundamentals Medium/Long Term',
  'score rationale fundamentals medium long term': 'Score Rationale - Fundamentals Medium/Long Term',
  'rationale technical setup short term 1 3 months': 'Rationale Technical Setup Short Term 1–3 Months',
  'score rationale technical setup short term 1 3 months': 'Score Rationale Technical Setup Short Term 1–3 Months',
  'run #': 'Run #',
  'run number': 'Run #',
  'run date': 'Run Date',
  'run time': 'Run Time',
  llm: 'LLM',
};

function normalizeHeader(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\*\*/g, '')
    .replace(/[`*]/g, '')
    .replace(/_/g, ' ')
    .replace(/[–—]/g, '-')
    .replace(/\+/g, ' plus ')
    .replace(/%/g, ' percent ')
    .replace(/[()]/g, ' ')
    .replace(/[/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map((item) => formatCellValue(item)).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).trim();
}

function buildEmptyCanonicalRow(headers: readonly CanonicalHeader[]): CanonicalRow {
  return headers.reduce((acc, header) => {
    acc[header] = '';
    return acc;
  }, {} as CanonicalRow);
}

function canonicalHeadersForSource(source: Record<string, unknown>): readonly CanonicalHeader[] {
  const mappedHeaders = Object.keys(source).map((key) => HEADER_ALIAS_TO_EXACT[normalizeHeader(key)]);
  return mappedHeaders.some((header) => REBALANCE_HEADER_ORDER.includes(header as RebalanceHeader))
    ? REBALANCE_HEADER_ORDER
    : SWING_HEADER_ORDER;
}

function canonicalHeaderForKey(key: string, headers: readonly CanonicalHeader[]): CanonicalHeader | undefined {
  const mappedHeader = HEADER_ALIAS_TO_EXACT[normalizeHeader(key)];
  if (!mappedHeader) return undefined;
  if (headers.includes(mappedHeader)) return mappedHeader;

  const rebalanceAliases: Partial<Record<CanonicalHeader, RebalanceHeader>> = {
    'Analyst Source': 'Analyst/Source',
    'Price per Unit': 'Price Per Unit',
    'Upside Horizon (%)': 'Upside Horizon (% return)',
    'Rationale Technical Setup Short Term 1–3 Months': 'Rationale Technical Setup Short Term 1–3 Months',
    'Rationale - Technical Setup (Medium Term)': 'Rationale - Technical Setup (Medium Term)',
    'Rationale - Technical Setup (Long Term)': 'Rationale - Technical Setup (Long Term)',
    'Rationale - Fundamentals Short Term': 'Rationale - Fundamentals Short Term',
  };
  const rebalanceHeader = rebalanceAliases[mappedHeader];
  if (rebalanceHeader && headers.includes(rebalanceHeader)) return rebalanceHeader;

  return undefined;
}

function looksLikeSeparator(value: string | number | undefined): boolean {
  const text = String(value ?? '').trim();
  if (!text) return false;
  return /^[\-|_=:\s.]+$/.test(text);
}

function isKnownHeaderRow(headers: string[]): boolean {
  const hits = headers.reduce((count, header) => {
    return HEADER_ALIAS_TO_EXACT[normalizeHeader(header)] ? count + 1 : count;
  }, 0);
  return hits >= Math.min(4, headers.length);
}

function isHeaderLikeRow(row: string[], headers: string[]): boolean {
  if (!row.length || !headers.length) return false;
  const max = Math.min(row.length, headers.length);
  let matches = 0;
  for (let i = 0; i < max; i += 1) {
    if (normalizeHeader(row[i]) === normalizeHeader(headers[i])) matches += 1;
  }
  return matches >= Math.max(3, Math.floor(headers.length / 2));
}

function parseJsonContent(content: string): JsonRecommendationPayload | JsonRecommendationRow[] | null {
  const trimmed = content.trim();
  if (!trimmed || !/^(?:```json\s*|```[\s\S]*[{[]|[{[])/i.test(trimmed)) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed.replace(/```json/gi, '').replace(/```/g, '').trim()) as unknown;
    if (Array.isArray(parsed)) {
      return parsed as JsonRecommendationRow[];
    }
    if (
      parsed &&
      typeof parsed === 'object' &&
      'stocks' in parsed &&
      Array.isArray((parsed as JsonRecommendationPayload).stocks)
    ) {
      return parsed as JsonRecommendationPayload;
    }
    return null;
  } catch (error) {
    console.error('Error parsing investment recommendation data:', error);
    return null;
  }
}

function parseMarkdownTable(content: string): ParsedMarkdownTable | null {
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const tableLines = lines.filter((line) => line.includes('|'));
  if (tableLines.length < 2) return null;

  const headerIndex = tableLines.findIndex((line) => {
    const cols = line
      .split('|')
      .map((cell) => cell.trim())
      .filter(Boolean);
    return cols.length >= 4 && isKnownHeaderRow(cols);
  });

  if (headerIndex === -1) return null;

  const headers = tableLines[headerIndex]
    .split('|')
    .map((cell) => cell.trim())
    .filter(Boolean);

  const rows: string[][] = [];
  for (const line of tableLines.slice(headerIndex + 1)) {
    if (/^\|?[\s:\-|\t]+\|?$/.test(line)) continue;
    const cols = line
      .split('|')
      .map((cell) => cell.trim())
      .filter(Boolean);
    if (!cols.length) continue;
    if (isHeaderLikeRow(cols, headers)) continue;
    if (cols.length < headers.length) {
      cols.push(...Array(headers.length - cols.length).fill(''));
    }
    rows.push(cols.slice(0, headers.length));
  }

  if (!rows.length) return null;
  return { headers, rows };
}

function parseSingleLinePipeTable(content: string): ParsedMarkdownTable | null {
  const compact = content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');

  if (!compact.includes('|')) return null;

  const tokens = compact
    .split('|')
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length < 10) return null;

  const separatorIndex = tokens.findIndex((token) => looksLikeSeparator(token));
  if (separatorIndex <= 0) return null;

  const headers = tokens.slice(0, separatorIndex);
  if (!isKnownHeaderRow(headers)) return null;

  const dataTokens = tokens.slice(separatorIndex).filter((token) => !looksLikeSeparator(token));
  const columnCount = headers.length;
  const rows: string[][] = [];

  for (let i = 0; i + columnCount <= dataTokens.length; i += columnCount) {
    const row = dataTokens.slice(i, i + columnCount);
    if (isHeaderLikeRow(row, headers)) continue;
    rows.push(row);
  }

  if (!rows.length) return null;
  return { headers, rows };
}

function formatRunMetadata(runCreatedAt?: string): { runDate: string; runTime: string } {
  if (!runCreatedAt) return { runDate: '', runTime: '' };

  const parsed =
    /[zZ]|[+-]\d{2}:\d{2}$/.test(runCreatedAt) ? new Date(runCreatedAt) : new Date(`${runCreatedAt}Z`);

  if (Number.isNaN(parsed.getTime())) return { runDate: '', runTime: '' };

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(parsed);

  const lookup = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';

  return {
    runDate: `${lookup('year')}-${lookup('month')}-${lookup('day')}`,
    runTime: `${lookup('hour')}:${lookup('minute')}:${lookup('second')}`,
  };
}

function toDisplayProvider(provider?: string): string {
  if (!provider) return '';
  return provider
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function buildCanonicalRow(
  source: Record<string, unknown>,
  context: { provider?: string; model?: string; runNumber?: number; runCreatedAt?: string },
  headers = canonicalHeadersForSource(source),
): CanonicalRow {
  const row = buildEmptyCanonicalRow(headers);

  for (const [key, value] of Object.entries(source)) {
    const mappedHeader = canonicalHeaderForKey(key, headers);
    if (!mappedHeader) continue;
    row[mappedHeader] = formatCellValue(value);
  }

  const providerLabel = toDisplayProvider(context.provider);
  const llmNameModel = providerLabel && context.model ? `${providerLabel} ${context.model}` : providerLabel || context.model || '';
  const { runDate, runTime } = formatRunMetadata(context.runCreatedAt);

  if (llmNameModel) {
    row['LLM Name + Model'] = llmNameModel;
  }
  if (providerLabel) {
    row.LLM = providerLabel;
  }
  if (!row.LLM && row['LLM Name + Model']) {
    row.LLM = row['LLM Name + Model'].split(/[\s/]+/)[0] ?? '';
  }
  if (context.runNumber !== undefined) {
    row['Run #'] = String(context.runNumber);
  }
  if (runDate) {
    row['Run Date'] = runDate;
  }
  if (runTime) {
    row['Run Time'] = runTime;
  }

  return row;
}

function isLikelyInvalidRow(row: CanonicalRow): boolean {
  const stockName = row['Stock Name'];
  const stockSymbol = row['Stock Symbol'];
  const exchangeSymbol = row['Exchange Symbol'];
  const technicalSetup = row['Technical Setup'];
  const entryRange = row['Entry Range'];

  if (![stockName, stockSymbol, exchangeSymbol, technicalSetup, entryRange].some((value) => String(value).trim())) {
    return true;
  }

  if (
    normalizeHeader(stockName) === 'stock name' ||
    normalizeHeader(stockSymbol) === 'stock symbol' ||
    normalizeHeader(technicalSetup) === 'technical setup'
  ) {
    return true;
  }

  return (
    looksLikeSeparator(stockName) ||
    looksLikeSeparator(stockSymbol) ||
    looksLikeSeparator(technicalSetup)
  );
}

function normalizeJsonTable(
  parsed: JsonRecommendationPayload | JsonRecommendationRow[],
  context: { provider?: string; model?: string; runNumber?: number; runCreatedAt?: string },
): CanonicalTable | null {
  const title = Array.isArray(parsed) ? undefined : parsed.title;
  const stocks = Array.isArray(parsed) ? parsed : parsed.stocks;
  const rows = stocks
    .map((stock) => buildCanonicalRow(stock, context))
    .filter((row) => !isLikelyInvalidRow(row));

  if (!rows.length) return null;
  const headers = stocks.some((stock) => canonicalHeadersForSource(stock).includes('Action (Buy/Add/Sell All/Trim/Hold/Buy New)'))
    ? REBALANCE_HEADER_ORDER
    : SWING_HEADER_ORDER;
  return { title, headers, rows };
}

export function normalizeMarkdownRecommendationTable(
  content: string,
  context: { provider?: string; model?: string; runNumber?: number; runCreatedAt?: string },
): CanonicalTable | null {
  const parsed = parseMarkdownTable(content) ?? parseSingleLinePipeTable(content);
  if (!parsed) return null;

  const headers = canonicalHeadersForSource(Object.fromEntries(parsed.headers.map((header) => [header, ''])));
  const rows = parsed.rows
    .map((row) => {
      const source: Record<string, string> = {};
      parsed.headers.forEach((header, index) => {
        source[header] = row[index] ?? '';
      });
      return buildCanonicalRow(source, context, headers);
    })
    .filter((row) => !isLikelyInvalidRow(row));

  if (!rows.length) return null;
  return { headers, rows };
}

function looksLikeHeaderlessCanonicalRow(tokens: string[], headers: SwingHeader[]): boolean {
  if (tokens.length !== headers.length) {
    return false;
  }

  const exchangeSymbol = tokens[headers.indexOf('Exchange Symbol')]?.trim().toUpperCase() ?? '';
  const stockSymbol = tokens[headers.indexOf('Stock Symbol')]?.trim() ?? '';
  const stockName = tokens[headers.indexOf('Stock Name')]?.trim() ?? '';
  const entryRange = tokens[headers.indexOf('Entry Range')]?.trim() ?? '';
  const runDate = tokens[headers.indexOf('Run Date')]?.trim() ?? '';
  const runTime = tokens[headers.indexOf('Run Time')]?.trim() ?? '';

  if (!['NSE', 'BSE'].includes(exchangeSymbol)) return false;
  if (!stockSymbol || stockSymbol.length > 20) return false;
  if (!stockName) return false;
  if (!/\d/.test(entryRange)) return false;
  if (!/\d{2,4}/.test(runDate)) return false;
  if (!runTime.includes(':')) return false;

  const numericHits = HEADERLESS_CANONICAL_NUMERIC_HEADERS.reduce((count, header) => {
    const value = (tokens[headers.indexOf(header)] ?? '').replace(/,/g, '').trim();
    return /^-?\d+(?:[.,]\d+)?$/.test(value)
      ? count + 1
      : count;
  }, 0);

  return numericHits >= 5;
}

function parseHeaderlessCanonicalLine(tokens: string[]): Record<string, string>[] {
  for (const headers of HEADERLESS_CANONICAL_HEADER_ORDERS) {
    if (tokens.length < headers.length || tokens.length % headers.length !== 0) continue;

    const items: Record<string, string>[] = [];
    let valid = true;

    for (let offset = 0; offset + headers.length <= tokens.length; offset += headers.length) {
      const chunk = tokens.slice(offset, offset + headers.length);
      if (!looksLikeHeaderlessCanonicalRow(chunk, headers)) {
        valid = false;
        break;
      }

      const source: Record<string, string> = {};
      headers.forEach((header, index) => {
        source[header] = chunk[index] ?? '';
      });
      items.push(source);
    }

    if (valid && items.length) {
      return items;
    }
  }

  return [];
}

function parseHeaderlessCanonicalRows(
  content: string,
  context: { provider?: string; model?: string; runNumber?: number; runCreatedAt?: string },
): CanonicalTable | null {
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const titleLine = lines.find((line) => line.startsWith('#'));
  const title = titleLine ? titleLine.replace(/^#+\s*/, '').trim() : undefined;

  const rows: CanonicalRow[] = [];

  for (const line of lines) {
    if (line.split('|').length - 1 < HEADERLESS_CANONICAL_MIN_COLUMN_COUNT - 2) continue;
    const tokens = line
      .split('|')
      .map((token) => token.trim())
      .filter(Boolean);

    for (const source of parseHeaderlessCanonicalLine(tokens)) {
      rows.push(buildCanonicalRow(source, context));
    }
  }

  const cleanedRows = rows.filter((row) => !isLikelyInvalidRow(row));
  if (!cleanedRows.length) return null;
  return { title, headers: SWING_HEADER_ORDER, rows: cleanedRows };
}

export function parseInvestmentRecommendationContent(
  content: string,
  context: { provider?: string; model?: string; runNumber?: number; runCreatedAt?: string } = {},
): CanonicalTable | null {
  const parsedJson = parseJsonContent(content);
  if (parsedJson) {
    return normalizeJsonTable(parsedJson, context);
  }
  return normalizeMarkdownRecommendationTable(content, context) ?? parseHeaderlessCanonicalRows(content, context);
}

export default function InvestmentRecommendationTable({
  content,
  provider,
  model,
  runNumber,
  runCreatedAt,
}: Props) {
  const canonicalTable = useMemo(() => (
    parseInvestmentRecommendationContent(content, { provider, model, runNumber, runCreatedAt })
  ), [content, model, provider, runCreatedAt, runNumber]);

  if (!canonicalTable) {
    return <MarkdownRenderer content={content} />;
  }

  return (
    <div className="space-y-4">
      {canonicalTable.title ? (
        <div className="border-b border-gray-200 pb-3">
          <h3 className="text-base font-semibold text-gray-900">{canonicalTable.title}</h3>
        </div>
      ) : null}
      <div className="overflow-x-auto">
	        <table className="min-w-max text-sm">
          <thead>
            <tr className="border-b border-gray-300 bg-gray-50">
              {canonicalTable.headers.map((header) => (
                <th
                  key={header}
                  className="whitespace-nowrap px-3 py-2 text-left font-semibold text-gray-700"
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
	          <tbody className="divide-y divide-gray-200">
	            {canonicalTable.rows.map((row, rowIdx) => (
	              <tr key={rowIdx} className="hover:bg-gray-50">
	                {canonicalTable.headers.map((header) => {
	                  const cellValue = row[header];
	                  const stockSymbol = row['Stock Symbol'] || row['Stock Name'];
	                  const exchangeSymbol = row['Exchange Symbol'];
	                  const market = ['NSE', 'BSE'].includes(exchangeSymbol) ? 'india' : 'us';

	                  const content =
	                    (header === 'Stock Name' || header === 'Stock Symbol') && cellValue ? (
	                      <TradingViewSymbolLink
	                        symbol={stockSymbol}
	                        market={market}
	                        exchange={exchangeSymbol}
	                        className="hover:text-blue-700"
	                      >
	                        <span className="underline-offset-4 hover:underline">{cellValue}</span>
	                      </TradingViewSymbolLink>
	                    ) : (
	                      cellValue
	                    );

	                  return (
	                    <td
                        key={`${rowIdx}-${header}`}
                        className={cn(
                          "px-3 py-2 align-top text-gray-700",
                          header === "Action (Buy/Add/Sell All/Trim/Hold/Buy New)" && normalizeActionCell(cellValue)
                            ? getStandardActionTextClass(normalizeActionCell(cellValue)!)
                            : null,
                        )}
                      >
	                      {content}
	                    </td>
	                  );
	                })}
	              </tr>
	            ))}
	          </tbody>
	        </table>
      </div>
    </div>
  );
}

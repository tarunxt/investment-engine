'use client';

import { useMemo } from 'react';
import MarkdownRenderer from '@/components/shared/MarkdownRenderer';

interface Stock {
  stock_name: string;
  technical_setup: string;
  entry_range: string;
  stop_loss: number;
  target: number;
  analyst_source: string;
  units_to_buy: number;
  price_per_unit: number;
  total_buy_amount: number;
  upside_horizon: string;
  confidence_score: number;
  rationale_remarks: string;
}

interface InvestmentRecommendation {
  title: string;
  stocks: Stock[];
}

interface Props {
  content: string;
}

interface ParsedMarkdownTable {
  headers: string[];
  rows: string[][];
}

const EXACT_HEADER_ORDER = [
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
  'Rationale Remarks',
  'Rationale - Technical Setup (Medium Term)',
  'Rationale - Technical Setup (Long Term)',
  'Rationale - Fundamentals Short Term',
  'Rationale - Fundamentals Medium/Long Term',
  'Rationale Technical Setup Short Term 1–3 Months',
  'Run #',
  'Run Date',
  'Run Time',
  'LLM',
] as const;

const HEADER_ALIAS_TO_EXACT: Record<string, (typeof EXACT_HEADER_ORDER)[number]> = {
  'llm name model': 'LLM Name + Model',
  'llm name plus model': 'LLM Name + Model',
  'exchange symbol': 'Exchange Symbol',
  'stock symbol': 'Stock Symbol',
  'stock name': 'Stock Name',
  'technical setup': 'Technical Setup',
  'entry range': 'Entry Range',
  'stop loss': 'Stop Loss',
  'target': 'Target',
  'analyst source': 'Analyst Source',
  'analyst/source': 'Analyst Source',
  'units to buy': 'Units to Buy',
  'price per unit': 'Price per Unit',
  'total buy amount': 'Total Buy Amount',
  'upside horizon': 'Upside Horizon (%)',
  'upside horizon percent': 'Upside Horizon (%)',
  'upside horizon (%)': 'Upside Horizon (%)',
  'weeks': 'Weeks',
  'confidence score': 'Confidence Score (0-100)',
  'confidence score (0-100)': 'Confidence Score (0-100)',
  'rationale remarks': 'Rationale Remarks',
  'rationale - technical setup (medium term)': 'Rationale - Technical Setup (Medium Term)',
  'rationale technical setup medium term': 'Rationale - Technical Setup (Medium Term)',
  'rationale - technical setup (long term)': 'Rationale - Technical Setup (Long Term)',
  'rationale technical setup long term': 'Rationale - Technical Setup (Long Term)',
  'rationale - fundamentals short term': 'Rationale - Fundamentals Short Term',
  'rationale fundamentals short term': 'Rationale - Fundamentals Short Term',
  'rationale - fundamentals medium/long term': 'Rationale - Fundamentals Medium/Long Term',
  'rationale fundamentals medium long term': 'Rationale - Fundamentals Medium/Long Term',
  'rationale technical setup short term 1 3 months': 'Rationale Technical Setup Short Term 1–3 Months',
  'run #': 'Run #',
  'run number': 'Run #',
  'run date': 'Run Date',
  'run time': 'Run Time',
  'llm': 'LLM',
};

function normalizeHeader(value: string): string {
  return value
    .toLowerCase()
    .replace(/\*\*/g, '')
    .replace(/[`_*]/g, '')
    .replace(/[–—]/g, '-')
    .replace(/\+/g, ' plus ')
    .replace(/[()]/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\//g, '/')
    .replace(/\s+/g, ' ')
    .trim();
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

function parseMarkdownTable(content: string): ParsedMarkdownTable | null {
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const tableLines = lines.filter((line) => line.includes('|'));
  if (tableLines.length < 3) return null;

  const headerLine = tableLines.find((line) => {
    const cols = line
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean);
    return cols.length >= 4;
  });
  if (!headerLine) return null;

  const headers = headerLine
    .split('|')
    .map((c) => c.trim())
    .filter(Boolean);
  if (!headers.length) return null;

  const rows: string[][] = [];
  for (const line of tableLines) {
    if (line === headerLine) continue;
    if (/^\|?[\s:\-|\t]+\|?$/.test(line)) continue;
    const cols = line
      .split('|')
      .map((c) => c.trim())
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

function looksLikeSeparator(value: string | number | undefined): boolean {
  const text = String(value ?? '').trim();
  if (!text) return false;
  return /^[\-\|_=\s.]+$/.test(text);
}

function isHeaderStockRow(stock: Stock): boolean {
  const symbol = normalizeHeader(String(stock.stock_name || ''));
  const setup = normalizeHeader(String(stock.technical_setup || ''));
  const entry = normalizeHeader(String(stock.entry_range || ''));
  const source = normalizeHeader(String(stock.analyst_source || ''));
  return (
    symbol === 'stock name' ||
    symbol === 'stock symbol' ||
    setup === 'technical setup' ||
    entry === 'entry range' ||
    source === 'analyst/source' ||
    source === 'analyst source'
  );
}

function isLikelyInvalidRow(stock: Stock): boolean {
  if (isHeaderStockRow(stock)) return true;
  if (
    looksLikeSeparator(stock.stock_name) ||
    looksLikeSeparator(stock.technical_setup) ||
    looksLikeSeparator(stock.entry_range)
  ) {
    return true;
  }
  return false;
}

export default function InvestmentRecommendationTable({ content }: Props) {
  const data = useMemo(() => {
    try {
      const parsed = JSON.parse(content.replaceAll('```json', '').replaceAll('```', ''));
      if (parsed.title && Array.isArray(parsed.stocks) && parsed.stocks.length > 0) {
        return parsed as InvestmentRecommendation;
      }
      return null;
    } catch (e) {
      console.error('Error parsing investment recommendation data:', e);
      return null;
    }
  }, [content]);

  const markdownTable = useMemo(() => {
    if (data) return null;
    return parseMarkdownTable(content);
  }, [content, data]);

  const normalizedMarkdownTable = useMemo(() => {
    if (!markdownTable) return null;

    const sourceIndexByTarget: Partial<Record<(typeof EXACT_HEADER_ORDER)[number], number>> = {};
    markdownTable.headers.forEach((header, idx) => {
      const key = normalizeHeader(header);
      const mapped = HEADER_ALIAS_TO_EXACT[key];
      if (mapped && sourceIndexByTarget[mapped] === undefined) {
        sourceIndexByTarget[mapped] = idx;
      }
    });

    const llmNameModelIndex = sourceIndexByTarget['LLM Name + Model'];
    const llmIndex = sourceIndexByTarget.LLM;

    const rows = markdownTable.rows.map((row) => {
      const normalizedRow = EXACT_HEADER_ORDER.map((target) => {
        const idx = sourceIndexByTarget[target];
        return idx !== undefined ? (row[idx] ?? '') : '';
      });

      if (!normalizedRow[EXACT_HEADER_ORDER.indexOf('LLM')]) {
        const llmNameModel = llmNameModelIndex !== undefined ? String(row[llmNameModelIndex] ?? '').trim() : '';
        const llmValue = llmIndex !== undefined ? String(row[llmIndex] ?? '').trim() : '';
        const derivedLlm = llmValue || (llmNameModel ? llmNameModel.split(/\s+/)[0] : '');
        normalizedRow[EXACT_HEADER_ORDER.indexOf('LLM')] = derivedLlm;
      }

      return normalizedRow;
    });

    return { headers: [...EXACT_HEADER_ORDER], rows };
  }, [markdownTable]);

  const cleanStocks = useMemo(() => {
    if (!data) return [];
    return data.stocks.filter((stock) => !isLikelyInvalidRow(stock));
  }, [data]);

  if (normalizedMarkdownTable) {
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-300 bg-gray-50">
              {normalizedMarkdownTable.headers.map((header, index) => (
                <th key={`${header}-${index}`} className="px-3 py-2 text-left font-semibold text-gray-700">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {normalizedMarkdownTable.rows.map((row, rowIdx) => (
              <tr key={rowIdx} className="hover:bg-gray-50">
                {row.map((cell, colIdx) => (
                  <td key={`${rowIdx}-${colIdx}`} className="px-3 py-2 align-top text-gray-700">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (!data) {
    return <MarkdownRenderer content={content} />;
  }

  const rows = cleanStocks.length > 0 ? cleanStocks : data.stocks;

  const totalInvestment = rows.reduce((sum, stock) => sum + (stock.total_buy_amount || 0), 0);
  const avgConfidence =
    rows.reduce((sum, stock) => sum + (stock.confidence_score || 0), 0) / rows.length;

  return (
    <div className="space-y-6">
      {/* Title */}
      <div className="border-b border-gray-200 pb-4">
        <h3 className="text-base font-semibold text-gray-900">{data.title}</h3>
        <div className="mt-3 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Total Investment</p>
            <p className="mt-1 text-lg font-semibold text-gray-900">₹{totalInvestment.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Stocks Selected</p>
            <p className="mt-1 text-lg font-semibold text-gray-900">{rows.length}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Avg Confidence</p>
            <p className="mt-1 text-lg font-semibold text-gray-900">{avgConfidence.toFixed(1)}%</p>
          </div>
        </div>
      </div>

      {/* Stocks Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-300 bg-gray-50">
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Stock</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Entry Range</th>
              <th className="px-4 py-3 text-right font-semibold text-gray-700">Stop Loss</th>
              <th className="px-4 py-3 text-right font-semibold text-gray-700">Target</th>
              <th className="px-4 py-3 text-right font-semibold text-gray-700">Units</th>
              <th className="px-4 py-3 text-right font-semibold text-gray-700">Total Amount</th>
              <th className="px-4 py-3 text-center font-semibold text-gray-700">Confidence</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {rows.map((stock, idx) => (
              <tr key={idx} className="hover:bg-gray-50">
                <td className="px-4 py-3">
                  <div className="font-medium text-gray-900">{stock.stock_name}</div>
                  <div className="mt-0.5 text-xs text-gray-500">{stock.analyst_source}</div>
                </td>
                <td className="px-4 py-3 text-gray-700">{stock.entry_range}</td>
                <td className="px-4 py-3 text-right font-medium text-gray-900">
                  {stock.stop_loss || '—'}
                </td>
                <td className="px-4 py-3 text-right font-medium text-gray-900">
                  {stock.target || '—'}
                </td>
                <td className="px-4 py-3 text-right text-gray-700">{stock.units_to_buy}</td>
                <td className="px-4 py-3 text-right font-medium text-gray-900">
                  ₹{(stock.total_buy_amount || 0).toLocaleString()}
                </td>
                <td className="px-4 py-3 text-center">
                  <span className="inline-flex items-center rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-800">
                    {stock.confidence_score}%
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Details Section */}
      <div className="space-y-4">
        <h4 className="font-semibold text-gray-900">Technical Setup & Analysis</h4>
        <div className="grid gap-4 md:grid-cols-2">
          {rows.map((stock, idx) => (
            <div key={idx} className="border border-gray-200 bg-gray-50 p-4">
              <p className="font-medium text-gray-900">{stock.stock_name}</p>
              <div className="mt-3 space-y-2 text-sm">
                <div>
                  <p className="text-xs font-semibold uppercase text-gray-500">Upside Horizon</p>
                  <p className="mt-0.5 text-gray-700">{stock.upside_horizon}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase text-gray-500">Technical Setup</p>
                  <p className="mt-0.5 text-gray-700">{stock.technical_setup}</p>
                </div>
                {stock.rationale_remarks && (
                  <div>
                    <p className="text-xs font-semibold uppercase text-gray-500">Remarks</p>
                    <p className="mt-0.5 text-gray-700">{stock.rationale_remarks}</p>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

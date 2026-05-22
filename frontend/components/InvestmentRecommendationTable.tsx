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

  if (!data) {
    return <MarkdownRenderer content={content} />;
  }

  const totalInvestment = data.stocks.reduce((sum, stock) => sum + (stock.total_buy_amount || 0), 0);
  const avgConfidence =
    data.stocks.reduce((sum, stock) => sum + (stock.confidence_score || 0), 0) / data.stocks.length;

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
            <p className="mt-1 text-lg font-semibold text-gray-900">{data.stocks.length}</p>
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
            {data.stocks.map((stock, idx) => (
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
          {data.stocks.map((stock, idx) => (
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

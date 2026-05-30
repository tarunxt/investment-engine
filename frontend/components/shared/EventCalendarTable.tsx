'use client';

import React from 'react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { PortfolioEventTable } from '@/types/api';

const OUTCOME_STYLES: Record<string, string> = {
  Bullish: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
  Bearish: 'bg-rose-100 text-rose-800 ring-rose-200',
  Neutral: 'bg-amber-100 text-amber-900 ring-amber-200',
};

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
  title = 'Upcoming Events',
  className,
}: {
  table: PortfolioEventTable;
  title?: string;
  className?: string;
}) {
  if (table.rows.length === 0) {
    return null;
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
                {table.columns.map((column) => (
                  <th
                    key={column}
                    className="px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500"
                  >
                    <div className="min-w-[10rem] max-w-[18rem] whitespace-normal">{column}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {table.rows.map((row, index) => (
                <tr key={`event-row-${index}`} className="align-top">
                  {table.columns.map((column) => {
                    const value = row[column] ?? '';

                    if (column === 'Expected Outcome') {
                      const tone = OUTCOME_STYLES[value] ?? OUTCOME_STYLES.Neutral;
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
                          {column === 'Status / Source' ? renderSourceContent(value) : (value || '-')}
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

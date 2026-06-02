'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';

import {
  BEARISH_SETUPS,
  BULLISH_SETUPS,
  type SetupRow,
  normalizeTechnicalSetupKey,
  technicalSetupDomId,
  type SetupTableProps,
  type SortDirection,
  type SortKey,
  type SortState,
} from '@/lib/technicalSetups';

const COLUMNS: Array<{ key: SortKey; label: string; align?: 'left' | 'right' }> = [
  { key: 'setup', label: 'Setup' },
  { key: 'bias', label: 'Bias', align: 'right' },
  { key: 'confidence', label: 'Confidence', align: 'right' },
  { key: 'bestUse', label: 'Best use' },
  { key: 'trigger', label: 'Entry trigger' },
  { key: 'invalidation', label: 'Invalidation' },
];

function compareRows(a: SetupRow, b: SetupRow, key: SortKey) {
  if (key === 'confidence') {
    return a.confidence - b.confidence;
  }

  return a[key].localeCompare(b[key], undefined, { sensitivity: 'base' });
}


function getTargetRowClasses(targetTone?: 'bullish' | 'bearish') {
  if (targetTone === 'bullish') {
    return {
      row: 'bg-emerald-100 outline outline-2 outline-emerald-600 ring-2 ring-emerald-300',
      cell: 'bg-emerald-100 text-emerald-950',
      mutedCell: 'bg-emerald-100 text-emerald-900',
      scoreCell: 'bg-emerald-100 text-emerald-700',
    };
  }

  if (targetTone === 'bearish') {
    return {
      row: 'bg-red-100 outline outline-2 outline-red-600 ring-2 ring-red-300',
      cell: 'bg-red-100 text-red-950',
      mutedCell: 'bg-red-100 text-red-900',
      scoreCell: 'bg-red-100 text-red-700',
    };
  }

  return {
    row: 'bg-indigo-50 outline outline-2 outline-indigo-500 ring-2 ring-indigo-200',
    cell: 'bg-indigo-50 text-indigo-950',
    mutedCell: 'bg-indigo-50 text-indigo-900',
    scoreCell: 'bg-indigo-50 text-indigo-700',
  };
}

function SortIcon({ isActive, direction }: { isActive: boolean; direction: SortDirection }) {
  if (!isActive) {
    return <ChevronsUpDown className="size-3.5 text-gray-400" aria-hidden="true" />;
  }

  return direction === 'desc' ? (
    <ArrowDown className="size-3.5 text-indigo-600" aria-hidden="true" />
  ) : (
    <ArrowUp className="size-3.5 text-indigo-600" aria-hidden="true" />
  );
}

function SetupTable({ title, description, accentClassName, triggerLabel, rows, targetSetup, targetTone }: SetupTableProps) {
  const [sort, setSort] = useState<SortState>({ key: 'confidence', direction: 'desc' });
  const targetRowRef = useRef<HTMLTableRowElement | null>(null);
  const normalizedTargetSetup = normalizeTechnicalSetupKey(targetSetup);

  const sortedRows = useMemo(() => {
    return [...rows].sort((a, b) => {
      const comparison = compareRows(a, b, sort.key);
      return sort.direction === 'asc' ? comparison : -comparison;
    });
  }, [rows, sort]);

  useEffect(() => {
    if (!normalizedTargetSetup || !targetRowRef.current) return;

    targetRowRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    targetRowRef.current.focus({ preventScroll: true });
  }, [normalizedTargetSetup, sortedRows]);

  const handleSort = (key: SortKey) => {
    setSort((current) => ({
      key,
      direction: current.key === key && current.direction === 'desc' ? 'asc' : 'desc',
    }));
  };

  return (
    <section className="overflow-hidden border border-gray-200 bg-white shadow-sm">
      <div className={`border-l-4 px-5 py-4 ${accentClassName}`}>
        <h2 className="text-lg font-semibold text-gray-950">{title}</h2>
        <p className="mt-1 text-sm text-gray-600">{description}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
            <tr>
              {COLUMNS.map((column) => {
                const label = column.key === 'trigger' ? triggerLabel : column.label;
                const isActive = sort.key === column.key;

                return (
                  <th
                    key={column.key}
                    className={`px-4 py-3 ${column.align === 'right' ? 'text-right' : ''}`}
                    aria-sort={isActive ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
                  >
                    <button
                      type="button"
                      onClick={() => handleSort(column.key)}
                      className={`inline-flex items-center gap-1.5 font-semibold hover:text-gray-900 ${
                        column.align === 'right' ? 'justify-end' : 'justify-start'
                      }`}
                    >
                      <span>{label}</span>
                      <SortIcon isActive={isActive} direction={sort.direction} />
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {sortedRows.map((row) => {
              const isTarget =
                Boolean(normalizedTargetSetup) &&
                normalizeTechnicalSetupKey(row.setup) === normalizedTargetSetup;
              const targetClasses = isTarget ? getTargetRowClasses(targetTone) : null;
              const baseCellClass = 'px-4 py-3';

              return (
                <tr
                  key={row.setup}
                  id={technicalSetupDomId(row.setup)}
                  ref={isTarget ? targetRowRef : null}
                  tabIndex={isTarget ? -1 : undefined}
                  aria-current={isTarget ? 'true' : undefined}
                  className={`scroll-mt-24 hover:bg-gray-50/70 ${targetClasses?.row || ''}`}
                >
                  <td className={`${baseCellClass} font-semibold ${targetClasses?.cell || 'text-gray-950'}`}>{row.setup}</td>
                  <td className={`${baseCellClass} text-right ${targetClasses?.mutedCell || 'text-gray-700'}`}>{row.bias}</td>
                  <td className={`${baseCellClass} text-right font-semibold ${targetClasses?.scoreCell || 'text-gray-950'}`}>
                    {row.confidence.toFixed(1)}/10
                  </td>
                  <td className={`${baseCellClass} ${targetClasses?.mutedCell || 'text-gray-700'}`}>{row.bestUse}</td>
                  <td className={`${baseCellClass} ${targetClasses?.mutedCell || 'text-gray-700'}`}>{row.trigger}</td>
                  <td className={`${baseCellClass} ${targetClasses?.mutedCell || 'text-gray-700'}`}>{row.invalidation}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function readTargetSetupFromLocation() {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('setup');
}

export default function TechnicalSetupsPage() {
  const [targetSetup] = useState<string | null>(() => readTargetSetupFromLocation());

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.24em] text-indigo-600">Technical setups</p>
        <h1 className="mt-2 text-2xl font-semibold text-gray-950">Technical Setups</h1>
        <p className="mt-2 max-w-3xl text-sm text-gray-600">
          Bullish and bearish chart setups ranked by averaged confidence score. Each table defaults to highest confidence first;
          click any column header to toggle between descending and ascending order.
        </p>
      </div>

      <SetupTable
        title="Bullish Setups"
        description="Long-entry and continuation structures sorted by confidence score."
        accentClassName="border-emerald-500 bg-emerald-50/50"
        triggerLabel="Entry trigger"
        rows={BULLISH_SETUPS}
        targetSetup={targetSetup}
        targetTone="bullish"
      />

      <SetupTable
        title="Bearish / Sell-Trim Setups"
        description="Exit, trim, and downside-continuation structures sorted by confidence score."
        accentClassName="border-red-500 bg-red-50/50"
        triggerLabel="Sell / trim trigger"
        rows={BEARISH_SETUPS}
        targetSetup={targetSetup}
        targetTone="bearish"
      />
    </div>
  );
}

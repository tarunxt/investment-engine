'use client';

import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';

type SetupRow = {
  setup: string;
  bias: string;
  confidence: number;
  bestUse: string;
  trigger: string;
  invalidation: string;
};

type SortKey = keyof SetupRow;
type SortDirection = 'asc' | 'desc';

type SortState = {
  key: SortKey;
  direction: SortDirection;
};

type SetupTableProps = {
  title: string;
  description: string;
  accentClassName: string;
  triggerLabel: string;
  rows: SetupRow[];
};

const BULLISH_SETUPS: SetupRow[] = [
  {
    setup: 'Bottom of rising channel',
    bias: 'Bullish',
    confidence: 8.2,
    bestUse: 'Buy-the-dip in uptrend',
    trigger: 'Bullish candle from lower channel',
    invalidation: 'Close below channel',
  },
  {
    setup: 'Bottom of falling channel',
    bias: 'Short-term bullish',
    confidence: 6.0,
    bestUse: 'Counter-trend bounce only',
    trigger: 'Reversal candle near lower channel',
    invalidation: 'Close below channel',
  },
  {
    setup: 'Support bounce',
    bias: 'Bullish',
    confidence: 7.8,
    bestUse: 'Buy near demand zone',
    trigger: 'Bullish reversal from support',
    invalidation: 'Close below support',
  },
  {
    setup: 'Resistance breakout',
    bias: 'Bullish',
    confidence: 7.2,
    bestUse: 'Momentum entry',
    trigger: 'Strong close above resistance',
    invalidation: 'Falls back below breakout level',
  },
  {
    setup: 'Breakout + retest',
    bias: 'Bullish',
    confidence: 8.8,
    bestUse: 'High-quality continuation',
    trigger: 'Retest holds and bounces',
    invalidation: 'Close below retest level',
  },
  {
    setup: 'Bull flag',
    bias: 'Bullish',
    confidence: 8.2,
    bestUse: 'Strong momentum stock',
    trigger: 'Break above flag',
    invalidation: 'Close below flag low',
  },
  {
    setup: 'Ascending triangle',
    bias: 'Bullish',
    confidence: 7.7,
    bestUse: 'Accumulation breakout',
    trigger: 'Break above flat resistance',
    invalidation: 'Close below last higher low',
  },
  {
    setup: 'Symmetrical triangle – upside breakout',
    bias: 'Bullish continuation',
    confidence: 6.5,
    bestUse: 'Compression breakout in uptrend',
    trigger: 'Close above triangle',
    invalidation: 'Re-entry into triangle',
  },
  {
    setup: 'Rectangle range breakout – upside',
    bias: 'Bullish',
    confidence: 7.0,
    bestUse: 'Breakout from consolidation',
    trigger: 'Close above range resistance',
    invalidation: 'Back inside range',
  },
  {
    setup: 'Double bottom / W pattern',
    bias: 'Bullish',
    confidence: 7.7,
    bestUse: 'Reversal from support',
    trigger: 'Break above neckline',
    invalidation: 'Close below second bottom',
  },
  {
    setup: 'Inverse head & shoulders',
    bias: 'Bullish',
    confidence: 7.7,
    bestUse: 'Trend reversal',
    trigger: 'Neckline breakout',
    invalidation: 'Close below right shoulder',
  },
  {
    setup: 'Cup and handle',
    bias: 'Bullish',
    confidence: 8.2,
    bestUse: 'Positional breakout',
    trigger: 'Break above handle resistance',
    invalidation: 'Close below handle low',
  },
  {
    setup: 'Higher-low pullback',
    bias: 'Bullish',
    confidence: 8.8,
    bestUse: 'Best trend-continuation setup',
    trigger: 'Bounce after higher low',
    invalidation: 'Close below higher low',
  },
  {
    setup: '20 EMA / 50 EMA support',
    bias: 'Bullish',
    confidence: 8.2,
    bestUse: 'Trend-following entry',
    trigger: 'Bounce from EMA',
    invalidation: 'Close below EMA + structure',
  },
  {
    setup: '200 DMA reclaim',
    bias: 'Bullish',
    confidence: 7.7,
    bestUse: 'Medium-term trend shift',
    trigger: 'Close above 200 DMA + hold',
    invalidation: 'Close back below 200 DMA',
  },
  {
    setup: 'VWAP reclaim',
    bias: 'Bullish intraday',
    confidence: 7.7,
    bestUse: 'Intraday long setup',
    trigger: 'Reclaim and hold above VWAP',
    invalidation: 'Close below VWAP',
  },
  {
    setup: 'Volume dry-up pullback',
    bias: 'Bullish',
    confidence: 8.8,
    bestUse: 'Strong swing continuation',
    trigger: 'Break above pullback high',
    invalidation: 'Close below pullback low',
  },
  {
    setup: 'Volume climax reversal at support',
    bias: 'Bullish reversal',
    confidence: 6.5,
    bestUse: 'Exhaustion bounce after panic selling',
    trigger: 'Confirmation after climax candle',
    invalidation: 'Break of climax low',
  },
  {
    setup: 'Bollinger Band squeeze – upside breakout',
    bias: 'Bullish',
    confidence: 7.0,
    bestUse: 'Volatility expansion',
    trigger: 'Breakout above squeeze range',
    invalidation: 'Re-entry into range',
  },
  {
    setup: 'Failed breakdown / bear trap',
    bias: 'Bullish',
    confidence: 8.3,
    bestUse: 'Fast reversal trade',
    trigger: 'Reclaim of broken support',
    invalidation: 'Close below trap low',
  },
  {
    setup: 'RSI bullish divergence at support',
    bias: 'Bullish',
    confidence: 6.6,
    bestUse: 'Early reversal clue',
    trigger: 'Price breaks minor resistance',
    invalidation: 'Close below recent low',
  },
  {
    setup: 'Relative strength breakout',
    bias: 'Bullish',
    confidence: 8.8,
    bestUse: 'Best breakout filter',
    trigger: 'Stock breaks out while index is flat/weak',
    invalidation: 'Back inside base',
  },
  {
    setup: 'Gap-up hold / gap-and-go',
    bias: 'Bullish',
    confidence: 7.7,
    bestUse: 'News/result momentum',
    trigger: 'Opening range breakout / VWAP hold',
    invalidation: 'Below VWAP / opening range',
  },
  {
    setup: '52-week high breakout',
    bias: 'Bullish',
    confidence: 8.3,
    bestUse: 'Momentum / relative strength',
    trigger: 'Close above 52-week high/base',
    invalidation: 'Back below breakout level',
  },
];

const BEARISH_SETUPS: SetupRow[] = [
  {
    setup: 'Top of rising channel',
    bias: 'Bearish / trim',
    confidence: 6.8,
    bestUse: 'Profit booking, not aggressive exit',
    trigger: 'Rejection candle near upper channel',
    invalidation: 'Close above channel',
  },
  {
    setup: 'Top of falling channel',
    bias: 'Bearish',
    confidence: 8.2,
    bestUse: 'Sell bounce in downtrend',
    trigger: 'Rejection near upper channel',
    invalidation: 'Close above channel',
  },
  {
    setup: 'Resistance rejection',
    bias: 'Bearish',
    confidence: 7.8,
    bestUse: 'Exit/trim near supply zone',
    trigger: 'Bearish rejection from resistance',
    invalidation: 'Close above resistance',
  },
  {
    setup: 'Support breakdown',
    bias: 'Bearish',
    confidence: 7.3,
    bestUse: 'Exit weak holding',
    trigger: 'Close below support',
    invalidation: 'Reclaim of support',
  },
  {
    setup: 'Breakdown + retest',
    bias: 'Bearish',
    confidence: 8.7,
    bestUse: 'High-quality sell/exit continuation',
    trigger: 'Retest fails at old support',
    invalidation: 'Close above retest level',
  },
  {
    setup: 'Bear flag',
    bias: 'Bearish',
    confidence: 8.2,
    bestUse: 'Exit on weak continuation',
    trigger: 'Break below flag',
    invalidation: 'Close above flag high',
  },
  {
    setup: 'Descending triangle',
    bias: 'Bearish',
    confidence: 7.7,
    bestUse: 'Distribution breakdown',
    trigger: 'Break below flat support',
    invalidation: 'Close above last lower high',
  },
  {
    setup: 'Symmetrical triangle – downside breakdown',
    bias: 'Bearish continuation',
    confidence: 6.6,
    bestUse: 'Exit when compression resolves downward',
    trigger: 'Close below triangle',
    invalidation: 'Re-entry into triangle',
  },
  {
    setup: 'Rectangle range breakout – downside',
    bias: 'Bearish',
    confidence: 7.1,
    bestUse: 'Exit after consolidation failure',
    trigger: 'Close below range support',
    invalidation: 'Back inside range',
  },
  {
    setup: 'Double top / M pattern',
    bias: 'Bearish',
    confidence: 7.8,
    bestUse: 'Reversal from resistance',
    trigger: 'Break below neckline',
    invalidation: 'Close above second top',
  },
  {
    setup: 'Head & shoulders',
    bias: 'Bearish',
    confidence: 7.8,
    bestUse: 'Trend reversal / exit',
    trigger: 'Neckline breakdown',
    invalidation: 'Close above right shoulder',
  },
  {
    setup: 'Lower-high pullback',
    bias: 'Bearish',
    confidence: 8.8,
    bestUse: 'Best sell-on-bounce setup',
    trigger: 'Rejection after lower high',
    invalidation: 'Close above lower high',
  },
  {
    setup: '200 DMA rejection',
    bias: 'Bearish',
    confidence: 7.7,
    bestUse: 'Exit weak stock / avoid fresh buy',
    trigger: 'Rejection near 200 DMA',
    invalidation: 'Close above 200 DMA',
  },
  {
    setup: 'VWAP rejection',
    bias: 'Bearish intraday',
    confidence: 7.7,
    bestUse: 'Intraday exit / avoid buying',
    trigger: 'Rejection below VWAP',
    invalidation: 'Close above VWAP',
  },
  {
    setup: 'Volume climax reversal at top',
    bias: 'Bearish / trim',
    confidence: 6.6,
    bestUse: 'Exit after exhaustion buying',
    trigger: 'Confirmation after climax candle',
    invalidation: 'Break above climax high',
  },
  {
    setup: 'Bollinger Band squeeze – downside breakdown',
    bias: 'Bearish',
    confidence: 7.1,
    bestUse: 'Exit when volatility expands downward',
    trigger: 'Breakdown below squeeze range',
    invalidation: 'Re-entry into range',
  },
  {
    setup: 'Failed breakout / bull trap',
    bias: 'Bearish',
    confidence: 8.3,
    bestUse: 'Exit/trim after trap',
    trigger: 'Fall back below resistance',
    invalidation: 'Close above trap high',
  },
  {
    setup: 'RSI bearish divergence at resistance',
    bias: 'Bearish',
    confidence: 6.6,
    bestUse: 'Early weakness clue',
    trigger: 'Price breaks minor support',
    invalidation: 'Close above recent high',
  },
  {
    setup: 'Relative weakness breakdown',
    bias: 'Bearish',
    confidence: 8.6,
    bestUse: 'Best exit/trim filter',
    trigger: 'Stock breaks support while index holds',
    invalidation: 'Reclaim of support',
  },
  {
    setup: 'Gap-up fade',
    bias: 'Bearish',
    confidence: 7.0,
    bestUse: 'Exit failed optimism',
    trigger: 'Breakdown below VWAP / opening range',
    invalidation: 'Reclaim of VWAP',
  },
  {
    setup: 'Parabolic blow-off top',
    bias: 'Bearish / exit',
    confidence: 6.7,
    bestUse: 'Exit signal, avoid fresh buying',
    trigger: 'Breakdown of prior day low',
    invalidation: 'Above blow-off high',
  },
];

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

function SetupTable({ title, description, accentClassName, triggerLabel, rows }: SetupTableProps) {
  const [sort, setSort] = useState<SortState>({ key: 'confidence', direction: 'desc' });

  const sortedRows = useMemo(() => {
    return [...rows].sort((a, b) => {
      const comparison = compareRows(a, b, sort.key);
      return sort.direction === 'asc' ? comparison : -comparison;
    });
  }, [rows, sort]);

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
            {sortedRows.map((row) => (
              <tr key={row.setup} className="hover:bg-gray-50/70">
                <td className="px-4 py-3 font-semibold text-gray-950">{row.setup}</td>
                <td className="px-4 py-3 text-right text-gray-700">{row.bias}</td>
                <td className="px-4 py-3 text-right font-semibold text-gray-950">{row.confidence.toFixed(1)}/10</td>
                <td className="px-4 py-3 text-gray-700">{row.bestUse}</td>
                <td className="px-4 py-3 text-gray-700">{row.trigger}</td>
                <td className="px-4 py-3 text-gray-700">{row.invalidation}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function TechnicalSetupsPage() {
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
      />

      <SetupTable
        title="Bearish / Sell-Trim Setups"
        description="Exit, trim, and downside-continuation structures sorted by confidence score."
        accentClassName="border-red-500 bg-red-50/50"
        triggerLabel="Sell / trim trigger"
        rows={BEARISH_SETUPS}
      />
    </div>
  );
}

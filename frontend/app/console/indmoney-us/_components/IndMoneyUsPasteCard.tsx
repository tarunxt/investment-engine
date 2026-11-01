'use client';

import { useState } from 'react';
import {
  AlertCircle,
  CalendarDays,
  Loader2,
  Save,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { IndMoneyUsPortfolioSnapshotCreateRequest } from '@/types/api';

function buildLocalDateTimeValue(date = new Date()) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  const hours = `${date.getHours()}`.padStart(2, '0');
  const minutes = `${date.getMinutes()}`.padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

export function IndMoneyUsPasteCard({
  saving,
  error,
  onSubmit,
}: {
  saving: boolean;
  error: string | null;
  onSubmit: (data: IndMoneyUsPortfolioSnapshotCreateRequest) => Promise<void>;
}) {
  const [rawText, setRawText] = useState('');
  const [capturedAt, setCapturedAt] = useState(buildLocalDateTimeValue());
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = rawText.trim();
    if (!trimmed) return;

    setSuccessMessage(null);
    try {
      await onSubmit({
        raw_text: trimmed,
        captured_at: capturedAt ? new Date(capturedAt).toISOString() : null,
      });

      setRawText('');
      setCapturedAt(buildLocalDateTimeValue());
      setSuccessMessage('Snapshot saved. Check its parse status and reconciliation warnings in Saved US snapshot.');
    } catch {
      // The parent already surfaces the save error inline.
    }
  };

  return (
    <div className="rounded-md border border-gray-200 bg-white">
      <div className="border-b border-gray-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-950">Paste snapshot</h2>
        <p className="mt-1 text-sm text-gray-600">Paste INDmoney data and save a timestamped manual snapshot.</p>
      </div>
      <form id="indmoney-us-import-form" onSubmit={handleSubmit} className="space-y-4 px-4 py-4">
        <details className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">
          <summary className="cursor-pointer rounded font-medium text-purple-800 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-purple-700">
            Show example
          </summary>
          <div className="mt-3 space-y-3">
            <p>
              In INDmoney, open your US stocks portfolio and copy the portfolio screen text,
              including Current Holdings. Keep the field labels, values and line breaks.
              Paste copied text here; screenshots and file uploads are not supported by this box.
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>Summary: wallet balance, Current Value, Invested Value, 1D Returns and Total Returns, when shown.</li>
              <li>Holdings: Current Holdings count, company name and ticker, market price/change, invested value, Qty, Avg., current value and total PnL/percentage.</li>
            </ul>
            <p id="indmoney-example-label" className="font-medium">
              Illustrative example only: fictional company and amounts, not saved holdings.
            </p>
            <pre aria-labelledby="indmoney-example-label" className="whitespace-pre-wrap break-words rounded border border-gray-200 bg-white p-3 text-xs leading-relaxed">{`Current Value
$110.00
Invested Value
$100.00
Total Returns
+$10.00 (▲10.00%)
Current Holdings (1)
Stock Name
Market Price
Invested (Qty/Price)
Current value
Total PnL
Example Fictional Company
DEMO
$11.00
▲1.00%
$100.00
10 Qty
$10.00 Avg.
$110.00
+$10.00
▲10.00%`}</pre>
            <p>
              Copy all holdings from your own source screen; do not fill missing fields with example values.
              Missing or unrecognized fields can produce a partial parse. Review the saved parse status and reconciliation warnings.
            </p>
          </div>
        </details>
        <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <div className="space-y-2">
            <label
              htmlFor="indmoney-captured-at"
              className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-gray-600"
            >
              <CalendarDays className="size-3.5" />
              Snapshot timestamp
            </label>
            <input
              id="indmoney-captured-at"
              type="datetime-local"
              value={capturedAt}
              onChange={(event) => setCapturedAt(event.target.value)}
              className="w-full border border-gray-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none ring-0 transition focus:border-purple-600 focus:ring-2 focus:ring-purple-200"
            />
            <p className="text-xs text-gray-600">
              Use the time when you copied the INDmoney screen so history stays meaningful.
            </p>
          </div>

          <div className="space-y-2">
            <label
              htmlFor="indmoney-raw-text"
              className="text-xs font-semibold uppercase tracking-wider text-gray-600"
            >
              Paste INDmoney data here
            </label>
            <textarea
              id="indmoney-raw-text"
              value={rawText}
              onChange={(event) => {
                setRawText(event.target.value);
                setSuccessMessage(null);
              }}
              placeholder="Paste the copied INDmoney portfolio text here..."
              className="min-h-[16rem] w-full resize-y border border-gray-200 bg-white px-3 py-3 text-sm text-slate-900 outline-none transition focus:border-purple-600 focus:ring-2 focus:ring-purple-200"
            />
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-600">
              <span>Best results come from pasting the full portfolio screen, including the holdings list.</span>
              <span aria-live="polite">{rawText.trim().length.toLocaleString('en-IN')} chars</span>
            </div>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {successMessage && !error && (
          <div className="border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            {successMessage}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-gray-600">
            Partial parsing is okay. We still keep the raw snapshot and show warnings when totals do not reconcile.
          </p>
          <Button type="submit" disabled={saving || !rawText.trim()} className="bg-purple-700 hover:bg-purple-800">
            {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Save className="mr-2 size-4" />}
            Save Snapshot
          </Button>
        </div>
        </form>
    </div>
  );
}

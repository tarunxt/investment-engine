'use client';

import { useState } from 'react';
import {
  AlertCircle,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  ClipboardPaste,
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
  const [isOpen, setIsOpen] = useState(false);

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
      setSuccessMessage('Snapshot saved. Check its parse status and reconciliation warnings below.');
    } catch {
      // The parent already surfaces the save error inline.
    }
  };

  return (
    <div className="border border-gray-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        aria-expanded={isOpen}
        aria-controls="indmoney-us-import-form"
        className="flex w-full items-start justify-between gap-4 px-5 py-3 text-left focus-visible:outline-2 focus-visible:outline-blue-600"
      >
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-full bg-white p-2 text-gray-600 shadow-sm">
            <ClipboardPaste className="size-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-slate-950">Import snapshot</h2>
            <p className="mt-1 text-sm text-gray-600">
              Paste INDmoney data and save a timestamped manual snapshot.
            </p>
          </div>
        </div>
        <span className="rounded-full bg-white p-2 text-gray-600 shadow-sm">
          {isOpen ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </span>
      </button>

      {isOpen ? (
        <form id="indmoney-us-import-form" onSubmit={handleSubmit} className="space-y-4 border-t border-gray-200 px-5 py-5">
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
              className="w-full border border-gray-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none ring-0 transition focus:border-blue-400"
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
              Paste IndMoney data here
            </label>
            <textarea
              id="indmoney-raw-text"
              value={rawText}
              onChange={(event) => {
                setRawText(event.target.value);
                setSuccessMessage(null);
              }}
              placeholder="Paste the copied INDmoney portfolio text here..."
              className="min-h-[16rem] w-full resize-y border border-gray-200 bg-white px-3 py-3 text-sm text-slate-900 outline-none transition focus:border-blue-400"
            />
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-600">
              <span>Best results come from pasting the full portfolio screen, including the holdings list.</span>
              <span>{rawText.trim().length.toLocaleString('en-IN')} chars</span>
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
          <Button type="submit" disabled={saving || !rawText.trim()} className="bg-blue-600 hover:bg-blue-700">
            {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Save className="mr-2 size-4" />}
            Save Snapshot
          </Button>
        </div>
        </form>
      ) : null}
    </div>
  );
}

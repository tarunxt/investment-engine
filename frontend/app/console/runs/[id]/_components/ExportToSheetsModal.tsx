'use client';

import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiService, APIError } from '@/services/api';
import type { RunResponse } from '@/types/api';

interface ExportToSheetsModalProps {
  run: RunResponse;
  onExported?: () => void;
}

function normalizeError(err: unknown) {
  if (err instanceof APIError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}

export default function ExportToSheetsModal({
  run,
  onExported,
}: ExportToSheetsModalProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [sheetUrl, setSheetUrl] = useState('');
  const [sheetName, setSheetName] = useState('Stock Ideas');
  const [title, setTitle] = useState('Investment Analysis Export');
  const [investmentAmount, setInvestmentAmount] = useState('INR 10,000');
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [successUrl, setSuccessUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || sheetUrl.trim()) return;

    let active = true;
    apiService.googleSheetsStatus()
      .then((res) => {
        if (!active) return;
        if (res.default_spreadsheet_url) {
          setSheetUrl(res.default_spreadsheet_url);
        }
      })
      .catch(() => {
        // Keep the modal usable even if this prefill request fails.
      });

    return () => {
      active = false;
    };
  }, [isOpen, sheetUrl]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setExporting(true);
    setError(null);
    setSuccess(null);
    setSuccessUrl(null);

    try {
      const res = await apiService.googleSheetsExportRun({
        run_id: run.id,
        spreadsheet_url: sheetUrl || undefined,
        sheet_name: sheetName,
        title,
        investment_amount: investmentAmount,
      });

      const targetUrl = res.spreadsheet_url || sheetUrl || null;
      setSuccess('Run queued for export to Google Sheets.');
      setSuccessUrl(targetUrl);
      setSheetUrl('');
      setSheetName('Run Analysis');
      setTitle('Multi-LLM Analysis Export');
      setTimeout(() => setIsOpen(false), 2000);
      onExported?.();
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setExporting(false);
    }
  };

  if (!isOpen) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => setIsOpen(true)}
        className="gap-2"
      >
        <Download className="size-4" />
        Export to Sheets
      </Button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="mx-4 max-w-md rounded-lg border border-gray-200 bg-white shadow-lg">
        <div className="border-b border-gray-200 px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-900">Export to Google Sheets</h2>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-6">
          {/* Sheet URL (optional) */}
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-gray-700">
              Spreadsheet URL (optional)
            </label>
            <p className="text-xs text-gray-500 mb-2">
              Leave empty to create a new sheet, or paste a Google Sheets URL
            </p>
            <input
              type="text"
              placeholder="https://docs.google.com/spreadsheets/d/..."
              value={sheetUrl}
              onChange={(e) => setSheetUrl(e.target.value)}
              className="border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Investment Amount */}
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-gray-700">
              Investment Amount
            </label>
            <input
              type="text"
              value={investmentAmount}
              onChange={(e) => setInvestmentAmount(e.target.value)}
              placeholder="e.g., INR 10,000"
              className="border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Sheet Name */}
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-gray-700">
              Sheet Name
            </label>
            <input
              type="text"
              value={sheetName}
              onChange={(e) => setSheetName(e.target.value)}
              className="border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Title (for new sheets) */}
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-gray-700">
              Spreadsheet Title (if creating new)
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Error message */}
          {error && (
            <div className="flex items-start gap-2 rounded bg-red-50 border border-red-200 p-3 text-sm text-red-700">
              <AlertCircle className="mt-0.5 size-4 shrink-0 flex-none" />
              <span>{error}</span>
            </div>
          )}

          {/* Success message */}
          {success && (
            <div className="flex items-start gap-2 rounded bg-emerald-50 border border-emerald-200 p-3 text-sm text-emerald-700">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 flex-none" />
              <div className="space-y-1">
                <div>{success}</div>
                {successUrl ? (
                  <a
                    href={successUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-emerald-800 underline hover:text-emerald-900"
                  >
                    Open sheet
                  </a>
                ) : null}
              </div>
            </div>
          )}

          {/* Buttons */}
          <div className="flex gap-2 justify-end pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setIsOpen(false);
                setError(null);
                setSuccess(null);
                setSuccessUrl(null);
              }}
              disabled={exporting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={exporting || !sheetName}
              className="gap-1"
            >
              {exporting ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Exporting…
                </>
              ) : (
                <>
                  <Download className="size-3.5" />
                  Export
                </>
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

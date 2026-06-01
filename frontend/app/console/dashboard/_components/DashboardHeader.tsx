'use client';

import { useState } from 'react';
import { AlertCircle, ChevronDown, FileSpreadsheet, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useDashboard } from '../_context';
import { GoogleSheetsField } from './GoogleSheetsField';

export function DashboardHeader({
  title = 'AI Job Console',
  description = 'Queue investment research jobs and monitor worker execution.',
}: {
  title?: string;
  description?: string;
} = {}) {
  const {
    loadingRuns,
    runsError,
    setRunsError,
    refreshRuns,
    googleSheetsConnected,
    refreshGoogleSheetsStatus,
  } = useDashboard();
  const [showSheets, setShowSheets] = useState(false);

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-gray-950">{title}</h1>
          <p className="mt-1 text-sm text-gray-600">{description}</p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void refreshGoogleSheetsStatus();
              setShowSheets((current) => !current);
            }}
            aria-expanded={showSheets}
            className="w-full justify-center sm:w-auto"
          >
            <span className="relative mr-2 inline-flex">
              <FileSpreadsheet className="size-4" />
              <span
                className={cn(
                  'absolute -right-1 -top-1 size-2 rounded-full ring-1 ring-white',
                  googleSheetsConnected ? 'bg-emerald-500' : 'bg-amber-500',
                )}
                aria-hidden="true"
              />
            </span>
            Sheets
            <ChevronDown className={cn('ml-2 size-4 transition-transform', showSheets && 'rotate-180')} />
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => refreshRuns()}
            disabled={loadingRuns}
            className="w-full sm:w-auto"
          >
            <RefreshCw className={cn('mr-2 size-4', loadingRuns && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {showSheets ? (
        <div className="max-w-3xl sm:ml-auto">
          <GoogleSheetsField showInvestmentAmount={false} />
        </div>
      ) : null}

      {runsError && (
        <div className="flex items-start justify-between gap-3 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{runsError}</span>
          </div>
          <button
            type="button"
            onClick={() => {
              setRunsError(null);
              refreshRuns();
            }}
            className="shrink-0 text-xs font-semibold underline hover:no-underline"
          >
            Retry
          </button>
        </div>
      )}
    </>
  );
}

'use client';

import { AlertCircle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useDashboard } from '../_context';

export function DashboardHeader({
  title = 'AI Job Console',
  description = 'Queue investment research jobs and monitor worker execution.',
}: {
  title?: string;
  description?: string;
} = {}) {
  const { loadingRuns, runsError, setRunsError, refreshRuns } = useDashboard();

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-gray-950">{title}</h1>
          <p className="mt-1 text-sm text-gray-600">{description}</p>
        </div>
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

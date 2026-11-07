'use client';

import { formatPortfolioTimestamp } from "@/lib/portfolioTimestamp";

import { useState } from 'react';
import { PortfolioAnalysisNav } from '@/components/shared/PortfolioAnalysisNav';
import navStyles from '../../zerodha/_components/IndiaPortfolioNav.module.css';
import { LastPasteDialog } from './LastPasteDialog';
import { Eye, Loader2, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import type {
  IndMoneyUsPortfolioOverviewResponse,
  IndMoneyUsPortfolioSnapshotCreateRequest,
  IndMoneyUsPortfolioSnapshotDetail,
} from '@/types/api';
import { IndMoneyUsPasteCard } from './IndMoneyUsPasteCard';
import { IndMoneyUsSnapshotsPanel } from './IndMoneyUsSnapshotsPanel';

const views = [
  { value: 'saved', label: 'Saved US snapshot' },
  { value: 'paste', label: 'Paste snapshot' },
];

export function IndMoneyUsSnapshotWorkspace({
  overview, selectedSnapshot, selectedSnapshotId, loading, selecting, saving,
  loadError, saveError, onRefresh, onCreateSnapshot, onSelectSnapshot,
}: {
  overview: IndMoneyUsPortfolioOverviewResponse | null;
  selectedSnapshot: IndMoneyUsPortfolioSnapshotDetail | null;
  selectedSnapshotId: number | null;
  loading: boolean;
  selecting: boolean;
  saving: boolean;
  loadError: string | null;
  saveError: string | null;
  onRefresh: () => Promise<void>;
  onCreateSnapshot: (payload: IndMoneyUsPortfolioSnapshotCreateRequest) => Promise<void>;
  onSelectSnapshot: (id: number) => void;
}) {
  const [view, setView] = useState('saved');

  const [showLastPaste, setShowLastPaste] = useState(false);

  return (
    <Tabs value={view} onValueChange={setView} className="mx-auto min-w-0 flex-col gap-3">
      <nav aria-label="US portfolio stages"><PortfolioAnalysisNav portfolio="indmoneyUs" active="portfolio" className={navStyles.navigation} /></nav>
      <TabsList aria-label="US snapshot views" className="h-auto w-full flex-wrap justify-start gap-2 bg-transparent p-0">
        {views.map((item) => (
          <div key={item.value} className="inline-flex items-stretch rounded-md bg-purple-50">
          <TabsTrigger
            value={item.value}
            id={`us-snapshot-tab-${item.value}`}
            aria-controls={`us-snapshot-panel-${item.value}`}
            className="h-auto flex-none whitespace-normal rounded-md bg-purple-50 px-3 py-2 text-sm font-medium normal-case tracking-normal text-purple-800 hover:bg-purple-100 data-[state=active]:bg-purple-700 data-[state=active]:text-white"
          >
            {item.label}
          </TabsTrigger>
          {item.value === 'paste' && (
            <button type="button" aria-label="View last pasted snapshot" aria-haspopup="dialog" title="View last pasted snapshot"
              onClick={() => setShowLastPaste(true)} className="rounded-r-md border-l border-purple-200 px-2 text-purple-800 hover:bg-purple-100 focus-visible:outline-2">
              <Eye className="size-4" aria-hidden="true" />
            </button>
          )}
          </div>
        ))}
      </TabsList>
      {showLastPaste && <LastPasteDialog onClose={() => setShowLastPaste(false)} />}

      <div className="min-w-0 rounded-lg border border-gray-200 bg-gray-50 p-4 sm:p-5">
        <header className="mb-3 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight text-gray-950">INDmoney US snapshot</h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-600">
              <span className="font-medium">Manual snapshot</span>
              <span aria-live="polite">
                {selectedSnapshot ? <>Captured: <time dateTime={selectedSnapshot.captured_at}>{formatPortfolioTimestamp(selectedSnapshot.captured_at)}</time></> : loading ? 'Loading saved snapshot…' : overview ? 'No saved snapshot yet.' : 'Saved snapshot unavailable.'}
              </span>
              {selectedSnapshot ? <span className="rounded border border-gray-300 bg-white px-2 py-0.5 text-xs text-gray-700">Holdings parse status: <span className="capitalize">{selectedSnapshot.parse_status}</span></span> : null}
              <details className="text-sm">
                <summary className="cursor-pointer rounded text-purple-800 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-purple-700">Source details</summary>
                <div className="mt-2 max-w-xl rounded border border-gray-200 bg-white p-3 text-gray-600">
                  <p className="mt-1">Paste the INDmoney portfolio screen daily and save a timestamped snapshot. Raw text is parsed into holdings, allocation, returns, market context and reconciliation checks as far as the pasted structure allows.</p>
                  {selectedSnapshot ? <p className="mt-1 capitalize">Source: {selectedSnapshot.source.replaceAll('_', ' ')} · Snapshot date: {selectedSnapshot.snapshot_date}</p> : null}
                </div>
              </details>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={loading || selecting || saving} onClick={() => void onRefresh()} title="Reload saved records only; does not import a snapshot or sync broker prices.">
              <RefreshCw className={cn('mr-2 size-3.5', loading && 'animate-spin')} />Refresh displayed data
            </Button>
          </div>
        </header>

        {loadError ? (
          <div role="alert" className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            <p>{selectedSnapshot ? 'Display read failed. Showing previously loaded saved data.' : 'Saved portfolio data could not be loaded.'}</p>
            <p>{loadError}</p>
          </div>
        ) : null}
        {loading && overview ? <p role="status" className="mb-3 flex items-center gap-2 text-sm text-gray-600"><Loader2 className="size-4 animate-spin" />Refreshing saved records…</p> : null}

        <TabsContent value="saved" forceMount hidden={view !== 'saved'} id="us-snapshot-panel-saved" aria-labelledby="us-snapshot-tab-saved">
          <IndMoneyUsSnapshotsPanel overview={overview} selectedSnapshot={selectedSnapshot} selectedSnapshotId={selectedSnapshotId} loading={loading} selecting={selecting} error={null} onSelectSnapshot={onSelectSnapshot} />
        </TabsContent>
        <TabsContent value="paste" forceMount hidden={view !== 'paste'} id="us-snapshot-panel-paste" aria-labelledby="us-snapshot-tab-paste">
          <IndMoneyUsPasteCard saving={saving} error={saveError} onSubmit={onCreateSnapshot} />
        </TabsContent>

      </div>
    </Tabs>
  );
}

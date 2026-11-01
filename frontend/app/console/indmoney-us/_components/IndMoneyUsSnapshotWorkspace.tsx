'use client';

import { formatPortfolioTimestamp } from "@/lib/portfolioTimestamp";

import { useState } from 'react';
import Link from 'next/link';
import { ClipboardPaste, Loader2, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { URLs } from '@/lib/urls';
import { cn } from '@/lib/utils';
import type {
  IndMoneyUsPortfolioOverviewResponse,
  IndMoneyUsPortfolioSnapshotCreateRequest,
  IndMoneyUsPortfolioSnapshotDetail,
} from '@/types/api';
import { IndMoneyUsPasteCard } from './IndMoneyUsPasteCard';
import { IndMoneyUsSnapshotsPanel } from './IndMoneyUsSnapshotsPanel';

const stages = [
  { label: 'Portfolio', india: URLs.routes.console.zerodha(), us: URLs.routes.console.indmoneyUs() },
  { label: 'Swing Trade', india: URLs.routes.console.zerodhaSwingTrade(), us: URLs.routes.console.indmoneyUsSwingTrade() },
  { label: 'Threats', india: URLs.routes.console.zerodhaThreats(), us: URLs.routes.console.indmoneyUsThreats() },
  { label: 'Events', india: URLs.routes.console.zerodhaEvents(), us: URLs.routes.console.indmoneyUsEvents() },
  { label: 'Rebalance', india: URLs.routes.console.zerodhaRebalance(), us: URLs.routes.console.indmoneyUsRebalance() },
  { label: 'Final Actionables', india: URLs.routes.console.zerodhaFinalActionables(), us: URLs.routes.console.indmoneyUsFinalActionables() },
];

const views = [
  { value: 'saved', label: 'Saved US snapshot' },
  { value: 'paste', label: 'Paste snapshot' },
  { value: 'navigation', label: 'Market and stage navigation' },
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

  return (
    <Tabs value={view} onValueChange={setView} className="mx-auto min-w-0 flex-col gap-3">
      <TabsList aria-label="US snapshot views" className="h-auto w-full flex-wrap justify-start gap-2 bg-transparent p-0">
        {views.map((item) => (
          <TabsTrigger
            key={item.value}
            value={item.value}
            id={`us-snapshot-tab-${item.value}`}
            aria-controls={`us-snapshot-panel-${item.value}`}
            className="h-auto flex-none whitespace-normal rounded-md bg-purple-50 px-3 py-2 text-sm font-medium normal-case tracking-normal text-purple-800 hover:bg-purple-100 data-[state=active]:bg-purple-700 data-[state=active]:text-white"
          >
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>

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
                  <p>Manual US portfolio tracking for INDmoney when no direct API is available.</p>
                  <p className="mt-1">Paste the INDmoney portfolio screen daily and save a timestamped snapshot. Raw text is parsed into holdings, allocation, returns, market context and reconciliation checks as far as the pasted structure allows.</p>
                  {selectedSnapshot ? <p className="mt-1 capitalize">Source: {selectedSnapshot.source.replaceAll('_', ' ')} · Snapshot date: {selectedSnapshot.snapshot_date}</p> : null}
                </div>
              </details>
            </div>
            <p className="mt-1 text-xs text-gray-500">Manual US portfolio tracking when no direct API is available.</p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button type="button" size="sm" onClick={() => setView('paste')} aria-controls="us-snapshot-panel-paste" className="bg-purple-700 text-white hover:bg-purple-800">
              <ClipboardPaste className="mr-2 size-3.5" />Import snapshot
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={loading || selecting || saving} onClick={() => void onRefresh()} title="Reload saved records only; does not import a snapshot or sync broker prices.">
              <RefreshCw className={cn('mr-2 size-3.5', loading && 'animate-spin')} />Refresh displayed data
            </Button>
          </div>
        </header>

        <p className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Saved snapshot is not a live market feed. Parsed does not mean current prices or a live broker connection. Totals and wallet values belong to the selected historical snapshot, not live account balance or buying power.
        </p>
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
        <TabsContent value="navigation" forceMount hidden={view !== 'navigation'} id="us-snapshot-panel-navigation" aria-labelledby="us-snapshot-tab-navigation">
          <nav aria-label="Portfolio market and stage destinations" className="rounded-md border border-gray-200 bg-white">
            <p className="border-b border-gray-200 px-4 py-3 text-sm text-gray-700">Current market: <strong>US</strong> · Current stage: <strong>Portfolio</strong></p>
            <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Stage and market links">
              <table className="w-full text-left text-sm">
                <thead className="bg-gray-50 text-gray-600"><tr><th scope="col" className="px-4 py-2 font-medium">Stage</th><th scope="col" className="px-4 py-2 font-medium">Markets</th></tr></thead>
                <tbody className="divide-y divide-gray-100">
                  {stages.map((stage) => (
                    <tr key={stage.label}>
                      <th scope="row" className="px-4 py-3 font-medium"><Link href={stage.us} className="rounded text-gray-800 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-purple-700">{stage.label}</Link></th>
                      <td className="px-4 py-3"><div className="flex flex-wrap gap-3">
                        <Link href={stage.india} aria-label={`${stage.label} — India`} className="rounded text-purple-800 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-purple-700">India</Link>
                        <Link href={stage.us} aria-label={`${stage.label} — US`} aria-current={stage.label === 'Portfolio' ? 'page' : undefined} className="rounded text-purple-800 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-purple-700">US</Link>
                      </div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </nav>
        </TabsContent>
      </div>
    </Tabs>
  );
}

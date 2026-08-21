'use client';

import { useCallback, useEffect, useState } from 'react';

import { AlertCircle, Copy, Loader2 } from 'lucide-react';

import { PortfolioAnalysisNav } from '@/components/shared/PortfolioAnalysisNav';
import { Button } from '@/components/ui/button';
import { IndMoneyUsPasteCard } from './_components/IndMoneyUsPasteCard';
import { IndMoneyUsSnapshotsPanel } from './_components/IndMoneyUsSnapshotsPanel';
import { cn } from '@/lib/utils';
import { apiService, APIError } from '@/services/api';
import type {
  IndMoneyUsPortfolioOverviewResponse,
  IndMoneyUsPortfolioSnapshotCreateRequest,
  IndMoneyUsPortfolioSnapshotDetail,
} from '@/types/api';

function normalizeError(error: unknown) {
  if (error instanceof APIError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong';
}

export default function IndMoneyUsPage() {
  const [overview, setOverview] = useState<IndMoneyUsPortfolioOverviewResponse | null>(null);
  const [selectedSnapshot, setSelectedSnapshot] = useState<IndMoneyUsPortfolioSnapshotDetail | null>(null);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [selecting, setSelecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showManualNote, setShowManualNote] = useState(false);

  const applyOverview = useCallback(
    (
      nextOverview: IndMoneyUsPortfolioOverviewResponse,
      preferredSnapshot?: IndMoneyUsPortfolioSnapshotDetail | null,
    ) => {
      setOverview(nextOverview);

      const availableIds = new Set(nextOverview.history.map((snapshot) => snapshot.id));
      if (preferredSnapshot) {
        setSelectedSnapshot(preferredSnapshot);
        setSelectedSnapshotId(preferredSnapshot.id);
        return;
      }

      if (!selectedSnapshotId || !availableIds.has(selectedSnapshotId)) {
        setSelectedSnapshot(nextOverview.latest);
        setSelectedSnapshotId(nextOverview.latest?.id ?? null);
        return;
      }

      if (nextOverview.latest?.id === selectedSnapshotId) {
        setSelectedSnapshot(nextOverview.latest);
      }
    },
    [selectedSnapshotId],
  );

  useEffect(() => {
    let cancelled = false;

    const loadOverview = async () => {
      try {
        const nextOverview = await apiService.indmoneyUsPortfolioOverview();
        if (cancelled) return;
        setLoadError(null);
        applyOverview(nextOverview);
      } catch (error) {
        if (cancelled) return;
        setLoadError(normalizeError(error));
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadOverview();

    return () => {
      cancelled = true;
    };
  }, [applyOverview]);

  const handleSelectSnapshot = useCallback(
    async (snapshotId: number) => {
      if (snapshotId === selectedSnapshotId && selectedSnapshot) {
        return;
      }

      setSelecting(true);
      setLoadError(null);
      setSelectedSnapshotId(snapshotId);

      try {
        if (overview?.latest?.id === snapshotId && overview.latest) {
          setSelectedSnapshot(overview.latest);
          return;
        }

        const snapshot = await apiService.indmoneyUsPortfolioSnapshot(snapshotId);
        setSelectedSnapshot(snapshot);
      } catch (error) {
        setLoadError(normalizeError(error));
      } finally {
        setSelecting(false);
      }
    },
    [overview, selectedSnapshot, selectedSnapshotId],
  );

  const handleCreateSnapshot = async (payload: IndMoneyUsPortfolioSnapshotCreateRequest) => {
    setSaving(true);
    setSaveError(null);

    try {
      const snapshot = await apiService.indmoneyUsCreatePortfolioSnapshot(payload);
      const nextOverview = await apiService.indmoneyUsPortfolioOverview();
      applyOverview(nextOverview, snapshot);
    } catch (error) {
      const message = normalizeError(error);
      setSaveError(message);
      throw new Error(message);
    } finally {
      setSaving(false);
    }
  };

  if (loading && !overview) {
    return (
      <div className="flex items-center gap-3 text-sm text-gray-500">
        <Loader2 className="size-4 animate-spin" />
        Loading INDmoney US portfolio…
      </div>
    );
  }

  return (
    <div className="mx-auto flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="inline-flex items-start gap-1">
            <h1 className="text-lg font-semibold tracking-tight text-gray-950">IndMoney US</h1>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-expanded={showManualNote}
              aria-controls="indmoney-us-manual-note"
              aria-label={showManualNote ? 'Hide manual workflow note' : 'Show manual workflow note'}
              title={showManualNote ? 'Hide manual workflow note' : 'Show manual workflow note'}
              onClick={() => setShowManualNote((current) => !current)}
              className={cn(
                '-mt-1 rounded-full text-amber-700 hover:bg-amber-100 hover:text-amber-800',
                showManualNote ? 'bg-amber-100 text-amber-900' : '',
              )}
            >
              <Copy className="size-3.5" />
              <span className="sr-only">
                {showManualNote ? 'Hide manual workflow note' : 'Show manual workflow note'}
              </span>
            </Button>
          </div>
          <p className="text-sm text-gray-500">
            Manual US portfolio tracking for INDmoney when no direct API is available.
          </p>
        </div>
        <div className="flex items-center gap-2 self-start">
          <PortfolioAnalysisNav portfolio="indmoneyUs" active="portfolio" />
        </div>
      </div>

      {showManualNote ? (
        <div
          id="indmoney-us-manual-note"
          className="border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 shadow-sm"
        >
          The flow here is intentionally manual: paste the INDmoney portfolio screen daily, save a timestamped
          snapshot, and the dashboard will turn that raw text into holdings tables, allocation views, and
          reconciliation checks as far as the pasted structure allows.
        </div>
      ) : null}

      {loadError && !overview ? (
        <div className="flex items-start gap-3 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{loadError}</span>
        </div>
      ) : null}

      <IndMoneyUsPasteCard
        saving={saving}
        error={saveError}
        onSubmit={handleCreateSnapshot}
      />

      <IndMoneyUsSnapshotsPanel
        overview={overview}
        selectedSnapshot={selectedSnapshot}
        selectedSnapshotId={selectedSnapshotId}
        loading={loading}
        selecting={selecting}
        error={loadError}
        onSelectSnapshot={handleSelectSnapshot}
      />
    </div>
  );
}

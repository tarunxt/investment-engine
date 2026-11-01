'use client';

import { useCallback, useEffect, useState } from 'react';

import { IndMoneyUsSnapshotWorkspace } from './_components/IndMoneyUsSnapshotWorkspace';
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
      setLoadError(null);
    } catch (error) {
      const message = normalizeError(error);
      setSaveError(message);
      throw new Error(message);
    } finally {
      setSaving(false);
    }
  };

  const handleRefreshDisplayedData = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const nextOverview = await apiService.indmoneyUsPortfolioOverview();
      const retainedSnapshot = selectedSnapshotId && nextOverview.history.some((item) => item.id === selectedSnapshotId)
        ? nextOverview.latest?.id === selectedSnapshotId
          ? nextOverview.latest
          : await apiService.indmoneyUsPortfolioSnapshot(selectedSnapshotId)
        : null;
      applyOverview(nextOverview, retainedSnapshot);
    } catch (error) {
      setLoadError(normalizeError(error));
    } finally {
      setLoading(false);
    }
  };

  return (
    <IndMoneyUsSnapshotWorkspace
      overview={overview}
      selectedSnapshot={selectedSnapshot}
      selectedSnapshotId={selectedSnapshotId}
      loading={loading}
      selecting={selecting}
      saving={saving}
      loadError={loadError}
      saveError={saveError}
      onRefresh={handleRefreshDisplayedData}
      onCreateSnapshot={handleCreateSnapshot}
      onSelectSnapshot={handleSelectSnapshot}
    />
  );
}

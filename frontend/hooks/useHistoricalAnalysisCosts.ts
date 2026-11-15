'use client';

import { useEffect, useState } from 'react';

import type { PortfolioAnalysisHistoryItem } from '@/types/api';

interface HistoricalAnalysisLike {
  provider: string;
  model: string;
  status: string;
  estimated_cost?: number | null;
}

interface UseHistoricalAnalysisCostsOptions {
  analysis?: HistoricalAnalysisLike | null;
  loadHistory: () => Promise<PortfolioAnalysisHistoryItem[]>;
  usdInrRate: number;
}

function hasKnownCost(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function toTargetKey(provider: string | null | undefined, model: string | null | undefined) {
  if (!provider || !model) return null;
  return `${provider}::${model}`;
}

function toInrCost(usdCost: number, usdInrRate: number) {
  return Math.round(usdCost * usdInrRate * 100) / 100;
}

function buildHistoricalCostMapInr(
  history: PortfolioAnalysisHistoryItem[],
  analysis: HistoricalAnalysisLike | null | undefined,
  usdInrRate: number,
) {
  const costs: Record<string, number> = {};
  if (!Number.isFinite(usdInrRate) || usdInrRate <= 0) return costs;

  const captureCost = (
    provider: string | null | undefined,
    model: string | null | undefined,
    status: string | null | undefined,
    estimatedCost: number | null | undefined,
  ) => {
    const key = toTargetKey(provider, model);
    if (!key || costs[key] !== undefined) return;
    if (status !== 'completed' || !hasKnownCost(estimatedCost)) return;
    costs[key] = toInrCost(estimatedCost, usdInrRate);
  };

  captureCost(analysis?.provider, analysis?.model, analysis?.status, analysis?.estimated_cost);

  for (const item of history) {
    captureCost(item.provider, item.model, item.status, item.estimated_cost);
  }

  return costs;
}

export function useHistoricalAnalysisCosts({
  analysis,
  loadHistory,
  usdInrRate,
}: UseHistoricalAnalysisCostsOptions) {
  const [history, setHistory] = useState<PortfolioAnalysisHistoryItem[]>([]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const items = await loadHistory();
        if (!cancelled) {
          setHistory(items);
        }
      } catch (error) {
        if (!cancelled) {
          console.warn('Failed to load historical analysis costs:', error);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [loadHistory]);

  return buildHistoricalCostMapInr(history, analysis, usdInrRate);
}

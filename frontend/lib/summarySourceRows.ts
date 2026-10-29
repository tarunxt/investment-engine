import type { FinalActionableHistoryItem } from '@/types/api';
import type { HistoricalDashboardActionRow } from '@/app/console/_components/FinalActionablesConsole';

type SummarySource = { kind: 'saved'; item: FinalActionableHistoryItem; runId: number; coveredAt: string }
  | { kind: 'retained'; item: HistoricalDashboardActionRow; runId: number; coveredAt: string };

/** A missing legacy summary must not hide retained runs or turn a recalculation into saved evidence. */
export function mergeSummarySourceRows(saved: FinalActionableHistoryItem[], retained: HistoricalDashboardActionRow[]): SummarySource[] {
  const represented = new Set(saved.filter(row => row.coverage_status === 'suggested').map(row => row.rebalance_run_id));
  const seen = new Set<string>();
  return [
    ...saved.map(item => ({ kind: 'saved' as const, item, runId: item.rebalance_run_id, coveredAt: item.covered_at })),
    ...retained.filter(item => {
      const key = `${item.runId}:${item.stock.exchange}:${item.stock.symbol}`;
      if (represented.has(item.runId) || seen.has(key)) return false;
      seen.add(key); return true;
    }).map(item => ({ kind: 'retained' as const, item, runId: item.runId, coveredAt: item.coveredAt })),
  ].sort((a, b) => Date.parse(b.coveredAt) - Date.parse(a.coveredAt) || b.runId - a.runId);
}

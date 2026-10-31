import type { StockSourceObservation, FinalActionableHistoryItem } from '@/types/api';
import type { HistoricalDashboardActionRow } from '@/app/console/_components/FinalActionablesConsole';

type SummarySource = { kind: 'saved'; item: FinalActionableHistoryItem; runId: number; coveredAt: string }
  | { kind: 'retained'; item: HistoricalDashboardActionRow; runId: number; coveredAt: string }
  | { kind: 'observation'; item: StockSourceObservation; runId: number; coveredAt: string };

/** A missing legacy summary must not hide retained runs or turn a recalculation into saved evidence. */
export function mergeSummarySourceRows(saved: FinalActionableHistoryItem[], retained: HistoricalDashboardActionRow[], observations: StockSourceObservation[] = []): SummarySource[] {
  const represented = new Set(saved.filter(row => row.coverage_status === 'suggested').map(row => row.rebalance_run_id));
  const seen = new Set<string>();
  return [
    ...saved.map(item => ({ kind: 'saved' as const, item, runId: item.rebalance_run_id, coveredAt: item.covered_at })),
    ...observations.filter(item => { const key = `original:${item.id}`; if (represented.has(item.run_id) || seen.has(key)) return false; seen.add(key); return true; }).map(item => ({ kind: 'observation' as const, item, runId: item.run_id, coveredAt: item.created_at ?? '' })),
    ...retained.filter(item => {
      const key = `${item.runId}:${item.stock.exchange}:${item.stock.symbol}`;
      if (represented.has(item.runId) || seen.has(key)) return false;
      seen.add(key); return true;
    }).map(item => ({ kind: 'retained' as const, item, runId: item.runId, coveredAt: item.coveredAt })),
  ].sort((a, b) => (Date.parse(b.coveredAt) || 0) - (Date.parse(a.coveredAt) || 0) || b.runId - a.runId);
}

/** Original source rows are not aggregate summaries or current-formula matrices. */
export function originalRebalanceSources(rows: StockSourceObservation[], symbol: string, exchange: string) {
  const norm = (s: unknown) => String(s ?? '').trim().toUpperCase();
  return rows.filter(row => {
    if (row.stage !== 'rebalance') return false;
    const cells = Object.entries(row.cells).map(([k, v]) => [k.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(), v] as const);
    const sourceSymbol = cells.find(([k]) => ['stock symbol', 'symbol', 'ticker', 'stock'].includes(k))?.[1];
    const sourceExchange = cells.find(([k]) => ['exchange symbol', 'exchange'].includes(k))?.[1];
    const annotation = /^(NSE|BSE|NASDAQ|NYSE|NYSEARCA|AMEX|ARCA):/.exec(norm(sourceSymbol))?.[1] ?? (/\.(NS|NSE)$/.test(norm(sourceSymbol)) ? 'NSE' : /\.(BO|BSE)$/.test(norm(sourceSymbol)) ? 'BSE' : null);
    const ticker = (value: unknown) => norm(value).replace(/^(NSE|BSE|NASDAQ|NYSE|NYSEARCA|AMEX|ARCA):/, '').replace(/\.(NS|BO|NSE|BSE)$/, '');
    if (annotation && sourceExchange && annotation !== norm(sourceExchange)) return false;
    return (!sourceSymbol || ticker(sourceSymbol) === ticker(symbol)) && (!(sourceExchange || annotation) || norm(sourceExchange || annotation) === norm(exchange));
  });
}

export function originalSourceCell(cells: Record<string, unknown>, names: string[]) {
  const matches = Object.entries(cells).filter(([key]) => names.includes(key.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()));
  // Ambiguous/malformed tables keep the complete original fields, never guessed values.
  if (cells['source contract status'] || matches.length !== 1) return null;
  const value = matches[0][1];
  return typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && value.trim() ? String(value) : null;
}

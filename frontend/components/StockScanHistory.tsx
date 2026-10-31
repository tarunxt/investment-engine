import type { ReactNode } from "react";

export const STOCK_SCAN_HISTORY_COLUMNS = [
  "Stock", "Timestamp covered", "Coverage", "Score-based action · current rules",
  "Original recorded action", "Recorded score", "Current-formula score (reconstructed)",
  "Consensus", "Historical value", "Action/current units", "Amount",
] as const;

/** Reusable presentation widget. Callers retain data, pagination and row actions.
 * renderRow supplies the existing keyed <tr>; the widget never fetches, sorts,
 * reconstructs scores or substitutes original history values.
 */
export function StockScanHistory<Row>({ rows, renderRow, controls, emptyState }: {
  rows: readonly Row[]; renderRow: (row: Row) => ReactNode;
  controls?: ReactNode; emptyState?: ReactNode;
}) {
  return <>
    <h4 className="mt-5 mb-2 text-sm font-semibold">Stock-Scan History</h4>
    {controls}
    {rows.length ? <div className="mb-3 overflow-x-auto rounded-lg border border-slate-200 bg-white/90">
      <table aria-label="Stock-Scan History" className="min-w-[72rem] text-xs">
        <thead><tr className="border-b border-gray-200 bg-slate-50 text-left text-[11px] uppercase tracking-wide text-gray-500">
          {STOCK_SCAN_HISTORY_COLUMNS.map(label => <th key={label} scope="col" className="px-3 py-2 font-semibold">{label}</th>)}
        </tr></thead>
        <tbody className="divide-y divide-gray-100">{rows.map(row => renderRow(row))}</tbody>
      </table>
    </div> : emptyState}
  </>;
}

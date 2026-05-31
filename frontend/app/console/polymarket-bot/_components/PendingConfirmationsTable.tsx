'use client';

import { AlertTriangle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { PolymarketSourceTradeDecision } from '@/types/api';

function formatMoney(value: number, digits = 2) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: digits,
  }).format(value || 0);
}

export function PendingConfirmationsTable({
  rows,
  maxPending,
  showAll,
  confirmDisabled,
  busyTradeId,
  onConfirm,
  onReject,
}: {
  rows: PolymarketSourceTradeDecision[];
  maxPending: number;
  showAll: boolean;
  confirmDisabled: boolean;
  busyTradeId: string | null;
  onConfirm: (tradeId: string) => void;
  onReject: (tradeId: string) => void;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-[24px] border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-sm text-slate-500">
        No pending confirmations yet. Proposals appear only after a new qualifying live-read trade is detected
        after the startup baseline.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {rows.length > maxPending ? (
        <div className="flex items-start gap-3 rounded-[20px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            Pending confirmations exceed `MAX_PENDING_CONFIRMATIONS` ({maxPending}). New proposals should be
            blocked until the queue is reduced.
          </span>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-[24px] border border-slate-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
          <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            <tr>
              <th className="px-4 py-3">Trader</th>
              <th className="px-4 py-3">Market</th>
              <th className="px-4 py-3">Outcome</th>
              <th className="px-4 py-3">Side</th>
              <th className="px-4 py-3">Amount</th>
              <th className="px-4 py-3">Price</th>
              <th className="px-4 py-3">Max Loss</th>
              <th className="px-4 py-3">Reason</th>
              <th className="px-4 py-3">Source</th>
              <th className="px-4 py-3">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((trade) => {
              const isBusy = busyTradeId === trade.id;
              return (
                <tr key={trade.id} className="align-top">
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-950">{trade.trader_name}</div>
                    <div className="mt-1 text-xs text-slate-500">
                      {trade.trader_handle ? `@${trade.trader_handle}` : trade.trader_address || trade.trader_id}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    <div className="font-medium text-slate-950">{trade.market_title}</div>
                    <div className="mt-1 text-xs text-slate-500">{trade.market_id}</div>
                  </td>
                  <td className="px-4 py-3 text-slate-700">{trade.outcome}</td>
                  <td className="px-4 py-3">
                    <span
                      className={
                        trade.side === 'BUY'
                          ? 'rounded-full bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700'
                          : 'rounded-full bg-rose-50 px-2 py-1 text-xs font-semibold text-rose-700'
                      }
                    >
                      {trade.side}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-700">{formatMoney(trade.amount)}</td>
                  <td className="px-4 py-3 text-slate-700">{formatMoney(trade.price, 4)}</td>
                  <td className="px-4 py-3 text-slate-700">{formatMoney(trade.max_loss)}</td>
                  <td className="px-4 py-3 text-slate-700">
                    <div className="max-w-[18rem] text-xs leading-5 text-slate-600">{trade.reason}</div>
                  </td>
                  <td className="px-4 py-3 text-xs uppercase tracking-[0.18em] text-slate-500">{trade.source}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-2">
                      <Button
                        size="xs"
                        className="justify-center rounded-full bg-amber-400 px-3 text-slate-950 hover:bg-amber-300"
                        disabled={confirmDisabled || isBusy}
                        onClick={() => onConfirm(trade.id)}
                      >
                        {isBusy ? 'Working' : 'Confirm'}
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        className="justify-center rounded-full border-slate-300"
                        disabled={isBusy}
                        onClick={() => onReject(trade.id)}
                      >
                        Reject
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {!showAll ? (
        <div className="text-xs text-slate-500">Showing latest 25 pending confirmations.</div>
      ) : null}
    </div>
  );
}

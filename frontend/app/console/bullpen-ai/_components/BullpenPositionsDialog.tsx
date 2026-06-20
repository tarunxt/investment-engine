"use client";

import { ExternalLink, Loader2, RefreshCw, X } from "lucide-react";

import { Button } from "@/components/ui/button";

export type BullpenActivePositionView = {
  key: string;
  marketId: string;
  marketTitle: string;
  outcome: string;
  shares: number;
  averagePrice: number;
  costBasis: number;
  currentOdds: number | null;
  currentValue: number | null;
  unrealizedPnl: number | null;
  marketUrl: string | null;
  closeTime: string | null;
};

type BullpenPositionsDialogProps = {
  isLoading: boolean;
  lastUpdatedAt: string | null;
  onClose: () => void;
  onRefresh: () => void;
  positions: BullpenActivePositionView[];
  positionsError: string | null;
};

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-IN", { dateStyle: "medium" });
}

function formatMoney(value: number | null) {
  if (value === null) return "—";
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatPrice(value: number | null) {
  if (value === null) return "—";
  return `${(value * 100).toLocaleString(undefined, {
    minimumFractionDigits: value * 100 < 10 ? 1 : 0,
    maximumFractionDigits: 2,
  })}c`;
}

function formatShares(value: number) {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: value < 10 ? 2 : 0,
    maximumFractionDigits: 3,
  });
}

function formatTimestamp(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function BullpenPositionsDialog({
  isLoading,
  lastUpdatedAt,
  onClose,
  onRefresh,
  positions,
  positionsError,
}: BullpenPositionsDialogProps) {
  const sortedPositions = [...positions].sort((left, right) => {
    const leftTime = left.closeTime ? new Date(left.closeTime).getTime() : Number.POSITIVE_INFINITY;
    const rightTime = right.closeTime ? new Date(right.closeTime).getTime() : Number.POSITIVE_INFINITY;
    if (leftTime !== rightTime) return leftTime - rightTime;
    return left.marketTitle.localeCompare(right.marketTitle);
  });
  const refreshedLabel = formatTimestamp(lastUpdatedAt);

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/55 p-4">
      <div className="flex max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.45)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
              Active Bullpen Positions
            </p>
            <h2 className="text-xl font-semibold text-slate-950">
              Positions ({positions.length})
            </h2>
            <p className="text-sm text-slate-600">
              Current holdings from the Bullpen wallet with refreshed odds, value,
              and unrealized PnL.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRefresh}
              disabled={isLoading}
            >
              {isLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Refreshing...
                </>
              ) : (
                <>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Refresh
                </>
              )}
            </Button>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
              aria-label="Close positions dialog"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto px-6 py-5">
          {positionsError ? (
            <div className="mb-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
              {positionsError}
            </div>
          ) : null}

          {refreshedLabel ? (
            <p className="mb-4 text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
              Last refreshed: {refreshedLabel}
            </p>
          ) : null}

          <div className="overflow-hidden rounded-2xl border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Market</th>
                  <th className="px-4 py-3">Close</th>
                  <th className="px-4 py-3">Average</th>
                  <th className="px-4 py-3">Current</th>
                  <th className="px-4 py-3">Value</th>
                  <th className="px-4 py-3">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {isLoading && sortedPositions.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-slate-500">
                      Refreshing active Bullpen positions...
                    </td>
                  </tr>
                ) : sortedPositions.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-slate-500">
                      No active Bullpen positions are open right now.
                    </td>
                  </tr>
                ) : (
                  sortedPositions.map((position) => (
                    <tr key={position.key} className="align-top hover:bg-slate-50">
                      <td className="max-w-xl px-4 py-3">
                        <div className="font-medium text-slate-950">
                          {position.marketTitle}
                        </div>
                        <div className="mt-1 text-xs text-slate-500">
                          {position.outcome} · {formatShares(position.shares)} shares
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                        {formatDate(position.closeTime)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-700">
                        {formatPrice(position.averagePrice)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-700">
                        {formatPrice(position.currentOdds === null ? null : position.currentOdds / 100)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <div className="font-semibold text-slate-950">
                          {formatMoney(position.currentValue ?? position.costBasis)}
                        </div>
                        <div
                          className={`mt-1 text-xs font-medium ${
                            position.unrealizedPnl === null
                              ? "text-slate-500"
                              : position.unrealizedPnl >= 0
                                ? "text-emerald-700"
                                : "text-rose-700"
                          }`}
                        >
                          {position.unrealizedPnl === null
                            ? `${formatMoney(position.costBasis)} cost basis`
                            : `${position.unrealizedPnl >= 0 ? "+" : "-"}${formatMoney(
                                Math.abs(position.unrealizedPnl),
                              )} vs cost basis`}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        {position.marketUrl ? (
                          <a
                            href={position.marketUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
                          >
                            Open
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        ) : (
                          <span className="text-xs text-slate-400">—</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

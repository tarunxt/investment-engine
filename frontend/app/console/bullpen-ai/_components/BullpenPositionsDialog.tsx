"use client";

import { ExternalLink, Loader2, RefreshCw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { BullpenActivePositionView } from "@/lib/bullpenPositions";

type BullpenPositionsDialogProps = {
  claimError: string | null;
  claimStatusMessage: string | null;
  isClaiming: boolean;
  isLoading: boolean;
  lastUpdatedAt: string | null;
  onClaimNow: () => void;
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

function formatPercent(value: number | null) {
  if (value === null) return null;
  return `${Math.abs(value).toLocaleString(undefined, {
    maximumFractionDigits: 2,
  })}%`;
}

function formatReturnsPerDay(value: number | null) {
  if (value === null) return "—";
  return `${value.toLocaleString(undefined, {
    maximumFractionDigits: 2,
  })}%`;
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

function sortPositions(
  left: BullpenActivePositionView,
  right: BullpenActivePositionView,
) {
  if (left.isClaimable !== right.isClaimable) {
    return left.isClaimable ? -1 : 1;
  }
  const leftTime = left.closeTime
    ? new Date(left.closeTime).getTime()
    : Number.POSITIVE_INFINITY;
  const rightTime = right.closeTime
    ? new Date(right.closeTime).getTime()
    : Number.POSITIVE_INFINITY;
  if (leftTime !== rightTime) return leftTime - rightTime;
  return left.marketTitle.localeCompare(right.marketTitle);
}

export function BullpenPositionsDialog({
  claimError,
  claimStatusMessage,
  isClaiming,
  isLoading,
  lastUpdatedAt,
  onClaimNow,
  onClose,
  onRefresh,
  positions,
  positionsError,
}: BullpenPositionsDialogProps) {
  const sortedPositions = [...positions].sort(sortPositions);
  const claimablePositions = sortedPositions.filter((position) => position.isClaimable);
  const activePositions = sortedPositions.filter((position) => !position.isClaimable);
  const claimableValue = claimablePositions.reduce(
    (total, position) =>
      total + (position.claimableValue ?? position.currentValue ?? position.costBasis),
    0,
  );
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
              Current Bullpen holdings, including resolved events that are ready
              to be redeemed or claimed.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {claimablePositions.length > 0 || isClaiming ? (
              <Button
                type="button"
                size="sm"
                onClick={onClaimNow}
                disabled={isClaiming}
                className="bg-emerald-600 text-white hover:bg-emerald-700"
              >
                {isClaiming ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Claiming...
                  </>
                ) : (
                  "Claim now"
                )}
              </Button>
            ) : null}
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

          {claimError ? (
            <div className="mb-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
              {claimError}
            </div>
          ) : null}

          {claimStatusMessage ? (
            <div className="mb-4 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
              {claimStatusMessage}
            </div>
          ) : null}

          {refreshedLabel ? (
            <p className="mb-4 text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
              Last refreshed: {refreshedLabel}
            </p>
          ) : null}

          {claimablePositions.length > 0 ? (
            <div className="mb-6 overflow-hidden rounded-2xl border border-emerald-200">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-emerald-200 bg-emerald-50 px-4 py-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-800">
                    Ready To Claim
                  </p>
                  <p className="mt-1 text-sm text-emerald-950">
                    {claimablePositions.length} resolved Bullpen event
                    {claimablePositions.length === 1 ? "" : "s"} can be claimed
                    now for about {formatMoney(claimableValue)}.
                  </p>
                </div>
                <Button
                  type="button"
                  onClick={onClaimNow}
                  disabled={isClaiming}
                  className="bg-emerald-600 text-white hover:bg-emerald-700"
                >
                  {isClaiming ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Claiming...
                    </>
                  ) : (
                    "Claim now"
                  )}
                </Button>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-emerald-100 text-sm">
                  <thead className="bg-white text-left text-xs font-semibold uppercase tracking-wide text-emerald-900">
                    <tr>
                      <th className="px-4 py-3">Market</th>
                      <th className="px-4 py-3">Date</th>
                      <th className="px-4 py-3">Claim value</th>
                      <th className="px-4 py-3">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-emerald-100 bg-white">
                    {claimablePositions.map((position) => (
                      <tr key={position.key} className="align-top">
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
                        <td className="whitespace-nowrap px-4 py-3">
                          <div className="font-semibold text-emerald-800">
                            {formatMoney(
                              position.claimableValue ??
                                position.currentValue ??
                                position.costBasis,
                            )}
                          </div>
                          <div className="mt-1 text-xs font-medium text-emerald-700">
                            Ready in Bullpen
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
                              Open market
                              <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                          ) : (
                            <span className="text-xs text-slate-400">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          <div className="mb-3">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
              {claimablePositions.length > 0
                ? `Still Open (${activePositions.length})`
                : `Current Positions (${sortedPositions.length})`}
            </p>
          </div>

          <div className="overflow-hidden rounded-2xl border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Market</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Average</th>
                  <th className="px-4 py-3">Current</th>
                  <th className="px-4 py-3">Returns/day</th>
                  <th className="px-4 py-3">Value</th>
                  <th className="px-4 py-3">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {isLoading && sortedPositions.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-slate-500">
                      Refreshing Bullpen positions...
                    </td>
                  </tr>
                ) : activePositions.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-slate-500">
                      {claimablePositions.length > 0
                        ? "All visible Bullpen positions are resolved and ready to claim."
                        : "No active Bullpen positions are open right now."}
                    </td>
                  </tr>
                ) : (
                  activePositions.map((position) => (
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
                        {formatPrice(position.currentPrice)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-700">
                        {formatReturnsPerDay(position.returnsPerDay)}
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
                              )}${
                                position.unrealizedPnlPercent === null
                                  ? ""
                                  : ` (${formatPercent(position.unrealizedPnlPercent)})`
                              } vs cost basis`}
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
                            Open market
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

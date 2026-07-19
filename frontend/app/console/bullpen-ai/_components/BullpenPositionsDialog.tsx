"use client";

import { ExternalLink, Loader2, RefreshCw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  isActiveBullpenPosition,
  isClaimableBullpenPosition,
  type BullpenActivePositionView,
  type BullpenExcludedPositionDiagnostic,
  type BullpenLiveHealth,
  type BullpenLiveSnapshot,
  type BullpenPositionsDiagnostics,
  type BullpenPositionsFallback,
  type BullpenPositionsSource,
} from "@/lib/bullpenPositions";
import { formatApiTimestamp } from "@/lib/datetime";
import { cn } from "@/lib/utils";

type BullpenPositionsDialogProps = {
  claimError: string | null;
  claimStatusMessage: string | null;
  isClaiming: boolean;
  isLoading: boolean;
  lastUpdatedAt: string | null;
  lastSuccessfulLiveSnapshot: BullpenLiveSnapshot | null;
  onClaimNow: () => void;
  onClose: () => void;
  onRefresh: () => void;
  positions: BullpenActivePositionView[];
  positionsDiagnostics: BullpenPositionsDiagnostics | null;
  positionsError: string | null;
  positionsFallback: BullpenPositionsFallback | null;
  positionsHealth: BullpenLiveHealth | null;
  positionsSource: BullpenPositionsSource | null;
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
  const timestamp = formatApiTimestamp(value, {
    emptyValue: null,
    second: undefined,
  });
  return timestamp || null;
}

function getLiveStatusLabel(health: BullpenLiveHealth | null, isLoading: boolean) {
  if (!health) {
    return isLoading ? "Checking..." : "Unknown";
  }

  if (health.ok) {
    return "OK";
  }

  switch (health.classification) {
    case "AUTH_REQUIRED":
      return "Login required";
    case "AUTH_EXPIRED":
      return "Auth expired";
    case "NETWORK_ERROR":
      return "Network issue";
    case "BINARY_MISSING":
      return "CLI missing";
    case "JSON_PARSE_ERROR":
      return "Bad CLI JSON";
    case "TIMEOUT":
      return "Timed out";
    default:
      return "Unknown error";
  }
}

function getSourceLabel(source: BullpenPositionsSource | null) {
  switch (source) {
    case "live-cli":
      return "Live CLI";
    case "last-successful-live-snapshot":
      return "Cached live snapshot";
    case "tracked-positions":
      return "Tracked fallback";
    default:
      return "Unavailable";
  }
}

function getStatusToneClass(health: BullpenLiveHealth | null) {
  if (!health) {
    return "border-slate-200 bg-slate-50 text-slate-800";
  }

  if (health.ok) {
    return "border-emerald-200 bg-emerald-50 text-emerald-900";
  }

  switch (health.classification) {
    case "AUTH_REQUIRED":
    case "AUTH_EXPIRED":
      return "border-amber-200 bg-amber-50 text-amber-950";
    case "NETWORK_ERROR":
    case "TIMEOUT":
      return "border-sky-200 bg-sky-50 text-sky-950";
    case "BINARY_MISSING":
    case "JSON_PARSE_ERROR":
    case "UNKNOWN_ERROR":
    default:
      return "border-rose-200 bg-rose-50 text-rose-950";
  }
}

function StatusCard({
  label,
  value,
  detail,
  toneClassName = "border-slate-200 bg-slate-50 text-slate-900",
  compactValue = false,
}: {
  label: string;
  value: string;
  detail: string | null;
  toneClassName?: string;
  compactValue?: boolean;
}) {
  return (
    <div className={cn("rounded-2xl border px-4 py-3", toneClassName)}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] opacity-75">
        {label}
      </p>
      <p
        className={cn(
          "mt-2 font-semibold tracking-tight",
          compactValue ? "break-all text-sm" : "text-lg",
        )}
      >
        {value}
      </p>
      <p className="mt-2 text-xs leading-5 opacity-80">{detail || "—"}</p>
    </div>
  );
}

function sortPositions(
  left: BullpenActivePositionView,
  right: BullpenActivePositionView,
) {
  const leftClaimable = isClaimableBullpenPosition(left);
  const rightClaimable = isClaimableBullpenPosition(right);
  if (leftClaimable !== rightClaimable) {
    return leftClaimable ? -1 : 1;
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

function formatDiagnosticClassification(
  value: BullpenExcludedPositionDiagnostic["economicClassification"],
) {
  switch (value) {
    case "settlement_pending":
      return "Settlement pending";
    case "stale_or_unknown":
      return "Stale or unknown";
    case "resolved_zero_payout":
      return "Resolved zero payout";
    case "closed":
      return "Closed";
    case "positive_payout_claimable":
      return "Claimable";
    case "active":
    default:
      return "Active";
  }
}

function DiagnosticTable({
  title,
  description,
  rows,
  toneClasses,
}: {
  title: string;
  description: string;
  rows: BullpenExcludedPositionDiagnostic[];
  toneClasses: {
    border: string;
    header: string;
    tableHead: string;
  };
}) {
  if (rows.length === 0) {
    return null;
  }

  return (
    <div className={`overflow-hidden rounded-2xl border ${toneClasses.border}`}>
      <div className={`border-b px-4 py-4 ${toneClasses.header}`}>
        <p className="text-xs font-semibold uppercase tracking-[0.16em]">
          {title}
        </p>
        <p className="mt-1 text-sm">{description}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className={toneClasses.tableHead}>
            <tr>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide">
                Market
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide">
                Close
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide">
                Classification
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide">
                Value
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide">
                Reason
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {rows.map((position) => (
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
                <td className="whitespace-nowrap px-4 py-3 text-slate-700">
                  {formatDiagnosticClassification(position.economicClassification)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-slate-700">
                  <div>{formatMoney(position.currentValue)}</div>
                  <div className="mt-1 text-xs text-slate-500">
                    Expected payout: {formatMoney(position.expectedPayoutUsd)}
                  </div>
                </td>
                <td className="min-w-[20rem] px-4 py-3 text-slate-700">
                  {position.classificationReason}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function BullpenPositionsDialog({
  claimError,
  claimStatusMessage,
  isClaiming,
  isLoading,
  lastUpdatedAt,
  lastSuccessfulLiveSnapshot,
  onClaimNow,
  onClose,
  onRefresh,
  positions,
  positionsDiagnostics,
  positionsError,
  positionsFallback,
  positionsHealth,
  positionsSource,
}: BullpenPositionsDialogProps) {
  const sortedPositions = [...positions].sort(sortPositions);
  const claimablePositions = sortedPositions.filter(isClaimableBullpenPosition);
  const activePositions = sortedPositions.filter(isActiveBullpenPosition);
  const settlementPendingPositions =
    positionsDiagnostics?.settlementPendingPositions ?? [];
  const excludedDiagnostics = positionsDiagnostics?.excludedPositions ?? [];
  const claimableValue = claimablePositions.reduce(
    (total, position) =>
      total + (position.claimableValue ?? position.currentValue ?? position.costBasis),
    0,
  );
  const refreshedLabel = formatTimestamp(lastUpdatedAt);
  const lastSuccessfulLiveRefreshLabel = formatTimestamp(
    lastSuccessfulLiveSnapshot?.fetchedAt || null,
  );
  const liveStatusLabel = getLiveStatusLabel(positionsHealth, isLoading);
  const sourceLabel = getSourceLabel(positionsSource);
  const liveStatusToneClass = getStatusToneClass(positionsHealth);
  const fallbackMessage = positionsFallback?.active
    ? positionsFallback.message
    : null;
  const credentialHomeLabel = positionsHealth?.credentialHome || "—";
  const actionNeededLabel =
    positionsHealth?.actionNeeded ||
    (positionsHealth?.ok ? "None" : "Refresh after restoring the live CLI.");

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
              to be redeemed or claimed. Settlement and stale rows are tracked
              separately below and do not count as active.
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
            <div className="mb-4 whitespace-pre-wrap break-words rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
              {positionsError}
            </div>
          ) : null}

          {claimError ? (
            <div className="mb-4 whitespace-pre-wrap break-words rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
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

          <div className="mb-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <StatusCard
              label="Live status"
              value={liveStatusLabel}
              detail={positionsHealth?.message || "Waiting for Bullpen live health."}
              toneClassName={liveStatusToneClass}
            />
            <StatusCard
              label="Showing"
              value={sourceLabel}
              detail={
                positionsSource === "live-cli"
                  ? "Freshly read from the Bullpen CLI."
                  : positionsSource === "last-successful-live-snapshot"
                    ? "Using the last successful live wallet snapshot."
                    : positionsSource === "tracked-positions"
                      ? "Using tracked positions only as a fallback."
                      : "No Bullpen position source is available yet."
              }
            />
            <StatusCard
              label="Last successful live refresh"
              value={lastSuccessfulLiveRefreshLabel || "—"}
              detail="Latest known good Bullpen CLI wallet sync."
            />
            <StatusCard
              label="Credential HOME"
              value={credentialHomeLabel}
              detail={
                positionsHealth?.commandPath
                  ? `CLI path: ${positionsHealth.commandPath}`
                  : "Bullpen CLI path unavailable."
              }
              compactValue
            />
          </div>

          {fallbackMessage ? (
            <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
              {fallbackMessage}
            </div>
          ) : null}

          <div
            className={cn(
              "mb-4 rounded-2xl border px-4 py-3 text-sm",
              positionsHealth?.ok
                ? "border-emerald-200 bg-emerald-50 text-emerald-950"
                : "border-slate-200 bg-slate-50 text-slate-900",
            )}
          >
            <span className="font-semibold">Action needed:</span>{" "}
            {actionNeededLabel}
          </div>

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

          <div className="mt-6 space-y-4">
            <DiagnosticTable
              title={`Settlement Pending (${settlementPendingPositions.length})`}
              description="Post-close rows with redeemability signals but no verified payout amount yet. These stay out of active counts, Stage 2, and Stage 3."
              rows={settlementPendingPositions}
              toneClasses={{
                border: "border-amber-200",
                header: "border-amber-200 bg-amber-50 text-amber-950",
                tableHead: "bg-amber-50/60 text-amber-900",
              }}
            />
            <DiagnosticTable
              title={`Diagnostics (${excludedDiagnostics.length})`}
              description="Expired, stale, resolved-zero, or otherwise excluded Bullpen rows kept for operator review only."
              rows={excludedDiagnostics}
              toneClasses={{
                border: "border-slate-200",
                header: "border-slate-200 bg-slate-50 text-slate-900",
                tableHead: "bg-slate-50 text-slate-500",
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

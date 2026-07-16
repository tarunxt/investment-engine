"use client";

import { Eye, EyeOff, Maximize2, Minimize2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import {
  buildBullpenHistoricalAssessmentGroups,
  buildBullpenHistoricalAssessmentRows,
  isBullpenHistoricalAssessmentRowInvalid,
  type BullpenHistoricalAssessmentRow,
} from "@/lib/bullpenHistoricalAssessment";
import type { BullpenQuestionRow } from "@/lib/bullpen-ai";
import { formatApiTimestamp } from "@/lib/datetime";
import {
  getInternetAccessBadgeText,
  getInternetAccessTooltipText,
  getResolvedProviderInternetAccess,
  isWebCapableInternetAccess,
} from "@/lib/llmInternetAccess";
import type { BullpenActivePositionView } from "@/lib/bullpenPositions";
import { cn } from "@/lib/utils";
import type { BullpenAutoLiveDecision, BullpenAutoLiveRun } from "@/types/api";

type BullpenEventHistoricalAssessmentTableProps = {
  question?: BullpenQuestionRow | null;
  position?: BullpenActivePositionView | null;
  runs?: BullpenAutoLiveRun[] | null;
  decisions?: BullpenAutoLiveDecision[] | null;
  title?: string;
  description?: string | null;
  className?: string;
  defaultCompact?: boolean;
};

function formatDate(value: string | null) {
  return formatApiTimestamp(value, {
    emptyValue: "—",
    second: undefined,
  });
}

function formatOdds(value: number | null) {
  if (value === null) return "—";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

function formatDirection(value: string | null | undefined) {
  switch (value) {
    case "YES_CAMP":
      return "Yes camp";
    case "NO_CAMP":
      return "No camp";
    case "UNCERTAIN":
      return "Uncertain";
    default:
      return "—";
  }
}

function formatYesNo(value: boolean | null | undefined) {
  if (value === true) return "Yes";
  if (value === false) return "No";
  return "—";
}

function isLikelyUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

function getSingleLineRationale(row: BullpenHistoricalAssessmentRow) {
  const sourceText = (
    row.rationale ??
    row.invalidReason ??
    row.staleFactReason ??
    "No rationale saved for this output."
  )
    .replace(/\s+/g, " ")
    .trim();
  const firstSentence = sourceText.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim();
  return firstSentence || sourceText;
}

function ToolbarButton({
  active,
  label,
  onClick,
  children,
}: {
  active?: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "inline-flex h-9 w-9 items-center justify-center rounded-full border transition",
        active
          ? "border-emerald-200 bg-emerald-50 text-emerald-800"
          : "border-slate-200 bg-white text-slate-500 hover:bg-slate-100 hover:text-slate-900",
      )}
    >
      {children}
    </button>
  );
}

function HistoricalAssessmentRationaleCell({
  row,
  compact,
}: {
  row: BullpenHistoricalAssessmentRow;
  compact: boolean;
}) {
  const internetAccess = getResolvedProviderInternetAccess(row.provider);
  const webCapable = isWebCapableInternetAccess(internetAccess);
  const internetVerified =
    row.internetVerified ?? row.webSearchUsed ?? row.evidenceBlockUsed;
  const invalidWarning =
    row.invalidReason || (row.staleFactDetected ? row.staleFactReason : null);
  const showNoSearchWarning = webCapable && row.webSearchUsed === false;
  const showNoSourcesWarning =
    row.webSearchUsed === true && (row.webSources?.length || 0) === 0;

  if (compact) {
    return (
      <p
        title={getSingleLineRationale(row)}
        className={cn(
          "max-w-[28rem] truncate text-sm leading-6",
          invalidWarning ? "text-rose-700" : "text-slate-700",
        )}
      >
        {getSingleLineRationale(row)}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p>{row.rationale || row.invalidReason || "—"}</p>
      <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3 text-xs leading-5 text-slate-600">
        <div className="flex flex-wrap items-center gap-2">
          <span
            title={getInternetAccessTooltipText(internetAccess)}
            className="rounded-full bg-sky-50 px-2 py-0.5 font-medium text-sky-700 ring-1 ring-sky-100"
          >
            {getInternetAccessBadgeText(internetAccess)}
          </span>
          {row.staleFactDetected ? (
            <span className="rounded-full bg-rose-50 px-2 py-0.5 font-medium text-rose-700 ring-1 ring-rose-100">
              Invalid stale fact
            </span>
          ) : null}
          {row.invalidReason && !row.staleFactDetected ? (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-700 ring-1 ring-amber-100">
              Excluded from consensus
            </span>
          ) : null}
          {row.rationaleOddsMismatch ? (
            <span className="rounded-full bg-orange-50 px-2 py-0.5 font-medium text-orange-700 ring-1 ring-orange-100">
              Rationale/odds mismatch
            </span>
          ) : null}
        </div>
        <div>Direction: {formatDirection(row.direction)}</div>
        <div>
          Effective weight:{" "}
          {row.effectiveWeight?.toLocaleString(undefined, {
            maximumFractionDigits: 2,
          }) || "—"}
        </div>
        <div>Web used: {formatYesNo(row.webSearchUsed)}</div>
        <div>Internet verified: {formatYesNo(internetVerified)}</div>
        <div>Evidence block used: {formatYesNo(row.evidenceBlockUsed)}</div>
        <div>Sources count: {(row.webSources || []).length.toLocaleString()}</div>
        {row.webSearchQueries.length > 0 ? (
          <div>Search queries: {row.webSearchQueries.join(" | ")}</div>
        ) : null}
        {row.webSources.length > 0 ? (
          <div className="space-y-1">
            <div>Sources:</div>
            {row.webSources.slice(0, 4).map((source) =>
              isLikelyUrl(source) ? (
                <a
                  key={source}
                  href={source}
                  target="_blank"
                  rel="noreferrer"
                  className="block break-all text-sky-700 underline decoration-sky-300 underline-offset-2"
                >
                  {source}
                </a>
              ) : (
                <div key={source} className="break-words">
                  {source}
                </div>
              ),
            )}
            {row.webSources.length > 4 ? (
              <div>
                +{row.webSources.length - 4} more source
                {row.webSources.length - 4 === 1 ? "" : "s"}
              </div>
            ) : null}
          </div>
        ) : null}
        {showNoSearchWarning ? (
          <div className="font-medium text-amber-700">
            Warning: This model can use live web data, but no search was saved for
            this run.
          </div>
        ) : null}
        {showNoSourcesWarning ? (
          <div className="font-medium text-amber-700">
            Warning: Live web/search ran, but no sources were returned or saved.
          </div>
        ) : null}
        {invalidWarning ? (
          <div className="font-medium text-rose-700">
            Invalid/stale warning: {invalidWarning}
          </div>
        ) : null}
        {row.rationaleOddsMismatchReason ? (
          <div className="font-medium text-orange-700">
            Mismatch warning: {row.rationaleOddsMismatchReason}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function BullpenEventHistoricalAssessmentTable({
  question,
  position,
  runs,
  decisions,
  title = "Event Historical LLM Assessment",
  description = "All saved LLM outputs for this event, with the newest run shown first.",
  className,
  defaultCompact = false,
}: BullpenEventHistoricalAssessmentTableProps) {
  const [isCompact, setIsCompact] = useState(defaultCompact);
  const [hideInvalidRows, setHideInvalidRows] = useState(false);
  const historicalRows = useMemo(
    () =>
      buildBullpenHistoricalAssessmentRows({
        question,
        position,
        runs,
        decisions,
      }),
    [decisions, position, question, runs],
  );
  const visibleRows = hideInvalidRows
    ? historicalRows.filter((row) => !isBullpenHistoricalAssessmentRowInvalid(row))
    : historicalRows;
  const groups = buildBullpenHistoricalAssessmentGroups(visibleRows);
  const hiddenInvalidCount = historicalRows.length - visibleRows.length;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl border border-slate-200 bg-white",
        className,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-4 py-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-slate-950">{title}</h3>
          <p className="text-xs leading-5 text-slate-500">
            {description}
            {hideInvalidRows && hiddenInvalidCount > 0
              ? ` ${hiddenInvalidCount.toLocaleString()} invalid or out-of-range row${hiddenInvalidCount === 1 ? "" : "s"} hidden.`
              : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ToolbarButton
            active={isCompact}
            label={
              isCompact
                ? "Expand rationale details"
                : "Collapse rationale to one line"
            }
            onClick={() => setIsCompact((current) => !current)}
          >
            {isCompact ? (
              <Maximize2 className="h-4 w-4" />
            ) : (
              <Minimize2 className="h-4 w-4" />
            )}
          </ToolbarButton>
          <ToolbarButton
            active={hideInvalidRows}
            label={
              hideInvalidRows
                ? "Show invalid or out-of-range rows again"
                : "Hide invalid or out-of-range rows"
            }
            onClick={() => setHideInvalidRows((current) => !current)}
          >
            {hideInvalidRows ? (
              <Eye className="h-4 w-4" />
            ) : (
              <EyeOff className="h-4 w-4" />
            )}
          </ToolbarButton>
        </div>
      </div>

      {groups.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="min-w-[1180px] divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Provider</th>
                <th className="px-4 py-3">Model</th>
                <th className="px-4 py-3">Direction</th>
                <th className="px-4 py-3">LLM Yes Odds</th>
                <th className="px-4 py-3">LLM No Odds</th>
                <th className="px-4 py-3">Timestamp</th>
                <th className="px-4 py-3">Rationale</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {groups.map((group) => (
                <FragmentGroup
                  key={group.id}
                  group={group}
                  isCompact={isCompact}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="px-4 py-6 text-sm text-slate-600">
          {hideInvalidRows
            ? "All saved rows for this event are currently hidden because they were invalid or outside the 0-100 odds range."
            : "No historical LLM assessment rows are available for this event yet."}
        </div>
      )}
    </div>
  );
}

function FragmentGroup({
  group,
  isCompact,
}: {
  group: ReturnType<typeof buildBullpenHistoricalAssessmentGroups>[number];
  isCompact: boolean;
}) {
  return (
    <>
      <tr>
        <td
          colSpan={7}
          className={cn(
            "border-y px-4 py-3",
            group.isLatest
              ? "border-emerald-200 bg-emerald-50/80"
              : "border-slate-200 bg-slate-50/80",
          )}
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span
              className={cn(
                "rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em]",
                group.isLatest
                  ? "bg-emerald-100 text-emerald-900"
                  : "bg-slate-200 text-slate-800",
              )}
            >
              {group.isLatest
                ? "Latest assessment run"
                : "Earlier assessment history"}
            </span>
            <span
              className={cn(
                "text-xs font-medium",
                group.isLatest ? "text-emerald-900" : "text-slate-600",
              )}
            >
              {group.latestTimestamp
                ? formatDate(group.latestTimestamp)
                : "Timestamp unavailable"}
            </span>
            {group.isLatest ? (
              <span className="text-xs text-emerald-950">
                {group.decisionLabel
                  ? `Latest cumulative decision: ${group.decisionLabel}. These highlighted rows are the newest LLM batch used for this event.`
                  : "These highlighted rows are the newest LLM batch saved for this event."}
              </span>
            ) : null}
          </div>
          {group.isLatest && group.decisionSummary ? (
            <p className="mt-2 text-xs leading-5 text-emerald-900/85">
              {group.decisionSummary}
            </p>
          ) : null}
        </td>
      </tr>
      {group.rows.map((row) => {
        const invalidRow = isBullpenHistoricalAssessmentRowInvalid(row);
        return (
          <tr
            key={row.id}
            className={cn(
              group.isLatest ? "bg-emerald-50/35" : "bg-white",
              invalidRow && "bg-amber-50/60",
            )}
          >
            <td className="whitespace-nowrap px-4 py-3 font-medium text-slate-900">
              {row.provider}
            </td>
            <td className="whitespace-nowrap px-4 py-3 text-slate-600">
              {row.model}
            </td>
            <td className="whitespace-nowrap px-4 py-3 text-slate-600">
              {formatDirection(row.direction)}
            </td>
            <td className="whitespace-nowrap px-4 py-3 font-semibold text-indigo-700">
              {formatOdds(row.llmYesOdds)}
            </td>
            <td className="whitespace-nowrap px-4 py-3 font-semibold text-violet-700">
              {formatOdds(row.llmNoOdds)}
            </td>
            <td className="whitespace-nowrap px-4 py-3 text-slate-600">
              {formatDate(row.timestamp)}
            </td>
            <td
              className={cn(
                "px-4 py-3 align-top leading-6 text-slate-700",
                isCompact ? "min-w-[320px]" : "min-w-[420px]",
              )}
            >
              <HistoricalAssessmentRationaleCell row={row} compact={isCompact} />
            </td>
          </tr>
        );
      })}
    </>
  );
}

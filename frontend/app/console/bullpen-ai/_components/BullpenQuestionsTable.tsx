"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, ExternalLink } from "lucide-react";

import type {
  BullpenQuestionRow,
  BullpenScanSnapshot,
} from "@/lib/bullpen-ai";
import { BullpenLlmBreakdownDialog } from "./BullpenLlmBreakdownDialog";

export type BullpenTableSortKey =
  | "question"
  | "closeTime"
  | "daysUntilClose"
  | "category"
  | "outcomes"
  | "yesOdds"
  | "noOdds"
  | "volume"
  | "liquidity"
  | "llmYesOdds"
  | "llmNoOdds"
  | "currentVsLlmOddsDifference";

export type BullpenTableSortDirection = "asc" | "desc";

export type BullpenTableSortState = {
  key: BullpenTableSortKey;
  direction: BullpenTableSortDirection;
};

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatOdds(value: number | null) {
  if (value === null) return "—";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

function formatDays(value: number | null) {
  if (value === null) return "—";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}d`;
}

function formatDifference(value: number | null) {
  if (value === null) return "—";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function formatOutcomeSummary(question: BullpenQuestionRow) {
  if (question.outcomeLabels.length > 0) return question.outcomeLabels.join(" / ");
  if (question.isBinaryYesNo) return "Yes / No";
  if (question.outcomeCount !== null) return `${question.outcomeCount} outcomes`;
  return "—";
}

function parseDisplayNumber(value: string | null) {
  if (!value) return null;
  const parsed = Number(value.replace(/[, ]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function compareText(left: string | null, right: string | null) {
  const normalizedLeft = (left || "").toLowerCase();
  const normalizedRight = (right || "").toLowerCase();
  if (!normalizedLeft && !normalizedRight) return 0;
  if (!normalizedLeft) return 1;
  if (!normalizedRight) return -1;
  return normalizedLeft.localeCompare(normalizedRight);
}

function compareNumber(left: number | null, right: number | null) {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

function compareDate(left: string | null, right: string | null) {
  const leftTime = left ? new Date(left).getTime() : Number.POSITIVE_INFINITY;
  const rightTime = right
    ? new Date(right).getTime()
    : Number.POSITIVE_INFINITY;
  return leftTime - rightTime;
}

function getComparatorValue(
  question: BullpenQuestionRow,
  key: BullpenTableSortKey,
) {
  switch (key) {
    case "question":
      return question.question;
    case "closeTime":
      return question.closeTime;
    case "daysUntilClose":
      return question.daysUntilClose;
    case "category":
      return question.category;
    case "outcomes":
      return formatOutcomeSummary(question);
    case "yesOdds":
      return question.yesOdds;
    case "noOdds":
      return question.noOdds;
    case "volume":
      return parseDisplayNumber(question.volume);
    case "liquidity":
      return parseDisplayNumber(question.liquidity);
    case "llmYesOdds":
      return question.llmYesOdds;
    case "llmNoOdds":
      return question.llmNoOdds;
    case "currentVsLlmOddsDifference":
      return question.currentVsLlmOddsDifference;
    default:
      return question.question;
  }
}

function sortQuestions(
  questions: BullpenQuestionRow[],
  sortState: BullpenTableSortState,
) {
  return [...questions].sort((left, right) => {
    let result = 0;

    switch (sortState.key) {
      case "closeTime":
        result = compareDate(left.closeTime, right.closeTime);
        break;
      case "daysUntilClose":
      case "yesOdds":
      case "noOdds":
      case "volume":
      case "liquidity":
      case "llmYesOdds":
      case "llmNoOdds":
      case "currentVsLlmOddsDifference":
        result = compareNumber(
          getComparatorValue(left, sortState.key) as number | null,
          getComparatorValue(right, sortState.key) as number | null,
        );
        break;
      default:
        result = compareText(
          String(getComparatorValue(left, sortState.key) || ""),
          String(getComparatorValue(right, sortState.key) || ""),
        );
        break;
    }

    if (result === 0) {
      result = left.question.localeCompare(right.question);
    }

    return sortState.direction === "asc" ? result : result * -1;
  });
}

function SortButton({
  label,
  sortKey,
  sortState,
  onSortChange,
}: {
  label: string;
  sortKey: BullpenTableSortKey;
  sortState: BullpenTableSortState;
  onSortChange: (key: BullpenTableSortKey) => void;
}) {
  const isActive = sortState.key === sortKey;
  const Icon = !isActive
    ? ArrowUpDown
    : sortState.direction === "asc"
      ? ArrowUp
      : ArrowDown;

  return (
    <button
      type="button"
      onClick={() => onSortChange(sortKey)}
      className="inline-flex items-center gap-1 transition hover:text-slate-800"
    >
      <span>{label}</span>
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

export function BullpenQuestionsTable({
  snapshot,
  emptyMessage,
  isLoading,
  onSortChange,
  selectedQuestionIds,
  selectionEnabled,
  sortState,
  onToggleQuestion,
  onToggleSelectAll,
}: {
  snapshot: BullpenScanSnapshot | null;
  emptyMessage: string;
  isLoading: boolean;
  onSortChange: (key: BullpenTableSortKey) => void;
  selectedQuestionIds: Set<string>;
  selectionEnabled: boolean;
  sortState: BullpenTableSortState;
  onToggleQuestion: (questionId: string) => void;
  onToggleSelectAll: () => void;
}) {
  const [breakdownQuestion, setBreakdownQuestion] =
    useState<BullpenQuestionRow | null>(null);
  const rows = snapshot ? sortQuestions(snapshot.questions, sortState) : [];
  const selectableRowCount = selectionEnabled ? rows.length : 0;
  const selectedVisibleCount = rows.filter((question) =>
    selectedQuestionIds.has(question.id),
  ).length;
  const allVisibleSelected =
    selectableRowCount > 0 && selectedVisibleCount === selectableRowCount;

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="w-12 px-4 py-3">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  disabled={!selectionEnabled || rows.length === 0}
                  onChange={() => onToggleSelectAll()}
                  className="h-4 w-4 rounded border-slate-300 text-slate-950 focus:ring-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
                />
              </th>
              <th className="px-4 py-3">
                <SortButton
                  label="Question"
                  sortKey="question"
                  sortState={sortState}
                  onSortChange={onSortChange}
                />
              </th>
              <th className="px-4 py-3">
                <SortButton
                  label="Closing time"
                  sortKey="closeTime"
                  sortState={sortState}
                  onSortChange={onSortChange}
                />
              </th>
              <th className="px-4 py-3">
                <SortButton
                  label="Days left"
                  sortKey="daysUntilClose"
                  sortState={sortState}
                  onSortChange={onSortChange}
                />
              </th>
              <th className="px-4 py-3">
                <SortButton
                  label="Category"
                  sortKey="category"
                  sortState={sortState}
                  onSortChange={onSortChange}
                />
              </th>
              <th className="px-4 py-3">
                <SortButton
                  label="Outcomes"
                  sortKey="outcomes"
                  sortState={sortState}
                  onSortChange={onSortChange}
                />
              </th>
              <th className="px-4 py-3">
                <SortButton
                  label="Current Yes odds %"
                  sortKey="yesOdds"
                  sortState={sortState}
                  onSortChange={onSortChange}
                />
              </th>
              <th className="px-4 py-3">
                <SortButton
                  label="Current No odds %"
                  sortKey="noOdds"
                  sortState={sortState}
                  onSortChange={onSortChange}
                />
              </th>
              <th className="px-4 py-3">
                <SortButton
                  label="LLM Yes Odds"
                  sortKey="llmYesOdds"
                  sortState={sortState}
                  onSortChange={onSortChange}
                />
              </th>
              <th className="px-4 py-3">
                <SortButton
                  label="LLM No Odds"
                  sortKey="llmNoOdds"
                  sortState={sortState}
                  onSortChange={onSortChange}
                />
              </th>
              <th className="px-4 py-3">
                <SortButton
                  label="Current vs LLM Odds Difference"
                  sortKey="currentVsLlmOddsDifference"
                  sortState={sortState}
                  onSortChange={onSortChange}
                />
              </th>
              <th className="px-4 py-3">
                <SortButton
                  label="Volume"
                  sortKey="volume"
                  sortState={sortState}
                  onSortChange={onSortChange}
                />
              </th>
              <th className="px-4 py-3">
                <SortButton
                  label="Liquidity"
                  sortKey="liquidity"
                  sortState={sortState}
                  onSortChange={onSortChange}
                />
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {rows.length > 0 ? (
              rows.map((question) => (
                <tr key={question.id} className="align-top hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selectedQuestionIds.has(question.id)}
                      disabled={!selectionEnabled}
                      onChange={() => onToggleQuestion(question.id)}
                      className="mt-1 h-4 w-4 rounded border-slate-300 text-slate-950 focus:ring-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
                    />
                  </td>
                  <td className="max-w-xl px-4 py-3 font-medium text-slate-900">
                    <div>{question.question}</div>
                    {question.marketUrl || question.slug ? (
                      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs font-normal text-slate-500">
                        {question.marketUrl ? (
                          <a
                            href={question.marketUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-purple-700 hover:text-purple-900"
                          >
                            Open market
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        ) : null}
                        {question.slug ? <span>{question.slug}</span> : null}
                      </div>
                    ) : null}
                    {question.llmNotes ? (
                      <p className="mt-2 text-xs font-normal leading-5 text-slate-500">
                        LLM note: {question.llmNotes}
                      </p>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                    {formatDate(question.closeTime)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                    {formatDays(question.daysUntilClose)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                    {question.category}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                    {formatOutcomeSummary(question)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 font-semibold text-emerald-700">
                    {formatOdds(question.yesOdds)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 font-semibold text-rose-700">
                    {formatOdds(question.noOdds)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 font-semibold text-indigo-700">
                    {question.llmBreakdown.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => setBreakdownQuestion(question)}
                        className="rounded-md underline decoration-indigo-300 underline-offset-4 transition hover:text-indigo-900"
                      >
                        {formatOdds(question.llmYesOdds)}
                      </button>
                    ) : (
                      formatOdds(question.llmYesOdds)
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 font-semibold text-violet-700">
                    {question.llmBreakdown.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => setBreakdownQuestion(question)}
                        className="rounded-md underline decoration-violet-300 underline-offset-4 transition hover:text-violet-900"
                      >
                        {formatOdds(question.llmNoOdds)}
                      </button>
                    ) : (
                      formatOdds(question.llmNoOdds)
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 font-semibold text-slate-700">
                    {formatDifference(question.currentVsLlmOddsDifference)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                    {question.volume || "—"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                    {question.liquidity || "—"}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td
                  colSpan={13}
                  className="px-4 py-12 text-center text-slate-500"
                >
                  {isLoading ? "Scanning Bullpen..." : emptyMessage}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {breakdownQuestion ? (
        <BullpenLlmBreakdownDialog
          question={breakdownQuestion}
          onClose={() => setBreakdownQuestion(null)}
        />
      ) : null}
    </div>
  );
}

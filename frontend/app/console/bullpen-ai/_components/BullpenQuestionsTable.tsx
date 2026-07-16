"use client";

import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ExternalLink,
  Info,
  X,
} from "lucide-react";

import {
  getBullpenLlmReviewState,
  hasBullpenLlmAnalysis,
  type BullpenQuestionRow,
  type BullpenScanSnapshot,
} from "@/lib/bullpen-ai";
import { formatApiTimestamp } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import type { BullpenAutoLiveDecision, BullpenAutoLiveRun } from "@/types/api";
import {
  BULLPEN_TABLE_COLUMN_IDS,
  DEFAULT_BULLPEN_TABLE_COLUMN_WIDTHS,
  clampBullpenTableColumnWidth,
  getBullpenTableWidth,
  readBullpenTableColumnOrderFromStorage,
  readBullpenTableColumnWidthsFromStorage,
  writeBullpenTableColumnOrderToStorage,
  writeBullpenTableColumnWidthsToStorage,
  type BullpenTableColumnId,
  type BullpenTableColumnWidths,
} from "./bullpenTableColumnWidths";
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
  | "currentVsLlmOddsDifference"
  | "returnsPerDay"
  | "amountToBeInvested";

export type BullpenTableSortDirection = "asc" | "desc";

export type BullpenTableSortState = {
  key: BullpenTableSortKey;
  direction: BullpenTableSortDirection;
};

type ResizableBullpenTableColumnId = Exclude<
  BullpenTableColumnId,
  "select" | "serialNumber"
>;

type ResizeState = {
  columnId: ResizableBullpenTableColumnId;
  startX: number;
  startWidth: number;
};

type DraggableBullpenTableColumnId = Exclude<BullpenTableColumnId, "select">;

type BullpenTableColumnDefinition = {
  columnId: BullpenTableColumnId;
  label: string;
  sortKey?: BullpenTableSortKey;
  align?: "left" | "center" | "right";
  afterLabel?: ReactNode;
};

const DEFAULT_VISIBLE_BULLPEN_TABLE_COLUMN_IDS: BullpenTableColumnId[] =
  BULLPEN_TABLE_COLUMN_IDS.filter(
    (columnId) => columnId !== "noOdds" && columnId !== "llmNoOdds",
  );

function formatDate(value: string | null) {
  return formatApiTimestamp(value, {
    emptyValue: "—",
    second: undefined,
  });
}

function formatUpdatedAt(value: string | null | undefined) {
  return formatApiTimestamp(value, {
    emptyValue: "—",
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

function formatReturnsPerDay(value: number | null) {
  if (value === null) return "—";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

function formatMoney(value: number | null) {
  if (value === null) return "—";
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatOutcomeSummary(question: BullpenQuestionRow) {
  if (question.outcomeLabels.length > 0)
    return question.outcomeLabels.join(" / ");
  if (question.isBinaryYesNo) return "Yes / No";
  if (question.outcomeCount !== null)
    return `${question.outcomeCount} outcomes`;
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
    case "returnsPerDay":
      return question.returnsPerDay;
    case "amountToBeInvested":
      return question.amountToBeInvested;
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
      case "returnsPerDay":
      case "amountToBeInvested":
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

function ColumnResizeHandle({
  columnId,
  label,
  isResizing,
  onResizeStart,
  onResizeStep,
  onReset,
}: {
  columnId: ResizableBullpenTableColumnId;
  label: string;
  isResizing: boolean;
  onResizeStart: (
    columnId: ResizableBullpenTableColumnId,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => void;
  onResizeStep: (columnId: ResizableBullpenTableColumnId, step: number) => void;
  onReset: (columnId: ResizableBullpenTableColumnId) => void;
}) {
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onResizeStep(columnId, -16);
      return;
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      onResizeStep(columnId, 16);
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      onReset(columnId);
    }
  };

  return (
    <button
      type="button"
      aria-label={`Resize ${label} column`}
      title="Drag to resize. Double-click to reset."
      onPointerDown={(event) => onResizeStart(columnId, event)}
      onDoubleClick={() => onReset(columnId)}
      onKeyDown={handleKeyDown}
      className={cn(
        "absolute inset-y-0 -right-1.5 z-10 flex w-3 cursor-col-resize touch-none items-stretch justify-center opacity-0 transition group-hover:opacity-100 focus:opacity-100",
        isResizing && "opacity-100",
      )}
    >
      <span
        className={cn(
          "my-2 w-px rounded-full bg-slate-300 transition",
          isResizing ? "bg-slate-500" : "group-hover:bg-slate-400",
        )}
      />
    </button>
  );
}

function ResizableColumnHeader({
  columnId,
  label,
  sortKey,
  sortState,
  onSortChange,
  isResizing,
  onResizeStart,
  onResizeStep,
  onReset,
  afterLabel,
  draggable,
  isDragging,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  columnId: ResizableBullpenTableColumnId;
  label: string;
  sortKey: BullpenTableSortKey;
  sortState: BullpenTableSortState;
  onSortChange: (key: BullpenTableSortKey) => void;
  afterLabel?: ReactNode;
  isResizing: boolean;
  onResizeStart: (
    columnId: ResizableBullpenTableColumnId,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => void;
  onResizeStep: (columnId: ResizableBullpenTableColumnId, step: number) => void;
  onReset: (columnId: ResizableBullpenTableColumnId) => void;
  draggable: boolean;
  isDragging: boolean;
  onDragStart: (columnId: DraggableBullpenTableColumnId) => void;
  onDragOver: (columnId: DraggableBullpenTableColumnId) => void;
  onDrop: (columnId: DraggableBullpenTableColumnId) => void;
  onDragEnd: () => void;
}) {
  return (
    <th
      className={cn(
        "group relative px-4 py-3",
        draggable && "cursor-grab",
        isDragging && "bg-blue-50 opacity-60",
      )}
      draggable={draggable}
      onDragStart={() => onDragStart(columnId)}
      onDragOver={(event) => {
        event.preventDefault();
        onDragOver(columnId);
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop(columnId);
      }}
      onDragEnd={onDragEnd}
      title="Drag column header to reorder. Drag right edge to resize."
    >
      <div className="inline-flex items-center gap-1">
        <SortButton
          label={label}
          sortKey={sortKey}
          sortState={sortState}
          onSortChange={onSortChange}
        />
        {afterLabel}
      </div>
      <ColumnResizeHandle
        columnId={columnId}
        label={label}
        isResizing={isResizing}
        onResizeStart={onResizeStart}
        onResizeStep={onResizeStep}
        onReset={onReset}
      />
    </th>
  );
}

function AmountHighlightConditionsDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/55 p-4">
      <div className="w-full max-w-lg overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.45)]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-fuchsia-600">
              Pink cell logic
            </p>
            <h2 className="mt-2 text-xl font-semibold text-slate-950">
              Amount to be invested highlight conditions
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close amount highlight conditions"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4 px-6 py-5 text-sm leading-6 text-slate-600">
          <p>
            The amount cell turns pink only when the row qualifies as an invest
            candidate.
          </p>
          <div className="rounded-2xl border border-fuchsia-200 bg-fuchsia-50 p-4">
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-fuchsia-700">
              Highlight rule
            </div>
            <ul className="mt-3 list-disc space-y-2 pl-5 font-medium text-slate-800">
              <li>LLM Yes or No Odds is greater than 80%.</li>
            </ul>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
              Amount formula
            </div>
            <p className="mt-3 font-semibold text-slate-950">
              5 × (strongest LLM odds - 80) × Returns/day / 100
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function getLlmOddsCellClass(value: number | null) {
  if (value === null) return "";
  if (value > 90) return "bg-lime-400 text-slate-950";
  if (value > 80) return "bg-green-500/75 text-slate-950";
  return "";
}

function LlmOddsDisplay({
  question,
  value,
}: {
  question: BullpenQuestionRow;
  value: number | null;
}) {
  const reviewState =
    value === null ? null : getBullpenLlmReviewState(question);
  const fetchError = value === null ? question.llmNotes : null;

  return (
    <span
      className="inline-flex max-w-[10rem] items-center gap-1"
      title={fetchError || undefined}
    >
      <span>{formatOdds(value)}</span>
      {fetchError ? (
        <span className="truncate text-[11px] font-medium text-rose-600">
          {fetchError}
        </span>
      ) : null}
      {reviewState ? (
        <AlertTriangle
          aria-label={reviewState.label}
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            reviewState.tone === "high" ? "text-amber-600" : "text-sky-600",
          )}
          role="img"
        >
          <title>{`${reviewState.label} — review the LLM breakdown before relying on this odds value.`}</title>
        </AlertTriangle>
      ) : null}
    </span>
  );
}

function renderBullpenTableCell({
  columnId,
  question,
  rowIndex,
  hasLlmAnalysis,
  selectedQuestionIds,
  selectionEnabled,
  onToggleQuestion,
  setBreakdownQuestion,
}: {
  columnId: BullpenTableColumnId;
  question: BullpenQuestionRow;
  rowIndex: number;
  hasLlmAnalysis: boolean;
  selectedQuestionIds: Set<string>;
  selectionEnabled: boolean;
  onToggleQuestion: (questionId: string) => void;
  setBreakdownQuestion: (question: BullpenQuestionRow) => void;
}) {
  switch (columnId) {
    case "select":
      return (
        <td key={columnId} className="px-4 py-3">
          <input
            type="checkbox"
            checked={selectedQuestionIds.has(question.id)}
            disabled={!selectionEnabled}
            onChange={() => onToggleQuestion(question.id)}
            className="mt-1 h-4 w-4 rounded border-slate-300 text-slate-950 focus:ring-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
          />
        </td>
      );
    case "serialNumber":
      return (
        <td
          key={columnId}
          className="whitespace-nowrap px-4 py-3 text-center font-semibold text-slate-600"
        >
          {rowIndex + 1}
        </td>
      );
    case "question":
      return (
        <td key={columnId} className="px-4 py-3 font-medium text-slate-900">
          <div className="break-words leading-5">{question.question}</div>
          {question.marketUrl ? (
            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs font-normal text-slate-500">
              <a
                href={question.marketUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-purple-700 hover:text-purple-900"
              >
                Open market
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
          ) : null}
        </td>
      );
    case "closeTime":
      return (
        <td
          key={columnId}
          className="truncate whitespace-nowrap px-4 py-3 text-slate-600"
          title={formatDate(question.closeTime) || undefined}
        >
          {formatDate(question.closeTime)}
        </td>
      );
    case "daysUntilClose":
      return (
        <td
          key={columnId}
          className="whitespace-nowrap px-4 py-3 text-slate-600"
        >
          {formatDays(question.daysUntilClose)}
        </td>
      );
    case "category":
      return (
        <td
          key={columnId}
          className="truncate whitespace-nowrap px-4 py-3 text-slate-600"
          title={question.category || undefined}
        >
          {question.category}
        </td>
      );
    case "outcomes":
      return (
        <td
          key={columnId}
          className="truncate whitespace-nowrap px-4 py-3 text-slate-600"
          title={formatOutcomeSummary(question)}
        >
          {formatOutcomeSummary(question)}
        </td>
      );
    case "yesOdds":
      return (
        <td
          key={columnId}
          className="whitespace-nowrap px-4 py-3 text-xs font-semibold"
        >
          <div className="text-emerald-700">
            Yes: {formatOdds(question.yesOdds)}
          </div>
          <div className="mt-1 text-rose-700">
            No: {formatOdds(question.noOdds)}
          </div>
        </td>
      );
    case "llmYesOdds": {
      const content = (
        <>
          <span
            className={cn("block", getLlmOddsCellClass(question.llmYesOdds))}
          >
            Yes:{" "}
            <LlmOddsDisplay question={question} value={question.llmYesOdds} />
          </span>
          <span
            className={cn(
              "mt-1 block",
              getLlmOddsCellClass(question.llmNoOdds),
            )}
          >
            No:{" "}
            <LlmOddsDisplay question={question} value={question.llmNoOdds} />
          </span>
        </>
      );
      return (
        <td
          key={columnId}
          className="whitespace-nowrap px-4 py-3 text-xs font-semibold text-violet-700"
        >
          {hasLlmAnalysis ? (
            <button
              type="button"
              onClick={() => setBreakdownQuestion(question)}
              aria-label={`Open LLM odds breakdown for ${question.question}`}
              className="rounded-md px-2 py-1 text-left underline decoration-violet-300 underline-offset-4 transition hover:text-violet-900"
            >
              {content}
            </button>
          ) : (
            <span className="rounded-md px-2 py-1">{content}</span>
          )}
        </td>
      );
    }
    case "returnsPerDay":
      return (
        <td
          key={columnId}
          className="whitespace-nowrap px-4 py-3 font-semibold text-slate-700"
        >
          {formatReturnsPerDay(question.returnsPerDay)}
        </td>
      );
    case "amountToBeInvested":
      return (
        <td
          key={columnId}
          className={cn(
            "whitespace-nowrap px-4 py-3 text-right font-semibold text-slate-700",
            question.isAmountToBeInvestedHighlighted
              ? "bg-fuchsia-500 text-slate-950"
              : "",
          )}
        >
          {formatMoney(question.amountToBeInvested)}
        </td>
      );
    case "volume":
      return (
        <td
          key={columnId}
          className="truncate whitespace-nowrap px-4 py-3 text-slate-600"
          title={question.volume || "—"}
        >
          {question.volume || "—"}
        </td>
      );
    case "liquidity":
      return (
        <td
          key={columnId}
          className="truncate whitespace-nowrap px-4 py-3 text-slate-600"
          title={question.liquidity || "—"}
        >
          {question.liquidity || "—"}
        </td>
      );
    default:
      return null;
  }
}

export function BullpenQuestionsTable({
  snapshot,
  rowsOverride,
  rowHighlightById,
  emptyMessage,
  headerContent,
  isLoading,
  historicalRuns,
  historicalDecisions,
  onSortChange,
  selectedQuestionIds,
  selectionEnabled,
  sortState,
  onToggleQuestion,
  onToggleSelectAll,
}: {
  snapshot: BullpenScanSnapshot | null;
  rowsOverride?: BullpenQuestionRow[];
  rowHighlightById?: Record<
    string,
    "active-retained" | "event-exit" | "new-opportunity"
  >;
  emptyMessage: string;
  headerContent?: ReactNode;
  isLoading: boolean;
  historicalRuns?: BullpenAutoLiveRun[];
  historicalDecisions?: BullpenAutoLiveDecision[];
  onSortChange: (key: BullpenTableSortKey) => void;
  selectedQuestionIds: Set<string>;
  selectionEnabled: boolean;
  sortState: BullpenTableSortState;
  onToggleQuestion: (questionId: string) => void;
  onToggleSelectAll: () => void;
}) {
  const [breakdownQuestion, setBreakdownQuestion] =
    useState<BullpenQuestionRow | null>(null);
  const [isAmountHighlightDialogOpen, setIsAmountHighlightDialogOpen] =
    useState(false);
  const [columnWidths, setColumnWidths] = useState<BullpenTableColumnWidths>(
    readBullpenTableColumnWidthsFromStorage,
  );
  const [columnOrder, setColumnOrder] = useState<BullpenTableColumnId[]>(() =>
    readBullpenTableColumnOrderFromStorage(
      DEFAULT_VISIBLE_BULLPEN_TABLE_COLUMN_IDS,
    ),
  );
  const [resizingColumnId, setResizingColumnId] =
    useState<ResizableBullpenTableColumnId | null>(null);
  const [draggedColumnId, setDraggedColumnId] =
    useState<DraggableBullpenTableColumnId | null>(null);
  const resizeStateRef = useRef<ResizeState | null>(null);
  const rows = sortQuestions(
    rowsOverride ?? (snapshot ? snapshot.questions : []),
    sortState,
  );
  const selectableRowCount = selectionEnabled ? rows.length : 0;
  const selectedVisibleCount = rows.filter((question) =>
    selectedQuestionIds.has(question.id),
  ).length;
  const allVisibleSelected =
    selectableRowCount > 0 && selectedVisibleCount === selectableRowCount;
  const visibleColumnIds = columnOrder.filter((columnId) =>
    DEFAULT_VISIBLE_BULLPEN_TABLE_COLUMN_IDS.includes(columnId),
  );
  const tableWidth = getBullpenTableWidth(columnWidths, visibleColumnIds);
  const updatedAtLabel = formatUpdatedAt(snapshot?.scannedAt);

  const setColumnWidth = (
    columnId: ResizableBullpenTableColumnId,
    width: number,
  ) => {
    const nextWidth = clampBullpenTableColumnWidth(columnId, width);
    setColumnWidths((current) =>
      current[columnId] === nextWidth
        ? current
        : {
            ...current,
            [columnId]: nextWidth,
          },
    );
  };

  const handleResizeStart = (
    columnId: ResizableBullpenTableColumnId,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    resizeStateRef.current = {
      columnId,
      startX: event.clientX,
      startWidth: columnWidths[columnId],
    };
    setResizingColumnId(columnId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const handleResizeStep = (
    columnId: ResizableBullpenTableColumnId,
    step: number,
  ) => {
    setColumnWidth(columnId, columnWidths[columnId] + step);
  };

  const resetColumnWidth = (columnId: ResizableBullpenTableColumnId) => {
    setColumnWidth(columnId, DEFAULT_BULLPEN_TABLE_COLUMN_WIDTHS[columnId]);
  };

  useEffect(() => {
    if (resizingColumnId) return;
    writeBullpenTableColumnWidthsToStorage(columnWidths);
  }, [columnWidths, resizingColumnId]);

  useEffect(() => {
    writeBullpenTableColumnOrderToStorage(visibleColumnIds);
  }, [visibleColumnIds]);

  const moveColumn = (
    sourceColumnId: DraggableBullpenTableColumnId,
    targetColumnId: DraggableBullpenTableColumnId,
  ) => {
    if (sourceColumnId === targetColumnId) return;

    setColumnOrder((current) => {
      const sourceIndex = current.indexOf(sourceColumnId);
      const targetIndex = current.indexOf(targetColumnId);
      if (sourceIndex === -1 || targetIndex === -1) return current;

      const next = [...current];
      const [sourceColumn] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, sourceColumn);
      return next;
    });
  };

  const handleColumnDragStart = (columnId: DraggableBullpenTableColumnId) => {
    setDraggedColumnId(columnId);
  };

  const handleColumnDragOver = (columnId: DraggableBullpenTableColumnId) => {
    if (!draggedColumnId) return;
    moveColumn(draggedColumnId, columnId);
  };

  const handleColumnDrop = (columnId: DraggableBullpenTableColumnId) => {
    if (draggedColumnId) moveColumn(draggedColumnId, columnId);
    setDraggedColumnId(null);
  };

  const syncDraggedColumnWidth = useEffectEvent(
    (columnId: ResizableBullpenTableColumnId, width: number) => {
      const nextWidth = clampBullpenTableColumnWidth(columnId, width);
      setColumnWidths((current) =>
        current[columnId] === nextWidth
          ? current
          : {
              ...current,
              [columnId]: nextWidth,
            },
      );
    },
  );

  useEffect(() => {
    if (!resizingColumnId) return;

    const stopResizing = () => {
      resizeStateRef.current = null;
      setResizingColumnId(null);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };

    const handlePointerMove = (event: PointerEvent) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState) return;
      syncDraggedColumnWidth(
        resizeState.columnId,
        resizeState.startWidth + (event.clientX - resizeState.startX),
      );
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResizing);
    window.addEventListener("pointercancel", stopResizing);
    window.addEventListener("blur", stopResizing);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResizing);
      window.removeEventListener("pointercancel", stopResizing);
      window.removeEventListener("blur", stopResizing);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };
  }, [resizingColumnId]);

  const amountHighlightInfo = (
    <span
      role="button"
      tabIndex={0}
      aria-label="Show amount highlight conditions"
      title="Show pink cell highlight conditions"
      onClick={(event) => {
        event.stopPropagation();
        setIsAmountHighlightDialogOpen(true);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          setIsAmountHighlightDialogOpen(true);
        }
      }}
      className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-slate-400 text-slate-500 transition hover:border-fuchsia-500 hover:bg-fuchsia-50 hover:text-fuchsia-700 focus:outline-none focus:ring-2 focus:ring-fuchsia-300"
    >
      <Info className="h-3 w-3" />
    </span>
  );

  const columnDefinitions: Record<
    BullpenTableColumnId,
    BullpenTableColumnDefinition
  > = {
    select: { columnId: "select", label: "Select" },
    serialNumber: { columnId: "serialNumber", label: "S. No", align: "center" },
    question: { columnId: "question", label: "Question", sortKey: "question" },
    closeTime: {
      columnId: "closeTime",
      label: "Closing time",
      sortKey: "closeTime",
    },
    daysUntilClose: {
      columnId: "daysUntilClose",
      label: "Days left",
      sortKey: "daysUntilClose",
    },
    category: { columnId: "category", label: "Category", sortKey: "category" },
    outcomes: { columnId: "outcomes", label: "Outcomes", sortKey: "outcomes" },
    yesOdds: { columnId: "yesOdds", label: "Current Odds", sortKey: "yesOdds" },
    noOdds: { columnId: "noOdds", label: "Current No Odds", sortKey: "noOdds" },
    llmYesOdds: {
      columnId: "llmYesOdds",
      label: "LLM Odds",
      sortKey: "llmYesOdds",
    },
    llmNoOdds: {
      columnId: "llmNoOdds",
      label: "LLM No Odds",
      sortKey: "llmNoOdds",
    },
    returnsPerDay: {
      columnId: "returnsPerDay",
      label: "Returns/day",
      sortKey: "returnsPerDay",
    },
    amountToBeInvested: {
      columnId: "amountToBeInvested",
      label: "Amount to be invested",
      sortKey: "amountToBeInvested",
      afterLabel: amountHighlightInfo,
    },
    volume: { columnId: "volume", label: "Volume", sortKey: "volume" },
    liquidity: {
      columnId: "liquidity",
      label: "Liquidity",
      sortKey: "liquidity",
    },
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200">
      <div className="border-b border-slate-200 bg-white px-4 py-3 text-left">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="text-sm font-semibold text-slate-950">
            Events Summary
          </h2>
          <span className="text-xs font-medium text-slate-500">
            Updated {updatedAtLabel}
          </span>
        </div>
        {headerContent ? <div className="mt-3">{headerContent}</div> : null}
      </div>
      <div className="overflow-x-auto">
        <table
          className="min-w-full table-fixed divide-y divide-slate-200 text-sm"
          suppressHydrationWarning
          style={{ width: tableWidth }}
        >
          <colgroup>
            {visibleColumnIds.map((columnId) => (
              <col key={columnId} style={{ width: columnWidths[columnId] }} />
            ))}
          </colgroup>
          <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              {visibleColumnIds.map((columnId) => {
                const definition = columnDefinitions[columnId];
                if (columnId === "select") {
                  return (
                    <th key={columnId} className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={allVisibleSelected}
                        disabled={!selectionEnabled || rows.length === 0}
                        onChange={() => onToggleSelectAll()}
                        className="h-4 w-4 rounded border-slate-300 text-slate-950 focus:ring-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
                      />
                    </th>
                  );
                }

                if (columnId === "serialNumber") {
                  return (
                    <th
                      key={columnId}
                      className="cursor-grab whitespace-nowrap px-4 py-3 text-center"
                      draggable
                      onDragStart={() => handleColumnDragStart(columnId)}
                      onDragOver={(event) => {
                        event.preventDefault();
                        handleColumnDragOver(columnId);
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        handleColumnDrop(columnId);
                      }}
                      onDragEnd={() => setDraggedColumnId(null)}
                      title="Drag column header to reorder."
                    >
                      {definition.label}
                    </th>
                  );
                }

                if (!definition.sortKey) return null;

                return (
                  <ResizableColumnHeader
                    key={columnId}
                    columnId={columnId as ResizableBullpenTableColumnId}
                    label={definition.label}
                    sortKey={definition.sortKey}
                    sortState={sortState}
                    onSortChange={onSortChange}
                    isResizing={resizingColumnId === columnId}
                    onResizeStart={handleResizeStart}
                    onResizeStep={handleResizeStep}
                    onReset={resetColumnWidth}
                    afterLabel={definition.afterLabel}
                    draggable
                    isDragging={draggedColumnId === columnId}
                    onDragStart={handleColumnDragStart}
                    onDragOver={handleColumnDragOver}
                    onDrop={handleColumnDrop}
                    onDragEnd={() => setDraggedColumnId(null)}
                  />
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {rows.length > 0 ? (
              rows.map((question, rowIndex) => {
                const hasLlmAnalysis = hasBullpenLlmAnalysis(question);

                const rowHighlight = rowHighlightById?.[question.id] ?? null;
                return (
                  <tr
                    key={question.id}
                    className={cn(
                      "align-top hover:bg-slate-50",
                      rowHighlight === "active-retained" &&
                        "bg-emerald-50 hover:bg-emerald-100/70",
                      rowHighlight === "event-exit" &&
                        "bg-rose-50 hover:bg-rose-100/70",
                      rowHighlight === "new-opportunity" &&
                        "bg-fuchsia-50 hover:bg-fuchsia-100/70",
                    )}
                  >
                    {visibleColumnIds.map((columnId) =>
                      renderBullpenTableCell({
                        columnId,
                        question,
                        rowIndex,
                        hasLlmAnalysis,
                        selectedQuestionIds,
                        selectionEnabled,
                        onToggleQuestion,
                        setBreakdownQuestion,
                      }),
                    )}
                  </tr>
                );
              })
            ) : (
              <tr>
                <td
                  colSpan={15}
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
          historicalRuns={historicalRuns}
          historicalDecisions={historicalDecisions}
          onClose={() => setBreakdownQuestion(null)}
        />
      ) : null}
      {isAmountHighlightDialogOpen ? (
        <AmountHighlightConditionsDialog
          onClose={() => setIsAmountHighlightDialogOpen(false)}
        />
      ) : null}
    </div>
  );
}

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
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, ExternalLink, Info, X } from "lucide-react";

import {
  getBullpenLlmReviewState,
  type BullpenQuestionRow,
  type BullpenScanSnapshot,
} from "@/lib/bullpen-ai";
import { formatApiTimestamp } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import {
  BULLPEN_TABLE_COLUMN_IDS,
  DEFAULT_BULLPEN_TABLE_COLUMN_WIDTHS,
  clampBullpenTableColumnWidth,
  getBullpenTableWidth,
  readBullpenTableColumnWidthsFromStorage,
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

type ResizableBullpenTableColumnId = Exclude<BullpenTableColumnId, "select">;

type ResizeState = {
  columnId: ResizableBullpenTableColumnId;
  startX: number;
  startWidth: number;
};

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
  onResizeStep: (
    columnId: ResizableBullpenTableColumnId,
    step: number,
  ) => void;
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
  onResizeStep: (
    columnId: ResizableBullpenTableColumnId,
    step: number,
  ) => void;
  onReset: (columnId: ResizableBullpenTableColumnId) => void;
}) {
  return (
    <th className="group relative px-4 py-3">
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


function AmountHighlightConditionsDialog({
  onClose,
}: {
  onClose: () => void;
}) {
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
            The amount cell turns pink only when the row qualifies as an invest candidate.
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
  const reviewState = value === null ? null : getBullpenLlmReviewState(question);

  return (
    <span className="inline-flex items-center gap-1">
      <span>{formatOdds(value)}</span>
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
  const [isAmountHighlightDialogOpen, setIsAmountHighlightDialogOpen] =
    useState(false);
  const [columnWidths, setColumnWidths] = useState<BullpenTableColumnWidths>(
    readBullpenTableColumnWidthsFromStorage,
  );
  const [resizingColumnId, setResizingColumnId] =
    useState<ResizableBullpenTableColumnId | null>(null);
  const resizeStateRef = useRef<ResizeState | null>(null);
  const rows = snapshot ? sortQuestions(snapshot.questions, sortState) : [];
  const selectableRowCount = selectionEnabled ? rows.length : 0;
  const selectedVisibleCount = rows.filter((question) =>
    selectedQuestionIds.has(question.id),
  ).length;
  const allVisibleSelected =
    selectableRowCount > 0 && selectedVisibleCount === selectableRowCount;
  const tableWidth = getBullpenTableWidth(columnWidths);
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

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-200 bg-white px-4 py-3 text-left">
        <h2 className="text-sm font-semibold text-slate-950">Fresh Bullpen Opportunities</h2>
        <span className="text-xs font-medium text-slate-500">
          Updated {updatedAtLabel}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table
          className="min-w-full table-fixed divide-y divide-slate-200 text-sm"
          suppressHydrationWarning
          style={{ width: tableWidth }}
        >
          <colgroup>
            {BULLPEN_TABLE_COLUMN_IDS.map((columnId) => (
              <col key={columnId} style={{ width: columnWidths[columnId] }} />
            ))}
          </colgroup>
          <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  disabled={!selectionEnabled || rows.length === 0}
                  onChange={() => onToggleSelectAll()}
                  className="h-4 w-4 rounded border-slate-300 text-slate-950 focus:ring-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
                />
              </th>
              <ResizableColumnHeader
                columnId="question"
                label="Question"
                sortKey="question"
                sortState={sortState}
                onSortChange={onSortChange}
                isResizing={resizingColumnId === "question"}
                onResizeStart={handleResizeStart}
                onResizeStep={handleResizeStep}
                onReset={resetColumnWidth}
              />
              <ResizableColumnHeader
                columnId="closeTime"
                label="Closing time"
                sortKey="closeTime"
                sortState={sortState}
                onSortChange={onSortChange}
                isResizing={resizingColumnId === "closeTime"}
                onResizeStart={handleResizeStart}
                onResizeStep={handleResizeStep}
                onReset={resetColumnWidth}
              />
              <ResizableColumnHeader
                columnId="daysUntilClose"
                label="Days left"
                sortKey="daysUntilClose"
                sortState={sortState}
                onSortChange={onSortChange}
                isResizing={resizingColumnId === "daysUntilClose"}
                onResizeStart={handleResizeStart}
                onResizeStep={handleResizeStep}
                onReset={resetColumnWidth}
              />
              <ResizableColumnHeader
                columnId="category"
                label="Category"
                sortKey="category"
                sortState={sortState}
                onSortChange={onSortChange}
                isResizing={resizingColumnId === "category"}
                onResizeStart={handleResizeStart}
                onResizeStep={handleResizeStep}
                onReset={resetColumnWidth}
              />
              <ResizableColumnHeader
                columnId="outcomes"
                label="Outcomes"
                sortKey="outcomes"
                sortState={sortState}
                onSortChange={onSortChange}
                isResizing={resizingColumnId === "outcomes"}
                onResizeStart={handleResizeStart}
                onResizeStep={handleResizeStep}
                onReset={resetColumnWidth}
              />
              <ResizableColumnHeader
                columnId="yesOdds"
                label="Current Yes odds %"
                sortKey="yesOdds"
                sortState={sortState}
                onSortChange={onSortChange}
                isResizing={resizingColumnId === "yesOdds"}
                onResizeStart={handleResizeStart}
                onResizeStep={handleResizeStep}
                onReset={resetColumnWidth}
              />
              <ResizableColumnHeader
                columnId="noOdds"
                label="Current No odds %"
                sortKey="noOdds"
                sortState={sortState}
                onSortChange={onSortChange}
                isResizing={resizingColumnId === "noOdds"}
                onResizeStart={handleResizeStart}
                onResizeStep={handleResizeStep}
                onReset={resetColumnWidth}
              />
              <ResizableColumnHeader
                columnId="llmYesOdds"
                label="LLM Yes Odds"
                sortKey="llmYesOdds"
                sortState={sortState}
                onSortChange={onSortChange}
                isResizing={resizingColumnId === "llmYesOdds"}
                onResizeStart={handleResizeStart}
                onResizeStep={handleResizeStep}
                onReset={resetColumnWidth}
              />
              <ResizableColumnHeader
                columnId="llmNoOdds"
                label="LLM No Odds"
                sortKey="llmNoOdds"
                sortState={sortState}
                onSortChange={onSortChange}
                isResizing={resizingColumnId === "llmNoOdds"}
                onResizeStart={handleResizeStart}
                onResizeStep={handleResizeStep}
                onReset={resetColumnWidth}
              />
              <ResizableColumnHeader
                columnId="returnsPerDay"
                label="Returns/day"
                sortKey="returnsPerDay"
                sortState={sortState}
                onSortChange={onSortChange}
                isResizing={resizingColumnId === "returnsPerDay"}
                onResizeStart={handleResizeStart}
                onResizeStep={handleResizeStep}
                onReset={resetColumnWidth}
              />
              <ResizableColumnHeader
                columnId="amountToBeInvested"
                label="Amount to be invested"
                sortKey="amountToBeInvested"
                sortState={sortState}
                onSortChange={onSortChange}
                isResizing={resizingColumnId === "amountToBeInvested"}
                onResizeStart={handleResizeStart}
                onResizeStep={handleResizeStep}
                onReset={resetColumnWidth}
                afterLabel={
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
                }
              />
              <ResizableColumnHeader
                columnId="volume"
                label="Volume"
                sortKey="volume"
                sortState={sortState}
                onSortChange={onSortChange}
                isResizing={resizingColumnId === "volume"}
                onResizeStart={handleResizeStart}
                onResizeStep={handleResizeStep}
                onReset={resetColumnWidth}
              />
              <ResizableColumnHeader
                columnId="liquidity"
                label="Liquidity"
                sortKey="liquidity"
                sortState={sortState}
                onSortChange={onSortChange}
                isResizing={resizingColumnId === "liquidity"}
                onResizeStart={handleResizeStart}
                onResizeStep={handleResizeStep}
                onReset={resetColumnWidth}
              />
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
                  <td className="px-4 py-3 font-medium text-slate-900">
                    <div>{question.question}</div>
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
                        className={cn(
                          "rounded-md px-2 py-1 underline decoration-indigo-300 underline-offset-4 transition hover:text-indigo-900",
                          getLlmOddsCellClass(question.llmYesOdds),
                        )}
                      >
                        <LlmOddsDisplay question={question} value={question.llmYesOdds} />
                      </button>
                    ) : (
                      <span
                        className={cn(
                          "rounded-md px-2 py-1",
                          getLlmOddsCellClass(question.llmYesOdds),
                        )}
                      >
                        <LlmOddsDisplay question={question} value={question.llmYesOdds} />
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 font-semibold text-violet-700">
                    {question.llmBreakdown.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => setBreakdownQuestion(question)}
                        className={cn(
                          "rounded-md px-2 py-1 underline decoration-violet-300 underline-offset-4 transition hover:text-violet-900",
                          getLlmOddsCellClass(question.llmNoOdds),
                        )}
                      >
                        <LlmOddsDisplay question={question} value={question.llmNoOdds} />
                      </button>
                    ) : (
                      <span
                        className={cn(
                          "rounded-md px-2 py-1",
                          getLlmOddsCellClass(question.llmNoOdds),
                        )}
                      >
                        <LlmOddsDisplay question={question} value={question.llmNoOdds} />
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 font-semibold text-slate-700">
                    {formatReturnsPerDay(question.returnsPerDay)}
                  </td>
                  <td
                    className={cn(
                      "whitespace-nowrap px-4 py-3 text-right font-semibold text-slate-700",
                      question.isAmountToBeInvestedHighlighted
                        ? "bg-fuchsia-500 text-slate-950"
                        : "",
                    )}
                  >
                    {formatMoney(question.amountToBeInvested)}
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
                  colSpan={14}
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
      {isAmountHighlightDialogOpen ? (
        <AmountHighlightConditionsDialog
          onClose={() => setIsAmountHighlightDialogOpen(false)}
        />
      ) : null}
    </div>
  );
}

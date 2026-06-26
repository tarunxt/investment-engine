export type BullpenTableColumnId =
  | "select"
  | "question"
  | "closeTime"
  | "daysUntilClose"
  | "category"
  | "outcomes"
  | "yesOdds"
  | "noOdds"
  | "llmYesOdds"
  | "llmNoOdds"
  | "returnsPerDay"
  | "amountToBeInvested"
  | "volume"
  | "liquidity";

export type BullpenTableColumnWidths = Record<BullpenTableColumnId, number>;

export const BULLPEN_TABLE_COLUMN_IDS: BullpenTableColumnId[] = [
  "select",
  "question",
  "closeTime",
  "daysUntilClose",
  "category",
  "outcomes",
  "yesOdds",
  "noOdds",
  "llmYesOdds",
  "llmNoOdds",
  "returnsPerDay",
  "amountToBeInvested",
  "volume",
  "liquidity",
];

export const DEFAULT_BULLPEN_TABLE_COLUMN_WIDTHS: BullpenTableColumnWidths = {
  select: 56,
  question: 340,
  closeTime: 210,
  daysUntilClose: 110,
  category: 140,
  outcomes: 120,
  yesOdds: 140,
  noOdds: 140,
  llmYesOdds: 125,
  llmNoOdds: 125,
  returnsPerDay: 110,
  amountToBeInvested: 170,
  volume: 120,
  liquidity: 120,
};

const MIN_BULLPEN_TABLE_COLUMN_WIDTHS: BullpenTableColumnWidths = {
  select: 56,
  question: 220,
  closeTime: 180,
  daysUntilClose: 96,
  category: 120,
  outcomes: 100,
  yesOdds: 110,
  noOdds: 110,
  llmYesOdds: 100,
  llmNoOdds: 100,
  returnsPerDay: 100,
  amountToBeInvested: 150,
  volume: 110,
  liquidity: 110,
};

const BULLPEN_TABLE_COLUMN_WIDTHS_STORAGE_KEY =
  "investment-engine:bullpen-ai:question-table-column-widths:v1";

export function getDefaultBullpenTableColumnWidths(): BullpenTableColumnWidths {
  return { ...DEFAULT_BULLPEN_TABLE_COLUMN_WIDTHS };
}

export function clampBullpenTableColumnWidth(
  columnId: BullpenTableColumnId,
  width: number,
) {
  return Math.max(
    MIN_BULLPEN_TABLE_COLUMN_WIDTHS[columnId],
    Math.round(width),
  );
}

export function getBullpenTableWidth(widths: BullpenTableColumnWidths) {
  return BULLPEN_TABLE_COLUMN_IDS.reduce(
    (total, columnId) => total + widths[columnId],
    0,
  );
}

export function readBullpenTableColumnWidthsFromStorage() {
  const widths = getDefaultBullpenTableColumnWidths();
  if (typeof window === "undefined") return widths;

  try {
    const raw = window.localStorage.getItem(
      BULLPEN_TABLE_COLUMN_WIDTHS_STORAGE_KEY,
    );
    if (!raw) return widths;

    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return widths;

    for (const columnId of BULLPEN_TABLE_COLUMN_IDS) {
      const storedWidth = parsed[columnId];
      if (typeof storedWidth !== "number" || !Number.isFinite(storedWidth)) {
        continue;
      }
      widths[columnId] = clampBullpenTableColumnWidth(columnId, storedWidth);
    }

    return widths;
  } catch {
    return widths;
  }
}

export function writeBullpenTableColumnWidthsToStorage(
  widths: BullpenTableColumnWidths,
) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      BULLPEN_TABLE_COLUMN_WIDTHS_STORAGE_KEY,
      JSON.stringify(widths),
    );
  } catch {
    // Keep the table usable even when storage is unavailable.
  }
}

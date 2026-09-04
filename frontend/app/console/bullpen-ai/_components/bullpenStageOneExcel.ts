import type { BullpenAutoRunScanCandidateView } from "./bullpenAutoRunProgress";

export type BullpenStageOneExcelCandidate = BullpenAutoRunScanCandidateView & {
  llmYesOdds?: number | null;
  llmNoOdds?: number | null;
  returnsPerDay?: number | null;
  amountToBeInvested?: number | null;
};

const EXCEL_HEADERS = [
  "S. No.",
  "Question ID",
  "Market ID",
  "Condition ID",
  "Event",
  "Market URL",
  "Slug",
  "Deadline (IST)",
  "Deadline (ISO)",
  "Theme",
  "Current Yes Odds (%)",
  "Current No Odds (%)",
  "LLM Yes Odds (%)",
  "LLM No Odds (%)",
  "Returns/day (%)",
  "Amount to be Invested (USD)",
  "Volume (USD)",
  "Liquidity (USD)",
  "Force Included",
  "Scan Status",
  "Filter Reasons",
] as const;

const formatIstTimestamp = (value: string | null) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "Asia/Kolkata",
  }).format(date);
};

export function buildStageOneFilteredEventsExcelRows(
  candidates: BullpenStageOneExcelCandidate[],
) {
  return candidates.map((candidate, index) => ({
    "S. No.": index + 1,
    "Question ID": candidate.questionId ?? "",
    "Market ID": candidate.marketId ?? "",
    "Condition ID": candidate.conditionId ?? "",
    Event: candidate.question,
    "Market URL": candidate.marketUrl ?? "",
    Slug: candidate.slug ?? "",
    "Deadline (IST)": formatIstTimestamp(candidate.closeTime),
    "Deadline (ISO)": candidate.closeTime ?? "",
    Theme: candidate.theme ?? "",
    "Current Yes Odds (%)": candidate.currentYesOdds,
    "Current No Odds (%)": candidate.currentNoOdds,
    "LLM Yes Odds (%)": candidate.llmYesOdds ?? null,
    "LLM No Odds (%)": candidate.llmNoOdds ?? null,
    "Returns/day (%)": candidate.returnsPerDay ?? null,
    "Amount to be Invested (USD)": candidate.amountToBeInvested ?? null,
    "Volume (USD)": candidate.volumeUsd,
    "Liquidity (USD)": candidate.liquidityUsd,
    "Force Included": candidate.forceInclude ? "Yes" : "No",
    "Scan Status": candidate.scanStatus,
    "Filter Reasons": candidate.filterReasons.join(" | "),
  }));
}

function buildExportFilename(scanCompletedAt: string | null) {
  const date = scanCompletedAt ? new Date(scanCompletedAt) : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const stamp = safeDate.toISOString().replace(/[:.]/g, "-");
  return `bullpen-stage-1-filtered-events-${stamp}.xlsx`;
}

export async function downloadStageOneFilteredEventsExcel({
  candidates,
  scanCompletedAt,
}: {
  candidates: BullpenStageOneExcelCandidate[];
  scanCompletedAt: string | null;
}) {
  if (candidates.length === 0) return;

  const { default: writeXlsxFile } = await import("write-excel-file/browser");
  const rows = buildStageOneFilteredEventsExcelRows(candidates);
  const headerRow = EXCEL_HEADERS.map((value) => ({
    value,
    fontWeight: "bold" as const,
    backgroundColor: "E2F3EA",
    textColor: "14532D",
    wrap: true,
  }));
  const dataRows = rows.map((row) =>
    EXCEL_HEADERS.map((header) => ({
      value: row[header] ?? "",
      wrap: header === "Event" || header === "Filter Reasons",
      alignVertical: "top" as const,
    })),
  );
  const workbook = writeXlsxFile([headerRow, ...dataRows], {
    sheet: "Filtered Events",
    stickyRowsCount: 1,
    columns: [
      { width: 8 },
      { width: 24 },
      { width: 24 },
      { width: 32 },
      { width: 60 },
      { width: 48 },
      { width: 32 },
      { width: 24 },
      { width: 26 },
      { width: 22 },
      ...Array.from({ length: 8 }, () => ({ width: 22 })),
      { width: 16 },
      { width: 16 },
      { width: 60 },
    ],
  });
  await workbook.toFile(buildExportFilename(scanCompletedAt));
}

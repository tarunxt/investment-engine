import type { BullpenAutoRunScanCandidateView } from "./bullpenAutoRunProgress";
import { URLs } from "@/lib/urls";

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
  "Best Bid (cents)",
  "Best Ask (cents)",
  "Spread (cents)",
  "LLM Yes Odds (%)",
  "LLM No Odds (%)",
  "Returns/day (%)",
  "Amount to be Invested (USD)",
  "Volume (USD)",
  "Liquidity (USD)",
  "Force Included",
  "Force-Included Position",
  "Selected",
  "Scan Status",
  "Filter Reasons",
  "Rules",
  "Event Description",
  "Market Context",
  "Resolution Source",
  "Preflight Evidence",
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
    "Best Bid (cents)": candidate.bestBidCents,
    "Best Ask (cents)": candidate.bestAskCents,
    "Spread (cents)": candidate.spreadCents,
    "LLM Yes Odds (%)": candidate.llmYesOdds ?? null,
    "LLM No Odds (%)": candidate.llmNoOdds ?? null,
    "Returns/day (%)": candidate.returnsPerDay ?? null,
    "Amount to be Invested (USD)": candidate.amountToBeInvested ?? null,
    "Volume (USD)": candidate.volumeUsd,
    "Liquidity (USD)": candidate.liquidityUsd,
    "Force Included": candidate.forceInclude ? "Yes" : "No",
    "Force-Included Position": candidate.forceIncludedPosition ? "Yes" : "No",
    Selected:
      candidate.selected === null || candidate.selected === undefined
        ? ""
        : candidate.selected
          ? "Yes"
          : "No",
    "Scan Status": candidate.scanStatus,
    "Filter Reasons": candidate.filterReasons.join(" | "),
    Rules: candidate.rules ?? "",
    "Event Description": candidate.eventDescription ?? "",
    "Market Context": candidate.marketContext ?? "",
    "Resolution Source": candidate.resolutionSource ?? "",
    "Preflight Evidence": candidate.preflightEvidenceBlock ?? "",
  }));
}

function buildExportFilename(
  scanCompletedAt: string | null,
  exportScope: "filtered" | "all-scanned",
) {
  const date = scanCompletedAt ? new Date(scanCompletedAt) : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const stamp = safeDate.toISOString().replace(/[:.]/g, "-");
  return `bullpen-stage-1-${exportScope}-events-${stamp}.xlsx`;
}

async function downloadStageOneEventsExcel({
  candidates,
  scanCompletedAt,
  exportScope,
}: {
  candidates: BullpenStageOneExcelCandidate[];
  scanCompletedAt: string | null;
  exportScope: "filtered" | "all-scanned";
}) {
  if (candidates.length === 0) return;

  const { default: writeXlsxFile } = await import("write-excel-file/browser");
  const rows = buildStageOneFilteredEventsExcelRows(candidates);
  const headerRow = EXCEL_HEADERS.map((value) => ({
    value,
    fontWeight: "bold" as const,
    backgroundColor: "#E2F3EA",
    textColor: "#14532D",
    wrap: true,
  }));
  const dataRows = rows.map((row) =>
    EXCEL_HEADERS.map((header) => ({
      value: row[header] ?? "",
      wrap:
        header === "Event" ||
        header === "Filter Reasons" ||
        header === "Rules" ||
        header === "Event Description" ||
        header === "Market Context" ||
        header === "Preflight Evidence",
      alignVertical: "top" as const,
    })),
  );
  const workbook = writeXlsxFile([headerRow, ...dataRows], {
    sheet:
      exportScope === "all-scanned" ? "All Scanned Events" : "Filtered Events",
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
      ...Array.from({ length: 11 }, () => ({ width: 22 })),
      { width: 16 },
      { width: 16 },
      { width: 22 },
      { width: 16 },
      { width: 60 },
      { width: 72 },
      { width: 72 },
      { width: 60 },
      { width: 48 },
      { width: 72 },
    ],
  });
  await workbook.toFile(buildExportFilename(scanCompletedAt, exportScope));
}

export async function downloadStageOneFilteredEventsExcel({
  candidates,
  scanCompletedAt,
}: {
  candidates: BullpenStageOneExcelCandidate[];
  scanCompletedAt: string | null;
}) {
  return downloadStageOneEventsExcel({
    candidates,
    scanCompletedAt,
    exportScope: "filtered",
  });
}

export async function downloadStageOneAllScannedEventsExcel({
  candidates,
  scanCompletedAt,
}: {
  candidates: BullpenStageOneExcelCandidate[];
  scanCompletedAt: string | null;
}) {
  return downloadStageOneEventsExcel({
    candidates,
    scanCompletedAt,
    exportScope: "all-scanned",
  });
}

export function downloadCompleteStageOneRunExcel(runId: string) {
  const link = document.createElement("a");
  link.href = URLs.bullpenAutoLive.runStageOneExcel(runId);
  link.download = "bullpen-stage-1-all-scanned-events.xlsx";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export function downloadIndependentStageOneExcel(
  exportId: string,
  exportScope: "filtered" | "all-scanned" = "all-scanned",
) {
  const link = document.createElement("a");
  const params = new URLSearchParams({ exportId, scope: exportScope });
  link.href = `/api/bullpen-ai/stage-one.xlsx?${params.toString()}`;
  link.download = `bullpen-stage-1-${exportScope}-events.xlsx`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

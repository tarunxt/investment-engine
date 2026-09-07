import exhaustiveHeaders from "@/lib/bullpenStageOneExcelColumns.json";
import type { BullpenAutoRunScanCandidateView } from "./bullpenAutoRunProgress";
import { URLs } from "@/lib/urls";

export type BullpenStageOneExcelCandidate = BullpenAutoRunScanCandidateView & {
  llmYesOdds?: number | null;
  llmNoOdds?: number | null;
  returnsPerDay?: number | null;
  amountToBeInvested?: number | null;
};

const BASE_HEADERS = [
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

const EXCEL_HEADERS = [...BASE_HEADERS, ...exhaustiveHeaders.slice(BASE_HEADERS.length)];

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
      value: (() => { const value = (row as Record<string, string | number | null>)[header]; return value === null || value === undefined || value === "" ? "N/A" : value; })(),
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
      ...EXCEL_HEADERS.slice(BASE_HEADERS.length).map(() => ({ width: 24 })),
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

const pendingExports = new Set<string>();

export async function downloadCompleteStageOneRunExcel(runId: string, scope: "filtered" | "all-scanned" = "all-scanned") {
  const fileUrl = URLs.bullpenAutoLive.runStageOneExcel(runId);
  const jobUrl = fileUrl.replace(/stage-one\.xlsx$/, "stage-one-export") + `?scope=${scope}`;
  if (pendingExports.has(jobUrl)) return;
  pendingExports.add(jobUrl);
  const notice = document.createElement("div");
  notice.setAttribute("role", "status");
  notice.style.cssText = "position:fixed;bottom:24px;right:24px;z-index:9999;max-width:420px;padding:16px;border:1px solid #f59e0b;border-radius:12px;background:#fffbeb;color:#78350f;box-shadow:0 4px 12px #0002";
  notice.textContent = "Preparing Excel. You can continue using this page.";
  document.body.appendChild(notice);
  try {
    const started = Date.now();
    let method = "POST";
    while (Date.now() - started < 35 * 60 * 1000) {
      const response = await fetch(jobUrl, { method, credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error(`Excel preparation request failed (${response.status}). Please try again.`);
      const state = await response.json();
      if (state.status === "failed") throw new Error(state.message);
      if (state.status === "ready") {
        const link = document.createElement("a");
        link.href = `${fileUrl}?scope=${scope}&prepared=true`;
        link.download = state.filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        notice.textContent = "Excel is ready. Download started.";
        window.setTimeout(() => notice.remove(), 10000);
        return;
      }
      notice.textContent = `${state.message || "Preparing Excel"}. Keep this tab open; download starts when ready.`;
      method = "GET";
      await new Promise(resolve => window.setTimeout(resolve, 3000));
    }
    throw new Error("Excel is still preparing. Click the download icon again to check its status.");
  } catch (error) {
    notice.textContent = error instanceof Error ? error.message : "Excel preparation failed. Please try again.";
    const dismiss = document.createElement("button");
    dismiss.textContent = " Dismiss";
    dismiss.onclick = () => notice.remove();
    notice.appendChild(dismiss);
  } finally {
    pendingExports.delete(jobUrl);
  }
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

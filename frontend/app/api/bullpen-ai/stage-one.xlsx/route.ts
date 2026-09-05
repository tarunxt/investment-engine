import { NextRequest, NextResponse } from "next/server";
import writeXlsxFile from "write-excel-file/node";

import { createBackendSessionContext } from "../_lib/serverBackendSession";
import {
  readStageOneGammaExport,
  type StageOneGammaExportRow,
} from "../_lib/stageOneGammaExport";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const LEGACY_HEADERS = [
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

function formatIstTimestamp(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "Asia/Kolkata",
  }).format(date);
}

function readNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value.replace(/[%x,$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function readCents(value: unknown) {
  const parsed = readNumber(value);
  if (parsed === null) return null;
  return Math.abs(parsed) <= 1 ? Number((parsed * 100).toFixed(4)) : parsed;
}

function safeCellValue(value: unknown): string | number | boolean {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? value : "";
  if (typeof value === "boolean") return value;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const truncated = text.length > 32_767 ? `${text.slice(0, 32_748)}…[truncated]` : text;
  return /^[=+\-@]/.test(truncated) ? `'${truncated}` : truncated;
}

function rawHeaders(rows: StageOneGammaExportRow[]) {
  const eventKeys = new Set<string>();
  const marketKeys = new Set<string>();
  for (const row of rows) {
    Object.keys(row.event).forEach((key) => eventKeys.add(key));
    Object.keys(row.market).forEach((key) => marketKeys.add(key));
  }
  return [
    ...Array.from(eventKeys).sort().map((key) => `event.${key}`),
    ...Array.from(marketKeys).sort().map((key) => `market.${key}`),
  ];
}

function buildLegacyValues(row: StageOneGammaExportRow, index: number) {
  const candidate = row.candidate;
  return [
    index + 1,
    candidate.questionId ?? candidate.id,
    candidate.marketId ?? row.market.id ?? candidate.id,
    candidate.conditionId ?? row.market.conditionId ?? "",
    candidate.question,
    candidate.marketUrl ?? "",
    candidate.slug ?? "",
    formatIstTimestamp(candidate.closeTime),
    candidate.closeTime ?? "",
    candidate.category,
    candidate.yesOdds,
    candidate.noOdds,
    readCents(row.market.bestBid),
    readCents(row.market.bestAsk),
    readCents(row.market.spread),
    "",
    "",
    "",
    "",
    readNumber(candidate.volume),
    readNumber(candidate.liquidity),
    "No",
    "No",
    "",
    row.scanStatus,
    row.filterReasons.join(" | "),
    candidate.rules ?? row.market.description ?? "",
    row.event.description ?? "",
    candidate.marketContext ?? "",
    candidate.resolutionSource ?? row.event.resolutionSource ?? "",
    "",
  ];
}

export async function GET(request: NextRequest) {
  const session = await createBackendSessionContext(request);
  if (!session.hasAuthJsSession || !session.accessToken) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const exportId = request.nextUrl.searchParams.get("exportId")?.trim();
  if (!exportId) {
    return NextResponse.json(
      { error: "Missing Stage 1 export identifier." },
      { status: 400 },
    );
  }

  try {
    const { metadata, rows } = await readStageOneGammaExport({
      exportId,
      ownerKey: session.sessionSubject ?? session.sessionGeneration,
    });
    if (rows.length !== metadata.rowCount) {
      throw new Error(
        `Stage 1 export row count mismatch (${rows.length}/${metadata.rowCount}).`,
      );
    }
    if (rows.length === 0) {
      return NextResponse.json(
        { error: "This Stage 1 scan has no retained rows." },
        { status: 409 },
      );
    }

    const gammaHeaders = rawHeaders(rows);
    const headers = [...LEGACY_HEADERS, ...gammaHeaders];
    const headerRow = headers.map((value) => ({
      value,
      fontWeight: "bold" as const,
      backgroundColor: "#E2F3EA",
      textColor: "#14532D",
      wrap: true,
    }));
    const dataRows = rows.map((row, index) => {
      const legacyValues = buildLegacyValues(row, index);
      const gammaValues = gammaHeaders.map((header) => {
        const [scope, ...keyParts] = header.split(".");
        const key = keyParts.join(".");
        return safeCellValue(scope === "event" ? row.event[key] : row.market[key]);
      });
      return [...legacyValues, ...gammaValues].map((value) => ({
        value: safeCellValue(value),
        alignVertical: "top" as const,
        wrap: true,
      }));
    });
    const workbook = writeXlsxFile([headerRow, ...dataRows], {
      sheet: "All Scanned Events",
      stickyRowsCount: 1,
      columns: headers.map((header) => ({
        width:
          header === "Event" || header.endsWith(".description")
            ? 60
            : header.includes("URL") || header.endsWith(".url")
              ? 48
              : 22,
      })),
    });
    const buffer = await workbook.toBuffer();
    const stamp = metadata.createdAt.replace(/[:.]/g, "-");
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "content-type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="bullpen-stage-1-all-scanned-events-${stamp}.xlsx"`,
        "cache-control": "no-store",
        "x-bullpen-export-rows": String(rows.length),
        "x-bullpen-export-columns": String(headers.length),
      },
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Stage 1 Excel export failed.";
    const status = /ENOENT/.test(message) ? 410 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

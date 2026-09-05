import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import { strToU8, Zip, ZipDeflate, ZipPassThrough } from "fflate";
import { NextRequest, NextResponse } from "next/server";

import { createBackendSessionContext } from "../_lib/serverBackendSession";
import {
  openStageOneGammaExport,
  type StageOneGammaExportRow,
} from "../_lib/stageOneGammaExport";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const LEGACY_HEADERS = [
  "S. No.", "Question ID", "Market ID", "Condition ID", "Event", "Market URL",
  "Slug", "Deadline (IST)", "Deadline (ISO)", "Theme", "Current Yes Odds (%)",
  "Current No Odds (%)", "Best Bid (cents)", "Best Ask (cents)", "Spread (cents)",
  "LLM Yes Odds (%)", "LLM No Odds (%)", "Returns/day (%)",
  "Amount to be Invested (USD)", "Volume (USD)", "Liquidity (USD)",
  "Force Included", "Force-Included Position", "Selected", "Scan Status",
  "Filter Reasons", "Rules", "Event Description", "Market Context",
  "Resolution Source", "Preflight Evidence",
] as const;

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

function formatIst(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium", timeStyle: "medium", timeZone: "Asia/Kolkata",
  }).format(date);
}

function safeValue(value: unknown): string | number | boolean {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? value : "";
  if (typeof value === "boolean") return value;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const trimmed = text.length > 32_767 ? `${text.slice(0, 32_748)}…[truncated]` : text;
  return /^[=+\-@]/.test(trimmed) ? `'${trimmed}` : trimmed;
}

async function forEachRow(
  path: string,
  visitor: (row: StageOneGammaExportRow, index: number) => void | Promise<void>,
) {
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let index = 0;
  for await (const line of lines) {
    if (!line) continue;
    await visitor(JSON.parse(line) as StageOneGammaExportRow, index++);
  }
  return index;
}

async function discoverHeaders(path: string) {
  const eventKeys = new Set<string>();
  const marketKeys = new Set<string>();
  const rowCount = await forEachRow(path, (row) => {
    Object.keys(row.event).forEach((key) => eventKeys.add(key));
    Object.keys(row.market).forEach((key) => marketKeys.add(key));
  });
  return {
    rowCount,
    gammaHeaders: [
      ...Array.from(eventKeys).sort().map((key) => `event.${key}`),
      ...Array.from(marketKeys).sort().map((key) => `market.${key}`),
    ],
  };
}

function legacyValues(row: StageOneGammaExportRow, index: number) {
  const candidate = row.candidate;
  return [
    index + 1, candidate.questionId ?? candidate.id,
    candidate.marketId ?? row.market.id ?? candidate.id,
    candidate.conditionId ?? row.market.conditionId ?? "", candidate.question,
    candidate.marketUrl ?? "", candidate.slug ?? "", formatIst(candidate.closeTime),
    candidate.closeTime ?? "", candidate.category, candidate.yesOdds, candidate.noOdds,
    readCents(row.market.bestBid), readCents(row.market.bestAsk), readCents(row.market.spread),
    "", "", "", "", readNumber(candidate.volume), readNumber(candidate.liquidity),
    "No", "No", "", row.scanStatus, row.filterReasons.join(" | "),
    candidate.rules ?? row.market.description ?? "", row.event.description ?? "",
    candidate.marketContext ?? "", candidate.resolutionSource ?? row.event.resolutionSource ?? "", "",
  ];
}

function xml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function columnName(index: number) {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function cell(value: unknown, column: number, row: number, style = 0) {
  const safe = safeValue(value);
  const ref = `${columnName(column)}${row}`;
  const styleAttribute = style ? ` s="${style}"` : "";
  if (typeof safe === "number") return `<c r="${ref}"${styleAttribute}><v>${safe}</v></c>`;
  if (typeof safe === "boolean") return `<c r="${ref}"${styleAttribute} t="b"><v>${safe ? 1 : 0}</v></c>`;
  return `<c r="${ref}"${styleAttribute} t="inlineStr"><is><t xml:space="preserve">${xml(safe)}</t></is></c>`;
}

function addText(zip: Zip, name: string, content: string) {
  const entry = new ZipPassThrough(name);
  zip.add(entry);
  entry.push(strToU8(content), true);
}

function buildWorkbookStream(path: string, expectedRows: number) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let finished = false;
      const fail = (error: unknown) => {
        if (!finished) {
          finished = true;
          controller.error(error);
        }
      };
      const zip = new Zip((error, data, final) => {
        if (error) return fail(error);
        if (finished) return;
        controller.enqueue(data);
        if (final) {
          finished = true;
          controller.close();
        }
      });
      addText(zip, "[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>');
      addText(zip, "_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
      addText(zip, "xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="All Scanned Events" sheetId="1" r:id="rId1"/></sheets></workbook>');
      addText(zip, "xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
      addText(zip, "xl/styles.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font/><font><b/><color rgb="FF14532D"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE2F3EA"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs></styleSheet>');

      void (async () => {
        const discovered = await discoverHeaders(path);
        if (discovered.rowCount !== expectedRows) throw new Error(`Stage 1 export row count mismatch (${discovered.rowCount}/${expectedRows}).`);
        const gammaHeaders = discovered.gammaHeaders;
        const headers = [...LEGACY_HEADERS, ...gammaHeaders];
        const sheet = new ZipDeflate("xl/worksheets/sheet1.xml", { level: 1 });
        zip.add(sheet);
        const lastColumn = columnName(headers.length - 1);
        const widths = headers.map((header, index) => {
          const width = header === "Event" || header.endsWith(".description") ? 60 : header.includes("URL") || header.endsWith(".url") ? 48 : 22;
          return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
        }).join("");
        const headerCells = headers.map((value, index) => cell(value, index, 1, 1)).join("");
        sheet.push(strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${lastColumn}${expectedRows + 1}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths}</cols><sheetData><row r="1">${headerCells}</row>`), false);
        const written = await forEachRow(path, (row, index) => {
          const gammaValues = headers.slice(LEGACY_HEADERS.length).map((header) => {
            const separator = header.indexOf(".");
            const scope = header.slice(0, separator);
            const key = header.slice(separator + 1);
            return scope === "event" ? row.event[key] : row.market[key];
          });
          const values = [...legacyValues(row, index), ...gammaValues];
          const rowNumber = index + 2;
          sheet.push(strToU8(`<row r="${rowNumber}">${values.map((value, column) => cell(value, column, rowNumber)).join("")}</row>`), false);
        });
        if (written !== expectedRows) throw new Error(`Stage 1 export row count changed (${written}/${expectedRows}).`);
        sheet.push(strToU8(`</sheetData><autoFilter ref="A1:${lastColumn}${expectedRows + 1}"/></worksheet>`), true);
        zip.end();
      })().catch(fail);
    },
  });
}

export async function GET(request: NextRequest) {
  const session = await createBackendSessionContext(request);
  if (!session.hasAuthJsSession || !session.accessToken) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const exportId = request.nextUrl.searchParams.get("exportId")?.trim();
  if (!exportId) return NextResponse.json({ error: "Missing Stage 1 export identifier." }, { status: 400 });
  try {
    const { metadata, rowsPath } = await openStageOneGammaExport({ exportId, ownerKey: session.sessionSubject ?? session.sessionGeneration });
    if (!metadata.rowCount) return NextResponse.json({ error: "This Stage 1 scan has no retained rows." }, { status: 409 });
    const stamp = metadata.createdAt.replace(/[:.]/g, "-");
    return new NextResponse(buildWorkbookStream(rowsPath, metadata.rowCount), {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="bullpen-stage-1-all-scanned-events-${stamp}.xlsx"`,
        "cache-control": "no-store",
        "x-bullpen-export-rows": String(metadata.rowCount),
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Stage 1 Excel export failed.";
    return NextResponse.json({ error: message }, { status: /ENOENT/.test(message) ? 410 : 500 });
  }
}

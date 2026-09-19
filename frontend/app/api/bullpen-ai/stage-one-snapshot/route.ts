import { createReadStream } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname } from "node:path";

import { NextRequest, NextResponse } from "next/server";

import {
  createBullpenScanFilters,
  createBullpenScanSnapshot,
  type BullpenQuestion,
} from "@/lib/bullpen-ai";

import {
  createBackendSessionContext,
  fetchBackendJsonWithSession,
} from "../_lib/serverBackendSession";
import {
  cacheStageOneGammaExportSummary,
  cacheUniversalScanSummary,
  openLatestStageOneGammaExport,
  openStageOneGammaExport,
  openUniversalScan,
  parseStageOneGammaExportRow,
  type StageOneGammaExportMetadata,
} from "../_lib/stageOneGammaExport";
import {
  createUniversalScanSummaryAccumulator,
  type UniversalScanSummaryCheckpoint,
} from "../_lib/universalScanSummary";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_ROWS_PER_STATUS = 500;
const UNIVERSAL_SUMMARY_CHUNK_ROWS = 10_000;

type UniversalSummaryBuildState = {
  version: 1;
  exportId: string;
  exportUpdatedAt: string;
  byteOffset: number;
  processedRows: number;
  checkpoint: UniversalScanSummaryCheckpoint;
};

export async function GET(request: NextRequest) {
  const session = await createBackendSessionContext(request);
  if (!session.hasAuthJsSession || !session.accessToken) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  try {
    const isUniversal = request.nextUrl.searchParams.get("universal") === "true";
    const sessionOwner = session.sessionSubject ?? session.sessionGeneration;
    const workspaceProfile =
      request.nextUrl.searchParams.get("workspaceProfile") === "bullpen-sports"
        ? "bullpen-sports"
        : "bullpen007";
    const ownerKey = isUniversal
      ? `${sessionOwner}:universal`
      : workspaceProfile === "bullpen007"
        ? sessionOwner
        : `${sessionOwner}:${workspaceProfile}`;
    let latest = isUniversal
      ? await openUniversalScan(sessionOwner)
      : await openLatestStageOneGammaExport({
      ownerKey,
    });
    if (isUniversal && !latest) {
      const remote = await fetchBackendJsonWithSession<{
        export?: {
          metadata: StageOneGammaExportMetadata;
          rows_path: string;
          filtered_rows_path: string;
        } | null;
      }>(session, "/trading-bots/universal-scan/export-reference").catch(() => null);
      if (remote?.export) {
        latest = {
          metadata: remote.export.metadata,
          rowsPath: remote.export.rows_path,
          filteredRowsPath: remote.export.filtered_rows_path,
        };
      }
    }
    if (!latest) {
      return NextResponse.json(
        { snapshot: null },
        { headers: { "cache-control": "no-store" } },
      );
    }

    let sourceScanCompletedAt = latest.metadata.sourceScanCompletedAt ?? null;
    if (
      !isUniversal &&
      !sourceScanCompletedAt &&
      latest.metadata.sourceScanExportId
    ) {
      const source = await openStageOneGammaExport({
        exportId: latest.metadata.sourceScanExportId,
        ownerKey: `${sessionOwner}:universal`,
      }).catch(() => null);
      sourceScanCompletedAt = source?.metadata.updatedAt ?? null;
    }
    if (!isUniversal && !sourceScanCompletedAt) {
      const source = await openUniversalScan(sessionOwner).catch(() => null);
      sourceScanCompletedAt = source?.metadata.updatedAt ?? null;
    }

    const hasCachedSummary =
      typeof latest.metadata.acceptedCount === "number" &&
      typeof latest.metadata.rejectedCount === "number" &&
      Array.isArray(latest.metadata.acceptedSample) &&
      Array.isArray(latest.metadata.rejectedSample);
    let accepted: BullpenQuestion[] = latest.metadata.acceptedSample ?? [];
    let rejected: Array<BullpenQuestion & { filterReasons: string[] }> =
      latest.metadata.rejectedSample ?? [];
    let acceptedCount = latest.metadata.acceptedCount ?? 0;
    let rejectedCount = latest.metadata.rejectedCount ?? 0;
    if (!hasCachedSummary) {
      accepted = [];
      rejected = [];
      acceptedCount = 0;
      rejectedCount = 0;
      const lines = createInterface({
        input: createReadStream(latest.rowsPath, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      for await (const line of lines) {
        if (!line) continue;
        const row = parseStageOneGammaExportRow(line);
        if (row.scanStatus === "passed") {
          acceptedCount += 1;
          if (accepted.length < MAX_ROWS_PER_STATUS) accepted.push(row.candidate);
        } else {
          rejectedCount += 1;
          if (rejected.length < MAX_ROWS_PER_STATUS) {
            rejected.push({ ...row.candidate, filterReasons: row.filterReasons });
          }
        }
      }
      await cacheStageOneGammaExportSummary({
        metadata: latest.metadata,
        ownerKey,
        acceptedCount,
        rejectedCount,
        acceptedSample: accepted,
        rejectedSample: rejected,
      }).catch(() => undefined);
    }

    let universalSummary = isUniversal ? latest.metadata.universalSummary : undefined;
    let universalSummaryProgress: { processedRows: number; totalRows: number } | null = null;
    if (isUniversal && (!universalSummary || universalSummary.totalEvents !== latest.metadata.rowCount)) {
      const progressPath = `${latest.rowsPath}.summary-progress.json`;
      let buildState: UniversalSummaryBuildState | null = null;
      try {
        const saved = JSON.parse(await readFile(progressPath, "utf8")) as UniversalSummaryBuildState;
        if (
          saved.version === 1 &&
          saved.exportId === latest.metadata.exportId &&
          saved.exportUpdatedAt === latest.metadata.updatedAt &&
          Number.isSafeInteger(saved.byteOffset) &&
          saved.byteOffset >= 0 &&
          Number.isSafeInteger(saved.processedRows) &&
          saved.processedRows >= 0 &&
          saved.checkpoint?.version === 1
        ) {
          buildState = saved;
        }
      } catch {
        buildState = null;
      }
      const initialCheckpoint: UniversalScanSummaryCheckpoint = {
        version: 1,
        totalEvents: 0,
        counters: {
          category: {},
          expiry: {},
          odds: {},
          volume: {},
          liquidity: {},
          structure: {},
        },
      };
      buildState ??= {
        version: 1,
        exportId: latest.metadata.exportId,
        exportUpdatedAt: latest.metadata.updatedAt,
        byteOffset: 0,
        processedRows: 0,
        checkpoint: initialCheckpoint,
      };
      const summary = createUniversalScanSummaryAccumulator({
        startedAt: latest.metadata.scannedAt ?? latest.metadata.createdAt,
        completedAt: latest.metadata.updatedAt,
        checkpoint: buildState.checkpoint,
      });
      const input = createReadStream(latest.rowsPath, {
        encoding: "utf8",
        start: buildState.byteOffset,
      });
      const lines = createInterface({ input, crlfDelay: Infinity });
      let chunkRows = 0;
      let reachedEnd = true;
      for await (const line of lines) {
        if (!line) continue;
        summary.add(parseStageOneGammaExportRow(line).candidate);
        buildState.byteOffset += Buffer.byteLength(`${line}\n`, "utf8");
        buildState.processedRows += 1;
        chunkRows += 1;
        if (chunkRows >= UNIVERSAL_SUMMARY_CHUNK_ROWS) {
          reachedEnd = false;
          lines.close();
          input.destroy();
          break;
        }
      }
      buildState.checkpoint = summary.checkpoint();
      if (reachedEnd || buildState.processedRows >= latest.metadata.rowCount) {
        universalSummary = summary.finish();
        await cacheUniversalScanSummary({
          metadata: latest.metadata,
          ownerKey,
          summary: universalSummary,
          directory: dirname(latest.rowsPath),
        });
        await rm(progressPath, { force: true }).catch(() => undefined);
      } else {
        await writeFile(progressPath, JSON.stringify(buildState), "utf8");
        universalSummaryProgress = {
          processedRows: buildState.processedRows,
          totalRows: latest.metadata.rowCount,
        };
      }
    }

    const mode = latest.metadata.mode ?? "30-days";
    const scannedAt = latest.metadata.scannedAt ?? latest.metadata.createdAt;
    const snapshot = createBullpenScanSnapshot(
      {
        mode,
        sourceUrl:
          latest.metadata.sourceUrl ??
          "https://gamma-api.polymarket.com/events/keyset",
        sourceLabel:
          latest.metadata.sourceLabel ?? "All open Polymarket Gamma markets",
        scannedAt,
        filters: latest.metadata.filters ?? createBullpenScanFilters(mode),
        totalCandidates: latest.metadata.rowCount,
        questions: accepted,
        rejectedQuestions: rejected,
        pagesScanned: latest.metadata.processedPages.length,
        totalAcceptedQuestions: acceptedCount,
        totalRejectedQuestions: rejectedCount,
        scanExportId: latest.metadata.exportId,
        sourceScanExportId: latest.metadata.sourceScanExportId,
        sourceScanCompletedAt: isUniversal
          ? latest.metadata.updatedAt
          : sourceScanCompletedAt,
        filtersCompletedAt: isUniversal
          ? null
          : latest.metadata.filtersCompletedAt ?? latest.metadata.updatedAt,
        details:
          "Latest completed Stage 1 snapshot synchronized from the server across devices.",
      },
      `bullpen-server-${latest.metadata.exportId}`,
    );
    return NextResponse.json(
      { snapshot, universalSummary, universalSummaryProgress },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Latest Stage 1 snapshot could not be loaded.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

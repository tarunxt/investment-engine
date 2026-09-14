import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import { NextRequest, NextResponse } from "next/server";

import {
  createBullpenScanFilters,
  createBullpenScanSnapshot,
  type BullpenQuestion,
} from "@/lib/bullpen-ai";

import { createBackendSessionContext } from "../_lib/serverBackendSession";
import {
  cacheStageOneGammaExportSummary,
  cacheUniversalScanSummary,
  openLatestStageOneGammaExport,
  openUniversalScan,
  parseStageOneGammaExportRow,
} from "../_lib/stageOneGammaExport";
import { createUniversalScanSummaryAccumulator } from "../_lib/universalScanSummary";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_ROWS_PER_STATUS = 500;

export async function GET(request: NextRequest) {
  const session = await createBackendSessionContext(request);
  if (!session.hasAuthJsSession || !session.accessToken) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  try {
    const isUniversal = request.nextUrl.searchParams.get("universal") === "true";
    const ownerKey = (session.sessionSubject ?? session.sessionGeneration) + (isUniversal ? ":universal" : "");
    const latest = isUniversal
      ? await openUniversalScan(session.sessionSubject ?? session.sessionGeneration)
      : await openLatestStageOneGammaExport({
      ownerKey,
    });
    if (!latest) {
      return NextResponse.json(
        { snapshot: null },
        { headers: { "cache-control": "no-store" } },
      );
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
    if (isUniversal && (!universalSummary || universalSummary.totalEvents !== latest.metadata.rowCount)) {
      const summary = createUniversalScanSummaryAccumulator({
        startedAt: latest.metadata.scannedAt ?? latest.metadata.createdAt,
        completedAt: latest.metadata.updatedAt,
      });
      const lines = createInterface({ input: createReadStream(latest.rowsPath, { encoding: "utf8" }), crlfDelay: Infinity });
      for await (const line of lines) {
        if (line) summary.add(parseStageOneGammaExportRow(line).candidate);
      }
      universalSummary = summary.finish();
      await cacheUniversalScanSummary({ metadata: latest.metadata, ownerKey, summary: universalSummary }).catch(() => undefined);
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
        details:
          "Latest completed Stage 1 snapshot synchronized from the server across devices.",
      },
      `bullpen-server-${latest.metadata.exportId}`,
    );
    return NextResponse.json(
      { snapshot, universalSummary },
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

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type {
  BullpenQuestion,
  BullpenScanFilters,
  ScanMode,
} from "@/lib/bullpen-ai";

const EXPORT_DIRECTORY = join(tmpdir(), "credx-bullpen-stage-one-exports");
const EXPORT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const ORPHAN_EXPORT_GRACE_MS = 2 * 60 * 1_000;
const EXPORT_ID_PATTERN = /^[0-9a-f-]{36}$/;
const EXPORT_FILE_PATTERN = /^([0-9a-f-]{36})\.(json|jsonl|filtered\.jsonl)$/;

export type StageOneGammaExportRow = {
  candidate: BullpenQuestion;
  event: Record<string, unknown>;
  market: Record<string, unknown>;
  scanStatus: "passed" | "filtered";
  filterReasons: string[];
  forceIncluded?: boolean;
  forceIncludedPosition?: boolean;
};

export type StageOneGammaExportMetadata = {
  exportId: string;
  ownerHash: string;
  createdAt: string;
  updatedAt: string;
  rowCount: number;
  completed: boolean;
  processedPages: string[];
  eventKeys?: string[];
  marketKeys?: string[];
  identityKeys?: string[];
  mode?: ScanMode;
  filters?: BullpenScanFilters;
  sourceUrl?: string;
  sourceLabel?: string;
  scannedAt?: string;
  acceptedCount?: number;
  rejectedCount?: number;
  acceptedSample?: BullpenQuestion[];
  rejectedSample?: Array<BullpenQuestion & { filterReasons: string[] }>;
  reapplyState?: {
    filterHash: string;
    byteOffset: number;
    processedCount: number;
    acceptedCount: number;
    rejectedCount: number;
    acceptedSample: BullpenQuestion[];
    rejectedSample: Array<BullpenQuestion & { filterReasons: string[] }>;
  };
};

function assertExportId(exportId: string) {
  if (!EXPORT_ID_PATTERN.test(exportId)) {
    throw new Error("Invalid Stage 1 export identifier.");
  }
}

function exportPaths(exportId: string) {
  assertExportId(exportId);
  return {
    rows: join(EXPORT_DIRECTORY, `${exportId}.jsonl`),
    filteredRows: join(EXPORT_DIRECTORY, `${exportId}.filtered.jsonl`),
    metadata: join(EXPORT_DIRECTORY, `${exportId}.json`),
  };
}

function ownerHash(ownerKey: string) {
  return createHash("sha256").update(ownerKey).digest("hex");
}

async function cleanupExpiredExports() {
  await mkdir(EXPORT_DIRECTORY, { recursive: true });
  const now = Date.now();
  const names = await readdir(EXPORT_DIRECTORY).catch(() => [] as string[]);
  const nameSet = new Set(names);
  await Promise.all(
    names.map(async (name) => {
      const path = join(EXPORT_DIRECTORY, name);
      const details = await stat(path).catch(() => null);
      const match = name.match(EXPORT_FILE_PATTERN);
      const counterpart = match
        ? `${match[1]}.${match[2] === "json" ? "jsonl" : "json"}`
        : null;
      const isExpired = Boolean(
        details && now - details.mtimeMs > EXPORT_RETENTION_MS,
      );
      const isAbandonedOrphan = Boolean(
        details &&
          counterpart &&
          !nameSet.has(counterpart) &&
          now - details.mtimeMs > ORPHAN_EXPORT_GRACE_MS,
      );
      if (isExpired || isAbandonedOrphan) {
        await rm(path, { force: true });
      }
    }),
  );
}

async function removeExport(exportId: string) {
  const paths = exportPaths(exportId);
  await Promise.all([
    rm(paths.rows, { force: true }),
    rm(paths.filteredRows, { force: true }),
    rm(paths.metadata, { force: true }),
  ]);
}

async function cleanupSupersededOwnerExports(ownerKey: string) {
  const expectedOwnerHash = ownerHash(ownerKey);
  const names = await readdir(EXPORT_DIRECTORY).catch(() => [] as string[]);
  await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        const exportId = name.slice(0, -".json".length);
        if (!EXPORT_ID_PATTERN.test(exportId)) return;
        const metadata = await readMetadata(exportId).catch(() => null);
        if (metadata?.ownerHash === expectedOwnerHash) {
          await removeExport(exportId);
        }
      }),
  );
}

async function readMetadata(exportId: string) {
  const { metadata } = exportPaths(exportId);
  const raw = await readFile(metadata, "utf8");
  return JSON.parse(raw) as StageOneGammaExportMetadata;
}

async function saveMetadata(metadata: StageOneGammaExportMetadata) {
  const paths = exportPaths(metadata.exportId);
  await writeFile(paths.metadata, JSON.stringify(metadata), "utf8");
}

export async function appendStageOneGammaExportPage({
  exportId,
  ownerKey,
  pageKey,
  rows,
  completed,
  snapshot,
}: {
  exportId: string | null;
  ownerKey: string;
  pageKey: string;
  rows: StageOneGammaExportRow[];
  completed: boolean;
  snapshot?: {
    mode: ScanMode;
    filters: BullpenScanFilters;
    sourceUrl: string;
    sourceLabel: string;
    scannedAt: string;
  };
}) {
  await cleanupExpiredExports();
  const resolvedExportId = exportId || randomUUID();
  const paths = exportPaths(resolvedExportId);
  let metadata: StageOneGammaExportMetadata;

  if (exportId) {
    metadata = await readMetadata(resolvedExportId);
    if (metadata.ownerHash !== ownerHash(ownerKey)) {
      throw new Error("Stage 1 export does not belong to this session.");
    }
  } else {
    // Only the latest exhaustive scan is selectable in the console. Retaining
    // every superseded raw Gamma ledger can consume several gigabytes and
    // eventually makes the next scan fail with EDQUOT (-122).
    await cleanupSupersededOwnerExports(ownerKey);
    metadata = {
      exportId: resolvedExportId,
      ownerHash: ownerHash(ownerKey),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      rowCount: 0,
      completed: false,
      processedPages: [],
      eventKeys: [],
      marketKeys: [],
      identityKeys: [],
      ...snapshot,
      acceptedCount: 0,
      rejectedCount: 0,
      acceptedSample: [],
      rejectedSample: [],
    };
    await writeFile(paths.rows, "", "utf8");
    await writeFile(paths.filteredRows, "", "utf8");
  }

  if (!metadata.processedPages.includes(pageKey)) {
    const identityKeys = new Set(metadata.identityKeys ?? []);
    const uniqueRows = rows.filter((row) => {
      const keys = [
        row.candidate.conditionId,
        row.candidate.marketId,
        row.candidate.slug,
        row.candidate.id,
      ]
        .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
        .map((value) => value.trim().toLowerCase());
      if (keys.some((key) => identityKeys.has(key))) return false;
      keys.forEach((key) => identityKeys.add(key));
      return true;
    });
    const payload = uniqueRows.map((row) => JSON.stringify(row)).join("\n");
    if (payload) await appendFile(paths.rows, `${payload}\n`, "utf8");
    const filteredPayload = uniqueRows
      .filter((row) => row.scanStatus === "passed")
      .map((row) => JSON.stringify(row))
      .join("\n");
    if (filteredPayload) {
      await appendFile(paths.filteredRows, `${filteredPayload}\n`, "utf8");
    }
    metadata.rowCount += uniqueRows.length;
    metadata.processedPages.push(pageKey);
    const eventKeys = new Set(metadata.eventKeys ?? []);
    const marketKeys = new Set(metadata.marketKeys ?? []);
    for (const row of uniqueRows) {
      Object.keys(row.event).forEach((key) => eventKeys.add(key));
      Object.keys(row.market).forEach((key) => marketKeys.add(key));
      if (row.scanStatus === "passed") {
        metadata.acceptedCount = (metadata.acceptedCount ?? 0) + 1;
        if ((metadata.acceptedSample?.length ?? 0) < 500) {
          metadata.acceptedSample = [
            ...(metadata.acceptedSample ?? []),
            row.candidate,
          ];
        }
      } else {
        metadata.rejectedCount = (metadata.rejectedCount ?? 0) + 1;
        if ((metadata.rejectedSample?.length ?? 0) < 500) {
          metadata.rejectedSample = [
            ...(metadata.rejectedSample ?? []),
            { ...row.candidate, filterReasons: row.filterReasons },
          ];
        }
      }
    }
    metadata.eventKeys = Array.from(eventKeys).sort();
    metadata.marketKeys = Array.from(marketKeys).sort();
    metadata.identityKeys = Array.from(identityKeys);
  }
  metadata.completed ||= completed;
  metadata.updatedAt = new Date().toISOString();
  await saveMetadata(metadata);
  return { exportId: resolvedExportId, rowCount: metadata.rowCount };
}

export async function cacheStageOneGammaExportSummary({
  metadata,
  ownerKey,
  acceptedCount,
  rejectedCount,
  acceptedSample,
  rejectedSample,
}: {
  metadata: StageOneGammaExportMetadata;
  ownerKey: string;
  acceptedCount: number;
  rejectedCount: number;
  acceptedSample: BullpenQuestion[];
  rejectedSample: Array<BullpenQuestion & { filterReasons: string[] }>;
}) {
  if (metadata.ownerHash !== ownerHash(ownerKey)) {
    throw new Error("Stage 1 export does not belong to this session.");
  }
  await saveMetadata({
    ...metadata,
    acceptedCount,
    rejectedCount,
    acceptedSample,
    rejectedSample,
  });
}

export async function openLatestStageOneGammaExport({
  ownerKey,
}: {
  ownerKey: string;
}) {
  await cleanupExpiredExports();
  const expectedOwnerHash = ownerHash(ownerKey);
  const names = await readdir(EXPORT_DIRECTORY).catch(() => [] as string[]);
  const matching = (
    await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => {
          const exportId = name.slice(0, -".json".length);
          if (!EXPORT_ID_PATTERN.test(exportId)) return null;
          const metadata = await readMetadata(exportId).catch(() => null);
          return metadata?.completed && metadata.ownerHash === expectedOwnerHash
            ? metadata
            : null;
        }),
    )
  )
    .filter((metadata): metadata is StageOneGammaExportMetadata => Boolean(metadata))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const metadata = matching[0];
  if (!metadata) return null;
  const paths = exportPaths(metadata.exportId);
  return {
    metadata,
    rowsPath: paths.rows,
    filteredRowsPath: paths.filteredRows,
  };
}

export async function readStageOneGammaExport({
  exportId,
  ownerKey,
}: {
  exportId: string;
  ownerKey: string;
}) {
  await cleanupExpiredExports();
  const metadata = await readMetadata(exportId);
  if (metadata.ownerHash !== ownerHash(ownerKey)) {
    throw new Error("Stage 1 export does not belong to this session.");
  }
  const raw = await readFile(exportPaths(exportId).rows, "utf8");
  const rows = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StageOneGammaExportRow);
  return { metadata, rows };
}

export async function openStageOneGammaExport({
  exportId,
  ownerKey,
}: {
  exportId: string;
  ownerKey: string;
}) {
  await cleanupExpiredExports();
  const metadata = await readMetadata(exportId);
  if (metadata.ownerHash !== ownerHash(ownerKey)) {
    throw new Error("Stage 1 export does not belong to this session.");
  }
  const paths = exportPaths(exportId);
  return {
    metadata,
    rowsPath: paths.rows,
    filteredRowsPath: paths.filteredRows,
  };
}

export async function reapplyStageOneGammaExportFilters({
  exportId,
  ownerKey,
  filters,
  evaluate,
  cursor,
}: {
  exportId: string;
  ownerKey: string;
  filters: BullpenScanFilters;
  evaluate: (
    candidate: BullpenQuestion,
    market: Record<string, unknown>,
    event: Record<string, unknown>,
  ) => string[];
  cursor?: number;
}) {
  await cleanupExpiredExports();
  const metadata = await readMetadata(exportId);
  if (metadata.ownerHash !== ownerHash(ownerKey)) {
    throw new Error("Stage 1 export does not belong to this session.");
  }
  if (!metadata.completed) {
    throw new Error("Only a completed Full Universe scan can be re-filtered.");
  }

  const paths = exportPaths(exportId);
  const temporaryFilteredPath = `${paths.filteredRows}.reapply.tmp`;
  const filterHash = createHash("sha256")
    .update(JSON.stringify(filters))
    .digest("hex");
  let state = metadata.reapplyState;
  if (!state || state.filterHash !== filterHash || cursor === undefined) {
    await rm(temporaryFilteredPath, { force: true });
    await writeFile(temporaryFilteredPath, "", "utf8");
    state = {
      filterHash,
      byteOffset: 0,
      processedCount: 0,
      acceptedCount: 0,
      rejectedCount: 0,
      acceptedSample: [],
      rejectedSample: [],
    };
  } else if (cursor !== state.processedCount) {
    throw new Error("The saved-universe re-filter cursor is stale.");
  }

  const input = createReadStream(paths.rows, {
    encoding: "utf8",
    start: state.byteOffset,
  });
  const lines = createInterface({
    input,
    crlfDelay: Infinity,
  });
  const CHUNK_ROWS = 5_000;
  let chunkRows = 0;
  let reachedEnd = true;
  let filteredBuffer = "";

  try {
    for await (const line of lines) {
      if (!line) continue;
      const row = JSON.parse(line) as StageOneGammaExportRow;
      const filterReasons = row.forceIncludedPosition || row.forceIncluded
        ? []
        : evaluate(row.candidate, row.market, row.event);
      const passed = filterReasons.length === 0;
      const nextRow: StageOneGammaExportRow = {
        ...row,
        scanStatus: passed ? "passed" : "filtered",
        filterReasons,
      };
      state.byteOffset += Buffer.byteLength(`${line}\n`, "utf8");
      state.processedCount += 1;
      chunkRows += 1;
      if (passed) {
        state.acceptedCount += 1;
        if (state.acceptedSample.length < 500) state.acceptedSample.push(row.candidate);
        filteredBuffer += `${JSON.stringify(nextRow)}\n`;
        if (filteredBuffer.length >= 1_000_000) {
          await appendFile(temporaryFilteredPath, filteredBuffer, "utf8");
          filteredBuffer = "";
        }
      } else {
        state.rejectedCount += 1;
        if (state.rejectedSample.length < 500) {
          state.rejectedSample.push({ ...row.candidate, filterReasons });
        }
      }
      if (chunkRows >= CHUNK_ROWS) {
        reachedEnd = false;
        lines.close();
        input.destroy();
        break;
      }
    }
    if (filteredBuffer) {
      await appendFile(temporaryFilteredPath, filteredBuffer, "utf8");
    }
  } catch (error) {
    lines.close();
    await rm(temporaryFilteredPath, { force: true });
    throw error;
  }

  if (!reachedEnd) {
    const progressMetadata = { ...metadata, reapplyState: state };
    await saveMetadata(progressMetadata);
    return { completed: false as const, metadata: progressMetadata };
  }
  if (state.processedCount !== metadata.rowCount) {
    throw new Error(
      `Stored Full Universe row count changed (${state.processedCount}/${metadata.rowCount}).`,
    );
  }
  await rename(temporaryFilteredPath, paths.filteredRows);

  const updatedMetadata: StageOneGammaExportMetadata = {
    ...metadata,
    reapplyState: undefined,
    filters,
    updatedAt: new Date().toISOString(),
    acceptedCount: state.acceptedCount,
    rejectedCount: state.rejectedCount,
    acceptedSample: state.acceptedSample,
    rejectedSample: state.rejectedSample,
  };
  await saveMetadata(updatedMetadata);
  return { completed: true as const, metadata: updatedMetadata };
}

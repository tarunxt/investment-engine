import { deflateSync, inflateSync } from "node:zlib";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type {
  BullpenQuestion,
  BullpenScanFilters,
  ScanMode,
} from "@/lib/bullpen-ai";
import type { UniversalScanSummary } from "./universalScanSummary";

const DEPLOYED_APP_ROOT = process.env.APP_ROOT?.trim();
const EXPORT_DIRECTORY = process.env.BULLPEN_STAGE_ONE_EXPORT_DIRECTORY?.trim() ||
  (process.env.NODE_ENV === "production"
    ? DEPLOYED_APP_ROOT
      ? join(DEPLOYED_APP_ROOT, "backend", ".stage-one-exports")
      : join(homedir(), ".local", "share", "credx-bullpen-stage-one-exports")
    : join(tmpdir(), "credx-bullpen-stage-one-exports"));
const READABLE_EXPORT_DIRECTORIES = Array.from(new Set([
  EXPORT_DIRECTORY,
  ...(process.env.NODE_ENV === "production"
    ? [
        ...(DEPLOYED_APP_ROOT ? [join(DEPLOYED_APP_ROOT, "backend", ".stage-one-exports")] : []),
        "/srv/investor/backend/.stage-one-exports",
        "/srv/investment-engine/backend/.stage-one-exports",
        join(homedir(), ".local", "share", "credx-bullpen-stage-one-exports"),
        "/home/investor/.local/share/credx-bullpen-stage-one-exports",
        "/home/investment-engine/.local/share/credx-bullpen-stage-one-exports",
      ]
    : []),
]));
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
  universalSource?: boolean;
  filterPending?: boolean;
  sourceScanExportId?: string;
  sourceScanCompletedAt?: string;
  filtersCompletedAt?: string;
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
  universalSummary?: UniversalScanSummary;
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

function exportPaths(exportId: string, directory = EXPORT_DIRECTORY) {
  assertExportId(exportId);
  return {
    rows: join(directory, `${exportId}.jsonl`),
    filteredRows: join(directory, `${exportId}.filtered.jsonl`),
    metadata: join(directory, `${exportId}.json`),
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
      const exportMetadata = match
        ? await readMetadata(match[1]).catch(() => null)
        : null;
      const isDurableUniversal = Boolean(
        exportMetadata?.universalSource && exportMetadata.completed,
      );
      const isExpired = Boolean(
        details && !isDurableUniversal && now - details.mtimeMs > EXPORT_RETENTION_MS,
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

async function cleanupSupersededOwnerExports(ownerKey: string, preserveCompleted = false, keepExportId?: string) {
  const expectedOwnerHash = ownerHash(ownerKey);
  const names = await readdir(EXPORT_DIRECTORY).catch(() => [] as string[]);
  await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        const exportId = name.slice(0, -".json".length);
        if (!EXPORT_ID_PATTERN.test(exportId)) return;
        if (exportId === keepExportId) return;
        const metadata = await readMetadata(exportId).catch(() => null);
        if (metadata?.ownerHash === expectedOwnerHash && !(preserveCompleted && metadata.completed)) {
          await removeExport(exportId);
        }
      }),
  );
}

async function readMetadata(exportId: string, directory = EXPORT_DIRECTORY) {
  const { metadata } = exportPaths(exportId, directory);
  const raw = await readFile(metadata, "utf8");
  return JSON.parse(raw) as StageOneGammaExportMetadata;
}

async function saveMetadata(metadata: StageOneGammaExportMetadata, directory = EXPORT_DIRECTORY) {
  const paths = exportPaths(metadata.exportId, directory);
  await writeFile(paths.metadata, JSON.stringify(metadata), "utf8");
}

async function findReadableMetadata(exportId: string) {
  for (const directory of READABLE_EXPORT_DIRECTORIES) {
    const metadata = await readMetadata(exportId, directory).catch(() => null);
    if (metadata) return { metadata, directory };
  }
  return null;
}

export async function cacheUniversalScanSummary({
  metadata,
  ownerKey,
  summary,
}: {
  metadata: StageOneGammaExportMetadata;
  ownerKey: string;
  summary: UniversalScanSummary;
}) {
  const located = await findReadableMetadata(metadata.exportId);
  if (!located || located.metadata.ownerHash !== ownerHash(ownerKey)) {
    throw new Error("Stage 1 export does not belong to this session.");
  }
  if (!located.metadata.completed || located.metadata.updatedAt !== metadata.updatedAt) return;
  await saveMetadata(
    { ...located.metadata, universalSummary: summary },
    located.directory,
  );
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
    await cleanupSupersededOwnerExports(ownerKey, ownerKey.endsWith(":universal"));
    metadata = {
      exportId: resolvedExportId,
      ownerHash: ownerHash(ownerKey),
      universalSource: ownerKey.endsWith(":universal"),
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
    const payload = uniqueRows.map((row) => serializeStageOneGammaExportRow(row, ownerKey.endsWith(":universal"))).join("\n");
    if (payload) await appendFile(paths.rows, `${payload}\n`, "utf8");
    const filteredPayload = uniqueRows
      .filter((row) => row.scanStatus === "passed")
      .map((row) => JSON.stringify(row))
      .join("\n");
    if (filteredPayload && !ownerKey.endsWith(":universal")) {
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
  if (metadata.completed && metadata.universalSource) {
    await cleanupSupersededOwnerExports(ownerKey, false, metadata.exportId);
  }
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
  const matching = (
    await Promise.all(
      READABLE_EXPORT_DIRECTORIES.map(async (directory) => {
        const names = await readdir(directory).catch(() => [] as string[]);
        return Promise.all(
          names
            .filter((name) => name.endsWith(".json"))
            .map(async (name) => {
              const exportId = name.slice(0, -".json".length);
              if (!EXPORT_ID_PATTERN.test(exportId)) return null;
              const metadata = await readMetadata(exportId, directory).catch(() => null);
              return metadata?.completed && !metadata.filterPending && metadata.ownerHash === expectedOwnerHash
                ? { metadata, directory }
                : null;
            }),
        );
      }),
    )
  )
    .flat()
    .filter((item): item is { metadata: StageOneGammaExportMetadata; directory: string } => Boolean(item))
    .sort((left, right) => Date.parse(right.metadata.updatedAt) - Date.parse(left.metadata.updatedAt));
  const latest = matching[0];
  if (!latest) return null;
  const paths = exportPaths(latest.metadata.exportId, latest.directory);
  return {
    metadata: latest.metadata,
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
  const located = await findReadableMetadata(exportId);
  if (!located || located.metadata.ownerHash !== ownerHash(ownerKey)) {
    throw new Error("Stage 1 export does not belong to this session.");
  }
  const metadata = located.metadata;
  const raw = await readFile(exportPaths(exportId, located.directory).rows, "utf8");
  const rows = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => parseStageOneGammaExportRow(line));
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
  const located = await findReadableMetadata(exportId);
  if (!located || located.metadata.ownerHash !== ownerHash(ownerKey)) {
    throw new Error("Stage 1 export does not belong to this session.");
  }
  const metadata = located.metadata;
  const paths = exportPaths(exportId, located.directory);
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
      const row = parseStageOneGammaExportRow(line);
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

  const filtersCompletedAt = new Date().toISOString();
  const updatedMetadata: StageOneGammaExportMetadata = {
    ...metadata,
    reapplyState: undefined,
    filterPending: false,
    filters,
    updatedAt: filtersCompletedAt,
    filtersCompletedAt,
    acceptedCount: state.acceptedCount,
    rejectedCount: state.rejectedCount,
    acceptedSample: state.acceptedSample,
    rejectedSample: state.rejectedSample,
  };
  await saveMetadata(updatedMetadata);
  return { completed: true as const, metadata: updatedMetadata };
}

// A workflow owns its filter output; the shared capture is never re-filtered in place.
export async function forkUniversalScan(
  ownerKey: string,
  sourceExportId?: string,
  universalOwnerKey = ownerKey,
) {
  const source = sourceExportId
    ? await openStageOneGammaExport({ exportId: sourceExportId, ownerKey: `${universalOwnerKey}:universal` })
    : await openUniversalScan(universalOwnerKey);
  if (!source || !source.metadata.completed) throw new Error("Run Universal Polymarket Scan in Trading Bots first.");
  const exportId = randomUUID();
  const paths = exportPaths(exportId);
  await copyFile(source.rowsPath, paths.rows);
  await writeFile(paths.filteredRows, "", "utf8");
  await saveMetadata({ ...source.metadata, exportId, ownerHash: ownerHash(ownerKey),
    universalSource: false, sourceScanExportId: source.metadata.exportId,
    sourceScanCompletedAt: source.metadata.updatedAt, filtersCompletedAt: undefined,
    filterPending: true, updatedAt: new Date().toISOString(),
    acceptedCount: 0, rejectedCount: 0, acceptedSample: [], rejectedSample: [], reapplyState: undefined });
  return exportId;
}

const universalImports = new Map<string, Promise<Awaited<ReturnType<typeof openLatestStageOneGammaExport>>>>();

// Preserve the user's existing completed capture when moving the scan surface.
// Reset workflow classifications and drop synthetic wallet-only rows.
export async function openUniversalScan(ownerKey: string) {
  const current = await openLatestStageOneGammaExport({ ownerKey: `${ownerKey}:universal` });
  if (current) return current;
  const pending = universalImports.get(ownerKey);
  if (pending) return pending;
  const importOriginal = (async () => {
    const original = await openLatestStageOneGammaExport({ ownerKey });
    if (!original) return null;
    const exportId = randomUUID();
    const paths = exportPaths(exportId);
    await writeFile(paths.rows, "", "utf8");
    let buffer = "";
    let rowCount = 0;
    const identityKeys = new Set<string>();
    const acceptedSample: BullpenQuestion[] = [];
    const lines = createInterface({ input: createReadStream(original.rowsPath, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      const row = parseStageOneGammaExportRow(line);
      if (row.event.source === "active_wallet_position" || row.market.source === "active_wallet_position") continue;
      const rawRow = { ...row, scanStatus: "passed", filterReasons: [], forceIncluded: false, forceIncludedPosition: false };
      rowCount += 1;
      for (const value of [row.candidate.conditionId, row.candidate.marketId, row.candidate.slug, row.candidate.id]) {
        if (typeof value === "string" && value.trim()) identityKeys.add(value.trim().toLowerCase());
      }
      if (acceptedSample.length < 500) acceptedSample.push(row.candidate);
      buffer += `${serializeStageOneGammaExportRow(rawRow as StageOneGammaExportRow, true)}\n`;
      if (buffer.length >= 1_000_000) { await appendFile(paths.rows, buffer, "utf8"); buffer = ""; }
    }
    if (buffer) await appendFile(paths.rows, buffer, "utf8");
    await writeFile(paths.filteredRows, "", "utf8");
    await saveMetadata({ ...original.metadata, exportId, ownerHash: ownerHash(`${ownerKey}:universal`),
      universalSource: true, sourceScanExportId: undefined, filterPending: false, reapplyState: undefined,
      identityKeys: [...identityKeys], rowCount, acceptedCount: rowCount, rejectedCount: 0, acceptedSample, rejectedSample: [] });
    return openLatestStageOneGammaExport({ ownerKey: `${ownerKey}:universal` });
  })();
  universalImports.set(ownerKey, importOriginal);
  try { return await importOriginal; } finally { universalImports.delete(ownerKey); }
}

// Per-row compression retains every raw field while keeping chunked re-filter
// byte offsets valid. Legacy plain JSONL rows remain readable.
export function serializeStageOneGammaExportRow(row: StageOneGammaExportRow, compressed = false) {
  const json = JSON.stringify(row);
  return compressed ? JSON.stringify({ compressedRowV1: deflateSync(Buffer.from(json), { level: 1 }).toString("base64") }) : json;
}
export function parseStageOneGammaExportRow(line: string): StageOneGammaExportRow {
  const row = JSON.parse(line);
  return typeof row.compressedRowV1 === "string"
    ? JSON.parse(inflateSync(Buffer.from(row.compressedRowV1, "base64")).toString("utf8"))
    : row;
}

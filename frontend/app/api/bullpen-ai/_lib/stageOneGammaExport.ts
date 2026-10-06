import { deflateSync, inflateSync } from "node:zlib";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import type { FileHandle } from "node:fs/promises";
import { appendFile as nativeAppendFile, writeFile as nativeWriteFile, link, open, mkdir, lstat, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
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
// Writers may run for 50 minutes. A missing counterpart is not proof that an
// export is abandoned; only a dedicated retention job may remove orphan files.
const EXPORT_ID_PATTERN = /^[0-9a-f-]{36}$/;

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
  storageRevision?: string;
  storageTransactionVersion?: 1;
  universalSource?: boolean;
  rowsBytes?: number;
  rowsSha256?: string;
  immutableRowsStorage?: {
    version: 1;
    sha256: string;
    bytes: number;
    recoveryExportId: string;
    recoveryOwnerHash?: string;
    independentRecovery: true;
  };
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
  const paths = {
    rows: join(directory, `${exportId}.jsonl`),
    filteredRows: join(directory, `${exportId}.filtered.jsonl`),
    metadata: join(directory, `${exportId}.json`),
  };
  const transaction = exportTransaction.getStore();
  if (transaction?.exportId === exportId && transaction.directory === directory) {
    for (const kind of ["rows", "filteredRows", "metadata"] as const) {
      paths[kind] = transaction.stages[kind] || paths[kind];
    }
  }
  return paths;
}

function ownerHash(ownerKey: string) {
  return createHash("sha256").update(ownerKey).digest("hex");
}

// Retention ages and owner supersession are not authoritative reference closure.
// Cleanup stays dry-run/pinned; no completed/history/orphan file is swept here.
type CaptureBudget = { token: string; identity: string; touched: boolean; credit: Map<string, number>; allocated: Map<string, number>; queue: Promise<void>; failed: boolean };
const captureBudget = new AsyncLocalStorage<CaptureBudget>();
async function budgetCommand(budget: CaptureBudget, command: Record<string, unknown>) {
  const python = process.env.BULLPEN_STORAGE_BUDGET_PYTHON;
  const helper = process.env.BULLPEN_STORAGE_BUDGET_HELPER;
  if (!python || !helper || !isAbsolute(python) || !isAbsolute(helper)) {
    throw new Error("UPS_STORAGE_CAPACITY: Reservation adapter paths must be explicitly configured before enabling storage reservations.");
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(python, [helper], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    const deadline = setTimeout(() => { child.kill(); reject(new Error("UPS_STORAGE_CAPACITY: Reservation adapter timed out; unresolved claims remain pinned.")); }, 30_000);
    child.stdout.on("data", chunk => { output += chunk.toString(); if (output.length > 65_536) child.kill(); });
    child.stderr.on("data", chunk => { errors = (errors + chunk.toString()).slice(-2048); });
    child.on("error", error => { clearTimeout(deadline); reject(error); });
    child.on("close", code => {
      clearTimeout(deadline);
      try {
        const result = JSON.parse(output);
        if (code !== 0 || result.ok !== true) throw new Error(result.error || errors || "Reservation adapter failed");
        resolve();
      } catch (error) { reject(error); }
    });
    child.stdin.on("error", error => { clearTimeout(deadline); reject(error); });
    child.stdin.end(JSON.stringify({ root: process.env.BULLPEN_STORAGE_RESERVATION_DIRECTORY || EXPORT_DIRECTORY,
      identity: budget.identity, token: budget.token, ...command }));
  });
}
async function withCaptureBudget<T>(identity: string, execute: () => Promise<T>, force = false): Promise<T> {
  if ((!force && process.env.BULLPEN_STORAGE_RESERVATIONS !== "1") || captureBudget.getStore()) return execute();
  const budget: CaptureBudget = { token: randomUUID(), identity, touched: false, credit: new Map(), allocated: new Map(), queue: Promise.resolve(), failed: false };
  return captureBudget.run(budget, async () => {
    try { return await execute(); }
    finally { await budget.queue; if (budget.touched) await budgetCommand(budget, { action: "release" }); }
  });
}
async function allocateWrite<T>(path: string, bytes: number, execute: () => Promise<T>): Promise<T> {
  return withCaptureBudget(`frontend:${path}`, async () => {
    const budget = captureBudget.getStore();
    if (!budget) return execute();
    const action = async () => {
      if (budget.failed) throw new Error("UPS_STORAGE_CAPACITY: Capture writer failed; retry using a new operation.");
      try {
        budget.touched = true;
        const target = dirname(path);
        let credit = budget.credit.get(target) || 0;
        if (credit < bytes || !budget.credit.has(target)) {
          const amount = Math.max(bytes, 4 * 1024 ** 2);
          await budgetCommand(budget, { action: "reserve", requests: [{ target, bytes: amount }] });
          credit += amount;
        }
        const result = await execute();
        budget.credit.set(target, credit - bytes);
        const allocated = (budget.allocated.get(target) || 0) + bytes;
        if (allocated >= 4 * 1024 ** 2) {
          await budgetCommand(budget, { action: "consume", target, bytes: allocated });
          budget.allocated.set(target, 0);
        } else { budget.allocated.set(target, allocated); }
        return result;
      } catch (error) { budget.failed = true; throw error; }
    };
    const pending = budget.queue.then(action);
    budget.queue = pending.then(() => undefined, () => undefined);
    return pending;
  });
}
async function writeFile(path: string, value: string, encoding: "utf8") {
  return allocateWrite(path, Buffer.byteLength(value, encoding), () => nativeWriteFile(path, value, encoding));
}
async function appendFile(path: string, value: string, encoding: "utf8") {
  return allocateWrite(path, Buffer.byteLength(value, encoding), () => nativeAppendFile(path, value, encoding));
}
async function copyFile(source: string, destination: string) {
  const reader = await openRegularFile(source);
  try {
    const before = await reader.stat();
    return await allocateWrite(destination, before.size, async () => {
      const writer = await open(destination, "wx");
      try {
        const buffer = Buffer.alloc(Math.min(before.size || 1, 1024 ** 2));
        let offset = 0;
        while (offset < before.size) {
          const { bytesRead } = await reader.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
          if (!bytesRead || (await writer.write(buffer, 0, bytesRead, offset)).bytesWritten !== bytesRead) throw new Error("UPS_STORAGE_CAPACITY: Export copy short read/write.");
          offset += bytesRead;
        }
        const after = await reader.stat();
        const current = await lstat(source);
        if (before.dev !== current.dev || before.ino !== current.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
          throw new Error("UPS_SOURCE_CORRUPT: Export changed during bounded copy.");
        }
        await writer.sync();
      } finally { await writer.close(); }
    });
  } finally { await reader.close(); }
}

type ExportFileKind = "rows" | "filteredRows" | "metadata" | "reapply";
type ExportTransaction = { exportId: string; directory: string; token: string; stages: Partial<Record<ExportFileKind, string>>; dirty: boolean };
const exportTransaction = new AsyncLocalStorage<ExportTransaction>();
const fileSuffix: Record<ExportFileKind, string> = { rows: ".jsonl", filteredRows: ".filtered.jsonl", metadata: ".json", reapply: ".filtered.jsonl.reapply.tmp" };

async function withExportOperation<T>(exportId: string, directory: string, kinds: ExportFileKind[], execute: () => Promise<T>): Promise<T> {
  assertExportId(exportId);
  const parent = exportTransaction.getStore();
  if (parent?.exportId === exportId && parent.directory === directory) return execute();
  const python = process.env.BULLPEN_STORAGE_BUDGET_PYTHON;
  const adapter = process.env.BULLPEN_STORAGE_BUDGET_HELPER;
  if (!python || !adapter || !isAbsolute(python) || !isAbsolute(adapter)) {
    const metadata = await readMetadata(exportId, directory).catch(() => null);
    if (metadata?.immutableRowsStorage || metadata?.storageTransactionVersion || process.env.BULLPEN_CANONICAL_EXPORT_STORAGE === "1") {
      throw new Error("UPS_STORAGE_TRANSACTION: Transaction adapter paths must be explicitly configured even after sharing is disabled.");
    }
    return execute(); // unchanged legacy exports with all opt-in features inactive
  }
  if (!captureBudget.getStore()) return withCaptureBudget(`export-transaction:${exportId}`,
    () => withExportOperation(exportId, directory, kinds, execute), true);
  const child = spawn(python, [join(dirname(adapter), "export-file-transaction.py"), directory, exportId], { stdio: ["pipe", "pipe", "pipe"] });
  const replies = createInterface({ input: child.stdout });
  const queue: Array<(value: string | Error) => void> = [];
  const buffered: Array<string | Error> = [];
  let errors = "";
  let stopped = false;
  const deliver = (value: string | Error) => { const receiver = queue.shift(); if (receiver) receiver(value); else buffered.push(value); };
  replies.on("line", line => deliver(line));
  child.stderr.on("data", chunk => { errors = (errors + chunk.toString()).slice(-2048); });
  child.on("error", error => { stopped = true; deliver(error); });
  child.on("close", () => { stopped = true; deliver(new Error(errors || "Export transaction helper exited; pending journal remains pinned.")); });
  child.stdin.on("error", error => deliver(error));
  const receive = () => new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => { child.kill(); reject(new Error("UPS_STORAGE_TRANSACTION: Transaction timed out; retry to recover its durable journal.")); }, 30_000);
    const receiver = (value: string | Error) => {
      clearTimeout(deadline);
      try {
        if (value instanceof Error) throw value;
        const reply = JSON.parse(value);
        if (!reply.ok) throw new Error(reply.error || "Export transaction failed");
        resolve();
      } catch (error) { reject(error); }
    };
    const value = buffered.shift();
    if (value !== undefined) receiver(value);
    else if (stopped) receiver(new Error("Export transaction helper exited"));
    else queue.push(receiver);
  });
  const context: ExportTransaction = { exportId, directory, token: randomUUID(), stages: {}, dirty: false };
  let commitAttempted = false;
  try {
    await receive(); // cross-process flock acquired and previous journal recovered
    for (const kind of kinds) {
      const stage = join(directory, `.${exportId}.${context.token}.${kind}.txn.tmp`);
      const source = join(directory, exportId + fileSuffix[kind]);
      context.stages[kind] = stage;
      if (kind === "rows") {
        const metadata = await readMetadata(exportId, directory).catch(() => null);
        if (metadata?.immutableRowsStorage && metadata.universalSource) throw new Error("Completed Universal scan payloads are immutable; create a new export.");
        const resolved = metadata ? await readableRows(metadata, directory) : source;
        if (await stat(resolved).catch(() => null)) await copyFile(resolved, stage);
      } else if (await stat(source).catch(() => null)) await copyFile(source, stage);
    }
    const result = await exportTransaction.run(context, execute);
    const present: ExportFileKind[] = [];
    for (const kind of kinds) if (await stat(context.stages[kind]!).catch(() => null)) present.push(kind);
    if (present.length && context.dirty) {
      if (!present.includes("metadata")) throw new Error("Export transaction has no ownership manifest");
      // Once the helper can have persisted a redo journal, stages must NEVER be
      // removed on failure; the next holder validates and completes publication.
      commitAttempted = true;
      child.stdin.write(JSON.stringify({ action: "commit", token: context.token, kinds: present,
        budgetRoot: process.env.BULLPEN_STORAGE_RESERVATION_DIRECTORY || EXPORT_DIRECTORY }) + "\n");
      await receive();
    }
    return result;
  } finally {
    if (!commitAttempted) for (const stage of Object.values(context.stages)) await rm(stage, { force: true });
    child.stdin.end();
    replies.close();
  }
}

function sameRevision(input: StageOneGammaExportMetadata, current: StageOneGammaExportMetadata) {
  return input.updatedAt === current.updatedAt && input.rowCount === current.rowCount && input.storageRevision === current.storageRevision;
}


async function openRegularFile(path: string): Promise<FileHandle> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  if (!(await handle.stat()).isFile()) { await handle.close(); throw new Error("UPS_SOURCE_CORRUPT: Nonregular export artifact remains pinned."); }
  return handle;
}

const verifiedPayloads = new Map<string, { signature: string; bytes: number; sha256: string }>();
async function rowsIntegrity(path: string) {
  const signature = (value: Awaited<ReturnType<typeof stat>>) => `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
  const handle = await openRegularFile(path);
  try {
    const before = await handle.stat();
    const cached = verifiedPayloads.get(path);
    if (cached?.signature === signature(before)) return cached;
    const digest = createHash("sha256");
    let bytes = 0;
    if (before.size) for await (const chunk of handle.createReadStream({ start: 0, end: before.size - 1, autoClose: false })) { bytes += chunk.length; digest.update(chunk); }
    if (bytes !== before.size || signature(before) !== signature(await handle.stat()) || signature(before) !== signature(await lstat(path))) {
      throw new Error("UPS_SOURCE_CORRUPT: Payload changed during verification.");
    }
    const result = { signature: signature(before), bytes, sha256: digest.digest("hex") };
    if (verifiedPayloads.size >= 128) verifiedPayloads.clear();
    verifiedPayloads.set(path, result);
    return result;
  } finally { await handle.close(); }
}
function recoveryDirectory() {
  return process.env.UNIVERSAL_SCAN_ARCHIVE_DIRECTORY?.trim() || join(dirname(EXPORT_DIRECTORY), ".universal-scan-archive");
}
async function checkedRecovery(metadata: StageOneGammaExportMetadata) {
  const storage = metadata.immutableRowsStorage;
  if (!storage || storage.version !== 1 || !storage.independentRecovery ||
      storage.sha256 !== metadata.rowsSha256 || storage.bytes !== metadata.rowsBytes) {
    throw new Error("UPS_SOURCE_CORRUPT: Immutable storage manifest is incomplete.");
  }
  assertExportId(storage.recoveryExportId);
  const directory = recoveryDirectory();
  const recovery = await readMetadata(storage.recoveryExportId, directory);
  if (!recovery.completed || !recovery.universalSource ||
      recovery.ownerHash !== (storage.recoveryOwnerHash || metadata.ownerHash) ||
      recovery.rowsSha256 !== storage.sha256 || recovery.rowsBytes !== storage.bytes ||
      recovery.rowCount !== metadata.rowCount) {
    throw new Error("UPS_SOURCE_CORRUPT: Independent recovery identity or ownership does not match.");
  }
  const path = exportPaths(storage.recoveryExportId, directory).rows;
  const actual = await rowsIntegrity(path);
  if (actual.sha256 !== storage.sha256 || actual.bytes !== storage.bytes) {
    throw new Error("UPS_SOURCE_CORRUPT: Independent recovery payload does not match.");
  }
  return path;
}
async function readableRows(metadata: StageOneGammaExportMetadata, directory: string) {
  const path = exportPaths(metadata.exportId, directory).rows;
  if (!metadata.immutableRowsStorage) return path; // old readers and manifests
  const actual = await rowsIntegrity(path).catch(() => null);
  if (actual && actual.sha256 === metadata.rowsSha256 && actual.bytes === metadata.rowsBytes) return path;
  return checkedRecovery(metadata); // exact historical identity; no newer/older fallback
}

async function cleanupExpiredExports() {
  await mkdir(EXPORT_DIRECTORY, { recursive: true });
}
async function cleanupSupersededOwnerExports(_ownerKey: string, _preserveCompleted = false, _keepExportId?: string) {
  void _ownerKey; void _preserveCompleted; void _keepExportId;
  await mkdir(EXPORT_DIRECTORY, { recursive: true });
}

async function readMetadata(exportId: string, directory = EXPORT_DIRECTORY) {
  const { metadata } = exportPaths(exportId, directory);
  const handle = await openRegularFile(metadata);
  try {
    if ((await handle.stat()).size > 64 * 1024 ** 2) throw new Error("UPS_SOURCE_CORRUPT: Oversized export manifest remains pinned.");
    return JSON.parse(await handle.readFile("utf8")) as StageOneGammaExportMetadata;
  } finally { await handle.close(); }
}

async function saveMetadata(metadata: StageOneGammaExportMetadata, directory = EXPORT_DIRECTORY) {
  const paths = exportPaths(metadata.exportId, directory);
  const transaction = exportTransaction.getStore();
  if (transaction) transaction.dirty = true;
  metadata.storageRevision = randomUUID();
  if (exportTransaction.getStore()) metadata.storageTransactionVersion = 1;
  const temporary = `${paths.metadata}.${randomUUID()}.manifest.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(metadata), "utf8");
    const persisted = await open(temporary, "r");
    try { await persisted.sync(); } finally { await persisted.close(); }
    await rename(temporary, paths.metadata);
    const directoryHandle = await open(directory, "r");
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } finally { await rm(temporary, { force: true }); }
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
  directory,
}: {
  metadata: StageOneGammaExportMetadata;
  ownerKey: string;
  summary: UniversalScanSummary;
  directory?: string;
}) {
  const resolvedDirectory = directory || (await findReadableMetadata(metadata.exportId))?.directory || EXPORT_DIRECTORY;
  return withExportOperation(metadata.exportId, resolvedDirectory, ["metadata"], async () => {
    const current = await readMetadata(metadata.exportId, resolvedDirectory);
    if (current.ownerHash !== ownerHash(ownerKey)) throw new Error("Stage 1 export does not belong to this session.");
    if (!current.completed || !sameRevision(metadata, current)) return;
    await saveMetadata({ ...current, universalSummary: summary }, resolvedDirectory);
  });
}

async function appendStageOneGammaExportPageInternal({
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
}, createdExportId?: string) {
  await cleanupExpiredExports();
  const resolvedExportId = exportId || createdExportId || randomUUID();
  const paths = exportPaths(resolvedExportId);
  let metadata: StageOneGammaExportMetadata;

  if (exportId) {
    metadata = await readMetadata(resolvedExportId);
    if (metadata.ownerHash !== ownerHash(ownerKey)) throw new Error("Stage 1 export does not belong to this session.");
    if (metadata.immutableRowsStorage && metadata.processedPages.includes(pageKey)) {
      return { exportId: resolvedExportId, rowCount: metadata.rowCount };
    }
    if (metadata.immutableRowsStorage && metadata.universalSource) {
      throw new Error("Completed Universal scan payloads are immutable; create a new export.");
    }
    if (metadata.immutableRowsStorage && !exportTransaction.getStore()) {
      throw new Error("UPS_STORAGE_TRANSACTION: Shared payload mutation requires a recoverable transaction.");
    }
    if (metadata.immutableRowsStorage) {
      // Wallet augmentation is an existing financial-workflow dependency.
      // Copy on write only this workflow's logical path before adding rows;
      // shared Universal bytes and its independent recovery remain unchanged.
      // withExportOperation copied validated bytes into an independent stage.
      // Its journal persists private rows before publishing cleared metadata.
      metadata = { ...metadata, immutableRowsStorage: undefined, rowsBytes: undefined, rowsSha256: undefined };
    }
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
  return withExportOperation(metadata.exportId, EXPORT_DIRECTORY, ["metadata"], async () => {
    const current = await readMetadata(metadata.exportId);
    if (current.ownerHash !== ownerHash(ownerKey)) throw new Error("Stage 1 export does not belong to this session.");
    if (!sameRevision(metadata, current)) return;
    await saveMetadata({ ...current, acceptedCount, rejectedCount, acceptedSample, rejectedSample });
  });
}

const latestExportReads = new Map<string, Promise<Awaited<ReturnType<typeof findLatestStageOneGammaExport>>>>();
type MetadataIndexEntry = {
  mtimeMs: number;
  size: number;
  ownerHash: string;
  completed: boolean;
  filterPending: boolean;
  updatedAt: string;
};
const metadataIndex = new Map<string, MetadataIndexEntry>();
const latestMetadataCache = new Map<string, {
  path: string;
  mtimeMs: number;
  size: number;
  metadata: StageOneGammaExportMetadata;
}>();

async function indexedMetadata(exportId: string, directory: string) {
  const path = exportPaths(exportId, directory).metadata;
  const details = await stat(path).catch(() => null);
  if (!details) return null;
  const cached = metadataIndex.get(path);
  if (cached?.mtimeMs === details.mtimeMs && cached.size === details.size) {
    return { index: cached, metadata: null };
  }
  const metadata = await readMetadata(exportId, directory).catch(() => null);
  if (!metadata) return null;
  const index: MetadataIndexEntry = {
    mtimeMs: details.mtimeMs,
    size: details.size,
    ownerHash: metadata.ownerHash,
    completed: metadata.completed,
    filterPending: Boolean(metadata.filterPending),
    updatedAt: metadata.updatedAt,
  };
  // This index stores only small selection fields, never the large identity
  // lists or row samples from all historical exports.
  if (metadataIndex.size > 2048) metadataIndex.clear();
  metadataIndex.set(path, index);
  return { index, metadata };
}

async function findLatestStageOneGammaExport({
  ownerKey,
}: {
  ownerKey: string;
}) {
  const expectedOwnerHash = ownerHash(ownerKey);
  const seenDirectories = new Set<string>();
  let latest: { exportId: string; directory: string; index: MetadataIndexEntry; metadata: StageOneGammaExportMetadata | null } | null = null;
  for (const directory of READABLE_EXPORT_DIRECTORIES) {
    const canonical = await realpath(directory).catch(() => null);
    if (!canonical || seenDirectories.has(canonical)) continue;
    seenDirectories.add(canonical);
    const names = await readdir(canonical).catch(() => [] as string[]);
    for (const name of names) {
      const exportId = name.slice(0, -".json".length);
      if (!name.endsWith(".json") || !EXPORT_ID_PATTERN.test(exportId)) continue;
      const candidate = await indexedMetadata(exportId, canonical);
      if (
        candidate?.index.completed && !candidate.index.filterPending &&
        candidate.index.ownerHash === expectedOwnerHash &&
        (!latest || Date.parse(candidate.index.updatedAt) > Date.parse(latest.index.updatedAt))
      ) {
        latest = { ...candidate, exportId, directory: canonical };
      }
    }
  }
  if (!latest) return null;
  const paths = exportPaths(latest.exportId, latest.directory);
  const cachedLatest = latestMetadataCache.get(ownerKey);
  const metadata = latest.metadata ?? (
    cachedLatest?.path === paths.metadata &&
    cachedLatest.mtimeMs === latest.index.mtimeMs &&
    cachedLatest.size === latest.index.size
      ? cachedLatest.metadata
      : await readMetadata(latest.exportId, latest.directory).catch(() => null)
  );
  if (!metadata || !metadata.completed || metadata.filterPending || metadata.ownerHash !== expectedOwnerHash) return null;
  if (latestMetadataCache.size >= 8 && !latestMetadataCache.has(ownerKey)) {
    latestMetadataCache.delete(latestMetadataCache.keys().next().value!);
  }
  latestMetadataCache.set(ownerKey, {
    path: paths.metadata,
    mtimeMs: latest.index.mtimeMs,
    size: latest.index.size,
    metadata,
  });
  return withExportOperation(metadata.exportId, latest.directory, [], async () => {
    const current = process.env.BULLPEN_STORAGE_BUDGET_HELPER
      ? await readMetadata(metadata.exportId, latest.directory)
      : metadata; // preserve unchanged legacy metadata cache when protocol is inactive
    if (!current.completed || current.filterPending || current.ownerHash !== expectedOwnerHash) return null;
    return { metadata: current, rowsPath: await readableRows(current, latest.directory), filteredRowsPath: paths.filteredRows };
  });
}

export async function openLatestStageOneGammaExport({ ownerKey }: { ownerKey: string }) {
  const pending = latestExportReads.get(ownerKey);
  if (pending) return pending;
  const read = findLatestStageOneGammaExport({ ownerKey });
  latestExportReads.set(ownerKey, read);
  try {
    return await read;
  } finally {
    latestExportReads.delete(ownerKey);
  }
}

export async function readStageOneGammaExport({
  exportId,
  ownerKey,
}: {
  exportId: string;
  ownerKey: string;
}) {
  const directory = (await findReadableMetadata(exportId))?.directory || EXPORT_DIRECTORY;
  return withExportOperation(exportId, directory, [], async () => {
  const located = await findReadableMetadata(exportId);
  if (!located || located.metadata.ownerHash !== ownerHash(ownerKey)) {
    throw new Error("Stage 1 export does not belong to this session.");
  }
  const metadata = located.metadata;
  const handle = await openRegularFile(await readableRows(metadata, located.directory));
  let raw: string;
  try { raw = await handle.readFile("utf8"); } finally { await handle.close(); }
  const rows = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => parseStageOneGammaExportRow(line));
  return { metadata, rows };
  });
}

export async function openStageOneGammaExport({
  exportId,
  ownerKey,
}: {
  exportId: string;
  ownerKey: string;
}) {
  const directory = (await findReadableMetadata(exportId))?.directory || EXPORT_DIRECTORY;
  return withExportOperation(exportId, directory, [], async () => {
  const located = await findReadableMetadata(exportId);
  if (!located || located.metadata.ownerHash !== ownerHash(ownerKey)) {
    throw new Error("Stage 1 export does not belong to this session.");
  }
  const metadata = located.metadata;
  const paths = exportPaths(exportId, located.directory);
  return {
    metadata,
    rowsPath: await readableRows(metadata, located.directory),
    filteredRowsPath: paths.filteredRows,
  };
  });
}


export async function openStageOneGammaExportSnapshot({ exportId, ownerKey }: { exportId: string; ownerKey: string }) {
  const directory = (await findReadableMetadata(exportId))?.directory || EXPORT_DIRECTORY;
  return withExportOperation(exportId, directory, [], async () => {
    const metadata = await readMetadata(exportId, directory);
    if (metadata.ownerHash !== ownerHash(ownerKey)) throw new Error("Stage 1 export does not belong to this session.");
    const rows = await openRegularFile(await readableRows(metadata, directory));
    let filteredRows: FileHandle | null = null;
    try {
      filteredRows = await openRegularFile(exportPaths(exportId, directory).filteredRows).catch(error => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      return { metadata, rows, filteredRows, async close() {
        await rows.close(); await filteredRows?.close();
      } };
    } catch (error) { await rows.close(); await filteredRows?.close(); throw error; }
  });
}

async function reapplyStageOneGammaExportFiltersInternal({
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
  const temporaryFilteredPath = exportTransaction.getStore()?.stages.reapply || `${paths.filteredRows}.reapply.tmp`;
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

  const input = createReadStream(await readableRows(metadata, EXPORT_DIRECTORY), {
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
async function forkUniversalScanInternal(
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
  let immutableRowsStorage: StageOneGammaExportMetadata["immutableRowsStorage"];
  if (process.env.BULLPEN_CANONICAL_EXPORT_STORAGE === "1" && source.metadata.immutableRowsStorage) {
    const recovery = await checkedRecovery(source.metadata);
    const [primaryStat, backupStat] = await Promise.all([stat(source.rowsPath), stat(recovery)]);
    if (primaryStat.dev === backupStat.dev && primaryStat.ino === backupStat.ino) {
      // Recovery became the reader's source after primary corruption. Copy it
      // into a fresh primary; do not alias primary directly to recovery bytes.
      await copyFile(source.rowsPath, paths.rows);
    } else {
      try { await link(source.rowsPath, paths.rows); }
      catch (error) {
        if (!["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
        await copyFile(source.rowsPath, paths.rows);
      }
    }
    const persisted = await open(paths.rows, "r");
    try { await persisted.sync(); } finally { await persisted.close(); }
    const directory = await open(EXPORT_DIRECTORY, "r");
    try { await directory.sync(); } finally { await directory.close(); }
    immutableRowsStorage = source.metadata.immutableRowsStorage;
  } else { await copyFile(source.rowsPath, paths.rows); }
  await writeFile(paths.filteredRows, "", "utf8");
  await saveMetadata({ ...source.metadata, immutableRowsStorage, exportId, ownerHash: ownerHash(ownerKey),
    universalSource: false, sourceScanExportId: source.metadata.exportId,
    sourceScanCompletedAt: source.metadata.updatedAt, filtersCompletedAt: undefined,
    filterPending: true, updatedAt: new Date().toISOString(),
    acceptedCount: 0, rejectedCount: 0, acceptedSample: [], rejectedSample: [], reapplyState: undefined });
  return exportId;
}

const universalImports = new Map<string, Promise<Awaited<ReturnType<typeof openLatestStageOneGammaExport>>>>();

// Preserve the user's existing completed capture when moving the scan surface.
// Reset workflow classifications and drop synthetic wallet-only rows.
async function openUniversalScanInternal(ownerKey: string) {
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
      immutableRowsStorage: undefined, rowsBytes: undefined, rowsSha256: undefined,
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

// Each write operation runs under the same capture/request claim, including
// metadata, page appends, filtered temporaries and fallback copies.
export async function appendStageOneGammaExportPage(args: Parameters<typeof appendStageOneGammaExportPageInternal>[0]) {
  const exportId = args.exportId || randomUUID();
  return withCaptureBudget(`frontend-page:${args.ownerKey}:${exportId}`, () =>
    withExportOperation(exportId, EXPORT_DIRECTORY, ["rows", "filteredRows", "metadata"], () => appendStageOneGammaExportPageInternal(args, exportId)));
}
export async function reapplyStageOneGammaExportFilters(args: Parameters<typeof reapplyStageOneGammaExportFiltersInternal>[0]) {
  return withCaptureBudget(`frontend-filter:${args.exportId}`, () =>
    withExportOperation(args.exportId, EXPORT_DIRECTORY, ["filteredRows", "metadata", "reapply"], () => reapplyStageOneGammaExportFiltersInternal(args)));
}
export async function forkUniversalScan(ownerKey: string, sourceExportId?: string, universalOwnerKey = ownerKey) {
  return withCaptureBudget(`frontend-fork:${ownerKey}`, () => forkUniversalScanInternal(ownerKey, sourceExportId, universalOwnerKey));
}
export async function openUniversalScan(ownerKey: string) {
  return withCaptureBudget(`frontend-import:${ownerKey}`, () => openUniversalScanInternal(ownerKey));
}

export async function withExportStorageBudget<T>(identity: string, execute: () => Promise<T>) {
  return withCaptureBudget(identity, execute);
}
export async function allocateExportFileWrite<T>(path: string, bytes: number, execute: () => Promise<T>) {
  return allocateWrite(path, bytes, execute);
}

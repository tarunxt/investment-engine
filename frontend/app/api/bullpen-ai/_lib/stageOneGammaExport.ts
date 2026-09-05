import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BullpenQuestion } from "@/lib/bullpen-ai";

const EXPORT_DIRECTORY = join(tmpdir(), "credx-bullpen-stage-one-exports");
const EXPORT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const EXPORT_ID_PATTERN = /^[0-9a-f-]{36}$/;

export type StageOneGammaExportRow = {
  candidate: BullpenQuestion;
  event: Record<string, unknown>;
  market: Record<string, unknown>;
  scanStatus: "passed" | "filtered";
  filterReasons: string[];
};

export type StageOneGammaExportMetadata = {
  exportId: string;
  ownerHash: string;
  createdAt: string;
  updatedAt: string;
  rowCount: number;
  completed: boolean;
  processedPages: string[];
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
  await Promise.all(
    names.map(async (name) => {
      const path = join(EXPORT_DIRECTORY, name);
      const details = await stat(path).catch(() => null);
      if (details && now - details.mtimeMs > EXPORT_RETENTION_MS) {
        await rm(path, { force: true });
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
}: {
  exportId: string | null;
  ownerKey: string;
  pageKey: string;
  rows: StageOneGammaExportRow[];
  completed: boolean;
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
    metadata = {
      exportId: resolvedExportId,
      ownerHash: ownerHash(ownerKey),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      rowCount: 0,
      completed: false,
      processedPages: [],
    };
    await writeFile(paths.rows, "", "utf8");
  }

  if (!metadata.processedPages.includes(pageKey)) {
    const payload = rows.map((row) => JSON.stringify(row)).join("\n");
    if (payload) await appendFile(paths.rows, `${payload}\n`, "utf8");
    metadata.rowCount += rows.length;
    metadata.processedPages.push(pageKey);
  }
  metadata.completed ||= completed;
  metadata.updatedAt = new Date().toISOString();
  await saveMetadata(metadata);
  return { exportId: resolvedExportId, rowCount: metadata.rowCount };
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
  return { metadata, rowsPath: exportPaths(exportId).rows };
}

import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  BULLPEN_BIN_CANDIDATES,
  buildBullpenProcessEnv,
  parseBullpenJsonOutput,
} from "./bullpenCli.ts";
import {
  runBullpenCliHealthCheckWithExecutor,
  type BullpenCliExecImplementation,
  type BullpenCliHealth,
} from "./bullpenHealthCore.ts";
import {
  aggregateBullpenCliPositions,
  applyBullpenPositionMarketData,
  normalizeBullpenPosition,
  summarizeBullpenPositions,
  type BullpenCliPosition,
  type BullpenCliPositionsPayload,
  type BullpenLiveSnapshot,
} from "../../../../lib/bullpenPositions.ts";
import {
  buildPolymarketEventUrl,
  resolvePolymarketMarkets,
} from "./polymarketMarketUrls.ts";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;
const SNAPSHOT_FILE_NAME = "last-successful-live-snapshot.json";
const HEALTH_FILE_NAME = "bullpen-health.json";

export type BullpenLiveSnapshotSyncResult = {
  ok: boolean;
  health: BullpenCliHealth;
  payload: BullpenCliPositionsPayload | null;
  snapshot: BullpenLiveSnapshot | null;
};

export type BullpenHealthReport = {
  ok: boolean;
  liveAvailable: boolean;
  checkedAt: string;
  health: BullpenCliHealth;
  lastSuccessfulLiveSnapshot: {
    fetchedAt: string;
    source: "live-cli";
    positionsCount: number;
    claimableCount: number;
  } | null;
};

function getBullpenStateDir() {
  const configured = process.env.BULLPEN_HEALTH_STATE_DIR?.trim();
  if (configured) {
    return configured;
  }

  return path.join(
    /* turbopackIgnore: true */ process.cwd(),
    ".runtime",
    "bullpen-ai",
  );
}

function getBullpenStatePaths() {
  const dir = getBullpenStateDir();
  return {
    dir,
    snapshotFilePath: path.join(dir, SNAPSHOT_FILE_NAME),
    healthFilePath: path.join(dir, HEALTH_FILE_NAME),
  };
}

async function writeJsonAtomic(filePath: string, payload: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempFilePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tempFilePath, filePath);
}

const execBullpenCommand: BullpenCliExecImplementation = async (
  file,
  args,
  options,
) => {
  const result = await execFileAsync(file, args, {
    env: options.env as NodeJS.ProcessEnv,
    timeout: options.timeoutMs,
    maxBuffer: options.maxBuffer,
  });

  return {
    stdout: typeof result.stdout === "string" ? result.stdout : String(result.stdout),
    stderr: typeof result.stderr === "string" ? result.stderr : String(result.stderr),
    exitCode: 0,
    signal: null,
  };
};

async function buildBullpenLiveSnapshot(
  payload: BullpenCliPositionsPayload,
  fetchedAt: string,
) {
  const rawPositions = Array.isArray(payload.positions)
    ? (payload.positions as BullpenCliPosition[])
    : [];
  const aggregatedRawPositions = aggregateBullpenCliPositions(rawPositions);
  const positions = aggregatedRawPositions.map((position) =>
    normalizeBullpenPosition(position, buildPolymarketEventUrl),
  );
  let refreshedPositions = positions;

  try {
    const refreshedMarkets = await resolvePolymarketMarkets(
      aggregatedRawPositions.map((position, index) => ({
        id: positions[index]?.key || `bullpen-position-${index + 1}`,
        slug:
          typeof position.slug === "string" && position.slug.trim()
            ? position.slug.trim()
            : null,
        marketUrl: positions[index]?.marketUrl ?? null,
      })),
    );
    refreshedPositions = positions.map((position) => {
      const refreshedMarket = refreshedMarkets[position.key];
      return refreshedMarket
        ? applyBullpenPositionMarketData(position, refreshedMarket)
        : position;
    });
  } catch {
    // Keep the live Bullpen wallet snapshot even if Polymarket enrichment fails.
  }

  return {
    positions: refreshedPositions,
    summary: summarizeBullpenPositions(refreshedPositions, payload.summary || {}),
    fetchedAt,
    source: "live-cli",
  } satisfies BullpenLiveSnapshot;
}

function isBullpenLiveSnapshot(value: unknown): value is BullpenLiveSnapshot {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.source === "live-cli" &&
    typeof record.fetchedAt === "string" &&
    Array.isArray(record.positions) &&
    Boolean(record.summary && typeof record.summary === "object")
  );
}

export async function readLastSuccessfulBullpenLiveSnapshot() {
  try {
    const { snapshotFilePath } = getBullpenStatePaths();
    const raw = await readFile(snapshotFilePath, "utf8");
    const parsed = JSON.parse(raw);
    return isBullpenLiveSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeLastSuccessfulBullpenLiveSnapshot(
  snapshot: BullpenLiveSnapshot,
) {
  const { snapshotFilePath } = getBullpenStatePaths();
  await writeJsonAtomic(snapshotFilePath, snapshot);
}

export function buildBullpenHealthReport({
  health,
  snapshot,
}: {
  health: BullpenCliHealth;
  snapshot: BullpenLiveSnapshot | null;
}): BullpenHealthReport {
  return {
    ok: health.ok,
    liveAvailable: health.ok,
    checkedAt: health.timestamp,
    health,
    lastSuccessfulLiveSnapshot: snapshot
      ? {
          fetchedAt: snapshot.fetchedAt,
          source: snapshot.source,
          positionsCount: snapshot.positions.length,
          claimableCount: snapshot.positions.filter((position) => position.isClaimable)
            .length,
        }
      : null,
  };
}

export async function writeBullpenHealthReport(report: BullpenHealthReport) {
  const { healthFilePath } = getBullpenStatePaths();
  await writeJsonAtomic(healthFilePath, report);
}

export async function syncBullpenLiveSnapshot({
  commandCandidates = BULLPEN_BIN_CANDIDATES,
  execFileImpl = execBullpenCommand,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBuffer = DEFAULT_MAX_BUFFER,
  now = () => new Date().toISOString(),
}: {
  commandCandidates?: string[];
  execFileImpl?: BullpenCliExecImplementation;
  timeoutMs?: number;
  maxBuffer?: number;
  now?: () => string;
} = {}): Promise<BullpenLiveSnapshotSyncResult> {
  const env = buildBullpenProcessEnv({ readOnly: true });
  const healthCheck = await runBullpenCliHealthCheckWithExecutor<BullpenCliPositionsPayload>(
    {
      commandCandidates,
      env,
      execFileImpl,
      parseJsonOutput: parseBullpenJsonOutput,
      timeoutMs,
      maxBuffer,
      now,
    },
  );

  if (!healthCheck.ok || !healthCheck.payload) {
    return {
      ok: false,
      health: healthCheck.health,
      payload: null,
      snapshot: null,
    };
  }

  const snapshot = await buildBullpenLiveSnapshot(
    healthCheck.payload,
    healthCheck.health.timestamp,
  );

  try {
    await writeLastSuccessfulBullpenLiveSnapshot(snapshot);
  } catch {
    // Keep the live response usable even if the snapshot file cannot be updated.
  }

  return {
    ok: true,
    health: healthCheck.health,
    payload: healthCheck.payload,
    snapshot,
  };
}

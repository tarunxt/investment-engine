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
  buildClaimableBullpenSignature,
  buildBullpenPositionsDiagnostics,
  extractBullpenCliPositionRows,
  filterDisplayBullpenPositions,
  normalizeBullpenPosition,
  summarizeBullpenPositions,
  type BullpenCliPositionsPayload,
  type BullpenLiveSnapshot,
} from "../../../../lib/bullpenPositions.ts";
import { redactBullpenSensitiveText } from "./bullpenHealthCore.ts";
import {
  buildPolymarketEventUrl,
  resolvePolymarketMarketsWithQuestionFallback,
} from "./polymarketMarketUrls.ts";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;
const DEFAULT_REDEEM_TIMEOUT_MS = 180_000;
const DEFAULT_AUTO_CLAIM_RETRY_COOLDOWN_MS = 60_000;
const SNAPSHOT_FILE_NAME = "last-successful-live-snapshot.json";
const HEALTH_FILE_NAME = "bullpen-health.json";
const AUTO_CLAIM_STATE_FILE_NAME = "bullpen-auto-claim.json";

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
  autoClaim: BullpenAutoClaimResult | null;
  lastSuccessfulLiveSnapshot: {
    fetchedAt: string;
    source: "live-cli";
    positionsCount: number;
    claimableCount: number;
  } | null;
};

export type BullpenAutoClaimResult = {
  enabled: boolean;
  attempted: boolean;
  submitted: boolean;
  skippedReason: string | null;
  attemptedAt: string | null;
  claimableCount: number;
  claimableSignature: string | null;
  error: string | null;
};

type BullpenAutoClaimState = {
  lastClaimableSignature: string | null;
  lastAttemptedAt: string | null;
  lastSubmittedAt: string | null;
  lastError: string | null;
};

const EMPTY_AUTO_CLAIM_STATE: BullpenAutoClaimState = {
  lastClaimableSignature: null,
  lastAttemptedAt: null,
  lastSubmittedAt: null,
  lastError: null,
};

function getBullpenStateDir() {
  const configured = process.env.BULLPEN_HEALTH_STATE_DIR?.trim();
  if (configured) {
    return configured;
  }

  return path.join("/tmp", "investment-engine", "bullpen-ai");
}

function getBullpenStatePaths() {
  const dir = getBullpenStateDir();
  return {
    dir,
    snapshotFilePath: path.join(dir, SNAPSHOT_FILE_NAME),
    healthFilePath: path.join(dir, HEALTH_FILE_NAME),
    autoClaimStateFilePath: path.join(dir, AUTO_CLAIM_STATE_FILE_NAME),
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
  const rawPositions = extractBullpenCliPositionRows(payload.positions ?? payload);
  const aggregatedRawPositions = aggregateBullpenCliPositions(rawPositions);
  const normalizedPositions = aggregatedRawPositions.map((position) =>
    normalizeBullpenPosition(position, buildPolymarketEventUrl),
  );
  let refreshedPositions = normalizedPositions;

  try {
    const refreshedMarkets = await resolvePolymarketMarketsWithQuestionFallback(
      aggregatedRawPositions.map((position, index) => ({
        id:
          normalizedPositions[index]?.key || `bullpen-position-${index + 1}`,
        slug:
          typeof position.slug === "string" && position.slug.trim()
            ? position.slug.trim()
            : null,
        marketUrl: normalizedPositions[index]?.marketUrl ?? null,
        question: normalizedPositions[index]?.marketTitle ?? null,
      })),
    );
    refreshedPositions = normalizedPositions.map((position) => {
      const refreshedMarket = refreshedMarkets[position.key];
      return refreshedMarket
        ? applyBullpenPositionMarketData(position, refreshedMarket)
        : position;
    });
  } catch {
    // Keep the live Bullpen wallet snapshot even if Polymarket enrichment fails.
  }

  const diagnostics = buildBullpenPositionsDiagnostics(refreshedPositions);
  const positions = filterDisplayBullpenPositions(refreshedPositions);

  return {
    positions,
    summary: summarizeBullpenPositions(positions, payload.summary || {}),
    diagnostics,
    fetchedAt,
    source: "live-cli",
  } satisfies BullpenLiveSnapshot;
}

function isBullpenAutoClaimEnabled() {
  const configured = process.env.BULLPEN_AUTO_CLAIM_RESOLVED?.trim().toLowerCase();
  if (!configured) {
    return false;
  }

  return configured === "true";
}

function getBullpenAutoClaimRetryCooldownMs() {
  const raw = process.env.BULLPEN_AUTO_CLAIM_RETRY_COOLDOWN_MS?.trim();
  if (!raw) {
    return DEFAULT_AUTO_CLAIM_RETRY_COOLDOWN_MS;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_AUTO_CLAIM_RETRY_COOLDOWN_MS;
  }

  return parsed;
}

function isBullpenAutoClaimState(value: unknown): value is BullpenAutoClaimState {
  if (!value || typeof value !== "object") return false;

  const record = value as Record<string, unknown>;
  const fields = [
    "lastClaimableSignature",
    "lastAttemptedAt",
    "lastSubmittedAt",
    "lastError",
  ] as const;

  return fields.every((field) => {
    const current = record[field];
    return current === null || typeof current === "string";
  });
}

async function readBullpenAutoClaimState() {
  try {
    const { autoClaimStateFilePath } = getBullpenStatePaths();
    const raw = await readFile(autoClaimStateFilePath, "utf8");
    const parsed = JSON.parse(raw);
    return isBullpenAutoClaimState(parsed) ? parsed : EMPTY_AUTO_CLAIM_STATE;
  } catch {
    return EMPTY_AUTO_CLAIM_STATE;
  }
}

async function writeBullpenAutoClaimState(state: BullpenAutoClaimState) {
  const { autoClaimStateFilePath } = getBullpenStatePaths();
  await writeJsonAtomic(autoClaimStateFilePath, state);
}

function isMissingBullpenCommandError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /enoent|not found|no such file or directory/i.test(message);
}

function buildBullpenRedeemErrorMessage(error: unknown) {
  if (error instanceof Error) {
    const processError = error as Error & {
      stdout?: string;
      stderr?: string;
    };
    return (
      redactBullpenSensitiveText(processError.stderr)?.trim() ||
      redactBullpenSensitiveText(processError.stdout)?.trim() ||
      redactBullpenSensitiveText(processError.message)?.trim() ||
      "Bullpen redeem failed."
    );
  }

  return redactBullpenSensitiveText(String(error))?.trim() || "Bullpen redeem failed.";
}

async function runBullpenRedeemCommand({
  commandCandidates = BULLPEN_BIN_CANDIDATES,
  execFileImpl = execBullpenCommand,
  timeoutMs = DEFAULT_REDEEM_TIMEOUT_MS,
  maxBuffer = DEFAULT_MAX_BUFFER,
}: {
  commandCandidates?: string[];
  execFileImpl?: BullpenCliExecImplementation;
  timeoutMs?: number;
  maxBuffer?: number;
}) {
  const env = buildBullpenProcessEnv({ readOnly: false });
  let lastError: unknown = null;

  for (const candidate of commandCandidates) {
    try {
      await execFileImpl(
        candidate,
        ["polymarket", "redeem", "--yes", "--non-interactive", "--output", "json"],
        {
          env,
          timeoutMs,
          maxBuffer,
        },
      );
      return;
    } catch (error) {
      lastError = error;
      if (isMissingBullpenCommandError(error)) {
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error("Bullpen redeem command is unavailable.");
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
  autoClaim = null,
}: {
  health: BullpenCliHealth;
  snapshot: BullpenLiveSnapshot | null;
  autoClaim?: BullpenAutoClaimResult | null;
}): BullpenHealthReport {
  return {
    ok: health.ok,
    liveAvailable: health.ok,
    checkedAt: health.timestamp,
    health,
    autoClaim,
    lastSuccessfulLiveSnapshot: snapshot
      ? {
          fetchedAt: snapshot.fetchedAt,
          source: snapshot.source,
          positionsCount: snapshot.positions.length,
          claimableCount: snapshot.summary.claimableCount,
        }
      : null,
  };
}

export async function writeBullpenHealthReport(report: BullpenHealthReport) {
  const { healthFilePath } = getBullpenStatePaths();
  await writeJsonAtomic(healthFilePath, report);
}

export async function autoClaimBullpenResolvedPositions(
  snapshot: BullpenLiveSnapshot,
  {
    commandCandidates = BULLPEN_BIN_CANDIDATES,
    execFileImpl = execBullpenCommand,
    maxBuffer = DEFAULT_MAX_BUFFER,
    now = () => new Date().toISOString(),
  }: {
    commandCandidates?: string[];
    execFileImpl?: BullpenCliExecImplementation;
    maxBuffer?: number;
    now?: () => string;
  } = {},
): Promise<BullpenAutoClaimResult> {
  const enabled = isBullpenAutoClaimEnabled();
  const claimableSignature = buildClaimableBullpenSignature(snapshot.positions) || null;
  const claimableCount = snapshot.positions.filter((position) => position.isClaimable).length;

  if (!enabled) {
    return {
      enabled,
      attempted: false,
      submitted: false,
      skippedReason: "disabled",
      attemptedAt: null,
      claimableCount,
      claimableSignature,
      error: null,
    };
  }

  if (!claimableSignature || claimableCount === 0) {
    const existingState = await readBullpenAutoClaimState();
    if (
      existingState.lastClaimableSignature ||
      existingState.lastAttemptedAt ||
      existingState.lastSubmittedAt ||
      existingState.lastError
    ) {
      await writeBullpenAutoClaimState(EMPTY_AUTO_CLAIM_STATE);
    }
    return {
      enabled,
      attempted: false,
      submitted: false,
      skippedReason: "no-claimable-positions",
      attemptedAt: null,
      claimableCount: 0,
      claimableSignature: null,
      error: null,
    };
  }

  const currentState = await readBullpenAutoClaimState();
  const attemptedAt = now();
  const cooldownMs = getBullpenAutoClaimRetryCooldownMs();
  const lastAttemptMs = currentState.lastAttemptedAt
    ? Date.parse(currentState.lastAttemptedAt)
    : Number.NaN;
  const attemptedAtMs = Date.parse(attemptedAt);
  const sameSignature = currentState.lastClaimableSignature === claimableSignature;

  if (
    sameSignature &&
    Number.isFinite(lastAttemptMs) &&
    Number.isFinite(attemptedAtMs) &&
    attemptedAtMs - lastAttemptMs < cooldownMs
  ) {
    return {
      enabled,
      attempted: false,
      submitted: false,
      skippedReason: "cooldown",
      attemptedAt: currentState.lastAttemptedAt,
      claimableCount,
      claimableSignature,
      error: currentState.lastError,
    };
  }

  try {
    await runBullpenRedeemCommand({
      commandCandidates,
      execFileImpl,
      maxBuffer,
    });
    await writeBullpenAutoClaimState({
      lastClaimableSignature: claimableSignature,
      lastAttemptedAt: attemptedAt,
      lastSubmittedAt: attemptedAt,
      lastError: null,
    });
    return {
      enabled,
      attempted: true,
      submitted: true,
      skippedReason: null,
      attemptedAt,
      claimableCount,
      claimableSignature,
      error: null,
    };
  } catch (error) {
    const message = buildBullpenRedeemErrorMessage(error);
    await writeBullpenAutoClaimState({
      lastClaimableSignature: claimableSignature,
      lastAttemptedAt: attemptedAt,
      lastSubmittedAt: currentState.lastSubmittedAt,
      lastError: message,
    });
    return {
      enabled,
      attempted: true,
      submitted: false,
      skippedReason: null,
      attemptedAt,
      claimableCount,
      claimableSignature,
      error: message,
    };
  }
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

import { NextRequest } from "next/server";

import { redactBullpenSensitiveText } from "../_lib/bullpenHealthCore.ts";
import { resolvePolymarketMarketsWithQuestionFallback } from "../_lib/polymarketMarketUrls";
import {
  backendSessionJson,
  createBackendSessionContext,
  fetchBackendJsonWithSession,
  type BackendSessionContext,
} from "../_lib/serverBackendSession";
import {
  aggregateBullpenCliPositions,
  applyBullpenPositionMarketData,
  buildBullpenPositionsDiagnostics,
  buildTrackedBullpenPositionViews,
  extractBullpenCliPositionRows,
  filterDisplayBullpenPositions,
  normalizeBullpenPosition,
  summarizeBullpenPositions,
  type BullpenActivePositionView,
  type BullpenCliPositionsPayload,
  type BullpenLiveHealth,
  type BullpenLiveSnapshot,
  type BullpenPositionsResponse,
  type BullpenPositionsSnapshotLineage,
} from "@/lib/bullpenPositions";
import type { PolymarketBotState } from "@/types/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BULLPEN_007_EXPECTED_ACCOUNT_IDENTITY =
  process.env.BULLPEN_007_WALLET_ADDRESS?.trim() ||
  "0xa70b18abdebf0704b41901c33e8477ea1085afdf";

type BackendBullpenCredentialArtifact = {
  path?: string | null;
  inode?: number | null;
  mtime_ns?: number | null;
  size?: number | null;
};

type BackendBullpenCommandDiagnostics = {
  effective_home?: string | null;
  bullpen_version?: string | null;
  error_classification?: string | null;
  credential_artifact?: BackendBullpenCredentialArtifact | null;
  refresh_requested_at?: string | null;
  caller_source?: string | null;
  snapshot_producer_source?: string | null;
  produced_by_another_refresh?: boolean | null;
  refresh_lock_key?: string | null;
  refresh_lock_wait_ms?: number | null;
  refresh_lock_ttl_seconds?: number | null;
  refresh_lock_age_ms?: number | null;
};

type BackendBullpenBrokerHealth = {
  ok?: boolean;
  checked_at?: string | null;
  message?: string | null;
  command_category?: string | null;
  error_classification?: string | null;
  cli_version?: string | null;
  command_path?: string | null;
  effective_home?: string | null;
  credential_artifact?: BackendBullpenCredentialArtifact | null;
};

type BackendBullpenRuntimeFailure = {
  occurred_at?: string | null;
  command_category?: string | null;
  classification?: string | null;
  message?: string | null;
};

type BackendBullpenPositionsSnapshot = {
  payload: BullpenCliPositionsPayload | Record<string, unknown> | null;
  fetched_at: string;
  cli_version?: string | null;
  credential_artifact?: BackendBullpenCredentialArtifact | null;
  account_identity?: string | null;
  position_classifier_version?: number | null;
  auth_checked_at?: string | null;
  source?: string | null;
  freshness_state?: string | null;
  diagnostics?: BackendBullpenCommandDiagnostics | null;
};

type BackendBullpenRuntimePositionsResponse = {
  ok: boolean;
  snapshot?: BackendBullpenPositionsSnapshot | null;
  stale_snapshot?: BackendBullpenPositionsSnapshot | null;
  broker_health?: BackendBullpenBrokerHealth | null;
  auth_checked_at?: string | null;
  last_failure?: BackendBullpenRuntimeFailure | null;
  cli_version?: string | null;
  error?: string | null;
};

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function buildSnapshotLineage(
  snapshot: BackendBullpenPositionsSnapshot,
): BullpenPositionsSnapshotLineage {
  const credentialArtifact =
    snapshot.credential_artifact ?? snapshot.diagnostics?.credential_artifact;
  return {
    accountIdentity: snapshot.account_identity?.trim() || null,
    credentialArtifact: {
      inode: credentialArtifact?.inode ?? null,
      mtimeNs: credentialArtifact?.mtime_ns ?? null,
      size: credentialArtifact?.size ?? null,
    },
    positionClassifierVersion:
      typeof snapshot.position_classifier_version === "number" &&
      Number.isFinite(snapshot.position_classifier_version)
        ? snapshot.position_classifier_version
        : null,
    source: snapshot.source?.trim() || null,
    freshnessState: snapshot.freshness_state?.trim() || null,
  };
}

function buildPolymarketEventUrl(slug: string | null) {
  return slug ? `https://polymarket.com/event/${slug}` : null;
}

function coerceErrorMessage(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return redactBullpenSensitiveText(value)?.trim() || null;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return (
      coerceErrorMessage(record.error) ||
      coerceErrorMessage(record.message) ||
      coerceErrorMessage(record.detail) ||
      null
    );
  }
  return null;
}

function isTruthyQueryValue(value: string | null) {
  return ["1", "true", "yes"].includes(value?.trim().toLowerCase() || "");
}

function isFalsyQueryValue(value: string | null) {
  return ["0", "false", "no"].includes(value?.trim().toLowerCase() || "");
}

function normalizeHealthClassification(
  value: string | null | undefined,
): BullpenLiveHealth["classification"] {
  const normalized = (value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (
    normalized.includes("auth_rejected") ||
    normalized.includes("refresh token rejected") ||
    normalized.includes("invalid refresh token") ||
    normalized.includes("jwt expired") ||
    normalized.includes("session expired") ||
    normalized.includes("login required")
  ) {
    return "AUTH_EXPIRED";
  }
  if (
    normalized.includes("auth required") ||
    normalized.includes("not logged in") ||
    normalized.includes("not authenticated") ||
    normalized.includes("requires login") ||
    normalized.includes("requires_auth")
  ) {
    return "AUTH_REQUIRED";
  }
  if (normalized.includes("timeout") || normalized.includes("lock_timeout")) {
    return "TIMEOUT";
  }
  if (normalized.includes("missing_runtime") || normalized.includes("not found")) {
    return "BINARY_MISSING";
  }
  if (normalized.includes("json_parse")) return "JSON_PARSE_ERROR";
  if (
    normalized.includes("transport") ||
    normalized.includes("network") ||
    normalized.includes("bad gateway") ||
    normalized.includes("connection reset") ||
    normalized.includes("fetch failed")
  ) {
    return "NETWORK_ERROR";
  }
  return "UNKNOWN_ERROR";
}

function buildHealthActionNeeded(
  classification: BullpenLiveHealth["classification"],
  credentialHome: string | null,
) {
  switch (classification) {
    case "AUTH_REQUIRED":
    case "AUTH_EXPIRED":
      return credentialHome
        ? `Verify Bullpen auth in the backend runtime using HOME=${credentialHome}. Cred-X will not start device login automatically.`
        : "Verify Bullpen auth in the backend runtime. Cred-X will not start device login automatically.";
    case "BINARY_MISSING":
      return "Install Bullpen at /usr/local/bin/bullpen or fix BULLPEN_BIN in the backend runtime.";
    case "NETWORK_ERROR":
      return "Check backend network reachability to Bullpen/Polymarket services, then retry.";
    case "TIMEOUT":
      return "Bullpen runtime timed out while refreshing the wallet. Retry after the current refresh completes.";
    case "JSON_PARSE_ERROR":
      return "Bullpen returned malformed JSON. Inspect backend runtime logs for the sanitized failure details.";
    default:
      return null;
  }
}

function buildLiveHealth(
  payload: BackendBullpenRuntimePositionsResponse | null,
  snapshot: BackendBullpenPositionsSnapshot | null,
): BullpenLiveHealth | null {
  if (!payload && !snapshot) return null;
  const brokerHealth = payload?.broker_health || null;
  const lastFailure = payload?.last_failure || null;
  const displaySnapshotAvailable = Boolean(snapshot?.payload);
  const runtimeReady = Boolean(payload?.ok && displaySnapshotAvailable);
  const diagnosticClassification =
    snapshot?.diagnostics?.error_classification ||
    brokerHealth?.error_classification ||
    lastFailure?.classification ||
    payload?.error;
  const classification = runtimeReady
    ? null
    : normalizeHealthClassification(diagnosticClassification);
  const credentialHome =
    brokerHealth?.effective_home ||
    snapshot?.diagnostics?.effective_home ||
    "/home/investor";
  const commandPath =
    brokerHealth?.command_path || process.env.BULLPEN_BIN || "/usr/local/bin/bullpen";
  return {
    ok: runtimeReady,
    classification,
    stdout: null,
    stderr: null,
    exitCode: null,
    signal: null,
    commandPath,
    attemptedPaths: [commandPath],
    timedOut: classification === "TIMEOUT",
    timestamp:
      snapshot?.fetched_at ||
      snapshot?.auth_checked_at ||
      payload?.auth_checked_at ||
      brokerHealth?.checked_at ||
      lastFailure?.occurred_at ||
      new Date().toISOString(),
    credentialHome,
    message: runtimeReady
      ? "Bullpen wallet display snapshot is available."
      : coerceErrorMessage(payload?.error) ||
        coerceErrorMessage(lastFailure?.message) ||
        coerceErrorMessage(brokerHealth?.message) ||
        "Bullpen runtime health is unavailable.",
    actionNeeded: buildHealthActionNeeded(classification, credentialHome),
  };
}

async function loadTrackedPositionsFallback(context: BackendSessionContext) {
  const state = await fetchBackendJsonWithSession<PolymarketBotState>(
    context,
    "/polymarket/state",
  );
  const openPositions = Array.isArray(state.open_positions)
    ? state.open_positions.filter((position) => position.shares > 0)
    : [];
  if (openPositions.length === 0) {
    return {
      positions: [],
      summary: summarizeBullpenPositions([], {}),
      diagnostics: buildBullpenPositionsDiagnostics([]),
      fetchedAt: new Date().toISOString(),
    };
  }

  let marketUpdates = {};
  try {
    marketUpdates = await resolvePolymarketMarketsWithQuestionFallback(
      openPositions.map((position) => ({
        id: position.key,
        slug: null,
        marketUrl: null,
        question: position.market_title,
      })),
      {
        backendAccessToken: context.accessToken,
        allowRuntimeQuestionFallback: false,
        runtimeSearch: (path, options) =>
          fetchBackendJsonWithSession(context, path, options),
      },
    );
  } catch {
    // The tracked fallback remains usable without enrichment.
  }

  const positions = buildTrackedBullpenPositionViews(openPositions, marketUpdates);
  return {
    positions,
    summary: summarizeBullpenPositions(positions, {}),
    diagnostics: buildBullpenPositionsDiagnostics(positions),
    fetchedAt: new Date().toISOString(),
  };
}

async function enrichPositionsWithPolymarketData(
  positions: BullpenActivePositionView[] | undefined,
  context: BackendSessionContext,
  options: { allowRuntimeQuestionFallback: boolean },
) {
  const normalizedPositions = Array.isArray(positions) ? positions : [];
  if (normalizedPositions.length === 0) return normalizedPositions;
  try {
    const marketUpdates = await resolvePolymarketMarketsWithQuestionFallback(
      normalizedPositions.map((position) => ({
        id: position.key,
        conditionId: position.conditionId,
        slug: position.marketSlug ?? position.slug,
        marketUrl: position.marketUrl,
        question: position.marketTitle,
      })),
      {
        backendAccessToken: context.accessToken,
        allowRuntimeQuestionFallback: options.allowRuntimeQuestionFallback,
        maxRuntimeQuestionFallbacks: 1,
        runtimeSearch: (path, options) =>
          fetchBackendJsonWithSession(context, path, options),
      },
    );
    return normalizedPositions.map((position) =>
      applyBullpenPositionMarketData(position, marketUpdates[position.key] || {}),
    );
  } catch {
    return normalizedPositions;
  }
}

async function buildLiveSnapshotFromBackend(
  snapshot: BackendBullpenPositionsSnapshot | null | undefined,
  context: BackendSessionContext,
  options: { allowRuntimeQuestionFallback: boolean },
): Promise<BullpenLiveSnapshot | null> {
  if (!snapshot || !snapshot.payload) return null;
  const payload = snapshot.payload as BullpenCliPositionsPayload;
  const rawPositions = extractBullpenCliPositionRows(payload.positions ?? payload);
  const aggregatedPositions = aggregateBullpenCliPositions(rawPositions);
  const normalizedPositions = aggregatedPositions.map((position) =>
    normalizeBullpenPosition(position, buildPolymarketEventUrl),
  );
  const enrichedPositions = await enrichPositionsWithPolymarketData(
    normalizedPositions,
    context,
    options,
  );
  const filteredPositions = filterDisplayBullpenPositions(enrichedPositions);
  return {
    positions: filteredPositions,
    summary: summarizeBullpenPositions(filteredPositions, payload.summary || {}),
    diagnostics: buildBullpenPositionsDiagnostics(enrichedPositions),
    fetchedAt: snapshot.fetched_at,
    source: snapshot.source === "redis-cache" ? "redis-cache" : "live-cli",
    lineage: buildSnapshotLineage(snapshot),
  } satisfies BullpenLiveSnapshot;
}

function displayFallbackMessage(snapshot: BullpenLiveSnapshot) {
  return snapshot.source === "redis-cache"
    ? "Showing the shared Bullpen wallet display snapshot. It is current portfolio evidence but is not execution authorization for auto-trade or auto-claim."
    : "Showing the last Bullpen wallet snapshot because an execution-fresh refresh is not currently available.";
}

async function trackedFallbackResponse(
  backendSession: BackendSessionContext,
  health: BullpenLiveHealth | null,
  error: string | null,
) {
  try {
    const trackedFallback = await loadTrackedPositionsFallback(backendSession);
    return backendSessionJson(backendSession, {
      positions: trackedFallback.positions,
      summary: trackedFallback.summary,
      diagnostics: trackedFallback.diagnostics,
      fetchedAt: trackedFallback.fetchedAt,
      liveAvailable: false,
      positionsSource: "tracked-positions",
      health,
      lastSuccessfulLiveSnapshot: null,
      lineage: null,
      fallback: {
        active: true,
        source: "tracked-positions",
        message:
          "No shared Bullpen wallet display snapshot could be resolved, so Cred-X is showing tracked positions only. Do not auto-trade or auto-claim from fallback data.",
      },
      error: error || undefined,
    } satisfies BullpenPositionsResponse);
  } catch (fallbackError) {
    const fallbackMessage =
      redactBullpenSensitiveText(
        fallbackError instanceof Error
          ? fallbackError.message
          : String(fallbackError),
      ) || "Tracked-position fallback failed.";
    return backendSessionJson(
      backendSession,
      {
        positions: [],
        summary: summarizeBullpenPositions([], {}),
        diagnostics: buildBullpenPositionsDiagnostics([]),
        fetchedAt: health?.timestamp || new Date().toISOString(),
        liveAvailable: false,
        positionsSource: null,
        health,
        lastSuccessfulLiveSnapshot: null,
        lineage: null,
        fallback: { active: false, source: null, message: null },
        error: `${error || "Bullpen runtime is unavailable."} Tracked-position fallback also failed: ${fallbackMessage}`,
      } satisfies BullpenPositionsResponse,
      { status: 503 },
    );
  }
}

export async function GET(request: NextRequest) {
  const backendSession = await createBackendSessionContext(request);
  const forceFresh = isTruthyQueryValue(
    request.nextUrl.searchParams.get("force_fresh"),
  );
  const passiveValue = request.nextUrl.searchParams.get("passive");
  const passive = forceFresh
    ? false
    : passiveValue === null
      ? true
      : !isFalsyQueryValue(passiveValue);
  const callerSource =
    request.nextUrl.searchParams.get("caller_source")?.trim() ||
    (passive ? "frontend-passive" : "frontend-active");
  const requestedMaxAge = Number.parseInt(
    request.nextUrl.searchParams.get("max_age_seconds") || "",
    10,
  );
  const maxAgeSeconds = Number.isFinite(requestedMaxAge)
    ? Math.min(Math.max(requestedMaxAge, 0), 300)
    : passive
      ? 300
      : 20;

  let backendPositions: BackendBullpenRuntimePositionsResponse | null = null;
  try {
    const backendQuery = new URLSearchParams({
      force_fresh: forceFresh ? "true" : "false",
      max_age_seconds: String(maxAgeSeconds),
      caller_source: callerSource,
      expected_account_identity: BULLPEN_007_EXPECTED_ACCOUNT_IDENTITY,
    });
    if (passive) {
      backendQuery.set("passive", "true");
    }
    backendPositions =
      await fetchBackendJsonWithSession<BackendBullpenRuntimePositionsResponse>(
        backendSession,
        `/polymarket/runtime/positions/display?${backendQuery.toString()}`,
      );
  } catch (error) {
    const sanitizedMessage =
      redactBullpenSensitiveText(
        error instanceof Error ? error.message : String(error),
      ) || "Backend Bullpen runtime request failed.";
    return trackedFallbackResponse(backendSession, null, sanitizedMessage);
  }

  const liveSnapshot = await buildLiveSnapshotFromBackend(
    backendPositions.snapshot || null,
    backendSession,
    { allowRuntimeQuestionFallback: !passive },
  );
  const staleSnapshot = await buildLiveSnapshotFromBackend(
    backendPositions.stale_snapshot || null,
    backendSession,
    { allowRuntimeQuestionFallback: false },
  );
  const backendSnapshot =
    backendPositions.snapshot || backendPositions.stale_snapshot || null;
  const health = buildLiveHealth(backendPositions, backendSnapshot);
  const backendError = coerceErrorMessage(backendPositions.error);

  const executionFresh = Boolean(
    backendPositions.ok &&
      backendPositions.snapshot &&
      backendPositions.snapshot.source === "live-cli" &&
      backendPositions.snapshot.freshness_state === "fresh" &&
      liveSnapshot,
  );
  if (executionFresh && liveSnapshot) {
    return backendSessionJson(backendSession, {
      positions: liveSnapshot.positions,
      summary: liveSnapshot.summary,
      diagnostics: liveSnapshot.diagnostics,
      fetchedAt: liveSnapshot.fetchedAt,
      liveAvailable: true,
      positionsSource: "live-cli",
      health,
      lastSuccessfulLiveSnapshot: liveSnapshot,
      lineage: liveSnapshot.lineage ?? null,
      fallback: { active: false, source: null, message: null },
    } satisfies BullpenPositionsResponse);
  }

  const displaySnapshot = liveSnapshot ?? staleSnapshot;
  if (displaySnapshot) {
    const displayOnly = displaySnapshot.source === "redis-cache";
    return backendSessionJson(backendSession, {
      positions: displaySnapshot.positions,
      summary: displaySnapshot.summary,
      diagnostics: displaySnapshot.diagnostics,
      fetchedAt: displaySnapshot.fetchedAt,
      liveAvailable: false,
      // A display cache is usable portfolio evidence, not a failed tracked
      // fallback. Expose its real source so both pages render the same rows.
      positionsSource: displayOnly
        ? "redis-cache"
        : "last-successful-live-snapshot",
      health,
      // Crucial: do not feed display-only Redis evidence into the main page's
      // execution-lineage preservation state. Doing so caused a later Refresh
      // to preserve yesterday's Stage-1/live snapshot instead of new wallet data.
      lastSuccessfulLiveSnapshot: displayOnly ? null : displaySnapshot,
      lineage: displaySnapshot.lineage ?? null,
      fallback: {
        active: true,
        source: displayOnly ? "redis-cache" : "last-successful-live-snapshot",
        message: displayFallbackMessage(displaySnapshot),
      },
      error: backendError || undefined,
    } satisfies BullpenPositionsResponse);
  }

  return trackedFallbackResponse(backendSession, health, backendError);
}

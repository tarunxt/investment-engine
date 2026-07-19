import { NextRequest, NextResponse } from "next/server";

import { fetchBackendRuntimeJson } from "../_lib/backendBullpenRuntime";
import { redactBullpenSensitiveText } from "../_lib/bullpenHealthCore.ts";
import { resolvePolymarketMarketsWithQuestionFallback } from "../_lib/polymarketMarketUrls";
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
} from "@/lib/bullpenPositions";
import type { PolymarketBotState } from "@/types/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type BullpenFallbackSource =
  | "last-successful-live-snapshot"
  | "tracked-positions"
  | null;

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

async function parseJsonResponse(response: Response) {
  const text = await response.text();
  if (!text.trim()) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function loadTrackedPositionsFallback(request: NextRequest) {
  const backendStateUrl = new URL("/backend-api/polymarket/state", request.url);
  const accessToken = request.cookies.get("app_access_token")?.value || null;
  const response = await fetch(backendStateUrl, {
    headers: accessToken
      ? {
          Authorization: `Bearer ${accessToken}`,
        }
      : undefined,
    cache: "no-store",
  });
  const payload = await parseJsonResponse(response);

  if (!response.ok) {
    throw new Error(
      coerceErrorMessage(payload) ||
        `Tracked-position fallback returned HTTP ${response.status}.`,
    );
  }

  const state = payload as PolymarketBotState;
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
    );
  } catch {
    // Keep the tracked-position fallback usable even if Polymarket enrichment fails.
  }

  const positions = buildTrackedBullpenPositionViews(openPositions, marketUpdates);
  return {
    positions,
    summary: summarizeBullpenPositions(positions, {}),
    diagnostics: buildBullpenPositionsDiagnostics(positions),
    fetchedAt: new Date().toISOString(),
  };
}

function buildFallbackResponse({
  source,
  message,
}: {
  source: BullpenFallbackSource;
  message: string | null;
}) {
  return {
    active: Boolean(source),
    source,
    message,
  } satisfies NonNullable<BullpenPositionsResponse["fallback"]>;
}

async function enrichPositionsWithPolymarketData(
  positions: BullpenActivePositionView[] | undefined,
) {
  const normalizedPositions = Array.isArray(positions) ? positions : [];
  if (normalizedPositions.length === 0) {
    return normalizedPositions;
  }

  try {
    const marketUpdates = await resolvePolymarketMarketsWithQuestionFallback(
      normalizedPositions.map((position) => ({
        id: position.key,
        slug: position.slug,
        marketUrl: position.marketUrl,
        question: position.marketTitle,
      })),
    );

    return normalizedPositions.map((position) =>
      applyBullpenPositionMarketData(position, marketUpdates[position.key] || {}),
    );
  } catch {
    return normalizedPositions;
  }
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

  if (normalized.includes("json_parse")) {
    return "JSON_PARSE_ERROR";
  }

  if (
    normalized.includes("transport") ||
    normalized.includes("network") ||
    normalized.includes("bad gateway") ||
    normalized.includes("connection reset")
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
      return "Bullpen runtime timed out while waiting for the shared wallet refresh lock or CLI response. Retry after the current refresh completes.";
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
  if (!payload && !snapshot) {
    return null;
  }

  const brokerHealth = payload?.broker_health || null;
  const lastFailure = payload?.last_failure || null;
  const diagnosticClassification =
    snapshot?.diagnostics?.error_classification ||
    brokerHealth?.error_classification ||
    lastFailure?.classification ||
    payload?.error;
  const classification = normalizeHealthClassification(diagnosticClassification);
  const credentialHome =
    brokerHealth?.effective_home ||
    snapshot?.diagnostics?.effective_home ||
    "/home/investor";
  const message =
    coerceErrorMessage(payload?.error) ||
    coerceErrorMessage(lastFailure?.message) ||
    coerceErrorMessage(brokerHealth?.message) ||
    (payload?.ok
      ? "Bullpen runtime health is ready."
      : "Bullpen runtime health is unavailable.");
  const commandPath =
    brokerHealth?.command_path || process.env.BULLPEN_BIN || "/usr/local/bin/bullpen";

  return {
    ok: Boolean(payload?.ok && brokerHealth?.ok !== false),
    classification,
    stdout: null,
    stderr: null,
    exitCode: null,
    signal: null,
    commandPath,
    attemptedPaths: [commandPath],
    timedOut: classification === "TIMEOUT",
    timestamp:
      snapshot?.auth_checked_at ||
      payload?.auth_checked_at ||
      brokerHealth?.checked_at ||
      lastFailure?.occurred_at ||
      new Date().toISOString(),
    credentialHome,
    message,
    actionNeeded: buildHealthActionNeeded(classification, credentialHome),
  };
}

async function buildLiveSnapshotFromBackend(
  snapshot: BackendBullpenPositionsSnapshot | null | undefined,
): Promise<BullpenLiveSnapshot | null> {
  if (!snapshot || !snapshot.payload) {
    return null;
  }

  const payload = snapshot.payload as BullpenCliPositionsPayload;
  const rawPositions = extractBullpenCliPositionRows(payload.positions ?? payload);
  const aggregatedPositions = aggregateBullpenCliPositions(rawPositions);
  const normalizedPositions = aggregatedPositions.map((position) =>
    normalizeBullpenPosition(position, buildPolymarketEventUrl),
  );
  const enrichedPositions = await enrichPositionsWithPolymarketData(
    normalizedPositions,
  );
  const filteredPositions = filterDisplayBullpenPositions(enrichedPositions);

  return {
    positions: filteredPositions,
    summary: summarizeBullpenPositions(filteredPositions, payload.summary || {}),
    diagnostics: buildBullpenPositionsDiagnostics(enrichedPositions),
    fetchedAt: snapshot.fetched_at,
    source: "live-cli",
  } satisfies BullpenLiveSnapshot;
}

export async function GET(request: NextRequest) {
  const accessToken = request.cookies.get("app_access_token")?.value || null;
  const forceFresh = ["1", "true", "yes"].includes(
    request.nextUrl.searchParams.get("force_fresh")?.trim().toLowerCase() || "",
  );
  const passive = ["1", "true", "yes"].includes(
    request.nextUrl.searchParams.get("passive")?.trim().toLowerCase() || "",
  );
  const callerSource = request.nextUrl.searchParams.get("caller_source")?.trim() || "";
  const requestedMaxAge = Number.parseInt(
    request.nextUrl.searchParams.get("max_age_seconds") || "",
    10,
  );
  const maxAgeSeconds = Number.isFinite(requestedMaxAge)
    ? Math.min(Math.max(requestedMaxAge, 0), 300)
    : 20;

  let backendPositions: BackendBullpenRuntimePositionsResponse | null = null;

  try {
    const backendQuery = new URLSearchParams({
      force_fresh: forceFresh ? "true" : "false",
      max_age_seconds: String(maxAgeSeconds),
    });
    if (passive) {
      backendQuery.set("passive", "true");
    }
    if (callerSource) {
      backendQuery.set("caller_source", callerSource);
    }
    backendPositions = (await fetchBackendRuntimeJson(
      `/polymarket/runtime/positions?${backendQuery.toString()}`,
      {
        accessToken,
      },
    )) as BackendBullpenRuntimePositionsResponse;
  } catch (error) {
    const sanitizedMessage =
      redactBullpenSensitiveText(
        error instanceof Error ? error.message : String(error),
      ) || "Backend Bullpen runtime request failed.";
    const fallbackHealth = buildLiveHealth(
      {
        ok: false,
        broker_health: {
          ok: false,
          message: sanitizedMessage,
          checked_at: new Date().toISOString(),
          error_classification: sanitizedMessage,
          command_path: process.env.BULLPEN_BIN || "/usr/local/bin/bullpen",
          effective_home: "/home/investor",
        },
        last_failure: {
          occurred_at: new Date().toISOString(),
          classification: sanitizedMessage,
          message: sanitizedMessage,
        },
        error: sanitizedMessage,
      },
      null,
    );

    try {
      const trackedFallback = await loadTrackedPositionsFallback(request);
      return NextResponse.json({
        positions: trackedFallback.positions,
        summary: trackedFallback.summary,
        diagnostics: trackedFallback.diagnostics,
        fetchedAt: trackedFallback.fetchedAt,
        liveAvailable: false,
        positionsSource: "tracked-positions",
        health: fallbackHealth,
        lastSuccessfulLiveSnapshot: null,
        fallback: buildFallbackResponse({
          source: "tracked-positions",
          message:
            "Bullpen runtime is unavailable and no shared wallet snapshot could be read, so Cred-X is showing tracked positions only as a fallback. Do not auto-trade or auto-claim from fallback data.",
        }),
        error: sanitizedMessage,
      } satisfies BullpenPositionsResponse);
    } catch (fallbackError) {
      const fallbackMessage =
        redactBullpenSensitiveText(
          fallbackError instanceof Error
            ? fallbackError.message
            : String(fallbackError),
        ) || "Tracked-position fallback failed.";

      return NextResponse.json(
        {
          positions: [],
          summary: summarizeBullpenPositions([], {}),
          diagnostics: buildBullpenPositionsDiagnostics([]),
          fetchedAt: fallbackHealth?.timestamp || new Date().toISOString(),
          liveAvailable: false,
          positionsSource: null,
          health: fallbackHealth,
          lastSuccessfulLiveSnapshot: null,
          fallback: buildFallbackResponse({
            source: null,
            message: null,
          }),
          error: `${sanitizedMessage} Tracked-position fallback also failed: ${fallbackMessage}`,
        } satisfies BullpenPositionsResponse,
        { status: 503 },
      );
    }
  }

  const liveSnapshot = await buildLiveSnapshotFromBackend(
    backendPositions?.snapshot || null,
  );
  const staleSnapshot = await buildLiveSnapshotFromBackend(
    backendPositions?.stale_snapshot || null,
  );
  const health = buildLiveHealth(
    backendPositions,
    backendPositions?.snapshot || backendPositions?.stale_snapshot || null,
  );

  if (backendPositions?.ok && liveSnapshot) {
    return NextResponse.json({
      positions: liveSnapshot.positions,
      summary: liveSnapshot.summary,
      diagnostics: liveSnapshot.diagnostics,
      fetchedAt: liveSnapshot.fetchedAt,
      liveAvailable: true,
      positionsSource: "live-cli",
      health,
      lastSuccessfulLiveSnapshot: liveSnapshot,
      fallback: buildFallbackResponse({
        source: null,
        message: null,
      }),
    } satisfies BullpenPositionsResponse);
  }

  if (staleSnapshot) {
    return NextResponse.json({
      positions: staleSnapshot.positions,
      summary: staleSnapshot.summary,
      diagnostics: staleSnapshot.diagnostics,
      fetchedAt: staleSnapshot.fetchedAt,
      liveAvailable: false,
      positionsSource: "last-successful-live-snapshot",
      health,
      lastSuccessfulLiveSnapshot: staleSnapshot,
      fallback: buildFallbackResponse({
        source: "last-successful-live-snapshot",
        message:
          "Live Bullpen runtime is unavailable, so Cred-X is showing the shared last successful wallet snapshot. Do not auto-trade or auto-claim from stale fallback data.",
      }),
      error: coerceErrorMessage(backendPositions?.error) || undefined,
    } satisfies BullpenPositionsResponse);
  }

  try {
    const trackedFallback = await loadTrackedPositionsFallback(request);
    return NextResponse.json({
      positions: trackedFallback.positions,
      summary: trackedFallback.summary,
      diagnostics: trackedFallback.diagnostics,
      fetchedAt: trackedFallback.fetchedAt,
      liveAvailable: false,
      positionsSource: "tracked-positions",
      health,
      lastSuccessfulLiveSnapshot: null,
      fallback: buildFallbackResponse({
        source: "tracked-positions",
        message:
          "Live Bullpen runtime is unavailable and no shared wallet snapshot is cached, so Cred-X is showing tracked positions only as a fallback. Do not auto-trade or auto-claim from fallback data.",
      }),
      error: coerceErrorMessage(backendPositions?.error) || undefined,
    } satisfies BullpenPositionsResponse);
  } catch (fallbackError) {
    const fallbackMessage =
      redactBullpenSensitiveText(
        fallbackError instanceof Error
          ? fallbackError.message
          : String(fallbackError),
      ) || "Tracked-position fallback failed.";

    return NextResponse.json(
      {
        positions: [],
        summary: summarizeBullpenPositions([], {}),
        diagnostics: buildBullpenPositionsDiagnostics([]),
        fetchedAt: health?.timestamp || new Date().toISOString(),
        liveAvailable: false,
        positionsSource: null,
        health,
        lastSuccessfulLiveSnapshot: null,
        fallback: buildFallbackResponse({
          source: null,
          message: null,
        }),
        error: `${coerceErrorMessage(backendPositions?.error) || "Bullpen runtime is unavailable."} Tracked-position fallback also failed: ${fallbackMessage}`,
      } satisfies BullpenPositionsResponse,
      { status: 503 },
    );
  }
}

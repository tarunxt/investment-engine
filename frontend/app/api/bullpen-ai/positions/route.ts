import { NextRequest, NextResponse } from "next/server";

import {
  readLastSuccessfulBullpenLiveSnapshot,
  syncBullpenLiveSnapshot,
} from "../_lib/bullpenHealth";
import { redactBullpenSensitiveText } from "../_lib/bullpenHealthCore.ts";
import { resolvePolymarketMarketsWithQuestionFallback } from "../_lib/polymarketMarketUrls";
import {
  applyBullpenPositionMarketData,
  buildBullpenPositionsDiagnostics,
  buildTrackedBullpenPositionViews,
  filterDisplayBullpenPositions,
  summarizeBullpenPositions,
  type BullpenActivePositionView,
  type BullpenPositionsResponse,
} from "@/lib/bullpenPositions";
import type { PolymarketBotState } from "@/types/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type BullpenFallbackSource =
  | "last-successful-live-snapshot"
  | "tracked-positions"
  | null;

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
        slug: position.market_id,
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
        slug: position.marketId,
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

export async function GET(request: NextRequest) {
  const liveResult = await syncBullpenLiveSnapshot();

  if (liveResult.ok && liveResult.snapshot) {
    const enrichedPositions = await enrichPositionsWithPolymarketData(
      liveResult.snapshot.positions,
    );
    const diagnostics =
      liveResult.snapshot.diagnostics ||
      buildBullpenPositionsDiagnostics(enrichedPositions);
    return NextResponse.json({
      positions: filterDisplayBullpenPositions(enrichedPositions),
      summary: summarizeBullpenPositions(
        filterDisplayBullpenPositions(enrichedPositions),
        liveResult.snapshot.summary,
      ),
      diagnostics,
      fetchedAt: liveResult.snapshot.fetchedAt,
      liveAvailable: true,
      positionsSource: "live-cli",
      health: liveResult.health,
      lastSuccessfulLiveSnapshot: {
        ...liveResult.snapshot,
        positions: enrichedPositions,
        summary: summarizeBullpenPositions(
          filterDisplayBullpenPositions(enrichedPositions),
          liveResult.snapshot.summary,
        ),
        diagnostics,
      },
      fallback: buildFallbackResponse({
        source: null,
        message: null,
      }),
    } satisfies BullpenPositionsResponse);
  }

  const lastSuccessfulLiveSnapshot =
    await readLastSuccessfulBullpenLiveSnapshot();

  if (lastSuccessfulLiveSnapshot) {
    return NextResponse.json({
      positions: lastSuccessfulLiveSnapshot.positions,
      summary: lastSuccessfulLiveSnapshot.summary,
      diagnostics: lastSuccessfulLiveSnapshot.diagnostics,
      fetchedAt: lastSuccessfulLiveSnapshot.fetchedAt,
      liveAvailable: false,
      positionsSource: "last-successful-live-snapshot",
      health: liveResult.health,
      lastSuccessfulLiveSnapshot,
      fallback: buildFallbackResponse({
        source: "last-successful-live-snapshot",
        message:
          "Live Bullpen CLI is unavailable, so Cred-X is showing the last successful live wallet snapshot. Do not auto-trade or auto-claim from stale fallback data.",
      }),
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
      health: liveResult.health,
      lastSuccessfulLiveSnapshot: null,
      fallback: buildFallbackResponse({
        source: "tracked-positions",
        message:
          "Live Bullpen CLI is unavailable and no successful live snapshot is cached, so Cred-X is showing tracked positions only as a fallback. Do not auto-trade or auto-claim from fallback data.",
      }),
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
        fetchedAt: liveResult.health.timestamp,
        liveAvailable: false,
        positionsSource: null,
        health: liveResult.health,
        lastSuccessfulLiveSnapshot: null,
        fallback: buildFallbackResponse({
          source: null,
          message: null,
        }),
        error: `${liveResult.health.message} Tracked-position fallback also failed: ${fallbackMessage}`,
      } satisfies BullpenPositionsResponse,
      { status: 503 },
    );
  }
}

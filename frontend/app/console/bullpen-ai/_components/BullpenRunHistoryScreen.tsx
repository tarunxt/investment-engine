"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { formatUnknownError } from "@/lib/apiErrors";
import { BullpenEventIdentityResolver } from "@/lib/bullpenEventIdentityResolver";
import { isBullpenHistoryActivePosition } from "@/lib/bullpenHistoryPositions";
import {
  isUsableBullpenPositionsSnapshot,
  type BullpenActivePositionView,
  type BullpenPositionsResponse,
} from "@/lib/bullpenPositions";
import { apiService } from "@/services/api";
import type {
  BullpenAutoLiveEventTrend,
  BullpenAutoLiveEventTrendsResponse,
  BullpenAutoLiveHistoryItem,
  BullpenAutoLiveHistoryPage,
} from "@/types/api";
import { BullpenHistoryPortfolio } from "./BullpenHistoryPortfolio";
import { BullpenRunHistoryContent } from "./BullpenRunHistoryContent";

const EVENT_TRENDS_CACHE_KEY = "bullpen-auto-live-event-trends-v1";

function readCachedEventTrends(): BullpenAutoLiveEventTrendsResponse | null {
  if (typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(EVENT_TRENDS_CACHE_KEY) || "null",
    ) as BullpenAutoLiveEventTrendsResponse | null;
    return parsed && Array.isArray(parsed.events) ? parsed : null;
  } catch {
    return null;
  }
}

function cacheEventTrends(trends: BullpenAutoLiveEventTrendsResponse) {
  try {
    window.localStorage.setItem(EVENT_TRENDS_CACHE_KEY, JSON.stringify(trends));
  } catch {
    // Storage can be unavailable in private/restricted browser contexts.
  }
}

async function fetchCurrentBullpenPositions() {
  const params = new URLSearchParams({
    caller_source: "ui-history-portfolio-refresh",
    force_fresh: "true",
    max_age_seconds: "0",
    request_id: crypto.randomUUID(),
  });
  const response = await fetch(`/api/bullpen-ai/positions?${params}`, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { "Cache-Control": "no-cache" },
  });
  const payload = (await response.json()) as BullpenPositionsResponse;
  if (!response.ok && !payload.positions?.length) {
    throw new Error(
      payload.error || `Bullpen positions request failed (${response.status}).`,
    );
  }
  return payload;
}

function resolveActivePositionSide(
  position: BullpenActivePositionView,
): "YES" | "NO" | null {
  if (position.heldSide === "YES" || position.heldSide === "NO") {
    return position.heldSide;
  }
  const outcome = position.outcome.trim().toUpperCase();
  return outcome === "YES" || outcome === "NO" ? outcome : null;
}

function normalizeBullpenContractIdentity(value: string | null | undefined) {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function normalizeBullpenContractTitle(value: string | null | undefined) {
  const normalized = normalizeBullpenContractIdentity(value);
  return normalized
    ? normalized.replace(/\s+/g, " ").replace(/[?!.]+$/, "")
    : null;
}

function isSameBullpenContract(
  event: BullpenAutoLiveEventTrend,
  position: BullpenActivePositionView,
) {
  const eventMarketId = normalizeBullpenContractIdentity(event.market_id);
  const conditionId = normalizeBullpenContractIdentity(position.conditionId);
  const positionKey = normalizeBullpenContractIdentity(position.key);

  // A Bullpen/Polymarket marketId can identify the parent event shared by
  // several deadline/outcome contracts. Never use position.marketId alone to
  // paint an active tick: that is what made sibling contracts (Aug 14/15/22,
  // Aug 15/16/17, etc.) all look active when only one contract was actually held.
  if (
    eventMarketId &&
    (eventMarketId === conditionId || eventMarketId === positionKey)
  ) {
    return true;
  }

  const eventTitle = normalizeBullpenContractTitle(event.market_title);
  const positionTitle = normalizeBullpenContractTitle(position.marketTitle);
  return Boolean(eventTitle && positionTitle && eventTitle === positionTitle);
}

export function applyCurrentBullpenPositionsToEventTrends(
  trends: BullpenAutoLiveEventTrendsResponse,
  positions: BullpenPositionsResponse,
): BullpenAutoLiveEventTrendsResponse {
  const activePositions = (positions.positions ?? []).filter(
    isBullpenHistoryActivePosition,
  );

  const events = trends.events.map((event: BullpenAutoLiveEventTrend) => {
    const target = BullpenEventIdentityResolver.buildIdentity({
      marketId: event.market_id,
      marketUrl: event.market_url ?? null,
      title: event.market_title,
    });
    const contractCandidates = activePositions.filter((position) =>
      isSameBullpenContract(event, position),
    );
    const match = BullpenEventIdentityResolver.resolveMatch({
      target,
      candidates: contractCandidates,
      getIdentity: BullpenEventIdentityResolver.fromPosition,
    });
    const activePosition =
      match.status === "matched" ? (match.match?.item ?? null) : null;

    return {
      ...event,
      is_active_position: activePosition !== null,
      active_position_side: activePosition
        ? resolveActivePositionSide(activePosition)
        : null,
    };
  });

  return { ...trends, events };
}

export function BullpenRunHistoryScreen() {
  const router = useRouter();
  const [page, setPage] = useState<BullpenAutoLiveHistoryPage | null>(null);
  const [trends, setTrends] =
    useState<BullpenAutoLiveEventTrendsResponse | null>(() =>
      readCachedEventTrends(),
    );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [trendsError, setTrendsError] = useState<string | null>(null);
  const [portfolioReady, setPortfolioReady] = useState(false);
  const [portfolioVersion, setPortfolioVersion] = useState(0);

  const load = useCallback(async (pageNumber = 1) => {
    setLoading(true);
    setError(null);
    setTrendsError(null);
    try {
      const positionsPromise = fetchCurrentBullpenPositions().catch(() => null);
      const historyRequestOptions = { timeoutMs: 10_000 };
      const [[pageResult, trendsResult], currentPositions] = await Promise.all([
        Promise.allSettled([
          apiService.getBullpenAutoLiveHistory(
            { page: pageNumber, size: 20 },
            historyRequestOptions,
          ),
          apiService.getBullpenAutoLiveHistoryEventTrends(
            historyRequestOptions,
          ),
        ]),
        positionsPromise,
      ]);
      const hasUsableCurrentPositions = Boolean(
        currentPositions &&
          isUsableBullpenPositionsSnapshot({
            positionsSource: currentPositions.positionsSource,
            liveAvailable: currentPositions.liveAvailable,
          }),
      );
      if (pageResult.status === "fulfilled") {
        setPage(pageResult.value);
      } else {
        setError(
          `Run history is temporarily unavailable. ${formatUnknownError(pageResult.reason)}`,
        );
      }
      if (trendsResult.status === "fulfilled") {
        const nextTrends =
          hasUsableCurrentPositions && currentPositions
            ? applyCurrentBullpenPositionsToEventTrends(
                trendsResult.value,
                currentPositions,
              )
            : trendsResult.value;
        setTrends(nextTrends);
        cacheEventTrends(nextTrends);
      } else {
        const cachedTrends = readCachedEventTrends();
        if (cachedTrends) {
          setTrends(cachedTrends);
        } else {
          setTrendsError(
            `Event trends are temporarily unavailable. ${formatUnknownError(trendsResult.reason)}`,
          );
        }
      }
      setPortfolioVersion((version) => version + 1);
    } catch (cause) {
      setError(
        `Run history is temporarily unavailable. ${formatUnknownError(cause)}`,
      );
    } finally {
      setPortfolioReady(true);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    window.queueMicrotask(() => void load());
  }, [load]);

  const openRun = (run: BullpenAutoLiveHistoryItem) =>
    router.push(
      `/console/bullpen-ai/runs/${encodeURIComponent(run.id)}`,
    );

  return (
    <main className="min-h-screen bg-slate-100 p-4 md:p-8">
      <div className="mx-auto max-w-[96rem] space-y-6">
        {portfolioReady ? (
          <BullpenHistoryPortfolio key={portfolioVersion} />
        ) : (
          <div className="rounded-3xl border border-slate-800 bg-slate-950 px-6 py-8 text-sm font-semibold text-slate-300 shadow-xl">
            Refreshing current Bullpen portfolio…
          </div>
        )}
        <BullpenRunHistoryContent
          page={page}
          trends={trends}
          loading={loading}
          trendsLoading={loading}
          error={error}
          trendsError={trendsError}
          onRefresh={() => void load(page?.page ?? 1)}
          onPage={(next) => void load(next)}
          onOpenRun={openRun}
          showFullScreen={false}
        />
      </div>
    </main>
  );
}

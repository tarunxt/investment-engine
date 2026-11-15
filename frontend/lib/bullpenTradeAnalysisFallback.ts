import type { BullpenTradeAnalysisListResponse } from "@/types/api";

const TRADE_ANALYSIS_CACHE_KEY =
  "investment-engine:bullpen-trade-analysis:last-known-good:v1";
export const TRADE_ANALYSIS_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

type TradeAnalysisCacheEnvelope = {
  version: 1;
  userId: number;
  filtersKey: string;
  cachedAt: number;
  data: BullpenTradeAnalysisListResponse;
};

export type TradeAnalysisCacheHit = {
  cachedAt: number;
  data: BullpenTradeAnalysisListResponse;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableFiniteNumber(value: unknown) {
  return value === null || isFiniteNumber(value);
}

export function isBullpenTradeAnalysisListResponse(
  value: unknown,
): value is BullpenTradeAnalysisListResponse {
  if (!isRecord(value) || !Array.isArray(value.items)) return false;
  if (!isRecord(value.summary) || !isRecord(value.learning_insights)) {
    return false;
  }

  const summary = value.summary;
  if (
    !isFiniteNumber(summary.total_executed_trades) ||
    !isFiniteNumber(summary.open_positions) ||
    !isFiniteNumber(summary.closed_positions) ||
    !isFiniteNumber(summary.total_net_pnl) ||
    !isFiniteNumber(summary.win_rate) ||
    !isNullableFiniteNumber(summary.average_pnl_percent) ||
    !isNullableFiniteNumber(summary.average_holding_period_seconds) ||
    !isFiniteNumber(summary.total_fees)
  ) {
    return false;
  }

  const validItems = value.items.every(
    (item) =>
      isRecord(item) &&
      typeof item.id === "string" &&
      item.id.length > 0 &&
      typeof item.title === "string" &&
      typeof item.status === "string" &&
      typeof item.final_tag === "string" &&
      typeof item.pnl_outcome_tag === "string" &&
      typeof item.is_squared_off === "boolean" &&
      Array.isArray(item.buy_tags),
  );
  if (!validItems) return false;

  const insights = value.learning_insights;
  return (
    Array.isArray(insights.win_rate_by_tag) &&
    Array.isArray(insights.average_pnl_by_tag) &&
    Array.isArray(insights.total_pnl_by_strategy_version) &&
    Array.isArray(insights.recommendations)
  );
}

export function buildTradeAnalysisFiltersKey(
  filters: Record<string, string>,
): string {
  return JSON.stringify(
    Object.keys(filters)
      .sort()
      .map((key) => [key, filters[key] ?? ""]),
  );
}

export function readTradeAnalysisCache(input: {
  userId: number | null | undefined;
  filtersKey: string;
  now?: number;
}): TradeAnalysisCacheHit | null {
  if (typeof window === "undefined" || !Number.isInteger(input.userId)) {
    return null;
  }

  try {
    const raw = window.sessionStorage.getItem(TRADE_ANALYSIS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TradeAnalysisCacheEnvelope>;
    const now = input.now ?? Date.now();
    if (
      parsed.version !== 1 ||
      parsed.userId !== input.userId ||
      parsed.filtersKey !== input.filtersKey ||
      !isFiniteNumber(parsed.cachedAt) ||
      now < parsed.cachedAt ||
      now - parsed.cachedAt > TRADE_ANALYSIS_CACHE_MAX_AGE_MS ||
      !isBullpenTradeAnalysisListResponse(parsed.data)
    ) {
      window.sessionStorage.removeItem(TRADE_ANALYSIS_CACHE_KEY);
      return null;
    }
    return {
      cachedAt: parsed.cachedAt,
      data: parsed.data,
    };
  } catch {
    return null;
  }
}

export function writeTradeAnalysisCache(input: {
  userId: number | null | undefined;
  filtersKey: string;
  data: BullpenTradeAnalysisListResponse;
  now?: number;
}): boolean {
  if (
    typeof window === "undefined" ||
    !Number.isInteger(input.userId) ||
    !isBullpenTradeAnalysisListResponse(input.data)
  ) {
    return false;
  }

  const envelope: TradeAnalysisCacheEnvelope = {
    version: 1,
    userId: input.userId as number,
    filtersKey: input.filtersKey,
    cachedAt: input.now ?? Date.now(),
    data: input.data,
  };
  try {
    window.sessionStorage.setItem(
      TRADE_ANALYSIS_CACHE_KEY,
      JSON.stringify(envelope),
    );
    return true;
  } catch {
    return false;
  }
}
